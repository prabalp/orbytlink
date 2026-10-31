import { beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

let store: Store, app: ReturnType<typeof createApp>["app"];
const services: ServiceAdapters = {
  test: vi.fn(async () => ({ protocol: "mcp" as const, tools: [{ name: "ping", inputSchema: { type: "object" } }] })),
  call: vi.fn(),
};
const request = (url: string, session: string, body?: unknown, method = body ? "POST" : "GET") =>
  inject(app, { url, body, method, headers: session.startsWith("Bearer ") ? { Authorization: session } : { Cookie: session } });
async function signup(name: string) {
  const r = await inject(app, {
    url: "/api/auth/register",
    method: "POST",
    body: { name, email: `${name.toLowerCase()}@example.invalid`, password: "Correct-horse-ship-2026" },
  });
  expect(r.status).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0];
}
// Alice creates an organization; Bob joins it through an invite link.
async function setup(role: "admin" | "member" = "member") {
  const alice = await signup("Alice"),
    bob = await signup("Bobby");
  expect((await request("/api/orgs", alice, { name: "Acme Corp" })).status).toBe(200);
  const invite = await request("/api/org/invites", alice, { role });
  const joined = await request("/api/invites/accept", bob, { token: invite.data.token });
  expect(joined.status).toBe(200);
  return { alice, bob, invite: invite.data };
}
beforeEach(() => {
  store = new Store(":memory:");
  app = createApp(store, services).app;
});

it("keeps a personal workspace and lets anyone create an organization they administer", async () => {
  const alice = await signup("Alice");
  const before = (await request("/api/state", alice)).data;
  expect(before.org).toBeNull();
  expect(before.workspaces).toHaveLength(1);
  expect(before.identity.role).toBe("admin");

  const created = await request("/api/orgs", alice, { name: "Acme Corp" });
  expect(created.status).toBe(200);
  const state = (await request("/api/state", alice)).data;
  expect(state.identity).toMatchObject({ org: true, role: "admin", workspaceName: "Acme Corp", workspace: created.data.id });
  expect(state.identity.permissions).toContain("configure");
  expect(state.org.members).toEqual([expect.objectContaining({ email: "alice@example.invalid", role: "admin", you: true })]);
  expect(state.workspaces.map((w: any) => w.kind).sort()).toEqual(["org", "personal"]);
  expect(state.settings[0].name).toBe("Acme Corp");
});

it("isolates organization data from the personal workspace and switches between them", async () => {
  const alice = await signup("Alice");
  const personal = (await request("/api/state", alice)).data.identity.workspace;
  const org = (await request("/api/orgs", alice, { name: "Acme Corp" })).data.id;
  await request("/api/connections", alice, { name: "Shared CRM", endpoint: "https://crm.example.com/mcp" });
  expect((await request("/api/state", alice)).data.connections).toHaveLength(1);

  expect((await request("/api/workspaces/switch", alice, { workspace: personal })).status).toBe(200);
  const back = (await request("/api/state", alice)).data;
  expect(back.identity.workspace).toBe(personal);
  expect(back.connections).toHaveLength(0);
  expect((await request("/api/workspaces/switch", alice, { workspace: org })).status).toBe(200);
  expect((await request("/api/state", alice)).data.connections).toHaveLength(1);
});

it("cannot switch into, or read, a workspace you are not a member of", async () => {
  const { alice } = await setup();
  const stranger = await signup("Eve");
  const org = (await request("/api/state", alice)).data.identity.workspace;
  expect((await request("/api/workspaces/switch", stranger, { workspace: org })).status).toBe(403);
  expect((await request("/api/state", stranger)).data.connections).toEqual([]);
  expect((await request("/api/org/invites", stranger, { role: "admin" })).status).toBe(409);
});

it("lets members use the gateway but not change it", async () => {
  const { alice, bob } = await setup("member");
  await request("/api/connections", alice, { name: "Shared CRM", endpoint: "https://crm.example.com/mcp" });
  const state = (await request("/api/state", bob)).data;
  expect(state.identity).toMatchObject({ role: "member", org: true });
  expect(state.connections).toHaveLength(1);
  expect(state.org.invites).toEqual([]);

  expect((await request("/api/connections", bob, { name: "Mine", endpoint: "https://x.example.com/mcp" })).status).toBe(403);
  expect((await request(`/api/connections/${state.connections[0].id}`, bob, undefined, "DELETE")).status).toBe(403);
  expect((await request("/api/settings", bob, { name: "Hacked", appearance: "dark" }, "PUT")).status).toBe(403);
  expect((await request("/api/org/invites", bob, { role: "admin" })).status).toBe(403);
  expect((await request("/api/org", bob, { name: "Renamed" }, "PUT")).status).toBe(403);

  // A member can create their own token, and it reaches the organization's tools.
  const token = await request("/api/tokens", bob, { name: "Bob laptop", expiresInDays: 30 });
  expect(token.status).toBe(200);
  const mcp = await inject(app, {
    url: "/mcp",
    method: "POST",
    headers: { Authorization: `Bearer ${token.data.token}`, Accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(mcp.status).toBe(200);
});

it("invites are single use, expire, can be revoked, and are never stored in plaintext", async () => {
  const { alice, invite } = await setup("member");
  expect(JSON.stringify(store.db.prepare("SELECT * FROM invites").all())).not.toContain(invite.token);
  const carol = await signup("Carol");
  expect((await request("/api/invites/accept", carol, { token: invite.token })).status).toBe(409);
  expect((await request("/api/invites/accept", carol, { token: "oi_" + "x".repeat(43) })).status).toBe(409);

  const second = (await request("/api/org/invites", alice, { role: "member" })).data;
  expect((await request("/api/invites/preview", carol, { token: second.token })).data).toEqual({ org: "Acme Corp", role: "member" });
  expect((await request(`/api/org/invites/${second.id}`, alice, undefined, "DELETE")).status).toBe(200);
  expect((await request("/api/invites/accept", carol, { token: second.token })).status).toBe(409);

  const third = (await request("/api/org/invites", alice, { role: "member" })).data;
  store.db.prepare("UPDATE invites SET expires=?").run(Date.now() - 1000);
  expect((await request("/api/invites/accept", carol, { token: third.token })).status).toBe(409);
});

it("anyone can be made an admin, and the last admin is protected", async () => {
  const { alice, bob } = await setup("member");
  const members = (await request("/api/state", alice)).data.org.members as any[];
  const aliceId = members.find((m) => m.you).id,
    bobId = members.find((m) => !m.you).id;

  // Only admin: cannot demote or remove self.
  expect((await request(`/api/org/members/${aliceId}`, alice, { role: "member" }, "PUT")).status).toBe(409);
  expect((await request(`/api/org/members/${aliceId}`, alice, undefined, "DELETE")).status).toBe(409);

  expect((await request(`/api/org/members/${bobId}`, alice, { role: "admin" }, "PUT")).status).toBe(200);
  const promoted = (await request("/api/state", bob)).data;
  expect(promoted.identity.role).toBe("admin");
  expect(promoted.identity.permissions).toContain("configure");
  expect((await request("/api/connections", bob, { name: "Bob CRM", endpoint: "https://crm.example.com/mcp" })).status).toBe(200);

  // With two admins, one can step down.
  expect((await request(`/api/org/members/${aliceId}`, bob, { role: "member" }, "PUT")).status).toBe(200);
  expect((await request("/api/org/invites", alice, { role: "member" })).status).toBe(403);
});

it("removing a member revokes their access and gateway tokens immediately", async () => {
  const { alice, bob } = await setup("member");
  const token = (await request("/api/tokens", bob, { name: "Bob laptop", expiresInDays: 30 })).data.token;
  const bobId = ((await request("/api/state", alice)).data.org.members as any[]).find((m) => !m.you).id;
  const rpc = () =>
    inject(app, {
      url: "/mcp",
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
  expect((await rpc()).status).toBe(200);

  expect((await request(`/api/org/members/${bobId}`, alice, undefined, "DELETE")).status).toBe(200);
  expect((await rpc()).status).toBe(401);
  const after = (await request("/api/state", bob)).data;
  expect(after.identity.org).toBe(false);
  expect(after.connections).toEqual([]);
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM access_tokens WHERE account_id=?").get(bobId)).toEqual({ n: 0 });
});

it("lets a member leave, but not strand the organization without an admin", async () => {
  const { alice, bob } = await setup("member");
  const members = (await request("/api/state", alice)).data.org.members as any[];
  const aliceId = members.find((m) => m.you).id,
    bobId = members.find((m) => !m.you).id;
  expect((await request(`/api/org/members/${aliceId}`, bob, undefined, "DELETE")).status).toBe(403);
  expect((await request(`/api/org/members/${bobId}`, bob, undefined, "DELETE")).status).toBe(200);
  expect((await request("/api/state", bob)).data.identity.org).toBe(false);
});

it("tokens list: members see their own, admins see everyone's and can revoke them", async () => {
  const { alice, bob } = await setup("member");
  await request("/api/tokens", alice, { name: "Alice token", expiresInDays: 7 });
  const bobToken = (await request("/api/tokens", bob, { name: "Bob token", expiresInDays: 7 })).data;
  expect(((await request("/api/state", bob)).data.tokens as any[]).map((t) => t.name)).toEqual(["Bob token"]);
  const seen = (await request("/api/state", alice)).data.tokens as any[];
  expect(seen.map((t) => t.name).sort()).toEqual(["Alice token", "Bob token"]);
  expect((await request(`/api/tokens/${seen.find((t) => !t.mine).id}`, bob, undefined, "DELETE")).status).toBe(200);
  expect(bobToken.id).toBeTruthy();
  const aliceTokenId = seen.find((t) => t.mine).id;
  expect((await request(`/api/tokens/${aliceTokenId}`, bob, undefined, "DELETE")).status).toBe(404);
  expect((await request(`/api/tokens/${aliceTokenId}`, alice, undefined, "DELETE")).status).toBe(200);
});

it("gateway tokens only reach the workspace they were created in", async () => {
  const alice = await signup("Alice");
  const personal = (await request("/api/state", alice)).data.identity.workspace;
  await request("/api/connections", alice, { name: "Personal app", endpoint: "https://p.example.com/mcp" });
  const token = (await request("/api/tokens", alice, { name: "personal", expiresInDays: 7 })).data.token;
  await request("/api/orgs", alice, { name: "Acme Corp" });
  const row = store.db.prepare("SELECT workspace FROM access_tokens").get() as { workspace: string };
  expect(row.workspace).toBe(personal);
  const list = await inject(app, {
    url: "/mcp",
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(list.status).toBe(200);
});

it("deleting an organization needs its name and destroys its data and credentials", async () => {
  const { alice, bob } = await setup("member");
  const org = (await request("/api/state", alice)).data.identity.workspace;
  const c = (await request("/api/connections", alice, { name: "CRM", endpoint: "https://crm.example.com/mcp", auth: "bearer", secret: "s3cret-value" })).data;
  expect(store.secret(org, c.id)).toBe("s3cret-value");

  expect((await request("/api/org", bob, { confirm: "Acme Corp" }, "DELETE")).status).toBe(403);
  expect((await request("/api/org", alice, { confirm: "acme" }, "DELETE")).status).toBe(409);
  expect((await request("/api/org", alice, { confirm: "Acme Corp" }, "DELETE")).status).toBe(200);

  for (const table of ["records", "secrets", "memberships", "invites", "access_tokens"])
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace=?`).get(org)).toEqual({ n: 0 });
  for (const who of [alice, bob]) {
    const state = (await request("/api/state", who)).data;
    expect(state.identity.org).toBe(false);
    expect(state.workspaces).toHaveLength(1);
  }
});

it("renaming from Settings or the organization keeps both names in step", async () => {
  const { alice } = await setup();
  await request("/api/settings", alice, { name: "Acme Gateway", appearance: "dark" }, "PUT");
  expect((await request("/api/state", alice)).data.org.name).toBe("Acme Gateway");
  await request("/api/org", alice, { name: "Acme Inc" }, "PUT");
  const state = (await request("/api/state", alice)).data;
  expect(state.org.name).toBe("Acme Inc");
  expect(state.settings[0].name).toBe("Acme Inc");
});

it("organization management is refused to gateway tokens", async () => {
  const alice = await signup("Alice");
  const made = await request("/api/tokens", alice, { name: "Alice token", expiresInDays: 7 });
  expect(made.status).toBe(200);
  const r = await request("/api/orgs", `Bearer ${made.data.token}`, { name: "Sneaky" });
  expect(r.status).toBe(403);
});
