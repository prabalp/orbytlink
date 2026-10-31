import { Ajv } from "ajv";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Row } from "./store.js";
// Every non-public range (RFC 6890 and successors). Only global unicast is reachable.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");
// Node's BlockList matches IPv4 rules against IPv4-mapped IPv6 and vice versa, so
// ::ffff:0:0/96 is handled by unwrapping the embedded address below instead.
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (!family) return false;
  // IPv4-mapped IPv6 hides an IPv4 destination; judge the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return !blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}
// OUTBOUND_HOSTS: exact hosts, "*.example.com" for subdomains, or "*" for any public host.
export function hostAllowed(hostname: string, list = process.env.OUTBOUND_HOSTS || "") {
  const host = hostname.toLowerCase();
  return list
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) =>
      rule === "*" ||
      rule === host ||
      (rule.startsWith("*.") && host.endsWith(rule.slice(1)) && host.length > rule.length - 1),
    );
}
export async function safeEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !hostAllowed(u.hostname)
  )
    throw new Error(
      "Use an HTTPS endpoint without credentials or query parameters, on an OUTBOUND_HOSTS allowlisted host",
    );
  // An IP literal skips DNS; it must still be public.
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(literal)
    ? [{ address: literal }]
    : await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error("Private and reserved destinations are blocked");
  return u;
}
// Read at most `limit` bytes so an oversized upstream reply cannot exhaust memory.
export async function boundedText(r: Response, limit = 100000) {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function headers(c: Row, secret?: string): Record<string, string> {
  const extra: Record<string, string> = { ...(c.headers || {}) };
  if (c.auth === "none" || !c.auth) return extra;
  if (!secret) throw new Error("Authentication credential is missing");
  if (c.auth === "api-key") return { ...extra, [c.authHeader || "X-API-Key"]: secret };
  if (c.auth === "basic")
    return {
      ...extra,
      Authorization: `Basic ${Buffer.from(secret, "utf8").toString("base64")}`,
    };
  return { ...extra, Authorization: `Bearer ${secret}` };
}
export type Protocol = "mcp" | "api";
export interface ServiceAdapters {
  test(c: Row, secret?: string): Promise<{ protocol: Protocol; tools: any[] }>;
  call(
    c: Row,
    tool: string,
    args: Record<string, unknown>,
    secret?: string,
  ): Promise<unknown>;
}
// Connecting and discovery are quick; a tool call may legitimately run much longer.
const CONNECT_TIMEOUT = 15000;
export const CALL_TIMEOUT = Number(process.env.TOOL_TIMEOUT_MS) || 120000;
// Results bigger than this are cut down to their text, not rejected.
export const RESULT_LIMIT = 100000;
async function withMcp<T>(
  c: Row,
  secret: string | undefined,
  fn: (client: Client) => Promise<T>,
  timeout = CONNECT_TIMEOUT,
) {
  const endpoint = await safeEndpoint(c.endpoint);
  const auth = headers(c, secret);
  const guardedFetch = async (input: string | URL, init?: RequestInit) => {
    // SSE servers name their own message URL; keep it on the verified origin.
    if (new URL(String(input)).origin !== endpoint.origin)
      throw new Error("MCP server redirected to another origin");
    return fetch(input, {
      ...init,
      headers: (() => {
        const merged = new Headers(init?.headers);
        for (const [k, v] of Object.entries(auth)) merged.set(k, v);
        return merged;
      })(),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  };
  const attempt = async (transport: "streamable" | "sse") => {
    const client = new Client({ name: "orbytlink", version: "0.1.0" });
    const t =
      transport === "streamable"
        ? new StreamableHTTPClientTransport(endpoint, { fetch: guardedFetch })
        : new SSEClientTransport(endpoint, { fetch: guardedFetch });
    await client.connect(t, { timeout: CONNECT_TIMEOUT });
    return client;
  };
  // Streamable HTTP first, then the older SSE transport some servers still use.
  let client: Client;
  try {
    client = await attempt("streamable");
  } catch (error) {
    // A server that rejects the credential speaks Streamable HTTP; retrying over SSE only hides that.
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
      throw new Error(`Authorization ${error.code === 401 ? "required" : "denied"} by the server`);
    client = await attempt("sse");
  }
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
async function mcpTools(c: Row, secret?: string) {
  return withMcp(c, secret, async (client) => {
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { timeout: 10000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (tools.length > 500 || JSON.stringify(tools).length > 1000000)
        throw new Error("Tool registry exceeds discovery limits");
    } while (cursor);
    return tools;
  });
}
// The endpoint itself is always callable as GET, even with no declared operations.
const endpointRead = {
  name: "GET",
  method: "GET",
  path: "",
  description: "Read the endpoint",
};
export function apiOperations(c: Row): (ApiOperation & { description?: string })[] {
  const declared = (c.operations || []) as ApiOperation[];
  return declared.some((o) => o.name === "GET")
    ? declared
    : [endpointRead, ...declared];
}
type ApiOperation = { name: string; method: string; path?: string };
async function apiRequest(
  c: Row,
  operation: ApiOperation,
  args: Record<string, unknown>,
  secret?: string,
) {
  const base = await safeEndpoint(c.endpoint);
  const rest = { ...args };
  const path = String(operation.path || "").replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (_m, key: string) => {
      if (!(key in rest)) throw new Error(`Missing path input: ${key}`);
      const v = encodeURIComponent(String(rest[key]));
      delete rest[key];
      return v;
    },
  );
  const url = new URL(base.href.replace(/\/$/, "") + path);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname.replace(/\/$/, ""))
  )
    throw new Error("Operation path leaves the endpoint");
  const bodyless = operation.method === "GET" || operation.method === "DELETE";
  if (bodyless)
    for (const [k, v] of Object.entries(rest))
      if (v !== undefined && v !== null)
        url.searchParams.set(
          k,
          typeof v === "object" ? JSON.stringify(v) : String(v),
        );
  const r = await fetch(url, {
    method: operation.method,
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      ...(bodyless ? {} : { "Content-Type": "application/json" }),
      ...headers(c, secret),
    },
    body: bodyless ? undefined : JSON.stringify(rest),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const text = await boundedText(r);
  if (!r.ok) throw new Error(`API request failed with status ${r.status}`);
  if (r.headers.get("content-type")?.includes("json"))
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  return text;
}
async function apiProbe(c: Row, secret?: string) {
  const url = await safeEndpoint(c.endpoint);
  const r = await fetch(url, {
    method: "GET",
    headers: headers(c, secret),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  await r.body?.cancel();
  if (!r.ok) throw new Error("API verification failed");
  return apiOperations(c).map((o) => ({
    name: o.name,
    description: [`${o.method} ${o.path || "/"}`, o.description]
      .filter(Boolean)
      .join(" · "),
    inputSchema: { type: "object" },
  }));
}
export const adapters: ServiceAdapters = {
  async test(c, secret) {
    if (!c.endpoint) throw new Error("Endpoint is not configured");
    if (c.kind === "api")
      return { protocol: "api", tools: await apiProbe(c, secret) };
    if (c.kind === "mcp")
      return { protocol: "mcp", tools: await mcpTools(c, secret) };
    // Auto-detect: speak MCP if the server does, otherwise treat it as an HTTP API.
    try {
      return { protocol: "mcp", tools: await mcpTools(c, secret) };
    } catch {
      return { protocol: "api", tools: await apiProbe(c, secret) };
    }
  },
  async call(c, tool, args, secret) {
    if ((c.protocol || c.kind) === "api") {
      const operation = apiOperations(c).find((o) => o.name === tool);
      if (!operation) throw new Error("Operation is not declared");
      return apiRequest(c, operation, args, secret);
    }
    const definition = c.tools.find((t: any) => t.name === tool);
    if (!definition) throw new Error("Tool is not registered");
    const ajv = new Ajv({
      strict: false,
      allErrors: false,
      validateFormats: false,
    });
    if (!ajv.validate(definition.inputSchema || { type: "object" }, args))
      throw new Error("Tool inputs do not match its discovered schema");
    return withMcp(
      c,
      secret,
      async (client) => {
        const result = await client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: CALL_TIMEOUT },
        );
        // A tool-level error is a normal result; the client decides what to do with it.
        return truncateResult(result);
      },
      CALL_TIMEOUT,
    );
  },
};
// An oversized result keeps its text, cut to the limit with a note, so the agent can narrow its query.
export function truncateResult(result: any) {
  const size = JSON.stringify(result).length;
  if (size <= RESULT_LIMIT) return result;
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  const body = (text || JSON.stringify(result.structuredContent ?? result)).slice(0, RESULT_LIMIT - 300);
  return {
    content: [
      {
        type: "text",
        text: `${body}\n\n[Truncated by OrbytLink: the full result was ${Math.round(size / 1000)} KB. Ask for less, e.g. a narrower search or fewer items.]`,
      },
    ],
    ...(result?.isError ? { isError: true } : {}),
  };
}
