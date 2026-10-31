import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inject } from "./inject.js";
import type { Express } from "express";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import type { ServiceAdapters } from "../server/adapters.js";
let app: Express,
  cookie: string,
  token: string,
  readToken: string,
  otherToken: string;
const store = new Store(":memory:");
const services: ServiceAdapters = {
  test: vi.fn(async () => ({
    protocol: "mcp" as const,
    tools: [{ name: "discovered_read", inputSchema: { type: "object" } }],
  })),
  call: vi.fn(),
};
async function request(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  credential = cookie,
) {
  return inject(app, {
    url: path,
    method,
    headers: credential?.startsWith("Bearer ")
      ? { Authorization: credential }
      : { Cookie: credential || "" },
    body,
  });
}
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ keys: [key] }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  process.env.OIDC_JWKS_URL = "https://identity.example/jwks";
  process.env.OIDC_ISSUER = "https://identity.example";
  process.env.OIDC_AUDIENCE = "orbytlink";
  const mint = (workspace: string, permissions: string[]) =>
    new SignJWT({ workspace, permissions })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("prabalp")
      .setIssuer("https://identity.example")
      .setAudience("orbytlink")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  token = await mint("live", ["read", "configure", "call"]);
  readToken = await mint("live", ["read"]);
  otherToken = await mint("other", ["read", "configure", "call"]);
  app = createApp(store, services).app;
  const r = await request("/api/auth/register", {
    name: "prabalp",
    email: "prabalp@example.invalid",
    password: "Correct-horse-ship-2026",
  });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
afterAll(() => {
  store.db.close();
  vi.restoreAllMocks();
  delete process.env.OIDC_JWKS_URL;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
});
describe("authenticated gateway", () => {
  it("starts with health and protects workspace access", async () => {
    expect((await request("/api/health")).status).toBe(200);
    expect((await request("/api/state", undefined, "GET", "")).status).toBe(
      401,
    );
    expect((await request("/api/state")).data.identity.user).toBe(
      "prabalp@example.invalid",
    );
  });
  it("validates connection creation and protects saved secrets", async () => {
    expect(
      (await request("/api/connections", { name: "x", kind: "mcp" })).status,
    ).toBe(400);
    const r = await request("/api/connections", {
      name: "Private server",
      kind: "mcp",
      endpoint: "",
      auth: "bearer",
      secret: "highly-private-secret",
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain("highly-private-secret");
    expect(r.data.hasSecret).toBe(true);
    const state = await request("/api/state");
    expect(JSON.stringify(state.data)).not.toContain("highly-private-secret");
  });
  it("reports missing configuration and makes no external request with missing configuration", async () => {
    const row = (await request("/api/connections", { name: "Unconfigured" })).data;
    const r = await request(`/api/connections/${row.id}/test`, {});
    expect(r.data.status).toBe("Not configured");
    expect(services.test).not.toHaveBeenCalled();
  });
  it("enforces configure permission and cross-workspace record isolation", async () => {
    expect(
      (
        await request(
          "/api/connections",
          { name: "Forbidden", kind: "mcp" },
          "POST",
          `Bearer ${readToken}`,
        )
      ).status,
    ).toBe(403);
    const row = (
      await request(
        "/api/connections",
        { name: "Private connection" },
        "POST",
        `Bearer ${token}`,
      )
    ).data;
    expect(
      (
        await request(
          `/api/connections/${row.id}`,
          {},
          "DELETE",
          `Bearer ${otherToken}`,
        )
      ).status,
    ).toBe(404);
  });
  it("tests actual configured MCP discovery behind authentication", async () => {
    const row = (
      await request(
        "/api/connections",
        {
          name: "Test MCP",
          kind: "mcp",
          endpoint: "https://actual.example/mcp",
        },
        "POST",
        `Bearer ${token}`,
      )
    ).data;
    const result = await request(
      `/api/connections/${row.id}/test`,
      {},
      "POST",
      `Bearer ${token}`,
    );
    expect(result.data.status).toBe("Connected");
    expect(result.data.tools[0].name).toBe("discovered_read");
  });
  it("reports unreachable MCP accurately and removes stale tool discovery", async () => {
    const row = (
      await request(
        "/api/connections",
        {
          name: "Unreachable MCP",
          kind: "mcp",
          endpoint: "https://unreachable.example/mcp",
        },
        "POST",
        `Bearer ${token}`,
      )
    ).data;
    vi.mocked(services.test).mockRejectedValueOnce(
      new Error("secret transport detail"),
    );
    const result = await request(
      `/api/connections/${row.id}/test`,
      {},
      "POST",
      `Bearer ${token}`,
    );
    expect(result.data.status).toBe("Error");
    expect(result.data.tools).toEqual([]);
    expect(JSON.stringify(result.data)).not.toContain(
      "secret transport detail",
    );
  });
  it("rejects forged tokens and unsafe request origins", async () => {
    expect(
      (await request("/api/state", undefined, "GET", "Bearer forged")).status,
    ).toBe(401);
    const r = await inject(app, {
      url: "/api/connections",
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: cookie },
      body: {},
    });
    expect(r.status).toBe(403);
  });
  it("exposes no gateway tools to an identity without call permission", async () => {
    const r = await inject(app, {
      url: "/mcp",
      method: "POST",
      headers: {
        Authorization: `Bearer ${readToken}`,
        Accept: "application/json, text/event-stream",
      },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(r.status).toBe(200);
    expect(r.data.result.tools).toEqual([]);
  });
});
