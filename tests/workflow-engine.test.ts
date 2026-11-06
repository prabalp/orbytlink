import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { dueKey, retryDelay, runDueWorkflows } from "../server/workflows";
import { inject } from "./inject";

const KEY = "sk_live_51Hsecretvalue9f2a";
let app: Express, store: Store, cookie: string, services: ServiceAdapters, flaky: number;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) => inject(app, { url, method, headers: { Cookie: c }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function connect(c = cookie) {
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 }, "POST", c)).data.token as string;
  const client = new Client({ name: "agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_input, init) => {
        const r = await inject(app, { url: "/mcp", method: init?.method || "POST", headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(r.text, {
          status: r.status,
          headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !["transfer-encoding", "content-length"].includes(k)).map(([k, v]) => [k, String(v)])),
        });
      },
    }),
  );
  return client;
}
async function addApp(name: string, tools: string[], c = cookie) {
  vi.mocked(services.test).mockResolvedValueOnce({ protocol: "mcp", tools: tools.map((t) => ({ name: t, description: t, inputSchema: { type: "object" } })) });
  const row = (await api("/api/connections", { name, kind: "mcp", endpoint: `https://${name.toLowerCase()}.example/mcp` }, "POST", c)).data;
  return (await api(`/api/connections/${row.id}/test`, {}, "POST", c)).data;
}
const save = async (wf: Record<string, unknown>, c = cookie) => api("/api/workflows", { enabled: true, ...wf }, "POST", c);
const run = async (id: string, inputs: Record<string, string> = {}, c = cookie) => (await api(`/api/workflows/${id}/run`, { inputs }, "POST", c)).data;

beforeEach(async () => {
  process.env.OUTBOUND_HOSTS = "*";
  retryDelay.ms = 1;
  flaky = 0;
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args) => {
      if (tool === "list_leads") return { content: [{ type: "text", text: JSON.stringify({ leads: [{ name: "Ada", hot: true }, { name: "Linus", hot: false }] }) }] };
      if (tool === "broken") return { content: [{ type: "text", text: "rate limited" }], isError: true };
      if (tool === "flaky" && flaky++ < 2) return { content: [{ type: "text", text: "try again" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ tool, args }) }] };
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/summarise")) return Response.json({ summary: `summary of ${JSON.parse(String(init.body)).text}`, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ ok: true });
    }),
  );
  app = createApp(store, services).app;
  cookie = await register("Alice");
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OUTBOUND_HOSTS;
});

it("calls a stored API as a step, with the key added by the gateway and never shown", async () => {
  await addApp("CRM", ["list_leads"]);
  await api("/api/apis", { name: "My model", baseUrl: "https://ai.example/v1", auth: "bearer", key: KEY, access: "write" });
  const state = (await api("/api/state")).data;
  expect(state.workflowStepTools.map((t: any) => t.name)).toContain("orbytlink__api_request");
  const wf = (
    await save({
      name: "Summarise leads",
      steps: [
        { id: "leads", tool: "crm__list_leads" },
        { id: "ai", tool: "orbytlink__api_request", args: { api: "my_model", method: "POST", path: "/summarise", body: '{"text": "{{steps.leads.json.leads.0.name}}"}' } },
      ],
    })
  ).data;
  const out = await run(wf.id);
  expect(out.status).toBe("succeeded");
  expect(out.data.summary).toBe("summary of Ada");
  expect(JSON.stringify(out)).not.toContain(KEY);
  expect(out.data.auth).toContain("[REDACTED]");
});

it("loops over a list, skips steps whose condition fails, retries, and can carry on after an error", async () => {
  await addApp("CRM", ["list_leads", "tag_lead", "broken", "flaky", "notify"]);
  const wf = (
    await save({
      name: "Tag hot leads",
      inputs: [{ name: "mode" }],
      steps: [
        { id: "leads", tool: "crm__list_leads" },
        { id: "tag", tool: "crm__tag_lead", forEach: "{{steps.leads.json.leads}}", args: { name: "{{item.name}}", label: "lead {{item.name}}" } },
        { id: "skip_me", tool: "crm__notify", when: { value: "{{input.mode}}", op: "equals", to: "loud" } },
        { id: "fails", tool: "crm__broken", onError: "continue" },
        { id: "retry", tool: "crm__flaky", retries: 2 },
      ],
    })
  ).data;
  const out = await run(wf.id, { mode: "quiet" });
  expect(out.status).toBe("succeeded");
  expect(out.steps.map((s: any) => [s.id, s.status])).toEqual([["leads", "ok"], ["tag", "ok"], ["skip_me", "skipped"], ["fails", "error"], ["retry", "ok"]]);
  expect(out.steps[1].items).toBe(2);
  const tagged = vi.mocked(services.call).mock.calls.filter((c) => c[1] === "tag_lead").map((c) => c[2]);
  expect(tagged).toEqual([{ name: "Ada", label: "lead Ada" }, { name: "Linus", label: "lead Linus" }]);
  expect(flaky).toBe(3);

  const bad = await save({ name: "Bad item", steps: [{ id: "a", tool: "crm__notify", args: { x: "{{item.name}}" } }] });
  expect(bad.status).toBe(400);
  const notList = (await save({ name: "Not a list", steps: [{ id: "a", tool: "crm__notify" }, { id: "b", tool: "crm__notify", forEach: "{{steps.a.text}}" }] })).data;
  expect((await run(notList.id)).error).toMatch(/For each did not get a list/);
});

it("runs another workflow as a step, and refuses one that calls itself", async () => {
  await addApp("CRM", ["notify"]);
  const inner = (await save({ name: "Ping", inputs: [{ name: "who" }], steps: [{ id: "n", tool: "crm__notify", args: { to: "{{input.who}}" } }] })).data;
  const outer = (await save({ name: "Ping twice", steps: [{ id: "a", tool: "workflow__ping", args: { who: "ada" } }, { id: "b", tool: "workflow__ping", args: { who: "{{steps.a.json.args.to}}x" } }] })).data;
  const out = await run(outer.id);
  expect(out.status).toBe("succeeded");
  expect(JSON.parse(out.output).args.to).toBe("adax");
  expect(inner.id).toBeTruthy();
  const loop = (await save({ name: "Loop", steps: [{ id: "a", tool: "crm__notify" }] })).data;
  await api(`/api/workflows/${loop.id}`, { ...loop, steps: [{ id: "a", tool: "workflow__loop" }] }, "PUT");
  expect((await run(loop.id)).error).toMatch(/calls itself/);
});

it("keeps private workflows to their owner, lets members own them, and keeps sharing for admins", async () => {
  await addApp("CRM", ["notify"]);
  await api("/api/orgs", { name: "Acme" });
  await addApp("CRM", ["notify"]);
  const bob = await register("Bobby");
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  await api("/api/invites/accept", { token: invite }, "POST", bob);

  expect((await save({ name: "Shared", steps: [{ id: "a", tool: "crm__notify" }] }, bob)).status).toBe(403);
  const mine = (await save({ name: "Bobs digest", visibility: "private", steps: [{ id: "a", tool: "crm__notify" }] }, bob)).data;
  expect(mine).toMatchObject({ visibility: "private", createdBy: "bobby@example.invalid", enabled: true });
  expect((await run(mine.id, {}, bob)).status).toBe("succeeded");

  const bobTools = (await (await connect(bob)).listTools()).tools.map((t) => t.name);
  const aliceTools = (await (await connect()).listTools()).tools.map((t) => t.name);
  expect(bobTools).toContain("workflow__bobs_digest");
  expect(aliceTools).not.toContain("workflow__bobs_digest");
  // Admins can see and remove it, but not run it as themselves.
  expect((await api("/api/state")).data.workflows.map((w: any) => w.name)).toContain("Bobs digest");
  expect((await api(`/api/workflows/${mine.id}/run`, {}, "POST")).status).toBe(404);
  // A member cannot change a shared workflow, or share their own.
  const shared = (await save({ name: "Team", steps: [{ id: "a", tool: "crm__notify" }] })).data;
  expect((await api(`/api/workflows/${shared.id}`, { ...shared, name: "Mine now" }, "PUT", bob)).status).toBe(403);
  expect((await api(`/api/workflows/${mine.id}`, { ...mine, visibility: "workspace" }, "PUT", bob)).status).toBe(403);
  expect((await api(`/api/workflows/${mine.id}`, undefined, "DELETE", bob)).status).toBe(200);
});

it("lets an agent write the run screen, and keeps the latest result per person when asked", async () => {
  await addApp("CRM", ["list_leads"]);
  const client = await connect();
  const drafted = await client.callTool({
    name: "orbytlink__create_workflow",
    arguments: {
      name: "Lead board",
      inputs: [{ name: "since", required: false }],
      steps: [{ id: "leads", tool: "crm__list_leads", args: { since: "{{input.since}}" } }],
      ui: { inputs: { since: { label: "Since", type: "date" } }, output: { from: "leads", path: "leads", view: "table", columns: [{ key: "name", label: "Name" }, { key: "hot", label: "Hot" }] } },
      keepLastResult: true,
    },
  });
  expect(drafted.isError).toBeFalsy();
  const wf = (await api("/api/state")).data.workflows[0];
  expect(wf).toMatchObject({ visibility: "private", enabled: false, ui: { output: { view: "table" } }, keepLastResult: true });
  expect((await api(`/api/workflows/${wf.id}/result`)).data).toBeNull();
  const out = await run(wf.id);
  expect(out.data).toEqual([{ name: "Ada", hot: true }, { name: "Linus", hot: false }]);
  expect((await api(`/api/workflows/${wf.id}/result`)).data).toMatchObject({ status: "succeeded", data: out.data });
  const badUi = await client.callTool({ name: "orbytlink__create_workflow", arguments: { name: "Bad", steps: [{ id: "a", tool: "crm__list_leads" }], ui: { output: { from: "nope" } } } });
  expect(badUi.isError).toBe(true);
  // Turning keeping off forgets what was kept.
  await api(`/api/workflows/${wf.id}`, { ...wf, keepLastResult: false }, "PUT");
  expect((await api(`/api/workflows/${wf.id}/result`)).data).toBeNull();
});

it("runs a schedule once in its minute, in its own time zone, as the person who set it", async () => {
  await addApp("CRM", ["notify"]);
  const daily = { every: "day", at: "09:30", timezone: "Asia/Kolkata", inputs: { who: "team" } };
  expect((await save({ name: "Needs input", inputs: [{ name: "who" }], steps: [{ id: "a", tool: "crm__notify" }], schedule: { ...daily, inputs: {} } })).status).toBe(400);
  const wf = (await save({ name: "Morning ping", inputs: [{ name: "who" }], steps: [{ id: "a", tool: "crm__notify", args: { to: "{{input.who}}" } }], schedule: daily })).data;
  expect(wf.scheduledBy).toBe("alice@example.invalid");
  const nine30 = new Date("2026-11-06T04:00:10Z"); // 09:30 in India
  expect(dueKey(wf.schedule, nine30)).toBe("2026-11-06 09:30");
  expect(dueKey(wf.schedule, new Date("2026-11-06T04:01:00Z"))).toBeUndefined();
  expect(dueKey({ every: "weekday", at: "09:30", timezone: "Asia/Kolkata" }, new Date("2026-11-08T04:00:00Z"))).toBeUndefined(); // Sunday
  expect(dueKey({ every: "hour", at: "00:30", timezone: "UTC" }, new Date("2026-11-08T13:30:00Z"))).toBe("2026-11-08 13:30");

  expect(await runDueWorkflows(store, services, nine30)).toBe(1);
  expect(await runDueWorkflows(store, services, new Date("2026-11-06T04:00:40Z"))).toBe(0);
  const runs = (await api("/api/state")).data.workflowRuns;
  expect(runs[0]).toMatchObject({ trigger: "schedule", status: "succeeded", user: "alice@example.invalid" });
  expect(vi.mocked(services.call).mock.calls.at(-1)?.[2]).toEqual({ to: "team" });
  await api(`/api/workflows/${wf.id}`, { ...wf, enabled: false }, "PUT");
  expect(await runDueWorkflows(store, services, new Date("2026-11-07T04:00:00Z"))).toBe(0);
});
