import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { render } from "../server/workflows";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let app: Express, store: Store, cookie: string, services: ServiceAdapters;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET", c = cookie) =>
  inject(app, { url, method, headers: { Cookie: c }, body });
async function register(name: string) {
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" },
  });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function connect(token: string) {
  const client = new Client({ name: "agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://gateway.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (_input, init) => {
        const r = await inject(app, {
          url: "/mcp",
          method: init?.method || "POST",
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(r.text, {
          status: r.status,
          headers: Object.fromEntries(
            Object.entries(r.headers)
              .filter(([k]) => !["transfer-encoding", "content-length"].includes(k))
              .map(([k, v]) => [k, String(v)]),
          ),
        });
      },
    }),
  );
  return client;
}
const tokenFor = async (c = cookie) => (await api("/api/tokens", { name: "Agent token", expiresInDays: 7 }, "POST", c)).data.token as string;
async function addApp(name: string, tools: { name: string; inputSchema?: any }[]) {
  vi.mocked(services.test).mockResolvedValueOnce({
    protocol: "mcp",
    tools: tools.map((t) => ({ description: `${t.name} tool`, inputSchema: { type: "object" }, ...t })),
  });
  const row = (await api("/api/connections", { name, kind: "mcp", endpoint: `https://${name.toLowerCase()}.example/mcp` })).data;
  return (await api(`/api/connections/${row.id}/test`, {})).data;
}
beforeEach(async () => {
  store = new Store(":memory:");
  services = {
    test: vi.fn(),
    call: vi.fn(async (_c, tool, args) => {
      if (tool === "create_issue") return { content: [{ type: "text", text: JSON.stringify({ id: "ENG-42", url: "https://linear.example/ENG-42", args }) }] };
      if (tool === "broken") return { content: [{ type: "text", text: "rate limited" }], isError: true };
      return { content: [{ type: "text", text: `${tool} ${JSON.stringify(args)}` }] };
    }),
  };
  app = createApp(store, services).app;
  cookie = await register("Alice");
});

it("lists real bundled skills with their source, licence and dated public signals", async () => {
  const skills = (await api("/api/state")).data.skills as any[];
  expect(skills.length).toBeGreaterThanOrEqual(15);
  const tdd = skills.find((s) => s.id === "tdd");
  expect(tdd).toMatchObject({ installs: "1.2M", repoStars: 307056, signalsAsOf: "2026-10-30", enabled: false });
  expect(tdd.source).toMatchObject({ repo: "mattpocock/skills", license: "MIT" });
  expect(tdd.url).toMatch(/^https:\/\/github\.com\/mattpocock\/skills\/tree\/[0-9a-f]{40}\//);
  const comms = skills.find((s) => s.id === "internal-comms");
  expect(comms.installs).toBeNull();
  expect(comms.source.license).toBe("Apache-2.0");
  const text = (await api("/api/skills/tdd")).data.text as string;
  expect(text).toContain("Test-Driven Development");
  expect(text).toContain("## Reference: mocking.md");
});

it("serves enabled skills to agents as MCP prompts and a load tool, and nothing when disabled", async () => {
  const client = await connect(await tokenFor());
  expect((await client.listPrompts()).prompts).toEqual([]);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("orbytlink__use_skill");

  expect((await api("/api/skills/handoff", { enabled: true }, "PUT")).status).toBe(200);
  const prompts = (await client.listPrompts()).prompts;
  expect(prompts.map((p) => p.name)).toEqual(["handoff"]);
  const prompt = await client.getPrompt({ name: "handoff" });
  expect(JSON.stringify(prompt.messages)).toContain("handoff document");

  const tool = (await client.listTools()).tools.find((t) => t.name === "orbytlink__use_skill")!;
  expect(tool.inputSchema.properties!.name).toMatchObject({ enum: ["handoff"] });
  const used = await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "handoff" } });
  expect(JSON.stringify(used.content)).toContain("handoff document");
  const other = await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "tdd" } });
  expect(other.isError).toBe(true);

  await api("/api/skills/handoff", { enabled: false }, "PUT");
  expect((await client.listPrompts()).prompts).toEqual([]);
  await expect(client.getPrompt({ name: "handoff" })).rejects.toThrow();
});

it("renders templates, keeping types for whole placeholders", () => {
  const steps = { a: { text: '{"id":"ENG-1","n":3}', json: { id: "ENG-1", n: 3, list: [{ x: "first" }] } } };
  expect(render("{{input.title}}", { title: "Hi" }, {})).toBe("Hi");
  expect(render("{{steps.a.json.n}}", {}, steps)).toBe(3);
  expect(render("Issue {{steps.a.json.id}} ({{ input.who }})", { who: "Bo" }, steps)).toBe("Issue ENG-1 (Bo)");
  expect(render("{{steps.a.json.list.0.x}}", {}, steps)).toBe("first");
  expect(render("{{steps.a.text}}", {}, steps)).toBe('{"id":"ENG-1","n":3}');
  expect(render("missing: {{steps.zz.text}}", {}, steps)).toBe("missing: ");
});

it("runs steps in order, passes results forward, coerces types, and logs no data", async () => {
  await addApp("Linear", [{ name: "create_issue", inputSchema: { type: "object", properties: { title: { type: "string" }, priority: { type: "number" } } } }]);
  await addApp("Slack", [{ name: "send_message", inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } } }]);
  const wf = await api("/api/workflows", {
    name: "File and announce",
    inputs: [{ name: "title" }, { name: "channel" }],
    steps: [
      { id: "issue", tool: "linear__create_issue", args: { title: "{{input.title}}", priority: "2" } },
      { id: "post", tool: "slack__send_message", args: { channel: "{{input.channel}}", text: "Filed {{steps.issue.json.id}}: {{input.title}}" } },
    ],
    enabled: true,
  });
  expect(wf.status).toBe(200);
  const run = await api(`/api/workflows/${wf.data.id}/run`, { inputs: { title: "Login fails", channel: "C1" } });
  expect(run.data.status).toBe("succeeded");
  expect(run.data.steps.map((s: any) => s.status)).toEqual(["ok", "ok"]);
  const calls = vi.mocked(services.call).mock.calls;
  expect(calls[0][2]).toEqual({ title: "Login fails", priority: 2 });
  expect(calls[1][2]).toEqual({ channel: "C1", text: "Filed ENG-42: Login fails" });
  expect(run.data.output).toContain("Filed ENG-42");

  const runs = (await api("/api/state")).data.workflowRuns;
  expect(runs[0]).toMatchObject({ workflow: "File and announce", status: "succeeded", trigger: "console" });
  expect(JSON.stringify(runs)).not.toContain("Login fails");
  expect((await api("/api/workflows/" + wf.data.id + "/run", { inputs: { channel: "C1" } })).status).toBe(409);
});

it("stops at a failing step and skips the rest", async () => {
  await addApp("Ops", [{ name: "broken" }, { name: "ping" }]);
  const wf = await api("/api/workflows", {
    name: "Fragile",
    steps: [
      { id: "first", tool: "ops__ping" },
      { id: "second", tool: "ops__broken" },
      { id: "third", tool: "ops__ping" },
    ],
    enabled: true,
  });
  const run = (await api(`/api/workflows/${wf.data.id}/run`, {})).data;
  expect(run.status).toBe("failed");
  expect(run.steps.map((s: any) => s.status)).toEqual(["ok", "error", "skipped"]);
  expect(run.error).toContain('Step "second"');
  expect(vi.mocked(services.call)).toHaveBeenCalledTimes(2);
});

it("rejects workflows that reference unknown inputs or later steps", async () => {
  const bad = (steps: any[], inputs: any[] = []) => api("/api/workflows", { name: "Bad", inputs, steps });
  expect((await bad([{ id: "a", tool: "x__y", args: { t: "{{input.nope}}" } }])).status).toBe(400);
  expect((await bad([{ id: "a", tool: "x__y", args: { t: "{{steps.b.text}}" } }, { id: "b", tool: "x__y" }])).status).toBe(400);
  expect((await bad([{ id: "a", tool: "x__y" }, { id: "a", tool: "x__y" }])).status).toBe(400);
  expect((await bad([])).status).toBe(400);
});

it("lets an agent draft a workflow that stays disabled until an admin enables it", async () => {
  await addApp("Slack", [{ name: "send_message" }]);
  const client = await connect(await tokenFor());
  const drafted = await client.callTool({
    name: "orbytlink__create_workflow",
    arguments: { name: "Daily hello", inputs: [{ name: "channel" }], steps: [{ id: "post", tool: "slack__send_message", args: { channel: "{{input.channel}}", text: "Hello" } }], enabled: true },
  });
  expect(drafted.isError).toBeFalsy();
  const wf = (await api("/api/state")).data.workflows[0];
  expect(wf).toMatchObject({ name: "Daily hello", enabled: false, source: "agent" });
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("workflow__daily_hello");

  const unknown = await client.callTool({ name: "orbytlink__create_workflow", arguments: { name: "Nope", steps: [{ id: "a", tool: "github__delete_repo" }] } });
  expect(unknown.isError).toBe(true);
  expect(JSON.stringify(unknown.content)).toContain("Unknown tools");

  await api(`/api/workflows/${wf.id}`, { ...wf, enabled: true }, "PUT");
  const tool = (await client.listTools()).tools.find((t) => t.name === "workflow__daily_hello")!;
  expect(tool.inputSchema).toMatchObject({ required: ["channel"] });
  const result = await client.callTool({ name: "workflow__daily_hello", arguments: { channel: "C9" } });
  expect(JSON.stringify(result.content)).toContain("send_message");
  expect((await api("/api/state")).data.workflowRuns[0].trigger).toBe("agent");
});

it("members can run enabled workflows but not drafts, and cannot change either", async () => {
  await addApp("Slack", [{ name: "send_message" }]);
  await api("/api/orgs", { name: "Acme" });
  const bob = await register("Bobby");
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  await api("/api/invites/accept", { token: invite }, "POST", bob);
  await addApp("Slack", [{ name: "send_message" }]);
  const live = (await api("/api/workflows", { name: "Live", steps: [{ id: "a", tool: "slack__send_message" }], enabled: true })).data;
  const draft = (await api("/api/workflows", { name: "Draft", steps: [{ id: "a", tool: "slack__send_message" }] })).data;
  expect((await api(`/api/workflows/${live.id}/run`, {}, "POST", bob)).data.status).toBe("succeeded");
  expect((await api(`/api/workflows/${draft.id}/run`, {}, "POST", bob)).status).toBe(403);
  expect((await api(`/api/workflows/${live.id}`, undefined, "DELETE", bob)).status).toBe(403);
  expect((await api("/api/skills/tdd", { enabled: true }, "PUT", bob)).status).toBe(403);
});

it("keeps app tools from taking over the gateway's own tool names", async () => {
  await addApp("Workflow", [{ name: "daily_hello" }]);
  await addApp("OrbytLink", [{ name: "use_skill" }]);
  const names = (await api("/api/state")).data.gatewayTools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(["workflow_app__daily_hello", "orbytlink_app__use_skill"]));
});
