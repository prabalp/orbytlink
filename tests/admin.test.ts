import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { grantOperator, parseCsv } from "../server/admin";
import { priceOf } from "../server/catalog";
import { setWallet } from "../server/instant";
import { setSources, sources } from "../server/instant/sources";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, workspace: string, services: ServiceAdapters;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie, headers: Record<string, string> = {}) => inject(app, { url, method, headers: { Cookie: c, ...headers }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function agent() {
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
  return { client, token };
}
const csvRequest = (body: string, apply = false) => inject(app, { url: `/api/admin/pricing/import${apply ? "?apply=1" : ""}`, method: "POST", headers: { Cookie: cookie, "Content-Type": "text/csv" }, body });

beforeEach(async () => {
  process.env.AI_GATEWAY_API_KEY = "vck_gateway_key_123456";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ balance: "12" })));
  store = new Store(":memory:");
  services = { test: vi.fn(), call: vi.fn() };
  app = createApp(store, services).app;
  cookie = await register("Alice");
  workspace = (await api("/api/state")).data.identity.workspace;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_MARKUP_PERCENT;
});

it("is a 404 to everyone but the operators granted from the command line, and only for console sessions", async () => {
  expect((await api("/api/admin/overview")).status).toBe(404);
  expect((await api("/api/state")).data.operator).toBeUndefined();
  grantOperator(store, "ALICE@example.invalid");
  expect((await api("/api/admin/overview")).status).toBe(200);
  expect((await api("/api/state")).data.operator).toBe(true);
  // A gateway token of the same person is not a way in.
  const { token } = await agent();
  expect((await inject(app, { url: "/api/admin/overview", headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
  // Nor is another account.
  const bob = await register("Bobby");
  expect((await api("/api/admin/pricing", undefined, "GET", bob)).status).toBe(404);
});

it("sets prices for models and services, logs who changed what, and changes default markups", async () => {
  grantOperator(store, "alice@example.invalid");
  const list = (await api("/api/admin/pricing?q=gemini-2.5-flash-lite")).data;
  const flash = list.rows.find((r: any) => r.id === "google/gemini-2.5-flash-lite");
  expect(flash).toMatchObject({ type: "model", rule: "default", cost_in: 0.1, price_in: 0.105, margin_pct: expect.any(Number) });
  expect(list.markups.ai).toEqual({ percent: 5, from: "default" });
  const set = await api("/api/admin/pricing", { type: "model", id: flash.id, rule: "markup", markup_pct: 40 }, "PUT");
  expect(set.data).toMatchObject({ rule: "markup", markup_pct: 40, price_in: 0.14 });
  await api("/api/admin/pricing", { type: "model", id: flash.id, rule: "fixed", price_in: 0.5, price_out: 1 }, "PUT");
  expect(priceOf(store, flash.id)).toMatchObject({ input: 0.5, output: 1, rule: "fixed" });
  // Services: an MCP tool call is free until priced.
  const services = (await api("/api/admin/pricing?type=service")).data.rows.map((r: any) => [r.id, r.price_in]);
  expect(services).toEqual(expect.arrayContaining([["orbytlink/mcp-call", 0], ["orbytlink/api-call", 0], ["orbytlink/browser-step", 0.001]]));
  // The default markup, from the portal, wins over .env.
  process.env.AI_MARKUP_PERCENT = "10";
  await api("/api/admin/markups", { ai: 25 }, "PUT");
  expect(priceOf(store, "openai/gpt-5-nano").input).toBeCloseTo(0.0625, 9);
  expect((await api("/api/admin/pricing?type=service")).data.markups.ai).toEqual({ percent: 25, from: "admin" });
  const log = (await api("/api/admin/audit")).data.entries;
  expect(log.map((e: any) => e.action)).toEqual(["markup.set", "price.set", "price.set"]);
  expect(log[2]).toMatchObject({ operator: "alice@example.invalid", target: `model ${flash.id}` });
  expect(JSON.parse(log[2].detail)).toMatchObject({ before: { rule: "default" }, after: { rule: "markup", markup_pct: 40 } });
});

it("exports prices as CSV and imports an edited copy: a preview of each change first, errors stop it", async () => {
  grantOperator(store, "alice@example.invalid");
  const csv = (await api("/api/admin/pricing.csv?type=model")).text;
  const rows = parseCsv(csv);
  expect(rows[0]).toEqual(["type", "id", "name", "unit", "cost_in", "cost_out", "price_in", "price_out", "markup_pct", "rule"]);
  // Uploading the file unchanged changes nothing.
  expect((await csvRequest(csv)).data).toMatchObject({ changes: [], errors: [] });
  // Edit two cells: a fixed price for one model, a markup for another.
  const edited = rows.map((r) => (r[1] === "openai/gpt-5-nano" ? [...r.slice(0, 6), "0.2", "0.9", "", r[9]] : r[1] === "typesafe-ai/jev" ? [...r.slice(0, 8), "50", r[9]] : r));
  const body = edited.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const preview = (await csvRequest(body)).data;
  expect(preview.errors).toEqual([]);
  expect(preview.changes.map((c: any) => [c.id, c.rule, c.price_in ?? c.markup_pct])).toEqual([
    ["openai/gpt-5-nano", "fixed", 0.2],
    ["typesafe-ai/jev", "markup", 50],
  ]);
  expect(priceOf(store, "openai/gpt-5-nano").rule).not.toBe("fixed"); // a preview changes nothing
  const applied = (await csvRequest(body, true)).data;
  expect(applied.applied).toBe(2);
  expect(priceOf(store, "openai/gpt-5-nano")).toMatchObject({ input: 0.2, output: 0.9, rule: "fixed" });
  expect(priceOf(store, "typesafe-ai/jev").input).toBeCloseTo(0.063, 9);
  // Back to default by rule, and a bad file.
  expect((await csvRequest("type,id,rule\nmodel,openai/gpt-5-nano,default\n", true)).data.applied).toBe(1);
  const bad = await csvRequest("type,id,price_in\nmodel,nope/none,1\nwidget,x,1\nmodel,openai/gpt-5-nano,abc\n", true);
  expect(bad.status).toBe(400);
  expect((await csvRequest("type,id,price_in\nmodel,nope/none,1\nwidget,x,1\nmodel,openai/gpt-5-nano,abc\n")).data.errors.map((e: any) => e.line)).toEqual([2, 3, 4]);
});

it("charges for MCP tool calls once priced, refusing calls the workspace can't pay for", async () => {
  grantOperator(store, "alice@example.invalid");
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: [{ name: "search", inputSchema: { type: "object" } }] });
  vi.mocked(services.call).mockResolvedValue({ content: [{ type: "text", text: "found" }] });
  const row = (await api("/api/connections", { name: "Notion", kind: "mcp", endpoint: "https://mcp.notion.com/mcp" })).data;
  await api(`/api/connections/${row.id}/test`, {});
  const { client } = await agent();
  const tool = (await client.listTools()).tools.find((t) => t.name.endsWith("search"))!.name;
  // Free by default: works with no credit, nothing recorded.
  expect(JSON.stringify((await client.callTool({ name: tool, arguments: {} })).content)).toContain("found");
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM usage_calls").get()).toEqual({ n: 0 });
  await api("/api/admin/pricing", { type: "service", id: "orbytlink/mcp-call", rule: "fixed", price_in: 0.002 }, "PUT");
  const refused = await client.callTool({ name: tool, arguments: {} });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/Not enough credit/);
  grantCredits(store, workspace, 1_000_000, "operator");
  await client.callTool({ name: tool, arguments: {} });
  expect((await api("/api/ai")).data.balance).toBe(998_000);
  expect(store.db.prepare("SELECT item_id, kind, charged_micro, via FROM usage_calls").get()).toEqual({ item_id: "orbytlink/mcp-call", kind: "service", charged_micro: 2_000, via: "agent" });
});

it("records provider top-ups, pins routes, grants workspace credit, and shows costs and margins", async () => {
  grantOperator(store, "alice@example.invalid");
  const providers = (await api("/api/admin/providers")).data;
  expect(providers.providers.find((p: any) => p.id === "vercel")).toMatchObject({ balance_mode: "api", balance_micro: 12_000_000 });
  const sarvam = (await api("/api/admin/providers/sarvam", { balanceInr: 900 })).data;
  expect(sarvam).toMatchObject({ balance_mode: "manual", balance_micro: 10_000_000 });
  expect((await api("/api/admin/routes", { item: "openai/gpt-5-nano", source: "vercel", priority: 1 }, "PUT")).data.after).toEqual({ priority: 1, enabled: true });
  const routing = (await api("/api/admin/routing?item=openai/gpt-5-nano")).data;
  expect(routing.ranked[0]).toMatchObject({ source: "vercel", priority: 1 });
  expect(JSON.stringify(routing)).not.toContain("vck_");
  const ws = (await api("/api/admin/workspaces")).data.workspaces;
  expect(ws[0]).toMatchObject({ workspace, owner: "alice@example.invalid", balance: 0 });
  expect((await api(`/api/admin/workspaces/${workspace}/credits`, { usd: 5, note: "welcome" })).data.balance).toBe(5_000_000);
  const o = (await api("/api/admin/overview?days=7")).data;
  expect(o).toMatchObject({ days: 7, creditHeld: 5_000_000, totals: { calls: 0 } });
  expect((await api("/api/admin/audit")).data.entries.map((e: any) => e.action)).toEqual(["credit.grant", "route.set", "provider.set"]);
});

it("lists the Instant tool sources beside the model providers, and warns when a configured source runs low", async () => {
  grantOperator(store, "alice@example.invalid");
  const original = sources();
  setSources([{ id: "a", configured: () => true }, { id: "b", configured: () => false }] as any);
  try {
    setWallet(store, "a", 2);
    const o = (await api("/api/admin/overview?days=7")).data;
    expect(o.instant.map((w: any) => [w.source, w.configured, w.wallet?.micro ?? null])).toEqual([["a", true, 2_000_000], ["b", false, null]]);
    expect(o.alerts).toContain("Tool source A balance is $2.00.");
    setWallet(store, "a", 50);
    expect((await api("/api/admin/overview?days=7")).data.alerts.some((a: string) => a.startsWith("Tool source"))).toBe(false);
  } finally {
    setSources(original);
  }
});
