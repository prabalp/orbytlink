import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "internal.evil.test" ? "10.0.0.5" : "93.184.216.34", family: 4 }]),
}));
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { inject } from "./inject";

const KEY = "sk_live_51Hsecretvalue9f2a";
const spec = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.billing.example/v1" }],
  paths: {
    "/invoices": { get: { summary: "List invoices" }, post: { summary: "Create an invoice" } },
    "/customers/{id}": { get: { summary: "Retrieve a customer" } },
  },
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let store: Store, app: ReturnType<typeof createApp>["app"], cookie: string, workspace: string;
let calls: { url: URL; init: RequestInit }[];
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) => inject(app, { url, method, headers: { Cookie: c }, body });
function provider() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/openapi.json") return Response.json(spec);
      if (url.pathname === "/openapi.yaml") return new Response("openapi: 3.0.0\npaths:\n  /things:\n    get:\n      summary: List things\n", { headers: { "content-type": "application/yaml" } });
      if (url.pathname === "/docs.html") return new Response("<html><head><script>evil()</script></head><body><h1>Billing API</h1><p>Use &amp; enjoy.</p></body></html>", { headers: { "content-type": "text/html" } });
      if (url.hostname === "billing.example" && url.pathname === "/") return new Response('<html><head><link rel="icon" href="/favicon-16.png"><link rel="apple-touch-icon" href="/brand.png"></head></html>', { headers: { "content-type": "text/html" } });
      if (url.hostname === "billing.example" && url.pathname === "/brand.png") return new Response(PNG, { headers: { "content-type": "application/octet-stream" } });
      if (url.hostname === "evil-logo.example" && url.pathname === "/") return Response.redirect("https://internal.evil.test/", 302);
      if (url.pathname.endsWith("/echo")) return Response.json({ seen: new Headers(init.headers).get("authorization"), query: url.search });
      return Response.json({ ok: true, path: url.pathname });
    }),
  );
}
const billing = (patch: Record<string, unknown> = {}) => ({
  name: "Billing",
  baseUrl: "https://api.billing.example/v1",
  docsUrl: "https://docs.billing.example/openapi.json",
  auth: "bearer",
  key: KEY,
  ...patch,
});
beforeEach(async () => {
  process.env.OUTBOUND_HOSTS = "*";
  store = new Store(":memory:");
  app = createApp(store).app;
  provider();
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  workspace = (await api("/api/state")).data.identity.workspace;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OUTBOUND_HOSTS;
});

it("stores the key encrypted and never returns it, only a hint", async () => {
  const saved = await api("/api/apis", billing());
  expect(saved.status).toBe(200);
  expect(saved.data).toMatchObject({ hasKey: true, keyHint: "9f2a", endpointCount: 3, docsFormat: "OpenAPI 3.1.0" });
  const state = JSON.stringify((await api("/api/state")).data);
  expect(state).not.toContain(KEY);
  expect(state).not.toContain("secretvalue");
  expect(JSON.stringify(store.db.prepare("SELECT * FROM secrets").all())).not.toContain(KEY);
  expect(store.secret(workspace, saved.data.id)).toBe(KEY);
  const docs = (await api(`/api/apis/${saved.data.id}/docs`)).data;
  expect(docs.endpoints).toContainEqual({ method: "POST", path: "/invoices", summary: "Create an invoice" });
});

it("reads YAML specs, strips HTML pages, and accepts pasted docs", async () => {
  const yaml = (await api("/api/apis", billing({ name: "Things", docsUrl: "https://docs.billing.example/openapi.yaml" }))).data;
  expect(yaml).toMatchObject({ docsFormat: "OpenAPI 3.0.0", endpointCount: 1 });
  const html = (await api("/api/apis", billing({ name: "Page", docsUrl: "https://docs.billing.example/docs.html" }))).data;
  const text = (await api(`/api/apis/${html.id}/docs`)).data.docs;
  expect(text).toContain("Billing API");
  expect(text).toContain("Use & enjoy.");
  expect(text).not.toContain("evil()");
  const pasted = (await api("/api/apis", billing({ name: "Private", docsUrl: "", docsText: "POST /charge creates a charge." }))).data;
  expect(pasted).toMatchObject({ docsFormat: "Text", docsSource: "pasted" });
});

it("attaches the key on the server, in the configured place, and redacts echoes", async () => {
  const bearer = (await api("/api/apis", billing())).data;
  const r = await api(`/api/apis/${bearer.id}/request`, { method: "GET", path: "/echo", query: { limit: 5 } });
  expect(r.status).toBe(200);
  expect(new Headers(calls.at(-1)!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  expect(calls.at(-1)!.url.searchParams.get("limit")).toBe("5");
  expect(JSON.stringify(r.data)).not.toContain(KEY);
  expect(JSON.stringify(r.data)).toContain("[REDACTED]");

  const query = (await api("/api/apis", billing({ name: "Maps", auth: "query", authName: "api_key" }))).data;
  await api(`/api/apis/${query.id}/request`, { path: "/echo", query: { api_key: "attacker-supplied" } });
  expect(calls.at(-1)!.url.searchParams.getAll("api_key")).toEqual([KEY]);

  const header = (await api("/api/apis", billing({ name: "Header", auth: "header", authName: "X-Api-Token" }))).data;
  await api(`/api/apis/${header.id}/request`, { path: "/x" });
  expect(new Headers(calls.at(-1)!.init.headers).get("x-api-token")).toBe(KEY);
});

it("keeps requests on the API, enforces read-only, and checks destinations", async () => {
  const a = (await api("/api/apis", billing())).data;
  expect((await api(`/api/apis/${a.id}/request`, { path: "/../admin" })).status).toBe(400);
  // A path that looks like another host is still a path on this API.
  await api(`/api/apis/${a.id}/request`, { path: "//evil.example/x" });
  expect(calls.at(-1)!.url.host).toBe("api.billing.example");
  expect((await api(`/api/apis/${a.id}/request`, { path: "/x?y=1" })).status).toBe(400);
  const before = calls.length;
  const write = await api(`/api/apis/${a.id}/request`, { method: "POST", path: "/invoices", body: { amount: 5 } });
  expect(write.status).toBe(403);
  expect(calls.length).toBe(before);
  await api(`/api/apis/${a.id}`, billing({ access: "write", key: undefined, docsUrl: a.docsUrl }), "PUT");
  expect((await api(`/api/apis/${a.id}/request`, { method: "POST", path: "/invoices", body: { amount: 5 } })).status).toBe(200);
  expect(calls.at(-1)!.init.body).toBe('{"amount":5}');

  const internal = (await api("/api/apis", billing({ name: "Internal", baseUrl: "https://internal.evil.test/v1", docsUrl: "" }))).data;
  expect((await api(`/api/apis/${internal.id}/request`, { path: "/x" })).status).toBe(400);
  expect(calls.some((c) => c.url.hostname === "internal.evil.test")).toBe(false);
});

it("drops the key when the API is moved to another host, so it can't be redirected", async () => {
  const a = (await api("/api/apis", billing())).data;
  const moved = (await api(`/api/apis/${a.id}`, billing({ baseUrl: "https://collector.example/v1", key: undefined }), "PUT")).data;
  expect(moved).toMatchObject({ hasKey: false, keyHint: null });
  expect(store.secret(workspace, a.id)).toBeUndefined();
  const r = await api(`/api/apis/${a.id}/request`, { path: "/x" });
  expect(r.status).toBe(409);
  // Only the credential-free logo lookup may reach the new host; nothing carrying the key does.
  const toCollector = calls.filter((c) => c.url.hostname === "collector.example");
  expect(toCollector.every((c) => !JSON.stringify(c).includes(KEY) && !new Headers(c.init.headers).has("authorization"))).toBe(true);
  // Same host, different path: the key stays.
  const b = (await api("/api/apis", billing({ name: "Billing two" }))).data;
  const kept = await api(`/api/apis/${b.id}`, billing({ name: "Billing two", baseUrl: "https://api.billing.example/v2", key: undefined }), "PUT");
  expect(kept.data.hasKey).toBe(true);
});

it("removes the encrypted key with the API, and only admins can manage APIs", async () => {
  const a = (await api("/api/apis", billing())).data;
  await api("/api/orgs", { name: "Acme" });
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Bobby", email: "bob@example.invalid", password: "Correct-horse-ship-2026" } });
  const bob = String(r.headers["set-cookie"]).split(";")[0];
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  await api("/api/invites/accept", { token: invite }, "POST", bob);
  expect((await api("/api/apis", billing(), "POST", bob)).status).toBe(403);
  await api("/api/workspaces/switch", { workspace });
  expect((await api(`/api/apis/${a.id}`, undefined, "DELETE")).status).toBe(200);
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE workspace=?").get(workspace)).toEqual({ n: 0 });
});

it("gives agents docs and requests through the gateway without ever exposing the key", async () => {
  const a = (await api("/api/apis", billing({ description: "Invoices and customers" }))).data;
  await api("/api/apis", billing({ name: "Keyless", key: undefined }));
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token;
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_i, init) => {
        const r = await inject(app, { url: "/mcp", method: "POST", headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) });
        return new Response(r.text, { status: r.status, headers: { "content-type": String(r.headers["content-type"] || "application/json") } });
      },
    }),
  );
  const tools = (await client.listTools()).tools;
  const request = tools.find((t) => t.name === "orbytlink__api_request")!;
  // An API without a key is not offered to agents.
  expect((request.inputSchema.properties!.api as any).enum).toEqual(["billing"]);
  expect(JSON.stringify(tools)).not.toContain(KEY);

  const docs = await client.callTool({ name: "orbytlink__api_docs", arguments: { api: "billing", search: "invoice" } });
  const docsText = JSON.stringify(docs.content);
  expect(docsText).toContain("POST /invoices - Create an invoice");
  expect(docsText).not.toContain("/customers/{id}");

  const ok = await client.callTool({ name: "orbytlink__api_request", arguments: { api: "billing", method: "GET", path: "/echo" } });
  expect(ok.isError).toBeFalsy();
  expect(JSON.stringify(ok.content)).not.toContain(KEY);
  const blocked = await client.callTool({ name: "orbytlink__api_request", arguments: { api: "billing", method: "DELETE", path: "/invoices/1" } });
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked.content)).toContain("read requests only");
  const logged = (await api("/api/state")).data.apiCalls;
  expect(logged[0]).toMatchObject({ api: a.name, method: "GET", path: "/echo", status: 200 });
});

it("sends fixed headers, form-encodes bodies when asked, and keeps a compact spec reference", async () => {
  const a = (await api("/api/apis", billing({ access: "write", bodyFormat: "form", headers: { "Stripe-Version": "2024-06-20" } }))).data;
  await api(`/api/apis/${a.id}/request`, { method: "POST", path: "/customers", body: { email: "a@b.co", metadata: { order: 6735 }, items: [{ price: "p_1" }] } });
  const sent = calls.at(-1)!;
  const headers = new Headers(sent.init.headers);
  expect(headers.get("stripe-version")).toBe("2024-06-20");
  expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  expect(decodeURIComponent(String(sent.init.body))).toBe("email=a@b.co&metadata[order]=6735&items[0][price]=p_1");
  // Keys can't be smuggled in as plain headers.
  expect((await api("/api/apis", billing({ name: "Smuggle", headers: { Authorization: "Bearer x" } }))).status).toBe(400);
  const docs = (await api(`/api/apis/${a.id}/docs`)).data.docs;
  expect(docs).toContain("POST /invoices - Create an invoice");
  expect(docs).not.toContain('"openapi"');
});

it("fetches the site's logo once on save, safely, without the key", async () => {
  const a = (await api("/api/apis", billing())).data;
  expect(a.logo).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  const logoCalls = calls.filter((c) => c.url.hostname === "billing.example");
  expect(logoCalls.map((c) => c.url.pathname)).toEqual(["/", "/brand.png"]);
  expect(logoCalls.every((c) => !new Headers(c.init.headers).has("authorization"))).toBe(true);
  // Saving again keeps it without another lookup.
  const before = calls.length;
  await api(`/api/apis/${a.id}`, billing({ key: undefined, docsUrl: a.docsUrl, name: "Billing 2" }), "PUT");
  expect(calls.length).toBe(before);
  // No icon anywhere (the stub answers JSON): no logo, and the miss is remembered.
  const other = (await api("/api/apis", billing({ name: "Plain", baseUrl: "https://plain.example/v1", docsUrl: "" }))).data;
  expect(other.logo).toBeNull();
  // A redirect to a private address is checked like any other hop.
  await api("/api/apis", billing({ name: "Evil", baseUrl: "https://evil-logo.example/v1", docsUrl: "" }));
  expect(calls.some((c) => c.url.hostname === "internal.evil.test")).toBe(false);
});
