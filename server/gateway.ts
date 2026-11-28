import { checkService, chargeService } from "./service-charges.js";
import { API_CALL, MCP_CALL } from "./catalog.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Store, Row } from "./store.js";
import type { ServiceAdapters } from "./adapters.js";
import type { Identity } from "./schema.js";
import { credentialFor } from "./oauth.js";
import { addSkill, enabledSkills, skillCatalog, skillText } from "./skills.js";
import { frontMatter, MIN_INSTALLS, searchRegistry } from "./skill-registry.js";
import { resumeWorkflow, runWorkflow, saveWorkflow, visibleTo, workflowInputSchema, workflowToolName, type RunOutcome } from "./workflows.js";
import { AI_TOOL, aiConfigured, aiInputSchema, aiSummary, generate, usd } from "./ai.js";
import { BROWSER_TOOL, browse, browseText, browserConfigured, browserInputSchema } from "./browser.js";
import { INSTANT_CALL, INSTANT_GET, INSTANT_SEARCH, callInstant, instantCallSchema, instantConfigured, instantGetSchema, instantSearchSchema, instantTool, searchInstant } from "./instant.js";
import { MAPS_TOOL, SCRAPE_TOOL, mapsInputSchema, scrape, scrapeInputSchema, scrapeMaps, scraperConfigured } from "./scraper.js";
import { CONNECT_TOOL, connectApp, connectTool } from "./connect.js";
import { alreadySaved, captureWorkflow, keyFor, noticeRepeat, recordCall } from "./capture.js";
import { toMarkdown, workflowFileName } from "./workflow-md.js";
import { authoredSchema, createAuthored, findAuthoredByName, libraryCount, librarySearch, updateAuthored, viewerFor } from "./library.js";
import { allowedMethods, apiCall } from "./apis.js";
import { ToolIndex, sameApp } from "./tool-search.js";
import { origin } from "./mcp-oauth.js";

// MCP clients accept tool names matching ^[a-zA-Z0-9_-]{1,64}$.
const clean = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

export type GatewayTool = {
  name: string;
  connection: Row;
  tool: Row;
};

// One namespaced tool per enabled tool of every enabled, verified connection.
export function gatewayTools(store: Store, workspace: string): GatewayTool[] {
  const used = new Set<string>();
  const tools: GatewayTool[] = [];
  for (const connection of store.list(workspace, "connections")) {
    if (!connection.enabled || connection.status !== "Connected") continue;
    const disabled = new Set<string>(connection.disabledTools || []);
    // "orbytlink" and "workflow" name the gateway's own tools; an app can't take them over.
    const base0 = (clean(connection.name) || "app").slice(0, 24);
    const prefix = base0 === "orbytlink" || base0 === "workflow" ? `${base0}_app` : base0;
    for (const tool of connection.tools || []) {
      if (disabled.has(tool.name)) continue;
      const base = `${prefix}__${clean(tool.name) || "tool"}`.slice(0, 64);
      let name = base;
      // Connections with similar names must never shadow each other.
      for (let n = 2; used.has(name); n++)
        name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
      used.add(name);
      tools.push({ name, connection, tool });
    }
  }
  return tools;
}

// How a client sees app tools. "all" lists every tool; "search" lists a few discovery tools
// so the agent finds the ones it needs; "auto" switches to search once the list gets long.
export type ToolMode = "auto" | "all" | "search";
export const AUTO_SEARCH_ABOVE = 30;
export function effectiveMode(mode: ToolMode | undefined, appToolCount: number): "all" | "search" {
  if (mode === "all" || mode === "search") return mode;
  return appToolCount > AUTO_SEARCH_ABOVE ? "search" : "all";
}
const PIN_LIMIT = 8,
  PIN_MIN_CALLS = 3,
  PIN_WINDOW = 30 * 24 * 60 * 60 * 1000;
// The tools this workspace actually uses stay one step away: listed directly even in search mode.
export function pinnedTools(store: Store, w: string, tools: GatewayTool[]): GatewayTool[] {
  const since = Date.now() - PIN_WINDOW;
  const counts = new Map<string, number>();
  for (const c of store.list(w, "calls")) {
    if (c.status !== "ok" || Date.parse(c.createdAt) < since) continue;
    const key = `${c.connectionId}\u0000${c.tool}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return tools
    .map((t) => ({ t, n: counts.get(`${t.connection.id}\u0000${t.tool.name}`) || 0 }))
    .filter((x) => x.n >= PIN_MIN_CALLS)
    .sort((a, b) => b.n - a.n || a.t.name.localeCompare(b.t.name))
    .slice(0, PIN_LIMIT)
    .map((x) => x.t);
}
// The schema an agent needs to call a tool; "$schema" only costs tokens.
const callableSchema = (schema: any) => {
  if (schema?.type !== "object") return { type: "object" };
  const { $schema: _drop, ...rest } = schema;
  return rest;
};
const listed = ({ name, connection, tool }: GatewayTool) => ({
  name,
  title: `${connection.name} · ${tool.title || tool.name}`,
  description: [`[${connection.name}]`, tool.description].filter(Boolean).join(" ").slice(0, 1024),
  inputSchema: tool.inputSchema?.type === "object" ? tool.inputSchema : { type: "object" },
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
});
const BASE_INSTRUCTIONS =
  "Credentials stay on the gateway and are never returned. Skills (orbytlink__use_skill) are instructions to load when a task matches them; orbytlink__find_skills finds more, including community skills on skills.sh, and orbytlink__add_skill turns one on when the user asks. workflow__* tools run a fixed sequence of tool calls. APIs stored in OrbytLink are read with orbytlink__api_docs and called with orbytlink__api_request; the gateway adds their keys. To automate a repeated task, draft a workflow with orbytlink__create_workflow; a person reviews and enables it. If the user needs an app that is not connected, call orbytlink__connect_app: it returns a link to connect it and the steps to show the user. Before doing a task step by step, check whether a workflow__* tool already does it: one call is faster and cheaper. After finishing a task the user is likely to repeat, offer to save it with orbytlink__save_workflow, built from the calls you just made.";
const SEARCH_INSTRUCTIONS =
  "OrbytLink is a gateway to the apps this workspace has connected. Their tools are not all listed: find them first. Call orbytlink__find_tools with a short description of the action (e.g. \"enroll leads in campaign\"), pick a result, then run it with orbytlink__call_tool using its exact name and arguments that match its input schema. orbytlink__list_apps shows which apps are connected. Tools listed directly are the ones used most and can be called as usual. " +
  BASE_INSTRUCTIONS;
const ALL_INSTRUCTIONS =
  "OrbytLink is a gateway to the apps this workspace has connected. Tool names are <app>__<tool>. " + BASE_INSTRUCTIONS;

export function gatewayServer(
  store: Store,
  services: ServiceAdapters,
  identity: Identity,
) {
  const w = identity.workspace;
  // The mode is fixed per request from the configuration at that moment.
  const mode = effectiveMode(identity.toolMode, gatewayTools(store, w).length);
  const server = new Server(
    {
      name: "OrbytLink",
      version: "0.3.0",
      websiteUrl: "https://orbytlink.com",
      icons: [{ src: `${origin()}/favicon.png`, mimeType: "image/png", sizes: ["128x128"] }],
    },
    {
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      instructions: mode === "search" ? SEARCH_INSTRUCTIONS : ALL_INSTRUCTIONS,
    },
  );
  const allowed = identity.permissions.includes("call");
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!allowed) return { tools: [] };
    const tools = gatewayTools(store, w);
    if (mode === "all") return { tools: [...tools.map(listed), ...ownTools(store, w, identity)] };
    return { tools: [...discoveryTools(tools, storedApis(store, w)), ...pinnedTools(store, w, tools).map(listed), ...ownTools(store, w, identity)] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: allowed
      ? enabledSkills(store, w, viewerFor(store, identity)).map((s) => ({ name: s.id, title: s.title, description: s.description.slice(0, 1024) }))
      : [],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const viewer = viewerFor(store, identity);
    const skill = allowed && enabledSkills(store, w, viewer).find((s) => s.id === request.params.name);
    if (!skill) throw new Error("Unknown or disabled skill");
    return {
      description: skill.description.slice(0, 1024),
      messages: [{ role: "user" as const, content: { type: "text" as const, text: skillText(store, viewer, skill.id)! } }],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!allowed) return toolText("This token cannot call tools.", true);
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    // Discovery works in every mode, so an agent can always search, whatever it was shown.
    if (name === "orbytlink__list_apps") return toolText(listApps(store, w));
    if (name === "orbytlink__find_tools") return findTools(store, w, args);
    if (name === "orbytlink__call_tool") {
      if (typeof args.name !== "string" || !args.name) return toolText("Give the exact tool name from orbytlink__find_tools.", true);
      const inner = args.arguments ?? {};
      if (typeof inner !== "object" || Array.isArray(inner)) return toolText("arguments must be an object.", true);
      if (args.name.startsWith("orbytlink__")) return toolText("Call OrbytLink's own tools directly, not through orbytlink__call_tool.", true);
      return callTool(store, services, identity, args.name, inner as Record<string, unknown>);
    }
    return callTool(store, services, identity, name, args);
  });
  return server;
}

// Any tool by name: the gateway's own, a workflow, or an app tool, listed or not. What runs is
// remembered briefly (capture.ts), so a task can be saved as a workflow from the calls that really
// happened; a task done the same way three times is pointed out to the agent once.
const recorded = (name: string) => !name.startsWith("orbytlink__") || [API_REQUEST_TOOL, AI_TOOL, BROWSER_TOOL, SCRAPE_TOOL, MAPS_TOOL, INSTANT_CALL].includes(name);
async function callTool(store: Store, services: ServiceAdapters, identity: Identity, name: string, args: Record<string, unknown>) {
  const result: any = await runTool(store, services, identity, name, args);
  if (!recorded(name)) return result;
  const text = Array.isArray(result?.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";
  const ok = !result?.isError && !text.startsWith("The workflow paused");
  const key = keyFor(identity);
  recordCall(key, name, store.redact(identity.workspace, args) || {}, text, ok);
  if (!ok) return result;
  const repeat = noticeRepeat(key);
  if (!repeat || alreadySaved(store, identity, repeat.tools)) return result;
  return {
    ...result,
    content: [
      ...(result.content || []),
      { type: "text", text: `[OrbytLink] This same sequence (${repeat.tools.join(" → ")}) has now run on ${repeat.count} separate occasions. If it is a task the user repeats, offer to save it as a workflow with orbytlink__save_workflow, so next time it is one call.` },
    ],
  };
}
async function runTool(store: Store, services: ServiceAdapters, identity: Identity, name: string, args: Record<string, unknown>) {
  const w = identity.workspace;
  const own = await callOwnTool(store, services, identity, name, args);
  if (own) return own;
  // Resolve against current configuration, so disabling a tool takes effect immediately.
  const entry = gatewayTools(store, w).find((t) => t.name === name);
  if (!entry) return toolText(`Unknown or disabled tool: ${name.slice(0, 80)}. Use orbytlink__find_tools to find the right name.`, true);
  const { connection, tool } = entry;
  const target = `${connection.name} · ${tool.name}`;
  // A price per MCP tool call, if the operator set one: refused up front when the workspace can't pay.
  let price = 0;
  try {
    price = checkService(store, w, MCP_CALL);
  } catch (error) {
    return toolText((error as Error).message, true);
  }
  const started = Date.now();
  try {
    const result = await services.call(connection, tool.name, args, await credentialFor(store, w, connection));
    chargeService(store, identity, MCP_CALL, price, "agent", target);
    store.audit(w, identity.user, "tool.called", target);
    log(store, w, identity, connection, tool.name, "ok", Date.now() - started);
    // Never let an upstream echo a stored credential back to the client.
    const safe = store.redact(w, result);
    if (safe && typeof safe === "object" && Array.isArray(safe.content)) return safe;
    return toolText(typeof safe === "string" ? safe : JSON.stringify(safe));
  } catch (error) {
    store.audit(w, identity.user, "tool.failed", target);
    log(store, w, identity, connection, tool.name, "error", Date.now() - started);
    const message = (error as Error).message;
    console.warn(`[${new Date().toISOString()}] tool ${target} failed: ${String(message).slice(0, 300)}`);
    // Our own adapter messages are safe to show; anything else stays generic.
    return toolText(
      /^(Authorization (required|expired|denied)|Missing path input|Tool inputs do not match|Tool is not registered|API request failed with status \d+|Response too large|Tool response too large|Operation path leaves)/.test(message)
        ? message
        : `${connection.name} could not complete the request.`,
      true,
    );
  }
}

type AppSummary = { app: string; prefix: string; tools: number; examples: string[] };
function appSummaries(tools: GatewayTool[]): AppSummary[] {
  const apps = new Map<string, AppSummary>();
  for (const t of tools) {
    const a: AppSummary = apps.get(t.connection.id) || { app: t.connection.name, prefix: t.name.split("__")[0], tools: 0, examples: [] };
    a.tools++;
    if (a.examples.length < 8) a.examples.push(t.tool.name);
    apps.set(t.connection.id, a);
  }
  return [...apps.values()];
}
// Stored APIs (social accounts among them) have no MCP tools of their own: agents reach them with
// orbytlink__api_docs and orbytlink__api_request. Discovery names them too, so an agent that searches
// for "LinkedIn" learns it is connected instead of concluding it isn't.
type StoredApi = { api: string; name: string; access: string };
function storedApis(store: Store, w: string): StoredApi[] {
  return enabledApis(store, w).map(({ slug, api }) => ({ api: slug, name: api.name, access: api.access === "write" ? "read and write" : "read only" }));
}
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1);
function apisMatching(apis: StoredApi[], text: string) {
  const wanted = new Set(words(text));
  const whole = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return apis.filter((a) => words(a.name).some((x) => x.length > 2 && wanted.has(x)) || (!!whole && a.name.toLowerCase().replace(/[^a-z0-9]+/g, "") === whole));
}
const apiHint = (apis: StoredApi[]) => ({
  apis,
  next: "These are stored APIs, not MCP tools: read one with orbytlink__api_docs {api}, then call it with orbytlink__api_request {api, method, path, body}. The gateway adds the account's key.",
});
function discoveryTools(tools: GatewayTool[], apis: StoredApi[] = []) {
  const apps = appSummaries(tools);
  const appList =
    [...apps.map((a) => `- ${a.app} (${a.tools} tools)`), ...apis.map((a) => `- ${a.name} (stored API "${a.api}": use orbytlink__api_docs and orbytlink__api_request)`)].join("\n") || "- none connected yet";
  return [
    {
      name: "orbytlink__find_tools",
      title: "Find app tools",
      description: `Find the tools of the connected apps that fit a task, with the input schema needed to call them. Describe the action in a few words, e.g. "create campaign" or "list unread emails"; give app to search one app only, or app alone to see all its tool names. Then run a result with orbytlink__call_tool. Connected apps:\n${appList}`.slice(0, 4000),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The action, in a few words" },
          app: { type: "string", description: "Optional: limit to one app, by name" },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "How many tools to return (default 8)" },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "orbytlink__call_tool",
      title: "Call an app tool",
      description: "Run a tool of a connected app by its exact name from orbytlink__find_tools. arguments must match that tool's input schema. The gateway adds the app's credentials.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact tool name, e.g. mail_orbyt__list_campaigns" },
          arguments: { type: "object", description: "The tool's inputs, matching its input schema" },
        },
        required: ["name"],
      },
    },
    {
      name: "orbytlink__list_apps",
      title: "List connected apps",
      description: "List the apps connected to this workspace, with how many tools each has and a few of their names, and the stored APIs and social accounts (called with orbytlink__api_request).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
}
function listApps(store: Store, w: string) {
  const apps = appSummaries(gatewayTools(store, w));
  const apis = storedApis(store, w);
  if (!apps.length && !apis.length) return "No apps are connected and verified yet. Connect one in OrbytLink → Connections.";
  return JSON.stringify(
    {
      apps: apps.map((a) => ({ app: a.app, toolPrefix: `${a.prefix}__`, tools: a.tools, examples: a.examples })),
      ...(apis.length ? { apis } : {}),
      next: `Use orbytlink__find_tools to find a tool and its input schema.${apis.length ? " Stored APIs and social accounts are read with orbytlink__api_docs and called with orbytlink__api_request." : ""}`,
    },
    null,
    1,
  );
}
function findTools(store: Store, w: string, args: Record<string, unknown>) {
  const tools = gatewayTools(store, w);
  const query = typeof args.query === "string" ? args.query.slice(0, 300) : "";
  const app = typeof args.app === "string" ? args.app.slice(0, 80) : "";
  const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 8));
  if (!query && !app) return toolText("Give a query (the action, in a few words) or an app name.", true);
  const apis = storedApis(store, w);
  if (app && !tools.some((t) => sameApp(t.connection.name, t.name, app))) {
    const stored = apisMatching(apis, app);
    if (stored.length) return toolText(JSON.stringify({ app, connected: true, ...apiHint(stored) }, null, 1));
    return toolText(`No connected app is named "${app}". Connected: ${appSummaries(tools).map((a) => a.app).join(", ") || "none"}. To connect it, call orbytlink__connect_app with {"app": "${app.replace(/"/g, "")}"}.`, true);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  // An app with no query is a directory: every name, no schemas, to keep it short.
  if (!query) {
    const all = tools.filter((t) => sameApp(t.connection.name, t.name, app));
    return toolText(JSON.stringify({
      app: all[0].connection.name,
      tools: all.slice(0, 300).map((t) => ({ name: t.name, description: String(t.tool.description || "").slice(0, 120) })),
      next: "Search with a query to get the input schema of the tool you need.",
    }, null, 1));
  }
  const index = new ToolIndex(tools.map((t) => ({
    name: t.name,
    app: t.connection.name,
    title: t.tool.title,
    description: t.tool.description,
    inputs: Object.keys(t.tool.inputSchema?.properties || {}),
  })));
  const hits = index.search(query, limit, app || undefined);
  const stored = app ? [] : apisMatching(apis, query);
  if (!hits.length)
    return stored.length
      ? toolText(JSON.stringify({ tools: [], ...apiHint(stored) }, null, 1))
      : toolText(`No tools match "${query}". Try other words, or orbytlink__list_apps to see what is connected.`);
  return toolText(JSON.stringify({
    ...(stored.length ? { apis: stored } : {}),
    tools: hits.map((h) => {
      const t = byName.get(h.name)!;
      return {
        name: t.name,
        app: t.connection.name,
        description: String(t.tool.description || "").slice(0, 600),
        inputSchema: callableSchema(t.tool.inputSchema),
        ...(t.tool.annotations?.readOnlyHint ? { readOnly: true } : {}),
        ...(t.tool.annotations?.destructiveHint ? { destructive: true } : {}),
      };
    }),
    next: "Run one with orbytlink__call_tool {name, arguments}.",
  }, null, 1));
}

function log(
  store: Store,
  w: string,
  identity: Identity,
  connection: Row,
  tool: string,
  status: "ok" | "error",
  ms: number,
) {
  store.put(w, "calls", {
    connectionId: connection.id,
    connection: connection.name,
    tool,
    status,
    ms,
    client: identity.authMethod === "token" ? "token" : identity.authMethod,
    user: identity.user,
    createdAt: new Date().toISOString(),
  });
  store.trim(w, "calls", 1000);
}

// The gateway's own tools: skills, workflow drafting, and one tool per enabled workflow.
const toolText = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
// Enabled workflows this person's agents may call: the workspace's, plus their own private ones.
export function visibleWorkflowTools(store: Store, identity: Identity) {
  const used = new Set<string>();
  return store
    .list(identity.workspace, "workflows")
    .filter((wf) => wf.enabled && visibleTo(wf, identity))
    .map((wf) => {
      let name = workflowToolName(wf);
      for (let n = 2; used.has(name); n++) name = `${workflowToolName(wf).slice(0, 60)}_${n}`;
      used.add(name);
      return { name, workflow: wf };
    });
}
export const API_REQUEST_TOOL = "orbytlink__api_request";
// A call to a stored API, from an agent or a workflow step; the gateway adds the key.
export async function callStoredApi(store: Store, identity: Identity, args: Record<string, unknown>) {
  const w = identity.workspace;
  const match = enabledApis(store, w).find((a) => a.slug === args.api);
  if (!match) return toolText("Unknown or disabled API.", true);
  try {
    // A price per API request, if the operator set one; charged once the request went through.
    const price = checkService(store, w, API_CALL);
    const out = await apiCall(store, w, match.api, { method: args.method, path: args.path, query: args.query, body: args.body });
    chargeService(store, identity, API_CALL, price, "agent", `${match.api.name} · ${args.method} ${args.path}`);
    store.audit(w, identity.user, "api.request", `${match.api.name} · ${args.method} ${args.path} · ${out.status}`);
    const body = typeof out.body === "string" ? out.body : JSON.stringify(out.body, null, 2);
    return toolText(`HTTP ${out.status}${out.truncated ? " (response truncated)" : ""}\n\n${body.slice(0, 100_000)}`, !out.ok);
  } catch (error) {
    const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
    return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as Error).message, true);
  }
}
const apiSlug = (a: Row) => a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "api";
export function enabledApis(store: Store, w: string) {
  const used = new Set<string>();
  return store
    .list(w, "apis")
    .filter((a) => a.enabled && (a.auth === "none" || a.hasKey))
    .map((a) => {
      let slug = apiSlug(a);
      for (let n = 2; used.has(slug); n++) slug = `${apiSlug(a)}_${n}`;
      used.add(slug);
      return { slug, api: a };
    });
}
// The docs tool answers from the stored docs: the endpoint index, or the passages that match.
function apiDocs(api: Row, search?: string) {
  const endpoints: Row[] = api.endpoints || [];
  const terms = (search || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s: string) => terms.every((t) => s.toLowerCase().includes(t));
  const index = endpoints.filter((e) => !terms.length || hit(`${e.method} ${e.path} ${e.summary}`)).slice(0, 300);
  const docs = String(api.docs || "");
  // For a spec, a search is answered by the endpoint index; raw spec text only without one.
  const passages = !terms.length ? docs : endpoints.length ? "" : docs.split(/\n\s*\n/).filter(hit).slice(0, 40).join("\n\n");
  return [
    `${api.name}: base URL ${api.baseUrl}. Allowed methods: ${allowedMethods(api).join(", ")}. Use orbytlink__api_request with a path relative to the base URL; the key is added by the gateway.`,
    index.length ? `Endpoints${terms.length ? ` matching "${search}"` : ""} (${index.length}${index.length === 300 ? "+" : ""}):\n${index.map((e) => `${e.method} ${e.path}${e.summary ? ` - ${e.summary}` : ""}`).join("\n")}` : "",
    passages ? `Documentation${terms.length ? " (matching passages)" : ""}:\n${passages.slice(0, 20_000)}` : docs ? "" : "No documentation is stored for this API.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
// Adding a skill changes the workspace, so only an agent acting for someone who may configure it can.
const canConfigure = (identity: Identity) => identity.permissions.includes("configure") || !!identity.ownerCanConfigure;
// Skills from the open skills.sh registry, found and added the way the find-skills skill does
// with `npx skills`, but into the workspace, since an agent behind the gateway has no shell.
async function findSkills(store: Store, identity: Identity, args: Record<string, unknown>) {
  const w = identity.workspace;
  const viewer = viewerFor(store, identity);
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
  if (!query) return toolText("Describe the task in a few words, e.g. \"write changelogs\".", true);
  const catalog = skillCatalog(store, w, viewer);
  const index = new ToolIndex(catalog.map((s) => ({ name: s.id, app: s.category, title: s.title, description: s.description })));
  const workspace = index.search(query, 5).map((d) => {
    const s = catalog.find((c) => c.id === d.name)!;
    return { skill: s.id, title: s.title, description: s.description.slice(0, 300), on: s.enabled };
  });
  // The shared library: every skill anyone on this server added, ready to use at once.
  const mine = new Set(catalog.map((s) => s.id));
  const found = librarySearch(store, query, viewer, { limit: 8 });
  const library = found.items
    .filter((l) => !mine.has(l.id))
    .slice(0, 5)
    .map((l) => ({ skill: l.id, title: l.name, description: l.description.slice(0, 300), source: l.origin === "authored" ? `written by ${l.owner}${l.visibility === "public" ? "" : ` (${l.visibility})`}` : `${l.repo} (${l.license})`, installs: l.installs, uses: l.uses }));
  const have = new Set(found.items.map((l) => `${l.repo}/${l.skill}`.toLowerCase()));
  let registry: Record<string, unknown>[] = [],
    note: string | undefined;
  try {
    registry = (await searchRegistry(query, 10))
      .filter((r) => !have.has(`${r.repo}/${r.skill}`.toLowerCase()))
      .map((r) => ({ skill: `${r.repo}@${r.skill}`, installs: r.installs, canAdd: r.installs >= MIN_INSTALLS, page: `https://skills.sh/${r.repo}/${r.skill}` }));
  } catch {
    note = "skills.sh could not be searched right now; only this workspace's skills are shown.";
  }
  return toolText(
    JSON.stringify(
      {
        query,
        inWorkspace: workspace,
        inLibrary: library,
        skillsSh: registry,
        ...(note ? { note } : {}),
        next: `Tell the user what fits, with install counts and sources. Skills inWorkspace or inLibrary can be loaded right away with orbytlink__use_skill {name}. A skills.sh skill is added to the shared library with orbytlink__add_skill {skill} (canAdd is false below ${MIN_INSTALLS.toLocaleString("en")} installs).`,
      },
      null,
      2,
    ),
  );
}
function ownTools(store: Store, w: string, identity: Identity) {
  const viewer = viewerFor(store, identity);
  const skills = enabledSkills(store, w, viewer);
  const tools: any[] = [
    {
      name: "orbytlink__find_skills",
      title: "Find skills",
      description:
        "Find skills (reusable expert instructions) for a task: this workspace's skills, OrbytLink's shared library of skills anyone has added, and community skills on skills.sh with their install counts. Use it when the user asks for a skill, or asks how to do something specialised that a skill might cover.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "The task in a few words, e.g. \"react performance\" or \"pr review\"" } }, required: ["query"] },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
  tools.push({
      name: "orbytlink__add_skill",
      title: "Add a skill",
      description: `Add a skill when the user asks for it. Give owner/repo@skill from orbytlink__find_skills to add a community skill from skills.sh to OrbytLink's shared library, so every workspace can use it: it is fetched from GitHub, pinned to that commit, and refused if it ships scripts, has under ${MIN_INSTALLS.toLocaleString("en")} installs or lacks an open licence. ${canConfigure(identity) ? "It is also turned on for every agent in this workspace." : "Only an admin can turn it on for everyone in this workspace."} Returns the skill's instructions to follow right away.`,
      inputSchema: { type: "object", properties: { skill: { type: "string", description: "e.g. tdd, or vercel-labs/agent-skills@react-best-practices" } }, required: ["skill"] },
      annotations: { openWorldHint: true },
    });
  if (canConfigure(identity))
    tools.push({
      name: "orbytlink__write_skill",
      title: "Write a skill",
      description:
        "Save a skill the user asks you to write or update, as their own private skill in OrbytLink, and turn it on for this workspace. body is the whole SKILL.md: YAML front matter with name and description, then the instructions. Writing a skill with the same name again updates it. It is private to this user and can't be shared or made public from here; they do that in OrbytLink → Skills. Only do this when the user asked for it, and never put secrets in a skill.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: "The full SKILL.md text, starting with --- front matter (name, description)." },
          name: { type: "string", description: "Skill name, if not in the front matter." },
          description: { type: "string", description: "When an agent should use it, if not in the front matter." },
          files: { type: "array", description: "Optional reference files (Markdown or text), at most 30.", items: { type: "object", properties: { path: { type: "string", description: "e.g. references/api.md" }, content: { type: "string" } }, required: ["path", "content"] } },
        },
        required: ["body"],
      },
      annotations: { idempotentHint: true },
    });
  tools.push(connectTool);
  const apis = enabledApis(store, w);
  if (apis.length) {
    const list = apis.map(({ slug, api }) => `- ${slug}: ${api.name}${api.description ? ` (${api.description})` : ""}, ${api.access === "write" ? "read and write" : "read only"}`).join("\n");
    tools.push(
      {
        name: "orbytlink__api_docs",
        title: "Read API docs",
        description: `Read the documentation and endpoint list of an API stored in OrbytLink. Search narrows it to matching endpoints and passages. APIs:\n${list}`.slice(0, 4000),
        inputSchema: { type: "object", properties: { api: { type: "string", enum: apis.map((a) => a.slug) }, search: { type: "string", description: "Words to look for, e.g. 'create invoice'" } }, required: ["api"] },
        annotations: { readOnlyHint: true },
      },
      {
        name: "orbytlink__api_request",
        title: "Call an API",
        description: `Call an API stored in OrbytLink. The gateway adds the API key on its server; you never see or send it. Read its docs first. APIs:\n${list}`.slice(0, 4000),
        inputSchema: {
          type: "object",
          properties: {
            api: { type: "string", enum: apis.map((a) => a.slug) },
            method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
            path: { type: "string", description: "Path relative to the API's base URL, starting with /" },
            query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
            body: { description: "JSON body for POST, PUT and PATCH" },
          },
          required: ["api", "method", "path"],
        },
      },
    );
  }
  // AI models, billed to the workspace's credit; listed only when they can actually be used.
  if (aiConfigured(store) && aiSummary(store, w).enabled)
    tools.push({
      name: AI_TOOL,
      title: "Ask an AI model",
      description:
        "Run a prompt on an AI model (text models from OrbytLink → Catalog → AI models, e.g. anthropic/claude-haiku-4.5 or openai/gpt-5-mini) and get its reply. Each call is charged to this workspace's AI credit at the listed price; credit for maxTokens is held until the call ends.",
      inputSchema: aiInputSchema,
      annotations: { openWorldHint: true },
    });
  // A real browser for web tasks no app or API covers; billed per page action from the same credit.
  if (browserConfigured(store, w) && aiSummary(store, w).enabled)
    tools.push({
      name: BROWSER_TOOL,
      title: "Use a web browser",
      description:
        "Carry out a task in a real web browser (search, fill a form, click through pages, read a page behind a login), then get back the final page to read the answer from. It runs first in the user's own browser (the OrbytLink extension, with the sites they are already signed in to) and falls back to a server browser that opens public pages only. Use it only when no connected app, API or MCP tool can do the job. Give a start url, a specific goal, and in values every piece of text it may need to type (search terms, form entries): it can type only those. It never types passwords: if a site needs a sign-in the user does it themselves, and the user is asked to approve each new site and any buying, sending or deleting. where: auto (default), local (only their own browser) or server; device names which of their browser profiles to use. Each step on the server's browser is charged to this workspace's credit; steps in their own browser cost only the decisions.",
      inputSchema: browserInputSchema,
      annotations: { openWorldHint: true },
    });
  // The scraper comes with OrbytLink: no app to connect, a daily allowance per workspace.
  tools.push({
    name: SCRAPE_TOOL,
    title: "Scrape web pages",
    description:
      "Read public web pages and get their title, description, text, and the contact details they publish: emails, phone numbers, social profiles, contact/about page links and the store platform (Shopify, WooCommerce…). Give urls to read up to 25 pages in parallel, e.g. every business website in a lead list; a page that can't be read comes back with an error instead of failing the call. contacts: true also reads up to two contact or about pages per site. select pulls parts out by CSS selector. It tries a plain request first and switches to a real stealth browser when a site blocks it or needs JavaScript. It obeys robots.txt and is free, within a daily allowance per workspace.",
    inputSchema: scrapeInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  });
  if (scraperConfigured())
    tools.push({
      name: MAPS_TOOL,
      title: "Search Google Maps",
      description:
        "Find local businesses on Google Maps by searching it in a real browser, e.g. query \"coffee shops\", location \"Austin, TX\". Each place comes back with name, category, website, phone, address, plus code, rating, review count, coordinates, its Maps link and any email or social links Maps shows. About 3 seconds per place; up to 60. To get emails, pass the websites to orbytlink__scrape afterwards (ask the user first). Free, within a daily number of searches per workspace.",
      inputSchema: mapsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
  // Instant tools: thousands of paid data APIs, found by job rather than listed one by one.
  if (instantConfigured() && aiSummary(store, w).enabled)
    tools.push(
      {
        name: INSTANT_SEARCH,
        title: "Find an instant tool",
        description:
          "Search thousands of ready data tools that need no account or key: Google and other search results, web scraping, people and company data (work emails, phones, profiles), LinkedIn, Instagram, TikTok, X, Reddit, YouTube and other social data, SEO and keyword data, ads libraries, reviews, app stores, e-commerce and market data. Describe the job, not a vendor. Returns tools with their price per call and how often they work. Tools whose id starts with best. ask the providers of a job cheapest first and bill only the answer; prefer them for common jobs.",
        inputSchema: instantSearchSchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: INSTANT_GET,
        title: "Read an instant tool",
        description: "The inputs, price and an example call of one instant tool, with other providers of the same job, cheapest first.",
        inputSchema: instantGetSchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: INSTANT_CALL,
        title: "Call an instant tool",
        description:
          "Call an instant tool by id with its query parameters and/or JSON body (read them with orbytlink__instant_get first). Each call is charged to this workspace's credit at the listed price; the most it may cost is held until it ends, and failed calls are free. A found email or phone is the provider's best match: verify it before anyone sends to it. Before a loop over many inputs, tell the user the expected total.",
        inputSchema: instantCallSchema,
        annotations: { openWorldHint: true },
      },
    );
  tools.push({
    name: "orbytlink__use_skill",
    title: "Load a skill",
    description: `Load the full instructions of a skill when the task matches it, then follow them. Any skill id from orbytlink__find_skills works, including the ${libraryCount(store, viewer).toLocaleString("en")} skills in OrbytLink's shared library.${skills.length ? ` Turned on in this workspace:\n${skills.map((s) => `- ${s.id}: ${s.description.slice(0, 160)}`).join("\n")}` : ""}`.slice(0, 4000),
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Skill id, e.g. tdd" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  });
  tools.push(
    {
      name: SAVE_TOOL,
      title: "Save a task as a workflow",
      description:
        "Save a task you just did through OrbytLink as a reusable workflow, built from the tool calls that actually ran (not retyped). Give the tools in the order you used them (or none to take every call since the last save), and the values the user supplied as inputs (name → the value used this time); values that came out of an earlier call are linked automatically. Add judgments where you decided something along the way. Saved as a draft, private to the user, until they enable it in OrbytLink → Workflows. replaces: a workflow's name, to fix one that broke.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. Weekly lead digest" },
          description: { type: "string", description: "What it does, for whoever calls it next" },
          tools: { type: "array", items: { type: "string" }, description: "Tool names in the order you called them" },
          inputs: { type: "object", additionalProperties: { type: "string" }, description: "Input name → the exact value used this time, e.g. {\"channel\": \"C0123\"}" },
          judgments: {
            type: "array",
            items: { type: "object", properties: { before: { type: "integer", description: "Step number it comes before (1 = first)" }, prompt: { type: "string", description: "What to decide, may use {{steps.<id>.text}}" }, returns: { type: "string" }, mode: { type: "string", enum: ["ai", "agent"] } }, required: ["before", "prompt"] },
          },
          judgment: { type: "string", enum: ["ai", "agent"], description: "Who decides by default: an AI model (automatic, uses AI credit) or the agent/person running it" },
          overrides: { type: "array", items: { type: "object", properties: { step: { type: "integer" }, arg: { type: "string" }, value: { type: "string" } }, required: ["step", "arg", "value"] } },
          replaces: { type: "string", description: "Name of an existing workflow to update instead" },
        },
        required: ["name"],
      },
    },
    {
      name: EXPORT_TOOL,
      title: "Export a workflow file",
      description: "Get a workflow as its workflow_<name>.md file (front matter + a ```yaml workflow block), to save in a repository or share. Importing the file in OrbytLink gives the same workflow.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "The workflow's name or workflow__ tool name" } }, required: ["name"] },
      annotations: { readOnlyHint: true },
    },
  );
  tools.push({
    name: "orbytlink__create_workflow",
    title: "Draft a workflow",
    description:
      "Draft a reusable workflow: a fixed, ordered list of tool calls that later runs the same way every time, with no model involved. A step's tool is an app tool (its exact app__tool name, as listed or found with orbytlink__find_tools), orbytlink__api_request (a stored API, e.g. an AI model API the user added; args api, method, path, query, body as JSON text), orbytlink__scrape (read public pages and the contacts they list; url or urls, contacts, select), orbytlink__scrape_maps (local businesses from Google Maps; query, location, maxResults), orbytlink__instant_call (a paid data tool found with orbytlink__instant_search; id, query, body) or another enabled workflow__*. Step arguments are strings that may contain {{input.<name>}} for a run input, {{steps.<id>.text}} for an earlier step's text result, or {{steps.<id>.json.<path>}} for a field of its JSON result. forEach (a placeholder that resolves to a JSON list) runs the step once per item, with {{item}} / {{item.<path>}}; when skips the step unless a condition holds; retries (0-3) and onError (stop|continue) handle failures. Also write ui, the run screen people will use: a field type per input, and how to show the result (output.view: table, list, cards, stats, text or json; output.from a step id, output.path into its JSON, columns for a table, title/subtitle/link keys for list or cards). The draft is saved disabled and private to the user; they review and enable it in OrbytLink. Use this when the user asks to automate a repeated task.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. Announce release in Slack" },
        description: { type: "string" },
        inputs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } }, required: ["name"] } },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "lowercase id, e.g. create_issue" },
              tool: { type: "string" },
              args: { type: "object", additionalProperties: { type: "string" } },
              forEach: { type: "string", description: "e.g. {{steps.find.json.items}}" },
              when: {
                type: "object",
                properties: { value: { type: "string" }, op: { type: "string", enum: ["truthy", "falsy", "equals", "not_equals", "contains", "not_contains"] }, to: { type: "string" } },
                required: ["value"],
              },
              retries: { type: "integer", minimum: 0, maximum: 3 },
              repeatable: { type: "boolean", description: "true if running the step twice does no harm; otherwise a step that changes something is only retried when the app surely didn't receive the call" },
              onError: { type: "string", enum: ["stop", "continue"] },
            },
            required: ["id", "tool"],
          },
        },
        ui: {
          type: "object",
          properties: {
            inputs: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: { label: { type: "string" }, type: { type: "string", enum: ["text", "textarea", "number", "date", "email", "url", "select", "checkbox"] }, options: { type: "array", items: { type: "string" } }, placeholder: { type: "string" } },
              },
            },
            output: {
              type: "object",
              properties: {
                from: { type: "string" },
                path: { type: "string" },
                view: { type: "string", enum: ["auto", "text", "table", "list", "cards", "stats", "json"] },
                columns: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } }, required: ["key", "label"] } },
                title: { type: "string" },
                subtitle: { type: "string" },
                link: { type: "string" },
              },
            },
          },
        },
        visibility: { type: "string", enum: ["private", "workspace"], description: "private (default): only this user's agents get it. workspace needs an admin." },
        keepLastResult: { type: "boolean", description: "Keep the latest result so the run screen can show it again" },
      },
      required: ["name", "steps"],
    },
  });
  const workflows = visibleWorkflowTools(store, identity);
  if (workflows.some(({ workflow }) => (workflow.steps || []).some((st: Row) => st.tool === "judge")))
    tools.push({
      name: RESUME_TOOL,
      title: "Continue a paused workflow",
      description: "Answer the decision a workflow paused for, and let it finish. Use the run id and the question from the paused workflow's reply.",
      inputSchema: { type: "object", properties: { run: { type: "string" }, answer: { type: "string", description: "Your decision, in the shape the workflow asked for" } }, required: ["run", "answer"] },
    });
  for (const { name, workflow } of workflows)
    tools.push({
      name,
      title: `Workflow · ${workflow.name}`,
      description: [`[Workflow, ${workflow.steps.length} steps]`, workflow.description].filter(Boolean).join(" ").slice(0, 1024),
      inputSchema: workflowInputSchema(workflow),
    });
  return tools;
}
const RESUME_TOOL = "orbytlink__resume_workflow",
  SAVE_TOOL = "orbytlink__save_workflow",
  EXPORT_TOOL = "orbytlink__export_workflow";
// What an agent reads back from a run: the result, the failure, or the decision it has to make.
function outcomeText(outcome: RunOutcome, workflow?: Row) {
  if (outcome.status === "waiting")
    return toolText(
      `The workflow paused for a decision (run ${outcome.runId}).\n\nDecide: ${outcome.question}${outcome.returns ? `\n\nAnswer with ${outcome.returns}.` : ""}\n\nThen call ${RESUME_TOOL} with {"run": "${outcome.runId}", "answer": "<your decision>"} and the rest of the workflow runs.`,
    );
  if (outcome.status === "succeeded") return toolText(outcome.output || "Workflow finished.");
  if (!workflow) return toolText(`Workflow failed. ${outcome.error}`, true);
  return toolText(fallbackText(workflow, outcome), true);
}
// A failed workflow is not the end of the task: say what already happened (so it isn't done twice),
// what is left, and how to turn the agent's own finish into a fix for the workflow.
function fallbackText(workflow: Row, outcome: RunOutcome) {
  const line = (st: RunOutcome["steps"][number]) => `${st.id} (${st.tool})`;
  const done = outcome.steps.filter((st) => st.status === "ok" && st.tool !== "judge");
  const failed = outcome.steps.find((st) => st.status === "error");
  const rest = outcome.steps.filter((st) => st.status === "skipped" && st.note !== "Condition not met");
  return [
    `Workflow "${workflow.name}" failed. ${outcome.error}`,
    done.length ? `Already done, and these took effect (don't repeat them): ${done.map(line).join(", ")}.` : "Nothing took effect before the failure.",
    `Not done: ${[...(failed ? [line(failed)] : []), ...rest.map(line)].join(", ") || "nothing"}.`,
    `Finish the user's task yourself: make the remaining calls directly (find tools with orbytlink__find_tools if they aren't listed), fixing what made "${failed?.id ?? "the step"}" fail. Use the results of the steps that already ran instead of running them again.`,
    `Then repair the workflow: call ${SAVE_TOOL} with replaces "${workflow.name}", the same name, and tools listing every tool of the whole task in order (${done.map((st) => st.tool).join(", ")}${done.length ? ", then " : ""}the ones you called). The steps that already ran are on record, so the fix is built from real calls. It is saved as a proposed fix for a person to review; the current workflow stays as it is until they apply it.`,
  ].join("\n\n");
}
async function callOwnTool(store: Store, services: ServiceAdapters, identity: Identity, name: string, args: Record<string, unknown>) {
  const w = identity.workspace;
  if (name === "orbytlink__find_skills") return findSkills(store, identity, args);
  if (name === "orbytlink__add_skill") {
    if (typeof args.skill !== "string" || !args.skill.trim()) return toolText("Give the skill as owner/repo@skill from orbytlink__find_skills, or a skill's id.", true);
    try {
      const admin = canConfigure(identity);
      const added = await addSkill(store, w, viewerFor(store, identity), args.skill, admin);
      const where = added.created ? `Added "${added.title}" to OrbytLink's shared library as ${added.id}` : `"${added.title}" (${added.id}) is in the library`;
      const on = admin ? "and it is on for every agent in this workspace" : "and you can use it now; an admin can turn it on for everyone in this workspace in OrbytLink → Skills";
      return toolText(`${where}, ${on}. Its instructions follow; use them for this task.\n\n${added.text}`);
    } catch (error) {
      return toolText((error as Error).message, true);
    }
  }
  if (name === "orbytlink__write_skill") {
    if (!canConfigure(identity)) return toolText("Only an admin's agent can write skills. Ask an admin, or add it yourself in OrbytLink → Skills.", true);
    try {
      const viewer = viewerFor(store, identity);
      const text = typeof args.body === "string" ? args.body : "";
      const meta = frontMatter(text).meta;
      const skillName = String(meta.name || args.name || "").trim();
      // Always private: an agent can't publish instructions to other people.
      const input = { name: skillName, description: String(meta.description || args.description || ""), body: text, files: Array.isArray(args.files) ? args.files : [], visibility: "private" as const };
      authoredSchema.parse(input);
      const existing = skillName ? findAuthoredByName(store, viewer, skillName) : undefined;
      const saved = existing ? updateAuthored(store, viewer, existing, input) : createAuthored(store, viewer, input);
      store.put(w, "skills", { id: saved.id, enabled: true });
      store.audit(w, identity.user, "skill.written", `${saved.id} · private · by agent`);
      return toolText(`${existing ? "Updated" : "Saved"} the skill "${saved.name}" as ${saved.id}. It is private to this user and on for this workspace; load it with orbytlink__use_skill {name: "${saved.id}"}. They can share it or edit it in OrbytLink → Skills.`);
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".") || "skill"}: ${i.message}`).join("; ") : (error as Error).message, true);
    }
  }
  if (name === "orbytlink__use_skill") {
    const id = typeof args.name === "string" ? args.name.trim().slice(0, 80) : "";
    const text = id && skillText(store, viewerFor(store, identity), id);
    if (!text) return toolText("Unknown skill. Find one with orbytlink__find_skills.", true);
    store.audit(w, identity.user, "skill.used", id);
    return toolText(text);
  }
  if (name === API_REQUEST_TOOL) return callStoredApi(store, identity, args);
  if (name === CONNECT_TOOL) {
    const out = connectApp(store, w, canConfigure(identity), args);
    return toolText("error" in out ? (out.error as string) : JSON.stringify(out, null, 1), "error" in out);
  }
  if (name === INSTANT_SEARCH || name === INSTANT_GET || name === INSTANT_CALL) {
    try {
      const out =
        name === INSTANT_SEARCH
          ? { tools: searchInstant(store, String(args.query || "")), next: `Read one with ${INSTANT_GET} {id}, then call it with ${INSTANT_CALL}.` }
          : name === INSTANT_GET
            ? instantTool(store, String(args.id || ""))
            : await callInstant(store, identity, args, "agent");
      return toolText(JSON.stringify(out, null, 1).slice(0, 100_000));
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as any)?.safe ? (error as Error).message : "The instant tool failed.", true);
    }
  }
  if (name === SCRAPE_TOOL || name === MAPS_TOOL) {
    try {
      const out = name === SCRAPE_TOOL ? await scrape(store, w, args) : await scrapeMaps(store, w, args);
      return toolText(JSON.stringify(out, null, 1));
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as any)?.safe ? (error as Error).message : "The scraper failed.", true);
    }
  }
  if (name === BROWSER_TOOL) {
    try {
      const r = await browse(store, identity, args, "agent");
      store.audit(w, identity.user, "browser.run", `${r.status} · ${r.steps} steps · $${usd(r.costMicro).toFixed(2)}`);
      return toolText(browseText(r), r.status === "failed");
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as Error).message, true);
    }
  }
  if (name === AI_TOOL) {
    try {
      const r = await generate(store, identity, args, "agent");
      store.audit(w, identity.user, "ai.generate", `${r.model} · $${usd(r.costMicro).toFixed(6)}`);
      return toolText(r.text);
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as Error).message, true);
    }
  }
  if (name === "orbytlink__api_docs") {
    const match = enabledApis(store, w).find((a) => a.slug === args.api);
    if (!match) return toolText("Unknown or disabled API.", true);
    return toolText(apiDocs(match.api, typeof args.search === "string" ? args.search : undefined));
  }
  if (name === "orbytlink__create_workflow") {
    try {
      const known = new Set([...gatewayTools(store, w).map((t) => t.name), ...visibleWorkflowTools(store, identity).map((t) => t.name), ...(enabledApis(store, w).length ? [API_REQUEST_TOOL] : []), ...(aiConfigured(store) ? [AI_TOOL] : []), ...(browserConfigured(store, w) ? [BROWSER_TOOL] : []), SCRAPE_TOOL, ...(scraperConfigured() ? [MAPS_TOOL] : []), ...(instantConfigured() ? [INSTANT_CALL] : [])]);
      const unknown = ((args.steps as any[]) || []).map((s) => s?.tool).filter((t) => !known.has(t));
      if (unknown.length) return toolText(`Unknown tools: ${unknown.join(", ")}. Use names exactly as listed by this server.`, true);
      const row = saveWorkflow(store, identity, { visibility: "private", ...args, enabled: false, schedule: null }, undefined, "agent");
      return toolText(`Drafted workflow "${row.name}" with ${row.steps.length} steps${row.visibility === "private" ? ", private to you" : ""}. It is disabled until someone reviews and enables it in OrbytLink → Workflows.`);
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? `The workflow is not valid: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : (error as Error).message, true);
    }
  }
  if (name === SAVE_TOOL) {
    try {
      const saved = captureWorkflow(store, identity, args);
      if (saved.proposed) {
        const steps = saved.row.proposal.steps.map((s: Row, i: number) => `${i + 1}. ${s.id} (${s.tool})`).join("\n");
        return toolText(
          [
            `Saved a proposed fix for "${saved.row.name}". The current workflow keeps running as it is until someone who manages it reviews the fix in OrbytLink → Workflows and applies it.`,
            `Proposed steps:\n${steps}`,
            saved.fixed.length ? `Fixed values (check these should not be inputs): ${saved.fixed.slice(0, 12).join("; ")}` : "",
            "Tell the user the task is done, and that a fix for the workflow is waiting for their review.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
      const steps = saved.row.steps.map((s: Row, i: number) => `${i + 1}. ${s.id}${s.tool === "judge" ? ` (decision by ${s.mode || saved.row.judgment})` : ` (${s.tool})`}`).join("\n");
      return toolText(
        [
          `Saved "${saved.row.name}" as a draft workflow${saved.row.visibility === "private" ? ", private to the user" : ""}. Once they enable it in OrbytLink → Workflows it becomes the tool ${saved.tool}.`,
          `Steps:\n${steps}`,
          saved.row.inputs.length ? `Inputs: ${saved.row.inputs.map((i: Row) => i.name).join(", ")}` : "No inputs: it does the same thing every time.",
          saved.linked.length ? `Linked from earlier steps: ${saved.linked.join("; ")}` : "",
          saved.fixed.length ? `Fixed values (check these should not be inputs): ${saved.fixed.slice(0, 12).join("; ")}` : "",
          `File: ${workflowFileName(saved.row)} (${EXPORT_TOOL} returns it).`,
          "Tell the user what was saved, and ask them to review and enable it.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? `The workflow is not valid: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : (error as Error).message, true);
    }
  }
  if (name === EXPORT_TOOL) {
    const want = String(args.name || "").toLowerCase();
    const wf = store.list(w, "workflows").find((r) => visibleTo(r, identity) && (r.name.toLowerCase() === want || workflowToolName(r) === want));
    if (!wf) return toolText("No workflow by that name that you can see.", true);
    return toolText(`${workflowFileName(wf)}\n\n${toMarkdown(wf)}`);
  }
  if (name === RESUME_TOOL) {
    if (typeof args.run !== "string" || typeof args.answer !== "string" || !args.answer.trim()) return toolText("Give the run id and your answer.", true);
    try {
      const outcome = await resumeWorkflow(store, services, identity, args.run, args.answer, "agent");
      for (const t of outcome.trace || []) recordCall(keyFor(identity), t.tool, store.redact(w, t.args) || {}, t.text, true);
      return outcomeText(outcome, store.list(w, "workflows").find((r) => r.id === outcome.workflowId));
    } catch (error) {
      return toolText((error as Error).message, true);
    }
  }
  const match = visibleWorkflowTools(store, identity).find((t) => t.name === name);
  if (!match) return;
  try {
    const outcome = await runWorkflow(store, services, identity, match.workflow, args, "agent");
    // The steps that worked count as calls the agent made, so a repair can be saved from them.
    for (const t of outcome.trace || []) recordCall(keyFor(identity), t.tool, store.redact(w, t.args) || {}, t.text, true);
    return outcomeText(outcome, match.workflow);
  } catch (error) {
    return toolText((error as Error).message, true);
  }
}
