import type { Row } from "../store.js";
import { clean, docsLink, nativeKey, num, readJson, scrub, send, type CallInput, type CallOutcome, type Route, type Upstream } from "./upstream.js";

// Source A: a tool exchange whose hosted API relays each provider's native API (method, path and
// body unchanged), injects its own credential, and reports the cost in a header. Its public catalog
// lists every tool with its price; its "routed" tools ask the providers of a job cheapest first.
// Its terms allow building it into a product that bills its own users.
const base = () => (process.env.INSTANT_A_URL || process.env.INSTANT_URL || "https://treg.to").replace(/\/+$/, "");
const token = () => process.env.INSTANT_A_TOKEN || process.env.INSTANT_TOKEN || "";
const ours = (id: string) => id.replace(/^treg\./, "best.");
const theirs = (id: string) => id.replace(/^best\./, "treg.");
// The errors about OrbytLink's own account there: never shown, and another source should take the call.
const ACCOUNT = /insufficient_balance|funds_required|platform_daily_cap_reached|own_key_required|member_spend_cap_reached|trial_allowance_reached|not_authenticated|tag_blocked|tag_spend_cap_reached/;
const BUSY = /share_busy|upstream_busy|provider_rate_limited|provider_capacity_unavailable|route_failed/;

function route(raw: Row, group: Route["group"], capability: string, job: string): Route | undefined {
  // Only what can be sold: served on the source's own account, not async generation jobs, not
  // deprecated or blocked, and with a published price.
  if (raw.platform_eligible === false || raw.platform_blocked || raw.superseded_by || raw.async || raw.status === "deprecated") return;
  const cost = raw.cost || {};
  if (cost.type !== "free" && num(cost.usd) === null) return;
  const best = raw.kind === "routed";
  const provider = best ? "Best available" : String(raw.provider_display || raw.provider || "");
  const method = String(raw.method || "GET").toUpperCase();
  const path = String(raw.path || "");
  const o = raw.observed || null;
  return {
    upstream: "a",
    ref: String(raw.id),
    id: ours(String(raw.id)),
    key: best ? `best:${ours(String(raw.id))}` : path ? nativeKey(String(raw.provider || provider), method, path) : `a:${raw.id}`,
    provider,
    name: scrub(String(raw.name || raw.id)).replace(/ — routed: best of (\d+) providers, own keys first/, " (best of $1 providers)"),
    summary: scrub(String(raw.summary || "")),
    job: scrub(job),
    group,
    method,
    path,
    best,
    costUsd: cost.type === "free" ? 0 : cost.varies ? num(cost.usd) || null : num(cost.usd),
    costType: String(cost.type || "per_call"),
    unit: String(cost.unit || "call"),
    per: num(cost.per) || 1,
    input: clean(raw.input ?? null, true),
    example: clean(raw.test_request ?? null, true),
    reliability: o && num(o.ok_rate) !== null ? { okRate: o.ok_rate, samples: o.samples || 0, p50Ms: num(o.p50_ms) } : null,
    docs: best ? "" : docsLink(raw.docs_url),
  };
}
async function getJson(path: string) {
  const r = await send(`${base()}${path}`, { headers: { Accept: "application/json" }, timeoutMs: 30_000 });
  if (!r?.ok) throw new Error(`catalog ${path}: ${r ? `HTTP ${r.status}` : "unreachable"}`);
  return r.json() as Promise<any>;
}

export const sourceA: Upstream = {
  id: "a",
  configured: () => !!token(),
  async catalog() {
    const index = await getJson("/catalog/platforms");
    const routes: Route[] = [];
    for (const p of index.platforms || []) {
      const slug = String(p.slug || "");
      if (!/^[a-z0-9-]{1,60}$/.test(slug)) continue;
      const detail = await getJson(`/catalog/platforms/${slug}`).catch((error) => {
        console.warn(`[instant] source a skipped ${slug}: ${(error as Error).message}`);
        return undefined;
      });
      if (!detail) continue;
      const group = { slug, label: scrub(String(p.label || slug)), category: scrub(String(p.category || "Other")), summary: scrub(String(p.summary || "")) };
      for (const c of detail.capabilities || []) for (const e of c.endpoints || []) {
        const r = route(e, group, ours(String(c.id || "")), String(c.description || c.id || ""));
        if (r) routes.push(r);
      }
      for (const e of detail.extended || []) {
        const r = route(e, group, "", String(e.summary || ""));
        if (r) routes.push(r);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return routes;
  },
  async call(r: Route, input: CallInput): Promise<CallOutcome> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(input.query || {})) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
    const headers: Record<string, string> = {
      "X-Treg-Token": token(),
      "X-Treg-Meta": `customer=${input.tag}`,
      "X-Treg-Route-Max-Cost": input.maxCostUsd.toFixed(6),
      "Idempotency-Key": input.idempotencyKey,
      Accept: "application/json",
    };
    const o = input.options;
    if (o.waterfall === false) headers["X-Treg-Route-Waterfall"] = "0";
    if (o.strictFilters) headers["X-Treg-Route-Strict-Filters"] = "1";
    if (o.verify) headers["X-Treg-Route-Verify"] = "true";
    if (o.complete) headers["X-Treg-Route-Complete"] = "1";
    if (o.domainMatch) headers["X-Treg-Route-Domain-Match"] = "strict";
    const hasBody = r.method !== "GET" && r.method !== "HEAD" && input.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    const url = `${base()}/call/${encodeURIComponent(theirs(r.ref)).replace(/%2F/g, "/")}${qs.size ? `?${qs}` : ""}`;
    const init = { method: r.method, headers, body: hasBody ? (typeof input.body === "string" ? input.body : JSON.stringify(input.body)) : undefined };
    // A dropped connection may still have been answered and paid: the retry carries the same
    // idempotency key, so the stored answer comes back instead of a second charge.
    const res = (await send(url, init)) ?? (await send(url, init));
    if (!res) return { status: 0, text: "", costMicro: 0, unavailable: true };
    const cost = Number(res.headers.get("X-Treg-Cost-Micro") || 0);
    const text = (await res.text()).slice(0, 400_000);
    const json = readJson(text);
    const out: CallOutcome = { status: res.status, text, json, costMicro: Number.isFinite(cost) && cost > 0 ? cost : 0, servedBy: res.headers.get("X-Treg-Served-By") || undefined, pending: res.status === 202 };
    if (res.headers.get("X-Treg-Error")) {
      const code = String((json as any)?.error || "");
      if (ACCOUNT.test(code) || res.status === 401) return { ...out, unavailable: true, accountProblem: `${res.status} ${code}` };
      if (BUSY.test(code) || res.status === 429 || res.status >= 500) return { ...out, unavailable: true };
      if (code === "route_max_cost") return { ...out, refusal: "This call could cost more than its limit. Ask for fewer results, or raise maxCost." };
      return { ...out, refusal: scrub(String((json as any)?.message || (json as any)?.detail || code || `The tool refused the request (HTTP ${res.status}).`)).slice(0, 500) };
    }
    // The provider's own 429 or 5xx: another source may get through.
    if (res.status === 429 || res.status >= 500) return { ...out, unavailable: true };
    return out;
  },
  async balance() {
    const r = await send(`${base()}/billing`, { headers: { "X-Treg-Token": token(), Accept: "application/json" }, timeoutMs: 15_000 });
    if (!r?.ok) return undefined;
    const b: any = await r.json().catch(() => null);
    const micro = num(b?.balance_micro) ?? (num(b?.balance_usd) !== null ? Math.round(b.balance_usd * 1e6) : null);
    return micro ?? undefined;
  },
};
