import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { keyFor, memoryStats, noticeRepeat, recordCall, resetCapture, suggestionsFor } from "../server/capture";
import { limits, runDueWorkflows, runStats, scheduleClock, syncSchedule } from "../server/workflows";
import { grantCredits } from "../server/ai";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters, workspace: string;
let leads: { id: string; email: string }[];
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
  leads = [{ id: "L-77", email: "ada@lovelace.example" }];
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args) => {
      if (tool === "list_leads") return { content: [{ type: "text", text: JSON.stringify({ leads, since: args.since }) }] };
      if (tool === "tag_lead") return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: args.id }) }] };
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, ...args }) }] };
    }),
  };
  app = createApp(store, services).app;
  cookie = await register("Alice");
  workspace = (await api("/api/state")).data.identity.workspace;
  await addApp("CRM", ["list_leads", "tag_lead"]);
  await addApp("Slack", ["send_message"]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
  scheduleClock.now = () => Date.now();
});

async function doTheTask(client: Client, since = "2026-11-01") {
  await client.callTool({ name: "crm__list_leads", arguments: { since } });
  await client.callTool({ name: "crm__tag_lead", arguments: { id: leads[0].id, label: "hot" } });
  await client.callTool({ name: "slack__send_message", arguments: { channel: "C9", text: `Tagged ${leads[0].id} for ${leads[0].email}` } });
}

it("saves a task from the calls that really ran: inputs from the user, links to earlier results, the rest fixed", async () => {
  const client = await agent();
  await doTheTask(client);
  const saved = await client.callTool({
    name: "orbytlink__save_workflow",
    arguments: { name: "Tag new leads", description: "Tag fresh leads and tell #sales", tools: ["crm__list_leads", "crm__tag_lead", "slack__send_message"], inputs: { since: "2026-11-01" } },
  });
  expect(saved.isError).toBeFalsy();
  expect(text(saved)).toContain("tag_lead.id ← list_leads");
  expect(text(saved)).toContain("send_message.channel = C9");
  expect(text(saved)).toContain("workflow_tag_new_leads.md");
  const wf = (await api("/api/state")).data.workflows.find((w: any) => w.name === "Tag new leads");
  expect(wf).toMatchObject({ enabled: false, visibility: "private", source: "agent", inputs: [{ name: "since" }] });
  expect(wf.steps.map((s: any) => [s.id, s.args])).toEqual([
    ["list_leads", { since: "{{input.since}}" }],
    ["tag_lead", { id: "{{steps.list_leads.json.leads.0.id}}", label: "hot" }],
    ["send_message", { channel: "C9", text: "Tagged L-77 for {{steps.list_leads.json.leads.0.email}}" }],
  ]);
  // Enabled, it replays with new data: one call instead of three.
  await api(`/api/workflows/${wf.id}`, { ...wf, enabled: true }, "PUT");
  leads = [{ id: "L-99", email: "grace@hopper.example" }];
  const run = await client.callTool({ name: "workflow__tag_new_leads", arguments: { since: "2026-11-05" } });
  expect(run.isError).toBeFalsy();
  expect(calls("list_leads").at(-1)).toEqual({ since: "2026-11-05" });
  expect(calls("tag_lead").at(-1)).toEqual({ id: "L-99", label: "hot" });
  expect(calls("send_message").at(-1)).toEqual({ channel: "C9", text: "Tagged L-77 for grace@hopper.example" });

  // Inputs that were never used, or a task that never ran, are refused with a reason.
  const unused = await client.callTool({ name: "orbytlink__save_workflow", arguments: { name: "Nope", tools: ["crm__list_leads"], inputs: { region: "EMEA" } } });
  expect(text(unused)).toMatch(/weren't found in any call: region/);
  const never = await client.callTool({ name: "orbytlink__save_workflow", arguments: { name: "Never", tools: ["github__open_pr"] } });
  expect(text(never)).toMatch(/No recent successful call of github__open_pr/);
});

it("pauses at a decision for the agent or the person, and goes on with their answer", async () => {
  const client = await agent();
  await doTheTask(client);
  await client.callTool({
    name: "orbytlink__save_workflow",
    arguments: {
      name: "Pick and tag",
      tools: ["crm__list_leads", "crm__tag_lead"],
      inputs: { since: "2026-11-01" },
      judgments: [{ before: 2, prompt: "Which lead in {{steps.list_leads.text}} is hottest?", returns: 'JSON {"id": string}' }],
      overrides: [{ step: 3, arg: "id", value: "{{steps.decide_1.json.id}}" }],
    },
  });
  const wf = (await api("/api/state")).data.workflows.find((w: any) => w.name === "Pick and tag");
  expect(wf.steps.map((s: any) => s.id)).toEqual(["list_leads", "decide_1", "tag_lead"]);
  await api(`/api/workflows/${wf.id}`, { ...wf, enabled: true }, "PUT");
  // An agent gets the question and answers through the resume tool.
  const paused = text(await client.callTool({ name: "workflow__pick_and_tag", arguments: { since: "2026-11-05" } }));
  expect(paused).toContain("paused for a decision");
  expect(paused).toContain("Which lead in");
  const runId = /run ([0-9a-f-]{36})/.exec(paused)![1];
  expect((await api("/api/state")).data.workflowRuns[0]).toMatchObject({ id: runId, status: "waiting" });
  const done = await client.callTool({ name: "orbytlink__resume_workflow", arguments: { run: runId, answer: '{"id": "L-123"}' } });
  expect(done.isError).toBeFalsy();
  expect(calls("tag_lead").at(-1)).toEqual({ id: "L-123", label: "hot" });
  expect((await api("/api/state")).data.workflowRuns[0]).toMatchObject({ id: runId, status: "succeeded" });
  // A run is answered once; and only by the person it paused for.
  expect((await client.callTool({ name: "orbytlink__resume_workflow", arguments: { run: runId, answer: "x" } })).isError).toBe(true);

  // In the console, the person running it answers on the run screen.
  const out = (await api(`/api/workflows/${wf.id}/run`, { inputs: { since: "2026-11-06" } })).data;
  expect(out).toMatchObject({ status: "waiting", returns: 'JSON {"id": string}' });
  const bob = await register("Bobby");
  expect((await api(`/api/workflows/runs/${out.runId}/resume`, { answer: '{"id":"L-1"}' }, "POST", bob)).status).toBe(404);
  const finished = (await api(`/api/workflows/runs/${out.runId}/resume`, { answer: '{"id": "L-5"}' })).data;
  expect(finished.status).toBe("succeeded");
  expect(calls("tag_lead").at(-1)).toEqual({ id: "L-5", label: "hot" });

  // A schedule can't stop to ask, so an agent decision there fails with a reason.
  scheduleClock.now = () => Date.parse("2026-11-06T00:00:00Z");
  const scheduled = (await api(`/api/workflows/${wf.id}`, { ...wf, enabled: true, schedule: { every: "day", at: "09:00", timezone: "UTC", inputs: { since: "2026-11-01" } } }, "PUT")).data;
  expect(scheduled.schedule).toBeTruthy();
  await runDueWorkflows(store, services, new Date("2026-11-06T09:00:05Z"));
  const failed = (await api("/api/state")).data.workflowRuns[0];
  expect(failed).toMatchObject({ trigger: "schedule", status: "failed" });
  expect(JSON.stringify(failed.steps)).toMatch(/needs a decision from a person or agent/);
});

it("lets an AI model make the decision when the workflow says so", async () => {
  process.env.AI_GATEWAY_API_KEY = "vck_test";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: '{"id": "L-AI"}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })));
  grantCredits(store, workspace, 1_000_000, "operator");
  const wf = (
    await api("/api/workflows", {
      name: "AI picks",
      enabled: true,
      judgment: "ai",
      steps: [
        { id: "list", tool: "crm__list_leads" },
        { id: "pick", tool: "judge", args: { prompt: "Pick the hottest of {{steps.list.text}}", returns: 'JSON {"id": string}' } },
        { id: "tag", tool: "crm__tag_lead", args: { id: "{{steps.pick.json.id}}" } },
      ],
    })
  ).data;
  const out = (await api(`/api/workflows/${wf.id}/run`, {})).data;
  expect(out.status).toBe("succeeded");
  expect(out.steps[1]).toMatchObject({ id: "pick", note: "Decided by AI" });
  expect(calls("tag_lead").at(-1)).toEqual({ id: "L-AI" });
});

it("exports workflow_<name>.md and imports it back to the same workflow", async () => {
  const wf = (
    await api("/api/workflows", {
      name: "Weekly digest",
      description: "Summarise leads for #sales",
      inputs: [{ name: "since", description: "Start date" }],
      judgment: "ai",
      notes: "# Weekly digest\n\nRuns every Monday.",
      steps: [
        { id: "list", tool: "crm__list_leads", args: { since: "{{input.since}}" }, retries: 2 },
        { id: "pick", tool: "judge", args: { prompt: "Pick 3 from {{steps.list.text}}" }, mode: "agent" },
        { id: "post", tool: "slack__send_message", args: { channel: "C9", text: "{{steps.pick.text}}" }, onError: "continue" },
      ],
    })
  ).data;
  const file = await api(`/api/workflows/${wf.id}/markdown`);
  expect(file.headers["content-disposition"]).toContain('filename="workflow_weekly_digest.md"');
  expect(file.text).toMatch(/^---\nname: Weekly digest/);
  expect(file.text).toContain("```yaml workflow");
  const client = await agent();
  expect(text(await client.callTool({ name: "orbytlink__export_workflow", arguments: { name: "weekly digest" } }))).toContain("workflow_weekly_digest.md");
  await api(`/api/workflows/${wf.id}`, undefined, "DELETE");
  const back = (await api("/api/workflows/import", { markdown: file.text })).data;
  for (const k of ["name", "description", "inputs", "steps", "judgment", "notes"]) expect(back[k]).toEqual(wf[k]);
  expect(back.enabled).toBe(false);
  const broken = await api("/api/workflows/import", { markdown: "---\nname: x\n---\nno steps here" });
  expect(broken.status).toBe(400);
  expect(broken.data.error).toMatch(/yaml workflow block/);
});

it("notices a task done the same way three times, and turns it into a draft on request", async () => {
  const key = keyFor({ workspace, user: "alice@example.invalid" });
  const t0 = Date.parse("2026-11-02T09:00:00Z");
  const once = (at: number) => {
    recordCall(key, "crm__list_leads", { since: "x" }, JSON.stringify({ leads }), true, at);
    recordCall(key, "slack__send_message", { channel: "C9", text: "L-77" }, "{}", true, at + 1000);
    return noticeRepeat(key, at + 1000);
  };
  expect(once(t0)).toBeUndefined();
  expect(once(t0 + 3 * 3600_000)).toBeUndefined();
  const third = once(t0 + 6 * 3600_000);
  expect(third).toMatchObject({ tools: ["crm__list_leads", "slack__send_message"], count: 3 });
  // Suggested once, not on every later repeat.
  expect(once(t0 + 9 * 3600_000)).toBeUndefined();
  expect(suggestionsFor(key)).toHaveLength(1);
  // A loop over one tool is not a task.
  recordCall(key, "crm__tag_lead", {}, "{}", true, t0 + 9 * 3600_000 + 5000);
  recordCall(key, "crm__tag_lead", {}, "{}", true, t0 + 9 * 3600_000 + 6000);
  expect(noticeRepeat(key, t0 + 9 * 3600_000 + 6000)?.tools).not.toEqual(["crm__tag_lead", "crm__tag_lead"]);
});

it("handles 10,000 workflows across 1,000 workspaces: schedule ticks stay cheap and runs stay within limits", async () => {
  scheduleClock.now = () => Date.parse("2026-11-06T00:00:00Z");
  const owner = (await api("/api/state")).data.identity.user;
  const insert = store.db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  store.transaction(() => {
    for (let w = 0; w < 1000; w++)
      for (let n = 0; n < 10; n++) {
        const id = `wf-${w}-${n}`;
        const wf = { id, name: `Flow ${n}`, enabled: true, visibility: "workspace", steps: [{ id: "a", tool: "crm__list_leads", args: {} }], inputs: [], createdBy: owner, scheduledBy: owner, schedule: n === 0 ? { every: "day", at: `${String(w % 24).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`, timezone: "UTC", inputs: {} } : null };
        insert.run(`ws-${w}`, "workflows", id, JSON.stringify(wf));
        if (wf.schedule) syncSchedule(store, `ws-${w}`, wf);
      }
  });
  expect((store.db.prepare("SELECT count(*) AS n FROM workflow_schedule").get() as any).n).toBe(1000);
  // A tick with nothing due reads the index only.
  let t = performance.now();
  // ws-0 is due at 00:00. Its owner isn't a member there, so it is claimed and skipped, never run.
  expect(await runDueWorkflows(store, services, new Date("2026-11-06T00:00:30Z"))).toBe(0);
  const tick = performance.now() - t;
  expect((store.db.prepare("SELECT next_due FROM workflow_schedule WHERE workflow_id='wf-0-0'").get() as any).next_due).toBe(Date.parse("2026-11-07T00:00:00Z"));
  expect(tick).toBeLessThan(100);
  t = performance.now();
  await runDueWorkflows(store, services, new Date("2026-11-06T00:00:50Z"));
  expect(performance.now() - t).toBeLessThan(20);

  // 120 runs at once in one busy workspace: never more than the per-workspace limit in flight.
  let live = 0,
    peak = 0;
  vi.mocked(services.call).mockImplementation(async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return { content: [{ type: "text", text: "{}" }] };
  });
  const wf = (await api("/api/workflows", { name: "Busy", enabled: true, steps: [{ id: "a", tool: "crm__list_leads" }] })).data;
  const runs = await Promise.all(Array.from({ length: 120 }, () => api(`/api/workflows/${wf.id}/run`, {})));
  expect(runs.every((r) => r.data.status === "succeeded")).toBe(true);
  expect(peak).toBeLessThanOrEqual(limits.perWorkspace);
  expect(runStats()).toEqual({ active: 0, queued: 0 });
});

it("keeps the call memory inside its budget however many people are active", () => {
  const big = "x".repeat(6000);
  for (let p = 0; p < 3000; p++) for (let c = 0; c < 30; c++) recordCall(`ws\u0000user${p}`, "crm__list_leads", { n: c }, big, true);
  expect(memoryStats().bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
});
