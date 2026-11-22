import type { Store } from "./store.js";
import { ensureCatalog } from "./catalog.js";
import { spend } from "./routing.js";

// The ledger: one row in usage_calls per paid call, kept for good, written by every billed feature
// (AI models, decision models, the browser, Instant tools). It answers "what was called, through
// which source, what did it cost us and what did we charge" for any call, workspace, item or day.
//
// cost_micro is what the call cost OrbytLink: the source's own figure when it reports one
// (cost_basis 'reported'), else units × the route's cost ('computed'), or NULL when unknown.
// Workspaces only ever see their own rows' item, units and charged amount.
export type Call = {
  workspace: string;
  user?: string | null;
  via: string;
  item: string;
  kind: string;
  source?: string | null;
  ref?: string | null;
  status: "ok" | "failed";
  unitsIn?: number;
  unitsOut?: number;
  costMicro?: number | null;
  costBasis?: "reported" | "computed" | null;
  chargedMicro: number;
  latencyMs?: number | null;
  note?: string | null;
};
export function recordCall(store: Store, c: Call) {
  ensureCatalog(store);
  store.db
    .prepare("INSERT INTO usage_calls(at,workspace,user,via,item_id,kind,source,route_ref,status,units_in,units_out,cost_micro,cost_basis,charged_micro,latency_ms,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), c.workspace, c.user ?? null, c.via, c.item, c.kind, c.source ?? null, c.ref ?? null, c.status, c.unitsIn ?? 0, c.unitsOut ?? 0, c.costMicro ?? null, c.costMicro == null ? null : (c.costBasis ?? "computed"), c.chargedMicro, c.latencyMs ?? null, c.note?.slice(0, 300) ?? null);
  // What the call cost comes off OrbytLink's balance at that provider.
  if (c.source && c.costMicro) spend(store, c.source, c.costMicro);
}
// A source's own cost figure, in USD, turned into micro-USD (AI Gateway reports it per response).
export const reportedCost = (body: any): number | null => {
  const v = body?.provider_metadata?.gateway?.cost ?? body?.providerMetadata?.gateway?.cost ?? body?.usage?.cost;
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
};

// What a workspace sees of its usage: newest first, charged amounts only.
export function workspaceUsage(store: Store, w: string, limit = 100) {
  ensureCatalog(store);
  return (store.db.prepare("SELECT u.at,u.user,u.via,u.item_id,u.kind,u.units_in,u.units_out,u.charged_micro,i.name FROM usage_calls u LEFT JOIN catalog_items i ON i.id=u.item_id WHERE u.workspace=? AND u.status='ok' ORDER BY u.id DESC LIMIT ?").all(w, limit) as any[]).map((r) => ({
    model: r.item_id,
    name: r.name ?? r.item_id,
    kind: r.kind,
    inputTokens: r.units_in,
    outputTokens: r.units_out,
    micro: r.charged_micro,
    user: r.user,
    via: r.via,
    createdAt: r.at,
  }));
}

// The operator's report: calls, cost, charged and margin, grouped by item, source, workspace or day.
export function report(store: Store, opts: { days?: number; by?: "item" | "source" | "workspace" | "day" | "kind" } = {}) {
  ensureCatalog(store);
  const by = opts.by ?? "item";
  const column = { item: "item_id", source: "COALESCE(source,'-')", workspace: "workspace", day: "substr(at,1,10)", kind: "kind" }[by];
  const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000).toISOString();
  const rows = store.db
    .prepare(
      `SELECT ${column} AS key, COUNT(*) AS calls, SUM(status='failed') AS failed, SUM(units_in) AS units_in, SUM(units_out) AS units_out,
              SUM(COALESCE(cost_micro,0)) AS cost_micro, SUM(cost_micro IS NULL AND status='ok') AS cost_unknown, SUM(charged_micro) AS charged_micro
       FROM usage_calls WHERE at >= ? GROUP BY key ORDER BY charged_micro DESC, calls DESC`,
    )
    .all(since) as any[];
  return rows.map((r) => ({ ...r, margin_micro: r.charged_micro - r.cost_micro }));
}
