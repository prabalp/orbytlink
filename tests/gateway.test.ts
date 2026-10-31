import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";
// The gateway also lists its own orbytlink__* tools; these tests are about app tools.
const appTools = (tools: { name: string }[]) => tools.map((t) => t.name).filter((n) => !n.startsWith("orbytlink__"));

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
const password = "Correct-horse-ship-2026";

async function register(email: string) {
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    body: { name: "prabalp", email, password },
  });
  return String(r.headers["set-cookie"]).split(";")[0];
}
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) =>
  inject(app, { url, method, headers: { Cookie: c }, body });

async function connect(token: string) {
  const client = new Client({ name: "claude-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://gateway.example/mcp"),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_input, init) => {
        const r = await inject(app, {
          url: "/mcp",
          method: init?.method || "POST",
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(r.text, {
          status: r.status,
          headers: Object.fromEntries(
            Object.entries(r.headers)
              .filter(([k]) => !["transfer-encoding", "content-length"].includes(k))
              .map(([k, v]) => [k, String(v)]),
          ),
        });
      },
    },
  );
  await client.connect(transport);
  return client;
}

async function addConnected(name: string, tools: string[], secret?: string) {
  vi.mocked(services.test).mockResolvedValueOnce({
    protocol: "mcp",
    tools: tools.map((t) => ({ name: t, description: `${t} tool`, inputSchema: { type: "object" } })),
  });
  const row = (
    await api("/api/connections", {
      name,
      kind: "mcp",
      endpoint: `https://${name.toLowerCase()}.example/mcp`,
      auth: secret ? "bearer" : "none",
      ...(secret ? { secret } : {}),
    })
  ).data;
  return (await api(`/api/connections/${row.id}/test`, {})).data;
}

beforeEach(async () => {
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args, secret) => ({
      content: [{ type: "text", text: `ran ${tool} ${JSON.stringify(args)} with ${secret}` }],
    })),
  };
  app = createApp(store, services).app;
  cookie = await register("prabalp@example.invalid");
});

describe("MCP gateway", () => {
  it("aggregates tools from every connected app behind one endpoint, namespaced", async () => {
    await addConnected("GitHub", ["create_issue", "list_repos"]);
    await addConnected("Linear", ["create_issue"]);
    await api("/api/connections", { name: "Untested", kind: "mcp", endpoint: "https://u.example/mcp" });
    const { data: token } = await api("/api/tokens", { name: "Claude Code" });
    const client = await connect(token.token);
    try {
      const names = appTools((await client.listTools()).tools).sort();
      expect(names).toEqual(["github__create_issue", "github__list_repos", "linear__create_issue"]);
    } finally {
      await client.close();
    }
  });
  it("calls the upstream tool with the stored credential and never returns it", async () => {
    const c = await addConnected("CRM", ["find"], "upstream-secret-value");
    const { data: token } = await api("/api/tokens", { name: "Claude" });
    const client = await connect(token.token);
    try {
      const result: any = await client.callTool({ name: "crm__find", arguments: { q: "acme" } });
      expect(services.call).toHaveBeenCalledWith(
        expect.objectContaining({ id: c.id }),
        "find",
        { q: "acme" },
        "upstream-secret-value",
      );
      // The upstream echoed the credential; the gateway must redact it.
      expect(JSON.stringify(result)).not.toContain("upstream-secret-value");
      expect(result.content[0].text).toContain("ran find");
    } finally {
      await client.close();
    }
    const state = await api("/api/state");
    expect(state.data.calls[0]).toMatchObject({ tool: "find", status: "ok" });
    expect(JSON.stringify(state.data)).not.toContain("acme");
  });
  it("hides disabled tools and disabled connections immediately", async () => {
    const c = await addConnected("Mail", ["read_inbox", "send_email"]);
    await api(`/api/connections/${c.id}/tools`, { disabledTools: ["send_email"] }, "PUT");
    const { data: token } = await api("/api/tokens", { name: "Claude" });
    const client = await connect(token.token);
    try {
      expect(appTools((await client.listTools()).tools)).toEqual(["mail__read_inbox"]);
      const blocked: any = await client.callTool({ name: "mail__send_email", arguments: {} });
      expect(blocked.isError).toBe(true);
      expect(services.call).not.toHaveBeenCalled();
      // Any edit takes the connection offline until it is tested again.
      await api(`/api/connections/${c.id}`, { name: "Mail", kind: "mcp", endpoint: "https://other.example/mcp" }, "PUT");
      expect(appTools((await client.listTools()).tools)).toEqual([]);
    } finally {
      await client.close();
    }
  });
  it("returns a generic error when the upstream fails", async () => {
    await addConnected("Flaky", ["go"]);
    vi.mocked(services.call).mockRejectedValueOnce(new Error("internal 10.0.0.5 stack detail"));
    const { data: token } = await api("/api/tokens", { name: "Claude" });
    const client = await connect(token.token);
    try {
      const r: any = await client.callTool({ name: "flaky__go", arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("10.0.0.5");
    } finally {
      await client.close();
    }
  });
});

describe("gateway tokens", () => {
  it("are shown once, stored hashed, listed, and revocable", async () => {
    const { data: created } = await api("/api/tokens", { name: "Laptop", expiresInDays: 30 });
    expect(created.token).toMatch(/^ol_/);
    const raw = JSON.stringify(store.db.prepare("SELECT * FROM access_tokens").all());
    expect(raw).not.toContain(created.token);
    const state = await api("/api/state");
    expect(state.data.tokens).toHaveLength(1);
    expect(JSON.stringify(state.data)).not.toContain(created.token);
    const bearer = { Authorization: `Bearer ${created.token}` };
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = { ...bearer, Accept: "application/json, text/event-stream" };
    expect((await inject(app, { url: "/mcp", method: "POST", headers, body: list })).status).toBe(200);
    expect((await api(`/api/tokens/${created.id}`, {}, "DELETE")).status).toBe(200);
    expect((await inject(app, { url: "/mcp", method: "POST", headers, body: list })).status).toBe(401);
  });
  it("can only call tools: no configuration, no token minting, no other workspace", async () => {
    const c = await addConnected("App", ["t"]);
    const { data: created } = await api("/api/tokens", { name: "Claude" });
    const headers = { Authorization: `Bearer ${created.token}` };
    for (const [url, method, body] of [
      ["/api/state", "GET", undefined],
      ["/api/connections", "POST", { name: "Sneaky" }],
      [`/api/connections/${c.id}`, "DELETE", {}],
      ["/api/tokens", "POST", { name: "Escalate" }],
    ] as const)
      expect((await inject(app, { url, method, headers, body })).status, url).toBe(403);
    const other = await register("someone-else@example.invalid");
    expect((await api(`/api/connections/${c.id}`, {}, "DELETE", other)).status).toBe(404);
  });
  it("must expire within a year", async () => {
    expect((await api("/api/tokens", { name: "Forever", expiresInDays: 10000 })).status).toBe(400);
  });
});
