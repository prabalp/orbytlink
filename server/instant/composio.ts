import { groupFor } from "./groups.js";
import { clean, readJson, scrub, send, slugify, type CallInput, type CallOutcome, type Route, type Upstream } from "./upstream.js";

// Source E: an action platform whose "instant" tools run on its own provider accounts and are paid
// from a prepaid balance. Its tools have their own slugs and argument schemas (not the provider's
// native API), it reports no cost per direct call and has no balance API, so the wallet table is
// kept by the operator and each call is counted at the tool's listed price.
// Its terms forbid resale: it is a stopgap the operator turns off for the full rollout (unset INSTANT_E_TOKEN).
const base = () => (process.env.INSTANT_E_URL || "https://backend.composio.dev/api/v3.1").replace(/\/+$/, "");
const token = () => process.env.INSTANT_E_TOKEN || "";
// The listed price is free text such as "$0.007 per search" or "$0.001 per 10 API calls": the first
// dollar amount, divided by the count it covers when one is given (so the price is per call).
export const priceFromText = (s: unknown) => {
  // "$0.001 per credit used; typically 5 credits ($0.005) per request": the typical request wins.
  const typical = /\(\s*\$\s*(\d+(?:\.\d+)?)\s*\)\s*per\s+(?:successful\s+)?(?:api\s+)?(?:request|call)/i.exec(String(s ?? ""));
  if (typical) return Number(typical[1]);
  const m = /\$\s*(\d+(?:\.\d+)?)(?:\s*(?:per|\/)\s*(\d[\d,]*)(k)?\b)?/i.exec(String(s ?? ""));
  if (!m) return null;
  const per = m[2] ? Number(m[2].replace(/,/g, "")) * (m[3] ? 1000 : 1) : 1;
  return per > 0 ? Number(m[1]) / per : null;
};

export const sourceE: Upstream = {
  id: "e",
  configured: () => !!token(),
  async catalog() {
    if (!token()) throw new Error("not configured");
    const routes: Route[] = [];
    let cursor = "";
    // Its whole tool list (over 90,000 tools, 1,000 a page) is read to find the instant ones; a page
    // that fails is retried, since it fails now and then.
    for (let page = 0; page < 200; page++) {
      const url = `${base()}/tools?toolkit_versions=latest&include_pricing=true&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      let r: Response | undefined;
      for (let attempt = 0; attempt < 4 && !r?.ok; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, 3000 * attempt));
        r = await send(url, { headers: { "x-api-key": token(), Accept: "application/json" }, timeoutMs: 90_000 });
      }
      if (!r?.ok) throw new Error(`catalog: ${r ? `HTTP ${r.status}` : "unreachable"}`);
      const d: any = await r.json();
      for (const t of d.items || []) {
        if (!t?.instant?.supported || !t.slug) continue;
        const toolkit = String(t.toolkit?.name || t.toolkit?.slug || "");
        const name = scrub(String(t.name || t.slug));
        const summary = scrub(String(t.description || "")).slice(0, 400);
        const cost = priceFromText(t.instant?.price?.description);
        routes.push({
          upstream: "e",
          ref: String(t.slug),
          key: `e:${t.slug}`,
          id: `${slugify(String(t.toolkit?.slug || toolkit)) || "tool"}.${slugify(String(t.slug).replace(new RegExp(`^${String(t.toolkit?.slug || "").toUpperCase()}_`), ""))}`,
          provider: scrub(toolkit),
          name,
          summary,
          job: summary || name,
          group: groupFor(`${toolkit} ${name} ${summary}`),
          method: "POST",
          best: false,
          costUsd: cost,
          costType: "per_call",
          unit: "call",
          per: 1,
          input: { body: clean(t.input_parameters ?? null, true) },
          example: null,
          reliability: null,
          docs: "",
        });
      }
      cursor = String(d.next_cursor || "");
      if (!cursor) break;
    }
    return routes;
  },
  async call(r: Route, input: CallInput): Promise<CallOutcome> {
    const args = input.body && typeof input.body === "object" ? input.body : (input.query ?? {});
    const init = {
      method: "POST",
      headers: { "x-api-key": token(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ connected_account_id: "instant_account", user_id: `c-${input.tag}`, arguments: args, version: "latest" }),
    };
    // No idempotency here: a dropped connection is not retried, so a call can't run twice.
    const res = await send(`${base()}/tools/execute/${encodeURIComponent(r.ref)}`, init);
    if (!res) return { status: 0, text: "", costMicro: 0, unavailable: true };
    const text = (await res.text()).slice(0, 400_000);
    const j: any = readJson(text);
    const err = String(j?.error?.message || j?.error || j?.message || "");
    // It doesn't report the cost of a direct call: the listed price is counted against its wallet.
    const listed = Math.round((r.costUsd ?? 0) * 1_000_000);
    if (res.status === 402 || /WalletBalanceExhausted|Metering/i.test(text) || res.status === 401 || res.status === 403) return { status: res.status, text, costMicro: 0, unavailable: true, accountProblem: `${res.status} ${err.slice(0, 120)}` };
    if (res.status === 429 || res.status >= 500) return { status: res.status, text, costMicro: 0, unavailable: true };
    if (res.ok && j?.successful !== false) return { status: 200, text: JSON.stringify(j?.data ?? null), json: j?.data ?? null, costMicro: listed };
    return { status: res.ok ? 400 : res.status, text, costMicro: 0, refusal: scrub(err || `The tool refused the request (HTTP ${res.status}).`).slice(0, 500) };
  },
};
