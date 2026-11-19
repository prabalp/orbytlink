import { groupFor } from "./groups.js";
import { clean, docsLink, nativeKey, num, readJson, scrub, send, type CallInput, type CallOutcome, type Route, type Upstream } from "./upstream.js";

// Source B: a tool marketplace with a plain REST API. Its public catalog lists every endpoint with a
// price; a run relays the provider's own body, query and path parameters, reports what it cost in
// the body, and settles failed runs at zero. Its docs describe white-label use; its legal terms want
// approval for commercial use, so it stays off until the operator has that (INSTANT_B_TOKEN).
const base = () => (process.env.INSTANT_B_URL || "https://api.monid.ai").replace(/\/+$/, "");
const token = () => process.env.INSTANT_B_TOKEN || "";
// It answers 50 per page whatever is asked; 200 pages is room for 10,000.
const PAGES = 200;

function priceOf(p: any): Pick<Route, "costUsd" | "costType" | "unit" | "per"> {
  const value = num(p?.amount?.value);
  switch (p?.type) {
    case "PER_CALL":
      return { costUsd: value, costType: "per_call", unit: "call", per: 1 };
    case "PER_RESULT":
      return { costUsd: value === null ? null : value + (num(p?.flatFee?.value) ?? 0), costType: "per_result", unit: "result", per: 1 };
    case "PER_UNIT":
      return { costUsd: value, costType: "per_result", unit: String(p?.unit || "unit").toLowerCase(), per: num(p?.per) || 1 };
    default:
      return { costUsd: null, costType: "per_call", unit: "call", per: 1 };
  }
}

export const sourceB: Upstream = {
  id: "b",
  configured: () => !!token(),
  async catalog() {
    const routes: Route[] = [];
    let cursor = "";
    for (let page = 0; page < PAGES; page++) {
      const r = await send(`${base()}/public/v1/endpoints?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { Accept: "application/json" }, timeoutMs: 30_000 });
      if (!r?.ok) throw new Error(`catalog: ${r ? `HTTP ${r.status}` : "unreachable"}`);
      const d: any = await r.json();
      for (const e of d.items || []) {
        const provider = String(e.provider || "");
        const endpoint = String(e.endpoint || "");
        if (!provider || !endpoint) continue;
        const name = scrub(String(e.displayName || endpoint));
        const summary = scrub(String(e.displayDescription || ""));
        routes.push({
          upstream: "b",
          ref: `${provider}|${endpoint}`,
          // The method isn't listed; a route on the same provider and path as another source's merges with it.
          key: nativeKey(provider, "ANY", endpoint),
          provider: scrub(String(e.providerDisplayName || provider)),
          name,
          summary,
          job: summary || name,
          group: groupFor(`${(e.categories || []).join(" ")} ${name} ${summary}`),
          method: "ANY",
          path: endpoint,
          best: false,
          ...priceOf(e.price),
          input: null,
          example: null,
          reliability: null,
          docs: "",
        });
      }
      cursor = String(d.cursor || "");
      if (!cursor || !(d.items || []).length) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    return routes;
  },
  async call(r: Route, input: CallInput): Promise<CallOutcome> {
    const [provider, endpoint] = r.ref.split("|");
    const body = { provider, endpoint, input: { body: input.body ?? {}, queryParams: input.query ?? {}, pathParams: {} }, maxCost: input.maxCostUsd, tag: input.tag };
    const init = { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey }, body: JSON.stringify(body) };
    const res = (await send(`${base()}/v1/run`, init)) ?? (await send(`${base()}/v1/run`, init));
    if (!res) return { status: 0, text: "", costMicro: 0, unavailable: true };
    const text = (await res.text()).slice(0, 400_000);
    const j: any = readJson(text);
    const rc = j?.billing?.reportedCost;
    const factor = rc?.unit === "DOLLAR" ? 1_000_000 : rc?.unit === "CENT" ? 10_000 : 1;
    const costMicro = Math.max(0, Math.round((num(rc?.value) ?? 0) * factor));
    const code = String(j?.errorCode || j?.code || "");
    const provStatus = num(j?.providerResponse?.httpStatus);
    if (res.status === 402 || /INSUFFICIENT|BALANCE|WALLET|UNAUTHORIZED|FORBIDDEN/i.test(code) || res.status === 401 || res.status === 503) return { status: res.status, text, costMicro, unavailable: true, accountProblem: `${res.status} ${code}` };
    if (res.status === 429 || res.status === 408 || (res.status >= 500 && res.status !== 502)) return { status: res.status, text, costMicro, unavailable: true };
    if (code === "MAX_COST_EXCEEDED") return { status: 400, text, costMicro: 0, refusal: "This call could cost more than its limit. Ask for fewer results." };
    if (res.status === 202) return { status: 202, text, json: clean({ runId: j?.runId, status: j?.status }), costMicro, pending: true };
    // The provider's own answer, passed through.
    if (provStatus && (provStatus === 429 || provStatus >= 500)) return { status: provStatus, text, costMicro, unavailable: true };
    if (!res.ok) return { status: res.status, text: scrub(String(j?.message || text)), costMicro, refusal: res.status < 500 ? scrub(String(j?.message || `The tool refused the request (HTTP ${res.status}).`)).slice(0, 500) : undefined };
    const output = j?.output ?? j;
    return { status: provStatus || 200, text: typeof output === "string" ? output : JSON.stringify(output), json: output, costMicro };
  },
  async balance() {
    const r = await send(`${base()}/v1/wallet/balance`, { headers: { Authorization: `Bearer ${token()}`, Accept: "application/json" }, timeoutMs: 15_000 });
    if (!r?.ok) return undefined;
    const d: any = await r.json().catch(() => null);
    const v = num(d?.balance?.value);
    return v === null ? undefined : Math.round(v * 1_000_000);
  },
};
// docsLink is kept for parity with other sources (this one's list carries no docs link).
void docsLink;
