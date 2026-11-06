import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { markInterrupted } from "../server/workflows";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
async function addApp(name: string, tools: string[]) {
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: tools.map((t) => ({ name: t, description: t, inputSchema: { type: "object" } })) });
  const row = (await api("/api/connections", { name, kind: "mcp", endpoint: `https://${name.toLowerCase()}.example/mcp` })).data;
  await api(`/api/connections/${row.id}/test`, {});
}
const save = async (wf: Record<string, unknown>) => api("/api/workflows", { enabled: true, ...wf });
const run = async (id: string, inputs: Record<string, string> = {}) => (await api(`/api/workflows/${id}/run`, { inputs })).data;
const calls = (tool: string) => vi.mocked(services.call).mock.calls.filter((c) => c[1] === tool).map((c) => c[2]);

beforeEach(async () => {
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args) => ({ content: [{ type: "text", text: JSON.stringify(tool === "list_leads" ? { leads: [{ name: "Ada" }, { name: "Linus" }] } : { tool, args }) }] })),
  };
  app = createApp(store, services).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  await addApp("CRM", ["list_leads", "tag", "a", "b", "c"]);
});
afterEach(() => vi.restoreAllMocks());

it("remembers values between runs, readable as {{state.name}}, and can be reset", async () => {
  const wf = (await save({
    name: "Track leads",
    steps: [
      { id: "tag", tool: "crm__tag", args: { previous: "{{state.newest}}" } },
      { id: "find", tool: "crm__list_leads", remember: { newest: "{{steps.find.json.leads.0.name}}" } },
    ],
  })).data;
  expect(wf.id, JSON.stringify(wf)).toBeTruthy();
  await run(wf.id);
  expect(calls("tag")[0]).toEqual({});
  await run(wf.id);
  expect(calls("tag")[1]).toEqual({ previous: "Ada" });
  expect((await api(`/api/workflows/${wf.id}/state`)).data).toMatchObject([{ key: "newest", preview: "Ada" }]);
  await inject(app, { url: `/api/workflows/${wf.id}/state`, method: "DELETE", headers: { Cookie: cookie } });
  expect((await api(`/api/workflows/${wf.id}/state`)).data).toEqual([]);
});

it("refuses a remembered value from a step that comes later, and on a decision step", async () => {
  const bad = await save({ name: "Bad", steps: [{ id: "one", tool: "crm__a", remember: { x: "{{steps.two.text}}" } }, { id: "two", tool: "crm__b" }] });
  expect(bad.status).toBe(400);
  const judge = await save({ name: "Bad two", steps: [{ id: "one", tool: "judge", args: { prompt: "pick" }, remember: { x: "y" } }] });
  expect(judge.status).toBe(400);
});

it("reuses a cached step result for the time asked, and says so", async () => {
  const wf = (await save({ name: "Cached", steps: [{ id: "find", tool: "crm__list_leads", cache: 60 }, { id: "tag", tool: "crm__tag" }] })).data;
  const first = await run(wf.id);
  const second = await run(wf.id);
  expect(calls("list_leads")).toHaveLength(1);
  expect(calls("tag")).toHaveLength(2);
  expect(first.steps[0].cached).toBeUndefined();
  expect(second.steps[0]).toMatchObject({ status: "ok", cached: 1 });
  expect(second.output).toBeTruthy();
});

it("keeps what went into and out of each step of a run, only for the person who ran it", async () => {
  const wf = (await save({ name: "Logged", inputs: [{ name: "who" }], steps: [{ id: "tag", tool: "crm__tag", args: { name: "{{input.who}}" } }] })).data;
  const out = await run(wf.id, { who: "Ada" });
  const logs = (await api(`/api/workflows/runs/${out.runId}/steps`)).data;
  expect(logs).toMatchObject([{ stepId: "tag", status: "ok", input: '{"name":"Ada"}' }]);
  expect(logs[0].output).toContain('"name":"Ada"');
  const off = (await save({ name: "Quiet", logData: false, steps: [{ id: "tag", tool: "crm__tag" }] })).data;
  const quiet = await run(off.id);
  expect((await api(`/api/workflows/runs/${quiet.runId}/steps`)).data).toEqual([]);
  const other = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Bob", email: "bob@example.invalid", password: "Correct-horse-ship-2026" } });
  const peek = await inject(app, { url: `/api/workflows/runs/${out.runId}/steps`, method: "GET", headers: { Cookie: String(other.headers["set-cookie"]).split(";")[0] } });
  expect(peek.status).toBe(404);
});

it("carries on an interrupted run from the step it had reached", async () => {
  const wf = (await save({ name: "Three steps", steps: [{ id: "a", tool: "crm__a" }, { id: "b", tool: "crm__b" }, { id: "c", tool: "crm__c" }] })).data;
  // The second step never answers, as if the server went down in the middle of it.
  const real = vi.mocked(services.call).getMockImplementation()!;
  vi.mocked(services.call).mockImplementation(((c: any, tool: string, args: any, cred: any) => (tool === "b" ? new Promise(() => {}) : real(c, tool, args, cred))) as any);
  void run(wf.id);
  for (let i = 0; i < 50 && !calls("b").length; i++) await new Promise((r) => setTimeout(r, 10));
  expect(calls("b")).toHaveLength(1);
  markInterrupted(store);
  const runs = (await api("/api/state")).data.workflowRuns;
  expect(runs[0]).toMatchObject({ status: "interrupted", resumable: true });
  vi.mocked(services.call).mockImplementation(real);
  const done = (await api(`/api/workflows/runs/${runs[0].id}/continue`, {})).data;
  expect(done.status).toBe("succeeded");
  expect(done.steps.map((s: any) => [s.id, s.status])).toEqual([["a", "ok"], ["b", "ok"], ["c", "ok"]]);
  expect(calls("a")).toHaveLength(1);
  expect(calls("b")).toHaveLength(2);
  expect((await api("/api/state")).data.workflowRuns[0].status).toBe("succeeded");
  // Once finished there is nothing left to continue.
  expect((await api(`/api/workflows/runs/${runs[0].id}/continue`, {})).status).toBe(409);
});
