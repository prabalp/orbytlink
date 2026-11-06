import type { Store } from "./store.js";
import { connectIndex, type ConnectEntry } from "./connect-index.js";
import { ToolIndex } from "./tool-search.js";

// When an agent needs an app this workspace has not connected, orbytlink__connect_app finds it in
// the catalog and answers with a link that opens the right form in the console, already filled in,
// and the steps for that app. Nothing is connected by the agent: a person opens the link.
export const CONNECT_TOOL = "orbytlink__connect_app";
export const connectTool = {
  name: CONNECT_TOOL,
  title: "Connect an app",
  description:
    "Use when the user wants an app, API or service that is not connected here (no matching tools from orbytlink__find_tools or orbytlink__list_apps). Finds it in OrbytLink's catalog and returns a link that opens its connect form, with the steps for that app (sign in, or where to get a key). Show the user the link and steps; once they connect it, its tools appear.",
  inputSchema: { type: "object", properties: { app: { type: "string", description: "The app or service, e.g. Apollo, Stripe, Google Sheets" } }, required: ["app"] },
  annotations: { readOnlyHint: true },
};

const origin = () => (process.env.APP_ORIGIN || "http://127.0.0.1:3100").replace(/\/+$/, "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const hostOf = (url = "") => {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).hostname;
  } catch {
    return "";
  }
};
const rank: Record<ConnectEntry["kind"], number> = { mcp: 0, api: 1, soon: 2 };
const index = new ToolIndex(connectIndex.map((e) => ({ name: `${e.kind}:${e.id}`, app: e.segment, title: e.name, description: e.description || "" })));
// Words that say nothing about which app is meant; left out of the text search so "internal tool"
// does not match every app whose category or description mentions tools.
const filler = new Set(["a", "an", "the", "my", "our", "your", "to", "for", "with", "and", "or", "of", "in", "on", "app", "apps", "tool", "tools", "api", "apis", "service", "services", "internal", "account", "connect", "integration", "platform", "data", "use", "using"]);

export function findInCatalog(query: string, limit = 3): ConnectEntry[] {
  const q = norm(query);
  if (!q) return [];
  // Names first (exact, then one containing the other), then a text search of descriptions.
  const exact = connectIndex.filter((e) => norm(e.name) === q || e.id === q);
  const partial = connectIndex.filter((e) => !exact.includes(e) && norm(e.name).length >= 3 && (norm(e.name).includes(q) || q.includes(norm(e.name))));
  const byName = [...exact, ...partial].sort((a, b) => rank[a.kind] - rank[b.kind]);
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !filler.has(w));
  const fuzzy = (words.length ? index.search(words.join(" "), 6) : [])
    .map((d) => connectIndex.find((e) => `${e.kind}:${e.id}` === d.name)!)
    .filter((e) => e && !byName.includes(e));
  return [...byName, ...fuzzy].slice(0, limit);
}

function steps(e: ConnectEntry): string[] {
  if (e.kind === "api")
    return [`Open the link: the ${e.name} form opens with its address and docs filled in.`, "Paste your API key, choose read only or read and write, then click Connect.", ...(e.notes || [])];
  if (e.auth === "oauth" && e.ownClient)
    return [`Open the link: the ${e.name} form opens filled in.`, `${e.name} needs your own OAuth app: create one, add the redirect URI shown in the form, and paste its client ID.`, "Click Save connection, then Connect and sign in.", ...(e.notes || [])];
  if (e.auth === "oauth") return [`Open the link and click Save connection.`, `Click Connect and sign in with ${e.name}, then approve access.`, ...(e.notes || [])];
  if (e.auth === "none") return ["Open the link, click Save connection, then Test. No key is needed.", ...(e.notes || [])];
  return [`Open the link and paste your ${e.name} key.`, "Click Save connection, then Test.", ...(e.notes || [])];
}

export function connectApp(store: Store, workspace: string, canConfigure: boolean, args: Record<string, unknown>) {
  const query = typeof args.app === "string" ? args.app.trim().slice(0, 120) : "";
  if (!query) return { error: "Name the app, e.g. Apollo or Google Sheets." };
  const custom = `${origin()}/#connections`;
  const found = findInCatalog(query);
  const connections = store.list(workspace, "connections");
  const apis = store.list(workspace, "apis");
  const results = found.map((e) => {
    if (e.kind === "soon")
      return {
        app: e.name,
        status: "No ready-made connection yet",
        steps: [`OrbytLink has no verified connection for ${e.name} yet.`, `If ${e.name} offers an MCP server URL or an HTTPS API, add it yourself: open ${custom}, click Add connection, and choose MCP or API.`],
      };
    const existing =
      e.kind === "mcp" ? connections.find((c) => c.endpoint === e.endpoint) : apis.find((a) => hostOf(a.baseUrl) && hostOf(a.baseUrl) === hostOf(e.endpoint));
    if (existing)
      return {
        app: e.name,
        type: e.kind === "mcp" ? "MCP server" : "API",
        status: existing.enabled === false ? "Connected but turned off" : e.kind === "mcp" && existing.status !== "Connected" ? `Added, but not working yet (${existing.status || "not tested"})` : "Already connected",
        steps: existing.enabled === false || (e.kind === "mcp" && existing.status !== "Connected") ? [`Open ${custom} and fix "${existing.name}" (turn it on, sign in or test it).`] : ["Its tools are available: use orbytlink__find_tools or orbytlink__api_docs."],
      };
    const link = `${origin()}/#connect=${e.kind}:${e.id}`;
    return {
      app: e.name,
      type: e.kind === "mcp" ? "MCP server" : "API",
      what: e.description,
      status: "Not connected",
      link,
      steps: canConfigure ? steps(e) : [`Only an admin of this workspace can connect apps. Send them this link: ${link}`],
      docs: e.docs,
    };
  });
  return {
    query,
    results,
    ...(results.length ? {} : { notFound: `"${query}" is not in OrbytLink's catalog. If it has an MCP server URL or an HTTPS API, add it at ${custom} (Add connection, then MCP or API).` }),
    next: "Show the user the link and the steps in plain words. After they connect it, call orbytlink__find_tools again to use its tools.",
  };
}
