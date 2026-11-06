import { beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { bindTemplate, missingApps, templateLogos, workflowTemplates } from "../src/workflow-templates";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const str = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) });
// Every app a template can need, with argument names the way real servers spell them.
const APPS: Record<string, { name: string; inputSchema: any }[]> = {
  Linear: [{ name: "create_issue", inputSchema: str("title", "description") }, { name: "list_issues", inputSchema: str() }],
  Slack: [{ name: "send_message", inputSchema: str("channel", "text") }],
  "Google Sheets": [{ name: "append_values", inputSchema: str("spreadsheet_id", "range", "values") }],
  Notion: [{ name: "create_page", inputSchema: str("title", "content") }],
  Gmail: [{ name: "create_draft", inputSchema: str("to", "subject", "body") }],
};
async function connect(app: string, only?: string[]) {
  const tools = APPS[app].filter((t) => !only || only.includes(t.name));
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: tools.map((t) => ({ description: t.name, ...t })) });
  const row = (await api("/api/connections", { name: app, kind: "mcp", endpoint: `https://${app.toLowerCase().replace(/ /g, "")}.example/mcp` })).data;
  await api(`/api/connections/${row.id}/test`, {});
}
const gatewayTools = async () => {
  const state = (await api("/api/state")).data;
  return state.gatewayTools.map((t: any) => ({ name: t.name, def: state.connections.find((c: any) => c.id === t.connectionId).tools.find((x: any) => x.name === t.tool) }));
};
// What the editor sends when saving: the bound draft without its display-only hints.
const toSave = (draft: any) => ({ ...draft, steps: draft.steps.map(({ hint: _hint, ...s }: any) => s) });
const called = (tool: string) => vi.mocked(services.call).mock.calls.filter((c) => c[1] === tool).map((c) => c[2]);

beforeEach(async () => {
  store = new Store(":memory:");
  services = { test: vi.fn(), call: vi.fn(async (_c, tool) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, tool, issues: [{ title: "Login is slow" }] }) }] })) };
  app = createApp(store, services).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  for (const a of Object.keys(APPS)) await connect(a);
});

it("saves every template through the real rules, with the engine's settings carried over", async () => {
  const tools = await gatewayTools();
  for (const t of workflowTemplates) {
    expect(missingApps(t, tools)).toEqual([]);
    const draft = bindTemplate(t, tools);
    expect(draft.steps.every((s: any) => s.tool), `${t.id} has an unbound step`).toBe(true);
    const saved = await api("/api/workflows", { ...toSave(draft), enabled: true, source: "template" });
    expect(saved.status, `${t.id}: ${JSON.stringify(saved.data)}`).toBe(200);
    expect(saved.data).toMatchObject({ source: "template", judgment: t.judgment || "agent" });
    expect(saved.data.ui.output.from, t.id).toBe(t.ui?.output?.from);
  }
});

it("runs the announce template with retries, and an announcement failure doesn't undo the issue", async () => {
  const t = workflowTemplates.find((x) => x.id === "issue-announce")!;
  const wf = (await api("/api/workflows", { ...toSave(bindTemplate(t, await gatewayTools())), enabled: true })).data;
  expect(wf.steps.map((s: any) => [s.id, s.retries ?? 0, s.onError])).toEqual([["issue", 2, "stop"], ["post", 2, "continue"]]);
  vi.mocked(services.call).mockImplementation(async (_c, tool) => (tool === "send_message" ? { content: [{ type: "text", text: "channel_not_found" }], isError: true } : { content: [{ type: "text", text: '{"id":"ENG-1"}' }] }));
  const run = (await api(`/api/workflows/${wf.id}/run`, { inputs: { title: "Login is slow", details: "Over 5s", channel: "C1" } })).data;
  expect(run.status).toBe("succeeded");
  expect(run.steps.map((s: any) => [s.id, s.status])).toEqual([["issue", "ok"], ["post", "error"]]);
  expect(called("create_issue")).toEqual([{ title: "Login is slow", description: "Over 5s" }]);
});

it("pauses the email template at the wording, and drafts with the agent's answer", async () => {
  const t = workflowTemplates.find((x) => x.id === "email-draft")!;
  const wf = (await api("/api/workflows", { ...toSave(bindTemplate(t, await gatewayTools())), enabled: true })).data;
  expect(wf.steps[0]).toMatchObject({ id: "write", tool: "judge" });
  const out = (await api(`/api/workflows/${wf.id}/run`, { inputs: { to: "ada@example.invalid", subject: "Renewal", notes: "thank them, ask for a call" } })).data;
  expect(out.status).toBe("waiting");
  expect(out.question).toContain("thank them, ask for a call");
  const done = (await api(`/api/workflows/runs/${out.runId}/resume`, { answer: "Hi Ada, thanks for renewing. Could we talk this week?" })).data;
  expect(done.status).toBe("succeeded");
  expect(called("create_draft")).toEqual([{ to: "ada@example.invalid", subject: "Renewal", body: "Hi Ada, thanks for renewing. Could we talk this week?" }]);
});

it("reads issues, has them summarised, and posts the digest, keeping the latest result", async () => {
  const t = workflowTemplates.find((x) => x.id === "issue-digest")!;
  const wf = (await api("/api/workflows", { ...toSave(bindTemplate(t, await gatewayTools())), enabled: true })).data;
  expect(wf).toMatchObject({ keepLastResult: true, ui: { output: { from: "digest", view: "text" } } });
  const out = (await api(`/api/workflows/${wf.id}/run`, { inputs: { channel: "C7" } })).data;
  expect(out.status).toBe("waiting");
  expect(out.question).toContain("Login is slow");
  const done = (await api(`/api/workflows/runs/${out.runId}/resume`, { answer: "- Login is slow (urgent)" })).data;
  expect(done.status).toBe("succeeded");
  expect(called("send_message").at(-1)).toEqual({ channel: "C7", text: "- Login is slow (urgent)" });
  expect((await api(`/api/workflows/${wf.id}/result`)).data).toMatchObject({ status: "succeeded" });
});

it("tells the person which apps a template still needs, and ignores decision steps", async () => {
  const t = workflowTemplates.find((x) => x.id === "issue-digest")!;
  const onlyLinear = (await gatewayTools()).filter((x: any) => x.name.startsWith("linear__"));
  expect(missingApps(t, onlyLinear)).toEqual(["Slack"]);
  expect(missingApps(workflowTemplates.find((x) => x.id === "email-draft")!, onlyLinear)).toEqual(["Gmail"]);
  expect(templateLogos(t)).toEqual(["linear", "slack"]);
  const draft = bindTemplate(t, onlyLinear);
  expect(draft.steps.find((s: any) => s.id === "post")).toMatchObject({ tool: "", hint: { app: "Slack" } });
  expect(draft.steps.find((s: any) => s.id === "digest")).toMatchObject({ tool: "judge" });
});
