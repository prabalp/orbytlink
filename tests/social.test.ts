import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { connectApp } from "../server/connect";
import { authorizeUrl, providerById } from "../server/social";
import { inject } from "./inject";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let store: Store, app: ReturnType<typeof createApp>["app"], cookie: string, workspace: string;
const services: ServiceAdapters = { test: vi.fn(), call: vi.fn() };
const request = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, body, method, headers: { Cookie: cookie } });
const cookieOf = (r: any, name: string) => ([] as string[]).concat(r.headers["set-cookie"] || []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`))!;
const ENV = ["LINKEDIN", "FACEBOOK", "X"];

let calls: { url: string; method: string; body: string; headers: Headers }[];
let reply: (url: string, init: RequestInit) => Response | undefined;
beforeEach(async () => {
  // Social hosts are trusted by the server: they work even with no OUTBOUND_HOSTS at all.
  delete process.env.OUTBOUND_HOSTS;
  for (const e of ENV) Object.assign(process.env, { [`${e}_CLIENT_ID`]: `${e.toLowerCase()}-id`, [`${e}_CLIENT_SECRET`]: `${e.toLowerCase()}-secret` });
  store = new Store(":memory:");
  app = createApp(store, services).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  workspace = (await request("/api/state")).data.identity.workspace;
  calls = [];
  reply = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || "GET", body: typeof init.body === "string" ? init.body : "", headers: new Headers(init.headers) });
      return reply(url, init) ?? new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const e of ENV) for (const k of ["CLIENT_ID", "CLIENT_SECRET"]) delete process.env[`${e}_${k}`];
});
async function connect(provider: string) {
  const start = await request(`/api/channels/${provider}/start`, {});
  expect(start.status).toBe(200);
  const url = new URL(start.data.url);
  const done = await inject(app, { url: `/api/oauth/callback?code=the-code&state=${url.searchParams.get("state")}`, headers: { Cookie: cookieOf(start, "orbyt_oauth") } });
  return { url, done };
}

it("builds each platform's sign-in link the way that platform wants it", () => {
  const li = new URL(authorizeUrl(providerById("linkedin")!, "https://app.example/api/oauth/callback", "s", "c"));
  expect(li.searchParams.get("client_id")).toBe("linkedin-id");
  expect(li.searchParams.get("scope")).toBe("openid profile email w_member_social");
  expect(li.searchParams.has("code_challenge")).toBe(false);
  process.env.TIKTOK_CLIENT_ID = "tt";
  const tt = new URL(authorizeUrl(providerById("tiktok")!, "https://app.example/cb", "s", "c"));
  expect(tt.searchParams.get("client_key")).toBe("tt");
  expect(tt.searchParams.get("scope")).toContain("video.publish,");
  delete process.env.TIKTOK_CLIENT_ID;
  const x = new URL(authorizeUrl(providerById("x")!, "https://app.example/cb", "s", "c"));
  expect(x.searchParams.get("code_challenge")).toBe("c");
  expect(new URL(authorizeUrl(providerById("reddit")!, "https://a.example/cb", "s", "c")).searchParams.get("duration")).toBe("permanent");
});

it("signs in to Search Console with the YouTube Google client and only the read-only scope", () => {
  process.env.YOUTUBE_CLIENT_ID = "yt-id";
  const gsc = new URL(authorizeUrl(providerById("google-search-console")!, "https://app.example/cb", "s", "c"));
  delete process.env.YOUTUBE_CLIENT_ID;
  expect(gsc.searchParams.get("client_id")).toBe("yt-id");
  expect(gsc.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
  expect(gsc.searchParams.get("access_type")).toBe("offline");
});

it("connects a LinkedIn account in one sign-in and calls its API with the token, which no one sees", async () => {
  reply = (url) => {
    if (url === "https://www.linkedin.com/oauth/v2/accessToken") return Response.json({ access_token: "li-token", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    if (url === "https://api.linkedin.com/v2/userinfo") return Response.json({ sub: "abc123", name: "Alice Doe", email: "alice@example.invalid" });
    if (url === "https://api.linkedin.com/rest/posts") return new Response(null, { status: 201 });
  };
  const { url, done } = await connect("linkedin");
  expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
  expect(done.headers.location).toBe("/#channel-connected=linkedin~1");
  const exchange = calls.find((c) => c.url.endsWith("/accessToken"))!;
  expect(new URLSearchParams(exchange.body).get("client_secret")).toBe("linkedin-secret");
  expect(new URLSearchParams(exchange.body).has("code_verifier")).toBe(false);

  const state = (await request("/api/state")).data;
  const a = state.apis[0];
  expect(a).toMatchObject({ name: "LinkedIn · Alice Doe", baseUrl: "https://api.linkedin.com", access: "write", hasKey: true, channel: { provider: "linkedin", accountId: "abc123" } });
  expect(a.description).toContain("urn:li:person:abc123");
  expect(JSON.stringify(state)).not.toContain("li-token");
  expect(state.channels.find((c: any) => c.id === "linkedin")).toMatchObject({ configured: true, accounts: 1 });

  const post = await request(`/api/apis/${a.id}/request`, { method: "POST", path: "/rest/posts", body: { author: "urn:li:person:abc123", commentary: "Hi" } });
  expect(post.data.status).toBe(201);
  const sent = calls.find((c) => c.url === "https://api.linkedin.com/rest/posts")!;
  expect(sent.headers.get("authorization")).toBe("Bearer li-token");
  expect(sent.headers.get("linkedin-version")).toMatch(/^\d{6}$/);

  // Signing in again updates the same account instead of adding another.
  await connect("linkedin");
  expect((await request("/api/state")).data.apis).toHaveLength(1);
});

it("asks which Search Console properties to connect when a sign-in brings several, and connects only those", async () => {
  process.env.YOUTUBE_CLIENT_ID = "yt-id";
  process.env.YOUTUBE_CLIENT_SECRET = "yt-secret";
  reply = (url) => {
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "g-token", refresh_token: "g-refresh", expires_in: 3600 });
    if (url === "https://www.googleapis.com/webmasters/v3/sites")
      return Response.json({ siteEntry: [{ siteUrl: "sc-domain:one.example", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:two.example", permissionLevel: "siteFullUser" }] });
  };
  const { done } = await connect("google-search-console");
  const id = decodeURIComponent(String(done.headers.location).match(/^\/#channel-choose=(.+)$/)![1]);
  expect((await request("/api/state")).data.apis).toHaveLength(0);
  const choices = (await request(`/api/channels/pending/${id}`)).data;
  expect(choices.accounts.map((a: any) => a.id)).toEqual(["sc-domain:one.example", "sc-domain:two.example"]);
  expect(JSON.stringify(choices)).not.toContain("g-token");
  expect((await request(`/api/channels/pending/${id}`, { accounts: [] })).status).toBe(400);
  expect((await request(`/api/channels/pending/${id}`, { accounts: ["sc-domain:two.example"] })).data).toEqual({ connected: 1 });
  const apis = (await request("/api/state")).data.apis;
  expect(apis.map((a: any) => a.name)).toEqual(["Google Search Console · sc-domain:two.example"]);
  expect((await request(`/api/channels/pending/${id}`)).status).toBe(410);
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
});

it("turns a Facebook sign-in into one account per Page, each with its own Page token", async () => {
  reply = (url) => {
    if (url.startsWith("https://graph.facebook.com/v23.0/oauth/access_token?")) {
      const q = new URL(url).searchParams;
      return Response.json(q.get("grant_type") === "fb_exchange_token" ? { access_token: "user-long", expires_in: 5184000 } : { access_token: "user-short", expires_in: 3600 });
    }
    if (url.startsWith("https://graph.facebook.com/v23.0/me/accounts")) return Response.json({ data: [{ id: "111", name: "Cafe", access_token: "page-1" }, { id: "222", name: "Shop", access_token: "page-2" }] });
    if (url.startsWith("https://graph.facebook.com/v23.0/222/feed")) return Response.json({ id: "222_9" });
  };
  const { done } = await connect("facebook");
  expect(done.headers.location).toBe("/#channel-connected=facebook~2");
  expect(calls.some((c) => c.url.includes("fb_exchange_token=user-short"))).toBe(true);
  const apis = (await request("/api/state")).data.apis;
  expect(apis.map((a: any) => a.name).sort()).toEqual(["Facebook Pages · Cafe", "Facebook Pages · Shop"]);
  const shop = apis.find((a: any) => a.name.endsWith("Shop"));
  expect(shop.channel.expiresAt).toBeNull();
  const r = await request(`/api/apis/${shop.id}/request`, { method: "POST", path: "/222/feed", body: { message: "Open today" } });
  expect(r.data.body).toEqual({ id: "222_9" });
  const sent = calls.find((c) => c.url.startsWith("https://graph.facebook.com/v23.0/222/feed"))!;
  expect(new URL(sent.url).searchParams.get("access_token")).toBe("page-2");
  expect(sent.body).toBe("message=Open+today");
});

it("renews a lapsing token before a call, and asks for a reconnect once the grant is revoked", async () => {
  let refreshes = 0;
  reply = (url, init) => {
    if (url === "https://api.x.com/2/oauth2/token") {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "authorization_code") return Response.json({ access_token: "x-1", refresh_token: "r-1", expires_in: 60 });
      refreshes++;
      return refreshes === 1 ? Response.json({ access_token: "x-2", refresh_token: "r-2", expires_in: 60 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url === "https://api.x.com/2/users/me") return Response.json({ data: { id: "42", name: "Alice", username: "alice" } });
    if (url === "https://api.x.com/2/tweets") return Response.json({ data: { id: "1" } }, { status: 201 });
  };
  const { url } = await connect("x");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const exchange = calls.find((c) => c.url === "https://api.x.com/2/oauth2/token")!;
  expect(exchange.headers.get("authorization")).toBe(`Basic ${Buffer.from("x-id:x-secret").toString("base64")}`);
  expect(new URLSearchParams(exchange.body).get("code_verifier")).toBeTruthy();
  const a = (await request("/api/state")).data.apis[0];

  // The token has under 5 minutes left, so it's renewed first.
  await request(`/api/apis/${a.id}/request`, { method: "POST", path: "/tweets", body: { text: "hi" } });
  expect(calls.filter((c) => c.url === "https://api.x.com/2/tweets").at(-1)!.headers.get("authorization")).toBe("Bearer x-2");
  expect(store.secret(workspace, `${a.id}:oauth-refresh`)).toBe("r-2");

  const revoked = await request(`/api/apis/${a.id}/request`, { method: "POST", path: "/tweets", body: { text: "again" } });
  expect(revoked.status).toBe(409);
  expect(revoked.data.error).toMatch(/reconnected/);
  const after = (await request("/api/state")).data.apis[0];
  expect(after).toMatchObject({ hasKey: false, channel: { error: "Reconnect this account." } });
});

it("lets only the name, access and on/off of a social account change; the rest comes from its sign-in", async () => {
  reply = (url) => {
    if (url.endsWith("/accessToken")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (url.endsWith("/v2/userinfo")) return Response.json({ sub: "s1", name: "A" });
  };
  await connect("linkedin");
  const a = (await request("/api/state")).data.apis[0];
  const r = await request(`/api/apis/${a.id}`, { access: "read", baseUrl: "https://evil.example" }, "PUT");
  expect(r.data).toMatchObject({ access: "read", baseUrl: "https://api.linkedin.com" });
});

it("refuses a platform the server hasn't set up, and connect_app hands agents a one-click link", async () => {
  const r = await request("/api/channels/pinterest/start", {});
  expect(r.status).toBe(409);
  const out: any = connectApp(store, workspace, true, { app: "LinkedIn" });
  expect(out.results[0]).toMatchObject({ app: "LinkedIn", status: "Not connected", link: "http://127.0.0.1:3100/#social=linkedin" });
  expect((connectApp(store, workspace, true, { app: "Pinterest" }) as any).results[0].status).toMatch(/isn't available/);
  expect((connectApp(store, workspace, true, { app: "twitter" }) as any).results[0].app).toBe("X");
});

it("connects Instagram through Facebook Login with the Facebook app's keys, one account per linked Page", async () => {
  // No INSTAGRAM_* keys: Instagram borrows the Facebook app's.
  expect(process.env.INSTAGRAM_CLIENT_ID).toBeUndefined();
  reply = (url) => {
    if (url.startsWith("https://graph.facebook.com/v23.0/oauth/access_token?")) {
      const q = new URL(url).searchParams;
      return Response.json(q.get("grant_type") === "fb_exchange_token" ? { access_token: "user-long", expires_in: 5184000 } : { access_token: "user-short", expires_in: 3600 });
    }
    if (url.startsWith("https://graph.facebook.com/v23.0/me/accounts")) {
      expect(new URL(url).searchParams.get("fields")).toContain("instagram_business_account{id,username,name}");
      return Response.json({
        data: [
          { id: "111", name: "Cafe", access_token: "page-1", instagram_business_account: { id: "17841", username: "cafe.ig", name: "Cafe IG" } },
          { id: "222", name: "No Instagram", access_token: "page-2" },
        ],
      });
    }
    if (url.startsWith("https://graph.facebook.com/v23.0/17841/media")) return Response.json({ id: "container-1" });
  };
  const { url, done } = await connect("instagram");
  expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
  expect(url.searchParams.get("client_id")).toBe("facebook-id");
  expect(url.searchParams.get("scope")).toContain("instagram_content_publish");
  expect(done.headers.location).toBe("/#channel-connected=instagram~1");
  const apis = (await request("/api/state")).data.apis;
  expect(apis).toHaveLength(1);
  expect(apis[0]).toMatchObject({ name: "Instagram · Cafe IG", baseUrl: "https://graph.facebook.com/v23.0", channel: { provider: "instagram", accountId: "17841", handle: "@cafe.ig", expiresAt: null } });
  const r = await request(`/api/apis/${apis[0].id}/request`, { method: "POST", path: "/17841/media", body: { image_url: "https://public.example/p.jpg", caption: "Hi" } });
  expect(r.data.body).toEqual({ id: "container-1" });
  const sent = calls.find((c) => c.url.startsWith("https://graph.facebook.com/v23.0/17841/media"))!;
  expect(new URL(sent.url).searchParams.get("access_token")).toBe("page-1");
});

it("says what to do when no Page with a linked Instagram account was shared", async () => {
  reply = (url) => {
    if (url.startsWith("https://graph.facebook.com/v23.0/oauth/access_token?")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (url.startsWith("https://graph.facebook.com/v23.0/me/accounts")) return Response.json({ data: [{ id: "222", name: "Plain Page", access_token: "p" }] });
  };
  const { done } = await connect("instagram");
  expect(done.headers.location).toMatch(/^\/#oauth-error=channel-empty~/);
});

// A connected account is a stored API, not an MCP connection: discovery must still say it is there.
it("tells agents a connected social account is connected, wherever they look", async () => {
  reply = (url) => {
    if (url.includes("/oauth/v2/accessToken")) return Response.json({ access_token: "li-token", expires_in: 5_184_000 });
    if (url.endsWith("/v2/userinfo")) return Response.json({ sub: "abc", name: "Tripty Example" });
  };
  await connect("linkedin");
  const out: any = connectApp(store, workspace, true, { app: "LinkedIn posting" });
  expect(out.results[0]).toMatchObject({ app: "LinkedIn", status: "Already connected" });
  expect((connectApp(store, workspace, true, { app: "linkedin company page" }) as any).results[0].app).toBe("LinkedIn Page");
  expect((connectApp(store, workspace, true, { app: "slack threads" }) as any).results.every((r: any) => r.type !== "Social account")).toBe(true);

  const token = (await request("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token as string;
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
  const text = async (name: string, args: Record<string, unknown>) => (((await client.callTool({ name, arguments: args })).content as any)[0].text as string);
  const apps = JSON.parse(await text("orbytlink__list_apps", {}));
  expect(apps.apis).toEqual([{ api: "linkedin_tripty_example", name: "LinkedIn · Tripty Example", access: "read and write" }]);
  const byApp = JSON.parse(await text("orbytlink__find_tools", { app: "LinkedIn" }));
  expect(byApp).toMatchObject({ connected: true, apis: [{ api: "linkedin_tripty_example" }] });
  const byQuery = JSON.parse(await text("orbytlink__find_tools", { query: "publish a post on linkedin" }));
  expect(byQuery.apis[0].api).toBe("linkedin_tripty_example");
  expect(byQuery.next).toMatch(/orbytlink__api_request/);
  // With few tools everything is listed directly, the API tools among them.
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("orbytlink__api_request");
});
