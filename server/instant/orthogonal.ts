import { groupFor } from "./groups.js";
import { docsLink, nativeKey, num, readJson, scrub, send, type CallInput, type CallOutcome, type Route, type Upstream } from "./upstream.js";

// Source C: a unified API whose public catalog lists each provider's native endpoints (method, path,
// parameters) with a USD price per call; a run sends the provider's path, query and body, and the
// response carries what it cost (priceCents). Its terms forbid resale without authorization, so it
// stays off until the operator has that in writing (INSTANT_C_TOKEN).
const api = () => (process.env.INSTANT_C_URL || "https://api.orthogonal.com").replace(/\/+$/, "");
const site = () => (process.env.INSTANT_C_CATALOG_URL || "https://www.orthogonal.com").replace(/\/+$/, "");
const token = () => process.env.INSTANT_C_TOKEN || "";
const usdOf = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /^\$?(\d+(\.\d+)?)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : null;
};
const params = (list: unknown) =>
  Array.isArray(list) ? Object.fromEntries(list.filter((p: any) => p?.name).map((p: any) => [p.name, { type: p.type, required: !!p.required, ...(p.description ? { note: scrub(String(p.description)).slice(0, 300) } : {}), ...(p.example !== undefined ? { example: p.example } : {}) }])) : {};

export const sourceC: Upstream = {
  id: "c",
  configured: () => !!token(),
  async catalog() {
    const routes: Route[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const r = await send(`${site()}/discover?limit=500&offset=${offset}`, { headers: { Accept: "application/json" }, timeoutMs: 30_000 });
      if (!r?.ok) throw new Error(`catalog: ${r ? `HTTP ${r.status}` : "unreachable"}`);
      const d: any = await r.json();
      for (const a of d.apis || []) {
        const slug = String(a.slug || "");
        for (const e of a.endpoints || []) {
          if (!slug || !e?.path || e.isPayable === false) continue;
          const method = String(e.method || "GET").toUpperCase();
          const name = scrub(String(e.name || `${method} ${e.path}`));
          const summary = scrub(String(e.description || ""));
          const cost = e.price === "dynamic" ? null : usdOf(e.price);
          routes.push({
            upstream: "c",
            ref: `${slug}|${method}|${e.path}`,
            key: nativeKey(slug, method, String(e.path)),
            provider: scrub(String(a.name || slug)),
            name,
            summary,
            job: summary || name,
            group: groupFor(`${a.name} ${a.description || ""} ${name} ${summary}`),
            method,
            path: String(e.path),
            best: false,
            costUsd: cost,
            costType: "per_call",
            unit: "call",
            per: 1,
            input: { queryParams: params(e.queryParams), body: params(e.bodyParams) },
            example: null,
            reliability: null,
            docs: docsLink(e.docsUrl),
          });
        }
      }
      if (!d.pagination?.hasMore) break;
    }
    return routes;
  },
  async call(r: Route, input: CallInput): Promise<CallOutcome> {
    const [apiSlug, method, path] = r.ref.split("|");
    const payload = { api: apiSlug, path, method, ...(input.query ? { query: input.query } : {}), ...(input.body !== undefined ? { body: input.body } : {}) };
    const init = { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey }, body: JSON.stringify(payload) };
    const res = (await send(`${api()}/v1/run`, init)) ?? (await send(`${api()}/v1/run`, init));
    if (!res) return { status: 0, text: "", costMicro: 0, unavailable: true };
    const text = (await res.text()).slice(0, 400_000);
    const j: any = readJson(text);
    const costMicro = Math.max(0, Math.round((num(j?.priceCents) ?? 0) * 10_000));
    const code = String(j?.code || "");
    if (j?.success === true) return { status: 200, text: JSON.stringify(j.data ?? null), json: j.data ?? null, costMicro };
    if (/INSUFFICIENT_CREDITS|UNAUTHORIZED/.test(code) || res.status === 401 || res.status === 402) return { status: res.status, text, costMicro, unavailable: true, accountProblem: `${res.status} ${code}` };
    if (/RATE_LIMITED|UPSTREAM_ERROR|IN_PROGRESS/.test(code) || res.status === 429 || res.status >= 500) return { status: res.status, text, costMicro, unavailable: true };
    return { status: res.status || 400, text, costMicro, refusal: scrub(String(j?.error || `The tool refused the request (HTTP ${res.status}).`)).slice(0, 500) };
  },
  async balance() {
    const r = await send(`${api()}/v1/credits/balance`, { headers: { Authorization: `Bearer ${token()}`, Accept: "application/json" }, timeoutMs: 15_000 });
    if (!r?.ok) return undefined;
    const d: any = await r.json().catch(() => null);
    const v = usdOf(String(d?.balance ?? "").replace(/,/g, ""));
    return v === null ? undefined : Math.round(v * 1_000_000);
  },
};
void readJson;
