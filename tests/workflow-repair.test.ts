import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { resetCapture } from "../server/capture";
import { retryDelay } from "../server/workflows";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
let leads: { id: string; email: string }[];
let slackFails: string | undefined;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) => inject(app, { url, method, headers: { Cookie: c }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function agent(c = cookie) {
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 }, "POST", c)).data.token as string;
  const client = new Client({ name: "agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_input, init) => {
        const r = await inject(app, { url: "/mcp", method: init?.method || "POST", headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(r.text, { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !["transfer-encoding", "content-length"].includes(k)).map(([k, v]) => [k, String(v)])) });
      },
    }),
  );
  return client;
}
async function addApp(name: string, tools: string[]) {
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: tools.map((t) => ({ name: t, description: t, inputSchema: { type: "object" } })) });
  const row = (await api("/api/connections", { name, kind: "mcp", endpoint: `https://${name.toLowerCase()}.example/mcp` })).data;
  return (await api(`/api/connections/${row.id}/test`, {})).data;
}
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
const calls = (tool: string) => vi.mocked(services.call).mock.calls.filter((c) => c[1] === tool).map((c) => c[2]);

beforeEach(async () => {
  resetCapture();
  slackFails = undefined;
  retryDelay.ms = 1;
  leads = [{ id: "L-77", email: "ada@lovelace.example" }];
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args) => {
      if (tool === "list_leads") return { content: [{ type: "text", text: JSON.stringify({ leads, since: args.since }) }] };
      if (tool === "tag_lead") return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: args.id }) }] };
      if (tool === "send_message" && slackFails) return { isError: true, content: [{ type: "text", text: slackFails }] };
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, ...args }) }] };
    }),
  };
  app = createApp(store, services).app;
  cookie = await register("Alice");
  await addApp("CRM", ["list_leads", "tag_lead"]);
  await addApp("Slack", ["send_message"]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  retryDelay.ms = 300;
});

async function doTheTask(client: Client, since = "2026-11-01") {
  await client.callTool({ name: "crm__list_leads", arguments: { since } });
  await client.callTool({ name: "crm__tag_lead", arguments: { id: leads[0].id, label: "hot" } });
  await client.callTool({ name: "slack__send_message", arguments: { channel: "C9", text: `Tagged ${leads[0].id} for ${leads[0].email}` } });
}
const TOOLS = ["crm__list_leads", "crm__tag_lead", "slack__send_message"];
// The task, saved as a workflow and enabled, as a person would after reviewing it.
async function liveWorkflow(client: Client) {
  await doTheTask(client);
  await client.callTool({ name: "orbytlink__save_workflow", arguments: { name: "Tag new leads", tools: TOOLS, inputs: { since: "2026-11-01" } } });
  const wf = (await api("/api/state")).data.workflows[0];
  expect((await api(`/api/workflows/${wf.id}`, { ...wf, enabled: true }, "PUT")).status).toBe(200);
  return (await api("/api/state")).data.workflows[0];
}

it("counts what a successful run spared the agent: the calls it made and the data that never reached the agent", async () => {
  const client = await agent();
  await liveWorkflow(client);
  const r = await client.callTool({ name: "workflow__tag_new_leads", arguments: { since: "2026-11-05" } });
  expect(r.isError).toBeFalsy();
  const state = (await api("/api/state")).data;
  const run = state.workflowRuns.find((x: any) => x.trigger === "agent");
  expect(run.saved.calls).toBe(3);
  expect(run.saved.tokens).toBeGreaterThan(0);
  expect(state.workflows[0].stats).toMatchObject({ runs: 1, succeeded: 1, failed: 0, calls: 3, tokens: run.saved.tokens, failStreak: 0 });
});

it("when a workflow fails, the agent learns what already happened, finishes the task, and proposes a fix without touching the live workflow", async () => {
  const client = await agent();
  const live = await liveWorkflow(client);
  slackFails = "HTTP 404 channel_not_found";
  const failed = await client.callTool({ name: "workflow__tag_new_leads", arguments: { since: "2026-11-05" } });
  expect(failed.isError).toBe(true);
  const says = text(failed);
  expect(says).toContain("Already done, and these took effect (don't repeat them): list_leads (crm__list_leads), tag_lead (crm__tag_lead)");
  expect(says).toContain("Not done: send_message (slack__send_message)");
  expect(says).toContain('replaces "Tag new leads"');
  expect((await api("/api/state")).data.workflows[0].stats).toMatchObject({ failStreak: 1, failed: 1 });

  // The agent finishes the job itself, posting to a channel that exists, then saves the repair.
  slackFails = undefined;
  await client.callTool({ name: "slack__send_message", arguments: { channel: "C42", text: `Tagged ${leads[0].id} for ${leads[0].email}` } });
  const fix = await client.callTool({ name: "orbytlink__save_workflow", arguments: { name: "Tag new leads", tools: TOOLS, inputs: { since: "2026-11-05" }, replaces: "Tag new leads" } });
  expect(fix.isError).toBeFalsy();
  expect(text(fix)).toContain("proposed fix");

  const wf = (await api("/api/state")).data.workflows[0];
  expect(wf.enabled).toBe(true);
  expect(wf.steps).toEqual(live.steps); // the live version is untouched
  expect(wf.proposal.proposedBy).toBe("alice@example.invalid");
  const send = wf.proposal.steps.find((st: any) => st.tool === "slack__send_message");
  expect(send.args.channel).toBe("C42");
  // The steps that ran inside the failed workflow were kept, so the fix still links them.
  expect(wf.proposal.steps.find((st: any) => st.tool === "crm__tag_lead").args.id).toBe("{{steps.list_leads.json.leads.0.id}}");

  // Turning the workflow off and on again is an ordinary save: the fix keeps waiting.
  await api(`/api/workflows/${wf.id}`, { ...wf, enabled: false }, "PUT");
  expect((await api("/api/state")).data.workflows[0].proposal).toBeTruthy();
  // Applying it is the reviewed save, which clears the proposal.
  const { proposal, ...rest } = wf;
  expect((await api(`/api/workflows/${wf.id}?fix=apply`, { ...rest, ...proposal, enabled: true, proposedBy: undefined, proposedAt: undefined }, "PUT")).status).toBe(200);
  const applied = (await api("/api/state")).data.workflows[0];
  expect(applied.proposal).toBeUndefined();
  expect(applied.steps.find((st: any) => st.tool === "slack__send_message").args.channel).toBe("C42");
  expect(applied.stats.failed).toBe(1); // history survives the edit
});

it("tells reads from writes: the app's own hints first, then the tool's name", async () => {
  const { toolChanges } = await import("../server/workflows");
  expect(toolChanges({ name: "send_message" })).toBe(true);
  expect(toolChanges({ name: "list_leads" })).toBe(false);
  expect(toolChanges({ name: "getUser" })).toBe(false);
  expect(toolChanges({ name: "listing_update" })).toBe(true);
  expect(toolChanges({ name: "send_message", annotations: { readOnlyHint: true } })).toBe(false);
  expect(toolChanges({ name: "get_and_delete", annotations: { destructiveHint: true } })).toBe(true);
});

it("a proposed fix can be turned down, leaving the workflow as it was", async () => {
  const client = await agent();
  await liveWorkflow(client);
  await doTheTask(client);
  await client.callTool({ name: "orbytlink__save_workflow", arguments: { name: "Tag new leads", tools: TOOLS, inputs: { since: "2026-11-01" }, replaces: "workflow__tag_new_leads" } });
  const wf = (await api("/api/state")).data.workflows[0];
  expect(wf.proposal).toBeTruthy();
  expect((await api(`/api/workflows/${wf.id}/proposal`, undefined, "DELETE")).status).toBe(200);
  const after = (await api("/api/state")).data.workflows[0];
  expect(after.proposal).toBeUndefined();
  expect(after.enabled).toBe(true);
});

it("a step that changes things is retried only when the app clearly never got the request", async () => {
  const client = await agent();
  const wf = await liveWorkflow(client);
  const steps = wf.steps.map((st: any) => (st.tool === "slack__send_message" ? { ...st, retries: 2 } : st));
  await api(`/api/workflows/${wf.id}`, { ...wf, steps }, "PUT");
  const sends = () => calls("send_message").length;

  // A server error may mean the message went out: no retry, so it is never posted twice.
  slackFails = "HTTP 500 internal_error";
  let before = sends();
  await client.callTool({ name: "workflow__tag_new_leads", arguments: { since: "2026-11-05" } });
  expect(sends() - before).toBe(1);

  // Rate limited means it was refused before anything happened: retrying is safe.
  slackFails = "HTTP 429 Too Many Requests";
  before = sends();
  await client.callTool({ name: "workflow__tag_new_leads", arguments: { since: "2026-11-05" } });
  expect(sends() - before).toBe(3);
});

it("a read-only step is retried on any error", async () => {
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
  const row = (await api("/api/connections", { name: "Docs", kind: "mcp", endpoint: "https://docs.example/mcp" })).data;
  await api(`/api/connections/${row.id}/test`, {});
  let attempts = 0;
  vi.mocked(services.call).mockImplementation(async (_c, tool) => {
    if (tool === "lookup" && ++attempts < 3) return { isError: true, content: [{ type: "text", text: "HTTP 500 flaky" }] };
    return { content: [{ type: "text", text: "{}" }] };
  });
  const wf = (await api("/api/workflows", { name: "Look it up", steps: [{ id: "find", tool: "docs__lookup", args: {}, retries: 2 }], enabled: true })).data;
  const out = (await api(`/api/workflows/${wf.id}/run`, { inputs: {} })).data;
  expect(out.status).toBe("succeeded");
  expect(attempts).toBe(3);
});
