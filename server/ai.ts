import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { modelPrices, PRICES_AS_OF } from "./model-prices.js";

// AI models, resold. OrbytLink calls the Vercel AI Gateway with its own key (AI_GATEWAY_API_KEY)
// and charges the workspace the catalog price, which already includes the markup. Money is kept
// in whole micro-dollars (1 USD = 1,000,000), so there is no rounding drift.
//
// A call first holds the most it could cost (a generous estimate of the prompt plus the full
// max_tokens), so concurrent calls cannot spend credit that is not there; once the gateway
// reports the real token counts the hold is settled to the actual price. Failed calls are free.
export const AI_TOOL = "orbytlink__ai_generate";
export const aiConfigured = () => !!process.env.AI_GATEWAY_API_KEY;
const gatewayUrl = () => (process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const row = (store: Store, w: string, kind: string, id: string) => store.list(w, kind).find((r) => r.id === id);
export const usd = (micro: number) => micro / 1_000_000;

// The stored prices (model-prices.ts, the catalog) already include a 5% markup over the provider's
// list price. AI_MARKUP_PERCENT sets the markup you actually want: 0 sells at cost, 10 adds 10%.
// It scales the stored price, so the amount charged and the amount shown always agree.
// Unset or invalid keeps the 5% the catalog was built with.
export const BAKED_MARKUP_PERCENT = 5;
export function markupPercent() {
  const raw = process.env.AI_MARKUP_PERCENT?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : BAKED_MARKUP_PERCENT;
}
export const priceScale = () => (1 + markupPercent() / 100) / (1 + BAKED_MARKUP_PERCENT / 100);

export function aiSummary(store: Store, w: string) {
  const settings: Record<string, any> = row(store, w, "ai_settings", "settings") || {};
  return {
    configured: aiConfigured(),
    enabled: settings.enabled !== false,
    balance: row(store, w, "ai_credits", "balance")?.micro || 0,
    monthSpent: row(store, w, "ai_months", month())?.micro || 0,
    monthlyLimit: settings.monthlyLimit ?? null,
    pricesAsOf: PRICES_AS_OF,
    priceScale: priceScale(),
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
    model: { type: "string", description: "Model ID from OrbytLink → Catalog → AI models, e.g. anthropic/claude-haiku-4.5" },
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

export async function generate(store: Store, identity: Identity, input: unknown, via: "agent" | "workflow" | "console"): Promise<AiResult> {
  const w = identity.workspace;
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw fail("AI models are not switched on for this OrbytLink server yet.");
  const req = generateSchema.parse(input);
  const price = modelPrices[req.model];
  if (!price) throw fail(`"${req.model.slice(0, 120)}" is not a text model with a listed price. Pick one from Catalog → AI models.`, 400);
  const scale = priceScale();
  const [inPrice, outPrice] = [price[0] * scale, price[1] * scale];
  const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...(req.messages || []), ...(req.prompt?.trim() ? [{ role: "user", content: req.prompt }] : [])];
  // A deliberately high estimate: about 3 characters per token, plus a little per message.
  const estimatedInput = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3) + 16 * messages.length;
  const hold = Math.max(1, Math.ceil(estimatedInput * inPrice + req.maxTokens * outPrice));
  // Checks and the hold happen together, with no await in between, so they cannot interleave.
  const s = aiSummary(store, w);
  if (!s.enabled) throw fail("An admin has turned AI models off for this workspace.");
  if (s.balance < hold) throw fail(`Not enough AI credit: this call can cost up to $${usd(hold).toFixed(4)} and the balance is $${usd(s.balance).toFixed(4)}.`, 402);
  if (s.monthlyLimit !== null && s.monthSpent + hold > s.monthlyLimit) throw fail(`This call would pass the workspace's monthly AI limit of $${usd(s.monthlyLimit).toFixed(2)}.`, 402);
  addBalance(store, w, -hold);
  addMonth(store, w, hold);
  let charged = 0;
  try {
    const r = await fetch(`${gatewayUrl()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.json ? { response_format: { type: "json_object" } } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    const body: any = await r.json().catch(() => null);
    if (!r.ok) throw fail(`The model provider refused the request (HTTP ${r.status}). No credit was used.`, 502);
    const text = String(body?.choices?.[0]?.message?.content ?? "");
    const inputTokens = Number(body?.usage?.prompt_tokens) || 0,
      outputTokens = Number(body?.usage?.completion_tokens) || 0;
    // Without token counts the hold stands as the charge, so usage is never undercounted.
    charged = body?.usage ? Math.max(1, Math.ceil(inputTokens * inPrice + outputTokens * outPrice)) : hold;
    store.put(w, "ai_usage", { model: req.model, inputTokens, outputTokens, micro: charged, user: identity.user, via, createdAt: new Date().toISOString() });
    store.trim(w, "ai_usage", 2000);
    return { text, model: req.model, inputTokens, outputTokens, costMicro: charged };
  } catch (error) {
    const e = error as any;
    if (e?.safe) throw e;
    throw fail(e?.name === "TimeoutError" ? "The model took longer than 90 seconds. No credit was used." : "The model could not be reached. No credit was used.", 502);
  } finally {
    // Settle: give back whatever of the hold was not charged (all of it when the call failed).
    addBalance(store, w, hold - charged);
    addMonth(store, w, charged - hold);
  }
}
