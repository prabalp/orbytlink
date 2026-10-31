import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
import { Store, type Row } from "./store.js";
import { configureEmailAuth, derive } from "./auth.js";
import { configureOAuthCallback, configureOAuthRoutes, credentialFor, dropOAuth, redirectUri } from "./oauth.js";
import { adapters, type ServiceAdapters } from "./adapters.js";
import { gatewayServer, gatewayTools } from "./gateway.js";
import { configureOrgs, describe, syncOrgName } from "./orgs.js";
import { skillCatalog, skillText } from "./skills.js";
import { runWorkflow, saveWorkflow } from "./workflows.js";
import { apiCall, apiSchema, fetchDocs, fetchLogo, ingestDocs, publicApi } from "./apis.js";
import {
  connectionSchema,
  settingsSchema,
  tokenSchema,
  allPermissions,
  type Identity,
} from "./schema.js";
export function createApp(
  store = new Store(),
  services: ServiceAdapters = adapters,
) {
  const app = express();
  const dev = process.env.NODE_ENV !== "production";
  const jwks = process.env.OIDC_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL))
    : undefined;
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader("Cache-Control", "no-store");
    if (!dev) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", rateLimit({ windowMs: 60000, limit: 180 }));
  // MCP clients such as Claude share egress IPs across many users; limit per credential.
  app.use(
    "/mcp",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      keyGenerator: (req) =>
        req.headers.authorization
          ? createHash("sha256").update(req.headers.authorization).digest("hex")
          : ipKeyGenerator(req.ip || "127.0.0.1"),
    }),
  );
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== (process.env.APP_ORIGIN || "http://127.0.0.1:3100")
      ) {
        res.status(403).json({ error: "Origin not permitted" });
        return;
      }
    }
    next();
  });
  const emailAuth = configureEmailAuth(app, store);
  const oauthKey = derive(store, "orbytlink:oauth:v1");
  configureOAuthCallback(
    app,
    store,
    oauthKey,
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, message: { error: "Too many attempts. Try again later." } }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      product: "OrbytLink",
      authentication: "email-password",
      gateway: "/mcp",
    }),
  );
  async function verify(token: string): Promise<Identity> {
    let payload;
    try {
      if (token.startsWith("ol_")) {
        const identity = emailAuth.verifyAccessToken(token);
        if (!identity) throw new Error();
        return identity;
      }
      if (!payload) {
        if (!jwks || !process.env.OIDC_ISSUER || !process.env.OIDC_AUDIENCE)
          throw new Error();
        payload = (
          await jwtVerify(token, jwks, {
            issuer: process.env.OIDC_ISSUER,
            audience: process.env.OIDC_AUDIENCE,
            algorithms: ["RS256", "ES256"],
            maxTokenAge: "1h",
          })
        ).payload;
      }
      if (
        !payload.sub ||
        typeof payload.workspace !== "string" ||
        !Array.isArray(payload.permissions) ||
        !payload.exp ||
        payload.exp - (payload.iat || 0) > 3600
      )
        throw new Error();
      return {
        user: payload.sub,
        workspace: payload.workspace,
        permissions: payload.permissions.filter((p) =>
          allPermissions.includes(p),
        ),
        demo: false,
        authMethod: "oidc",
        displayName:
          typeof payload.name === "string" ? payload.name : payload.sub,
      };
    } catch {
      throw Object.assign(new Error("Authentication required"), {
        status: 401,
      });
    }
  }
  app.use(["/api", "/mcp"], async (req, res, next) => {
    try {
      const authorization = req.headers.authorization;
      const authenticated = authorization && authorization !== "Bearer cookie-session"
        ? await verify(authorization.replace(/^Bearer /, ""))
        : emailAuth.browserIdentity(req);
      if (!authenticated)
        throw Object.assign(new Error("Authentication required"), {
          status: 401,
        });
      res.locals.identity = authenticated;
      const i = res.locals.identity as Identity;
      store.seed(i.workspace);
      next();
    } catch (e) {
      next(e);
    }
  });
  configureOrgs(app, store);
  const identity = (res: Response) => res.locals.identity as Identity;
  const permit =
    (permission: string) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (!identity(res).permissions.includes(permission)) {
        res.status(403).json({ error: `${permission} permission required` });
        return;
      }
      next();
    };
  configureOAuthRoutes(app, store, oauthKey, permit);
  app.get("/api/state", permit("read"), (req, res) => {
    const i = identity(res);
    res.json(
      store.redact(i.workspace, {
        identity: i,
        settings: store.list(i.workspace, "settings"),
        connections: store.list(i.workspace, "connections"),
        audit: store.list(i.workspace, "audit").slice(0, 100),
        calls: store.list(i.workspace, "calls").slice(0, 100),
        oauthRedirectUri: redirectUri(),
        tokens: emailAuth.listTokens(req),
        skills: skillCatalog(store, i.workspace),
        workflows: store.list(i.workspace, "workflows"),
        workflowRuns: store.list(i.workspace, "workflow_runs").slice(0, 50),
        apis: store.list(i.workspace, "apis").map(publicApi),
        apiCalls: store.list(i.workspace, "api_calls").slice(0, 50),
        ...describe(store, (req.user as any)?.id, i),
        gatewayTools: gatewayTools(store, i.workspace).map((t) => ({
          name: t.name,
          connectionId: t.connection.id,
          tool: t.tool.name,
        })),
      }),
    );
  });
  app.post("/api/tokens", permit("call"), (req, res) => {
    if (identity(res).authMethod !== "email") {
      res.status(403).json({ error: "Sign in with your account to create gateway tokens." });
      return;
    }
    const input = tokenSchema.parse(req.body);
    res.json(emailAuth.createToken(req, input.name, input.expiresInDays));
  });
  app.delete("/api/tokens/:id", permit("call"), (req, res) => {
    emailAuth.revokeToken(req, String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/connections", permit("configure"), (req, res) =>
    saveConnection(req, res),
  );
  app.put("/api/connections/:id", permit("configure"), (req, res) =>
    saveConnection(req, res),
  );
  app.delete("/api/connections/:id", permit("configure"), (req, res) => {
    const i = identity(res);
    const c = store.get(i.workspace, "connections", String(req.params.id));
    // Removing a connection also destroys its encrypted credential.
    store.remove(i.workspace, "connections", c.id);
    store.audit(i.workspace, i.user, "connection.removed", c.name);
    res.json({ ok: true });
  });
  function saveConnection(req: Request, res: Response) {
    const i = identity(res),
      w = i.workspace;
    const data = connectionSchema.parse(req.body);
    const existing = req.params.id
      ? store.get(w, "connections", String(req.params.id))
      : undefined;
    const { secret, clientSecret, ...safe } = data;
    // Changing who we sign in to (or how) invalidates the authorization already granted.
    const oauthChanged =
      !!existing &&
      JSON.stringify([existing.auth, existing.endpoint, existing.oauth ?? null]) !==
        JSON.stringify([safe.auth, safe.endpoint, safe.oauth ?? null]);
    if (oauthChanged) dropOAuth(store, w, existing!.id, !clientSecret);
    // Any change to where or how we connect must be verified again before clients see it.
    const row = store.put(w, "connections", {
      ...safe,
      id: existing?.id,
      disabledTools:
        "disabledTools" in (req.body || {})
          ? safe.disabledTools
          : existing?.disabledTools || [],
      status: safe.endpoint ? "Not tested" : "Not configured",
      tools: [],
      protocol: safe.kind === "auto" ? null : safe.kind,
      hasSecret: secret ? true : !!existing?.hasSecret,
      hasClientSecret: clientSecret ? true : oauthChanged ? false : !!existing?.hasClientSecret,
      oauthState: oauthChanged ? undefined : existing?.oauthState,
      lastChecked: null,
      error: null,
    });
    if (secret) store.secret(w, row.id, secret);
    if (clientSecret) store.secret(w, `${row.id}:oauth-client`, clientSecret);
    store.audit(w, i.user, existing ? "connection.updated" : "connection.added", row.name);
    res.json(row);
  }
  app.put("/api/connections/:id/tools", permit("configure"), (req, res) => {
    const i = identity(res),
      w = i.workspace,
      c = store.get(w, "connections", String(req.params.id));
    const { disabledTools } = z
      .object({ disabledTools: z.array(z.string().max(200)).max(500) })
      .parse(req.body);
    const known = new Set((c.tools || []).map((t: Row) => t.name));
    const row = store.put(w, "connections", {
      ...c,
      disabledTools: disabledTools.filter((t) => known.has(t)),
    });
    store.audit(w, i.user, "connection.tools-changed", c.name);
    res.json(row);
  });
  app.post(
    "/api/connections/:id/test",
    permit("configure"),
    async (req, res) => {
      const i = identity(res),
        w = i.workspace,
        c = store.get(w, "connections", String(req.params.id));
      if (!c.enabled) throw new Error("Enable the connection before testing");
      let next;
      try {
        if (!c.endpoint) throw new Error("Endpoint is not configured");
        const { protocol, tools } = await services.test(
          c,
          await credentialFor(store, w, c),
        );
        next = {
          ...c,
          status: "Connected",
          protocol,
          tools,
          lastChecked: new Date().toISOString(),
          error: null,
        };
      } catch (error) {
        const message = (error as Error).message;
        next = {
          ...c,
          status: c.endpoint ? "Error" : "Not configured",
          lastChecked: new Date().toISOString(),
          error: !c.endpoint
            ? "Add an endpoint to test this connection."
            : /OUTBOUND_HOSTS|Private and reserved|^Authorization/.test(message)
              ? `${message.replace(/\.$/, "")}.`
              : "Verification failed. Check the endpoint, authentication, and that the server is reachable.",
          protocol: c.kind === "auto" ? null : c.kind,
          tools: [],
        };
      }
      store.put(w, "connections", next);
      store.audit(w, i.user, "connection.tested", `${c.name} · ${next.status}`);
      res.json(next);
    },
  );
  app.get("/api/skills/:id", permit("read"), (req, res) => {
    const text = skillText(String(req.params.id));
    if (!text) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json({ id: req.params.id, text });
  });
  // Enabling a skill makes it available to every agent connected to this workspace.
  app.put("/api/skills/:id", permit("configure"), (req, res) => {
    const i = identity(res),
      id = String(req.params.id);
    if (!skillText(id)) throw Object.assign(new Error("Record not found"), { status: 404 });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    store.put(i.workspace, "skills", { id, enabled });
    store.audit(i.workspace, i.user, enabled ? "skill.enabled" : "skill.disabled", id);
    res.json({ ok: true });
  });
  app.post("/api/workflows", permit("configure"), (req, res) => {
    const source = req.body?.source === "template" ? "template" : "console";
    res.json(saveWorkflow(store, identity(res), req.body, undefined, source));
  });
  app.put("/api/workflows/:id", permit("configure"), (req, res) => {
    const i = identity(res);
    res.json(saveWorkflow(store, i, req.body, store.get(i.workspace, "workflows", String(req.params.id))));
  });
  app.delete("/api/workflows/:id", permit("configure"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    store.remove(i.workspace, "workflows", wf.id);
    store.audit(i.workspace, i.user, "workflow.deleted", wf.name);
    res.json({ ok: true });
  });
  // Running uses the same tools agents can call, so members (who can call tools) may run.
  app.post("/api/workflows/:id/run", permit("call"), async (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    // Drafts (including agent-written ones) run only for people who can review them.
    if (!wf.enabled && !i.permissions.includes("configure"))
      throw Object.assign(new Error("This workflow is a draft. An admin must enable it first."), { status: 403 });
    const inputs = z.record(z.string(), z.string().max(4000)).default({}).parse(req.body?.inputs);
    res.json(await runWorkflow(store, services, i, wf, inputs, "console"));
  });
  async function saveApi(req: Request, res: Response) {
    const i = identity(res),
      w = i.workspace;
    const existing = req.params.id ? store.get(w, "apis", String(req.params.id)) : undefined;
    const { key, docsText, ...data } = apiSchema.parse(req.body);
    // A saved key only ever goes to the host it was saved for: moving the API elsewhere drops it.
    const moved = !!existing && new URL(existing.baseUrl).origin !== new URL(data.baseUrl).origin;
    if (moved) store.deleteSecret(w, existing!.id);
    // Looked up once per host, alongside the docs; a miss is remembered as null.
    const logo = !existing || moved || existing.logo === undefined ? fetchLogo(data.baseUrl).catch(() => null) : existing.logo;
    let docs: Record<string, unknown> = {};
    let docsError: string | null = null;
    if (docsText?.trim()) docs = ingestDocs(docsText, "pasted");
    else if (data.docsUrl && data.docsUrl !== existing?.docsUrl)
      try {
        docs = await fetchDocs(data.docsUrl);
      } catch (error) {
        docsError = /OUTBOUND_HOSTS|Private and reserved|answered \d+/.test((error as Error).message)
          ? (error as Error).message
          : "The docs could not be fetched.";
      }
    const hasKey = key ? true : moved ? false : !!existing?.hasKey;
    const row = store.put(w, "apis", {
      ...(existing || {}),
      ...data,
      ...docs,
      logo: await logo,
      docsError: docsError ?? (Object.keys(docs).length ? null : existing?.docsError ?? null),
      hasKey,
      keyHint: key ? (key.length >= 12 ? key.slice(-4) : null) : moved ? null : existing?.keyHint ?? null,
      keyUpdatedAt: key ? new Date().toISOString() : moved ? null : existing?.keyUpdatedAt ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    if (key) store.secret(w, row.id, key);
    store.audit(w, i.user, existing ? (key ? "api.key-rotated" : "api.updated") : "api.added", row.name);
    res.json(publicApi(row));
  }
  app.post("/api/apis", permit("configure"), saveApi);
  app.put("/api/apis/:id", permit("configure"), saveApi);
  app.delete("/api/apis/:id", permit("configure"), (req, res) => {
    const i = identity(res),
      a = store.get(i.workspace, "apis", String(req.params.id));
    // Removing an API destroys its encrypted key with it.
    store.remove(i.workspace, "apis", a.id);
    store.audit(i.workspace, i.user, "api.removed", a.name);
    res.json({ ok: true });
  });
  app.post("/api/apis/:id/docs", permit("configure"), async (req, res) => {
    const i = identity(res),
      a = store.get(i.workspace, "apis", String(req.params.id));
    if (!a.docsUrl) throw Object.assign(new Error("Add a docs URL first."), { status: 409 });
    let docs;
    try {
      docs = await fetchDocs(a.docsUrl);
    } catch (error) {
      const m = (error as Error).message;
      throw Object.assign(new Error(/OUTBOUND_HOSTS|Private and reserved|answered \d+/.test(m) ? m : "The docs could not be fetched."), { status: 409 });
    }
    res.json(publicApi(store.put(i.workspace, "apis", { ...a, ...docs, docsError: null })));
  });
  app.get("/api/apis/:id/docs", permit("read"), (req, res) => {
    const a = store.get(identity(res).workspace, "apis", String(req.params.id));
    res.json({ endpoints: a.endpoints || [], docs: String(a.docs || "").slice(0, 60_000), format: a.docsFormat || null });
  });
  // The console's "Try a request": the same guarded path agents use, key attached on the server.
  app.post("/api/apis/:id/request", permit("call"), async (req, res) => {
    const i = identity(res),
      a = store.get(i.workspace, "apis", String(req.params.id));
    const out = await apiCall(store, i.workspace, a, req.body);
    store.audit(i.workspace, i.user, "api.request", `${a.name} · ${req.body?.method || "GET"} ${req.body?.path || "/"} · ${out.status}`);
    res.json(out);
  });
  app.put("/api/settings", permit("configure"), (req, res) => {
    const i = identity(res),
      s = settingsSchema.parse(req.body);
    store.put(i.workspace, "settings", { ...s, id: "workspace" });
    if (i.org) syncOrgName(store, i.workspace, s.name);
    store.audit(i.workspace, i.user, "workspace.updated", "workspace");
    res.json({ ok: true });
  });
  app.post("/mcp", async (req, res) => {
    const server = gatewayServer(store, services, identity(res));
    // Stateless Streamable HTTP: every request is authenticated on its own.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) =>
    res.status(405).json({ error: "Use Streamable HTTP POST" }),
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);
  return { app, store };
}
export function errorHandler(error: any, req: Request, res: Response, _next: NextFunction) {
  // Bugs (TypeError and the like) are server errors; plain Errors are input/configuration problems.
  const bug = [TypeError, ReferenceError, RangeError].some((t) => error instanceof t);
  const status = error instanceof z.ZodError ? 400 : error.status || (bug ? 500 : 400);
  // Anything without a deliberate status is unexpected: log it. Never the body, which may hold secrets.
  if (!(error instanceof z.ZodError) && (!error.status || status >= 500))
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${status}`, error?.stack || error);
  if (res.headersSent) return;
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      : status === 401
        ? "Authentication required"
        : status === 404
          ? "Record not found"
          : status === 403 || status === 409
            ? error.message
            : status >= 500
              ? "Something went wrong on the server. It has been logged."
              : "Request failed. Check input and configuration.";
  res.status(status).json({ error: message });
}
