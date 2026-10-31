import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { createApp } from "../server/app";
import {
  createAccount,
  resetAccountPassword,
  verifyPassword,
} from "../server/auth";
import { inject } from "./inject";
const credentials = {
  name: "prabalp",
  email: "prabalp@example.invalid",
  password: "Correct-horse-ship-2026",
};
let store: Store, app: ReturnType<typeof createApp>["app"];
const cookie = (r: any) => String(r.headers["set-cookie"]).split(";")[0];
const request = (
  url: string,
  body?: unknown,
  session = "",
  method = body ? "POST" : "GET",
) => inject(app, { url, body, method, headers: { Cookie: session } });
const signup = () => request("/api/auth/register", credentials);
beforeEach(() => {
  store = new Store(":memory:");
  app = createApp(store).app;
});
afterEach(() => {
  store.db.close();
  vi.unstubAllEnvs();
});
it("registers an actual isolated account, hashes its password, and issues an HTTP-only session", async () => {
  const r = await signup();
  expect(r.status).toBe(200);
  const state = await request("/api/state", undefined, cookie(r));
  expect(state.status).toBe(200);
  expect(state.data.identity.demo).toBe(false);
  expect(state.data.identity.email).toBe(credentials.email);
  expect(state.data.identity.workspace).not.toBe("prabalp");
  expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly/);
  expect(String(r.headers["set-cookie"])).toMatch(/SameSite=Strict/);
  const account = store.db.prepare("SELECT * FROM accounts").get() as any;
  expect(account.password_hash).not.toContain(credentials.password);
  expect(
    await verifyPassword(credentials.password, account.password_hash),
  ).toBe(true);
  expect(JSON.stringify(state.data)).not.toContain("password_hash");
  expect(JSON.stringify(state.data)).not.toContain(credentials.password);
});
it("normalizes email and authenticates after signing out; all failed logins use the same response", async () => {
  const registration = await signup();
  await request("/api/session/logout", {}, cookie(registration));
  expect(
    (await request("/api/state", undefined, cookie(registration))).status,
  ).toBe(401);
  const login = await request("/api/auth/login", {
    email: "PRABALP@EXAMPLE.INVALID",
    password: credentials.password,
  });
  expect(login.status).toBe(200);
  expect((await request("/api/state", undefined, cookie(login))).status).toBe(
    200,
  );
  const bad = await request("/api/auth/login", {
    email: credentials.email,
    password: "wrong-password-12345",
  });
  const missing = await request("/api/auth/login", {
    email: "prabalp-missing@example.invalid",
    password: "wrong-password-12345",
  });
  expect(bad.status).toBe(401);
  expect(missing.data).toEqual(bad.data);
});
it("enforces account isolation without accepting caller-supplied workspace or permissions", async () => {
  const one = await signup(),
    s1 = await request("/api/state", undefined, cookie(one));
  const skill = await request(
    "/api/connections",
    { name: "Private connection" },
    cookie(one),
  );
  const two = await request("/api/auth/register", {
    ...credentials,
    email: "prabalp-two@example.invalid",
    workspace: s1.data.identity.workspace,
    permissions: ["admin"],
  });
  const s2 = await request("/api/state", undefined, cookie(two));
  expect(s2.data.identity.workspace).not.toBe(s1.data.identity.workspace);
  expect(s2.data.connections.some((s: any) => s.id === skill.data.id)).toBe(false);
  expect(
    (await request(`/api/connections/${skill.data.id}`, {}, cookie(two), "DELETE"))
      .status,
  ).toBe(404);
});
it("invalidates expired and disabled-account sessions", async () => {
  const r = await signup();
  store.db.prepare("UPDATE sessions SET expires=0").run();
  expect((await request("/api/state", undefined, cookie(r))).status).toBe(401);
  const login = await request("/api/auth/login", credentials);
  store.db.prepare("UPDATE accounts SET disabled=1").run();
  expect((await request("/api/state", undefined, cookie(login))).status).toBe(
    401,
  );
});
it("revokes every session and client token on sign-out-all", async () => {
  const one = await signup(),
    two = await request("/api/auth/login", credentials);
  const token = await request("/api/tokens", { name: "Laptop" }, cookie(one));
  expect(
    (
      await inject(app, {
        url: "/mcp",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.data.token}`,
          Accept: "application/json, text/event-stream",
        },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      })
    ).status,
  ).toBe(200);
  await request("/api/auth/logout-all", {}, cookie(one));
  expect((await request("/api/state", undefined, cookie(two))).status).toBe(
    401,
  );
  expect(
    (
      await inject(app, {
        url: "/mcp",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.data.token}`,
          Accept: "application/json, text/event-stream",
        },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      })
    ).status,
  ).toBe(401);
});
it("changes password, rotates the current session, and revokes old sessions and tokens", async () => {
  const one = await signup(),
    two = await request("/api/auth/login", credentials);
  await request("/api/tokens", { name: "Laptop" }, cookie(one));
  const changed = await request(
    "/api/auth/password",
    {
      currentPassword: credentials.password,
      newPassword: "Another-correct-password-2026",
    },
    cookie(one),
  );
  expect(changed.status).toBe(200);
  expect(cookie(changed)).not.toBe(cookie(one));
  expect((await request("/api/state", undefined, cookie(changed))).status).toBe(
    200,
  );
  expect((await request("/api/state", undefined, cookie(one))).status).toBe(
    401,
  );
  expect((await request("/api/state", undefined, cookie(two))).status).toBe(
    401,
  );
  expect(
    store.db.prepare("SELECT COUNT(*) AS count FROM access_tokens").get()
      ?.count,
  ).toBe(0);
  expect((await request("/api/auth/login", credentials)).status).toBe(401);
  expect(
    (
      await request("/api/auth/login", {
        email: credentials.email,
        password: "Another-correct-password-2026",
      })
    ).status,
  ).toBe(200);
});
it("supports operator password recovery without SMTP and revokes sessions", async () => {
  const r = await signup();
  await resetAccountPassword(
    store,
    credentials.email,
    "Recovered-password-2026",
  );
  expect((await request("/api/state", undefined, cookie(r))).status).toBe(401);
  expect(
    (
      await request("/api/auth/login", {
        email: credentials.email,
        password: "Recovered-password-2026",
      })
    ).status,
  ).toBe(200);
});
it("removes the demo login and can close public registration", async () => {
  expect((await request("/api/session/demo", {})).status).toBe(410);
  vi.stubEnv("ALLOW_SIGNUP", "false");
  expect((await request("/api/auth/config")).data.signupEnabled).toBe(false);
  expect((await signup()).status).toBe(403);
});
it("validates passwords and protects authentication against cross-origin requests", async () => {
  expect(
    (await request("/api/auth/register", { ...credentials, password: "short" }))
      .status,
  ).toBe(400);
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    headers: { Origin: "https://evil.invalid" },
    body: credentials,
  });
  expect(r.status).toBe(403);
  expect(
    store.db.prepare("SELECT COUNT(*) AS count FROM accounts").get()?.count,
  ).toBe(0);
});
it("rate limits credential guessing", async () => {
  await createAccount(store, credentials);
  let last;
  for (let i = 0; i < 9; i++)
    last = await request("/api/auth/login", {
      email: credentials.email,
      password: "incorrect-password-2026",
    });
  expect(last?.status).toBe(429);
});
it("runs email authentication in production over HTTPS without any OIDC configuration", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", "https://orbytlink.example");
  const production = createApp(store).app;
  const insecure = await inject(production, {
    url: "/api/auth/login",
    method: "POST",
    body: credentials,
  });
  expect(insecure.status).toBe(426);
  const secure = await inject(production, {
    url: "/api/auth/register",
    method: "POST",
    body: credentials,
    secure: true,
    headers: { host: "orbytlink.example", Origin: "https://orbytlink.example" },
  });
  expect(secure.status).toBe(200);
  expect(String(secure.headers["set-cookie"])).toContain("Secure");
  expect(
    (
      await inject(production, {
        url: "/api/state",
        secure: true,
        headers: { Cookie: cookie(secure), host: "orbytlink.example" },
      })
    ).status,
  ).toBe(200);
});
it("keeps sessions after reopening the database and recreating the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbytlink-auth-"));
  let persistent = new Store(dir);
  try {
    let server = createApp(persistent).app;
    const r = await inject(server, {
      url: "/api/auth/register",
      method: "POST",
      body: credentials,
    });
    const session = cookie(r);
    persistent.db.close();
    persistent = new Store(dir);
    server = createApp(persistent).app;
    expect(
      (
        await inject(server, {
          url: "/api/state",
          headers: { Cookie: session },
        })
      ).status,
    ).toBe(200);
  } finally {
    persistent.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
