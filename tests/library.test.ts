import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { ANYONE, librarySearch, setBlocked } from "../server/library";
import { inject } from "./inject";

// A fake skills.sh and GitHub with an openly licensed skill and one with no licence.
const SHA = "b".repeat(40);
const repos: Record<string, { license: string | null; files: Record<string, string> }> = {
  "acme/skills": { license: "MIT", files: { "skills/changelog/SKILL.md": "---\nname: changelog\ndescription: Write release notes people read.\n---\nGroup changes by impact." } },
  "acme/closed": { license: null, files: { "skills/secret/SKILL.md": "---\nname: secret\ndescription: Proprietary sales playbook.\n---\nDo the thing." } },
};
const listings = [
  { source: "acme/skills", skillId: "changelog", name: "changelog", installs: 5400 },
  { source: "acme/closed", skillId: "secret", name: "secret", installs: 9000 },
];
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "skills.sh") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return json({ skills: listings.filter((l) => l.skillId.includes(q) || q.includes(l.skillId)) });
  }
  const repo = Object.keys(repos).find((r) => url.pathname.includes(`/${r}`));
  if (url.host === "api.github.com" && repo) {
    if (url.pathname === `/repos/${repo}`) return json({ full_name: repo, default_branch: "main", stargazers_count: 10, license: repos[repo].license ? { spdx_id: repos[repo].license } : null });
    if (url.pathname === `/repos/${repo}/commits/main`) return json({ sha: SHA });
    if (url.pathname === `/repos/${repo}/git/trees/${SHA}`) return json({ tree: Object.entries(repos[repo].files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
  }
  if (url.host === "raw.githubusercontent.com" && repo) {
    const path = decodeURIComponent(url.pathname.replace(`/${repo}/${SHA}/`, ""));
    if (path in repos[repo].files) return new Response(repos[repo].files[path]);
  }
  return json({ message: "Not Found" }, 404);
});

let app: Express, store: Store;
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
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

beforeEach(() => {
  vi.stubGlobal("fetch", fakeFetch);
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() }).app;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIBRARY_OPEN_LICENSES_ONLY;
});

it("shares a skill one person adds with every other workspace on the server", async () => {
  const alice = await register("Alice");
  const bob = await register("Bobby");
  const added = (await api(alice, "/api/library", { skill: "acme/skills@changelog", enable: true })).data;
  expect(added).toMatchObject({ id: "changelog", created: true, enabled: true });
  // Bob's own workspace: not turned on there, but found in the library and usable at once.
  expect((await api(bob, "/api/state")).data.skills.some((s: any) => s.id === "changelog")).toBe(false);
  const page = (await api(bob, "/api/library?q=release%20notes")).data;
  expect(page).toMatchObject({ total: 1, all: 1 });
  expect(page.items[0]).toMatchObject({ id: "changelog", enabled: false, source: { repo: "acme/skills", license: "MIT" } });
  const client = await agent(bob);
  const found = JSON.parse(text(await client.callTool({ name: "orbytlink__find_skills", arguments: { query: "changelog" } })));
  expect(found.inLibrary[0]).toMatchObject({ skill: "changelog", source: "acme/skills (MIT)" });
  expect(found.skillsSh.map((s: any) => s.skill)).not.toContain("acme/skills@changelog");
  expect(text(await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "changelog" } }))).toContain("Group changes by impact.");
  // Adding it again fetches nothing and makes no copy.
  const calls = fakeFetch.mock.calls.length;
  expect((await api(bob, "/api/library", { skill: "acme/skills@changelog", enable: true })).data).toMatchObject({ id: "changelog", created: false, enabled: true });
  expect(fakeFetch.mock.calls.length).toBe(calls);
  expect((await api(bob, "/api/library")).data.all).toBe(1);
});

it("keeps skills without an open licence out of the shared library", async () => {
  const alice = await register("Alice");
  const r = await api(alice, "/api/library", { skill: "acme/closed@secret" });
  expect(r.status).toBe(409);
  expect(r.data.error).toMatch(/no open licence/);
  expect((await api(alice, "/api/library")).data.all).toBe(0);
  process.env.LIBRARY_OPEN_LICENSES_ONLY = "false";
  expect((await api(alice, "/api/library", { skill: "acme/closed@secret" })).data).toMatchObject({ id: "secret", created: true });
});

it("lets the operator block a skill everywhere", async () => {
  const alice = await register("Alice");
  await api(alice, "/api/library", { skill: "acme/skills@changelog", enable: true });
  expect(setBlocked(store, "changelog", true)).toBe(true);
  expect((await api(alice, "/api/library?q=changelog")).data.total).toBe(0);
  expect((await api(alice, "/api/state")).data.skills.some((s: any) => s.id === "changelog")).toBe(false);
  const client = await agent(alice);
  expect((await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "changelog" } })).isError).toBe(true);
  expect((await client.listPrompts()).prompts.map((p) => p.name)).not.toContain("changelog");
  expect((await api(alice, "/api/library", { skill: "acme/skills@changelog" })).data.error).toMatch(/removed from the OrbytLink library/);
});

it("moves skills a workspace added before the library into it, still turned on", async () => {
  const old = new Store(":memory:");
  old.put("ws-1", "added_skills", {
    id: "changelog",
    name: "changelog",
    description: "Write release notes people read.",
    body: "Group changes by impact.",
    files: [],
    source: { repo: "acme/skills", path: "skills/changelog", commit: SHA, license: "MIT" },
    installs: 5400,
    repoStars: 10,
    addedBy: "alice@example.invalid",
    addedAt: "2026-11-01T00:00:00.000Z",
  });
  old.put("ws-1", "skills", { id: "changelog", enabled: true });
  createApp(old, { test: vi.fn(), call: vi.fn() });
  expect(old.list("ws-1", "added_skills")).toEqual([]);
  expect(librarySearch(old, "release", ANYONE).items.map((s) => s.id)).toEqual(["changelog"]);
  expect(old.list("ws-1", "skills")).toEqual([expect.objectContaining({ id: "changelog", enabled: true })]);
});

it("stays fast with 50,000 skills: search in milliseconds, and pages never carry the whole library", async () => {
  const words = "react performance testing review changelog marketing email sales seo design docker kubernetes python security audit pipeline proposal legal finance invoice onboarding hiring research summary".split(" ");
  const ins = store.db.prepare("INSERT INTO library_skills(id, repo, path, skill, name, description, commit_sha, license, installs, repo_stars, bytes, files, added_by, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const body = store.db.prepare("INSERT INTO library_bodies(id, body, files) VALUES (?,?,?)");
  store.transaction(() => {
    for (let i = 0; i < 50_000; i++) {
      const w = (k: number) => words[(i * 7 + k * 13) % words.length];
      ins.run(`s${i}`, `org${i % 500}/skills`, `skills/s${i}`, `s${i}`, `${w(1)} ${w(2)} helper ${i}`, `Use when working on ${w(3)}, ${w(4)} and ${w(5)}.`, SHA, "MIT", i % 9000, 0, 2000, 0, "seed", Date.now());
      body.run(`s${i}`, "x".repeat(2000), "[]");
    }
  });
  const alice = await register("Alice");
  let t = performance.now();
  const hits = librarySearch(store, "security audit", ANYONE, { limit: 20 });
  const searchMs = performance.now() - t;
  expect(hits.total).toBeGreaterThan(0);
  expect(hits.items).toHaveLength(20);
  expect(searchMs).toBeLessThan(150);
  t = performance.now();
  const page = await api(alice, "/api/library?q=sales%20email&page=2");
  expect(performance.now() - t).toBeLessThan(500);
  expect(page.data.items.length).toBeLessThanOrEqual(30);
  expect(page.data.all).toBe(50_000);
  // The workspace state does not grow with the library.
  const state = await api(alice, "/api/state");
  expect(JSON.stringify(state.data.skills).length).toBeLessThan(40_000);
  const client = await agent(alice);
  t = performance.now();
  const found = JSON.parse(text(await client.callTool({ name: "orbytlink__find_skills", arguments: { query: "kubernetes docker" } })));
  expect(performance.now() - t).toBeLessThan(1000);
  expect(found.inLibrary.length).toBeGreaterThan(0);
  expect(text(await client.callTool({ name: "orbytlink__use_skill", arguments: { name: "s123" } }))).toContain("xxxx");
});
