import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { modelPrices } from "../server/model-prices";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

const MODEL = "anthropic/claude-haiku-4.5";
let app: Express, store: Store, cookie: string, workspace: string, services: ServiceAdapters;
let gateway: { body: any; auth: string | null }[], reply: (body: any) => Response;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) => inject(app, { url, method, headers: { Cookie: c }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function connect() {
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token as string;
  const client = new Client({ name: "agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_input, init) => {
        const r = await inject(app, { url: "/mcp", method: init?.method || "POST", headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(r.text, { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !["transfer-encoding", "content-length"].includes(k)).map(([k, v]) => [k, String(v)])) });
      },
    }),
  );
  return client;
}
const balance = async () => (await api("/api/ai")).data.balance as number;

beforeEach(async () => {
  process.env.AI_GATEWAY_API_KEY = "vck_operator_key_123456";
  gateway = [];
  reply = (body) => Response.json({ choices: [{ message: { content: `echo: ${body.messages.at(-1).content}` } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      gateway.push({ body, auth: new Headers(init.headers).get("authorization") });
      expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
      return reply(body);
    }),
  );
  store = new Store(":memory:");
  services = { test: vi.fn(), call: vi.fn() };
  app = createApp(store, services).app;
  cookie = await register("Alice");
  workspace = (await api("/api/state")).data.identity.workspace;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
});

it("follows AI_MARKUP_PERCENT for both the price shown and the amount charged", async () => {
  grantCredits(store, workspace, 10_000_000, "operator");
  const [inPrice, outPrice] = modelPrices[MODEL]; // stored with the 5% the catalog was built with
  const cost = (percent: number) => Math.ceil((1000 * inPrice + 500 * outPrice) * ((1 + percent / 100) / 1.05));
  for (const [setting, percent] of [["0", 0], ["20", 20], ["nonsense", 5], ["-3", 5]] as const) {
    process.env.AI_MARKUP_PERCENT = setting;
    const r = (await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 600 })).data;
    expect(r.costMicro, `AI_MARKUP_PERCENT=${setting}`).toBe(cost(percent));
    expect((await api("/api/ai")).data.priceScale).toBeCloseTo((1 + percent / 100) / 1.05, 10);
  }
  delete process.env.AI_MARKUP_PERCENT;
  expect((await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 600 })).data.costMicro).toBe(cost(5));
});

it("charges the listed price for the tokens used, with the operator's key, and refuses calls it cannot pay for", async () => {
  expect((await api("/api/ai/try", { model: MODEL, prompt: "hi" })).status).toBe(402);
  expect(gateway).toHaveLength(0);
  grantCredits(store, workspace, 1_000_000, "operator");
  const r = (await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 600 })).data;
  const [inPrice, outPrice] = modelPrices[MODEL];
  const expected = Math.ceil(1000 * inPrice + 500 * outPrice);
  expect(r).toMatchObject({ text: "echo: hi", inputTokens: 1000, outputTokens: 500, costMicro: expected });
  expect(gateway[0]).toMatchObject({ auth: "Bearer vck_operator_key_123456", body: { model: MODEL, max_tokens: 600 } });
  expect(await balance()).toBe(1_000_000 - expected);
  const state = (await api("/api/ai")).data;
  expect(state.monthSpent).toBe(expected);
  expect(state.usage[0]).toMatchObject({ model: MODEL, micro: expected, via: "console", user: "alice@example.invalid" });
  // The key never reaches the browser.
  expect(JSON.stringify((await api("/api/state")).data)).not.toContain("vck_operator_key");
  // Unknown or non-text models are refused before any call.
  expect((await api("/api/ai/try", { model: "openai/dall-e-3", prompt: "x" })).status).toBe(400);
  expect(gateway).toHaveLength(1);
});

it("holds credit for the worst case, so a call that could overspend is refused, and failed calls are free", async () => {
  grantCredits(store, workspace, 20_000, "operator"); // $0.02
  const tooBig = await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 16_000 });
  expect(tooBig.status).toBe(402);
  expect(tooBig.data.error).toMatch(/Not enough AI credit/);
  reply = () => Response.json({ error: "overloaded" }, { status: 503 });
  const failed = await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 100 });
  expect(failed.status).toBe(502);
  expect(failed.data.error).toMatch(/No credit was used/);
  expect(await balance()).toBe(20_000);
  expect((await api("/api/ai")).data.monthSpent).toBe(0);
});

it("lets admins cap monthly spend or switch models off, and only admins", async () => {
  grantCredits(store, workspace, 5_000_000, "operator");
  expect((await api("/api/ai/settings", { enabled: true, monthlyLimitUsd: 0.0001 }, "PUT")).status).toBe(200);
  const capped = await api("/api/ai/try", { model: MODEL, prompt: "hi", maxTokens: 100 });
  expect(capped.status).toBe(402);
  expect(capped.data.error).toMatch(/monthly AI limit/);
  await api("/api/ai/settings", { enabled: false, monthlyLimitUsd: null }, "PUT");
  expect((await api("/api/ai/try", { model: MODEL, prompt: "hi" })).data.error).toMatch(/turned AI models off/);
  const tools = (await (await connect()).listTools()).tools.map((t) => t.name);
  expect(tools).not.toContain("orbytlink__ai_generate");

  await api("/api/orgs", { name: "Acme" });
  const bob = await register("Bobby");
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  await api("/api/invites/accept", { token: invite }, "POST", bob);
  expect((await api("/api/ai/settings", { enabled: true, monthlyLimitUsd: null }, "PUT", bob)).status).toBe(403);
});

it("is a tool for agents and a step for workflows, billed the same way", async () => {
  grantCredits(store, workspace, 1_000_000, "operator");
  const client = await connect();
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("orbytlink__ai_generate");
  const out = await client.callTool({ name: "orbytlink__ai_generate", arguments: { model: MODEL, prompt: "from agent" } });
  expect(JSON.stringify(out.content)).toContain("echo: from agent");

  const wf = (
    await api("/api/workflows", {
      name: "Summarise",
      enabled: true,
      inputs: [{ name: "text" }],
      steps: [{ id: "sum", tool: "orbytlink__ai_generate", args: { model: MODEL, prompt: "Summarise: {{input.text}}", maxTokens: "200" } }],
    })
  ).data;
  const run = (await api(`/api/workflows/${wf.id}/run`, { inputs: { text: "a long day" } })).data;
  expect(run.status).toBe("succeeded");
  expect(run.output).toBe("echo: Summarise: a long day");
  expect(gateway.at(-1)?.body.max_tokens).toBe(200);
  const usage = (await api("/api/ai")).data.usage.map((u: any) => u.via);
  expect(usage).toEqual(["workflow", "agent"]);

  await api("/api/ai/settings", { enabled: true, monthlyLimitUsd: 0 }, "PUT");
  const blocked = (await api(`/api/workflows/${wf.id}/run`, { inputs: { text: "x" } })).data;
  expect(blocked.error).toMatch(/monthly AI limit/);
});

it("is off entirely when the server has no gateway key", async () => {
  delete process.env.AI_GATEWAY_API_KEY;
  grantCredits(store, workspace, 1_000_000, "operator");
  expect((await api("/api/ai/try", { model: MODEL, prompt: "hi" })).data.error).toMatch(/not switched on/);
  expect((await api("/api/state")).data.ai.configured).toBe(false);
});
