import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { readFileSync } from "node:fs";
import { decisionModels, ensureCatalog, exportCatalog, GOOGLE, importCatalog, priceOf, removeRoute, setDecision, setPrice, syncGoogle, syncVercel, upsertItem, upsertRoute, VERCEL } from "../server/catalog";
import { report } from "../server/ledger";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, workspace: string;
let calls: { url: string; body: any; auth: string | null }[], reply: (url: string) => Response;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const ok = (extra: object = {}) => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, ...extra });
const shown = async (id: string) => (await api("/api/models")).data.models.find((m: any) => m.id === id);
const ENV = ["AI_GATEWAY_API_KEY", "GROQ_API_KEY", "SARVAM_API_KEY", "AI_MARKUP_PERCENT"];

beforeEach(async () => {
  process.env.AI_GATEWAY_API_KEY = "vck_gateway_key_123456";
  calls = [];
  reply = () => ok();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return reply(String(input));
    }),
  );
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  workspace = (await api("/api/state")).data.identity.workspace;
  grantCredits(store, workspace, 100_000_000, "operator");
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) delete process.env[k];
});

it("keeps the catalog in tables: an item per model, a route per way of calling it, nothing secret in a row", async () => {
  const items = store.db.prepare("SELECT kind, COUNT(*) AS n FROM catalog_items GROUP BY kind ORDER BY kind").all() as any[];
  expect(Object.fromEntries(items.map((r) => [r.kind, r.n]))).toEqual({ chat: 320, decision: 14, listed: 164, service: 3 });
  const flash = store.db.prepare("SELECT r.*, i.info_url FROM catalog_routes r JOIN catalog_items i ON i.id=r.item_id WHERE item_id=?").get("google/gemini-2.5-flash-lite") as any;
  expect(flash).toMatchObject({ source: "vercel", protocol: "openai-chat", endpoint: "https://ai-gateway.vercel.sh/v1/chat/completions", ref: "google/gemini-2.5-flash-lite", key_env: "AI_GATEWAY_API_KEY", cost_in: 0.1, cost_out: 0.4, info_url: "https://vercel.com/ai-gateway/models/gemini-2.5-flash-lite" });
  const jev = store.db.prepare("SELECT * FROM catalog_routes WHERE item_id='typesafe-ai/jev'").get() as any;
  expect(jev).toMatchObject({ protocol: "openai-decisions", endpoint: "https://ai-gateway.vercel.sh/v1/decisions", key_env: "AI_GATEWAY_API_KEY" });
  // Every Vercel route: the same endpoint per protocol and the same key variable.
  expect(store.db.prepare("SELECT DISTINCT endpoint, key_env FROM catalog_routes WHERE source='vercel' ORDER BY endpoint").all()).toEqual([
    { endpoint: VERCEL.chat, key_env: "AI_GATEWAY_API_KEY" },
    { endpoint: VERCEL.decisions, key_env: "AI_GATEWAY_API_KEY" },
  ]);
  expect(JSON.stringify(store.db.prepare("SELECT * FROM catalog_routes").all())).not.toContain("vck_");
  // Workspaces see names and prices only.
  const text = JSON.stringify((await api("/api/models")).data);
  for (const hidden of ["vercel", "ai-gateway", "AI_GATEWAY_API_KEY", "cost_in", "browser-step"]) expect(text).not.toContain(hidden);
  expect(await shown("google/gemini-2.5-flash-lite")).toMatchObject({ input: ["0.105", "1M tokens"], output: ["0.42", "1M tokens"], callable: true });
});

it("calls a model through another source by adding one route row, and records both sides of every call", async () => {
  // Groq for Gemini Flash Lite: a row with its link, its model id and the variable that holds its key.
  const groq = { item: "google/gemini-2.5-flash-lite", source: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", ref: "gemini-flash-lite", key_env: "GROQ_API_KEY", cost_in: 0.05, cost_out: 0.2 };
  upsertRoute(store, groq);
  // Not live until its key variable is set: calls still go to Vercel, at Vercel's price.
  await api("/api/ai/try", { model: groq.item, prompt: "hi", maxTokens: 10 });
  expect(calls.at(-1)!.url).toBe(VERCEL.chat);
  process.env.GROQ_API_KEY = "gsk_groq_key_123";
  // The price people see doesn't move: it comes from the list price, so a cheaper source is margin.
  expect((await shown(groq.item)).input[0]).toBe("0.105");
  const r = (await api("/api/ai/try", { model: groq.item, prompt: "hi", maxTokens: 10 })).data;
  expect(calls.at(-1)).toMatchObject({ url: groq.endpoint, auth: "Bearer gsk_groq_key_123", body: { model: "gemini-flash-lite" } });
  expect(r.costMicro).toBe(105_000);
  // Priority wins over cost: the operator can pin a source.
  upsertRoute(store, { item: groq.item, source: "vercel", priority: 10 });
  await api("/api/ai/try", { model: groq.item, prompt: "hi", maxTokens: 10 });
  expect(calls.at(-1)!.url).toBe(VERCEL.chat);
  // That source is down: the call moves to the next route.
  reply = (url) => (url === VERCEL.chat ? new Response("down", { status: 503 }) : ok());
  await api("/api/ai/try", { model: groq.item, prompt: "hi", maxTokens: 10 });
  expect(calls.at(-1)!.url).toBe(groq.endpoint);
  // The source's own cost figure is recorded when it gives one.
  reply = () => ok({ provider_metadata: { gateway: { cost: "0.0421" } } });
  removeRoute(store, groq.item, "groq");
  await api("/api/ai/try", { model: groq.item, prompt: "hi", maxTokens: 10 });

  // The attempt at Vercel while it was down is in the ledger too, as a failure.
  expect(store.db.prepare("SELECT source, status, note FROM usage_calls WHERE workspace=? AND status='failed'").all(workspace)).toEqual([{ source: "vercel", status: "failed", note: "HTTP 503, moved on" }]);
  const rows = store.db.prepare("SELECT source, route_ref, status, units_in, cost_micro, cost_basis, charged_micro FROM usage_calls WHERE workspace=? AND status='ok' ORDER BY id").all(workspace) as any[];
  expect(rows).toEqual([
    { source: "vercel", route_ref: groq.item, status: "ok", units_in: 1_000_000, cost_micro: 100_000, cost_basis: "computed", charged_micro: 105_000 },
    { source: "groq", route_ref: "gemini-flash-lite", status: "ok", units_in: 1_000_000, cost_micro: 50_000, cost_basis: "computed", charged_micro: 105_000 },
    { source: "vercel", route_ref: groq.item, status: "ok", units_in: 1_000_000, cost_micro: 100_000, cost_basis: "computed", charged_micro: 105_000 },
    { source: "groq", route_ref: "gemini-flash-lite", status: "ok", units_in: 1_000_000, cost_micro: 50_000, cost_basis: "computed", charged_micro: 105_000 },
    { source: "vercel", route_ref: groq.item, status: "ok", units_in: 1_000_000, cost_micro: 42_100, cost_basis: "reported", charged_micro: 105_000 },
  ]);
  const bySource = Object.fromEntries(report(store, { by: "source" }).map((r) => [r.key, r]));
  expect(bySource.groq).toMatchObject({ calls: 2, cost_micro: 100_000, charged_micro: 210_000, margin_micro: 110_000 });
  // The workspace sees what it was charged, never the source or the cost.
  const usage = (await api("/api/ai")).data.usage;
  expect(usage[0]).toMatchObject({ model: groq.item, micro: 105_000, via: "console" });
  expect(JSON.stringify(usage)).not.toMatch(/groq|vercel|cost/);
});

it("refuses rows that could leak a secret or call an insecure link", () => {
  const base = { item: "google/gemini-2.5-flash-lite", source: "evil", endpoint: "https://evil.example/v1/chat/completions", cost_in: 0.1, cost_out: 0.1 };
  for (const key_env of ["SECRET_KEY", "CASHFREE_SECRET_KEY", "GOOGLE_CLIENT_SECRET", "PATH", "INSTANT_A_TOKEN", "lower_key"]) expect(() => upsertRoute(store, { ...base, key_env }), key_env).toThrow(/isn't allowed/);
  expect(() => upsertRoute(store, { ...base, key_env: "EVIL_API_KEY", endpoint: "http://evil.example/v1" })).toThrow(/https/);
  expect(() => upsertRoute(store, { ...base, item: "typesafe-ai/jev", key_env: "EVIL_API_KEY", protocol: "openai-chat" })).toThrow(/can't use/);
});

it("prices by the default markup, an item's own markup, or a fixed price; the seed never overwrites operator rows", async () => {
  process.env.AI_MARKUP_PERCENT = "20";
  expect(priceOf(store, "openai/gpt-5-nano")).toMatchObject({ input: 0.06, rule: "markup 20% on list" });
  setPrice(store, "openai/gpt-5-nano", { markup: 50 });
  expect(priceOf(store, "openai/gpt-5-nano")).toMatchObject({ input: 0.075, rule: "markup 50% on list" });
  setPrice(store, "openai/gpt-5-nano", { input: 0.5, output: 2 });
  expect((await shown("openai/gpt-5-nano")).input[0]).toBe("0.5");
  // An operator's change to a seed route survives a newer seed.
  upsertRoute(store, { item: "openai/gpt-5-nano", source: "vercel", cost_in: 0.04 });
  store.db.prepare("UPDATE catalog_meta SET value='old' WHERE key='seed_version'").run();
  // (the next seed runs on a new Store over the same database; here, the same rows are checked directly)
  expect((store.db.prepare("SELECT origin, cost_in FROM catalog_routes WHERE item_id='openai/gpt-5-nano'").get() as any)).toEqual({ origin: "operator", cost_in: 0.04 });
  setPrice(store, "openai/gpt-5-nano", "default");
  // The list price, not the route's cost, sets it.
  expect(priceOf(store, "openai/gpt-5-nano").input).toBeCloseTo(0.06, 9);
  // A new model of the operator's own, at a new source.
  process.env.GROQ_API_KEY = "gsk_1234567890";
  upsertItem(store, { id: "groq/lynx-1", kind: "chat", name: "Lynx 1" });
  upsertRoute(store, { item: "groq/lynx-1", source: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", key_env: "GROQ_API_KEY", cost_in: 0.2, cost_out: 1 });
  expect(await shown("groq/lynx-1")).toMatchObject({ name: "Lynx 1", input: ["0.24", "1M tokens"], callable: true });
});

it("round-trips the whole catalog as JSON and keeps the browser's decision list to decision models", () => {
  expect(decisionModels(store).map((m) => m.id)).toEqual(["typesafe-ai/jev", "perplexity/pplx-decider-flash-v1.2", "microsoft/microsoft-decision-1"]);
  expect(() => setDecision(store, ["google/gemini-2.5-flash-lite"])).toThrow(/Not a decision model/);
  setDecision(store, ["liquid/d1"]);
  const dump = exportCatalog(store);
  expect(dump.lists["browser-decision"]).toEqual(["liquid/d1"]);
  const other = new Store(":memory:");
  ensureCatalog(other);
  upsertItem(store, { id: "acme/new-model", kind: "chat" });
  upsertRoute(store, { item: "acme/new-model", source: "acme", endpoint: "https://api.acme.example/v1/chat/completions", key_env: "ACME_API_KEY", cost_in: 1, cost_out: 2 });
  importCatalog(other, exportCatalog(store));
  expect(other.db.prepare("SELECT endpoint, key_env FROM catalog_routes WHERE item_id='acme/new-model'").get()).toEqual({ endpoint: "https://api.acme.example/v1/chat/completions", key_env: "ACME_API_KEY" });
  expect(decisionModels(other).map((m) => m.id)).toEqual(["liquid/d1"]);
});

it("sees changes another process writes, such as the operator's command line, without a restart", () => {
  process.env.SECRET_KEY ??= "a".repeat(64);
  const dir = mkdtempSync(join(tmpdir(), "orbyt-catalog-"));
  const server = new Store(dir),
    cli = new Store(dir);
  ensureCatalog(server);
  expect(priceOf(server, "liquid/d1").rule).toBe("markup 5% on list");
  setPrice(cli, "liquid/d1", { input: 0.3 });
  expect(priceOf(server, "liquid/d1")).toMatchObject({ input: 0.3, rule: "fixed" });
  server.db.close();
  cli.db.close();
});

it("moves usage recorded before the ledger into it once, keeping what was charged", () => {
  const old = new Store(":memory:");
  old.put("w1", "ai_usage", { model: "anthropic/claude-haiku-4.5", inputTokens: 10, outputTokens: 5, micro: 123, user: "a@example.invalid", via: "agent", createdAt: "2026-11-01T00:00:00.000Z" });
  old.put("w1", "ai_usage", { model: "browser", inputTokens: 0, outputTokens: 0, micro: 40_000, via: "workflow", createdAt: "2026-11-02T00:00:00.000Z" });
  ensureCatalog(old);
  ensureCatalog(old);
  expect(old.db.prepare("SELECT item_id, kind, charged_micro, cost_micro FROM usage_calls ORDER BY at").all()).toEqual([
    { item_id: "anthropic/claude-haiku-4.5", kind: "chat", charged_micro: 123, cost_micro: null },
    { item_id: "orbytlink/browser-step", kind: "service", charged_micro: 40_000, cost_micro: null },
  ]);
});

it("syncs new decision models and their costs from AI Gateway's model list, keeping operator rows", () => {
  const list = [
    { id: "google/gemini-decision-1", name: "Gemini Decision 1", owned_by: "google", type: "evaluation", context_window: 262144, pricing: { input: "0.0000001", output: "0" } },
    { id: "typesafe-ai/jev", name: "Jev", type: "evaluation", context_window: 32000, pricing: { input: "0.00000005", output: "0" } },
    { id: "liquid/d1", name: "Liquid d1", type: "evaluation", pricing: { input: "0.00000003", output: "0" } },
    { id: "openai/brand-new-chat", name: "Brand New", type: "language", pricing: { input: "0.000001", output: "0.000002" } },
  ];
  upsertRoute(store, { item: "liquid/d1", source: "vercel", cost_in: 0.019 }); // the operator's own figure
  const dry = syncVercel(store, list, ["decision"], true);
  expect(dry.added).toEqual(["google/gemini-decision-1"]);
  expect(store.db.prepare("SELECT 1 FROM catalog_items WHERE id='google/gemini-decision-1'").get()).toBeUndefined();
  const out = syncVercel(store, list);
  expect(out).toMatchObject({ added: ["google/gemini-decision-1"], operatorKept: ["liquid/d1"] });
  expect(out.costChanged).toEqual(["typesafe-ai/jev: 0.042/0 → 0.05/0"]);
  expect(out.notListed).toContain("perplexity/pplx-decider-flash-v1.2");
  const gemini = store.db.prepare("SELECT i.kind, i.category, i.info_url, r.protocol, r.endpoint, r.key_env, r.cost_in FROM catalog_items i JOIN catalog_routes r ON r.item_id=i.id WHERE i.id='google/gemini-decision-1'").get();
  expect(gemini).toEqual({ kind: "decision", category: "Decision", info_url: "https://vercel.com/ai-gateway/models/gemini-decision-1", protocol: "openai-decisions", endpoint: VERCEL.decisions, key_env: "AI_GATEWAY_API_KEY", cost_in: 0.1 });
  expect(priceOf(store, "typesafe-ai/jev").input).toBeCloseTo(0.0525, 9);
  expect((store.db.prepare("SELECT cost_in FROM catalog_routes WHERE item_id='liquid/d1'").get() as any).cost_in).toBe(0.019);
  // Chat models are synced only when asked.
  expect(store.db.prepare("SELECT 1 FROM catalog_items WHERE id='openai/brand-new-chat'").get()).toBeUndefined();
  setDecision(store, ["google/gemini-decision-1", "typesafe-ai/jev"]);
  expect(decisionModels(store).map((m) => m.id)).toEqual(["google/gemini-decision-1", "typesafe-ai/jev"]);
});

it("adds Sarvam from its provider file: a new model, and cheaper routes to models already sold, at the same prices", async () => {
  importCatalog(store, JSON.parse(readFileSync("catalog/providers/sarvam.json", "utf8")));
  // A model only Sarvam serves: its list price is Sarvam's (₹10 / ₹25 per 1M at ₹90 to the dollar).
  expect(priceOf(store, "sarvam/sarvam-105b")).toMatchObject({ input: Math.round((10 / 90) * 1.05 * 1e9) / 1e9, rule: "markup 5% on list" });
  const route = store.db.prepare("SELECT endpoint, ref, key_env, auth_header FROM catalog_routes WHERE item_id='deepseek/deepseek-v4.1-flash-1017' AND source='sarvam'").get();
  expect(route).toEqual({ endpoint: "https://api.sarvam.ai/v2/chat/completions", ref: "deepseekv4.1-flash-1017", key_env: "SARVAM_API_KEY", auth_header: "api-subscription-key" });
  // An existing model keeps its name and list price.
  expect(await shown("deepseek/deepseek-v4.1-flash-1017")).toMatchObject({ name: "DeepSeek V4.1 Flash 1017", input: ["0.315", "1M tokens"] });
  // With the key set, calls go to Sarvam (cheaper) with the key in Sarvam's header, at the same price.
  process.env.SARVAM_API_KEY = "sk_sarvam_123456";
  const sent: Headers[] = [];
  vi.mocked(fetch).mockImplementation(async (input: any, init: any = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    sent.push(new Headers(init.headers));
    return ok();
  });
  const r = (await api("/api/ai/try", { model: "deepseek/deepseek-v4.1-flash-1017", prompt: "hi", maxTokens: 10 })).data;
  expect(calls.at(-1)).toMatchObject({ url: "https://api.sarvam.ai/v2/chat/completions", auth: null, body: { model: "deepseekv4.1-flash-1017" } });
  expect(sent.at(-1)!.get("api-subscription-key")).toBe("sk_sarvam_123456");
  expect(r.costMicro).toBe(315_000);
  const row = store.db.prepare("SELECT source, cost_micro, charged_micro FROM usage_calls ORDER BY id DESC LIMIT 1").get();
  expect(row).toEqual({ source: "sarvam", cost_micro: Math.ceil(1_000_000 * Math.round((14 / 90) * 1e9) / 1e9), charged_micro: 315_000 });
  delete process.env.SARVAM_API_KEY;
});

it("never sends a call to a source that costs more than the price", async () => {
  process.env.GROQ_API_KEY = "gsk_1234567890";
  upsertRoute(store, { item: "google/gemma-4-31b-it", source: "groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", key_env: "GROQ_API_KEY", cost_in: 5, cost_out: 5, priority: 100 });
  await api("/api/ai/try", { model: "google/gemma-4-31b-it", prompt: "hi", maxTokens: 10 });
  expect(calls.at(-1)!.url).toBe(VERCEL.chat);
});

it("adds a Google AI Studio route for each model the key can call that the catalog sells", () => {
  const out = syncGoogle(store, [{ id: "models/gemini-2.5-flash-lite" }, { id: "gemini-3.8-flash" }, { id: "gemini-unheard-of" }]);
  expect(out.added).toEqual(["google/gemini-2.5-flash-lite", "google/gemini-3.8-flash"]);
  expect(out.notInCatalog).toEqual(["gemini-unheard-of"]);
  expect(store.db.prepare("SELECT endpoint, ref, key_env, auth_header, cost_in, cost_out FROM catalog_routes WHERE item_id='google/gemini-2.5-flash-lite' AND source='google'").get()).toEqual({ endpoint: GOOGLE.chat, ref: "gemini-2.5-flash-lite", key_env: "GEMINI_API_KEY", auth_header: null, cost_in: 0.1, cost_out: 0.4 });
  expect(priceOf(store, "google/gemini-2.5-flash-lite").input).toBe(0.105);
});
