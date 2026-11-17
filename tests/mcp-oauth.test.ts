import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Store } from "../server/store";
import { createApp } from "../server/app";
import { redirectAllowed } from "../server/mcp-oauth";
import { inject } from "./inject";

let store: Store, app: ReturnType<typeof createApp>["app"], cookie: string;
const ORIGIN = "http://127.0.0.1:3100";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const request = (url: string, body?: unknown, headers: Record<string, string> = {}, method = body !== undefined ? "POST" : "GET") =>
  inject(app, { url, body, method, headers: { Cookie: cookie, ...headers } });
const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  inject(app, {
    url,
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const mcpList = (token: string) =>
  inject(app, {
    url: "/mcp",
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
  });
const registerClient = async (redirect = CALLBACK, extra: Record<string, unknown> = {}) =>
  (await request("/oauth/register", { client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", ...extra })).data;
// Walk the browser part: /oauth/authorize, then the console's consent answer.
async function approve(clientId: string, challenge: string, answer: Record<string, unknown> = { allow: true }) {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ORIGIN}/mcp`,
  });
  const start = await inject(app, { url: `/oauth/authorize?${qs}` });
  expect(start.status).toBe(302);
  const id = /#authorize=(.+)$/.exec(String(start.headers.location))![1];
  const done = await request(`/api/oauth/requests/${id}`, answer);
  return { id, done };
}
async function connectAgent(toolMode = "auto") {
  const c = await registerClient();
  const { verifier, challenge } = pkce();
  const { done } = await approve(c.client_id, challenge, { allow: true, toolMode });
  const code = new URL(done.data.redirect).searchParams.get("code")!;
  const tokens = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: c.client_id, redirect_uri: CALLBACK });
  return { client: c, tokens: tokens.data };
}

beforeEach(async () => {
  store = new Store(":memory:");
  app = createApp(store).app;
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    body: { name: "Prabal", email: "prabalp@example.invalid", password: "Correct-horse-ship-2026" },
  });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
afterEach(() => {
  store.db.close();
  vi.unstubAllEnvs();
});

describe("Agents sign in to /mcp with OAuth", () => {
  it("answers an anonymous /mcp call with a 401 that points to the sign-in metadata", async () => {
    const r = await inject(app, { url: "/mcp", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
    const bad = await inject(app, { url: "/mcp", method: "POST", body: {}, headers: { Authorization: "Bearer ol_nope" } });
    expect(bad.headers["www-authenticate"]).toContain('error="invalid_token"');
  });
  it("publishes protected-resource and authorization-server metadata", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await inject(app, { url: path });
      expect(r.data).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
      expect(r.headers["access-control-allow-origin"]).toBe("*");
    }
    const as = (await inject(app, { url: "/.well-known/oauth-authorization-server" })).data;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });
  it("lets browser-based clients preflight and call the OAuth endpoints from another origin", async () => {
    const pre = await inject(app, { url: "/oauth/token", method: "OPTIONS", headers: { Origin: "https://inspector.example" } });
    expect(pre.status).toBe(204);
    const reg = await request("/oauth/register", { redirect_uris: ["http://localhost:6274/oauth/callback"] }, { Origin: "https://inspector.example" });
    expect(reg.status).toBe(201);
    // The console's own API still refuses other origins.
    expect((await request("/api/tokens", { name: "x" }, { Origin: "https://evil.example" })).status).toBe(403);
  });
  it("registers clients but refuses unsafe redirect addresses", async () => {
    expect(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectAllowed("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://evil.example/cb", "https://x.example/cb#frag", "data:text/html,hi", "not a url"])
      expect(redirectAllowed(bad)).toBe(false);
    const r = await request("/oauth/register", { redirect_uris: ["http://evil.example/cb"] });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid_redirect_uri");
    const ok = await registerClient();
    expect(ok).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [CALLBACK] });
    expect(ok.client_id).toMatch(/^olc_/);
    expect(ok.client_secret).toBeUndefined();
  });
  it("runs the whole flow: approve, exchange with PKCE, call /mcp, refresh, revoke", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const { id, done } = await approve(c.client_id, challenge, { allow: true, toolMode: "search" });
    // An answered request is gone: it can't be approved twice.
    expect((await inject(app, { url: `/api/oauth/requests/${id}` })).status).toBe(404);
    const back = new URL(done.data.redirect);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    const code = back.searchParams.get("code")!;
    // A wrong verifier fails, and the code is spent either way.
    const wrong = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: c.client_id });
    expect(wrong.data.error).toBe("invalid_grant");
    const replay = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: c.client_id });
    expect(replay.data.error).toBe("invalid_grant");

    const { client: agent, tokens } = await connectAgent("search");
    const clientId = agent.client_id;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    const list = await mcpList(tokens.access_token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).toContain("find_tools");

    // Listed alongside gateway tokens, with the tool mode chosen on the consent screen.
    const state = (await request("/api/state")).data;
    const grant = state.tokens.find((t: any) => t.signedIn);
    expect(grant).toMatchObject({ name: "Claude", toolMode: "search", signedIn: true });

    // Refreshing rotates both tokens; the old ones stop working.
    const next = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(next.status).toBe(200);
    expect(next.data.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpList(tokens.access_token)).status).toBe(401);
    expect((await mcpList(next.data.access_token)).status).toBe(200);
    expect((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })).data.error).toBe("invalid_grant");

    // Revoking from the console ends the connection, refresh token included.
    await request(`/api/tokens/${grant.id}`, {}, {}, "DELETE");
    expect((await mcpList(next.data.access_token)).status).toBe(401);
    expect((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: next.data.refresh_token, client_id: clientId })).data.error).toBe("invalid_grant");
  });
  it("expires access tokens after an hour but keeps the grant refreshable", async () => {
    const { client, tokens } = await connectAgent();
    store.db.prepare("UPDATE access_tokens SET access_expires=? WHERE client_id=?").run(Date.now() - 1, client.client_id);
    expect((await mcpList(tokens.access_token)).status).toBe(401);
    const next = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect((await mcpList(next.data.access_token)).status).toBe(200);
  });
  it("sends a declined request back to the agent as access_denied", async () => {
    const c = await registerClient();
    const { done } = await approve(c.client_id, pkce().challenge, { allow: false });
    const back = new URL(done.data.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect((await request("/api/state")).data.tokens).toHaveLength(0);
  });
  it("never redirects to an unregistered address, and rejects requests without PKCE", async () => {
    const c = await registerClient();
    const other = await inject(app, { url: `/oauth/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${pkce().challenge}&code_challenge_method=S256` });
    expect(other.headers.location).toBe("/#authorize-error=bad-redirect");
    const unknown = await inject(app, { url: "/oauth/authorize?response_type=code&client_id=olc_nope" });
    expect(unknown.headers.location).toBe("/#authorize-error=unknown-client");
    const plain = await inject(app, { url: `/oauth/authorize?response_type=code&client_id=${c.client_id}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=s` });
    const u = new URL(String(plain.headers.location));
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("state")).toBe("s");
  });
  it("accepts loopback redirects on any port for desktop and CLI clients", async () => {
    const c = await registerClient("http://127.0.0.1:1234/callback");
    const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: "http://127.0.0.1:5678/callback", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(String((await inject(app, { url: `/oauth/authorize?${qs}` })).headers.location)).toMatch(/^\/#authorize=/);
  });
  it("only lets a signed-in person approve, and only for a workspace they belong to", async () => {
    const c = await registerClient();
    const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const id = /#authorize=(.+)$/.exec(String((await inject(app, { url: `/oauth/authorize?${qs}` })).headers.location))![1];
    expect((await inject(app, { url: `/api/oauth/requests/${id}` })).data).toEqual({ client: "Claude", destination: "claude.ai" });
    expect((await inject(app, { url: `/api/oauth/requests/${id}`, method: "POST", body: { allow: true } })).status).toBe(401);
    // A gateway token cannot approve on the person's behalf.
    const { tokens } = await connectAgent();
    expect((await inject(app, { url: `/api/oauth/requests/${id}`, method: "POST", body: { allow: true }, headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(403);
    expect((await request(`/api/oauth/requests/${id}`, { allow: true, workspace: "someone-else" })).status).toBe(403);
  });
  it("supports confidential clients that register for a secret", async () => {
    const c = await registerClient(CALLBACK, { token_endpoint_auth_method: "client_secret_basic" });
    expect(c.client_secret).toMatch(/^olcs_/);
    const { verifier, challenge } = pkce();
    const code = new URL((await approve(c.client_id, challenge)).done.data.redirect).searchParams.get("code")!;
    const fields = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK };
    expect((await form("/oauth/token", { ...fields, client_id: c.client_id })).status).toBe(401);
    const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64");
    const r = await form("/oauth/token", fields, { Authorization: `Basic ${basic}` });
    // A request the client fails to authenticate never reaches the code, so it still works here.
    expect(r.status).toBe(200);
    expect(r.data.access_token).toMatch(/^ol_/);
  });
});

// The MCP SDK's own OAuth client (what Claude Code and many agents use) against a real listener.
describe("with the MCP SDK's OAuth client", () => {
  let server: Server;
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  it("discovers, registers, signs in and lists tools using only the /mcp URL", async () => {
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv("APP_ORIGIN", origin);
    let info: any, saved: any, verifier = "", authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:9999/callback",
      clientMetadata: { client_name: "SDK agent", redirect_uris: ["http://127.0.0.1:9999/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      clientInformation: () => info,
      saveClientInformation: (i) => void (info = i),
      tokens: () => saved,
      saveTokens: (t) => void (saved = t),
      redirectToAuthorization: (u) => void (authUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };
    const mcp = `${origin}/mcp`;
    expect(await auth(provider, { serverUrl: mcp })).toBe("REDIRECT");
    // The person's browser: follow the authorize URL to the console, then approve there.
    const hop = await fetch(authUrl!, { redirect: "manual" });
    const id = /#authorize=(.+)$/.exec(hop.headers.get("location")!)![1];
    const approved = await fetch(`${origin}/api/oauth/requests/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ allow: true }),
    });
    const code = new URL((await approved.json()).redirect).searchParams.get("code")!;
    expect(await auth(provider, { serverUrl: mcp, authorizationCode: code })).toBe("AUTHORIZED");
    const client = new Client({ name: "sdk-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { authProvider: provider }));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
