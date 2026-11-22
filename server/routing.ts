import type { Store } from "./store.js";
import { ensureCatalog, keyFor, priceOf, routesOf, type Protocol, type Route } from "./catalog.js";

// ── Which provider serves a call ─────────────────────────────────────────────
//
// For a model sold by several providers (say Vercel, Google and Sarvam), every call is routed like this:
//
//   1. Filter: only providers that can take the call. The route is on, its key variable is set, its
//      cost fits under the price (no call sells at a loss), and OrbytLink has CREDIT LEFT at that
//      provider for this call's worst-case cost. A postpaid provider always has credit.
//   2. Rank what's left by qualifiers, in order; the first difference decides:
//        manual       the route's priority set by the operator: 1 beats 0, always
//        cost         expected cost of a typical call of this model (its usual token counts, from the ledger)
//        speed        average response time of this provider for this model, from the ledger
//        reliability  share of successful calls (counted as 100% for now; the ledger records failures)
//   3. Call them in that order: the first that answers serves the call; a failure moves to the next.
//      A provider that says it's over its limit (HTTP 429, e.g. a free tier spent) rests for a minute,
//      doubling while it keeps saying so, up to 30 minutes, so calls don't keep trying it first.
//
// The price the workspace pays doesn't depend on any of this: it is the model's list price × markup.
export type Source = { id: string; name: string; balance_mode: "api" | "manual" | "postpaid"; balance_micro: number | null; balance_checked_at: string | null; balance_url: string | null; balance_key_env: string | null; balance_field: string | null; updated_at: string };
export type Candidate = Route & {
  key: string;
  expectedMicro: number;
  needMicro: number;
  latencyMs: number | null;
  reliability: number;
  balanceMicro: number | null;
  excluded?: string;
};
const BALANCE_EVERY = 5 * 60_000;
const SAMPLE = 50;

export function sources(store: Store): Source[] {
  ensureCatalog(store);
  return store.db.prepare("SELECT * FROM catalog_sources ORDER BY id").all() as Source[];
}
const sourceRow = (store: Store, id: string) => store.db.prepare("SELECT * FROM catalog_sources WHERE id=?").get(id) as Source | undefined;

// ── Balances ─────────────────────────────────────────────────────────────────
// A call's cost comes off the balance as it's recorded; providers with a balance API are re-read
// every few minutes, which corrects any drift.
export function spend(store: Store, source: string, micro: number) {
  store.db.prepare("UPDATE catalog_sources SET balance_micro=balance_micro-? WHERE id=? AND balance_mode<>'postpaid' AND balance_micro IS NOT NULL").run(micro, source);
}
// Record what OrbytLink holds at a provider (after a top-up), or change how its balance is known.
export function setSource(store: Store, id: string, change: { mode?: Source["balance_mode"]; balanceUsd?: number; name?: string; url?: string | null; keyEnv?: string | null; field?: string | null }) {
  ensureCatalog(store);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new Error("Provider: a short lowercase name");
  const old = sourceRow(store, id);
  const mode = change.mode ?? old?.balance_mode ?? "manual";
  if (!["api", "manual", "postpaid"].includes(mode)) throw new Error("Mode: api, manual or postpaid");
  if (change.balanceUsd !== undefined && (!Number.isFinite(change.balanceUsd) || Math.abs(change.balanceUsd) > 1_000_000)) throw new Error("Balance: a USD amount");
  const url = change.url !== undefined ? change.url : (old?.balance_url ?? null);
  if (mode === "api" && (!url || !url.startsWith("https://"))) throw new Error("An api balance needs an https url");
  store.db
    .prepare(
      `INSERT INTO catalog_sources(id,name,balance_mode,balance_micro,balance_checked_at,balance_url,balance_key_env,balance_field,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,balance_mode=excluded.balance_mode,balance_micro=excluded.balance_micro,balance_checked_at=excluded.balance_checked_at,balance_url=excluded.balance_url,balance_key_env=excluded.balance_key_env,balance_field=excluded.balance_field,updated_at=excluded.updated_at`,
    )
    .run(
      id,
      change.name ?? old?.name ?? id,
      mode,
      change.balanceUsd !== undefined ? Math.round(change.balanceUsd * 1_000_000) : (old?.balance_micro ?? null),
      change.balanceUsd !== undefined ? new Date().toISOString() : (old?.balance_checked_at ?? null),
      url,
      change.keyEnv !== undefined ? change.keyEnv : (old?.balance_key_env ?? null),
      change.field !== undefined ? change.field : (old?.balance_field ?? null),
      new Date().toISOString(),
    );
  return sourceRow(store, id)!;
}
const inFlight = new WeakMap<Store, Promise<void>>();
// Re-read the balance of every api-mode provider that is due. Calls never wait for this: routing
// uses the last known balance and starts a refresh in the background when one is stale.
export function refreshBalances(store: Store, force = false): Promise<void> {
  const running = inFlight.get(store);
  if (running) return running;
  const due = sources(store).filter((s) => s.balance_mode === "api" && s.balance_url && s.balance_key_env && process.env[s.balance_key_env] && (force || !s.balance_checked_at || Date.parse(s.balance_checked_at) < Date.now() - BALANCE_EVERY));
  if (!due.length) return Promise.resolve();
  const p = Promise.all(
    due.map(async (s) => {
      try {
        const r = await fetch(s.balance_url!, { headers: { Authorization: `Bearer ${process.env[s.balance_key_env!]}` }, signal: AbortSignal.timeout(5000) });
        const body: any = r.ok ? await r.json() : null;
        const usd = Number(body?.[s.balance_field || "balance"]);
        if (Number.isFinite(usd)) store.db.prepare("UPDATE catalog_sources SET balance_micro=?, balance_checked_at=? WHERE id=?").run(Math.round(usd * 1_000_000), new Date().toISOString(), s.id);
      } catch {
        // Unreachable: keep the last known balance.
      }
    }),
  ).then(() => undefined);
  inFlight.set(store, p.finally(() => inFlight.delete(store)));
  return p;
}

// ── What the ledger says about a model and its providers ─────────────────────
const statsCache = new WeakMap<Store, Map<string, { at: number; v: any }>>();
function cached<T>(store: Store, key: string, ttl: number, load: () => T): T {
  const m = statsCache.get(store) || new Map();
  statsCache.set(store, m);
  const hit = m.get(key);
  if (hit && hit.at > Date.now() - ttl) return hit.v;
  const v = load();
  m.set(key, { at: Date.now(), v });
  return v;
}
// A typical call of this model: average tokens in and out of its last successful calls.
export function typicalCall(store: Store, itemId: string) {
  return cached(store, `typical:${itemId}`, 60_000, () => {
    const r = store.db.prepare(`SELECT AVG(units_in) AS i, AVG(units_out) AS o, COUNT(*) AS n FROM (SELECT units_in, units_out FROM usage_calls WHERE item_id=? AND status='ok' AND units_in>0 ORDER BY id DESC LIMIT ${SAMPLE})`).get(itemId) as { i: number | null; o: number | null; n: number };
    return r.n >= 5 ? { inTokens: r.i ?? 1000, outTokens: r.o ?? 250 } : { inTokens: 1000, outTokens: 250 };
  });
}
// Average response time of one provider for one model, from its last successful calls.
export function speedOf(store: Store, itemId: string, source: string): number | null {
  return cached(store, `speed:${itemId}:${source}`, 60_000, () => {
    const r = store.db.prepare(`SELECT AVG(latency_ms) AS ms, COUNT(*) AS n FROM (SELECT latency_ms FROM usage_calls WHERE item_id=? AND source=? AND status='ok' AND latency_ms IS NOT NULL ORDER BY id DESC LIMIT ${SAMPLE})`).get(itemId, source) as { ms: number | null; n: number };
    return r.n >= 3 && r.ms !== null ? Math.round(r.ms) : null;
  });
}
// Reliability is counted as 100% for every provider for now. The ledger already records failed
// attempts (status 'failed'), so this is where a measured success rate will plug in.
export const reliabilityOf = (_store: Store, _itemId: string, _source: string) => 1;
export const clearRoutingStats = (store: Store) => statsCache.delete(store);

// ── Rate limits ──────────────────────────────────────────────────────────────
const resting = new Map<string, { until: number; strikes: number }>();
const restKey = (itemId: string, source: string) => `${itemId}|${source}`;
export function noteRateLimited(itemId: string, source: string) {
  const r = resting.get(restKey(itemId, source));
  const strikes = Math.min((r?.strikes ?? 0) + 1, 6);
  resting.set(restKey(itemId, source), { until: Date.now() + Math.min(60_000 * 2 ** (strikes - 1), 30 * 60_000), strikes });
}
export const noteAnswered = (itemId: string, source: string) => void resting.delete(restKey(itemId, source));
export const restingUntil = (itemId: string, source: string) => {
  const r = resting.get(restKey(itemId, source));
  return r && r.until > Date.now() ? r.until : null;
};
export const clearRests = () => resting.clear();

// ── The plan for one call ────────────────────────────────────────────────────
// `call` is this call's worst case (its estimated input and its full max output), used for the
// credit check; ranking uses a typical call. Returns the ranked providers and the excluded ones.
export function plan(store: Store, itemId: string, opts: { protocol?: Protocol; call?: { inTokens: number; outTokens: number } } = {}) {
  void refreshBalances(store);
  const price = priceOf(store, itemId);
  const typical = typicalCall(store, itemId);
  const call = opts.call ?? typical;
  const micro = (r: Route, t: { inTokens: number; outTokens: number }) => Math.ceil(t.inTokens * (r.cost_in ?? 0) + t.outTokens * (r.cost_out ?? 0));
  const fits = (c: number | null, p: number | null) => c === null || p === null || c <= p + 1e-12;
  const ranked: Candidate[] = [],
    excluded: Candidate[] = [];
  for (const r of routesOf(store, itemId)) {
    const src = sourceRow(store, r.source);
    const c: Candidate = {
      ...r,
      key: keyFor(r),
      expectedMicro: micro(r, typical),
      needMicro: micro(r, call),
      latencyMs: speedOf(store, itemId, r.source),
      reliability: reliabilityOf(store, itemId, r.source),
      balanceMicro: src && src.balance_mode !== "postpaid" ? src.balance_micro : null,
    };
    const credit = !src || src.balance_mode === "postpaid" || src.balance_micro === null || src.balance_micro >= c.needMicro;
    c.excluded = !r.enabled
      ? "switched off"
      : opts.protocol && r.protocol !== opts.protocol
        ? `speaks ${r.protocol}`
        : r.protocol !== "internal" && !r.endpoint
          ? "no endpoint"
          : r.protocol !== "internal" && !c.key
            ? `key variable ${r.key_env} not set`
            : !fits(r.cost_in, price.input) || !fits(r.cost_out, price.output)
              ? "costs more than the price"
              : !credit
                ? `no credit left (balance $${((src!.balance_micro ?? 0) / 1e6).toFixed(4)})`
                : restingUntil(itemId, r.source)
                  ? `over its limit, resting until ${new Date(restingUntil(itemId, r.source)!).toISOString().slice(11, 19)} UTC`
                  : undefined;
    (c.excluded ? excluded : ranked).push(c);
  }
  // The qualifiers, in order: manual, then cost, then speed, then reliability.
  ranked.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.expectedMicro - b.expectedMicro ||
      (a.latencyMs !== null && b.latencyMs !== null ? a.latencyMs - b.latencyMs : 0) ||
      b.reliability - a.reliability ||
      a.source.localeCompare(b.source),
  );
  return { ranked, excluded, typical, price };
}
