import type { Store } from "./store.js";
import { SEED_VERSION, seedModels } from "./model-seed.js";

// ── The catalog: what OrbytLink sells, how each thing is called, and what it costs and charges ──
//
// Five tables, in the same SQLite file as everything else:
//
//   catalog_items    one row per thing sold: a chat model, a decision model, a listed-only model, or a
//                    service such as a browser step. Name, kind, units, the model card link, and its
//                    LIST price (the public price per unit, before markup): what people pay is based on
//                    it, so the price stays the same whichever source answers.
//   catalog_routes   one row per way of calling an item: the source, the protocol, the full endpoint
//                    link, the item's id there (ref), the NAME of the environment variable holding the
//                    key (never the key itself), the header it goes in (default Authorization: Bearer),
//                    and the cost per unit at that source. Calling a model through another provider is
//                    one more row here. A source that costs more than the price is never used.
//   catalog_prices   a price set by hand for an item: a markup of its own, or a fixed price. No row
//                    means the default markup (AI_MARKUP_PERCENT) over the item's list price.
//   catalog_lists    ordered lists of items, such as the browser's decision models.
//   catalog_sources  one row per provider: how OrbytLink knows its balance there (read from the
//                    provider's API, recorded by hand, or postpaid) and the balance itself. A call only
//                    goes to a provider with credit left for it (see routing.ts).
//   usage_calls      the ledger: one row per paid call, kept for good. The item, the route that served
//                    it, the units used, what it cost OrbytLink (as the source reported it, or worked out
//                    from the route's cost), and what the workspace was charged. See ledger.ts.
//
// The backend reads only from these tables. Reads come from an in-memory copy that reloads whenever
// the database changes (including writes from `npm run account -- catalog …` in another process), so
// a lookup costs microseconds. Workspaces see item names and prices only, never sources, endpoints,
// key names or costs.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog_items (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('chat','decision','listed','service')),
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  category   TEXT NOT NULL,
  context    INTEGER,
  unit_in    TEXT,
  unit_out   TEXT,
  variable   INTEGER NOT NULL DEFAULT 0,
  info_url   TEXT,
  listed     INTEGER NOT NULL DEFAULT 1,
  origin     TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('seed','operator')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_routes (
  id         INTEGER PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  protocol   TEXT NOT NULL CHECK (protocol IN ('openai-chat','openai-decisions','internal')),
  endpoint   TEXT,
  ref        TEXT NOT NULL,
  key_env    TEXT,
  cost_in    REAL,
  cost_out   REAL,
  priority   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  origin     TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('seed','operator')),
  updated_at TEXT NOT NULL,
  UNIQUE (item_id, source)
);
CREATE INDEX IF NOT EXISTS catalog_routes_item ON catalog_routes(item_id);
CREATE TABLE IF NOT EXISTS catalog_prices (
  item_id    TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  markup_pct REAL,
  price_in   REAL,
  price_out  REAL,
  set_by     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((markup_pct IS NULL) <> (price_in IS NULL))
);
CREATE TABLE IF NOT EXISTS catalog_lists (
  list     TEXT NOT NULL,
  position INTEGER NOT NULL,
  item_id  TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  PRIMARY KEY (list, item_id)
);
CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_sources (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  balance_mode       TEXT NOT NULL CHECK (balance_mode IN ('api','manual','postpaid')),
  balance_micro      INTEGER,
  balance_checked_at TEXT,
  balance_url        TEXT,
  balance_key_env    TEXT,
  balance_field      TEXT,
  updated_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_calls (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  user          TEXT,
  via           TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  source        TEXT,
  route_ref     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok','failed')),
  units_in      REAL NOT NULL DEFAULT 0,
  units_out     REAL NOT NULL DEFAULT 0,
  cost_micro    INTEGER,
  cost_basis    TEXT CHECK (cost_basis IN ('reported','computed') OR cost_basis IS NULL),
  charged_micro INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS usage_calls_workspace ON usage_calls(workspace, at);
CREATE INDEX IF NOT EXISTS usage_calls_item ON usage_calls(item_id, at);
CREATE INDEX IF NOT EXISTS usage_calls_source ON usage_calls(source, at);
CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls(at);
`;

export type Kind = "chat" | "decision" | "listed" | "service";
export type Protocol = "openai-chat" | "openai-decisions" | "internal";
export type Item = { id: string; kind: Kind; name: string; provider: string; category: string; context: number | null; unit_in: string | null; unit_out: string | null; variable: number; info_url: string | null; listed: number; list_in: number | null; list_out: number | null; origin: "seed" | "operator"; updated_at: string };
export type Route = { id: number; item_id: string; source: string; protocol: Protocol; endpoint: string | null; ref: string; key_env: string | null; auth_header: string | null; cost_in: number | null; cost_out: number | null; priority: number; enabled: number; origin: "seed" | "operator"; updated_at: string };
export type PriceRule = { item_id: string; markup_pct: number | null; price_in: number | null; price_out: number | null; set_by: string; updated_at: string };
export type Price = { input: number | null; output: number | null; rule: string };

// The seed's source: Vercel AI Gateway. Every Vercel row has the same endpoint and key variable; only
// the model id (and its model card link) changes.
export const VERCEL = {
  source: "vercel",
  chat: "https://ai-gateway.vercel.sh/v1/chat/completions",
  decisions: "https://ai-gateway.vercel.sh/v1/decisions",
  keyEnv: "AI_GATEWAY_API_KEY",
  card: (id: string) => `https://vercel.com/ai-gateway/models/${id.split("/").pop()}`,
};
// Google AI Studio: OpenAI-compatible, the key as a Bearer token; its list prices match AI Gateway's.
// Two keys can be set: a paid one (GEMINI_API_KEY, billed at list price) and a free-tier one
// (GEMINI_FREE_API_KEY, cost 0). The free route ranks first on cost, so it's used until Google says its
// quota is spent (HTTP 429); the call then moves on and that route rests for a while (routing.ts).
export const GOOGLE = {
  source: "google",
  chat: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  models: "https://generativelanguage.googleapis.com/v1beta/openai/models",
  keyEnv: "GEMINI_API_KEY",
  free: { source: "google-free", keyEnv: "GEMINI_FREE_API_KEY" },
  // A model Google offers on no free tier: if a "free" key can call it, the key's project is billed.
  paidOnlyModel: "gemini-4-argon",
};
// Take away every route of one source (operator-made rows stay), e.g. when a key turns out not to be free.
export function dropSourceRoutes(store: Store, source: string) {
  ensureCatalog(store);
  const n = store.db.prepare("DELETE FROM catalog_routes WHERE source=? AND origin='seed'").run(source).changes;
  changed(store);
  return Number(n);
}
export const BROWSER_STEP = "orbytlink/browser-step";
// Calls through a workspace's own connections. Free ($0) until the operator prices them.
export const MCP_CALL = "orbytlink/mcp-call";
export const API_CALL = "orbytlink/api-call";
export const DECISION_LIST = "browser-decision";
// Jev was built for picking an operation and a page element; the others are cheap backups.
export const DEFAULT_DECISION = ["typesafe-ai/jev", "perplexity/pplx-decider-flash-v1.2", "microsoft/microsoft-decision-1"];

export const BAKED_MARKUP_PERCENT = 5;
// Default markups: set in the admin portal (stored in catalog_meta), else the .env value, else 5%.
const storedMarkup: { ai: number | null; instant: number | null } = { ai: null, instant: null };
export const defaultMarkup = (kind: "ai" | "instant") => storedMarkup[kind];
export function markupPercent() {
  if (storedMarkup.ai !== null) return storedMarkup.ai;
  const raw = process.env.AI_MARKUP_PERCENT?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : BAKED_MARKUP_PERCENT;
}
function loadMarkups(store: Store) {
  for (const kind of ["ai", "instant"] as const) {
    const v = meta(store, `markup_${kind}`);
    storedMarkup[kind] = v === undefined || v === "" ? null : Number(v);
  }
}
export function setDefaultMarkup(store: Store, kind: "ai" | "instant", percent: number | null) {
  ensureCatalog(store);
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 1000)) throw new Error("Markup: a percentage between 0 and 1000");
  if (percent === null) store.db.prepare("DELETE FROM catalog_meta WHERE key=?").run(`markup_${kind}`);
  else setMeta(store, `markup_${kind}`, String(percent));
  storedMarkup[kind] = percent;
  changed(store);
}

// A route names the variable that holds its key. Only key-like names are accepted, and never one of
// OrbytLink's own secrets, so a row can't send the server's master key or a payment key to an endpoint.
const OWN_SECRETS = new Set(["SECRET_KEY", "SCRAPER_TOKEN", "BROWSER_TOKEN", "RESEND_API_KEY", "CASHFREE_SECRET_KEY", "DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY", "GOOGLE_CLIENT_SECRET"]);
export function checkKeyEnv(name: string) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || !/(_API_KEY|_KEY|_TOKEN)$/.test(name) || OWN_SECRETS.has(name) || /_CLIENT_SECRET$|^INSTANT_|^SESSION/.test(name))
    throw new Error(`Key variable "${name}" isn't allowed: use a name ending in _API_KEY, _KEY or _TOKEN that isn't one of OrbytLink's own secrets.`);
  return name;
}
export function checkEndpoint(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`Endpoint "${value}" isn't a URL.`);
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("Endpoints must be https links without a username or password.");
  return u.href;
}

// ── Schema, seed and cache ────────────────────────────────────────────────────
type Cat = { items: Map<string, Item>; routes: Map<string, Route[]>; prices: Map<string, PriceRule>; lists: Map<string, string[]>; updatedAt: string };
const ready = new WeakSet<Store>();
const cache = new WeakMap<Store, { version: string; cat: Cat }>();
const local = new WeakMap<Store, number>();
const now = () => new Date().toISOString();
// One transaction, even when an import that is already in one calls a writer that wants one.
const inTx = new WeakSet<Store>();
function atomic<T>(store: Store, fn: () => T): T {
  if (inTx.has(store)) return fn();
  inTx.add(store);
  try {
    return store.transaction(fn);
  } finally {
    inTx.delete(store);
  }
}

export function ensureCatalog(store: Store) {
  if (ready.has(store)) return;
  store.db.exec("PRAGMA foreign_keys = ON;");
  store.db.exec(SCHEMA);
  migrate(store);
  ready.add(store);
  loadMarkups(store);
  seed(store);
  migrateLegacyUsage(store);
}
// Columns added after the first version of the tables.
function migrate(store: Store) {
  const has = (table: string, column: string) => (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has("catalog_items", "list_in")) store.db.exec("ALTER TABLE catalog_items ADD COLUMN list_in REAL; ALTER TABLE catalog_items ADD COLUMN list_out REAL;");
  if (!has("catalog_routes", "auth_header")) store.db.exec("ALTER TABLE catalog_routes ADD COLUMN auth_header TEXT;");
  if (!has("usage_calls", "latency_ms")) store.db.exec("ALTER TABLE usage_calls ADD COLUMN latency_ms INTEGER;");
  store.db.exec("CREATE INDEX IF NOT EXISTS usage_calls_route ON usage_calls(item_id, source, id)");
  // The providers the catalog ships with, and how their balance is known. Never overwrites a row.
  const at = now();
  const put = store.db.prepare("INSERT INTO catalog_sources(id,name,balance_mode,balance_url,balance_key_env,balance_field,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING");
  put.run("vercel", "Vercel AI Gateway", "api", "https://ai-gateway.vercel.sh/v1/credits", "AI_GATEWAY_API_KEY", "balance", at);
  put.run("google", "Google AI Studio", "postpaid", null, null, null, at);
  put.run("google-free", "Google AI Studio (free tier)", "postpaid", null, null, null, at);
  put.run("sarvam", "Sarvam Token Factory", "manual", null, null, null, at);
  put.run("orbytlink", "OrbytLink (own server)", "postpaid", null, null, null, at);
  // Calls through a workspace's own MCP servers and APIs: sold at $0 until the operator sets a price.
  for (const [id, name] of [[MCP_CALL, "MCP tool call"], [API_CALL, "API request"]]) {
    store.db.prepare("INSERT INTO catalog_items(id,kind,name,provider,category,unit_in,listed,origin,updated_at) VALUES(?,'service',?,'orbytlink','Service','call',0,'seed',?) ON CONFLICT(id) DO NOTHING").run(id, name, at);
    store.db.prepare("INSERT INTO catalog_routes(item_id,source,protocol,ref,cost_in,origin,updated_at) VALUES(?,'orbytlink','internal',?,0,'seed',?) ON CONFLICT(item_id,source) DO NOTHING").run(id, id.split("/")[1], at);
    store.db.prepare("INSERT INTO catalog_prices(item_id,price_in,set_by,updated_at) VALUES(?,0,'seed',?) ON CONFLICT(item_id) DO NOTHING").run(id, at);
  }
  // Items made before list prices existed take theirs from their Vercel route (AI Gateway's list price).
  store.db.exec("UPDATE catalog_items SET list_in=(SELECT cost_in FROM catalog_routes r WHERE r.item_id=catalog_items.id AND r.source='vercel'), list_out=(SELECT cost_out FROM catalog_routes r WHERE r.item_id=catalog_items.id AND r.source='vercel') WHERE list_in IS NULL AND kind<>'service'");
}
const meta = (store: Store, key: string) => (store.db.prepare("SELECT value FROM catalog_meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
const setMeta = (store: Store, key: string, value: string) => store.db.prepare("INSERT INTO catalog_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
// Every write goes through here, so this process's own cache reloads; other processes' commits are
// seen through SQLite's data_version.
function changed(store: Store) {
  local.set(store, (local.get(store) || 0) + 1);
  setMeta(store, "updated_at", now().slice(0, 10));
}

function seed(store: Store) {
  if (meta(store, "seed_version") === SEED_VERSION) return;
  atomic(store, () => {
    const at = now();
    const origin = (table: string, where: string, ...args: unknown[]) => (store.db.prepare(`SELECT origin FROM ${table} WHERE ${where}`).get(...(args as [])) as { origin: string } | undefined)?.origin;
    const putItem = store.db.prepare(
      `INSERT INTO catalog_items(id,kind,name,provider,category,context,unit_in,unit_out,variable,info_url,listed,list_in,list_out,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,'seed',?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,provider=excluded.provider,category=excluded.category,context=excluded.context,unit_in=excluded.unit_in,unit_out=excluded.unit_out,variable=excluded.variable,info_url=excluded.info_url,list_in=excluded.list_in,list_out=excluded.list_out,updated_at=excluded.updated_at`,
    );
    const putRoute = store.db.prepare(
      `INSERT INTO catalog_routes(item_id,source,protocol,endpoint,ref,key_env,cost_in,cost_out,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,'seed',?)
       ON CONFLICT(item_id,source) DO UPDATE SET protocol=excluded.protocol,endpoint=excluded.endpoint,ref=excluded.ref,key_env=excluded.key_env,cost_in=excluded.cost_in,cost_out=excluded.cost_out,updated_at=excluded.updated_at`,
    );
    const seeded = new Set<string>();
    for (const m of seedModels) {
      seeded.add(m.id);
      const kind: Kind = m.decision ? "decision" : m.callable ? "chat" : "listed";
      // Rows an operator added or edited are theirs: the seed never overwrites them.
      if (origin("catalog_items", "id=?", m.id) !== "operator")
        putItem.run(m.id, kind, m.name, m.provider, m.category, m.context, m.inputUnit, m.outputUnit, m.from ? 1 : 0, VERCEL.card(m.id), m.input, m.output, at);
      if (origin("catalog_routes", "item_id=? AND source=?", m.id, VERCEL.source) !== "operator")
        putRoute.run(m.id, VERCEL.source, kind === "decision" ? "openai-decisions" : "openai-chat", kind === "decision" ? VERCEL.decisions : VERCEL.chat, m.id, VERCEL.keyEnv, m.input, m.output, at);
    }
    for (const { id } of store.db.prepare("SELECT id FROM catalog_items WHERE origin='seed' AND kind<>'service'").all() as { id: string }[])
      if (!seeded.has(id)) store.db.prepare("DELETE FROM catalog_items WHERE id=?").run(id);
    // The browser's own step: run on OrbytLink's server, so its route is internal and costs nothing
    // by default (set a cost to count the server); sold at $0.001 a step unless priced otherwise.
    if (!origin("catalog_items", "id=?", BROWSER_STEP)) {
      store.db.prepare("INSERT INTO catalog_items(id,kind,name,provider,category,unit_in,listed,origin,updated_at) VALUES(?,'service','Browser step','orbytlink','Service','step',0,'seed',?)").run(BROWSER_STEP, at);
      store.db.prepare("INSERT INTO catalog_routes(item_id,source,protocol,ref,cost_in,origin,updated_at) VALUES(?,'orbytlink','internal','browser-step',0,'seed',?)").run(BROWSER_STEP, at);
      store.db.prepare("INSERT INTO catalog_prices(item_id,price_in,set_by,updated_at) VALUES(?,0.001,'seed',?) ON CONFLICT(item_id) DO NOTHING").run(BROWSER_STEP, at);
    }
    // The decision list must name decision models; an empty or outdated list gets the defaults.
    const list = store.db.prepare("SELECT l.item_id, i.kind FROM catalog_lists l LEFT JOIN catalog_items i ON i.id=l.item_id WHERE l.list=?").all(DECISION_LIST) as { item_id: string; kind: string | null }[];
    if (!list.length || list.some((r) => r.kind !== "decision")) writeList(store, DECISION_LIST, DEFAULT_DECISION.filter((id) => seeded.has(id)));
    setMeta(store, "seed_version", SEED_VERSION);
    if (!meta(store, "updated_at")) setMeta(store, "updated_at", SEED_VERSION.split("#")[0]);
  });
  changed(store);
}
// Usage recorded before the ledger existed (per-workspace JSON rows) moves into it once, without costs.
function migrateLegacyUsage(store: Store) {
  if (meta(store, "legacy_usage")) return;
  atomic(store, () => {
    const rows = store.db.prepare("SELECT workspace, data FROM records WHERE kind='ai_usage'").all() as { workspace: string; data: string }[];
    const insert = store.db.prepare("INSERT INTO usage_calls(at,workspace,user,via,item_id,kind,status,units_in,units_out,charged_micro,note) VALUES(?,?,?,?,?,?,'ok',?,?,?,'before the ledger')");
    for (const { workspace, data } of rows) {
      const u = JSON.parse(data);
      const model = String(u.model || "unknown");
      const kind = model === "browser" ? "service" : model.startsWith("instant:") ? "instant" : "chat";
      insert.run(u.createdAt || now(), workspace, u.user ?? null, u.via || "agent", model === "browser" ? BROWSER_STEP : model, kind, Number(u.inputTokens) || 0, Number(u.outputTokens) || 0, Number(u.micro) || 0);
    }
    const sales = store.db.prepare("SELECT data FROM records WHERE workspace='_instant' AND kind='instant_ledger'").all() as { data: string }[];
    const sale = store.db.prepare("INSERT INTO usage_calls(at,workspace,via,item_id,kind,source,status,cost_micro,cost_basis,charged_micro,note) VALUES(?,?,'agent',?,'instant',?,'ok',?,'reported',0,'before the ledger: cost only')");
    for (const { data } of sales) {
      const s = JSON.parse(data);
      sale.run(s.at || now(), s.workspace || "", `instant:${s.tool}`, s.source ?? null, Number(s.costMicro) || 0);
    }
    setMeta(store, "legacy_usage", now());
  });
}

function catalog(store: Store): Cat {
  ensureCatalog(store);
  const dv = (store.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  const version = `${dv}:${local.get(store) || 0}`;
  const hit = cache.get(store);
  if (hit && hit.version === version) return hit.cat;
  const items = new Map((store.db.prepare("SELECT * FROM catalog_items").all() as Item[]).map((i) => [i.id, i]));
  const routes = new Map<string, Route[]>();
  for (const r of store.db.prepare("SELECT * FROM catalog_routes").all() as Route[]) routes.set(r.item_id, [...(routes.get(r.item_id) || []), r]);
  const prices = new Map((store.db.prepare("SELECT * FROM catalog_prices").all() as PriceRule[]).map((p) => [p.item_id, p]));
  const lists = new Map<string, string[]>();
  for (const l of store.db.prepare("SELECT list, item_id FROM catalog_lists ORDER BY list, position").all() as { list: string; item_id: string }[]) lists.set(l.list, [...(lists.get(l.list) || []), l.item_id]);
  loadMarkups(store);
  const cat = { items, routes, prices, lists, updatedAt: meta(store, "updated_at") || SEED_VERSION.split("#")[0] };
  cache.set(store, { version, cat });
  return cat;
}

// ── Reading ──────────────────────────────────────────────────────────────────
export const getItem = (store: Store, id: string) => catalog(store).items.get(id);
export const catalogUpdatedAt = (store: Store) => catalog(store).updatedAt;
const cost = (r: Route) => (r.cost_in ?? 0) + (r.cost_out ?? 0);
const keyOf = (r: Route) => (r.key_env ? process.env[r.key_env]?.trim() || "" : "");
// A route can take calls when it's on and, unless it runs inside OrbytLink, its key variable is set.
export const routeLive = (r: Route) => !!r.enabled && (r.protocol === "internal" || (!!r.endpoint && !!keyOf(r)));
export const routesOf = (store: Store, itemId: string) => catalog(store).routes.get(itemId) || [];
export const keyFor = keyOf;
// Live routes, the operator's priority first, then the cheapest.
export function liveRoutes(store: Store, itemId: string): (Route & { key: string })[] {
  return (catalog(store).routes.get(itemId) || [])
    .filter(routeLive)
    .sort((a, b) => b.priority - a.priority || cost(a) - cost(b))
    .map((r) => ({ ...r, key: keyOf(r) }));
}
export const anyLive = (store: Store, kind: Kind) => [...catalog(store).items.values()].some((i) => i.kind === kind && callableRoutes(store, i.id).length > 0);
const round = (v: number | null) => (v === null ? null : Math.round(v * 1e9) / 1e9);
// What an item sells for, per unit, and why: its list price times the markup, or a price set by hand.
// It doesn't depend on which sources are live, so people see one steady price; a cheaper source is
// margin. An item with no list price is priced from its dearest route, so no route sells at a loss.
export function priceOf(store: Store, itemId: string): Price {
  const c = catalog(store);
  const rule = c.prices.get(itemId);
  if (rule && rule.price_in !== null) return { input: rule.price_in, output: rule.price_out, rule: "fixed" };
  const m = rule?.markup_pct ?? markupPercent();
  const item = c.items.get(itemId);
  const routes = c.routes.get(itemId) || [];
  const base = item?.list_in != null ? { cost_in: item.list_in, cost_out: item.list_out } : [...routes].sort((a, b) => cost(b) - cost(a))[0];
  if (!base) return { input: null, output: null, rule: "no route" };
  const k = 1 + m / 100;
  return { input: round(base.cost_in === null ? null : base.cost_in * k), output: round(base.cost_out === null ? null : base.cost_out * k), rule: `markup ${m}%${item?.list_in != null ? " on list" : " on dearest route"}` };
}
// The live routes a call may use: those whose cost fits under the price (a route with no cost on
// record is allowed; the ledger marks its cost unknown).
export function callableRoutes(store: Store, itemId: string) {
  const p = priceOf(store, itemId);
  const fits = (c: number | null, price: number | null) => c === null || price === null || c <= price + 1e-12;
  return liveRoutes(store, itemId).filter((r) => fits(r.cost_in, p.input) && fits(r.cost_out, p.output));
}
export const listOf = (store: Store, list: string) => catalog(store).lists.get(list) || [];
// The browser's decision models that can be called now, in the operator's order.
export const decisionModels = (store: Store) => listOf(store, DECISION_LIST).map((id) => getItem(store, id)).filter((i): i is Item => !!i && i.kind === "decision" && callableRoutes(store, i.id).length > 0);

const amount = (v: number | null) => (v === null ? null : String(Number(v.toFixed(9))));
// The catalog as workspaces see it: names and prices, nothing about sources or costs.
export function publicModels(store: Store) {
  return [...catalog(store).items.values()]
    .filter((i) => i.listed && i.kind !== "service")
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
    .map((i) => {
      const p = priceOf(store, i.id);
      return {
        id: i.id,
        name: i.name,
        provider: i.provider,
        category: i.category,
        context: i.context,
        input: p.input === null || !i.unit_in ? null : [amount(p.input), i.unit_in],
        output: p.output === null || !i.unit_out ? null : [amount(p.output), i.unit_out],
        ...(i.variable ? { from: true } : {}),
        callable: i.kind === "chat" && i.unit_in === "1M tokens" && i.unit_out === "1M tokens",
        ...(i.kind === "decision" ? { decision: true } : {}),
      };
    });
}

// ── Writing (operator only: npm run account -- catalog …) ─────────────────────
const usdAmount = (v: unknown, what: string) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`${what} must be a USD amount between 0 and 100000`);
  return n;
};
export type ItemInput = { id: string; kind?: Kind; name?: string; provider?: string; category?: string; context?: number | null; unit_in?: string | null; unit_out?: string | null; info_url?: string | null; listed?: boolean; list_in?: unknown; list_out?: unknown };
// Writes read the row straight from the table (not the cache), so a bulk import stays linear.
const itemRow = (store: Store, id: string) => store.db.prepare("SELECT * FROM catalog_items WHERE id=?").get(id) as Item | undefined;
export function upsertItem(store: Store, input: ItemInput) {
  ensureCatalog(store);
  if (!/^[a-z0-9][a-z0-9._:/-]{0,119}$/i.test(input.id)) throw new Error("Item id: letters, digits and . _ : / - only");
  const old = itemRow(store, input.id);
  const kind = input.kind ?? old?.kind ?? "chat";
  if (!["chat", "decision", "listed", "service"].includes(kind)) throw new Error("kind: chat, decision, listed or service");
  if (input.info_url) checkEndpoint(input.info_url);
  const row = {
    id: input.id,
    kind,
    name: input.name ?? old?.name ?? input.id.split("/").pop()!,
    provider: input.provider ?? old?.provider ?? (input.id.includes("/") ? input.id.split("/")[0] : "other"),
    category: input.category ?? old?.category ?? (kind === "decision" ? "Decision" : kind === "service" ? "Service" : "Text & reasoning"),
    context: input.context ?? old?.context ?? null,
    unit_in: input.unit_in ?? old?.unit_in ?? (kind === "service" ? "call" : "1M tokens"),
    unit_out: input.unit_out ?? old?.unit_out ?? (kind === "chat" ? "1M tokens" : null),
    info_url: input.info_url ?? old?.info_url ?? null,
    listed: input.listed ?? (old ? !!old.listed : kind !== "service"),
    list_in: input.list_in !== undefined ? usdAmount(input.list_in, "list_in") : (old?.list_in ?? null),
    list_out: input.list_out !== undefined ? usdAmount(input.list_out, "list_out") : (old?.list_out ?? null),
  };
  store.db
    .prepare(
      `INSERT INTO catalog_items(id,kind,name,provider,category,context,unit_in,unit_out,variable,info_url,listed,list_in,list_out,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,'operator',?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,provider=excluded.provider,category=excluded.category,context=excluded.context,unit_in=excluded.unit_in,unit_out=excluded.unit_out,info_url=excluded.info_url,listed=excluded.listed,list_in=excluded.list_in,list_out=excluded.list_out,origin='operator',updated_at=excluded.updated_at`,
    )
    .run(row.id, row.kind, row.name, row.provider, row.category, row.context, row.unit_in, row.unit_out, row.info_url, row.listed ? 1 : 0, row.list_in, row.list_out, now());
  changed(store);
  return itemRow(store, row.id)!;
}
export type RouteInput = { item: string; source: string; protocol?: Protocol; endpoint?: string | null; ref?: string; key_env?: string | null; auth_header?: string | null; cost_in?: unknown; cost_out?: unknown; priority?: number; enabled?: boolean };
// The header a source wants its key in, when it isn't "Authorization: Bearer <key>".
const BLOCKED_HEADERS = new Set(["host", "cookie", "content-length", "content-type", "transfer-encoding", "connection"]);
export function checkAuthHeader(name: string | null | undefined) {
  if (name === null || name === undefined || name === "" || name.toLowerCase() === "authorization") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/i.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) throw new Error(`Header "${name}" can't carry a key.`);
  return name.toLowerCase();
}
// Add a way of calling an item, or change one. The item must exist (add it with upsertItem first).
export function upsertRoute(store: Store, input: RouteInput) {
  ensureCatalog(store);
  const item = itemRow(store, input.item);
  if (!item) throw new Error(`No item "${input.item}". Add it first.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(input.source)) throw new Error("Source: a short lowercase name like vercel, groq or openrouter");
  const routeRow = () => store.db.prepare("SELECT * FROM catalog_routes WHERE item_id=? AND source=?").get(item.id, input.source) as Route | undefined;
  const old = routeRow();
  const protocol = input.protocol ?? old?.protocol ?? (item.kind === "decision" ? "openai-decisions" : item.kind === "service" ? "internal" : "openai-chat");
  if (!["openai-chat", "openai-decisions", "internal"].includes(protocol)) throw new Error("protocol: openai-chat, openai-decisions or internal");
  if ((item.kind === "decision") !== (protocol === "openai-decisions") && protocol !== "internal") throw new Error(`A ${item.kind} item can't use the ${protocol} protocol.`);
  const endpoint = protocol === "internal" ? null : checkEndpoint(input.endpoint ?? old?.endpoint ?? "");
  const keyEnv = protocol === "internal" ? null : checkKeyEnv(input.key_env ?? old?.key_env ?? "");
  const authHeader = protocol === "internal" ? null : checkAuthHeader(input.auth_header !== undefined ? input.auth_header : old?.auth_header);
  const r = {
    ref: input.ref ?? old?.ref ?? item.id,
    cost_in: input.cost_in !== undefined ? usdAmount(input.cost_in, "cost_in") : (old?.cost_in ?? null),
    cost_out: input.cost_out !== undefined ? usdAmount(input.cost_out, "cost_out") : (old?.cost_out ?? null),
    priority: input.priority ?? old?.priority ?? 0,
    enabled: input.enabled ?? (old ? !!old.enabled : true),
  };
  if (r.cost_in === null && (item.kind === "chat" || item.kind === "decision")) throw new Error("cost_in is required: what one unit costs at this source, in USD");
  store.db.prepare("INSERT INTO catalog_sources(id,name,balance_mode,updated_at) VALUES(?,?,'postpaid',?) ON CONFLICT(id) DO NOTHING").run(input.source, input.source, now());
  store.db
    .prepare(
      `INSERT INTO catalog_routes(item_id,source,protocol,endpoint,ref,key_env,auth_header,cost_in,cost_out,priority,enabled,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'operator',?)
       ON CONFLICT(item_id,source) DO UPDATE SET protocol=excluded.protocol,endpoint=excluded.endpoint,ref=excluded.ref,key_env=excluded.key_env,auth_header=excluded.auth_header,cost_in=excluded.cost_in,cost_out=excluded.cost_out,priority=excluded.priority,enabled=excluded.enabled,origin='operator',updated_at=excluded.updated_at`,
    )
    .run(item.id, input.source, protocol, endpoint, r.ref, keyEnv, authHeader, r.cost_in, r.cost_out, r.priority, r.enabled ? 1 : 0, now());
  changed(store);
  return routeRow()!;
}
export function removeRoute(store: Store, itemId: string, source: string) {
  if (!store.db.prepare("DELETE FROM catalog_routes WHERE item_id=? AND source=?").run(itemId, source).changes) throw new Error(`No ${source} route for ${itemId}`);
  changed(store);
}
export function removeItem(store: Store, itemId: string) {
  if (!store.db.prepare("DELETE FROM catalog_items WHERE id=?").run(itemId).changes) throw new Error(`No item ${itemId}`);
  changed(store);
}
// A markup of the item's own, a fixed price, or back to the default markup.
export function setPrice(store: Store, itemId: string, rule: { markup: number } | { input: unknown; output?: unknown } | "default", by = "operator") {
  ensureCatalog(store);
  if (!itemRow(store, itemId)) throw new Error(`No item ${itemId}`);
  if (rule === "default") store.db.prepare("DELETE FROM catalog_prices WHERE item_id=?").run(itemId);
  else {
    const markup = "markup" in rule ? Number(rule.markup) : null;
    if (markup !== null && (!Number.isFinite(markup) || markup < -100 || markup > 1000)) throw new Error("Markup: a percentage between -100 and 1000");
    const input = "input" in rule ? usdAmount(rule.input, "Input price") : null;
    const output = "input" in rule ? usdAmount(rule.output, "Output price") : null;
    if (markup === null && input === null) throw new Error("Give a markup or a price");
    store.db
      .prepare("INSERT INTO catalog_prices(item_id,markup_pct,price_in,price_out,set_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET markup_pct=excluded.markup_pct,price_in=excluded.price_in,price_out=excluded.price_out,set_by=excluded.set_by,updated_at=excluded.updated_at")
      .run(itemId, markup, input, output, by, now());
  }
  changed(store);
}
function writeList(store: Store, list: string, ids: string[]) {
  store.db.prepare("DELETE FROM catalog_lists WHERE list=?").run(list);
  const put = store.db.prepare("INSERT INTO catalog_lists(list,position,item_id) VALUES(?,?,?)");
  ids.forEach((id, n) => put.run(list, n, id));
}
export function setDecision(store: Store, ids: string[]) {
  ensureCatalog(store);
  const bad = ids.filter((id) => itemRow(store, id)?.kind !== "decision");
  if (!ids.length || bad.length) throw new Error(bad.length ? `Not a decision model: ${bad.join(", ")}` : "Give at least one model id");
  atomic(store, () => writeList(store, DECISION_LIST, [...new Set(ids)]));
  changed(store);
}

// ── Whole-catalog views for the operator ─────────────────────────────────────
// One line per item: what's charged, how, and every route with its cost, key variable and whether it's live.
export function describe(store: Store, query = "") {
  const q = query.toLowerCase();
  const c = catalog(store);
  return [...c.items.values()]
    .filter((i) => `${i.id} ${i.name} ${i.kind}`.toLowerCase().includes(q))
    .map((i) => ({
      item: i,
      price: priceOf(store, i.id),
      routes: (c.routes.get(i.id) || []).map((r) => ({ ...r, live: routeLive(r), keySet: !!keyOf(r) })),
    }));
}
// The whole catalog as JSON, to review, keep in version control, or load into another server.
export function exportCatalog(store: Store) {
  const c = catalog(store);
  return {
    items: [...c.items.values()].map(({ updated_at: _u, ...i }) => ({ ...i, routes: (c.routes.get(i.id) || []).map(({ id: _id, item_id: _item, updated_at: _ru, ...r }) => r), price: c.prices.get(i.id) ?? null })),
    lists: Object.fromEntries(c.lists),
  };
}
// A provider file can give costs in rupees (cost_in_inr / cost_out_inr); they are turned into dollars at
// USD_INR_RATE (default 90) when imported. An item that already exists keeps its own fields unless the
// file sets them, so a file can just add a route to a model the catalog already has.
const inrRate = () => {
  const n = Number(process.env.USD_INR_RATE);
  return Number.isFinite(n) && n > 0 ? n : 90;
};
const fromInr = (usd: unknown, inr: unknown) => (usd !== undefined && usd !== null ? usd : inr !== undefined && inr !== null ? Math.round((Number(inr) / inrRate()) * 1e9) / 1e9 : undefined);
export function importCatalog(store: Store, data: { items?: any[]; lists?: Record<string, string[]> }) {
  if (!data || !Array.isArray(data.items)) throw new Error('Expected {"items": [...]}');
  return atomic(store, () => {
    for (const i of data.items!) {
      const exists = !!itemRow(store, i.id);
      if (!exists || i.kind || i.name || i.list_in !== undefined || i.list_in_inr !== undefined)
        upsertItem(store, { id: i.id, kind: i.kind, name: i.name, provider: i.provider, category: i.category, context: i.context, unit_in: i.unit_in, unit_out: i.unit_out, info_url: i.info_url, listed: i.listed === undefined ? undefined : !!i.listed, list_in: fromInr(i.list_in, i.list_in_inr), list_out: fromInr(i.list_out, i.list_out_inr) });
      for (const r of i.routes || []) upsertRoute(store, { item: i.id, source: r.source, protocol: r.protocol, endpoint: r.endpoint, ref: r.ref, key_env: r.key_env, auth_header: r.auth_header, cost_in: fromInr(r.cost_in, r.cost_in_inr), cost_out: fromInr(r.cost_out, r.cost_out_inr), priority: r.priority, enabled: r.enabled === undefined ? undefined : !!r.enabled });
      if (i.price?.markup_pct != null) setPrice(store, i.id, { markup: i.price.markup_pct });
      else if (i.price?.price_in != null) setPrice(store, i.id, { input: i.price.price_in, output: i.price.price_out });
    }
    if (data.lists?.[DECISION_LIST]) setDecision(store, data.lists[DECISION_LIST]);
    return data.items!.length;
  });
}

// ── Syncing from a source's own model list ───────────────────────────────────
// AI Gateway publishes every model it serves at https://ai-gateway.vercel.sh/v1/models (public, no
// key): id, name, type, context window, input types and price per token. A sync adds the models it
// doesn't have yet and refreshes names and costs of the ones the seed or a sync made. Rows an operator
// changed stay as they are, and nothing is deleted: a model Vercel stops listing is reported, not removed.
export const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
type VercelModel = { id: string; name?: string; owned_by?: string; type?: string; context_window?: number; pricing?: { input?: string; output?: string } };
export function syncVercel(store: Store, models: VercelModel[], kinds: ("decision" | "chat")[] = ["decision"], dryRun = false) {
  ensureCatalog(store);
  const perMillion = (v?: string) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6 * 1e9) / 1e9);
  const wanted = models
    .map((m) => ({ m, kind: m.type === "evaluation" || m.type === "decision" ? ("decision" as const) : m.type === "language" ? ("chat" as const) : null }))
    .filter((x): x is { m: VercelModel; kind: "decision" | "chat" } => !!x.kind && kinds.includes(x.kind) && /^[a-z0-9][a-z0-9._:/-]{0,119}$/i.test(x.m.id) && perMillion(x.m.pricing?.input) !== null);
  const out = { added: [] as string[], costChanged: [] as string[], unchanged: 0, operatorKept: [] as string[], notListed: [] as string[] };
  const at = now();
  const run = () => {
    for (const { m, kind } of wanted) {
      const item = itemRow(store, m.id);
      const route = store.db.prepare("SELECT * FROM catalog_routes WHERE item_id=? AND source=?").get(m.id, VERCEL.source) as Route | undefined;
      const costIn = perMillion(m.pricing?.input),
        costOut = kind === "chat" ? perMillion(m.pricing?.output) : (perMillion(m.pricing?.output) ?? 0);
      if (item?.origin === "operator" || route?.origin === "operator") {
        out.operatorKept.push(m.id);
        continue;
      }
      if (!item) out.added.push(m.id);
      else if (route?.cost_in !== costIn || route?.cost_out !== costOut) out.costChanged.push(`${m.id}: ${route?.cost_in}/${route?.cost_out} → ${costIn}/${costOut}`);
      else out.unchanged++;
      if (dryRun) continue;
      store.db
        .prepare(
          `INSERT INTO catalog_items(id,kind,name,provider,category,context,unit_in,unit_out,variable,info_url,listed,list_in,list_out,origin,updated_at) VALUES(?,?,?,?,?,?,'1M tokens','1M tokens',0,?,1,?,?,'seed',?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,context=excluded.context,info_url=excluded.info_url,list_in=excluded.list_in,list_out=excluded.list_out,updated_at=excluded.updated_at`,
        )
        .run(m.id, kind, m.name || m.id, m.owned_by || m.id.split("/")[0], kind === "decision" ? "Decision" : "Text & reasoning", m.context_window || null, VERCEL.card(m.id), costIn, costOut, at);
      store.db
        .prepare(
          `INSERT INTO catalog_routes(item_id,source,protocol,endpoint,ref,key_env,cost_in,cost_out,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,'seed',?)
           ON CONFLICT(item_id,source) DO UPDATE SET protocol=excluded.protocol,endpoint=excluded.endpoint,ref=excluded.ref,key_env=excluded.key_env,cost_in=excluded.cost_in,cost_out=excluded.cost_out,updated_at=excluded.updated_at`,
        )
        .run(m.id, VERCEL.source, kind === "decision" ? "openai-decisions" : "openai-chat", kind === "decision" ? VERCEL.decisions : VERCEL.chat, m.id, VERCEL.keyEnv, costIn, costOut, at);
    }
    const listed = new Set(wanted.map((x) => x.m.id));
    for (const r of store.db.prepare("SELECT r.item_id FROM catalog_routes r JOIN catalog_items i ON i.id=r.item_id WHERE r.source='vercel' AND i.kind IN (" + kinds.map(() => "?").join(",") + ")").all(...kinds) as { item_id: string }[])
      if (!listed.has(r.item_id)) out.notListed.push(r.item_id);
    if (!dryRun) setMeta(store, "vercel_synced_at", at);
  };
  if (dryRun) run();
  else atomic(store, run);
  if (!dryRun) changed(store);
  return out;
}

// Google AI Studio lists the models a key can call at GET /v1beta/openai/models. For each one the
// catalog already sells as google/<id>, a google route is added at that item's list price (Google's
// own list prices are the ones AI Gateway resells at). Models the catalog doesn't have are reported.
export function syncGoogle(store: Store, models: { id: string }[], tier: "paid" | "free" = "paid") {
  ensureCatalog(store);
  const source = tier === "free" ? GOOGLE.free.source : GOOGLE.source;
  const keyEnv = tier === "free" ? GOOGLE.free.keyEnv : GOOGLE.keyEnv;
  const out = { added: [] as string[], updated: [] as string[], operatorKept: [] as string[], notInCatalog: [] as string[] };
  const at = now();
  atomic(store, () => {
    for (const m of models) {
      const ref = String(m.id || "").replace(/^models\//, "");
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(ref)) continue;
      const item = itemRow(store, `google/${ref}`);
      if (!item || item.kind !== "chat") {
        out.notInCatalog.push(ref);
        continue;
      }
      const old = store.db.prepare("SELECT origin FROM catalog_routes WHERE item_id=? AND source=?").get(item.id, source) as { origin: string } | undefined;
      if (old?.origin === "operator") {
        out.operatorKept.push(item.id);
        continue;
      }
      (old ? out.updated : out.added).push(item.id);
      store.db
        .prepare(
          `INSERT INTO catalog_routes(item_id,source,protocol,endpoint,ref,key_env,cost_in,cost_out,origin,updated_at) VALUES(?,?,'openai-chat',?,?,?,?,?,'seed',?)
           ON CONFLICT(item_id,source) DO UPDATE SET endpoint=excluded.endpoint,ref=excluded.ref,key_env=excluded.key_env,cost_in=excluded.cost_in,cost_out=excluded.cost_out,updated_at=excluded.updated_at`,
        )
        .run(item.id, source, GOOGLE.chat, ref, keyEnv, tier === "free" ? 0 : item.list_in, tier === "free" ? 0 : item.list_out, at);
    }
  });
  changed(store);
  return out;
}

// The operator's own price rule for an item (undefined: default markup).
export const priceRule = (store: Store, itemId: string) => catalog(store).prices.get(itemId);
// Turn a route on or off, or pin it (priority), without taking it over from its source's sync.
export function setRouteFlags(store: Store, itemId: string, source: string, flags: { priority?: number; enabled?: boolean }) {
  ensureCatalog(store);
  const r = store.db.prepare("SELECT * FROM catalog_routes WHERE item_id=? AND source=?").get(itemId, source) as Route | undefined;
  if (!r) throw new Error(`No ${source} route for ${itemId}`);
  if (flags.priority !== undefined && (!Number.isInteger(flags.priority) || flags.priority < 0 || flags.priority > 100)) throw new Error("Priority: a whole number from 0 to 100");
  store.db.prepare("UPDATE catalog_routes SET priority=?, enabled=?, updated_at=? WHERE id=?").run(flags.priority ?? r.priority, flags.enabled === undefined ? r.enabled : flags.enabled ? 1 : 0, now(), r.id);
  changed(store);
  return { before: { priority: r.priority, enabled: !!r.enabled }, after: { priority: flags.priority ?? r.priority, enabled: flags.enabled ?? !!r.enabled } };
}
