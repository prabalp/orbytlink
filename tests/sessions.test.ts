import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { adapters, closeMcpSessions, openMcpSessions } from "../server/adapters.js";

// A real MCP server behind a stubbed fetch: it counts sessions and can forget them.
let sessions: Map<string, WebStandardStreamableHTTPServerTransport>;
let initializes: number, calls: number, authSeen: string[];
let failNext: "network" | null;
async function upstream(input: string | URL, init: RequestInit = {}) {
  const request = new Request(input, init);
  authSeen.push(request.headers.get("authorization") || "");
  const sid = request.headers.get("mcp-session-id");
  if (sid) {
    const transport = sessions.get(sid);
    // The server restarted or expired the session.
    if (!transport) return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }), { status: 404 });
    if (failNext === "network" && request.method === "POST") {
      failNext = null;
      throw new TypeError("fetch failed");
    }
    return transport.handleRequest(request);
  }
  const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    calls++;
    return { content: [{ type: "text", text: `echo ${JSON.stringify(r.params.arguments)}` }] };
  });
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      initializes++;
      sessions.set(id, transport);
    },
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
const connection = (over: Record<string, unknown> = {}) => ({
  id: "mail",
  name: "Mail",
  kind: "mcp",
  protocol: "mcp",
  endpoint: "https://mcp.example.com/mcp",
  auth: "bearer",
  enabled: true,
  tools: [{ name: "echo", inputSchema: { type: "object" } }],
  ...over,
});
const text = (r: any) => r.content[0].text;

beforeEach(() => {
  process.env.OUTBOUND_HOSTS = "mcp.example.com";
  sessions = new Map();
  initializes = 0;
  calls = 0;
  authSeen = [];
  failNext = null;
  vi.stubGlobal("fetch", vi.fn(upstream));
});
afterEach(() => {
  closeMcpSessions();
  vi.unstubAllGlobals();
});

describe("MCP sessions for tool calls", () => {
  it("reuse one session across calls instead of a handshake each time", async () => {
    const c = connection();
    for (let i = 0; i < 3; i++) expect(text(await adapters.call(c, "echo", { i }, "secret-1"))).toBe(`echo {"i":${i}}`);
    expect(initializes).toBe(1);
    expect(calls).toBe(3);
    expect(openMcpSessions()).toBe(1);
  });
  it("share the session between concurrent calls", async () => {
    const c = connection();
    await Promise.all([1, 2, 3, 4].map((i) => adapters.call(c, "echo", { i }, "secret-1")));
    expect(initializes).toBe(1);
    expect(calls).toBe(4);
  });
  it("start a new session when the credential or endpoint config changes", async () => {
    await adapters.call(connection(), "echo", {}, "secret-1");
    await adapters.call(connection(), "echo", {}, "secret-2");
    expect(initializes).toBe(2);
    expect(authSeen.at(-1)).toBe("Bearer secret-2");
    await adapters.call(connection({ headers: { "X-Tenant": "b" } }), "echo", {}, "secret-2");
    expect(initializes).toBe(3);
    expect(openMcpSessions()).toBe(1);
  });
  it("reconnect and retry once when the server has forgotten the session", async () => {
    const c = connection();
    await adapters.call(c, "echo", {}, "s");
    sessions.clear();
    expect(text(await adapters.call(c, "echo", { again: true }, "s"))).toBe('echo {"again":true}');
    expect(initializes).toBe(2);
    expect(calls).toBe(2);
  });
  it("never retry a call that may have reached the server", async () => {
    const c = connection();
    await adapters.call(c, "echo", {}, "s");
    failNext = "network";
    await expect(adapters.call(c, "echo", { send: "email" }, "s")).rejects.toThrow();
    expect(calls).toBe(1);
    // The broken session is dropped; the next call opens a fresh one.
    expect(openMcpSessions()).toBe(0);
    await adapters.call(c, "echo", {}, "s");
    expect(initializes).toBe(2);
  });
  it("keep sessions separate per connection", async () => {
    await adapters.call(connection({ id: "a" }), "echo", {}, "s");
    await adapters.call(connection({ id: "b" }), "echo", {}, "s");
    expect(initializes).toBe(2);
    expect(openMcpSessions()).toBe(2);
  });
});
