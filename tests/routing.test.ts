import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { upsertRoute } from "../server/catalog";
import { recordCall } from "../server/ledger";
import { clearRests, clearRoutingStats, plan, refreshBalances, setSource, sources } from "../server/routing";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

// Model x, sold by three providers: Vercel (api balance), Google (postpaid), Sarvam (balance by hand).
const X = "deepseek/deepseek-v4.1-flash-1017";
let app: Express, store: Store, cookie: string, workspace: string;
let calls: string[], reply: (url: string) => Response | Promise<Response>;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const ok = () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
const order = () => plan(store, X).ranked.map((c) => c.source);
const ENV = ["AI_GATEWAY_API_KEY", "GEMINI_API_KEY", "GEMINI_FREE_API_KEY", "SARVAM_API_KEY"];

beforeEach(async () => {
  Object.assign(process.env, { AI_GATEWAY_API_KEY: "vck_gateway_123456", GEMINI_API_KEY: "gem_123456", SARVAM_API_KEY: "sk_sarvam_123456" });
  calls = [];
  clearRests();
  reply = (url) => (url.endsWith("/credits") ? Response.json({ balance: "25" }) : ok());
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => (calls.push(String(input)), reply(String(input)))));
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  workspace = (await api("/api/state")).data.identity.workspace;
  grantCredits(store, workspace, 100_000_000, "operator");
  // Vercel lists x at $0.30 / $1.20; Google at the same price; Sarvam at about half.
  upsertRoute(store, { item: X, source: "google", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key_env: "GEMINI_API_KEY", cost_in: 0.3, cost_out: 1.2 });
  upsertRoute(store, { item: X, source: "sarvam", endpoint: "https://api.sarvam.ai/v2/chat/completions", key_env: "SARVAM_API_KEY", auth_header: "api-subscription-key", cost_in: 0.155, cost_out: 0.611 });
  await refreshBalances(store, true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) delete process.env[k];
});

it("1. uses only providers where OrbytLink has credit left for the call", async () => {
  expect(sources(store).find((s) => s.id === "vercel")).toMatchObject({ balance_mode: "api", balance_micro: 25_000_000 });
  // Sarvam's balance is recorded by hand: nothing recorded yet means it isn't tracked, so it's allowed.
  expect(order()).toEqual(["sarvam", "google", "vercel"]);
  setSource(store, "sarvam", { balanceUsd: 0 });
  expect(order()).toEqual(["google", "vercel"]);
  expect(plan(store, X).excluded.find((c) => c.source === "sarvam")!.excluded).toMatch(/no credit left/);
  // Vercel's balance comes from its API: at $0 it drops out too; Google is postpaid and stays.
  reply = (url) => (url.endsWith("/credits") ? Response.json({ balance: "0" }) : ok());
  await refreshBalances(store, true);
  expect(order()).toEqual(["google"]);
  // A balance too small for this call's worst case doesn't count either.
  setSource(store, "sarvam", { balanceUsd: 0.0001 });
  expect(plan(store, X, { call: { inTokens: 1000, outTokens: 1000 } }).ranked.map((c) => c.source)).toEqual(["google"]);
  expect(plan(store, X, { call: { inTokens: 10, outTokens: 10 } }).ranked.map((c) => c.source)).toEqual(["sarvam", "google"]);
});

it("2. a manual priority of 1 always wins, whatever it costs", () => {
  upsertRoute(store, { item: X, source: "vercel", priority: 1 });
  expect(order()[0]).toBe("vercel");
  upsertRoute(store, { item: X, source: "google", priority: 1 });
  // Two with priority 1: cost decides between them (equal here), then speed, then name.
  expect(order()).toEqual(["google", "vercel", "sarvam"]);
});

it("3. then the cheapest for a typical call of this model, using its real token mix", () => {
  // A provider cheap on input but dear on output.
  upsertRoute(store, { item: X, source: "sarvam", cost_in: 0.05, cost_out: 1.2 });
  upsertRoute(store, { item: X, source: "google", cost_in: 0.29, cost_out: 0.5 });
  // Mostly input (the default 1000 in / 250 out): sarvam's input price wins.
  expect(order()[0]).toBe("sarvam");
  // This model's calls turn out to be mostly output: google is cheaper for them.
  for (let i = 0; i < 10; i++) recordCall(store, { workspace, via: "agent", item: X, kind: "chat", source: "vercel", status: "ok", unitsIn: 100, unitsOut: 2000, chargedMicro: 1 });
  clearRoutingStats(store);
  expect(order()[0]).toBe("google");
});

it("4. then the faster one when the cost is the same, measured from the ledger", () => {
  setSource(store, "sarvam", { balanceUsd: 0 });
  // Google and Vercel price x the same.
  for (let i = 0; i < 5; i++) {
    recordCall(store, { workspace, via: "agent", item: X, kind: "chat", source: "vercel", status: "ok", unitsIn: 1000, unitsOut: 250, chargedMicro: 1, latencyMs: 400 });
    recordCall(store, { workspace, via: "agent", item: X, kind: "chat", source: "google", status: "ok", unitsIn: 1000, unitsOut: 250, chargedMicro: 1, latencyMs: 1500 });
  }
  clearRoutingStats(store);
  const p = plan(store, X);
  expect(p.ranked.map((c) => [c.source, c.latencyMs, c.reliability])).toEqual([
    ["vercel", 400, 1],
    ["google", 1500, 1],
  ]);
});

it("calls the providers in that order, records each attempt, and takes the cost off the balance", async () => {
  setSource(store, "sarvam", { balanceUsd: 10 });
  reply = (url) => (url.includes("sarvam") ? new Response("down", { status: 503 }) : url.endsWith("/credits") ? Response.json({ balance: "25" }) : ok());
  const r = await api("/api/ai/try", { model: X, prompt: "hi", maxTokens: 100 });
  expect(r.status).toBe(200);
  expect(calls.filter((u) => !u.endsWith("/credits"))).toEqual(["https://api.sarvam.ai/v2/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"]);
  const rows = store.db.prepare("SELECT source, status, note, latency_ms IS NOT NULL AS timed FROM usage_calls WHERE workspace=? ORDER BY id").all(workspace) as any[];
  expect(rows).toEqual([
    { source: "sarvam", status: "failed", note: "HTTP 503, moved on", timed: 1 },
    { source: "google", status: "ok", note: null, timed: 1 },
  ]);
  // Google is postpaid: nothing to take off. A Sarvam call comes off Sarvam's balance.
  reply = () => ok();
  await api("/api/ai/try", { model: X, prompt: "hi", maxTokens: 100 });
  const sarvam = sources(store).find((s) => s.id === "sarvam")!;
  expect(sarvam.balance_micro).toBe(10_000_000 - Math.ceil(1000 * 0.155 + 100 * 0.611));
});

it("bills hidden thinking tokens as output when a provider counts them only in the total", async () => {
  setSource(store, "sarvam", { balanceUsd: 0 });
  reply = (url) => (url.endsWith("/credits") ? Response.json({ balance: "25" }) : Response.json({ choices: [{ message: { content: "Temple City" } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 308 } }));
  const r = (await api("/api/ai/try", { model: X, prompt: "hi", maxTokens: 300 })).data;
  expect(r).toMatchObject({ inputTokens: 12, outputTokens: 296 });
  expect(r.costMicro).toBe(Math.ceil(12 * 0.315 + 296 * 1.26));
});

it("uses the free-tier Google key first, and the paid ones only once Google says the free quota is spent", async () => {
  process.env.GEMINI_FREE_API_KEY = "gem_free_123456";
  const G = "google/gemini-2.5-flash-lite";
  upsertRoute(store, { item: G, source: "google", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key_env: "GEMINI_API_KEY", cost_in: 0.1, cost_out: 0.4 });
  upsertRoute(store, { item: G, source: "google-free", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key_env: "GEMINI_FREE_API_KEY", cost_in: 0, cost_out: 0 });
  expect(plan(store, G).ranked.map((c) => c.source)[0]).toBe("google-free");
  const keys: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith("/credits")) return Response.json({ balance: "25" });
    const key = new Headers(init.headers).get("authorization")!;
    keys.push(key);
    return key === "Bearer gem_free_123456" ? Response.json({ error: { message: "quota exceeded" } }, { status: 429 }) : ok();
  });
  await api("/api/ai/try", { model: G, prompt: "hi", maxTokens: 50 });
  expect(keys).toEqual(["Bearer gem_free_123456", "Bearer gem_123456"]);
  // The free route now rests: the next call goes straight to the paid key.
  expect(plan(store, G).excluded.find((c) => c.source === "google-free")!.excluded).toMatch(/over its limit, resting until/);
  await api("/api/ai/try", { model: G, prompt: "hi", maxTokens: 50 });
  expect(keys.at(-1)).toBe("Bearer gem_123456");
  expect(keys).toHaveLength(3);
  // Free calls cost OrbytLink nothing in the ledger.
  clearRests();
  vi.mocked(fetch).mockImplementation(async (input: any) => (String(input).endsWith("/credits") ? Response.json({ balance: "25" }) : ok()));
  await api("/api/ai/try", { model: G, prompt: "hi", maxTokens: 50 });
  expect(store.db.prepare("SELECT source, cost_micro FROM usage_calls WHERE status='ok' ORDER BY id DESC LIMIT 1").get()).toEqual({ source: "google-free", cost_micro: 0 });
});
