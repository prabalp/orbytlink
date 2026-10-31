import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import type { Store, Row } from "./store.js";
import { safeEndpoint, boundedText } from "./adapters.js";
import { roleIn } from "./orgs.js";
import { oauthSchema, type Identity } from "./schema.js";

// OAuth sign-in to upstream apps (Google, Slack, Notion, Linear…): authorization code with
// PKCE. Tokens are encrypted in the vault next to the connection's other credentials and
// refreshed on demand. The state, verifier and requester travel in a short-lived signed
// cookie, because the session cookie is SameSite=Strict and is not sent on the way back.
const COOKIE = "orbyt_oauth";
const LIFETIME = 10 * 60 * 1000;
const b64 = (b: Buffer) => b.toString("base64url");
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

export const redirectUri = () =>
  `${(process.env.APP_ORIGIN || "http://127.0.0.1:3100").replace(/\/$/, "")}/api/oauth/callback`;

type Resolved = {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  scopeParam: string;
  authParams: Record<string, string>;
  tokenAuth: "body" | "basic";
  resource?: string;
  redirect: string;
};
type Tokens = { access: string; refresh?: string; expiresAt: number | null; scope?: string };

// Every request to an authorization server goes through the same outbound checks as
// connections: HTTPS, allowlisted host, public addresses, no redirects, bounded reply.
async function http(url: string, init: RequestInit = {}) {
  let target: URL;
  try {
    target = await safeEndpoint(url);
  } catch (error) {
    const message = (error as Error).message;
    throw conflict(
      /OUTBOUND_HOSTS|Private and reserved/.test(message)
        ? `${message}. The sign-in server (${new URL(url).hostname}) must be allowed in OUTBOUND_HOSTS.`
        : "The sign-in server address is not allowed.",
    );
  }
  try {
    const r = await fetch(target, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
    });
    const text = await boundedText(r, 200000);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: r.ok, status: r.status, json };
  } catch {
    throw conflict("The sign-in server could not be reached.");
  }
}

const isUrl = (v: unknown): v is string => {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
};

// MCP authorization discovery: protected-resource metadata, then authorization-server metadata.
async function discover(endpoint: string) {
  const base = new URL(endpoint);
  const path = base.pathname.replace(/\/$/, "");
  let issuer = base.origin;
  for (const url of [
    `${base.origin}/.well-known/oauth-protected-resource${path}`,
    `${base.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const r = await http(url).catch(() => undefined);
    const first = r?.json?.authorization_servers?.[0];
    if (r?.ok && isUrl(first)) {
      issuer = first;
      break;
    }
  }
  const as = new URL(issuer);
  const asPath = as.pathname.replace(/\/$/, "");
  for (const url of [
    `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${as.origin}/.well-known/openid-configuration${asPath}`,
    `${as.origin}${asPath}/.well-known/openid-configuration`,
  ]) {
    const r = await http(url).catch(() => undefined);
    const m = r?.json;
    if (r?.ok && isUrl(m?.authorization_endpoint) && isUrl(m?.token_endpoint)) {
      if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes("S256"))
        throw conflict("This server does not support PKCE sign-in.");
      return {
        authorizationUrl: m.authorization_endpoint as string,
        tokenUrl: m.token_endpoint as string,
        registrationUrl: isUrl(m.registration_endpoint) ? (m.registration_endpoint as string) : undefined,
      };
    }
  }
  throw conflict("This server does not advertise OAuth sign-in. Use a token instead, or enter the OAuth details manually.");
}

async function register(store: Store, w: string, c: Row, registrationUrl: string, redirect: string) {
  const r = await http(registrationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "OrbytLink",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!r.ok || typeof r.json?.client_id !== "string")
    throw conflict("The server refused automatic client registration. Enter a client ID manually.");
  if (typeof r.json.client_secret === "string" && r.json.client_secret)
    store.secret(w, `${c.id}:oauth-client`, r.json.client_secret);
  return r.json.client_id as string;
}

async function resolveConfig(store: Store, w: string, c: Row): Promise<Resolved> {
  const cfg = oauthSchema.parse(c.oauth ?? {}),
    redirect = redirectUri();
  if (cfg.mode === "manual")
    return {
      authorizationUrl: cfg.authorizationUrl,
      tokenUrl: cfg.tokenUrl,
      clientId: cfg.clientId,
      scopes: cfg.scopes,
      scopeParam: cfg.scopeParam,
      authParams: cfg.authParams,
      tokenAuth: cfg.tokenAuth,
      redirect,
    };
  const meta = await discover(c.endpoint);
  const previous = c.oauthState?.resolved as Resolved | undefined;
  let clientId = cfg.clientId;
  if (!clientId && previous?.clientId && previous.redirect === redirect && previous.tokenUrl === meta.tokenUrl)
    clientId = previous.clientId;
  if (!clientId) {
    if (!meta.registrationUrl)
      throw conflict("This server needs a registered OAuth client. Enter its client ID (and secret) in the connection.");
    clientId = await register(store, w, c, meta.registrationUrl, redirect);
  }
  return {
    authorizationUrl: meta.authorizationUrl,
    tokenUrl: meta.tokenUrl,
    clientId,
    scopes: cfg.scopes,
    scopeParam: cfg.scopeParam,
    authParams: cfg.authParams,
    tokenAuth: cfg.tokenAuth,
    resource: c.endpoint,
    redirect,
  };
}

async function tokenRequest(store: Store, w: string, c: Row, r: Resolved, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const clientSecret = store.secret(w, `${c.id}:oauth-client`);
  if (clientSecret && r.tokenAuth === "basic")
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(r.clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  else {
    body.set("client_id", r.clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }
  if (r.resource) body.set("resource", r.resource);
  const res = await http(r.tokenUrl, { method: "POST", headers, body: body.toString() });
  const j = res.json;
  // Slack answers 200 with ok:false, and nests user tokens under authed_user.
  const access = j?.access_token ?? j?.authed_user?.access_token;
  if (!res.ok || j?.ok === false || j?.error || typeof access !== "string")
    throw Object.assign(new Error("Token request failed"), { oauthError: String(j?.error || res.status) });
  const refresh = j.refresh_token ?? j.authed_user?.refresh_token;
  const lifetime = Number(j.expires_in ?? j.authed_user?.expires_in);
  return {
    access,
    refresh: typeof refresh === "string" ? refresh : undefined,
    expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? Date.now() + lifetime * 1000 : null,
    scope: typeof j.scope === "string" ? j.scope : undefined,
  };
}

function saveTokens(store: Store, w: string, id: string, t: Tokens, resolved?: Resolved) {
  store.secret(w, `${id}:oauth-access`, t.access);
  // Providers that rotate refresh tokens send a new one; otherwise keep the old.
  if (t.refresh) store.secret(w, `${id}:oauth-refresh`, t.refresh);
  const fresh = store.get(w, "connections", id);
  store.put(w, "connections", {
    ...fresh,
    oauthState: {
      ...(fresh.oauthState || {}),
      ...(resolved ? { resolved } : {}),
      connected: true,
      expiresAt: t.expiresAt,
      scope: t.scope ?? fresh.oauthState?.scope ?? null,
      connectedAt: fresh.oauthState?.connectedAt ?? new Date().toISOString(),
    },
  });
}

// Forget the tokens (and optionally the client secret) of a connection.
export function dropOAuth(store: Store, w: string, id: string, clientSecretToo = false) {
  store.deleteSecret(w, `${id}:oauth-access`);
  store.deleteSecret(w, `${id}:oauth-refresh`);
  if (clientSecretToo) store.deleteSecret(w, `${id}:oauth-client`);
}

function markExpired(store: Store, w: string, id: string) {
  dropOAuth(store, w, id);
  const fresh = store.get(w, "connections", id);
  store.put(w, "connections", {
    ...fresh,
    status: "Error",
    error: "Authorization expired. Reconnect this app.",
    oauthState: { ...(fresh.oauthState || {}), connected: false },
  });
}

const inflight = new Map<string, Promise<string>>();

// The credential to present upstream: the vault secret, or a fresh OAuth access token.
export async function credentialFor(store: Store, w: string, c: Row): Promise<string | undefined> {
  if (c.auth !== "oauth") return store.secret(w, c.id);
  const state = c.oauthState;
  const token = state?.connected ? store.secret(w, `${c.id}:oauth-access`) : undefined;
  if (!token) throw new Error("Authorization required. Connect this app first.");
  if (!state.expiresAt || state.expiresAt - Date.now() > 60_000) return token;
  const key = `${w}:${c.id}`;
  let pending = inflight.get(key);
  if (!pending) {
    // Concurrent calls share one refresh; rotating refresh tokens would break on a second one.
    pending = refresh(store, w, c).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function refresh(store: Store, w: string, c: Row): Promise<string> {
  const resolved = c.oauthState?.resolved as Resolved | undefined;
  const refreshToken = store.secret(w, `${c.id}:oauth-refresh`);
  if (!resolved || !refreshToken) {
    markExpired(store, w, c.id);
    throw new Error("Authorization expired. Reconnect this app.");
  }
  try {
    const t = await tokenRequest(store, w, c, resolved, { grant_type: "refresh_token", refresh_token: refreshToken });
    saveTokens(store, w, c.id, t);
    return t.access;
  } catch (error) {
    // A revoked or expired grant needs the person to sign in again; a network blip does not.
    if (/^(invalid_grant|invalid_token|unauthorized_client|400|401)$/.test((error as any).oauthError || "")) {
      markExpired(store, w, c.id);
      throw new Error("Authorization expired. Reconnect this app.");
    }
    throw new Error("Could not refresh authorization");
  }
}

function sign(key: string, value: string) {
  return b64(createHmac("sha256", key).update(value).digest());
}
function readCookie(req: Request, name: string) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
}

// Registered BEFORE the authentication middleware: the browser arrives from the provider
// without the Strict session cookie, so this route authenticates from the signed flow cookie.
export function configureOAuthCallback(app: Express, store: Store, key: string, limit: RequestHandler) {
  app.get("/api/oauth/callback", limit, async (req, res) => {
    const fail = (code: string) => {
      res.clearCookie(COOKIE, { path: "/api/oauth" });
      res.redirect(`/#oauth-error=${code}`);
    };
    const raw = readCookie(req, COOKIE) || "";
    const [payload, mac] = raw.split(".");
    const expected = payload ? sign(key, payload) : "";
    if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
      return fail("oauth-failed");
    let flow: { state: string; verifier: string; w: string; id: string; account: string; exp: number };
    try {
      flow = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      return fail("oauth-failed");
    }
    if (flow.exp < Date.now() || req.query.state !== flow.state)
      return fail("oauth-failed");
    if (req.query.error) return fail(req.query.error === "access_denied" ? "oauth-cancelled" : "oauth-failed");
    if (typeof req.query.code !== "string") return fail("oauth-failed");
    // The person who started this must still be an admin of the workspace.
    if (roleIn(store, flow.account, flow.w) !== "admin") return fail("oauth-forbidden");
    try {
      const c = store.get(flow.w, "connections", flow.id);
      const resolved = c.oauthState?.resolved as Resolved | undefined;
      if (c.auth !== "oauth" || !resolved) return fail("oauth-failed");
      const t = await tokenRequest(store, flow.w, c, resolved, {
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: resolved.redirect,
        code_verifier: flow.verifier,
      });
      saveTokens(store, flow.w, c.id, t);
      // New authorization: the connection must pass a live test again before it is exposed.
      const fresh = store.get(flow.w, "connections", c.id);
      store.put(flow.w, "connections", { ...fresh, status: "Not tested", tools: [], error: null });
      store.audit(flow.w, c.name, "connection.authorized", c.name);
      res.clearCookie(COOKIE, { path: "/api/oauth" });
      res.redirect(`/#oauth-connected=${c.id}`);
    } catch {
      fail("oauth-failed");
    }
  });
}

type Permit = (permission: string) => RequestHandler;
export function configureOAuthRoutes(app: Express, store: Store, key: string, permit: Permit) {
  const production = process.env.NODE_ENV === "production";
  const caller = (req: Request) => {
    const identity = (req.res as any).locals.identity as Identity;
    const account = (req.user as any)?.id as string | undefined;
    if (identity.authMethod !== "email" || !account)
      throw Object.assign(new Error("Sign in with your account to connect apps."), { status: 403 });
    return { identity, account };
  };

  app.post("/api/connections/:id/oauth/start", permit("configure"), async (req, res) => {
    const { identity, account } = caller(req);
    const w = identity.workspace,
      c = store.get(w, "connections", String(req.params.id));
    if (c.auth !== "oauth") throw conflict("This connection does not use OAuth.");
    if (!c.endpoint) throw conflict("Add the server endpoint first.");
    const resolved = await resolveConfig(store, w, c);
    store.put(w, "connections", { ...store.get(w, "connections", c.id), oauthState: { ...(c.oauthState || {}), resolved } });
    const flow = {
      state: b64(randomBytes(32)),
      verifier: b64(randomBytes(48)),
      w,
      id: c.id,
      account,
      exp: Date.now() + LIFETIME,
    };
    const payload = b64(Buffer.from(JSON.stringify(flow)));
    res.cookie(COOKIE, `${payload}.${sign(key, payload)}`, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      maxAge: LIFETIME,
      path: "/api/oauth",
    });
    const url = new URL(resolved.authorizationUrl);
    const params: Record<string, string> = {
      ...resolved.authParams,
      response_type: "code",
      client_id: resolved.clientId,
      redirect_uri: resolved.redirect,
      state: flow.state,
      code_challenge: b64(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
    };
    if (resolved.scopes.length) params[resolved.scopeParam] = resolved.scopes.join(" ");
    if (resolved.resource) params.resource = resolved.resource;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    store.audit(w, identity.user, "connection.authorize-started", c.name);
    res.json({ url: url.toString() });
  });

  app.post("/api/connections/:id/oauth/disconnect", permit("configure"), (req, res) => {
    const { identity } = caller(req);
    const w = identity.workspace,
      c = store.get(w, "connections", String(req.params.id));
    dropOAuth(store, w, c.id);
    store.put(w, "connections", {
      ...c,
      status: c.endpoint ? "Not tested" : "Not configured",
      tools: [],
      error: null,
      oauthState: { ...(c.oauthState || {}), connected: false, expiresAt: null },
    });
    store.audit(w, identity.user, "connection.disconnected", c.name);
    res.json({ ok: true });
  });
}
