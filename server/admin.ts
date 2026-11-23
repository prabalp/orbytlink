import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { grantCredits, usd } from "./ai.js";
import { defaultMarkup, describe, getItem, markupPercent, priceOf, priceRule, routesOf, setDefaultMarkup, setPrice, setRouteFlags, ensureCatalog } from "./catalog.js";
import { report } from "./ledger.js";
import { plan, refreshBalances, setSource, sources } from "./routing.js";
import { syncGoogleLive, syncVercelLive } from "./provider-sync.js";
import { clearQuote, instantMarkup, priceList, rebuild, setQuote, walletReport } from "./instant.js";

// ── The admin portal (app.orbytlink.com/admin) ───────────────────────────────
//
// For the operator of this OrbytLink server, not for workspaces: prices of everything sold (models,
// services such as MCP tool calls and API requests, Instant tools), provider balances and routing,
// costs and margins from the ledger, workspace credit, and a log of every change made here.
//
// Who is an operator is a table, granted only from the server's command line
// (npm run account -- operator grant <email>), never by sign-up or an environment variable: sign-up
// doesn't verify email addresses, so an email-based rule could be claimed by registering that address.
// Only signed-in console sessions count (not gateway tokens). To anyone else every admin route is a 404.
const ADMIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS operators (email TEXT PRIMARY KEY, granted_at TEXT NOT NULL, granted_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  operator TEXT NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at);
`;
const ready = new WeakSet<Store>();
export function ensureAdmin(store: Store) {
  if (ready.has(store)) return;
  store.db.exec(ADMIN_SCHEMA);
  ready.add(store);
}
const norm = (email: string) => email.trim().toLowerCase();
export function isOperator(store: Store, identity: Identity) {
  ensureAdmin(store);
  if (identity.authMethod !== "email" || !identity.email) return false;
  return !!store.db.prepare("SELECT 1 FROM operators WHERE email=?").get(norm(identity.email));
}
export function grantOperator(store: Store, email: string, by = "command line") {
  ensureAdmin(store);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Give an email address");
  store.db.prepare("INSERT INTO operators(email,granted_at,granted_by) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING").run(norm(email), new Date().toISOString(), by);
}
export function revokeOperator(store: Store, email: string) {
  ensureAdmin(store);
  return Number(store.db.prepare("DELETE FROM operators WHERE email=?").run(norm(email)).changes) > 0;
}
export const listOperators = (store: Store) => {
  ensureAdmin(store);
  return store.db.prepare("SELECT email, granted_at, granted_by FROM operators ORDER BY email").all() as { email: string; granted_at: string; granted_by: string }[];
};
function audit(store: Store, operator: string, action: string, target: string, detail?: unknown) {
  store.db.prepare("INSERT INTO admin_audit(at,operator,action,target,detail) VALUES(?,?,?,?,?)").run(new Date().toISOString(), operator, action, target.slice(0, 300), detail === undefined ? null : JSON.stringify(detail).slice(0, 4000));
}

// ── Pricing: one row shape for models, services and Instant tools ────────────
export type PriceType = "model" | "service" | "tool";
export type PriceRow = {
  type: PriceType;
  id: string;
  name: string;
  unit: string;
  cost_in: number | null;
  cost_out: number | null;
  price_in: number | null;
  price_out: number | null;
  rule: "default" | "markup" | "fixed" | "unpriced";
  markup_pct: number | null;
  margin_pct: number | null;
  routes: number;
  live: number;
};
// Margin on a typical call: 1,000 tokens in and 250 out for a model, one call otherwise.
const margin = (type: PriceType, r: Pick<PriceRow, "cost_in" | "cost_out" | "price_in" | "price_out">) => {
  const w = type === "model" ? [1000, 250] : [1, 0];
  const price = (r.price_in ?? 0) * w[0] + (r.price_out ?? 0) * w[1];
  const cost = (r.cost_in ?? 0) * w[0] + (r.cost_out ?? 0) * w[1];
  if (r.price_in === null || r.cost_in === null) return null;
  if (price === 0) return cost === 0 ? 0 : -100;
  return Math.round(((price - cost) / price) * 1000) / 10;
};
function catalogRows(store: Store): PriceRow[] {
  return describe(store).map(({ item, price, routes }) => {
    const live = routes.filter((r) => r.live);
    const pool = live.length ? live : routes;
    const cheapest = [...pool].sort((a, b) => (a.cost_in ?? 0) * 4 + (a.cost_out ?? 0) - ((b.cost_in ?? 0) * 4 + (b.cost_out ?? 0)))[0];
    const rule = priceRule(store, item.id);
    const type: PriceType = item.kind === "service" ? "service" : "model";
    const row = {
      type,
      id: item.id,
      name: item.name,
      unit: item.unit_out ? `per ${item.unit_in}` : `per ${item.unit_in ?? "call"}`,
      cost_in: cheapest?.cost_in ?? null,
      cost_out: cheapest?.cost_out ?? null,
      price_in: price.input,
      price_out: price.output,
      rule: rule?.price_in != null ? ("fixed" as const) : rule?.markup_pct != null ? ("markup" as const) : ("default" as const),
      markup_pct: rule?.markup_pct ?? null,
      routes: routes.length,
      live: live.length,
    };
    return { ...row, margin_pct: margin(type, row) };
  });
}
function toolRows(store: Store): PriceRow[] {
  return priceList(store).map((t) => {
    const fixed = !!t.setBy && !t.setBy.startsWith("markup") && t.setBy !== "unpriced";
    const row = {
      type: "tool" as const,
      id: t.tool,
      name: t.tool,
      unit: "per call",
      cost_in: t.cheapestCostUsd,
      cost_out: null,
      price_in: t.priceUsd,
      price_out: null,
      rule: t.setBy === "unpriced" || t.priceUsd === null ? ("unpriced" as const) : fixed ? ("fixed" as const) : ("default" as const),
      markup_pct: null,
      routes: t.routes.length,
      live: t.routes.length,
    };
    return { ...row, margin_pct: margin("tool", row) };
  });
}
export function priceRows(store: Store, type?: PriceType) {
  return [...(!type || type !== "tool" ? catalogRows(store).filter((r) => !type || r.type === type) : []), ...(!type || type === "tool" ? toolRows(store) : [])];
}
const markups = (store: Store) => {
  ensureCatalog(store);
  return {
    ai: { percent: markupPercent(), from: defaultMarkup("ai") !== null ? "admin" : process.env.AI_MARKUP_PERCENT ? ".env" : "default" },
    instant: { percent: instantMarkup(), from: defaultMarkup("instant") !== null ? "admin" : process.env.INSTANT_MARKUP_PERCENT ? ".env" : "default" },
  };
};

// One price change, from the portal or a CSV row. Returns what it was and what it is now.
type Change = { type: PriceType; id: string; rule: "default" | "markup" | "fixed"; markup_pct?: number; price_in?: number; price_out?: number | null };
function applyChange(store: Store, c: Change, by: string) {
  if (c.type === "tool") {
    if (c.rule === "markup") throw new Error("Instant tools take a fixed price, or the default markup");
    if (c.rule === "default") clearQuote(store, c.id);
    else setQuote(store, c.id, c.price_in!, by);
    return;
  }
  if (!getItem(store, c.id)) throw new Error(`No item ${c.id}`);
  setPrice(store, c.id, c.rule === "default" ? "default" : c.rule === "markup" ? { markup: c.markup_pct! } : { input: c.price_in, output: c.price_out }, by);
}
const snapshot = (r: PriceRow | undefined) => (r ? { rule: r.rule, markup_pct: r.markup_pct, price_in: r.price_in, price_out: r.price_out } : null);

// ── CSV ──────────────────────────────────────────────────────────────────────
// Export: type,id,name,unit,cost_in,cost_out,price_in,price_out,markup_pct,rule (USD per unit).
// Import reads type and id, then what the row asks for: rule "default" puts the item back on the
// default markup; a markup_pct different from the current one sets that markup; price_in/price_out
// different from the current prices fix the price. Rows that ask for no change are left alone, so
// an exported file can be edited in a few cells and uploaded as it is.
const CSV_COLUMNS = ["type", "id", "name", "unit", "cost_in", "cost_out", "price_in", "price_out", "markup_pct", "rule"] as const;
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function pricesCsv(store: Store, type?: PriceType) {
  const rows = priceRows(store, type);
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(c === "unit" ? r.unit : (r as any)[c])).join(","))].join("\n") + "\n";
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}
const num = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const t = v.replace(/[$\s,]/g, "");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const near = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
export type CsvPreview = { changes: (Change & { name: string; before: ReturnType<typeof snapshot> })[]; unchanged: number; errors: { line: number; message: string }[] };
export function previewCsv(store: Store, text: string): CsvPreview {
  const rows = parseCsv(text);
  if (!rows.length) return { changes: [], unchanged: 0, errors: [{ line: 1, message: "The file is empty." }] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  if (col("type") < 0 || col("id") < 0) return { changes: [], unchanged: 0, errors: [{ line: 1, message: "The first row must name the columns, with at least type and id (download the current prices for the layout)." }] };
  const current = new Map(priceRows(store).map((r) => [`${r.type}|${r.id}`, r]));
  const out: CsvPreview = { changes: [], unchanged: 0, errors: [] };
  const seen = new Set<string>();
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const get = (name: string) => (col(name) >= 0 ? r[col(name)]?.trim() : undefined);
    const type = (get("type") || "").toLowerCase() as PriceType;
    const id = get("id") || "";
    if (!["model", "service", "tool"].includes(type)) return void out.errors.push({ line, message: `type must be model, service or tool (got "${get("type")}")` });
    const cur = current.get(`${type}|${id}`);
    if (!cur) return void out.errors.push({ line, message: `No ${type} "${id}"` });
    if (seen.has(`${type}|${id}`)) return void out.errors.push({ line, message: `${id} appears twice` });
    seen.add(`${type}|${id}`);
    const rule = (get("rule") || "").toLowerCase();
    const markup = num(get("markup_pct")),
      pin = num(get("price_in")),
      pout = num(get("price_out"));
    if ([markup, pin, pout].some((v) => Number.isNaN(v))) return void out.errors.push({ line, message: "price_in, price_out and markup_pct must be numbers" });
    if ((pin !== undefined && pin < 0) || (pout !== undefined && pout < 0) || (markup !== undefined && (markup < -100 || markup > 1000))) return void out.errors.push({ line, message: "Prices can't be negative; a markup is between -100 and 1000" });
    let change: Change | null = null;
    if (rule === "default" && cur.rule !== "default" && cur.rule !== "unpriced" && (markup === undefined || cur.rule !== "markup" || near(markup, cur.markup_pct))) change = { type, id, rule: "default" };
    else if (markup !== undefined && !(cur.rule === "markup" && near(markup, cur.markup_pct))) {
      if (type === "tool") return void out.errors.push({ line, message: "Instant tools take a fixed price (price_in), not a markup" });
      change = { type, id, rule: "markup", markup_pct: markup };
    } else if (pin !== undefined && (!near(pin, cur.price_in) || (type === "model" && pout !== undefined && !near(pout, cur.price_out)))) {
      change = { type, id, rule: "fixed", price_in: pin, price_out: type === "model" ? (pout ?? cur.price_out) : null };
    }
    if (change) out.changes.push({ ...change, name: cur.name, before: snapshot(cur) });
    else out.unchanged++;
  });
  return out;
}

// ── Monitoring ───────────────────────────────────────────────────────────────
const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
function overview(store: Store, days: number) {
  ensureCatalog(store);
  const t = store.db
    .prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(status='failed'),0) AS failed, COALESCE(SUM(charged_micro),0) AS charged, COALESCE(SUM(cost_micro),0) AS cost, COALESCE(SUM(cost_micro IS NULL AND status='ok'),0) AS costUnknown FROM usage_calls WHERE at >= ?")
    .get(since(days)) as Record<string, number>;
  const credit = store.db.prepare("SELECT COALESCE(SUM(json_extract(data,'$.micro')),0) AS micro, COUNT(*) AS n FROM records WHERE kind='ai_credits' AND id='balance'").get() as { micro: number; n: number };
  const providers = sources(store);
  // The Instant tools' wholesale sources keep their own wallets; they count here too.
  const instant = walletReport(store);
  const alerts: string[] = [];
  for (const p of providers) if (p.balance_mode !== "postpaid" && p.balance_micro !== null && p.balance_micro < 5_000_000) alerts.push(`${p.name} balance is $${usd(p.balance_micro).toFixed(2)}.`);
  for (const w of instant) if (w.configured && w.wallet && w.wallet.micro < 5_000_000) alerts.push(`Tool source ${w.source.toUpperCase()} balance is $${usd(w.wallet.micro).toFixed(2)}.`);
  const losing = catalogRows(store).filter((r) => r.live && r.margin_pct !== null && r.margin_pct < 0);
  if (losing.length) alerts.push(`${losing.length} item${losing.length === 1 ? "" : "s"} sell below cost: ${losing.slice(0, 5).map((r) => r.name).join(", ")}${losing.length > 5 ? "…" : ""}.`);
  if (t.costUnknown) alerts.push(`${t.costUnknown} paid call${t.costUnknown === 1 ? "" : "s"} have no cost on record.`);
  return {
    days,
    totals: { ...t, margin: t.charged - t.cost },
    byDay: report(store, { days, by: "day" }).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    byKind: report(store, { days, by: "kind" }),
    bySource: report(store, { days, by: "source" }),
    topItems: report(store, { days, by: "item" }).slice(0, 10),
    creditHeld: credit.micro,
    providers,
    instant,
    alerts,
  };
}
function workspaces(store: Store, q: string) {
  const personal = store.db.prepare("SELECT workspace, name, email, created_at, disabled FROM accounts").all() as any[];
  const orgs = store.db.prepare("SELECT id AS workspace, name, created_at FROM orgs").all() as any[];
  const usage = new Map(report(store, { days: 30, by: "workspace" }).map((r) => [r.key, r]));
  const month = new Date().toISOString().slice(0, 7);
  const rec = (w: string, kind: string, id: string) => {
    const r = store.db.prepare("SELECT data FROM records WHERE workspace=? AND kind=? AND id=?").get(w, kind, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  };
  const query = q.toLowerCase();
  return [
    ...personal.map((a) => ({ workspace: a.workspace, name: `${a.name}’s workspace`, owner: a.email, type: "personal", created: new Date(a.created_at).toISOString(), disabled: !!a.disabled })),
    ...orgs.map((o) => ({ workspace: o.workspace, name: o.name, owner: "", type: "organization", created: new Date(o.created_at).toISOString(), disabled: false })),
  ]
    .filter((w) => !query || `${w.name} ${w.owner} ${w.workspace}`.toLowerCase().includes(query))
    .map((w) => {
      const u = usage.get(w.workspace);
      return { ...w, balance: rec(w.workspace, "ai_credits", "balance")?.micro ?? 0, monthSpent: rec(w.workspace, "ai_months", month)?.micro ?? 0, calls30: u?.calls ?? 0, charged30: u?.charged_micro ?? 0, cost30: u?.cost_micro ?? 0 };
    })
    .sort((a, b) => b.charged30 - a.charged30 || b.balance - a.balance || a.name.localeCompare(b.name));
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function configureAdmin(app: Express, store: Store) {
  ensureAdmin(store);
  const operator = (res: Response) => (res.locals.identity as Identity).email!;
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!isOperator(store, res.locals.identity as Identity)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };
  const fail = (res: Response, error: unknown) => res.status((error as any)?.status && (error as any).status < 500 ? (error as any).status : 400).json({ error: (error as Error).message });
  const r = express.Router();
  r.use(guard);

  r.get("/overview", (req, res) => res.json(overview(store, Math.min(365, Math.max(1, Number(req.query.days) || 30)))));

  r.get("/pricing", (req, res) => {
    const type = ["model", "service", "tool"].includes(String(req.query.type)) ? (req.query.type as PriceType) : undefined;
    const q = String(req.query.q || "").toLowerCase();
    const filter = String(req.query.filter || "all");
    let rows = priceRows(store, type).filter((r) => !q || `${r.id} ${r.name}`.toLowerCase().includes(q));
    if (filter === "custom") rows = rows.filter((r) => r.rule === "markup" || r.rule === "fixed");
    if (filter === "loss") rows = rows.filter((r) => r.margin_pct !== null && r.margin_pct < 0);
    if (filter === "unpriced") rows = rows.filter((r) => r.rule === "unpriced" || r.price_in === null);
    if (filter === "live") rows = rows.filter((r) => r.live > 0);
    const offset = Math.max(0, Number(req.query.offset) || 0),
      limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ total: rows.length, rows: rows.slice(offset, offset + limit), markups: markups(store) });
  });
  r.put("/pricing", (req, res) => {
    try {
      const b = req.body || {};
      const type = String(b.type) as PriceType;
      if (!["model", "service", "tool"].includes(type)) throw new Error("type: model, service or tool");
      const before = priceRows(store, type).find((x) => x.id === b.id);
      if (!before) throw new Error(`No ${type} ${b.id}`);
      const change: Change = { type, id: String(b.id), rule: b.rule, markup_pct: b.markup_pct === undefined ? undefined : Number(b.markup_pct), price_in: b.price_in === undefined ? undefined : Number(b.price_in), price_out: b.price_out === undefined || b.price_out === null ? null : Number(b.price_out) };
      if (!["default", "markup", "fixed"].includes(change.rule)) throw new Error("rule: default, markup or fixed");
      if (change.rule === "markup" && !Number.isFinite(change.markup_pct)) throw new Error("Give a markup");
      if (change.rule === "fixed" && !(Number.isFinite(change.price_in) && change.price_in! >= 0)) throw new Error("Give a price");
      applyChange(store, change, operator(res));
      const after = priceRows(store, type).find((x) => x.id === b.id);
      audit(store, operator(res), "price.set", `${type} ${b.id}`, { before: snapshot(before), after: snapshot(after) });
      res.json(after);
    } catch (error) {
      fail(res, error);
    }
  });
  r.put("/markups", (req, res) => {
    try {
      const before = markups(store);
      for (const kind of ["ai", "instant"] as const)
        if (kind in (req.body || {})) setDefaultMarkup(store, kind, req.body[kind] === null || req.body[kind] === "" ? null : Number(req.body[kind]));
      // Instant tools' prices are worked out from the markup when the catalog is rebuilt.
      if ("instant" in (req.body || {})) rebuild(store);
      const after = markups(store);
      audit(store, operator(res), "markup.set", "default markups", { before, after });
      res.json(after);
    } catch (error) {
      fail(res, error);
    }
  });
  r.get("/pricing.csv", (req, res) => {
    const type = ["model", "service", "tool"].includes(String(req.query.type)) ? (req.query.type as PriceType) : undefined;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orbytlink-prices-${type || "all"}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(pricesCsv(store, type));
  });
  r.post("/pricing/import", express.text({ type: ["text/csv", "text/plain"], limit: "8mb" }), (req, res) => {
    try {
      const text = typeof req.body === "string" ? req.body : "";
      const preview = previewCsv(store, text);
      if (req.query.apply !== "1") return void res.json(preview);
      if (preview.errors.length) throw Object.assign(new Error("Fix the rows with errors first; nothing was changed."), { status: 400 });
      store.transaction(() => {
        for (const c of preview.changes) applyChange(store, c, operator(res));
      });
      if (preview.changes.some((c) => c.type === "tool")) rebuild(store);
      audit(store, operator(res), "price.import", `${preview.changes.length} prices from a CSV`, preview.changes.slice(0, 200).map((c) => ({ type: c.type, id: c.id, before: c.before, rule: c.rule, markup_pct: c.markup_pct, price_in: c.price_in, price_out: c.price_out })));
      res.json({ ...preview, applied: preview.changes.length });
    } catch (error) {
      fail(res, error);
    }
  });

  r.get("/providers", async (_req, res) => {
    await refreshBalances(store);
    const counts = store.db.prepare("SELECT source, COUNT(*) AS routes, SUM(enabled) AS enabled FROM catalog_routes GROUP BY source").all() as any[];
    const usage = new Map(report(store, { days: 30, by: "source" }).map((u) => [u.key, u]));
    res.json({
      providers: sources(store).map((s) => {
        const c = counts.find((x) => x.source === s.id);
        const u = usage.get(s.id);
        return { ...s, keySet: s.balance_key_env ? !!process.env[s.balance_key_env] : null, routes: c?.routes ?? 0, enabledRoutes: c?.enabled ?? 0, calls30: u?.calls ?? 0, cost30: u?.cost_micro ?? 0, charged30: u?.charged_micro ?? 0 };
      }),
      instant: walletReport(store),
      usdInr: Number(process.env.USD_INR_RATE) > 0 ? Number(process.env.USD_INR_RATE) : 90,
    });
  });
  r.post("/providers/refresh", async (_req, res) => {
    await refreshBalances(store, true);
    res.json({ providers: sources(store) });
  });
  r.post("/providers/:id", (req, res) => {
    try {
      const before = sources(store).find((s) => s.id === req.params.id);
      if (!before) throw Object.assign(new Error("No such provider"), { status: 404 });
      const rate = Number(process.env.USD_INR_RATE) > 0 ? Number(process.env.USD_INR_RATE) : 90;
      const b = req.body || {};
      const balanceUsd = b.balanceInr !== undefined && b.balanceInr !== "" ? Number(b.balanceInr) / rate : b.balanceUsd !== undefined && b.balanceUsd !== "" ? Number(b.balanceUsd) : undefined;
      const mode = b.mode ?? (balanceUsd !== undefined && before.balance_mode === "postpaid" ? "manual" : undefined);
      const after = setSource(store, String(req.params.id), { mode, balanceUsd });
      audit(store, operator(res), "provider.set", String(req.params.id), { before: { mode: before.balance_mode, balance_micro: before.balance_micro }, after: { mode: after.balance_mode, balance_micro: after.balance_micro } });
      res.json(after);
    } catch (error) {
      fail(res, error);
    }
  });
  r.post("/sync", async (req, res) => {
    try {
      const target = String(req.body?.target);
      const out =
        target === "vercel-decision" ? await syncVercelLive(store, ["decision"]) : target === "vercel-chat" ? await syncVercelLive(store, ["chat"]) : target === "google" ? await syncGoogleLive(store) : null;
      if (!out) throw new Error("target: vercel-decision, vercel-chat or google");
      audit(store, operator(res), "catalog.sync", target, out.lines);
      res.json({ lines: out.lines });
    } catch (error) {
      fail(res, error);
    }
  });
  r.get("/routing", (req, res) => {
    const id = String(req.query.item || "");
    const item = getItem(store, id);
    if (!item) return void res.status(404).json({ error: `No item ${id}` });
    const p = plan(store, id);
    const strip = ({ key: _k, ...c }: any) => c;
    res.json({ item, price: priceOf(store, id), typical: p.typical, ranked: p.ranked.map(strip), excluded: p.excluded.map(strip), routes: routesOf(store, id).length });
  });
  r.put("/routes", (req, res) => {
    try {
      const b = req.body || {};
      const out = setRouteFlags(store, String(b.item), String(b.source), { priority: b.priority === undefined ? undefined : Number(b.priority), enabled: b.enabled === undefined ? undefined : !!b.enabled });
      audit(store, operator(res), "route.set", `${b.item} via ${b.source}`, out);
      res.json(out);
    } catch (error) {
      fail(res, error);
    }
  });

  r.get("/workspaces", (req, res) => res.json({ workspaces: workspaces(store, String(req.query.q || "")) }));
  r.post("/workspaces/:w/credits", (req, res) => {
    try {
      const amount = Number(req.body?.usd);
      if (!Number.isFinite(amount) || amount === 0) throw new Error("Give an amount in USD (negative to take credit away)");
      const w = String(req.params.w);
      if (!workspaces(store, "").some((x) => x.workspace === w)) throw Object.assign(new Error("No such workspace"), { status: 404 });
      const note = String(req.body?.note || "").slice(0, 200);
      const s = grantCredits(store, w, Math.round(amount * 1_000_000), operator(res), note);
      audit(store, operator(res), "credit.grant", w, { usd: amount, note, balance: s.balance });
      res.json(s);
    } catch (error) {
      fail(res, error);
    }
  });

  r.get("/calls", (req, res) => {
    const where: string[] = ["1=1"],
      args: (string | number)[] = [];
    const add = (clause: string, ...values: string[]) => {
      where.push(clause);
      args.push(...values);
    };
    if (req.query.status === "failed" || req.query.status === "ok") add("u.status=?", String(req.query.status));
    if (req.query.source) add("u.source=?", String(req.query.source));
    if (req.query.kind) add("u.kind=?", String(req.query.kind));
    if (req.query.q) add("(u.item_id LIKE ? OR u.workspace LIKE ?)", `%${req.query.q}%`, `%${req.query.q}%`);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = store.db.prepare(`SELECT u.*, i.name AS item_name FROM usage_calls u LEFT JOIN catalog_items i ON i.id=u.item_id WHERE ${where.join(" AND ")} ORDER BY u.id DESC LIMIT ${limit}`).all(...args);
    res.json({ calls: rows });
  });
  r.get("/audit", (_req, res) => res.json({ entries: store.db.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT 300").all() }));
  r.get("/operators", (_req, res) => res.json({ operators: listOperators(store) }));

  app.use("/api/admin", r);
}
