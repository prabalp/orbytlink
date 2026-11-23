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
import path from "node:path";
import { Store, type Row } from "./store.js";
import { configureEmailAuth, derive } from "./auth.js";
import { configureOAuthCallback, configureOAuthRoutes, credentialFor, dropOAuth, redirectUri } from "./oauth.js";
import { adapters, type ServiceAdapters } from "./adapters.js";
import { configureMcpOAuth, crossOriginAllowed, mcpCors, resourceMetadataUrl } from "./mcp-oauth.js";
import { API_REQUEST_TOOL, enabledApis, gatewayServer, gatewayTools, visibleWorkflowTools } from "./gateway.js";
import { configureOrgs, describe, syncOrgName } from "./orgs.js";
import { addSkill, libraryEntry, removeSkill, skillCatalog, skillText } from "./skills.js";
import { authoredDetail, createAuthored, deleteAuthored, initializeLibrary, libraryCount, librarySearch, updateAuthored, viewerFor, type Scope } from "./library.js";
import { MIN_INSTALLS, searchRegistry } from "./skill-registry.js";
import { AI_TOOL, aiConfigured, aiSummary, generate, saveAiSettings } from "./ai.js";
import { BROWSER_TOOL, browserConfigured, browserSummary } from "./browser.js";
import { configureDevices, deviceSummary, removeDevice, startPairing } from "./devices.js";
import { catalogUpdatedAt, ensureCatalog, publicModels } from "./catalog.js";
import { workspaceUsage } from "./ledger.js";
import { configureAdmin, isOperator } from "./admin.js";
import { MAPS_TOOL, SCRAPE_TOOL, scraperConfigured, scraperSummary } from "./scraper.js";
import { INSTANT_CALL, instantConfigured, instantPlatform, instantPlatforms } from "./instant.js";
import { BUNDLES, cashfreeConfigured, cashfreeMode, createOrder, currenciesFor, dodoMode, dodoOrderFrom, listPayments, orderIdFrom, paymentsConfigured, providerFor, quote, settle, validSignature } from "./payments.js";
import { alreadySaved, captureWorkflow, dismissSuggestion, keyFor, suggestionsFor } from "./capture.js";
import { fromMarkdown, toMarkdown, workflowFileName } from "./workflow-md.js";
import { clearCache, forgetState, forgetWorkflowData, listState, stepLogs } from "./workflow-data.js";
import { continueRun, forgetResults, initializeWorkflows, lastResult, listedFor, manageable, resumeWorkflow, runWorkflow, saveWorkflow, unschedule, visibleTo } from "./workflows.js";
import { apiCall, apiSchema, fetchDocs, fetchLogo, ingestDocs, publicApi } from "./apis.js";
import { channelSummary } from "./social.js";
import {
  connectionSchema,
  settingsSchema,
  tokenSchema,
  tokenUpdateSchema,
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
        "default-src 'self'; script-src 'self' https://sdk.cashfree.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://sdk.cashfree.com https://api.cashfree.com https://sandbox.cashfree.com; frame-src https://sdk.cashfree.com; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    next();
  });
  // Brand icons, public and cacheable: clients such as Claude.ai pick the connector icon from
  // this host's favicon. The files live in public/ (copied to dist/ by the Vite build).
  const ICONS: Record<string, [file: string, type: string]> = {
    "/favicon.ico": ["favicon.ico", "image/x-icon"],
    "/favicon.png": ["favicon-128x128.png", "image/png"],
    "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
    "/icon.svg": ["icon.svg", "image/svg+xml"],
    ...Object.fromEntries([32, 48, 64, 128, 256].map((s) => [`/favicon-${s}x${s}.png`, [`favicon-${s}x${s}.png`, "image/png"]])),
  };
  const iconRoot = path.resolve(dev ? "public" : "dist");
  app.get(Object.keys(ICONS), (req, res, next) => {
    const [file, type] = ICONS[req.path];
    res.sendFile(file, {
      root: iconRoot,
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
      cacheControl: false,
    }, (error) => error && next(error));
  });
  // The payment webhook is signed over the raw body, so keep it for that one route.
  app.use(express.json({ limit: "256kb", verify: (req: any, _res, buf) => { if (req.url?.startsWith("/api/payments/webhook") || req.url?.startsWith("/api/payments/dodo/webhook")) req.rawBody = buf.toString("utf8"); } }));
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
  app.use(mcpCors);
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !crossOriginAllowed(req)) {
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
  // Agents sign in to /mcp with OAuth; registered before the session check below on purpose.
  const mcpOAuth = configureMcpOAuth(app, store);
  initializeLibrary(store);
  ensureCatalog(store);
  initializeWorkflows(store);
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
  // Cashfree calls this when an order's payment changes. It has no session, so the signature is the
  // only credential; and it only names an order, which settle() re-checks with Cashfree itself.
  app.post("/api/payments/webhook", async (req: any, res, next) => {
    try {
      if (!cashfreeConfigured()) return void res.status(404).json({ error: "Not found" });
      if (!validSignature(String(req.rawBody ?? ""), String(req.headers["x-webhook-timestamp"] ?? ""), String(req.headers["x-webhook-signature"] ?? "")))
        return void res.status(401).json({ error: "Bad signature" });
      const id = orderIdFrom(req.body);
      if (id) await settle(store, id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  // Dodo's webhook: same idea, Standard Webhooks signature. Answer 2xx for any verified event so Dodo
  // stops retrying; only events that name one of our orders lead to a check.
  app.post("/api/payments/dodo/webhook", async (req: any, res, next) => {
    try {
      if (!process.env.DODO_PAYMENTS_WEBHOOK_KEY) return void res.status(404).json({ error: "Not found" });
      const { ok, orderId } = dodoOrderFrom(String(req.rawBody ?? ""), req.headers);
      if (!ok) return void res.status(401).json({ error: "Bad signature" });
      if (orderId) await settle(store, orderId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  // The "Your browser" extension signs in with a pairing code, then its own device token.
  configureDevices(app, store, rateLimit({ windowMs: 60000, limit: 90 }));
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
      // Tell MCP clients where to sign in (RFC 9728); a rejected token is reported as invalid.
      if (req.baseUrl === "/mcp")
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resourceMetadataUrl()}", scope="mcp"${req.headers.authorization ? ', error="invalid_token"' : ""}`,
        );
      next(e);
    }
  });
  app.post("/api/oauth/requests/:id", mcpOAuth.answer);
  configureOrgs(app, store);
  // The operator's admin portal (/admin); a 404 to everyone else.
  configureAdmin(app, store);
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
        skills: skillCatalog(store, i.workspace, viewerFor(store, i)),
        workflows: listedFor(store, i),
        workflowRuns: store
          .list(i.workspace, "workflow_runs")
          .filter((r) => r.user === i.user || listedFor(store, i).some((wf) => wf.id === r.workflowId && visibleTo(wf, i)))
          .slice(0, 50),
        ai: aiSummary(store, i.workspace),
        browser: { ...browserSummary(store), configured: browserConfigured(store, i.workspace), devices: deviceSummary(store, i.workspace) },
        // Only the server's operators see the admin portal link.
        ...(isOperator(store, i) ? { operator: true } : {}),
        scraper: scraperSummary(store, i.workspace),
        instant: { configured: instantConfigured() },
        // Steps can also call stored APIs, AI models and other workflows, besides app tools.
        workflowStepTools: [
          ...(aiConfigured(store) ? [{ name: AI_TOOL, title: "Ask an AI model", app: "AI models", args: ["model", "prompt", "system", "maxTokens", "temperature", "json"] }] : []),
          ...(browserConfigured(store, i.workspace) ? [{ name: BROWSER_TOOL, title: "Use a web browser", app: "Browser", args: ["url", "goal", "values", "maxSteps", "where", "device"] }] : []),
          ...(enabledApis(store, i.workspace).length
            ? [{ name: API_REQUEST_TOOL, title: "Call a stored API", app: "APIs", args: ["api", "method", "path", "query", "body"], apis: enabledApis(store, i.workspace).map((a) => a.slug) }]
            : []),
          { name: SCRAPE_TOOL, title: "Scrape web pages", app: "Scraper", args: ["url", "urls", "contacts", "mode", "select", "waitFor"] },
          ...(scraperConfigured() ? [{ name: MAPS_TOOL, title: "Search Google Maps", app: "Scraper", args: ["query", "location", "maxResults"] }] : []),
          ...(instantConfigured() ? [{ name: INSTANT_CALL, title: "Call an instant tool", app: "Instant", args: ["id", "query", "body", "maxCost"] }] : []),
          ...visibleWorkflowTools(store, i).map((t) => ({ name: t.name, title: t.workflow.name, app: "Workflows", args: (t.workflow.inputs || []).map((x: { name: string }) => x.name) })),
        ],
        apis: store.list(i.workspace, "apis").map(publicApi),
        apiCalls: store.list(i.workspace, "api_calls").slice(0, 50),
        channels: channelSummary(store, i.workspace),
        ...describe(store, (req.user as any)?.id, i),
        gatewayTools: gatewayTools(store, i.workspace).map((t) => ({
          name: t.name,
          connectionId: t.connection.id,
          tool: t.tool.name,
        })),
      }),
    );
  });
  app.post("/api/devices/pair", permit("call"), (_req, res) => {
    const i = identity(res);
    res.json(startPairing(store, i.workspace, i.user));
  });
  app.delete("/api/devices/:id", permit("call"), (req, res) => {
    const i = identity(res);
    removeDevice(store, i.workspace, i.user, String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/tokens", permit("call"), (req, res) => {
    if (identity(res).authMethod !== "email") {
      res.status(403).json({ error: "Sign in with your account to create gateway tokens." });
      return;
    }
    const input = tokenSchema.parse(req.body);
    res.json(emailAuth.createToken(req, input.name, input.expiresInDays, input.toolMode));
  });
  app.put("/api/tokens/:id", permit("call"), (req, res) => {
    if (identity(res).authMethod !== "email") {
      res.status(403).json({ error: "Sign in with your account to change gateway tokens." });
      return;
    }
    emailAuth.updateToken(req, String(req.params.id), tokenUpdateSchema.parse(req.body).toolMode);
    res.json({ ok: true });
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
  async function saveConnection(req: Request, res: Response) {
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
    // The server's own site mark, looked up once (like an API's) and again only if it moves host.
    // A miss is remembered as null; an app from the catalog keeps its bundled brand mark instead.
    const movedHost = !!existing && !!existing.endpoint && !!safe.endpoint && new URL(existing.endpoint).hostname !== new URL(safe.endpoint).hostname;
    const logo = !safe.endpoint ? null : !existing || movedHost || existing.logo === undefined ? await fetchLogo(safe.endpoint).catch(() => null) : existing.logo;
    // Any change to where or how we connect must be verified again before clients see it.
    const row = store.put(w, "connections", {
      ...safe,
      id: existing?.id,
      logo,
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
      // Connections saved before logos existed get theirs on the next test, passed or not.
      const logo = c.logo === undefined ? (c.endpoint ? await fetchLogo(c.endpoint).catch(() => null) : null) : c.logo;
      let next;
      try {
        if (!c.endpoint) throw new Error("Endpoint is not configured");
        const { protocol, tools } = await services.test(
          c,
          await credentialFor(store, w, c),
        );
        next = {
          ...c,
          logo,
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
          logo,
        };
      }
      store.put(w, "connections", next);
      store.audit(w, i.user, "connection.tested", `${c.name} · ${next.status}`);
      res.json(next);
    },
  );
  app.get("/api/skills/:id", permit("read"), (req, res) => {
    const text = skillText(store, viewerFor(store, identity(res)), String(req.params.id));
    if (!text) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json({ id: req.params.id, text });
  });
  // Enabling a skill makes it available to every agent connected to this workspace.
  app.put("/api/skills/:id", permit("configure"), (req, res) => {
    const i = identity(res),
      id = String(req.params.id);
    // Only skills this admin can see may be turned on for their workspace.
    if (!skillText(store, viewerFor(store, i), id)) throw Object.assign(new Error("Record not found"), { status: 404 });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    store.put(i.workspace, "skills", { id, enabled });
    store.audit(i.workspace, i.user, enabled ? "skill.enabled" : "skill.disabled", id);
    res.json({ ok: true });
  });
  // Only skills added from skills.sh can be removed; bundled ones are just turned off.
  app.delete("/api/skills/:id", permit("configure"), (req, res) => {
    const i = identity(res),
      id = String(req.params.id);
    if (!store.list(i.workspace, "skills").some((r) => r.id === id)) throw Object.assign(new Error("Record not found"), { status: 404 });
    removeSkill(store, i.workspace, i.user, id);
    res.json({ ok: true });
  });
  // Members may keep private workflows of their own; saveWorkflow enforces who may change what.
  app.post("/api/workflows", permit("call"), (req, res) => {
    const source = req.body?.source === "template" ? "template" : "console";
    res.json(saveWorkflow(store, identity(res), req.body, undefined, source));
  });
  app.put("/api/workflows/:id", permit("call"), (req, res) => {
    const i = identity(res);
    // ?fix=apply: this save is the reviewed version of an agent's proposed fix, so the proposal goes.
    res.json(saveWorkflow(store, i, req.body, store.get(i.workspace, "workflows", String(req.params.id)), "console", req.query.fix === "apply"));
  });
  app.delete("/api/workflows/:id", permit("call"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!manageable(wf, i)) throw Object.assign(new Error("Only an admin or the workflow's owner can delete it."), { status: 403 });
    store.remove(i.workspace, "workflows", wf.id);
    forgetResults(store, i.workspace, wf.id);
    forgetWorkflowData(store, wf.id);
    unschedule(store, wf.id);
    store.audit(i.workspace, i.user, "workflow.deleted", wf.name);
    res.json({ ok: true });
  });
  // Turn down a fix an agent proposed; the workflow stays as it is. (Applying it is a normal save.)
  app.delete("/api/workflows/:id/proposal", permit("call"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!manageable(wf, i)) throw Object.assign(new Error("Only an admin or the workflow's owner can do this."), { status: 403 });
    const { proposal: _dropped, ...rest } = wf;
    store.put(i.workspace, "workflows", rest);
    store.audit(i.workspace, i.user, "workflow.fix-dismissed", wf.name);
    res.json({ ok: true });
  });
  // Running uses the same tools agents can call, so members (who can call tools) may run.
  app.post("/api/workflows/:id/run", permit("call"), async (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!visibleTo(wf, i)) throw Object.assign(new Error("Record not found"), { status: 404 });
    // Drafts (including agent-written ones) run only for people who can review them.
    if (!wf.enabled && !manageable(wf, i))
      throw Object.assign(new Error("This workflow is a draft. An admin must enable it first."), { status: 403 });
    const inputs = z.record(z.string(), z.string().max(4000)).default({}).parse(req.body?.inputs);
    res.json(await runWorkflow(store, services, i, wf, inputs, "console"));
  });
  // The shared skill library: searched a page at a time, never sent whole.
  app.get("/api/library", permit("read"), (req, res) => {
    const i = identity(res);
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const page = Math.max(0, Math.min(1000, Number(req.query.page) || 0));
    const scope = (["all", "mine", "shared", "public"].includes(String(req.query.scope)) ? req.query.scope : "all") as Scope;
    const viewer = viewerFor(store, i);
    const on = new Map(store.list(i.workspace, "skills").map((r) => [r.id, !!r.enabled]));
    const found = librarySearch(store, q, viewer, { limit: 30, offset: page * 30, scope });
    res.json({ total: found.total, all: libraryCount(store, viewer), page, items: found.items.map((l) => libraryEntry(l, on.get(l.id) ?? false, viewer)) });
  });
  // skills.sh results for the same words, minus what the library already has.
  app.get("/api/library/registry", permit("read"), async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    if (!q) return void res.json({ items: [] });
    const have = new Set(librarySearch(store, q, viewerFor(store, identity(res)), { limit: 50, scope: "public" }).items.map((l) => `${l.repo}/${l.skill}`.toLowerCase()));
    try {
      const items = (await searchRegistry(q, 12))
        .filter((r) => !have.has(`${r.repo}/${r.skill}`.toLowerCase()))
        .map((r) => ({ skill: `${r.repo}@${r.skill}`, name: r.name, repo: r.repo, installs: r.installs, canAdd: r.installs >= MIN_INSTALLS, page: `https://skills.sh/${r.repo}/${r.skill}` }));
      res.json({ items, minInstalls: MIN_INSTALLS });
    } catch {
      res.json({ items: [], error: "skills.sh could not be searched right now." });
    }
  });
  // Anyone who can call tools may add a public skills.sh skill to the library; turning it on for
  // the whole workspace stays with admins.
  app.post("/api/library", permit("call"), async (req, res) => {
    const i = identity(res);
    const { skill, enable } = z.object({ skill: z.string().min(3).max(300), enable: z.boolean().default(false) }).parse(req.body);
    const admin = i.permissions.includes("configure");
    const added = await addSkill(store, i.workspace, viewerFor(store, i), skill, enable && admin);
    res.json({ id: added.id, title: added.title, created: added.created, enabled: added.enabled });
  });
  // Instant tools: the catalog people browse in Catalog → Instant (prices include the markup).
  app.get("/api/instant", permit("call"), (_req, res) => {
    res.json(instantPlatforms(store));
  });
  app.get("/api/instant/:slug", permit("call"), (req, res) => {
    res.json(instantPlatform(store, String(req.params.slug)));
  });
  // Skills people write or upload: private, shared with chosen people and organizations, or public.
  // Anyone who can call tools may write one; only its author may change or delete it.
  app.post("/api/skills/authored", permit("call"), (req, res) => {
    const i = identity(res);
    const s = createAuthored(store, viewerFor(store, i), req.body);
    store.audit(i.workspace, i.user, "skill.written", `${s.id} · ${s.visibility}`);
    res.json(s);
  });
  app.get("/api/skills/authored/:id", permit("call"), (req, res) => {
    res.json(authoredDetail(store, viewerFor(store, identity(res)), String(req.params.id)));
  });
  app.put("/api/skills/authored/:id", permit("call"), (req, res) => {
    const i = identity(res);
    const s = updateAuthored(store, viewerFor(store, i), String(req.params.id), req.body);
    store.audit(i.workspace, i.user, "skill.edited", `${s.id} · ${s.visibility}`);
    res.json(s);
  });
  app.delete("/api/skills/authored/:id", permit("call"), (req, res) => {
    const i = identity(res);
    deleteAuthored(store, viewerFor(store, i), String(req.params.id));
    store.audit(i.workspace, i.user, "skill.deleted", String(req.params.id));
    res.json({ ok: true });
  });
  // The model catalog, from the database: names and prices only.
  app.get("/api/models", permit("read"), (_req, res) => {
    res.json({ updatedAt: catalogUpdatedAt(store), models: publicModels(store) });
  });
  // AI models: credit, this month's spend, limits and recent usage.
  app.get("/api/ai", permit("read"), (_req, res) => {
    const w = identity(res).workspace;
    res.json({ ...aiSummary(store, w), usage: workspaceUsage(store, w, 100), ledger: store.list(w, "ai_ledger").slice(0, 50) });
  });
  // Buying credit: prices, a new order (an admin's action), and a check on an order after returning from Cashfree.
  // Behind Cloudflare, cf-ipcountry says where the visitor is: India pays in rupees, others in dollars.
  const countryOf = (req: Request) => String(req.headers["cf-ipcountry"] ?? "").toUpperCase();
  app.get("/api/payments", permit("read"), (req, res) => {
    const i = identity(res);
    const country = countryOf(req);
    res.json({
      enabled: paymentsConfigured(),
      mode: cashfreeMode(),
      currencies: currenciesFor(country),
      providers: { INR: providerFor("INR"), USD: providerFor("USD") },
      testMode: { cashfree: cashfreeMode() === "sandbox", dodo: dodoMode() === "test_mode" },
      suggested: country === "IN" ? "INR" : country ? "USD" : null,
      bundles: BUNDLES.map((b) => ({ credit: b, USD: quote(b, "USD"), INR: quote(b, "INR") })),
      history: listPayments(store, i.workspace),
    });
  });
  app.post("/api/payments/orders", permit("configure"), async (req, res) => {
    const allowed = currenciesFor(countryOf(req));
    // Unknown currencies fall through to the order's own validation (a 400).
    if (["USD", "INR"].includes(req.body?.currency) && !allowed.includes(req.body.currency))
      throw Object.assign(new Error(`Payments from your country are taken in ${allowed.join(" or ") || "no currency yet"}.`), { status: 409, safe: true });
    res.json(await createOrder(store, identity(res), req.body));
  });
  app.post("/api/payments/orders/:id/check", permit("read"), async (req, res) => {
    const p = await settle(store, String(req.params.id), identity(res).workspace);
    if (!p) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json({ payment: p, balance: aiSummary(store, identity(res).workspace).balance });
  });
  app.put("/api/ai/settings", permit("configure"), (req, res) => {
    res.json(saveAiSettings(store, identity(res), req.body));
  });
  // Trying a model from the catalog is a real, charged call.
  app.post("/api/ai/try", permit("call"), async (req, res) => {
    const i = identity(res);
    const r = await generate(store, i, req.body, "console");
    store.audit(i.workspace, i.user, "ai.generate", `${r.model} · console`);
    res.json(r);
  });
  // workflow_<name>.md: download one, or import one as a draft.
  app.get("/api/workflows/:id/markdown", permit("read"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!visibleTo(wf, i)) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${workflowFileName(wf)}"`);
    res.send(toMarkdown(wf));
  });
  app.post("/api/workflows/import", permit("call"), (req, res) => {
    const i = identity(res);
    const { markdown } = z.object({ markdown: z.string().min(10).max(400_000) }).parse(req.body);
    const data = fromMarkdown(markdown);
    // Members keep private workflows only; an admin's import keeps the file's choice.
    const visibility = i.permissions.includes("configure") ? data.visibility : "private";
    res.json(saveWorkflow(store, i, { ...data, visibility }, undefined, "console"));
  });
  // Tasks this person has done the same way three times: a click turns one into a draft.
  app.get("/api/workflows/suggestions", permit("call"), (_req, res) => {
    const i = identity(res);
    res.json(suggestionsFor(keyFor(i)).filter((p) => !alreadySaved(store, i, p.tools)).map((p) => ({ tools: p.tools, count: p.count, lastAt: new Date(p.lastAt).toISOString() })));
  });
  app.post("/api/workflows/suggestions/draft", permit("call"), (req, res) => {
    const i = identity(res);
    const { tools, name } = z.object({ tools: z.array(z.string().max(64)).min(2).max(20), name: z.string().trim().min(2).max(80) }).parse(req.body);
    const saved = captureWorkflow(store, i, { name, tools });
    res.json(saved.row);
  });
  app.post("/api/workflows/suggestions/dismiss", permit("call"), (req, res) => {
    const { tools } = z.object({ tools: z.array(z.string().max(64)).min(1).max(20) }).parse(req.body);
    dismissSuggestion(keyFor(identity(res)), tools);
    res.json({ ok: true });
  });
  // A run paused at a judgment step goes on once the person who started it answers.
  app.post("/api/workflows/runs/:id/resume", permit("call"), async (req, res) => {
    const { answer } = z.object({ answer: z.string().min(1).max(20_000) }).parse(req.body);
    res.json(await resumeWorkflow(store, services, identity(res), String(req.params.id), answer, "console"));
  });
  // Carry on a run that a restart interrupted, from the step it had reached.
  app.post("/api/workflows/runs/:id/continue", permit("call"), async (req, res) => {
    res.json(await continueRun(store, services, identity(res), String(req.params.id)));
  });
  // What went into and came out of each step of a recent run: for the person who ran it, or an admin.
  app.get("/api/workflows/runs/:id/steps", permit("call"), (req, res) => {
    const i = identity(res),
      run = store.list(i.workspace, "workflow_runs").find((r) => r.id === String(req.params.id));
    if (!run || (run.user !== i.user && !i.permissions.includes("configure"))) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json(stepLogs(store, i.workspace, run.id));
  });
  // What a workflow remembers between runs, and the way to forget it.
  app.get("/api/workflows/:id/state", permit("call"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!visibleTo(wf, i)) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json(listState(store, wf.id));
  });
  app.delete("/api/workflows/:id/state", permit("call"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!manageable(wf, i)) throw Object.assign(new Error("Only an admin or the workflow's owner can reset what it remembers."), { status: 403 });
    forgetState(store, wf.id, typeof req.query.key === "string" ? req.query.key : undefined);
    res.json({ ok: true });
  });
  app.delete("/api/workflow-cache", permit("configure"), (_req, res) => {
    res.json({ cleared: clearCache(store, identity(res).workspace) });
  });
  // The latest kept result of a workflow, for the person asking.
  app.get("/api/workflows/:id/result", permit("call"), (req, res) => {
    const i = identity(res),
      wf = store.get(i.workspace, "workflows", String(req.params.id));
    if (!visibleTo(wf, i)) throw Object.assign(new Error("Record not found"), { status: 404 });
    res.json(lastResult(store, i, wf.id));
  });
  async function saveApi(req: Request, res: Response) {
    const i = identity(res),
      w = i.workspace;
    const existing = req.params.id ? store.get(w, "apis", String(req.params.id)) : undefined;
    // A social account is set up by its sign-in: only its name, access and on/off change here.
    if (existing?.channel) {
      const patch = z.object({ name: z.string().trim().min(2).max(80).optional(), access: z.enum(["read", "write"]).optional(), enabled: z.boolean().optional() }).parse(req.body);
      const row = store.put(w, "apis", { ...existing, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
      store.audit(w, i.user, "api.updated", row.name);
      res.json(publicApi(row));
      return;
    }
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
  // Errors marked safe (credit, limits, provider refusals) carry a message written for people.
  if (!(error instanceof z.ZodError) && !error?.safe && (!error.status || status >= 500))
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${status}`, error?.stack || error);
  if (res.headersSent) return;
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      : error?.safe
        ? error.message
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
