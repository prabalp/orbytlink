import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { fetchSkill, frontMatter, MIN_INSTALLS, parseSkillRef, registryEntry, type FetchedSkill } from "./skill-registry.js";
import { vendoredSkills } from "./skills-data.js";

// The skill library: one store for every skill on this server, built to stay fast at tens of
// thousands of skills:
// - skill details and the (much larger) instructions live in separate tables, and the
//   instructions are read only when an agent actually uses one skill;
// - search is SQLite's FTS5 full-text index, kept in step by triggers;
// - workspaces store only which skills they have turned on.
//
// Who can see a skill:
// - public: everyone. Skills added from skills.sh are always public; people can also publish
//   skills they wrote.
// - shared: its owner, plus the people and organizations in skill_access.
// - private: its owner only.
// Every search and every load is filtered by the viewer, in the same query.
export type Visibility = "public" | "shared" | "private";
export type LibrarySkill = {
  id: string;
  origin: "skills.sh" | "authored";
  repo: string;
  path: string;
  skill: string;
  name: string;
  description: string;
  commit: string;
  license: string;
  installs: number | null;
  repoStars: number | null;
  bytes: number;
  files: number;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
  uses: number;
  blocked: boolean;
  owner: string | null;
  visibility: Visibility;
};
// Who is asking: their account email, and every organization they belong to.
export type Viewer = { user: string; orgs: string[] };
export const ANYONE: Viewer = { user: "", orgs: [] };
export function viewerFor(store: Store, identity: Pick<Identity, "user">): Viewer {
  const orgs = (
    store.db.prepare("SELECT m.workspace FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN orgs o ON o.id=m.workspace WHERE a.email=?").all(identity.user.toLowerCase()) as { workspace: string }[]
  ).map((r) => r.workspace);
  return { user: identity.user.toLowerCase(), orgs };
}
// The SQL that keeps a query to what a viewer may see; `s` is library_skills.
function visible(viewer: Viewer): [string, string[]] {
  const principals = [`user:${viewer.user}`, ...viewer.orgs.map((o) => `org:${o}`)];
  return [
    `s.blocked=0 AND (s.visibility='public' OR (s.owner IS NOT NULL AND s.owner=?) OR EXISTS (SELECT 1 FROM skill_access a WHERE a.skill_id=s.id AND a.principal IN (${principals.map(() => "?").join(",")})))`,
    [viewer.user, ...principals],
  ];
}

// Sharing a skills.sh skill with everyone is redistribution, so by default only openly licensed ones go in.
const OPEN = /^(MIT|MIT-0|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Unlicense|CC0-1\.0|CC-BY-4\.0|CC-BY-SA-4\.0|MPL-2\.0)$/i;
export const isOpenLicense = (license: string) => OPEN.test(license.trim());
const openOnly = () => process.env.LIBRARY_OPEN_LICENSES_ONLY !== "false";
const COLUMNS =
  "id, origin, repo, path, skill, name, description, commit_sha, license, installs, repo_stars, bytes, files, added_by, added_at, updated_at, uses, blocked, owner, visibility";
const S_COLUMNS = COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
const toSkill = (r: any): LibrarySkill => ({
  id: r.id,
  origin: r.origin,
  repo: r.repo,
  path: r.path,
  skill: r.skill,
  name: r.name,
  description: r.description,
  commit: r.commit_sha,
  license: r.license,
  installs: r.installs ?? null,
  repoStars: r.repo_stars ?? null,
  bytes: r.bytes,
  files: r.files,
  addedBy: r.added_by,
  addedAt: r.added_at,
  updatedAt: r.updated_at ?? r.added_at,
  uses: r.uses,
  blocked: !!r.blocked,
  owner: r.owner ?? null,
  visibility: r.visibility,
});
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export function initializeLibrary(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS library_skills(
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, skill TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL, commit_sha TEXT NOT NULL, license TEXT NOT NULL,
      installs INTEGER, repo_stars INTEGER, bytes INTEGER NOT NULL, files INTEGER NOT NULL,
      added_by TEXT NOT NULL, added_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS library_bodies(id TEXT PRIMARY KEY, body TEXT NOT NULL, files TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(name, description, repo, content='library_skills', content_rowid='rowid', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS library_ai AFTER INSERT ON library_skills BEGIN
      INSERT INTO library_fts(rowid, name, description, repo) VALUES (new.rowid, new.name, new.description, new.repo); END;
    CREATE TRIGGER IF NOT EXISTS library_ad AFTER DELETE ON library_skills BEGIN
      INSERT INTO library_fts(library_fts, rowid, name, description, repo) VALUES ('delete', old.rowid, old.name, old.description, old.repo); END;
    CREATE TRIGGER IF NOT EXISTS library_au AFTER UPDATE OF name, description, repo ON library_skills BEGIN
      INSERT INTO library_fts(library_fts, rowid, name, description, repo) VALUES ('delete', old.rowid, old.name, old.description, old.repo);
      INSERT INTO library_fts(rowid, name, description, repo) VALUES (new.rowid, new.name, new.description, new.repo); END;
    CREATE TABLE IF NOT EXISTS skill_access(skill_id TEXT NOT NULL, principal TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY(skill_id, principal));
    CREATE INDEX IF NOT EXISTS skill_access_principal ON skill_access(principal, skill_id);`);
  // Columns added with access control; older libraries get them with public, skills.sh defaults.
  const has = (column: string) => (store.db.prepare("PRAGMA table_info(library_skills)").all() as { name: string }[]).some((c) => c.name === column);
  if (!has("origin")) store.db.exec("ALTER TABLE library_skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'skills.sh'");
  if (!has("owner")) store.db.exec("ALTER TABLE library_skills ADD COLUMN owner TEXT");
  if (!has("visibility")) store.db.exec("ALTER TABLE library_skills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  if (!has("updated_at")) store.db.exec("ALTER TABLE library_skills ADD COLUMN updated_at INTEGER");
  store.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS library_source ON library_skills(lower(repo), lower(skill)) WHERE origin='skills.sh';
    CREATE INDEX IF NOT EXISTS library_owner ON library_skills(owner);`);
  // The first version indexed every skill's source, which authored skills (no repository) can't share.
  const old = store.db.prepare("SELECT sql FROM sqlite_master WHERE name='library_source'").get() as { sql: string } | undefined;
  if (old && !/WHERE/i.test(old.sql)) store.db.exec("DROP INDEX library_source; CREATE UNIQUE INDEX library_source ON library_skills(lower(repo), lower(skill)) WHERE origin='skills.sh';");
  migrateWorkspaceSkills(store);
}

// Before the library, a skill added from skills.sh was copied into one workspace ("added_skills").
// Each moves into the library once; the workspace keeps it turned on, under the library's id.
function migrateWorkspaceSkills(store: Store) {
  const rows = store.db.prepare("SELECT workspace, id, data FROM records WHERE kind='added_skills'").all() as { workspace: string; id: string; data: string }[];
  for (const r of rows) {
    const s = JSON.parse(r.data);
    store.transaction(() => {
      const name = s.source.path.split("/").pop() || s.name;
      const existing = findBySource(store, s.source.repo, name);
      const id = existing?.id ?? insertFetched(store, { name: s.name, description: s.description, body: s.body, files: s.files || [], source: s.source, repoStars: s.repoStars ?? null }, name, s.installs ?? null, s.addedBy || "migrated", Date.parse(s.addedAt) || Date.now(), r.id);
      const on = store.list(r.workspace, "skills").find((k) => k.id === r.id);
      if (on && id !== r.id) {
        store.remove(r.workspace, "skills", r.id);
        store.put(r.workspace, "skills", { id, enabled: on.enabled });
      }
      store.remove(r.workspace, "added_skills", r.id);
    });
  }
}

function findBySource(store: Store, repo: string, skill: string) {
  const r = store.db.prepare(`SELECT ${COLUMNS} FROM library_skills WHERE origin='skills.sh' AND lower(repo)=lower(?) AND lower(skill)=lower(?)`).get(repo, skill);
  return r ? toSkill(r) : undefined;
}
const taken = (store: Store, id: string) => vendoredSkills.some((v) => v.id === id) || !!store.db.prepare("SELECT 1 FROM library_skills WHERE id=?").get(id);
const sizeOf = (body: string, files: { content: string }[]) => Buffer.byteLength(body) + files.reduce((n, x) => n + Buffer.byteLength(x.content), 0);
function insertFetched(store: Store, f: FetchedSkill, skill: string, installs: number | null, by: string, at = Date.now(), wantedId?: string) {
  const base = (wantedId && !taken(store, wantedId) && wantedId) || slug(f.name) || slug(skill) || "skill";
  let id = base;
  if (taken(store, id)) id = `${slug(f.source.repo.split("/")[0])}-${base}`.slice(0, 64);
  for (let n = 2; taken(store, id); n++) id = `${base.slice(0, 60)}-${n}`;
  store.db
    .prepare(`INSERT INTO library_skills(${COLUMNS}) VALUES (?,'skills.sh',?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,NULL,'public')`)
    .run(id, f.source.repo, f.source.path, skill, f.name, f.description, f.source.commit, f.source.license, installs, f.repoStars, sizeOf(f.body, f.files), f.files.length, by, at, at);
  store.db.prepare("INSERT INTO library_bodies(id, body, files) VALUES (?,?,?)").run(id, f.body, JSON.stringify(f.files));
  return id;
}

export function libraryGet(store: Store, id: string, viewer: Viewer) {
  const [where, params] = visible(viewer);
  const r = store.db.prepare(`SELECT ${S_COLUMNS} FROM library_skills s WHERE s.id=? AND ${where}`).get(id, ...params);
  return r ? toSkill(r) : undefined;
}
// Details for a handful of ids at once (a workspace's turned-on skills), never the whole library.
export function libraryMany(store: Store, ids: string[], viewer: Viewer) {
  if (!ids.length) return [];
  const [where, params] = visible(viewer);
  return (store.db.prepare(`SELECT ${S_COLUMNS} FROM library_skills s WHERE s.id IN (${ids.map(() => "?").join(",")}) AND ${where}`).all(...ids, ...params) as any[]).map(toSkill);
}
// The instructions, read only when one skill is used, and only by someone who may see it.
export function libraryBody(store: Store, id: string, viewer: Viewer) {
  if (!libraryGet(store, id, viewer)) return;
  const r = store.db.prepare("SELECT body, files FROM library_bodies WHERE id=?").get(id) as { body: string; files: string } | undefined;
  if (!r) return;
  store.db.prepare("UPDATE library_skills SET uses=uses+1 WHERE id=?").run(id);
  return { body: r.body, files: JSON.parse(r.files) as { path: string; content: string }[] };
}
export const libraryCount = (store: Store, viewer: Viewer) => {
  const [where, params] = visible(viewer);
  return (store.db.prepare(`SELECT count(*) AS n FROM library_skills s WHERE ${where}`).get(...params) as { n: number }).n;
};

// Which part of the library to search: all a viewer may see, what they wrote, what others shared
// with them, or the public library.
export type Scope = "all" | "mine" | "shared" | "public";
function scoped(scope: Scope, viewer: Viewer): [string, string[]] {
  if (scope === "mine") return ["s.owner=?", [viewer.user]];
  if (scope === "public") return ["s.visibility='public'", []];
  if (scope === "shared") return ["s.visibility<>'public' AND (s.owner IS NULL OR s.owner<>?)", [viewer.user]];
  return ["1=1", []];
}
// Words become prefix terms ("chang" finds "changelog"); every word must match, and if nothing
// does, any word may. Ranked by text relevance (names weigh most), then popularity.
export function librarySearch(store: Store, query: string, viewer: Viewer, opts: { limit?: number; offset?: number; scope?: Scope } = {}) {
  const { limit = 20, offset = 0, scope = "all" } = opts;
  const [where, params] = visible(viewer);
  const [scopeWhere, scopeParams] = scoped(scope, viewer);
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 8);
  if (!words.length) {
    const total = (store.db.prepare(`SELECT count(*) AS n FROM library_skills s WHERE ${where} AND ${scopeWhere}`).get(...params, ...scopeParams) as { n: number }).n;
    const items = (store.db.prepare(`SELECT ${S_COLUMNS} FROM library_skills s WHERE ${where} AND ${scopeWhere} ORDER BY s.installs DESC, s.uses DESC, s.name LIMIT ? OFFSET ?`).all(...params, ...scopeParams, limit, offset) as any[]).map(toSkill);
    return { total, items };
  }
  const run = (match: string) => {
    const from = `FROM library_fts f JOIN library_skills s ON s.rowid=f.rowid WHERE library_fts MATCH ? AND ${where} AND ${scopeWhere}`;
    const total = (store.db.prepare(`SELECT count(*) AS n ${from}`).get(match, ...params, ...scopeParams) as { n: number }).n;
    const items = (store.db.prepare(`SELECT ${S_COLUMNS} ${from} ORDER BY bm25(library_fts, 10.0, 3.0, 1.0), s.installs DESC LIMIT ? OFFSET ?`).all(match, ...params, ...scopeParams, limit, offset) as any[]).map(toSkill);
    return { total, items };
  };
  const terms = words.map((w) => `"${w}"*`);
  const all = run(terms.join(" AND "));
  return all.total || words.length === 1 ? all : run(terms.join(" OR "));
}

const refused = (message: string, status = 409) => Object.assign(new Error(message), { status, safe: true });
// Add a skills.sh skill to the public library (or return it if someone already did). The registry
// vouches for its popularity; GitHub supplies its content, pinned to a commit and Markdown only.
export async function addToLibrary(store: Store, user: string, ref: string): Promise<{ skill: LibrarySkill; created: boolean }> {
  const wanted = parseSkillRef(ref);
  if (!wanted) throw refused("Give the skill as owner/repo@skill, exactly as skills.sh lists it.");
  const known = findBySource(store, wanted.repo, wanted.skill);
  if (known?.blocked) throw refused(`${wanted.repo}@${wanted.skill} was removed from the OrbytLink library and can't be added.`);
  if (known) return { skill: known, created: false };
  const listing = await registryEntry(wanted.repo, wanted.skill);
  if (!listing) throw refused(`${wanted.repo}@${wanted.skill} is not listed on skills.sh, so OrbytLink won't add it.`);
  if (listing.installs < MIN_INSTALLS)
    throw refused(`${wanted.repo}@${wanted.skill} has ${listing.installs} installs on skills.sh. The library only takes skills with at least ${MIN_INSTALLS.toLocaleString("en")}, so few people have vetted this one.`);
  const fetched = await fetchSkill(wanted.repo, wanted.skill);
  if (openOnly() && !isOpenLicense(fetched.source.license))
    throw refused(`${wanted.repo}@${wanted.skill} has no open licence (${fetched.source.license}), so it can't be shared in the library.`);
  // Another request may have added it while this one was fetching.
  const raced = findBySource(store, wanted.repo, wanted.skill);
  if (raced) return { skill: raced, created: false };
  const id = store.transaction(() => insertFetched(store, fetched, wanted.skill, listing.installs, user));
  return { skill: libraryGet(store, id, ANYONE)!, created: true };
}

// ── Skills people write or upload ───────────────────────────────────────────
const email = z.string().trim().toLowerCase().email().max(200);
export const authoredSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(10, "Say in a sentence when an agent should use it").max(1000),
  // SKILL.md text; YAML front matter is accepted and fills in name and description when given.
  body: z.string().min(20, "Write the instructions").max(200_000),
  files: z.array(z.object({ path: z.string().trim().regex(/^[A-Za-z0-9_./-]{1,120}\.(md|mdx|markdown|txt)$/i, "Reference files must be Markdown or text"), content: z.string().max(200_000) })).max(30).default([]),
  visibility: z.enum(["private", "shared", "public"]).default("private"),
  share: z.object({ people: z.array(email).max(200).default([]), orgs: z.array(z.string().min(1).max(80)).max(20).default([]) }).default({ people: [], orgs: [] }),
});
export type AuthoredInput = z.input<typeof authoredSchema>;
function normalise(input: unknown, viewer: Viewer) {
  const raw = authoredSchema.parse(input);
  const { meta, body } = frontMatter(raw.body);
  const data = { ...raw, name: meta.name?.trim() || raw.name, description: meta.description?.trim() || raw.description, body: body || raw.body };
  if (data.files.some((f) => f.path.includes(".."))) throw refused("Reference file paths can't contain '..'.", 400);
  if (sizeOf(data.body, data.files) > 400_000) throw refused("A skill can be at most 400 KB, instructions and reference files together.", 400);
  // A skill can be shared with organizations its author belongs to, not pushed into others.
  const foreign = data.share.orgs.filter((o) => !viewer.orgs.includes(o));
  if (foreign.length) throw refused("You can only share a skill with organizations you belong to.", 403);
  if (data.visibility === "shared" && !data.share.people.length && !data.share.orgs.length) throw refused("Choose at least one person or organization to share with, or keep it private.", 400);
  return data;
}
function setAccess(store: Store, id: string, data: ReturnType<typeof normalise>) {
  store.db.prepare("DELETE FROM skill_access WHERE skill_id=?").run(id);
  if (data.visibility !== "shared") return;
  const add = store.db.prepare("INSERT OR IGNORE INTO skill_access(skill_id, principal, added_at) VALUES (?,?,?)");
  for (const p of data.share.people) add.run(id, `user:${p}`, Date.now());
  for (const o of data.share.orgs) add.run(id, `org:${o}`, Date.now());
}
export function createAuthored(store: Store, viewer: Viewer, input: unknown) {
  const data = normalise(input, viewer);
  const mine = (store.db.prepare("SELECT count(*) AS n FROM library_skills WHERE owner=?").get(viewer.user) as { n: number }).n;
  if (mine >= 500) throw refused("You can keep up to 500 skills of your own.");
  // Ids of skills people write carry a random tail, so a private skill's name can't be guessed from another's id.
  const id = `${slug(data.name) || "skill"}-${randomBytes(3).toString("hex")}`;
  const now = Date.now();
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO library_skills(${COLUMNS}) VALUES (?,'authored','','',?,?,?,'',?,NULL,NULL,?,?,?,?,?,0,0,?,?)`)
      .run(id, id, data.name, data.description, "Owner's terms", sizeOf(data.body, data.files), data.files.length, viewer.user, now, now, viewer.user, data.visibility);
    store.db.prepare("INSERT INTO library_bodies(id, body, files) VALUES (?,?,?)").run(id, data.body, JSON.stringify(data.files));
    setAccess(store, id, data);
  });
  return libraryGet(store, id, viewer)!;
}
// Only the owner may change or delete a skill they wrote.
function owned(store: Store, viewer: Viewer, id: string) {
  const r = store.db.prepare(`SELECT ${COLUMNS} FROM library_skills WHERE id=?`).get(id);
  const s = r ? toSkill(r) : undefined;
  if (!s || s.origin !== "authored" || s.owner !== viewer.user) throw refused("Only the person who wrote this skill can change it.", s && libraryGet(store, id, viewer) ? 403 : 404);
  return s;
}
export function updateAuthored(store: Store, viewer: Viewer, id: string, input: unknown) {
  owned(store, viewer, id);
  const data = normalise(input, viewer);
  store.transaction(() => {
    store.db
      .prepare("UPDATE library_skills SET name=?, description=?, bytes=?, files=?, visibility=?, updated_at=? WHERE id=?")
      .run(data.name, data.description, sizeOf(data.body, data.files), data.files.length, data.visibility, Date.now(), id);
    store.db.prepare("UPDATE library_bodies SET body=?, files=? WHERE id=?").run(data.body, JSON.stringify(data.files), id);
    setAccess(store, id, data);
  });
  return libraryGet(store, id, viewer)!;
}
export function deleteAuthored(store: Store, viewer: Viewer, id: string) {
  owned(store, viewer, id);
  store.transaction(() => {
    store.db.prepare("DELETE FROM skill_access WHERE skill_id=?").run(id);
    store.db.prepare("DELETE FROM library_bodies WHERE id=?").run(id);
    store.db.prepare("DELETE FROM library_skills WHERE id=?").run(id);
  });
}
// The owner's view of a skill they wrote: its text and who it is shared with.
export function authoredDetail(store: Store, viewer: Viewer, id: string) {
  const s = owned(store, viewer, id);
  const body = store.db.prepare("SELECT body, files FROM library_bodies WHERE id=?").get(id) as { body: string; files: string };
  const grants = (store.db.prepare("SELECT principal FROM skill_access WHERE skill_id=? ORDER BY principal").all(id) as { principal: string }[]).map((g) => g.principal);
  return {
    ...s,
    body: body.body,
    files: JSON.parse(body.files),
    share: { people: grants.filter((g) => g.startsWith("user:")).map((g) => g.slice(5)), orgs: grants.filter((g) => g.startsWith("org:")).map((g) => g.slice(4)) },
  };
}

// Operator only (npm run account -- skills block <id>): a blocked skill disappears from search and
// can no longer be loaded, in every workspace.
export function setBlocked(store: Store, id: string, blocked: boolean) {
  const r = store.db.prepare("UPDATE library_skills SET blocked=? WHERE id=?").run(blocked ? 1 : 0, id);
  return Number(r.changes) > 0;
}
