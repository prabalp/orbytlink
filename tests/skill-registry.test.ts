import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { parseSkillRef } from "../server/skill-registry";
import { inject } from "./inject";

// A fake skills.sh and GitHub: a Markdown skill, one that ships a script, and an unpopular one.
const SHA = "a".repeat(40);
const files: Record<string, string> = {
  "skills/changelog/SKILL.md": "---\nname: changelog\ndescription: >\n  Write release notes\n  people read.\n---\n# Changelog\n\nGroup changes by impact.",
  "skills/changelog/references/style.md": "Use past tense.",
  "skills/changelog/LICENSE.txt": "MIT",
  "skills/runner/SKILL.md": "---\nname: runner\ndescription: Runs things\n---\nRun scripts/run.py",
  "skills/runner/scripts/run.py": "print('hi')",
  "README.md": "# repo",
};
const listings = [
  { source: "acme/skills", skillId: "changelog", name: "changelog", installs: 5400 },
  { source: "acme/skills", skillId: "runner", name: "runner", installs: 8000 },
  { source: "nobody/stuff", skillId: "changelog-lite", name: "changelog-lite", installs: 12 },
];
let calls: string[] = [];
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  calls.push(url.host + url.pathname);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "skills.sh") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return json({ skills: listings.filter((l) => l.skillId.includes(q) || q.includes("release") || q.includes("note")) });
  }
  if (url.host === "api.github.com") {
    if (url.pathname === "/repos/acme/skills") return json({ full_name: "acme/skills", default_branch: "main", stargazers_count: 900, license: { spdx_id: "MIT" } });
    if (url.pathname === "/repos/acme/skills/commits/main") return json({ sha: SHA });
    if (url.pathname === `/repos/acme/skills/git/trees/${SHA}`) return json({ tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
    return json({ message: "Not Found" }, 404);
  }
  if (url.host === "raw.githubusercontent.com") {
    const path = decodeURIComponent(url.pathname.replace(`/acme/skills/${SHA}/`, ""));
    return path in files ? new Response(files[path]) : new Response("", { status: 404 });
  }
  throw new Error(`unexpected fetch ${url}`);
});

let app: Express, store: Store, cookie: string;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
async function connect(token: string) {
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
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

beforeEach(async () => {
  calls = [];
  vi.stubGlobal("fetch", fakeFetch);
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() }).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
afterEach(() => vi.unstubAllGlobals());

it("reads skill references in the forms people paste", () => {
  expect(parseSkillRef("vercel-labs/agent-skills@react-best-practices")).toEqual({ repo: "vercel-labs/agent-skills", skill: "react-best-practices" });
  expect(parseSkillRef("https://skills.sh/acme/skills/changelog")).toEqual({ repo: "acme/skills", skill: "changelog" });
  expect(parseSkillRef("npx skills add acme/skills@changelog")).toEqual({ repo: "acme/skills", skill: "changelog" });
  expect(parseSkillRef("acme/../x@y")).toBeUndefined();
  expect(parseSkillRef("just-a-name")).toBeUndefined();
});

it("lets an agent find a skill on skills.sh, add it pinned to a commit, and use it at once", async () => {
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token;
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["orbytlink__find_skills", "orbytlink__add_skill"]));

  const found = JSON.parse(text(await client.callTool({ name: "orbytlink__find_skills", arguments: { query: "release notes" } })));
  expect(found.skillsSh).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ skill: "acme/skills@changelog", installs: 5400, canAdd: true }),
      expect.objectContaining({ skill: "nobody/stuff@changelog-lite", canAdd: false }),
    ]),
  );

  const added = await client.callTool({ name: "orbytlink__add_skill", arguments: { skill: "acme/skills@changelog" } });
  expect(added.isError).toBeFalsy();
  expect(text(added)).toContain("Group changes by impact.");
  expect(text(added)).toContain("## Reference: references/style.md");
  expect(text(added)).not.toContain("MIT\n");

  const skill = (await api("/api/state")).data.skills.find((s: any) => s.id === "changelog");
  expect(skill).toMatchObject({ enabled: true, category: "Library", installs: "5.4K", repoStars: 900, description: "Write release notes people read." });
  expect(skill.source).toEqual({ repo: "acme/skills", path: "skills/changelog", commit: SHA, license: "MIT" });
  expect(skill.url).toBe(`https://github.com/acme/skills/tree/${SHA}/skills/changelog`);
  expect((await api("/api/state")).data.audit.some((a: any) => a.action === "skill.library-added" && a.target.includes("acme/skills@aaaaaaa"))).toBe(true);

  // It now behaves like any other enabled skill, and is no longer offered as new.
  const used = await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "changelog" } });
  expect(text(used)).toContain("community skill from skills.sh in OrbytLink's shared library");
  const again = JSON.parse(text(await client.callTool({ name: "orbytlink__find_skills", arguments: { query: "release notes" } })));
  expect(again.inWorkspace[0]).toMatchObject({ skill: "changelog", on: true });
  expect(again.skillsSh.map((s: any) => s.skill)).not.toContain("acme/skills@changelog");
});

it("refuses skills that ship scripts, are barely used, or aren't listed", async () => {
  const client = await connect((await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token);
  const add = async (skill: string) => client.callTool({ name: "orbytlink__add_skill", arguments: { skill } });
  const script = await add("acme/skills@runner");
  expect(script.isError).toBe(true);
  expect(text(script)).toContain("scripts/run.py");
  const unpopular = await add("nobody/stuff@changelog-lite");
  expect(text(unpopular)).toContain("12 installs");
  expect(calls.some((c) => c.startsWith("api.github.com/repos/nobody"))).toBe(false);
  expect(text(await add("acme/skills@unlisted"))).toContain("not listed on skills.sh");
  expect((await api("/api/state")).data.skills.some((s: any) => s.category === "Library")).toBe(false);
  expect((await api("/api/library")).data.all).toBe(0);
});

it("turns on a bundled skill by name, and takes a library skill off a workspace without deleting it", async () => {
  const client = await connect((await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token);
  const on = await client.callTool({ name: "orbytlink__add_skill", arguments: { skill: "tdd" } });
  expect(text(on)).toContain("it is on for every agent in this workspace");
  expect(calls).toEqual([]);

  await client.callTool({ name: "orbytlink__add_skill", arguments: { skill: "acme/skills@changelog" } });
  expect((await api("/api/skills/nope", undefined, "DELETE")).status).toBe(404);
  expect((await api("/api/skills/changelog", {}, "DELETE")).status).toBe(200);
  const skills = (await api("/api/state")).data.skills;
  expect(skills.some((s: any) => s.id === "changelog")).toBe(false);
  expect(skills.find((s: any) => s.id === "tdd").enabled).toBe(true);
  // Still in the shared library, and still usable.
  expect((await api("/api/library?q=changelog")).data.items.map((s: any) => s.id)).toEqual(["changelog"]);
  expect(text(await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "changelog" } }))).toContain("Group changes by impact.");
});

it("lets members' agents add to the shared library and use it, but not turn skills on for everyone", async () => {
  expect((await api("/api/orgs", { name: "Acme" })).status).toBe(200);
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Bobby", email: "bob@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  expect((await api("/api/invites/accept", { token: invite })).status).toBe(200);
  expect((await api("/api/state")).data.identity.role).toBe("member");
  const token = (await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token;
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["orbytlink__find_skills", "orbytlink__add_skill"]));
  const added = await client.callTool({ name: "orbytlink__add_skill", arguments: { skill: "acme/skills@changelog" } });
  expect(text(added)).toContain("an admin can turn it on for everyone");
  expect(text(added)).toContain("Group changes by impact.");
  expect((await api("/api/state")).data.skills.some((s: any) => s.id === "changelog")).toBe(false);
  expect((await api("/api/skills/changelog", { enabled: true }, "PUT")).status).toBe(403);
});

const SKILL = "---\nname: blog-topic-picker\ndescription: Pick the next blog post from search data and write it.\n---\n# Blog topic picker\n\nPick the topic with the best score, then write the post.";

it("lets an admin's agent write a private skill, turns it on, and updates it when written again", async () => {
  const client = await connect((await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token);
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("orbytlink__write_skill");

  const first = await client.callTool({ name: "orbytlink__write_skill", arguments: { body: SKILL } });
  if (first.isError) throw new Error(text(first));
  expect(first.isError).toBeFalsy();
  expect(text(first)).toContain('Saved the skill "blog-topic-picker"');
  const id = text(first).match(/as (blog-topic-picker-[0-9a-f]{6})\./)![1];
  expect((await api("/api/state")).data.skills.find((s: any) => s.id === id)).toMatchObject({ enabled: true });
  expect(text(await client.callTool({ name: "orbytlink__use_skill", arguments: { name: id } }))).toContain("Pick the topic with the best score");
  expect((await api(`/api/skills/authored/${id}`)).data).toMatchObject({ visibility: "private" });

  // Same name again: updated in place, not duplicated; asking for "public" is ignored.
  const again = await client.callTool({ name: "orbytlink__write_skill", arguments: { body: SKILL.replace("best score", "highest score"), visibility: "public" } });
  expect(text(again)).toContain(`Updated the skill "blog-topic-picker" as ${id}`);
  expect(text(await client.callTool({ name: "orbytlink__use_skill", arguments: { name: id } }))).toContain("highest score");
  expect((await api(`/api/skills/authored/${id}`)).data.visibility).toBe("private");
  expect((await api("/api/library")).data.all).toBe(1);
});

it("explains what is missing when an agent writes an invalid skill, and keeps the tool from members' agents", async () => {
  const client = await connect((await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token);
  const bad = await client.callTool({ name: "orbytlink__write_skill", arguments: { body: "---\nname: x\n---\nshort" } });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toMatch(/name|description|instructions/i);

  expect((await api("/api/orgs", { name: "Acme" })).status).toBe(200);
  const invite = (await api("/api/org/invites", { role: "member" })).data.token;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Bobby", email: "bob@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  expect((await api("/api/invites/accept", { token: invite })).status).toBe(200);
  const member = await connect((await api("/api/tokens", { name: "Agent", expiresInDays: 7 })).data.token);
  expect((await member.listTools()).tools.map((t) => t.name)).not.toContain("orbytlink__write_skill");
  expect(text(await member.callTool({ name: "orbytlink__write_skill", arguments: { body: SKILL } }))).toContain("Only an admin");
});
