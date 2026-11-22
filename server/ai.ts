import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { anyLive, catalogUpdatedAt, getItem, markupPercent, priceOf } from "./catalog.js";
import { noteAnswered, noteRateLimited, plan, type Candidate } from "./routing.js";
import { recordCall, reportedCost } from "./ledger.js";
export { BAKED_MARKUP_PERCENT, markupPercent } from "./catalog.js";

// AI models, resold. What is sold, how each model is called and what it costs are rows in the catalog
// tables (server/catalog.ts): a call goes to the item's first live route, with the key named in that
// route, and the workspace pays the catalog price. Every call is written to the ledger (ledger.ts). Money is kept in whole micro-dollars (1 USD = 1,000,000), so
// there is no rounding drift.
//
// A call first holds the most it could cost (a generous estimate of the prompt plus the full
// max_tokens), so concurrent calls cannot spend credit that is not there; once the gateway
// reports the real token counts the hold is settled to the actual price. Failed calls are free.
export const AI_TOOL = "orbytlink__ai_generate";
export const aiConfigured = (store: Store) => anyLive(store, "chat");
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const row = (store: Store, w: string, kind: string, id: string) => store.list(w, kind).find((r) => r.id === id);
export const usd = (micro: number) => micro / 1_000_000;

export function aiSummary(store: Store, w: string) {
  const settings: Record<string, any> = row(store, w, "ai_settings", "settings") || {};
  return {
    configured: aiConfigured(store),
    enabled: settings.enabled !== false,
    balance: row(store, w, "ai_credits", "balance")?.micro || 0,
    monthSpent: row(store, w, "ai_months", month())?.micro || 0,
    monthlyLimit: settings.monthlyLimit ?? null,
    pricesAsOf: catalogUpdatedAt(store),
    markupPercent: markupPercent(),
  };
}
export const addBalance = (store: Store, w: string, micro: number) =>
  store.put(w, "ai_credits", { id: "balance", micro: (row(store, w, "ai_credits", "balance")?.micro || 0) + micro });
export const addMonth = (store: Store, w: string, micro: number) => {
  const id = month();
  store.put(w, "ai_months", { id, micro: Math.max(0, (row(store, w, "ai_months", id)?.micro || 0) + micro) });
};

// Credits come from the operator for now (npm run account -- credits); payments are not built yet.
export function grantCredits(store: Store, w: string, micro: number, by: string, note = "") {
  if (!Number.isInteger(micro) || micro === 0 || Math.abs(micro) > 100_000 * 1_000_000) throw new Error("Give an amount in USD, at most 100,000");
  addBalance(store, w, micro);
  store.put(w, "ai_ledger", { type: micro > 0 ? "credit" : "debit", micro, by, note, createdAt: new Date().toISOString() });
  store.audit(w, by, "ai.credits", `${micro > 0 ? "+" : ""}${usd(micro).toFixed(2)} USD`);
  return aiSummary(store, w);
}
export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  monthlyLimitUsd: z.number().min(0).max(100_000).nullable(),
});
export function saveAiSettings(store: Store, identity: Identity, input: unknown) {
  const s = aiSettingsSchema.parse(input);
  store.put(identity.workspace, "ai_settings", { id: "settings", enabled: s.enabled, monthlyLimit: s.monthlyLimitUsd === null ? null : Math.round(s.monthlyLimitUsd * 1_000_000) });
  store.audit(identity.workspace, identity.user, "ai.settings", s.enabled ? `on, limit ${s.monthlyLimitUsd ?? "none"}` : "off");
  return aiSummary(store, identity.workspace);
}

const message = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(200_000) });
export const generateSchema = z
  .object({
    model: z.string().min(1).max(120),
    prompt: z.string().max(200_000).optional(),
    system: z.string().max(50_000).optional(),
    messages: z.array(message).max(100).optional(),
    maxTokens: z.number().int().min(1).max(16_000).default(1024),
    temperature: z.number().min(0).max(2).optional(),
    json: z.boolean().optional(),
  })
  .refine((x) => x.prompt?.trim() || x.messages?.length, "Give a prompt or messages");
// What a workflow step's text arguments become, and what agents see.
export const aiInputSchema = {
  type: "object",
  properties: {
    model: { type: "string", description: "Model ID from OrbytLink → Catalog → AI models, e.g. google/gemini-2.5-flash-lite" },
    prompt: { type: "string", description: "The user message" },
    system: { type: "string", description: "Optional system instructions" },
    messages: { type: "array", description: "Instead of prompt: [{role, content}] with role system, user or assistant", items: { type: "object" } },
    maxTokens: { type: "integer", description: "Most tokens to generate (default 1024, at most 16000). Credit for all of them is held until the call ends." },
    temperature: { type: "number" },
    json: { type: "boolean", description: "Ask for a JSON object reply" },
  },
  required: ["model"],
};

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status, safe: true });
export type AiResult = { text: string; model: string; inputTokens: number; outputTokens: number; costMicro: number };
type Via = "agent" | "workflow" | "console" | "browser";
type LiveRoute = Candidate;

// Hold the most a call can cost, before any await, so concurrent calls can't spend credit twice.
function hold(store: Store, w: string, micro: number) {
  const s = aiSummary(store, w);
  if (!s.enabled) throw fail("An admin has turned AI models off for this workspace.");
  if (s.balance < micro) throw fail(`Not enough AI credit: this call can cost up to $${usd(micro).toFixed(4)} and the balance is $${usd(s.balance).toFixed(4)}.`, 402);
  if (s.monthlyLimit !== null && s.monthSpent + micro > s.monthlyLimit) throw fail(`This call would pass the workspace's monthly AI limit of $${usd(s.monthlyLimit).toFixed(2)}.`, 402);
  addBalance(store, w, -micro);
  addMonth(store, w, micro);
}
function settle(store: Store, w: string, held: number, charged: number) {
  addBalance(store, w, held - charged);
  addMonth(store, w, charged - held);
}
// The providers for this call, in the order routing.ts ranks them (credit, then manual, cost, speed,
// reliability). With none able to take it, the reasons go to the server log, not to the workspace.
function routesFor(store: Store, itemId: string, name: string, protocol: "openai-chat" | "openai-decisions", call: { inTokens: number; outTokens: number }) {
  const p = plan(store, itemId, { protocol, call });
  if (!p.ranked.length) {
    if (p.excluded.length) console.warn(`[routing] ${itemId}: no provider can take it (${p.excluded.map((c) => `${c.source}: ${c.excluded}`).join("; ")})`);
    throw fail(`${name} isn't available on this server right now. Pick another model.`, 409);
  }
  return p.ranked;
}
// Each provider in turn; one that fails (down, overloaded, out of credit, or without that model) hands
// over to the next. Returns the response, the provider that gave it, how long it took, and the failed
// attempts (which go to the ledger, for reliability).
async function callRoutes(routes: LiveRoute[], body: (ref: string) => unknown, timeout: number) {
  // Over its limit (429): that provider rests for this model; answering clears it.
  const limited = (route: LiveRoute, r: Response) => (r.status === 429 ? noteRateLimited(route.item_id, route.source) : r.ok ? noteAnswered(route.item_id, route.source) : undefined);
  let last: { r: Response; route: LiveRoute; latencyMs: number } | undefined;
  const failed: { route: LiveRoute; latencyMs: number; note: string }[] = [];
  for (const route of routes) {
    const started = Date.now();
    const r = await fetch(route.endpoint!, {
      method: "POST",
      headers: { ...(route.auth_header ? { [route.auth_header]: route.key } : { Authorization: `Bearer ${route.key}` }), "Content-Type": "application/json" },
      body: JSON.stringify(body(route.ref)),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    }).catch((e) => {
      failed.push({ route, latencyMs: Date.now() - started, note: e?.name === "TimeoutError" ? "timed out" : "unreachable" });
      if (route === routes.at(-1)) throw Object.assign(e, { failed });
      return undefined;
    });
    if (!r) continue;
    limited(route, r);
    last = { r, route, latencyMs: Date.now() - started };
    if (r.ok) break;
    if (route !== routes.at(-1)) failed.push({ route, latencyMs: last.latencyMs, note: `HTTP ${r.status}, moved on` });
  }
  if (!last) throw fail("The model could not be reached. No credit was used.", 502);
  return { ...last, failed };
}
// Cost of a call to OrbytLink: the source's own figure, or the tokens at the route's cost per 1M
// (USD per 1M tokens is micro-USD per token).
const costOf = (body: any, route: LiveRoute, inputTokens: number, outputTokens: number) => {
  const reported = reportedCost(body);
  if (reported !== null) return { costMicro: reported, costBasis: "reported" as const };
  if (route.cost_in === null) return { costMicro: null, costBasis: null };
  return { costMicro: Math.ceil(inputTokens * route.cost_in + outputTokens * (route.cost_out ?? 0)), costBasis: "computed" as const };
};

export async function generate(store: Store, identity: Identity, input: unknown, via: Via): Promise<AiResult> {
  const w = identity.workspace;
  if (!aiConfigured(store)) throw fail("AI models are not switched on for this OrbytLink server yet.");
  const req = generateSchema.parse(input);
  const item = getItem(store, req.model);
  if (!item || item.kind !== "chat" || item.unit_in !== "1M tokens" || item.unit_out !== "1M tokens") throw fail(`"${req.model.slice(0, 120)}" is not a text model with a listed price. Pick one from Catalog → AI models.`, 400);
  const price = priceOf(store, item.id);
  const [inPrice, outPrice] = [price.input ?? 0, price.output ?? 0];
  const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...(req.messages || []), ...(req.prompt?.trim() ? [{ role: "user", content: req.prompt }] : [])];
  // A deliberately high estimate: about 3 characters per token, plus a little per message.
  const estimatedInput = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3) + 16 * messages.length;
  const routes = routesFor(store, item.id, item.name, "openai-chat", { inTokens: estimatedInput, outTokens: req.maxTokens });
  const held = Math.max(1, Math.ceil(estimatedInput * inPrice + req.maxTokens * outPrice));
  hold(store, w, held);
  let charged = 0;
  let served: LiveRoute | undefined;
  try {
    const { r, route, latencyMs, failed } = await callRoutes(routes, (ref) => ({ model: ref, messages, max_tokens: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.json ? { response_format: { type: "json_object" } } : {}) }), 90_000);
    served = route;
    for (const f of failed) recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "chat", source: f.route.source, ref: f.route.ref, status: "failed", chargedMicro: 0, latencyMs: f.latencyMs, note: f.note });
    const body: any = await r.json().catch(() => null);
    if (!r.ok) throw fail(`The model provider refused the request (HTTP ${r.status}). No credit was used.`, 502);
    const text = String(body?.choices?.[0]?.message?.content ?? "");
    // Some providers (Gemini) leave hidden thinking out of completion_tokens but count it in total_tokens,
    // and bill it as output; others already include it. Output is whichever is larger, so it's never undercounted.
    const inputTokens = Number(body?.usage?.prompt_tokens) || 0,
      outputTokens = Math.max(Number(body?.usage?.completion_tokens) || 0, (Number(body?.usage?.total_tokens) || 0) - inputTokens);
    // Without token counts the hold stands as the charge, so usage is never undercounted.
    charged = body?.usage ? Math.max(1, Math.ceil(inputTokens * inPrice + outputTokens * outPrice)) : held;
    recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "chat", source: route.source, ref: route.ref, status: "ok", unitsIn: inputTokens, unitsOut: outputTokens, ...costOf(body, route, inputTokens, outputTokens), chargedMicro: charged, latencyMs });
    return { text, model: req.model, inputTokens, outputTokens, costMicro: charged };
  } catch (error) {
    const e = error as any;
    // Every provider failed: each attempt goes to the ledger (for reliability), or the one failure.
    const attempts: { route: LiveRoute; latencyMs: number; note: string }[] = Array.isArray(e?.failed) ? e.failed : [];
    if (attempts.length) for (const f of attempts) recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "chat", source: f.route.source, ref: f.route.ref, status: "failed", chargedMicro: 0, latencyMs: f.latencyMs, note: f.note });
    else recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "chat", source: served?.source, ref: served?.ref, status: "failed", chargedMicro: 0, note: e?.safe ? e.message : e?.name || "error" });
    if (e?.safe) throw e;
    throw fail(e?.name === "TimeoutError" ? "The model took longer than 90 seconds. No credit was used." : "The model could not be reached. No credit was used.", 502);
  } finally {
    settle(store, w, held, charged);
  }
}

// ── Decision models ──────────────────────────────────────────────────────────
// They answer typed questions about an input (OpenAI-compatible POST /decisions): a choice among
// given values, a yes/no probability, or a score. No free text. Billed per token like any model.
export type DecisionQuestion =
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
  | { type: "predicate"; name: string; instructions: string };
export type DecisionAnswer = { type: string; name: string | null; choice?: string; confidence?: number; probability?: number };
export type DecideResult = { answers: Record<string, DecisionAnswer>; model: string; inputTokens: number; outputTokens: number; costMicro: number };
export async function decide(store: Store, identity: Identity, req: { model: string; input: string; questions: DecisionQuestion[] }, via: Via): Promise<DecideResult> {
  const w = identity.workspace;
  const item = getItem(store, req.model);
  if (!item || item.kind !== "decision") throw fail(`"${req.model.slice(0, 120)}" is not a decision model.`, 400);
  const price = priceOf(store, item.id);
  const [inPrice, outPrice] = [price.input ?? 0, price.output ?? 0];
  // About 3 characters per token over everything sent, plus a few answer tokens per question.
  const estimatedInput = Math.ceil((JSON.stringify(req.questions).length + req.input.length) / 3);
  const routes = routesFor(store, item.id, item.name, "openai-decisions", { inTokens: estimatedInput, outTokens: 50 * req.questions.length });
  const held = Math.max(1, Math.ceil(estimatedInput * inPrice + 50 * req.questions.length * outPrice));
  hold(store, w, held);
  let charged = 0;
  let served: LiveRoute | undefined;
  try {
    const { r, route, latencyMs, failed } = await callRoutes(routes, (ref) => ({ model: ref, input: req.input, questions: req.questions }), 60_000);
    served = route;
    for (const f of failed) recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "decision", source: f.route.source, ref: f.route.ref, status: "failed", chargedMicro: 0, latencyMs: f.latencyMs, note: f.note });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(body?.answers)) throw fail(`The decision model refused the request (HTTP ${r.status}). No credit was used.`, 502);
    const inputTokens = Number(body?.usage?.input_tokens) || 0,
      outputTokens = Number(body?.usage?.output_tokens) || 0;
    charged = body?.usage ? Math.max(1, Math.ceil(inputTokens * inPrice + outputTokens * outPrice)) : held;
    recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "decision", source: route.source, ref: route.ref, status: "ok", unitsIn: inputTokens, unitsOut: outputTokens, ...costOf(body, route, inputTokens, outputTokens), chargedMicro: charged, latencyMs });
    // Answers come back in question order; key them by name.
    const answers: Record<string, DecisionAnswer> = {};
    body.answers.forEach((a: any, i: number) => {
      const name = typeof a?.name === "string" ? a.name : req.questions[i]?.name;
      if (name) answers[name] = { ...a, name, ...(a?.choice !== undefined ? { choice: String(a.choice) } : {}) };
    });
    return { answers, model: req.model, inputTokens, outputTokens, costMicro: charged };
  } catch (error) {
    const e = error as any;
    // Every provider failed: each attempt goes to the ledger (for reliability), or the one failure.
    const attempts: { route: LiveRoute; latencyMs: number; note: string }[] = Array.isArray(e?.failed) ? e.failed : [];
    if (attempts.length) for (const f of attempts) recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "decision", source: f.route.source, ref: f.route.ref, status: "failed", chargedMicro: 0, latencyMs: f.latencyMs, note: f.note });
    else recordCall(store, { workspace: w, user: identity.user, via, item: item.id, kind: "decision", source: served?.source, ref: served?.ref, status: "failed", chargedMicro: 0, note: e?.safe ? e.message : e?.name || "error" });
    if (e?.safe) throw e;
    throw fail(e?.name === "TimeoutError" ? "The decision model took too long. No credit was used." : "The decision model could not be reached. No credit was used.", 502);
  } finally {
    settle(store, w, held, charged);
  }
}
