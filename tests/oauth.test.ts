import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "internal.evil.test" ? "10.0.0.5" : "93.184.216.34", family: 4 }]),
}));
import { createApp } from "../server/app";
import { credentialFor } from "../server/oauth";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let store: Store, app: ReturnType<typeof createApp>["app"], cookie: string, workspace: string;
const services: ServiceAdapters = {
  test: vi.fn(async () => ({ protocol: "mcp" as const, tools: [{ name: "ping", inputSchema: { type: "object" } }] })),
  call: vi.fn(),
};
const request = (url: string, body?: unknown, session = cookie, method = body ? "POST" : "GET") =>
  inject(app, { url, body, method, headers: { Cookie: session } });
const cookieOf = (r: any, name: string) =>
  ([] as string[]).concat(r.headers["set-cookie"] || []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`))!;

const google = {
  name: "Google Drive",
  endpoint: "https://drivemcp.googleapis.com/mcp/v1",
  auth: "oauth",
  clientSecret: "client-secret-value",
  oauth: {
    mode: "manual",
    clientId: "client-1.apps.googleusercontent.com",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    authParams: { access_type: "offline", prompt: "consent" },
  },
};
let fetchCalls: { url: string; body: URLSearchParams; headers: Headers }[];
function mockProvider(
  handler: (url: string, body: URLSearchParams) => Response | undefined = () => undefined,
) {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = new URLSearchParams(typeof init.body === "string" && !init.body.startsWith("{") ? init.body : "");
      fetchCalls.push({ url, body, headers: new Headers(init.headers) });
      const custom = handler(url, body);
      if (custom) return custom;
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json(
          body.get("grant_type") === "refresh_token"
            ? { access_token: "access-2", expires_in: 3600 }
            : { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "drive.readonly" },
        );
      return new Response("not found", { status: 404 });
    }),
  );
}
async function addConnection(body: any = google) {
  const r = await request("/api/connections", body);
  expect(r.status).toBe(200);
  return r.data.id as string;
}
async function authorize(id: string) {
  const start = await request(`/api/connections/${id}/oauth/start`, {});
  expect(start.status).toBe(200);
  const url = new URL(start.data.url);
  const done = await inject(app, {
    url: `/api/oauth/callback?code=the-code&state=${url.searchParams.get("state")}`,
    headers: { Cookie: cookieOf(start, "orbyt_oauth") },
  });
  return { start, url, done };
}
beforeEach(async () => {
  process.env.OUTBOUND_HOSTS = "*";
  store = new Store(":memory:");
  app = createApp(store, services).app;
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" },
  });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  workspace = (await request("/api/state")).data.identity.workspace;
  vi.mocked(services.test).mockClear();
  mockProvider();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OUTBOUND_HOSTS;
});

it("runs the authorization code flow with PKCE and stores tokens only in the vault", async () => {
  const id = await addConnection();
  const { start, url, done } = await authorize(id);

  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("client_id")).toBe(google.oauth.clientId);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("scope")).toBe(google.oauth.scopes[0]);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3100/api/oauth/callback");
  expect(String(start.headers["set-cookie"])).toMatch(/HttpOnly/i);
  expect(String(start.headers["set-cookie"])).toMatch(/SameSite=Lax/i);

  expect(done.headers.location).toBe(`/#oauth-connected=${id}`);
  const exchange = fetchCalls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
  expect(exchange.body.get("grant_type")).toBe("authorization_code");
  expect(exchange.body.get("code")).toBe("the-code");
  expect(exchange.body.get("code_verifier")).toBeTruthy();
  expect(exchange.body.get("client_secret")).toBe("client-secret-value");

  expect(store.secret(workspace, `${id}:oauth-access`)).toBe("access-1");
  expect(store.secret(workspace, `${id}:oauth-refresh`)).toBe("refresh-1");
  const stored = JSON.stringify(store.db.prepare("SELECT * FROM secrets").all());
  expect(stored).not.toContain("access-1");
  const state = (await request("/api/state")).data;
  const c = state.connections[0];
  expect(c.oauthState.connected).toBe(true);
  expect(c.status).toBe("Not tested");
  expect(JSON.stringify(state)).not.toMatch(/access-1|refresh-1|client-secret-value/);

  // Testing uses the access token as a bearer credential.
  const tested = await request(`/api/connections/${id}/test`, {});
  expect(tested.data.status).toBe("Connected");
  expect(vi.mocked(services.test).mock.calls[0][1]).toBe("access-1");
});

it("rejects forged, missing, replayed-state and cancelled callbacks", async () => {
  const id = await addConnection();
  const start = await request(`/api/connections/${id}/oauth/start`, {});
  const state = new URL(start.data.url).searchParams.get("state");
  const cb = (qs: string, c?: string) => inject(app, { url: `/api/oauth/callback?${qs}`, headers: { Cookie: c ?? "" } });
  expect((await cb(`code=x&state=${state}`)).headers.location).toBe("/#oauth-error=oauth-failed");
  expect((await cb(`code=x&state=wrong`, cookieOf(start, "orbyt_oauth"))).headers.location).toBe("/#oauth-error=oauth-failed");
  const tampered = cookieOf(start, "orbyt_oauth").replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
  expect((await cb(`code=x&state=${state}`, tampered)).headers.location).toBe("/#oauth-error=oauth-failed");
  expect((await cb(`error=access_denied&state=${state}`, cookieOf(start, "orbyt_oauth"))).headers.location).toBe("/#oauth-error=oauth-cancelled");
  expect(fetchCalls.some((c) => c.url.includes("token"))).toBe(false);
  expect((await request("/api/state")).data.connections[0].oauthState.connected).toBeFalsy();
});

it("refreshes an expiring token once for concurrent calls and keeps the refresh token", async () => {
  const id = await addConnection();
  await authorize(id);
  const row = store.get(workspace, "connections", id);
  store.put(workspace, "connections", { ...row, oauthState: { ...row.oauthState, expiresAt: Date.now() - 1000 } });
  const c = store.get(workspace, "connections", id);
  const tokens = await Promise.all([credentialFor(store, workspace, c), credentialFor(store, workspace, c), credentialFor(store, workspace, c)]);
  expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
  expect(fetchCalls.filter((f) => f.body.get("grant_type") === "refresh_token")).toHaveLength(1);
  expect(store.secret(workspace, `${id}:oauth-refresh`)).toBe("refresh-1");
  const fresh = store.get(workspace, "connections", id);
  expect(fresh.oauthState.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000);
  expect(await credentialFor(store, workspace, fresh)).toBe("access-2");
});

it("takes the connection offline when the grant is revoked", async () => {
  const id = await addConnection();
  await authorize(id);
  await request(`/api/connections/${id}/test`, {});
  const row = store.get(workspace, "connections", id);
  store.put(workspace, "connections", { ...row, oauthState: { ...row.oauthState, expiresAt: Date.now() - 1000 } });
  mockProvider((url) => (url.includes("oauth2.googleapis.com") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : undefined));
  await expect(credentialFor(store, workspace, store.get(workspace, "connections", id))).rejects.toThrow(/Authorization expired/);
  const after = store.get(workspace, "connections", id);
  expect(after.status).toBe("Error");
  expect(after.oauthState.connected).toBe(false);
  expect(store.secret(workspace, `${id}:oauth-access`)).toBeUndefined();
  expect((await request("/api/state")).data.gatewayTools).toEqual([]);
  // A transient failure does not sign the app out.
  const id2 = await addConnection({ ...google, name: "Second" });
  mockProvider();
  await authorize(id2);
  const r2 = store.get(workspace, "connections", id2);
  store.put(workspace, "connections", { ...r2, oauthState: { ...r2.oauthState, expiresAt: Date.now() - 1000 } });
  mockProvider(() => new Response("oops", { status: 503 }));
  await expect(credentialFor(store, workspace, store.get(workspace, "connections", id2))).rejects.toThrow("Could not refresh authorization");
  expect(store.get(workspace, "connections", id2).oauthState.connected).toBe(true);
});

it("needs authorization before a test, and says so", async () => {
  const id = await addConnection();
  const r = await request(`/api/connections/${id}/test`, {});
  expect(r.data.status).toBe("Error");
  expect(r.data.error).toBe("Authorization required. Connect this app first.");
  expect(services.test).not.toHaveBeenCalled();
});

it("discovers the server's OAuth metadata and registers a client once", async () => {
  const handler = (url: string) => {
    if (url === "https://mcp.notion.example/.well-known/oauth-protected-resource/mcp")
      return Response.json({ authorization_servers: ["https://auth.notion.example"] });
    if (url === "https://auth.notion.example/.well-known/oauth-authorization-server")
      return Response.json({
        authorization_endpoint: "https://auth.notion.example/authorize",
        token_endpoint: "https://auth.notion.example/token",
        registration_endpoint: "https://auth.notion.example/register",
        code_challenge_methods_supported: ["S256"],
      });
    if (url === "https://auth.notion.example/register") return Response.json({ client_id: "dcr-client-9" });
    if (url === "https://auth.notion.example/token") return Response.json({ access_token: "n-access", refresh_token: "n-refresh", expires_in: 3600 });
    return undefined;
  };
  mockProvider(handler);
  const id = await addConnection({ name: "Notion", endpoint: "https://mcp.notion.example/mcp", auth: "oauth" });
  const first = await authorize(id);
  expect(first.url.origin + first.url.pathname).toBe("https://auth.notion.example/authorize");
  expect(first.url.searchParams.get("client_id")).toBe("dcr-client-9");
  expect(first.url.searchParams.get("resource")).toBe("https://mcp.notion.example/mcp");
  const registration = fetchCalls.find((c) => c.url.endsWith("/register"))!;
  expect(registration).toBeTruthy();
  expect(first.done.headers.location).toBe(`/#oauth-connected=${id}`);
  expect(store.secret(workspace, `${id}:oauth-access`)).toBe("n-access");

  await authorize(id);
  expect(fetchCalls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
});

it("refuses discovery that points at private or non-allowlisted hosts", async () => {
  mockProvider((url) =>
    url.includes("/.well-known/oauth-authorization-server")
      ? Response.json({
          authorization_endpoint: "https://evil.example/authorize",
          token_endpoint: "https://internal.evil.test/token",
          registration_endpoint: "https://internal.evil.test/register",
        })
      : undefined,
  );
  const id = await addConnection({ name: "Sneaky", endpoint: "https://mcp.sneaky.example/mcp", auth: "oauth" });
  const r = await request(`/api/connections/${id}/oauth/start`, {});
  expect(r.status).toBe(409);
  expect(r.data.error).toMatch(/Private and reserved|not allowed/);
  expect(fetchCalls.some((c) => c.url.includes("internal.evil.test"))).toBe(false);

  process.env.OUTBOUND_HOSTS = "mcp.sneaky.example";
  const r2 = await request(`/api/connections/${id}/oauth/start`, {});
  expect(r2.status).toBe(409);
});

it("lets only admins connect apps, and removes tokens with the connection", async () => {
  const id = await addConnection();
  await authorize(id);
  expect((await request(`/api/connections/${id}/oauth/start`, {}, "")).status).toBe(401);
  expect(store.secret(workspace, `${id}:oauth-refresh`)).toBe("refresh-1");

  const gone = await request(`/api/connections/${id}`, undefined, cookie, "DELETE");
  expect(gone.status).toBe(200);
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE workspace=?").get(workspace)).toEqual({ n: 0 });
});

it("disconnecting forgets the tokens; changing the client forgets them too", async () => {
  const id = await addConnection();
  await authorize(id);
  await request(`/api/connections/${id}/test`, {});
  expect((await request(`/api/connections/${id}/oauth/disconnect`, {})).status).toBe(200);
  const c = store.get(workspace, "connections", id);
  expect(c).toMatchObject({ status: "Not tested", tools: [] });
  expect(c.oauthState.connected).toBe(false);
  expect(store.secret(workspace, `${id}:oauth-access`)).toBeUndefined();
  expect(store.secret(workspace, `${id}:oauth-client`)).toBe("client-secret-value");

  mockProvider();
  await authorize(id);
  const edited = await request(`/api/connections/${id}`, { ...google, clientSecret: undefined, oauth: { ...google.oauth, clientId: "other-client" } }, cookie, "PUT");
  expect(edited.status).toBe(200);
  expect(store.secret(workspace, `${id}:oauth-access`)).toBeUndefined();
  expect(store.secret(workspace, `${id}:oauth-client`)).toBeUndefined();
  expect(edited.data.oauthState).toBeUndefined();
  expect(edited.data.hasClientSecret).toBe(false);
});

it("validates OAuth settings and refuses to override the gateway's own parameters", async () => {
  const bad = (patch: any) => request("/api/connections", { ...google, ...patch });
  expect((await bad({ oauth: { ...google.oauth, clientId: "" } })).status).toBe(400);
  expect((await bad({ oauth: { ...google.oauth, tokenUrl: "http://insecure.example/token" } })).status).toBe(400);
  expect((await bad({ oauth: { ...google.oauth, authParams: { state: "fixed" } } })).status).toBe(400);
  expect((await bad({ oauth: { ...google.oauth, authParams: { redirect_uri: "https://evil.example" } } })).status).toBe(400);
  expect((await bad({ endpoint: "" })).status).toBe(400);
});

it("sends Slack-style tokens correctly: user_scope, basic auth, nested user token", async () => {
  mockProvider((url) =>
    url === "https://slack.com/api/oauth.v2.user.access"
      ? Response.json({ ok: true, authed_user: { access_token: "xoxp-1" } })
      : undefined,
  );
  const id = await addConnection({
    name: "Slack",
    endpoint: "https://mcp.slack.com/mcp",
    auth: "oauth",
    clientSecret: "slack-secret",
    oauth: {
      mode: "manual",
      clientId: "123.456",
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
      scopes: ["search:read.public", "chat:write"],
      scopeParam: "user_scope",
      tokenAuth: "basic",
    },
  });
  const { url, done } = await authorize(id);
  expect(url.searchParams.get("user_scope")).toBe("search:read.public chat:write");
  expect(url.searchParams.has("scope")).toBe(false);
  const call = fetchCalls.find((c) => c.url.includes("oauth.v2.user.access"))!;
  expect(call.headers.get("authorization")).toBe(`Basic ${Buffer.from("123.456:slack-secret").toString("base64")}`);
  expect(call.body.has("client_secret")).toBe(false);
  expect(done.headers.location).toBe(`/#oauth-connected=${id}`);
  expect(store.secret(workspace, `${id}:oauth-access`)).toBe("xoxp-1");
  // A provider that says ok:false is a failure even with HTTP 200.
  mockProvider((url) => (url.includes("oauth.v2.user.access") ? Response.json({ ok: false, error: "invalid_code" }) : undefined));
  expect((await authorize(id)).done.headers.location).toBe("/#oauth-error=oauth-failed");
});
