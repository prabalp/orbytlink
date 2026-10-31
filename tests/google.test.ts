import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../server/app";
import { createAccount } from "../server/auth";
import { Store } from "../server/store";
import { inject } from "./inject";

let store: Store, app: ReturnType<typeof createApp>["app"];
const cookieOf = (r: any, name: string) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  store = new Store(":memory:");
  app = createApp(store).app;
});
afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

async function start() {
  const r = await inject(app, { url: "/api/auth/google" });
  const location = new URL(String(r.headers.location));
  return { r, location, cookie: cookieOf(r, "orbyt_google")! };
}

// One signing key for the whole file: the gateway caches Google's key set, as it should.
const keys = generateKeyPair("RS256");
async function finish(claims: Record<string, unknown>, tamper = false) {
  const { privateKey, publicKey } = await keys;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const { location, cookie } = await start();
  const idToken = await new SignJWT({ nonce: location.searchParams.get("nonce"), ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(process.env.GOOGLE_CLIENT_ID!)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const exchange = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes("/certs")) return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code_verifier")).toBeTruthy();
    return Response.json({ id_token: idToken });
  });
  vi.stubGlobal("fetch", exchange);
  const state = tamper ? "forged" : location.searchParams.get("state");
  return inject(app, {
    url: `/api/auth/google/callback?code=abc&state=${state}`,
    headers: { Cookie: cookie },
  });
}

it("advertises Google only when configured, and explains when it is not", async () => {
  expect((await inject(app, { url: "/api/auth/config" })).data.google).toBe(true);
  delete process.env.GOOGLE_CLIENT_ID;
  expect((await inject(app, { url: "/api/auth/config" })).data.google).toBe(false);
  const r = await inject(app, { url: "/api/auth/google" });
  expect(r.status).toBe(302);
  expect(r.headers.location).toBe("/#auth-error=google-not-configured");
});

it("redirects to Google with PKCE, state and nonce in a signed Lax cookie", async () => {
  const { r, location } = await start();
  expect(r.status).toBe(302);
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3100/api/auth/google/callback");
  const header = String(([] as string[]).concat(r.headers["set-cookie"] as any).join(";"));
  expect(header).toMatch(/HttpOnly/i);
  expect(header).toMatch(/SameSite=Lax/i);
});

it("creates an account from a verified Google identity and signs in", async () => {
  const r = await finish({ sub: "g-1", email: "Prabal@Example.com", email_verified: true, name: "Prabal" });
  expect(r.headers.location).toBe("/#connections");
  const session = cookieOf(r, "orbyt_session")!;
  const state = await inject(app, { url: "/api/state", headers: { Cookie: session } });
  expect(state.status).toBe(200);
  expect(state.data.identity.email).toBe("prabal@example.com");
  // A Google-created account has no usable password.
  const login = await inject(app, {
    url: "/api/auth/login",
    method: "POST",
    body: { email: "prabal@example.com", password: "oauth:anything-at-all" },
  });
  expect(login.status).toBe(401);
});

it("links an existing email account once and rejects a different Google subject later", async () => {
  await createAccount(store, { name: "Prabal", email: "p@example.com", password: "Correct-horse-ship-2026" });
  expect((await finish({ sub: "g-1", email: "p@example.com", email_verified: true })).headers.location).toBe("/#connections");
  expect((await finish({ sub: "g-2", email: "p@example.com", email_verified: true })).headers.location).toBe("/#auth-error=google-mismatch");
});

it("rejects unverified emails, forged state, and closed registration", async () => {
  expect((await finish({ sub: "g-1", email: "a@example.com", email_verified: false })).headers.location).toBe("/#auth-error=google-unverified");
  expect((await finish({ sub: "g-1", email: "a@example.com", email_verified: true }, true)).headers.location).toBe("/#auth-error=google-failed");
  process.env.ALLOW_SIGNUP = "false";
  try {
    expect((await finish({ sub: "g-9", email: "new@example.com", email_verified: true })).headers.location).toBe("/#auth-error=signup-closed");
  } finally {
    delete process.env.ALLOW_SIGNUP;
  }
});
