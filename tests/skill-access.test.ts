import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { inject } from "./inject";

let app: Express, store: Store;
let alice: string, bob: string, carol: string, acme: string;
const api = (cookie: string, url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
async function register(name: string) {
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" } });
  return String(r.headers["set-cookie"]).split(";")[0];
}
async function agent(cookie: string) {
  const token = (await api(cookie, "/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token as string;
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
const use = async (cookie: string, id: string) => (await agent(cookie)).callTool({ name: "orbytlink__use_skill", arguments: { name: id } });
const visibleTo = async (cookie: string, q = "proposal") => (await api(cookie, `/api/library?q=${q}`)).data.items.map((s: any) => s.id);
const skill = (patch: Record<string, unknown> = {}) => ({
  name: "Proposal playbook",
  description: "Use when writing a sales proposal for Acme customers.",
  body: "# Proposal playbook\n\nOpen with the customer's goal, then price.",
  ...patch,
});

beforeEach(async () => {
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() }).app;
  alice = await register("Alice");
  bob = await register("Bobby");
  carol = await register("Carol");
  // Alice runs the Acme organization; Bob is a member; Carol is outside it.
  await api(alice, "/api/orgs", { name: "Acme" });
  acme = (await api(alice, "/api/state")).data.identity.workspace;
  const invite = (await api(alice, "/api/org/invites", { role: "member" })).data.token;
  await api(bob, "/api/invites/accept", { token: invite });
});

it("keeps a private skill to its author, everywhere it could leak", async () => {
  const s = (await api(alice, "/api/skills/authored", skill())).data;
  expect(s).toMatchObject({ visibility: "private", owner: "alice@example.invalid", origin: "authored" });
  expect(s.id).toMatch(/^proposal-playbook-[0-9a-f]{6}$/);
  expect(await visibleTo(alice)).toEqual([s.id]);
  expect(JSON.stringify((await use(alice, s.id)).content)).toContain("Open with the customer's goal");
  for (const other of [bob, carol]) {
    expect(await visibleTo(other)).toEqual([]);
    expect((await use(other, s.id)).isError).toBe(true);
    expect((await api(other, `/api/skills/${s.id}`)).status).toBe(404);
    expect((await api(other, `/api/skills/authored/${s.id}`)).status).toBe(404);
    const found = JSON.parse(((await (await agent(other)).callTool({ name: "orbytlink__find_skills", arguments: { query: "proposal" } })).content as any)[0].text);
    expect(JSON.stringify(found)).not.toContain(s.id);
  }
});

it("shares with chosen people, or with an organization's members, and nobody else", async () => {
  const forCarol = (await api(alice, "/api/skills/authored", skill({ name: "Carol proposal", visibility: "shared", share: { people: ["Carol@Example.invalid"] } }))).data;
  expect(await visibleTo(carol)).toEqual([forCarol.id]);
  expect((await api(carol, "/api/library?scope=shared")).data.items.map((s: any) => s.id)).toEqual([forCarol.id]);
  expect((await use(carol, forCarol.id)).isError).toBeFalsy();
  expect(await visibleTo(bob)).toEqual([]);

  const forAcme = (await api(alice, "/api/skills/authored", skill({ name: "Acme proposal", visibility: "shared", share: { orgs: [acme] } }))).data;
  expect(await visibleTo(bob)).toEqual([forAcme.id]);
  expect((await use(bob, forAcme.id)).isError).toBeFalsy();
  expect((await visibleTo(carol)).sort()).toEqual([forCarol.id]);

  // Nobody can push a skill into an organization they don't belong to, or "share" with no one.
  const intoAcme = await api(carol, "/api/skills/authored", skill({ visibility: "shared", share: { orgs: [acme] } }));
  expect(intoAcme.status).toBe(403);
  const noOne = await api(alice, "/api/skills/authored", skill({ visibility: "shared" }));
  expect(noOne.status).toBe(400);
  expect(noOne.data.error).toMatch(/at least one person or organization/);
});

it("publishes to everyone when asked, and only the author can change or delete", async () => {
  const s = (await api(alice, "/api/skills/authored", skill({ visibility: "public" }))).data;
  for (const who of [alice, bob, carol]) expect(await visibleTo(who)).toEqual([s.id]);
  expect((await api(carol, `/api/library?q=proposal`)).data.items[0]).toMatchObject({ category: "Community", mine: false });

  expect((await api(bob, `/api/skills/authored/${s.id}`, skill({ name: "Hijacked" }), "PUT")).status).toBe(403);
  expect((await api(carol, `/api/skills/authored/${s.id}`, undefined, "DELETE")).status).toBe(403);
  // Making it private again takes it away from everyone else at once.
  const back = (await api(alice, `/api/skills/authored/${s.id}`, skill({ visibility: "private" }), "PUT")).data;
  expect(back.visibility).toBe("private");
  expect(await visibleTo(carol)).toEqual([]);
  const detail = (await api(alice, `/api/skills/authored/${s.id}`)).data;
  expect(detail).toMatchObject({ body: expect.stringContaining("Open with"), share: { people: [], orgs: [] } });
  expect((await api(alice, `/api/skills/authored/${s.id}`, undefined, "DELETE")).status).toBe(200);
  expect(await visibleTo(alice)).toEqual([]);
});

it("gives a skill an admin turned on only to the members allowed to see it", async () => {
  const s = (await api(alice, "/api/skills/authored", skill({ name: "Admin only playbook" }))).data;
  // Alice (an Acme admin) can see her private skill, so she may turn it on in Acme...
  expect((await api(alice, `/api/skills/${s.id}`, { enabled: true }, "PUT")).status).toBe(200);
  const bobAgent = await agent(bob);
  // ...but Bob, an Acme member who can't see it, doesn't get it.
  expect((await api(bob, "/api/state")).data.skills.some((k: any) => k.id === s.id)).toBe(false);
  expect((await bobAgent.listPrompts()).prompts.map((p) => p.name)).not.toContain(s.id);
  // Once she shares it with Acme, every member's agent gets it automatically.
  await api(alice, `/api/skills/authored/${s.id}`, skill({ name: "Admin only playbook", visibility: "shared", share: { orgs: [acme] } }), "PUT");
  expect((await bobAgent.listPrompts()).prompts.map((p) => p.name)).toContain(s.id);
  // A skill nobody shared with Carol can't be turned on in her workspace.
  expect((await api(carol, `/api/skills/${s.id}`, { enabled: true }, "PUT")).status).toBe(404);
});

it("takes an uploaded SKILL.md as it is, front matter and reference files included", async () => {
  const s = (
    await api(alice, "/api/skills/authored", {
      name: "ignored",
      description: "ignored but long enough",
      body: "---\nname: Renewal emails\ndescription: Use when a customer's contract is up for renewal.\n---\n# Renewals\n\nThank them first.",
      files: [{ path: "references/tone.md", content: "Warm, short." }],
    })
  ).data;
  expect(s).toMatchObject({ name: "Renewal emails", description: "Use when a customer's contract is up for renewal.", files: 1 });
  const text = JSON.stringify((await use(alice, s.id)).content);
  expect(text).toContain("Thank them first.");
  expect(text).toContain("Reference: references/tone.md");
  expect(text).not.toContain("name: Renewal emails");
  const script = await api(alice, "/api/skills/authored", { ...skill(), files: [{ path: "run.py", content: "print(1)" }] });
  expect(script.status).toBe(400);
});
