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

// Many apps and tools: the agent searches instead of loading every schema.
const mailTools = [
  "list_leads", "get_lead", "find_lead", "delete_lead", "list_campaigns", "create_campaign", "update_campaign",
  "archive_campaign", "enroll_leads_in_campaign", "send_campaign_test", "list_conversations", "get_conversation",
  "list_inboxes", "connect_inbox", "list_signatures", "create_signature", "list_members", "invite_member",
  "list_suppressions", "add_suppression", "remove_suppression", "approve_email_draft", "delete_email_draft",
  "list_meetings", "create_meeting", "list_my_organisations", "get_organisation", "check_domain_dns",
];
const crmTools = ["create_contact", "find_contact", "update_deal", "list_deals", "log_call"];
async function addMany() {
  vi.mocked(services.test).mockResolvedValueOnce({
    protocol: "mcp",
    tools: mailTools.map((t) => ({
      name: t,
      description: `${t.replace(/_/g, " ")} in Mail Orbyt`,
      inputSchema: t === "enroll_leads_in_campaign"
        ? { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { campaignId: { type: "string" }, leadIds: { type: "array", items: { type: "string" } } }, required: ["campaignId", "leadIds"] }
        : { type: "object" },
    })),
  });
  const row = (await api("/api/connections", { name: "Mail Orbyt", kind: "mcp", endpoint: "https://mail.example/mcp", auth: "none" })).data;
  await api(`/api/connections/${row.id}/test`, {});
  await addConnected("CRM", crmTools);
}
const token = async (toolMode?: string) => (await api("/api/tokens", { name: "Claude", ...(toolMode ? { toolMode } : {}) })).data;
const text = (r: any) => r.content[0].text as string;

describe("tool discovery", () => {
  it("auto lists every tool for a small workspace", async () => {
    await addConnected("GitHub", ["create_issue"]);
    const client = await connect((await token()).token);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("github__create_issue");
      expect(names).not.toContain("orbytlink__find_tools");
    } finally {
      await client.close();
    }
  });
  it("auto switches to search above 30 tools: find, then call", async () => {
    await addMany();
    const client = await connect((await token()).token);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed).toEqual(expect.arrayContaining(["orbytlink__find_tools", "orbytlink__call_tool", "orbytlink__list_apps"]));
      expect(appTools((await client.listTools()).tools)).toEqual([]);
      expect(client.getInstructions()).toContain("orbytlink__find_tools");

      const apps = JSON.parse(text(await client.callTool({ name: "orbytlink__list_apps", arguments: {} })));
      expect(apps.apps.map((a: any) => [a.app, a.tools])).toEqual(expect.arrayContaining([["Mail Orbyt", mailTools.length], ["CRM", crmTools.length]]));

      const found = JSON.parse(text(await client.callTool({ name: "orbytlink__find_tools", arguments: { query: "enroll leads in a campaign" } })));
      expect(found.tools[0].name).toBe("mail_orbyt__enroll_leads_in_campaign");
      // The schema the agent needs, without the $schema noise.
      expect(found.tools[0].inputSchema).toEqual({ type: "object", properties: { campaignId: { type: "string" }, leadIds: { type: "array", items: { type: "string" } } }, required: ["campaignId", "leadIds"] });
      expect(found.tools.length).toBeLessThanOrEqual(8);

      const scoped = JSON.parse(text(await client.callTool({ name: "orbytlink__find_tools", arguments: { query: "create", app: "crm" } })));
      expect(scoped.tools.map((t: any) => t.name)).toEqual(["crm__create_contact"]);
      const directory = JSON.parse(text(await client.callTool({ name: "orbytlink__find_tools", arguments: { app: "CRM" } })));
      expect(directory.tools.map((t: any) => t.name)).toHaveLength(crmTools.length);
      expect(directory.tools[0].inputSchema).toBeUndefined();

      const ran: any = await client.callTool({ name: "orbytlink__call_tool", arguments: { name: "mail_orbyt__enroll_leads_in_campaign", arguments: { campaignId: "c1", leadIds: ["l1"] } } });
      expect(text(ran)).toContain("ran enroll_leads_in_campaign");
      expect(services.call).toHaveBeenCalledWith(expect.objectContaining({ name: "Mail Orbyt" }), "enroll_leads_in_campaign", { campaignId: "c1", leadIds: ["l1"] }, undefined);
      // Unlisted tools can still be called by name, as workflows and older chats do.
      expect(text(await client.callTool({ name: "crm__log_call", arguments: {} }))).toContain("ran log_call");
    } finally {
      await client.close();
    }
  });
  it("explains bad discovery calls instead of failing silently", async () => {
    await addMany();
    const client = await connect((await token("search")).token);
    try {
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
      expect((await call("orbytlink__find_tools", {})).isError).toBe(true);
      expect(text(await call("orbytlink__find_tools", { query: "x", app: "Nope" }))).toContain("No connected app");
      expect(text(await call("orbytlink__find_tools", { query: "zzzqqq" }))).toContain("No tools match");
      expect(text(await call("orbytlink__call_tool", { name: "mail_orbyt__nope" }))).toContain("orbytlink__find_tools");
      expect((await call("orbytlink__call_tool", { name: "orbytlink__list_apps" })).isError).toBe(true);
      expect((await call("orbytlink__call_tool", { name: "crm__log_call", arguments: [] })).isError).toBe(true);
      expect(services.call).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("respects a token's choice, and disabled tools stay unreachable", async () => {
    await addMany();
    const all = await connect((await token("all")).token);
    try {
      expect(appTools((await all.listTools()).tools)).toHaveLength(mailTools.length + crmTools.length);
    } finally {
      await all.close();
    }
    const crm = (await api("/api/state")).data.connections.find((c: any) => c.name === "CRM");
    await api(`/api/connections/${crm.id}/tools`, { disabledTools: ["log_call"] }, "PUT");
    const search = await connect((await token("search")).token);
    try {
      const found = JSON.parse(text(await search.callTool({ name: "orbytlink__find_tools", arguments: { app: "CRM" } })));
      expect(found.tools.map((t: any) => t.name)).not.toContain("crm__log_call");
      expect(((await search.callTool({ name: "orbytlink__call_tool", arguments: { name: "crm__log_call" } })) as any).isError).toBe(true);
    } finally {
      await search.close();
    }
  });
  it("lists the most-used tools directly", async () => {
    await addMany();
    const client = await connect((await token()).token);
    try {
      for (let i = 0; i < 3; i++) await client.callTool({ name: "orbytlink__call_tool", arguments: { name: "mail_orbyt__list_campaigns" } });
      await client.callTool({ name: "orbytlink__call_tool", arguments: { name: "crm__list_deals" } });
      expect(appTools((await client.listTools()).tools)).toEqual(["mail_orbyt__list_campaigns"]);
    } finally {
      await client.close();
    }
  });
  it("lets the owner change a token's mode, and no one else", async () => {
    await addMany();
    const created = await token();
    expect(created.toolMode).toBe("auto");
    expect((await api("/api/tokens", { name: "Bad", toolMode: "everything" })).status).toBe(400);
    expect((await api(`/api/tokens/${created.id}`, { toolMode: "all" }, "PUT")).status).toBe(200);
    expect((await api("/api/state")).data.tokens.find((t: any) => t.id === created.id).toolMode).toBe("all");
    const client = await connect(created.token);
    try {
      expect(appTools((await client.listTools()).tools)).toHaveLength(mailTools.length + crmTools.length);
    } finally {
      await client.close();
    }
    const other = await register("someone-else@example.invalid");
    expect((await api(`/api/tokens/${created.id}`, { toolMode: "search" }, "PUT", other)).status).toBe(404);
    // A token cannot change itself.
    const headers = { Authorization: `Bearer ${created.token}` };
    expect((await inject(app, { url: `/api/tokens/${created.id}`, method: "PUT", headers, body: { toolMode: "search" } })).status).toBe(403);
  });
});
