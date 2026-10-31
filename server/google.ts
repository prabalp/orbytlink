import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Express, Request, Response, RequestHandler } from "express";
import type { Store } from "./store.js";
import type { Account } from "./auth.js";

// Google sign-in (OpenID Connect, authorization code + PKCE). The session cookie is
// SameSite=Strict, so it is not sent when Google redirects back; the flow's state,
// nonce and PKCE verifier travel in their own short-lived, signed, Lax cookie instead.
const COOKIE = "orbyt_google";
const LIFETIME = 10 * 60 * 1000;
const issuers = ["https://accounts.google.com", "accounts.google.com"];
const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const b64 = (b: Buffer) => b.toString("base64url");

export const googleConfigured = () =>
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

const callbackUrl = () =>
  `${(process.env.APP_ORIGIN || "http://127.0.0.1:3100").replace(/\/$/, "")}/api/auth/google/callback`;

function readCookie(req: Request, name: string) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
}

export function configureGoogleAuth(
  app: Express,
  store: Store,
  key: string,
  limit: RequestHandler,
  login: (req: Request, res: Response, accountId: string, done: (error?: unknown) => void) => void,
) {
  const production = process.env.NODE_ENV === "production";
  const sign = (value: string) => b64(createHmac("sha256", key).update(value).digest());
  const fail = (res: Response, code: string) => {
    res.clearCookie(COOKIE, { path: "/api/auth/google" });
    res.redirect(`/#auth-error=${code}`);
  };

  app.get("/api/auth/google", limit, (_req, res) => {
    if (!googleConfigured()) return fail(res, "google-not-configured");
    const flow = {
      state: b64(randomBytes(32)),
      nonce: b64(randomBytes(32)),
      verifier: b64(randomBytes(48)),
      exp: Date.now() + LIFETIME,
    };
    const payload = b64(Buffer.from(JSON.stringify(flow)));
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      maxAge: LIFETIME,
      path: "/api/auth/google",
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: callbackUrl(),
      response_type: "code",
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: b64(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    res.redirect(url.toString());
  });

  app.get("/api/auth/google/callback", limit, async (req, res) => {
    if (!googleConfigured()) return fail(res, "google-not-configured");
    const raw = readCookie(req, COOKIE) || "";
    const [payload, mac] = raw.split(".");
    const expected = payload ? sign(payload) : "";
    if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
      return fail(res, "google-failed");
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      state: string; nonce: string; verifier: string; exp: number;
    };
    if (flow.exp < Date.now() || req.query.state !== flow.state || typeof req.query.code !== "string")
      return fail(res, req.query.error === "access_denied" ? "google-cancelled" : "google-failed");
    try {
      const token = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl(),
          grant_type: "authorization_code",
          code_verifier: flow.verifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!token.ok) return fail(res, "google-failed");
      const { id_token } = (await token.json()) as { id_token?: string };
      if (!id_token) return fail(res, "google-failed");
      const { payload: claims } = await jwtVerify(id_token, jwks, {
        issuer: issuers,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      if (claims.nonce !== flow.nonce || !claims.sub || typeof claims.email !== "string" || claims.email_verified !== true)
        return fail(res, "google-unverified");
      const account = findOrCreate(store, {
        sub: claims.sub,
        email: claims.email.trim().toLowerCase(),
        name: typeof claims.name === "string" ? claims.name : "",
      });
      if (typeof account === "string") return fail(res, account);
      res.clearCookie(COOKIE, { path: "/api/auth/google" });
      login(req, res, account.id, (error) => {
        if (error) return fail(res, "google-failed");
        res.redirect("/#connections");
      });
    } catch {
      fail(res, "google-failed");
    }
  });
}

// Google accounts are matched by their stable subject; a verified email links an existing account once.
function findOrCreate(store: Store, profile: { sub: string; email: string; name: string }): Account | string {
  return store.transaction(() => {
    const bySub = store.db.prepare("SELECT * FROM accounts WHERE google_sub=?").get(profile.sub) as Account | undefined;
    if (bySub) return bySub.disabled ? "account-disabled" : bySub;
    const byEmail = store.db.prepare("SELECT * FROM accounts WHERE email=?").get(profile.email) as
      | (Account & { google_sub: string | null })
      | undefined;
    if (byEmail) {
      if (byEmail.disabled) return "account-disabled";
      if (byEmail.google_sub && byEmail.google_sub !== profile.sub) return "google-mismatch";
      store.db.prepare("UPDATE accounts SET google_sub=? WHERE id=?").run(profile.sub, byEmail.id);
      store.audit(byEmail.workspace, byEmail.email, "account.google-linked", byEmail.id);
      return byEmail;
    }
    if (process.env.ALLOW_SIGNUP === "false") return "signup-closed";
    const id = randomUUID(),
      workspace = randomUUID(),
      name = (profile.name.trim() || profile.email.split("@")[0]).slice(0, 80).padEnd(2, " ");
    // No usable password: the hash has no scrypt parameters, so password sign-in always fails.
    store.db
      .prepare(
        "INSERT INTO accounts(id,email,name,workspace,password_hash,created_at,google_sub) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, profile.email, name, workspace, `oauth:${b64(randomBytes(32))}`, Date.now(), profile.sub);
    store.seed(workspace);
    store.audit(workspace, profile.email, "account.created", "google");
    return store.db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Account;
  });
}
