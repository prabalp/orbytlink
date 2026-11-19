import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Row } from "./store.js";
import type { Identity } from "./schema.js";
import { addBalance, addMonth, aiSummary, usd } from "./ai.js";
import { clean, safeFail as fail, scrub, slugify, type Route, type Upstream } from "./instant/upstream.js";
import { sources } from "./instant/sources.js";
export { scrub } from "./instant/upstream.js";

// Instant tools: thousands of data APIs (search results, scraping, people and company data, social
// media, SEO, ads, market data…) that every workspace can call with no account of its own. OrbytLink
// buys them wholesale from several sources and sells them under its own name. Workspaces see one
// catalog and one price per tool; which source serves a call is decided here and never shown.
//
// - The catalog is the union of every source's tools. Tools that are the same call (the same
//   provider's same method and path) are merged into one tool with several routes.
// - The price is a static quote per tool, set by the operator (a default is made once, from the
//   cheapest route plus the markup, when a tool first appears; it never changes by itself).
// - A call goes to the cheapest route whose source has the money for it (its balance from its API,
//   or from the wallet table the operator keeps). A source that is down, busy or out of money is
//   skipped and the next cheapest is tried. The upstream is told the most it may charge (the quote
//   less the margin), so a call never costs OrbytLink more than it earns.
export const INSTANT_SEARCH = "orbytlink__instant_search",
  INSTANT_GET = "orbytlink__instant_get",
  INSTANT_CALL = "orbytlink__instant_call";
const GLOBAL = "_instant";
const SYNC_EVERY = 24 * 3600_000;
const BALANCE_EVERY = 5 * 60_000;
const live = (): Upstream[] => sources().filter((s) => s.configured());
export const instantConfigured = () => live().length > 0;
export function instantMarkup() {
  const n = Number(process.env.INSTANT_MARKUP_PERCENT ?? 5);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 5;
}

// ── The union catalog ────────────────────────────────────────────────────────
type RouteRef = Pick<Route, "upstream" | "ref" | "costUsd" | "method" | "path" | "best">;
export type InstantTool = {
  id: string;
  key: string;
  provider: string;
  name: string;
  summary: string;
  job: string;
  group: string;
  method: string;
  best: boolean;
  unit: { type: string; unit: string; per: number };
  input: unknown;
  example: unknown;
  reliability: Route["reliability"];
  docs: string;
  routes: RouteRef[];
};
export type InstantGroup = { slug: string; label: string; category: string; summary: string; tools: number; providers: number };
let memo: { at: number; groups: InstantGroup[]; tools: InstantTool[]; byId: Map<string, InstantTool> } | undefined;
let routeMemo: { at: number; map: Map<string, Route> } | undefined;
function routeFor(store: Store, upstream: string, ref: string) {
  if (!routeMemo || routeMemo.at < Date.now() - 600_000) {
    const map = new Map<string, Route>();
    for (const row of store.list(GLOBAL, "instant_routes")) for (const r of row.routes as Route[]) map.set(`${r.upstream}|${r.ref}`, r);
    routeMemo = { at: Date.now(), map };
  }
  return routeMemo.map.get(`${upstream}|${ref}`);
}
function loadCatalog(store: Store) {
  if (memo && memo.at > Date.now() - 600_000) return memo;
  const head = store.list(GLOBAL, "instant_meta").find((r) => r.id === "catalog");
  const tools = store.list(GLOBAL, "instant_tools").flatMap((r) => r.tools as InstantTool[]);
  memo = { at: Date.now(), groups: head?.groups || [], tools, byId: new Map(tools.map((t) => [t.id, t])) };
  return memo;
}
export const catalogSyncedAt = (store: Store): string | null => store.list(GLOBAL, "instant_meta").find((r) => r.id === "catalog")?.syncedAt ?? null;

// Each source's routes are kept apart, so a source that can't be reached keeps yesterday's list.
export async function syncCatalog(store: Store) {
  const report: Record<string, number | string> = {};
  for (const s of sources()) {
    try {
      const routes = await s.catalog();
      if (!routes.length) throw new Error("empty catalog");
      store.put(GLOBAL, "instant_routes", { id: s.id, routes, syncedAt: new Date().toISOString() });
      report[s.id] = routes.length;
    } catch (error) {
      report[s.id] = `kept previous (${(error as Error).message.slice(0, 120)})`;
    }
  }
  const out = rebuild(store);
  return { ...out, sources: report };
}
// Merge every source's routes into one catalog, and give new tools their quote.
export function rebuild(store: Store) {
  const order = sources().map((s) => s.id);
  // Only sources that can take calls; before any is set up, every catalog is shown as a preview.
  const on = new Set(live().map((s) => s.id));
  const all = store
    .list(GLOBAL, "instant_routes")
    .filter((r) => !on.size || on.has(r.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .flatMap((r) => r.routes as Route[]);
  const byKey = new Map<string, InstantTool>();
  // A route that doesn't say its method matches a tool on the same provider and path.
  const byPath = new Map<string, InstantTool>();
  const pathOf = (key: string) => key.replace(/:[A-Z]+ /, ":");
  const groups = new Map<string, Route["group"]>();
  const taken = new Set<string>();
  for (const r of all) {
    const known = byKey.get(r.key) ?? (r.method === "ANY" ? byPath.get(pathOf(r.key)) : undefined);
    const ref: RouteRef = { upstream: r.upstream, ref: r.ref, costUsd: r.costUsd, method: r.method, path: r.path, best: r.best };
    if (known) {
      if (!known.routes.some((x) => x.upstream === r.upstream)) known.routes.push(ref);
      if (!known.reliability && r.reliability) known.reliability = r.reliability;
      continue;
    }
    let id = r.id || `${slugify(r.provider) || "tool"}.${slugify(r.name) || "call"}`;
    for (let n = 2; taken.has(id); n++) id = `${r.id || `${slugify(r.provider)}.${slugify(r.name)}`}_${n}`;
    taken.add(id);
    groups.set(r.group.slug, groups.get(r.group.slug) || r.group);
    const tool: InstantTool = {
      id,
      key: r.key,
      // Scrubbed again here, so no source's name can reach the catalog even if its adapter missed one.
      provider: scrub(r.provider),
      name: scrub(r.name),
      summary: scrub(r.summary),
      job: scrub(r.job),
      group: r.group.slug,
      method: r.method,
      best: r.best,
      unit: { type: r.costType, unit: r.unit, per: r.per },
      input: r.input,
      example: r.example,
      reliability: r.reliability,
      docs: r.docs,
      routes: [ref],
    };
    byKey.set(r.key, tool);
    if (r.method !== "ANY" && r.path) byPath.set(pathOf(r.key), tool);
  }
  const tools = [...byKey.values()];
  // Quotes saved by earlier versions for every tool are dropped: a tool's price now follows the
  // markup, and only the operator's own prices are stored.
  for (const p of store.list(GLOBAL, "instant_prices")) if (p.by === "default") store.remove(GLOBAL, "instant_prices", p.id);
  // A tool is sold when a route prices it or the operator has; the rest wait for a price.
  const set = operatorQuotes(store);
  const prices = new Set(tools.filter((t) => set.has(t.id) || autoQuote(t) !== undefined).map((t) => t.id));
  const sellable = tools.filter((t) => prices.has(t.id));
  const groupRows: InstantGroup[] = [...groups.values()]
    .map((g) => {
      const mine = sellable.filter((t) => t.group === g.slug);
      return { ...g, tools: mine.length, providers: new Set(mine.filter((t) => !t.best).map((t) => t.provider)).size };
    })
    .filter((g) => g.tools > 0);
  for (const r of store.list(GLOBAL, "instant_tools")) if (!groupRows.some((g) => g.slug === r.id)) store.remove(GLOBAL, "instant_tools", r.id);
  for (const g of groupRows) store.put(GLOBAL, "instant_tools", { id: g.slug, tools: sellable.filter((t) => t.group === g.slug) });
  // Tools no route prices: listed for the operator, sold once priced.
  const unpriced = tools.filter((t) => !prices.has(t.id)).map((t) => t.id);
  store.put(GLOBAL, "instant_meta", { id: "catalog", groups: groupRows, unpriced, syncedAt: new Date().toISOString() });
  memo = undefined;
  routeMemo = undefined;
  return { groups: groupRows.length, tools: sellable.length, merged: sellable.filter((t) => t.routes.length > 1).length };
}
let syncing: Promise<unknown> | undefined;
export function syncIfStale(store: Store) {
  const at = catalogSyncedAt(store);
  if (syncing || (at && Date.parse(at) > Date.now() - SYNC_EVERY)) return;
  syncing = syncCatalog(store)
    .then((r) => console.log(`[instant] catalog synced: ${JSON.stringify(r)}`))
    .catch((error) => console.warn(`[instant] catalog sync failed: ${(error as Error).message}`))
    .finally(() => (syncing = undefined));
}
export function startInstantSync(store: Store) {
  syncIfStale(store);
  setInterval(() => syncIfStale(store), 3600_000).unref();
}

// ── Quotes ───────────────────────────────────────────────────────────────────
// A tool's price is the cheapest route's cost times (1 + INSTANT_MARKUP_PERCENT/100), rounded up to
// $0.0001, worked out when asked so a new markup applies on restart. A price the operator sets for
// a tool is stored and wins over it.
function autoQuote(t: Pick<InstantTool, "routes" | "best">): number | undefined {
  const costs = t.routes.map((x) => x.costUsd).filter((v): v is number => v !== null);
  if (!costs.length) return undefined;
  // From the cheapest route: a dearer route is used only while its cost still fits under the quote.
  const cheapest = Math.min(...costs);
  const quote = cheapest === 0 ? 0 : Math.ceil((cheapest * (1 + instantMarkup() / 100) * 1_000_000) / 100) * 100;
  return t.best ? Math.max(quote, 2000) : quote;
}
const operatorQuotes = (store: Store) =>
  new Map(store.list(GLOBAL, "instant_prices").filter((p) => p.by !== "default").map((p) => [p.id as string, p.micro as number]));
const quoteOf = (store: Store, id: string): number | undefined => {
  const set = operatorQuotes(store).get(id);
  if (set !== undefined) return set;
  const t = loadCatalog(store).byId.get(id);
  return t ? autoQuote(t) : undefined;
};
const quotes = (store: Store) => {
  const set = operatorQuotes(store);
  const out = new Map<string, number>();
  for (const t of loadCatalog(store).tools) {
    const q = set.get(t.id) ?? autoQuote(t);
    if (q !== undefined) out.set(t.id, q);
  }
  return out;
};
// The operator sets a tool's price (npm run account -- instant price <tool> <usd>).
export function setQuote(store: Store, id: string, priceUsd: number, by: string) {
  const unpriced: string[] = store.list(GLOBAL, "instant_meta").find((r) => r.id === "catalog")?.unpriced || [];
  if (!loadCatalog(store).byId.has(id) && !unpriced.includes(id) && !store.list(GLOBAL, "instant_prices").some((p) => p.id === id)) throw fail(`No instant tool "${id}".`, 404);
  if (!Number.isFinite(priceUsd) || priceUsd < 0 || priceUsd > 100) throw fail("Give a price in USD between 0 and 100.", 400);
  store.put(GLOBAL, "instant_prices", { id, micro: Math.round(priceUsd * 1_000_000), by });
  memo = undefined;
}

// The whole list, for the operator to review or edit (CSV: tool,price_usd,cheapest_cost_usd,routes,set_by).
export function priceList(store: Store) {
  const q = new Map(store.list(GLOBAL, "instant_prices").filter((p) => p.by !== "default").map((p) => [p.id as string, p]));
  return loadCatalog(store).tools.map((t) => {
    const costs = t.routes.map((r) => r.costUsd).filter((v): v is number => v !== null);
    const p = q.get(t.id);
    const auto = autoQuote(t);
    const priceUsd = p ? p.micro / 1_000_000 : auto === undefined ? null : auto / 1_000_000;
    return { tool: t.id, priceUsd, cheapestCostUsd: costs.length ? Math.min(...costs) : null, routes: t.routes.map((r) => r.upstream).join(""), setBy: p?.by ?? (auto === undefined ? "" : `markup ${instantMarkup()}%`) };
  }).concat(
    ((store.list(GLOBAL, "instant_meta").find((r) => r.id === "catalog")?.unpriced || []) as string[]).map((tool) => ({ tool, priceUsd: null, cheapestCostUsd: null, routes: "", setBy: "unpriced" })),
  );
}

// ── Wallets: what each source still holds of OrbytLink's money ────────────────
type Wallet = { id: string; micro: number; from: "api" | "manual"; checkedAt: string };
const wallets = (store: Store) => new Map(store.list(GLOBAL, "instant_wallets").map((w) => [w.id as string, w as unknown as Wallet]));
// For a source with no balance API, the operator records what was paid in (npm run account -- instant wallet <source> <usd>).
export function setWallet(store: Store, source: string, balanceUsd: number) {
  if (!sources().some((s) => s.id === source)) throw fail(`Unknown source "${source}".`, 404);
  store.put(GLOBAL, "instant_wallets", { id: source, micro: Math.round(balanceUsd * 1_000_000), from: "manual", checkedAt: new Date().toISOString() });
}
export const walletReport = (store: Store) => sources().map((s) => ({ source: s.id, configured: s.configured(), wallet: wallets(store).get(s.id) ?? null, down: breakerOpen(s.id) }));
const refreshing = new Map<string, Promise<void>>();
async function refreshBalances(store: Store) {
  const now = Date.now();
  const have = wallets(store);
  await Promise.all(
    live()
      .filter((s) => s.balance && !(have.get(s.id)?.from === "api" && Date.parse(have.get(s.id)!.checkedAt) > now - BALANCE_EVERY) && have.get(s.id)?.from !== "manual")
      .map((s) => {
        let p = refreshing.get(s.id);
        if (!p) {
          p = Promise.race([s.balance!(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))])
            .then((micro) => {
              if (micro !== undefined) store.put(GLOBAL, "instant_wallets", { id: s.id, micro, from: "api", checkedAt: new Date().toISOString() });
            })
            .catch(() => undefined)
            .finally(() => refreshing.delete(s.id));
          refreshing.set(s.id, p);
        }
        return p;
      }),
  );
}
function spendFromWallet(store: Store, source: string, micro: number) {
  if (!micro) return;
  const w = wallets(store).get(source);
  if (w) store.put(GLOBAL, "instant_wallets", { ...w, micro: w.micro - micro });
}

// A source that keeps failing is left alone for five minutes.
const breaker = new Map<string, { fails: number; until: number }>();
const breakerOpen = (id: string) => (breaker.get(id)?.until ?? 0) > Date.now();
function noteFailure(id: string) {
  const b = breaker.get(id) || { fails: 0, until: 0 };
  b.fails++;
  if (b.fails >= 3) b.until = Date.now() + 5 * 60_000;
  breaker.set(id, b);
}
const noteSuccess = (id: string) => breaker.delete(id);
export const resetBreakers = () => breaker.clear();

// ── What workspaces see: tools and quotes, never routes or sources ─────────────
const publicTool = (t: InstantTool, quote: number | undefined) => {
  const { routes: _routes, key: _key, ...rest } = t;
  return { ...rest, price: { usd: quote === undefined ? null : quote / 1_000_000, ...t.unit } };
};
export function instantPlatforms(store: Store) {
  const c = loadCatalog(store);
  const q = quotes(store);
  return {
    configured: instantConfigured(),
    syncedAt: catalogSyncedAt(store),
    platforms: c.groups.map((g) => {
      const prices = c.tools.filter((t) => t.group === g.slug).map((t) => q.get(t.id)).filter((v): v is number => v !== undefined);
      return { ...g, priceFrom: prices.length ? Math.min(...prices) / 1_000_000 : null };
    }),
  };
}
export function instantPlatform(store: Store, slug: string) {
  const c = loadCatalog(store);
  const g = c.groups.find((x) => x.slug === slug);
  if (!g) throw fail("Unknown group of tools.", 404);
  const q = quotes(store);
  const tools = c.tools.filter((t) => t.group === slug).map((t) => publicTool(t, q.get(t.id)));
  const prices = tools.map((t) => t.price.usd).filter((v): v is number => v !== null);
  return { platform: { ...g, priceFrom: prices.length ? Math.min(...prices) : null }, tools };
}
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) || [];
const brief = (t: InstantTool, quote: number | undefined) => ({
  id: t.id,
  name: t.name,
  provider: t.provider,
  does: t.summary || t.job,
  method: t.method,
  priceUsd: quote === undefined ? null : quote / 1_000_000,
  priced: `${t.unit.type.replace("_", " ")}${t.unit.unit !== "call" ? ` (${t.unit.per > 1 ? `${t.unit.per} ` : ""}${t.unit.unit})` : ""}`,
  worksPercent: t.reliability ? Math.round(t.reliability.okRate * 100) : null,
});
export function searchInstant(store: Store, query: string, limit = 15) {
  const c = loadCatalog(store);
  const q = quotes(store);
  const terms = words(query).filter((w) => w.length > 1);
  if (!terms.length) return [];
  const all = c.tools.map((t) => {
    const hay = `${t.id} ${t.name} ${t.summary} ${t.job} ${t.provider} ${t.group}`.toLowerCase();
    const share = terms.filter((w) => hay.includes(w)).length / terms.length;
    const rel = t.reliability ? t.reliability.okRate : 0.9;
    const price = (q.get(t.id) ?? 1_000_000) / 1_000_000;
    return { t, share, score: share + (t.best ? 0.3 : 0) + rel * 0.2 - Math.min(price, 1) * 0.5 };
  });
  // Every word, or failing that most of them; then the "best" tools, reliability and price.
  let hits = all.filter((x) => x.share === 1);
  if (!hits.length) hits = all.filter((x) => x.share >= 0.6);
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ t }) => brief(t, q.get(t.id)));
}
export function instantTool(store: Store, id: string) {
  const c = loadCatalog(store);
  const t = c.byId.get(id);
  if (!t) throw fail(`No instant tool "${id}". Find one with ${INSTANT_SEARCH}.`, 404);
  const q = quotes(store);
  // Other tools for the same job, cheapest first.
  const others = t.job
    ? c.tools
        .filter((x) => x.job === t.job && x.id !== t.id && x.group === t.group)
        .sort((a, b) => Number(b.best) - Number(a.best) || (q.get(a.id) ?? 9e9) - (q.get(b.id) ?? 9e9))
        .slice(0, 8)
        .map((x) => brief(x, q.get(x.id)))
    : [];
  return { ...publicTool(t, q.get(t.id)), alternatives: others };
}

// ── Calling ──────────────────────────────────────────────────────────────────
export const instantSearchSchema = {
  type: "object",
  properties: { query: { type: "string", description: 'The job in a few words, e.g. "google search results", "work email from linkedin", "instagram profile", "backlinks for a domain"' } },
  required: ["query"],
};
export const instantGetSchema = { type: "object", properties: { id: { type: "string", description: "A tool id from orbytlink__instant_search" } }, required: ["id"] };
export const instantCallSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Tool id, e.g. best.web.search" },
    query: { type: "object", description: "Query parameters, as orbytlink__instant_get lists them" },
    body: { description: "JSON body, for tools that take one" },
    waterfall: { type: "boolean", description: "best.* tools: false asks only the cheapest provider" },
    strictFilters: { type: "boolean", description: "best.* tools: skip providers that can't apply every filter you sent" },
    verify: { type: "boolean", description: "Email and phone finds: check each hit in the same call" },
    complete: { type: "boolean", description: "best.* tools: keep asking until every field is filled" },
    domainMatch: { type: "string", enum: ["strict"], description: "Email finds: keep looking past an address at another domain" },
  },
  required: ["id"],
};
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional();
const callSchema = z.object({
  id: z.string().min(3).max(200),
  query: z.union([z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])), z.string().transform((s) => (s.trim() ? JSON.parse(s) : undefined))]).optional(),
  body: z.unknown().optional(),
  waterfall: bool,
  strictFilters: bool,
  verify: bool,
  complete: bool,
  domainMatch: z.literal("strict").optional(),
});
const tag = (s: string) => s.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120) || "unknown";

export type InstantResult = { id: string; status: number; costUsd: number; servedBy?: string; pending?: boolean; result: unknown };
export async function callInstant(store: Store, identity: Identity, input: unknown, via: "agent" | "workflow"): Promise<InstantResult> {
  const w = identity.workspace;
  if (!instantConfigured()) throw fail("Instant tools are not switched on for this OrbytLink server yet.");
  const a = callSchema.parse(input);
  const t = loadCatalog(store).byId.get(a.id);
  if (!t) throw fail(`No instant tool "${a.id}". Find one with ${INSTANT_SEARCH}.`, 404);
  const quote = quoteOf(store, t.id);
  if (quote === undefined) throw fail(`"${t.id}" has no price yet, so it can't be called.`, 409);
  // What a source may charge for this call: the quote less the margin, so it never costs more than it earns.
  const ceilingMicro = Math.floor(quote / (1 + instantMarkup() / 100));
  const s = aiSummary(store, w);
  if (!s.enabled) throw fail("An admin has turned paid tools off for this workspace.");
  if (s.balance < quote) throw fail(`Not enough credit: this call costs $${usd(quote).toFixed(4)} and the balance is $${usd(s.balance).toFixed(2)}.`, 402);
  if (s.monthlyLimit !== null && s.monthSpent + quote > s.monthlyLimit) throw fail(`This call would pass the workspace's monthly limit of $${usd(s.monthlyLimit).toFixed(2)}.`, 402);

  // The routes worth trying: a configured source that isn't resting after failures, has the money
  // for the call, and whose cost fits under the ceiling; cheapest first, then most reliable.
  await refreshBalances(store);
  const ws = wallets(store);
  const byId = new Map(live().map((x) => [x.id, x]));
  const plan = t.routes
    .filter((r) => byId.has(r.upstream) && !breakerOpen(r.upstream))
    .map((r) => ({ r, cost: r.costUsd === null ? ceilingMicro : Math.ceil(r.costUsd * 1_000_000) }))
    .filter(({ r, cost }) => cost <= ceilingMicro && (ws.get(r.upstream)?.micro ?? Infinity) >= Math.max(cost, r.best ? ceilingMicro : cost))
    .sort((x, y) => x.cost - y.cost);
  if (!plan.length) throw fail("This tool is briefly unavailable. No credit was used; try again later or pick another tool.", 503);

  addBalance(store, w, -quote);
  addMonth(store, w, quote);
  let charged = 0;
  try {
    for (const { r } of plan) {
      const source = byId.get(r.upstream)!;
      const route = routeFor(store, r.upstream, r.ref);
      if (!route) continue;
      const out = await source.call(route, {
        query: a.query,
        body: a.body,
        options: { waterfall: a.waterfall, strictFilters: a.strictFilters, verify: a.verify, complete: a.complete, domainMatch: a.domainMatch },
        maxCostUsd: ceilingMicro / 1_000_000,
        tag: tag(w),
        idempotencyKey: randomUUID(),
      });
      spendFromWallet(store, source.id, out.costMicro);
      if (out.unavailable) {
        noteFailure(source.id);
        if (out.accountProblem) console.error(`[instant] source ${source.id} account problem: ${out.accountProblem}`);
        continue;
      }
      noteSuccess(source.id);
      if (out.refusal) throw fail(out.refusal, 400);
      if (out.status < 200 || (out.status >= 300 && out.status !== 202)) throw fail(`The provider answered HTTP ${out.status}: ${scrub(out.text).slice(0, 400)}`, 400);
      charged = quote;
      store.put(w, "ai_usage", { model: `instant:${t.id}`, inputTokens: 0, outputTokens: 0, micro: charged, user: identity.user, via, createdAt: new Date().toISOString() });
      store.trim(w, "ai_usage", 2000);
      store.audit(w, identity.user, "instant.call", `${t.id} · ${out.status} · $${usd(charged).toFixed(6)}`);
      // The internal side of the sale, for the operator's margins (never shown to the workspace).
      store.put(GLOBAL, "instant_ledger", { tool: t.id, source: source.id, workspace: w, costMicro: out.costMicro, priceMicro: quote, at: new Date().toISOString() });
      store.trim(GLOBAL, "instant_ledger", 20_000);
      return { id: t.id, status: out.status, costUsd: usd(charged), ...(out.servedBy && !route.best ? {} : out.servedBy ? { servedBy: out.servedBy } : {}), ...(out.pending ? { pending: true } : {}), result: out.json === undefined ? scrub(out.text) : clean(out.json) };
    }
    throw fail("This tool is briefly unavailable. No credit was used; try again later or pick another tool.", 503);
  } finally {
    addBalance(store, w, quote - charged);
    addMonth(store, w, charged - quote);
  }
}
export type { Row };
