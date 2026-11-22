import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { addBalance, addMonth, aiSummary, usd } from "./ai.js";
import { liveRoutes, priceOf } from "./catalog.js";
import { recordCall } from "./ledger.js";

// Per-call prices for calls through a workspace's own connections: an MCP tool call
// (orbytlink/mcp-call) or a stored API request (orbytlink/api-call). They are catalog items like any
// other, priced in the admin portal; at $0 (the default) nothing is checked, charged or recorded.
// Agent and workflow calls are charged; a console test of an API isn't.
const microOf = (store: Store, item: string) => Math.max(0, Math.round((priceOf(store, item).input ?? 0) * 1_000_000));
const fail = (message: string) => Object.assign(new Error(message), { status: 402, safe: true });

// Before the call: refuse it if the workspace can't pay. Returns the price, to charge after.
export function checkService(store: Store, w: string, item: string): number {
  const price = microOf(store, item);
  if (!price) return 0;
  const s = aiSummary(store, w);
  if (!s.enabled) throw fail("An admin has turned paid use off for this workspace.");
  if (s.balance < price) throw fail(`Not enough credit: this call costs $${usd(price).toFixed(4)} and the balance is $${usd(s.balance).toFixed(4)}.`);
  if (s.monthlyLimit !== null && s.monthSpent + price > s.monthlyLimit) throw fail(`This call would pass the workspace's monthly limit of $${usd(s.monthlyLimit).toFixed(2)}.`);
  return price;
}
// After a call that went through: charge it and write it to the ledger.
export function chargeService(store: Store, identity: Identity, item: string, price: number, via: string, ref: string) {
  if (!price) return;
  addBalance(store, identity.workspace, -price);
  addMonth(store, identity.workspace, price);
  const unit = liveRoutes(store, item)[0]?.cost_in;
  recordCall(store, { workspace: identity.workspace, user: identity.user, via, item, kind: "service", source: "orbytlink", ref: ref.slice(0, 120), status: "ok", unitsIn: 1, costMicro: unit == null ? null : Math.round(unit * 1_000_000), costBasis: "computed", chargedMicro: price });
}
