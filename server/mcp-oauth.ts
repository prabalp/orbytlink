// OrbytLink as an OAuth 2.1 authorization server for its own /mcp endpoint, so an agent needs
// nothing but https://app.orbytlink.com/mcp: it finds this server from the 401 on /mcp (RFC 9728),
// registers itself (RFC 7591), sends the person to sign in and approve, and gets tokens with PKCE.
// Claude, ChatGPT, Claude Code, Cursor, VS Code and other MCP clients all follow this flow.
//
// A grant is a row in access_tokens, so it is listed, given a tool mode and revoked exactly like
// a hand-made gateway token. Its access token lasts an hour; the refresh token rotates on every
// use and keeps the grant alive for 90 days after it was last used.
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Account } from "./auth.js";
import { identityFor } from "./orgs.js";
import { gatewayPermissions, type Identity } from "./schema.js";

const ACCESS_TTL = 60 * 60 * 1000;
const GRANT_TTL = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const REQUEST_TTL = 15 * 60 * 1000;
const SCOPE = "mcp";
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
export const origin = () => (process.env.APP_ORIGIN || "http://127.0.0.1:3100").replace(/\/$/, "");
export const resourceUrl = () => `${origin()}/mcp`;
export const resourceMetadataUrl = () => `${origin()}/.well-known/oauth-protected-resource/mcp`;

export function initializeOAuthServerTables(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect_uris TEXT NOT NULL,secret_hash TEXT,auth_method TEXT NOT NULL,created_at INTEGER NOT NULL,last_used INTEGER);
CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes(code_hash TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);`);
  // The grant columns on access_tokens are added in initializeAuthTables, next to the others.
}

function sweep(store: Store) {
  const now = Date.now();
  store.transaction(() => {
    store.db.prepare("DELETE FROM oauth_requests WHERE expires<=?").run(now);
    store.db.prepare("DELETE FROM oauth_codes WHERE expires<=?").run(now);
    // Registrations nobody finished signing in with within a week.
    store.db
      .prepare("DELETE FROM oauth_clients WHERE last_used IS NULL AND created_at<? AND id NOT IN (SELECT client_id FROM access_tokens WHERE client_id IS NOT NULL)")
      .run(now - 7 * 24 * 60 * 60 * 1000);
  });
}

// Web clients use https; desktop and CLI clients use a loopback address or their own URL scheme
// (cursor://, vscode://). Never script, data or file URLs, and never fragments.
const blockedSchemes = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);
const loopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
export function redirectAllowed(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || value.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return loopback(u);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !blockedSchemes.has(u.protocol);
}
// RFC 8252: a loopback redirect may use any port, since native apps pick a free one at run time.
function redirectMatches(registered: string[], value: string) {
  if (registered.includes(value)) return true;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || !loopback(u)) return false;
  return registered.some((r) => {
    const x = new URL(r);
    return x.protocol === "http:" && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
  });
}

type Client = { id: string; name: string; redirect_uris: string; secret_hash: string | null; auth_method: string };
type Pending = { clientId: string; redirectUri: string; challenge: string; state?: string; resource: string };
type Code = Pending & { accountId: string; workspace: string; toolMode: string };

const registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_uri: z.string().max(2000).optional(),
  logo_uri: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
});

// Clients name the resource they want a token for (RFC 8707). Accept the MCP URL or the bare origin.
function resourceOk(value: unknown) {
  if (value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  const v = value.replace(/\/$/, "");
  return v === resourceUrl() || v === origin();
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

export function configureMcpOAuth(app: Express, store: Store) {
  initializeOAuthServerTables(store);
  sweep(store);
  setInterval(() => {
    try {
      sweep(store);
    } catch {
      // The database is closing; nothing to sweep.
    }
  }, 60 * 60 * 1000).unref();
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const tokenLimit = rateLimit({ windowMs: 60_000, limit: 60, message: { error: "slow_down", error_description: "Too many requests" } });
  const registerLimit = rateLimit({ windowMs: 60 * 60_000, limit: 30, message: { error: "slow_down", error_description: "Too many registrations" } });

  // Discovery. Clients look for these at the MCP URL's path first, then at the root.
  const protectedResource = (_req: Request, res: Response) =>
    res.json({
      resource: resourceUrl(),
      authorization_servers: [origin()],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "OrbytLink",
      resource_documentation: `${origin()}/#connect-agents`,
    });
  const authorizationServer = (_req: Request, res: Response) =>
    res.json({
      issuer: origin(),
      authorization_endpoint: `${origin()}/oauth/authorize`,
      token_endpoint: `${origin()}/oauth/token`,
      registration_endpoint: `${origin()}/oauth/register`,
      revocation_endpoint: `${origin()}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origin()}/#connect-agents`,
    });
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], protectedResource);
  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], authorizationServer);

  app.post("/oauth/register", registerLimit, (req, res) => {
    const parsed = registration.safeParse(req.body);
    if (!parsed.success) return oauthError(res, 400, "invalid_client_metadata", "Send JSON with redirect_uris.");
    const m = parsed.data;
    const bad = m.redirect_uris.find((u) => !redirectAllowed(u));
    if (bad) return oauthError(res, 400, "invalid_redirect_uri", "Redirect URIs must be https, a loopback http address, or an app's own scheme, without a fragment.");
    if (m.response_types && !m.response_types.includes("code"))
      return oauthError(res, 400, "invalid_client_metadata", "Only the code response type is supported.");
    // Public clients (PKCE alone) unless the client asks for a secret.
    const method = m.token_endpoint_auth_method === "client_secret_post" || m.token_endpoint_auth_method === "client_secret_basic" ? m.token_endpoint_auth_method : "none";
    const id = `olc_${randomBytes(18).toString("base64url")}`,
      clientSecret = method === "none" ? undefined : secret("olcs_"),
      now = Date.now(),
      name = m.client_name || new URL(m.redirect_uris[0]).hostname || "MCP client";
    store.db
      .prepare("INSERT INTO oauth_clients(id,name,redirect_uris,secret_hash,auth_method,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, name, JSON.stringify(m.redirect_uris), clientSecret ? digest(clientSecret) : null, method, now);
    res.status(201).json({
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: m.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    });
  });

  const client = (id: unknown) =>
    typeof id === "string" ? (store.db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(id) as Client | undefined) : undefined;

  // The browser arrives here from the agent. Bad client or redirect: never redirect, explain in the
  // console instead. Anything else wrong goes back to the agent as an OAuth error.
  app.get("/oauth/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const c = client(q.client_id);
    if (!c) return void res.redirect("/#authorize-error=unknown-client");
    const registered = JSON.parse(c.redirect_uris) as string[];
    const redirectUri = q.redirect_uri ?? (registered.length === 1 ? registered[0] : undefined);
    if (!redirectUri || !redirectMatches(registered, redirectUri)) return void res.redirect("/#authorize-error=bad-redirect");
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", origin());
      res.redirect(u.toString());
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge))
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!resourceOk(q.resource)) return back("invalid_target", `This server issues tokens for ${resourceUrl()} only.`);
    const id = randomBytes(24).toString("base64url");
    const pending: Pending = { clientId: c.id, redirectUri, challenge: q.code_challenge, state: q.state?.slice(0, 1000), resource: resourceUrl() };
    store.db.prepare("INSERT INTO oauth_requests(id,data,expires) VALUES(?,?,?)").run(id, JSON.stringify(pending), Date.now() + REQUEST_TTL);
    res.redirect(`/#authorize=${id}`);
  });

  const pendingRequest = (id: string) => {
    const row = store.db.prepare("SELECT data FROM oauth_requests WHERE id=? AND expires>?").get(id, Date.now()) as { data: string } | undefined;
    if (!row) throw Object.assign(new Error("This sign-in request has expired. Start connecting again from your agent."), { status: 404, safe: true });
    const p = JSON.parse(row.data) as Pending;
    const c = client(p.clientId);
    if (!c) throw Object.assign(new Error("This agent is no longer registered. Start connecting again from your agent."), { status: 404, safe: true });
    return { p, c };
  };
  const describeRequest = (id: string) => {
    const { p, c } = pendingRequest(id);
    const u = new URL(p.redirectUri);
    return { client: c.name, destination: u.protocol === "https:" || u.protocol === "http:" ? u.host : `${u.protocol.replace(/:$/, "")} app` };
  };
  // Shown on the sign-in screen before the person signs in: only the agent's name and where it returns.
  app.get("/api/oauth/requests/:id", (req, res, next) => {
    try {
      res.json(describeRequest(String(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  const decision = z.object({
    allow: z.boolean(),
    workspace: z.string().max(100).optional(),
    toolMode: z.enum(["auto", "all", "search"]).default("auto"),
  });
  // Mounted after the session check: only a person signed in to the console can answer.
  const answer = (req: Request, res: Response) => {
    const identity = res.locals.identity as Identity;
    const accountId = (req.user as { id?: string } | undefined)?.id;
    if (identity.authMethod !== "email" || !accountId) {
      res.status(403).json({ error: "Sign in to OrbytLink to approve an agent." });
      return;
    }
    const id = String(req.params.id);
    const { p, c } = pendingRequest(id);
    const input = decision.parse(req.body);
    store.db.prepare("DELETE FROM oauth_requests WHERE id=?").run(id);
    const u = new URL(p.redirectUri);
    if (p.state) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", origin());
    if (!input.allow) {
      u.searchParams.set("error", "access_denied");
      u.searchParams.set("error_description", "The person declined.");
      res.json({ redirect: u.toString() });
      return;
    }
    const account = store.db.prepare("SELECT * FROM accounts WHERE id=? AND disabled=0").get(accountId) as Account | undefined;
    const workspace = input.workspace || identity.workspace;
    const who = account && identityFor(store, account, workspace);
    if (!who) {
      res.status(403).json({ error: "You are not a member of that workspace." });
      return;
    }
    const code = secret("olac_");
    const data: Code = { ...p, accountId, workspace, toolMode: input.toolMode };
    store.db.prepare("INSERT INTO oauth_codes(code_hash,data,expires) VALUES(?,?,?)").run(digest(code), JSON.stringify(data), Date.now() + CODE_TTL);
    store.db.prepare("UPDATE oauth_clients SET last_used=? WHERE id=?").run(Date.now(), c.id);
    store.audit(workspace, who.email || who.user, "agent.authorized", c.name);
    u.searchParams.set("code", code);
    res.json({ redirect: u.toString() });
  };

  // Client authentication at the token and revocation endpoints: HTTP Basic, form fields, or none.
  const authenticateClient = (req: Request): Client | undefined => {
    let id = req.body?.client_id as string | undefined,
      given = req.body?.client_secret as string | undefined;
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization || "")?.[1];
    if (basic) {
      const [u, s] = Buffer.from(basic, "base64").toString().split(":");
      id = decodeURIComponent(u || "");
      given = decodeURIComponent(s || "");
    }
    const c = client(id);
    if (!c) return;
    if (c.secret_hash) {
      if (!given) return;
      const a = Buffer.from(digest(given)),
        b = Buffer.from(c.secret_hash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return;
    }
    return c;
  };
  const issue = (res: Response, grantId: string) => {
    const access = secret("ol_"),
      refresh = secret("olr_"),
      now = Date.now();
    store.db
      .prepare("UPDATE access_tokens SET token_hash=?,refresh_hash=?,access_expires=?,expires=? WHERE id=?")
      .run(digest(access), digest(refresh), now + ACCESS_TTL, now + GRANT_TTL, grantId);
    res.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: SCOPE });
  };

  app.post("/oauth/token", tokenLimit, form, (req, res) => {
    const b = (req.body || {}) as Record<string, string | undefined>;
    const c = authenticateClient(req);
    if (!c) return oauthError(res, 401, "invalid_client", "Unknown client or wrong client secret.");
    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier) return oauthError(res, 400, "invalid_request", "code and code_verifier are required.");
      // Single use: the code is gone whether or not the exchange succeeds.
      const row = store.db.prepare("DELETE FROM oauth_codes WHERE code_hash=? AND expires>? RETURNING data").get(digest(b.code), Date.now()) as
        | { data: string }
        | undefined;
      const code = row && (JSON.parse(row.data) as Code);
      if (!code || code.clientId !== c.id) return oauthError(res, 400, "invalid_grant", "The code is invalid, used or expired.");
      if (b.redirect_uri !== undefined && b.redirect_uri !== code.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match.");
      if (createHash("sha256").update(b.code_verifier).digest("base64url") !== code.challenge)
        return oauthError(res, 400, "invalid_grant", "The code verifier does not match.");
      if (!resourceOk(b.resource)) return oauthError(res, 400, "invalid_target", `This server issues tokens for ${resourceUrl()} only.`);
      const account = store.db.prepare("SELECT * FROM accounts WHERE id=? AND disabled=0").get(code.accountId) as Account | undefined;
      if (!account || !identityFor(store, account, code.workspace)) return oauthError(res, 400, "invalid_grant", "The account can no longer use that workspace.");
      const grantId = randomUUID(),
        now = Date.now();
      store.transaction(() => {
        // Reconnecting the same agent replaces its earlier grant instead of piling up rows.
        store.db.prepare("DELETE FROM access_tokens WHERE client_id=? AND account_id=? AND workspace=?").run(c.id, account.id, code.workspace);
        store.db
          .prepare(
            "INSERT INTO access_tokens(token_hash,account_id,expires,permissions,id,name,created_at,last_used,workspace,tool_mode,client_id) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)",
          )
          .run(digest(secret("pending_")), account.id, now + GRANT_TTL, JSON.stringify(gatewayPermissions), grantId, c.name, now, code.workspace, code.toolMode, c.id);
      });
      return issue(res, grantId);
    }
    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) return oauthError(res, 400, "invalid_request", "refresh_token is required.");
      const grant = store.db
        .prepare("SELECT t.id,t.account_id,t.workspace FROM access_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.refresh_hash=? AND t.client_id=? AND t.expires>? AND a.disabled=0")
        .get(digest(b.refresh_token), c.id, Date.now()) as { id: string; account_id: string; workspace: string } | undefined;
      if (!grant) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid, revoked or expired. Connect the agent again.");
      return issue(res, grant.id);
    }
    return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  // RFC 7009: always 200, whether or not the token was known.
  app.post("/oauth/revoke", tokenLimit, form, (req, res) => {
    const c = authenticateClient(req);
    if (!c) return oauthError(res, 401, "invalid_client", "Unknown client or wrong client secret.");
    const token = String(req.body?.token || "");
    if (token) store.db.prepare("DELETE FROM access_tokens WHERE client_id=? AND (token_hash=? OR refresh_hash=?)").run(c.id, digest(token), digest(token));
    res.status(200).end();
  });

  return { answer };
}

// Agents (and the browser-based MCP Inspector) call discovery, token and /mcp from other origins.
// None of these use cookies, so any origin may call them; the console's own routes stay same-origin.
const corsPaths = /^\/(\.well-known\/oauth-|oauth\/(token|register|revoke)$|mcp$)/;
export function mcpCors(req: Request, res: Response, next: NextFunction) {
  if (!corsPaths.test(req.path)) return next();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return void res.status(204).end();
  next();
}
// Cross-origin POSTs are allowed where no cookie is involved: the OAuth endpoints, and /mcp with a token.
export function crossOriginAllowed(req: Request) {
  if (/^\/oauth\/(token|register|revoke)$/.test(req.path)) return true;
  // The browser extension authenticates with a pairing code or its own bearer token, never a cookie.
  if (/^\/api\/device\/(register|poll|result)$/.test(req.path)) return true;
  const auth = req.headers.authorization || "";
  return req.path === "/mcp" && /^Bearer /.test(auth) && auth !== "Bearer cookie-session";
}
