import { groupFor } from "./groups.js";
import { clean, nativeKey, num, readJson, scrub, send, type CallInput, type CallOutcome, type Route, type Upstream } from "./upstream.js";

// Source D: a tool wallet for agents. Every operation is POST /v1/<op> with a JSON body; a key may
// cover several cards (spending accounts), and a call names one. Its catalog needs the key, so it is
// read only once the source is configured. Calls take the provider's own parameters and come back as
// a receipt with what was billed. Its terms want approval for commercial use (INSTANT_D_TOKEN).
const base = () => (process.env.INSTANT_D_URL || "https://go.o11.ai").replace(/\/+$/, "");
const token = () => process.env.INSTANT_D_TOKEN || "";
let card: string | undefined = process.env.INSTANT_D_CARD || undefined;
async function op(name: string, body: Record<string, unknown>, timeoutMs = 30_000, extra: Record<string, string> = {}) {
  return send(`${base()}/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json", ...extra }, body: JSON.stringify(body), timeoutMs });
}
async function cardId() {
  if (card) return card;
  const r = await op("cards", {});
  const d: any = r?.ok ? await r.json().catch(() => null) : null;
  const first = (d?.cards || d?.items || [])[0];
  card = first?.id ? String(first.id) : undefined;
  return card;
}
const micros = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : num(v);
  return n === null || !Number.isFinite(n) ? null : n;
};

export const sourceD: Upstream = {
  id: "d",
  configured: () => !!token(),
  async catalog() {
    if (!token()) throw new Error("not configured");
    const id = await cardId();
    const routes: Route[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 250; page++) {
      const r = await op("find_tools", { format: "detailed", limit: 50, ...(cursor ? { cursor } : {}), ...(id ? { cardId: id } : {}) });
      if (!r?.ok) throw new Error(`catalog: ${r ? `HTTP ${r.status}` : "unreachable"}`);
      const d: any = await r.json();
      const items: any[] = d.tools || d.items || d.results || [];
      for (const t of items) {
        if (!t?.id || t.effect === "write" || t.requiresCustomerCredentials) continue;
        const p = t.price || {};
        const cost = p.basis === "free" ? 0 : micros(p.micros) ?? micros(p.priceMaxMicros);
        const ep = t.endpoint || {};
        const method = String(ep.method || "").toUpperCase();
        const name = scrub(String(t.name || t.id));
        const summary = scrub(String(t.description || ""));
        routes.push({
          upstream: "d",
          ref: String(t.id),
          key: method && ep.path ? nativeKey(String(t.provider || ""), method, String(ep.path)) : `d:${t.id}`,
          provider: scrub(String(t.providerName || t.provider || "")),
          name,
          summary,
          job: summary || name,
          group: groupFor(`${t.provider} ${name} ${summary}`),
          method: method || "POST",
          path: ep.path ? String(ep.path) : undefined,
          best: false,
          costUsd: cost === null ? null : cost / 1_000_000,
          costType: p.basis === "variable" ? "per_result" : "per_call",
          unit: String(p.unit || "call"),
          per: 1,
          input: clean(t.input ?? null, true),
          example: null,
          reliability: num(t.health?.successRate) !== null ? { okRate: t.health.successRate, samples: num(t.health?.samples) ?? 0, p50Ms: num(t.health?.p50Ms) } : null,
          docs: "",
        });
      }
      cursor = d.nextCursor || d.cursor || undefined;
      if (!cursor || !items.length) break;
    }
    return routes;
  },
  async call(r: Route, input: CallInput): Promise<CallOutcome> {
    const id = await cardId();
    const body = {
      tool: r.ref,
      ...(input.query ? { query: input.query } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      idempotencyKey: input.idempotencyKey,
      maxCostMicros: String(Math.floor(input.maxCostUsd * 1_000_000)),
      ...(id ? { cardId: id } : {}),
    };
    const res = (await op("call", body, 110_000, { Prefer: "wait=100" })) ?? (await op("call", body, 110_000, { Prefer: "wait=100" }));
    if (!res) return { status: 0, text: "", costMicro: 0, unavailable: true };
    const text = (await res.text()).slice(0, 400_000);
    const j: any = readJson(text);
    const receipt = j?.receipt ?? j;
    const costMicro = Math.max(0, micros(receipt?.billedMicros) ?? 0);
    const codes: string[] = receipt?.failure?.codes || [];
    if (res.status === 401 || res.status === 402 || codes.some((c) => /UNFUNDED|BALANCE|ALLOWANCE|UNAUTHORIZED/.test(c))) return { status: res.status, text, costMicro, unavailable: true, accountProblem: `${res.status} ${codes.join(",")}` };
    if (res.status === 429 || res.status >= 500 || codes.includes("RATE_LIMITED") || receipt?.failure?.retryable) return { status: res.status, text, costMicro, unavailable: true };
    const state = String(receipt?.state || "");
    if (state === "succeeded") return { status: 200, text: JSON.stringify(receipt.result ?? null), json: receipt.result ?? null, costMicro };
    if (["queued", "executing", "waiting"].includes(state)) return { status: 202, text, json: { runId: receipt.id, status: state }, costMicro, pending: true };
    return { status: res.ok ? 400 : res.status, text, costMicro, refusal: scrub(String(receipt?.error?.message || receipt?.error || j?.message || "The tool refused the request.")).slice(0, 500) };
  },
  async balance() {
    const id = await cardId();
    const r = await op("balance", id ? { cardId: id } : {}, 15_000);
    if (!r?.ok) return undefined;
    const d: any = await r.json().catch(() => null);
    const v = micros(d?.card?.availableMicros) ?? micros(d?.availableMicros);
    return v === null ? undefined : v;
  },
};
