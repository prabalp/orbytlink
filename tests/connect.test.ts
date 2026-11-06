import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) => inject(app, { url, method, headers: { Cookie: c }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function connect(c = cookie) {
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 }, "POST", c)).data.token as string;
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
const ask = async (client: Client, app: string) => {
  const r = await client.callTool({ name: "orbytlink__connect_app", arguments: { app } });
  return JSON.parse((r.content as any)[0].text);
};
beforeEach(async () => {
  store = new Store(":memory:");
  services = { test: vi.fn(), call: vi.fn() };
  app = createApp(store, services).app;
  cookie = await register("Alice");
});

it("sends the agent a link and the app's own steps when an app is not connected", async () => {
  const client = await connect();
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("orbytlink__connect_app");
  const apollo = (await ask(client, "apollo")).results[0];
  expect(apollo).toMatchObject({ app: "Apollo.io", type: "MCP server", status: "Not connected", link: "http://127.0.0.1:3100/#connect=mcp:apollo" });
  expect(apollo.steps.join(" ")).toMatch(/sign in with Apollo\.io/);
  const stripe = (await ask(client, "stripe")).results;
  expect(stripe.map((r: any) => r.type)).toEqual(["MCP server", "API"]);
  expect(stripe[1].link).toBe("http://127.0.0.1:3100/#connect=api:stripe");
  expect(stripe[1].steps.join(" ")).toMatch(/Paste your API key/);
  const exa = (await ask(client, "exa")).results[0];
  expect(exa.steps.join(" ")).toMatch(/paste your Exa key/);
  const reddit = (await ask(client, "reddit")).results[0];
  expect(reddit).toMatchObject({ app: "Reddit", status: "No ready-made connection yet" });
  expect(reddit.link).toBeUndefined();
  const none = await ask(client, "zzqx internal tool");
  expect(none.results).toEqual([]);
  expect(none.notFound).toMatch(/#connections/);
  // find_tools points the agent here when an app is missing.
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: [{ name: "x", inputSchema: { type: "object" } }] });
  const row = (await api("/api/connections", { name: "Linear", kind: "mcp", endpoint: "https://linear.example/mcp" })).data;
  await api(`/api/connections/${row.id}/test`, {});
  const find = await client.callTool({ name: "orbytlink__find_tools", arguments: { app: "Apollo" } });
  expect(JSON.stringify(find.content)).toContain("orbytlink__connect_app");
});

it("says when an app is already connected, and tells members to ask an admin", async () => {
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: [{ name: "search", inputSchema: { type: "object" } }] });
  const row = (await api("/api/connections", { name: "Notion", kind: "mcp", endpoint: "https://mcp.notion.com/mcp" })).data;
  await api(`/api/connections/${row.id}/test`, {});
  const client = await connect();
  expect((await ask(client, "notion")).results[0]).toMatchObject({ app: "Notion", status: "Already connected" });

  await api("/api/orgs", { name: "Acme" });
  const bob = await register("Bobby");
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  await api("/api/invites/accept", { token: invite }, "POST", bob);
  const member = (await ask(await connect(bob), "apollo")).results[0];
  expect(member.steps).toEqual([`Only an admin of this workspace can connect apps. Send them this link: ${member.link}`]);
});

it("keeps the gateway's search list in step with the console catalog", async () => {
  const { connectIndex } = await import("../server/connect-index");
  const { catalog } = await import("../src/catalog");
  const { apiPresets } = await import("../src/api-presets");
  const { moreApps } = await import("../src/catalog-more");
  // If this fails, run: npm run catalog (it also runs before every build and dev start).
  expect(connectIndex.filter((e) => e.kind === "mcp").map((e) => [e.id, e.endpoint])).toEqual(catalog.filter((p) => !p.hidden).map((p) => [p.id, p.endpoint]));
  expect(connectIndex.filter((e) => e.kind === "api").map((e) => e.id)).toEqual(apiPresets.map((p) => p.id));
  expect(connectIndex.filter((e) => e.kind === "soon").map((e) => e.id)).toEqual(moreApps.map((a) => a.id));
});
