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
import { enabledSkills, skillText } from "./skills.js";
import { runWorkflow, saveWorkflow, workflowInputSchema, workflowToolName } from "./workflows.js";
import { allowedMethods, apiCall } from "./apis.js";

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

export function gatewayServer(
  store: Store,
  services: ServiceAdapters,
  identity: Identity,
) {
  const w = identity.workspace;
  const server = new Server(
    { name: "OrbytLink", version: "0.2.0" },
    {
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      instructions:
        "OrbytLink is a gateway to the apps this workspace has connected. Tool names are <app>__<tool>. Credentials stay on the gateway and are never returned. Skills (orbytlink__use_skill) are instructions to load when a task matches them. workflow__* tools run a fixed sequence of tool calls. APIs stored in OrbytLink are read with orbytlink__api_docs and called with orbytlink__api_request; the gateway adds their keys. To automate a repeated task, draft a workflow with orbytlink__create_workflow; a person reviews and enables it.",
    },
  );
  const allowed = identity.permissions.includes("call");
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowed
      ? [...gatewayTools(store, w).map(({ name, connection, tool }) => ({
          name,
          title: `${connection.name} · ${tool.title || tool.name}`,
          description: [`[${connection.name}]`, tool.description]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1024),
          inputSchema: tool.inputSchema?.type === "object"
            ? tool.inputSchema
            : { type: "object" },
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })), ...ownTools(store, w)]
      : [],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: allowed
      ? enabledSkills(store, w).map((s) => ({ name: s.id, title: s.title, description: s.description.slice(0, 1024) }))
      : [],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const skill = allowed && enabledSkills(store, w).find((s) => s.id === request.params.name);
    if (!skill) throw new Error("Unknown or disabled skill");
    return {
      description: skill.description.slice(0, 1024),
      messages: [{ role: "user" as const, content: { type: "text" as const, text: skillText(skill.id)! } }],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fail = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });
    if (!allowed) return fail("This token cannot call tools.");
    const own = await callOwnTool(store, services, identity, request.params.name, (request.params.arguments || {}) as Record<string, unknown>);
    if (own) return own;
    // Resolve against current configuration, so disabling a tool takes effect immediately.
    const entry = gatewayTools(store, w).find((t) => t.name === request.params.name);
    if (!entry) return fail("Unknown or disabled tool.");
    const { connection, tool } = entry;
    const target = `${connection.name} · ${tool.name}`;
    const started = Date.now();
    try {
      const result = await services.call(
        connection,
        tool.name,
        (request.params.arguments || {}) as Record<string, unknown>,
        await credentialFor(store, w, connection),
      );
      store.audit(w, identity.user, "tool.called", target);
      log(store, w, identity, connection, tool.name, "ok", Date.now() - started);
      // Never let an upstream echo a stored credential back to the client.
      const safe = store.redact(w, result);
      if (safe && typeof safe === "object" && Array.isArray(safe.content))
        return safe;
      return {
        content: [
          {
            type: "text" as const,
            text: typeof safe === "string" ? safe : JSON.stringify(safe),
          },
        ],
      };
    } catch (error) {
      store.audit(w, identity.user, "tool.failed", target);
      log(store, w, identity, connection, tool.name, "error", Date.now() - started);
      const message = (error as Error).message;
      console.warn(`[${new Date().toISOString()}] tool ${target} failed: ${String(message).slice(0, 300)}`);
      // Our own adapter messages are safe to show; anything else stays generic.
      return fail(
        /^(Authorization (required|expired|denied)|Missing path input|Tool inputs do not match|API request failed with status \d+|Response too large|Tool response too large|Operation path leaves)/.test(
          message,
        )
          ? message
          : `${connection.name} could not complete the request.`,
      );
    }
  });
  return server;
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
function enabledWorkflows(store: Store, w: string) {
  const used = new Set<string>();
  return store
    .list(w, "workflows")
    .filter((wf) => wf.enabled)
    .map((wf) => {
      let name = workflowToolName(wf);
      for (let n = 2; used.has(name); n++) name = `${workflowToolName(wf).slice(0, 60)}_${n}`;
      used.add(name);
      return { name, workflow: wf };
    });
}
const apiSlug = (a: Row) => a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "api";
function enabledApis(store: Store, w: string) {
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
function ownTools(store: Store, w: string) {
  const skills = enabledSkills(store, w);
  const tools: any[] = [];
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
  if (skills.length)
    tools.push({
      name: "orbytlink__use_skill",
      title: "Load a skill",
      description: `Load the full instructions of a skill when the task matches it, then follow them. Available skills:\n${skills
        .map((s) => `- ${s.id}: ${s.description.slice(0, 160)}`)
        .join("\n")}`.slice(0, 4000),
      inputSchema: { type: "object", properties: { name: { type: "string", enum: skills.map((s) => s.id) } }, required: ["name"] },
      annotations: { readOnlyHint: true },
    });
  tools.push({
    name: "orbytlink__create_workflow",
    title: "Draft a workflow",
    description:
      "Draft a reusable workflow: a fixed, ordered list of calls to the tools listed by this server (use their exact app__tool names). Step arguments are strings that may contain {{input.<name>}} for a run input, {{steps.<id>.text}} for an earlier step's text result, or {{steps.<id>.json.<path>}} for a field of its JSON result. The draft is saved disabled; a person reviews and enables it in OrbytLink. Use this when the user asks to automate a repeated task.",
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
            properties: { id: { type: "string", description: "lowercase id, e.g. create_issue" }, tool: { type: "string" }, args: { type: "object", additionalProperties: { type: "string" } } },
            required: ["id", "tool"],
          },
        },
      },
      required: ["name", "steps"],
    },
  });
  for (const { name, workflow } of enabledWorkflows(store, w))
    tools.push({
      name,
      title: `Workflow · ${workflow.name}`,
      description: [`[Workflow, ${workflow.steps.length} steps]`, workflow.description].filter(Boolean).join(" ").slice(0, 1024),
      inputSchema: workflowInputSchema(workflow),
    });
  return tools;
}
async function callOwnTool(store: Store, services: ServiceAdapters, identity: Identity, name: string, args: Record<string, unknown>) {
  const w = identity.workspace;
  if (name === "orbytlink__use_skill") {
    const skill = enabledSkills(store, w).find((s) => s.id === args.name);
    if (!skill) return toolText("Unknown or disabled skill.", true);
    store.audit(w, identity.user, "skill.used", skill.id);
    return toolText(skillText(skill.id)!);
  }
  if (name === "orbytlink__api_docs" || name === "orbytlink__api_request") {
    const match = enabledApis(store, w).find((a) => a.slug === args.api);
    if (!match) return toolText("Unknown or disabled API.", true);
    if (name === "orbytlink__api_docs") return toolText(apiDocs(match.api, typeof args.search === "string" ? args.search : undefined));
    try {
      const out = await apiCall(store, w, match.api, { method: args.method, path: args.path, query: args.query, body: args.body });
      store.audit(w, identity.user, "api.request", `${match.api.name} · ${args.method} ${args.path} · ${out.status}`);
      const body = typeof out.body === "string" ? out.body : JSON.stringify(out.body, null, 2);
      return toolText(`HTTP ${out.status}${out.truncated ? " (response truncated)" : ""}\n\n${body.slice(0, 100_000)}`, !out.ok);
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (error as Error).message, true);
    }
  }
  if (name === "orbytlink__create_workflow") {
    try {
      const known = new Set(gatewayTools(store, w).map((t) => t.name));
      const unknown = ((args.steps as any[]) || []).map((s) => s?.tool).filter((t) => !known.has(t));
      if (unknown.length) return toolText(`Unknown tools: ${unknown.join(", ")}. Use names exactly as listed by this server.`, true);
      const row = saveWorkflow(store, identity, { ...args, enabled: false }, undefined, "agent");
      return toolText(`Drafted workflow "${row.name}" with ${row.steps.length} steps. It is disabled until someone reviews and enables it in OrbytLink → Workflows.`);
    } catch (error) {
      const issues = (error as any)?.issues as { path: (string | number)[]; message: string }[] | undefined;
      return toolText(issues ? `The workflow is not valid: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : (error as Error).message, true);
    }
  }
  const match = enabledWorkflows(store, w).find((t) => t.name === name);
  if (!match) return;
  try {
    const outcome = await runWorkflow(store, services, identity, match.workflow, args, "agent");
    return toolText(outcome.status === "succeeded" ? outcome.output || "Workflow finished." : `Workflow failed. ${outcome.error}`, outcome.status !== "succeeded");
  } catch (error) {
    return toolText((error as Error).message, true);
  }
}
