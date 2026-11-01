// Finds skills in the open skills.sh registry and fetches one from its GitHub repository, so an
// agent can add a skill to the workspace without a shell. A fetched skill is pinned to the
// commit it was read at and holds only Markdown: a skill that ships scripts is refused.

export const REGISTRY = "https://skills.sh";
// The bar find-skills itself recommends: below this, too few people have used a skill to trust it.
export const MIN_INSTALLS = Number(process.env.SKILL_MIN_INSTALLS ?? 1000);
const MAX_FILES = 150,
  MAX_BYTES = 400_000;

export type RegistrySkill = { repo: string; skill: string; name: string; installs: number };
export type FetchedSkill = {
  name: string;
  description: string;
  body: string;
  files: { path: string; content: string }[];
  source: { repo: string; path: string; commit: string; license: string };
  repoStars: number | null;
};

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SKILL = /^[A-Za-z0-9_.:-]{1,100}$/;

// "owner/repo@skill", "owner/repo/skill" or a skills.sh / GitHub link to one.
export function parseSkillRef(input: string): { repo: string; skill: string } | undefined {
  const s = input.trim().replace(/^https?:\/\/(www\.)?skills\.sh\//, "").replace(/^npx skills add\s+/, "");
  const m = /^([^/@\s]+\/[^/@\s]+)(?:@|\/)([^/@\s]+)$/.exec(s);
  if (!m || !REPO.test(m[1]) || !SKILL.test(m[2])) return;
  return { repo: m[1], skill: m[2] };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "OrbytLink", ...headers }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${r.status}`), { status: r.status });
  return r.json() as Promise<any>;
}
const github = (path: string) =>
  getJson(`https://api.github.com${path}`, {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });

export async function searchRegistry(query: string, limit = 10): Promise<RegistrySkill[]> {
  const data = await getJson(`${REGISTRY}/api/search?q=${encodeURIComponent(query.slice(0, 200))}&limit=${Math.min(50, Math.max(1, limit))}`);
  return ((data?.skills as any[]) || [])
    .filter((s) => typeof s?.source === "string" && REPO.test(s.source) && typeof s.skillId === "string" && SKILL.test(s.skillId))
    .map((s) => ({ repo: s.source, skill: s.skillId, name: String(s.name || s.skillId), installs: Number(s.installs) || 0 }));
}

// The registry's own listing for exactly this skill, which carries its install count.
export async function registryEntry(repo: string, skill: string) {
  const want = `${repo}/${skill}`.toLowerCase();
  return (await searchRegistry(skill, 50)).find((s) => `${s.repo}/${s.skill}`.toLowerCase() === want);
}

// The YAML front matter's simple keys (single-line or folded `>` / `|` blocks).
export function frontMatter(md: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {} as Record<string, string>, body: md.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    }
    meta[kv[1]] = value.replace(/^["']|["']$/g, "");
  }
  return { meta, body: md.slice(m[0].length).trim() };
}

// Instructions are Markdown or text; licences, images and metadata files are skipped. Anything
// else, above all scripts, could be run by an agent that has a shell, so the skill is refused.
const TEXT = /\.(md|mdx|markdown|txt)$/i;
const SKIP = /(^|\/)(LICEN[CS]E[^/]*|NOTICE[^/]*|\.gitignore|\.DS_Store)$|\.(png|jpe?g|gif|webp|svg|ico|json|ya?ml|toml|csv)$/i;

export async function fetchSkill(repo: string, skill: string): Promise<FetchedSkill> {
  const info = await github(`/repos/${repo}`).catch((e) => {
    throw new Error(e.status === 404 ? `GitHub has no public repository ${repo}.` : `Could not read ${repo} on GitHub (${e.message}).`);
  });
  const fullName: string = REPO.test(info.full_name) ? info.full_name : repo;
  const commit: string = (await github(`/repos/${fullName}/commits/${encodeURIComponent(info.default_branch)}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub did not return a commit to pin the skill to.");
  const tree = await github(`/repos/${fullName}/git/trees/${commit}?recursive=1`);
  const blobs: { path: string; size: number }[] = (tree.tree || []).filter((t: any) => t.type === "blob");
  const raw = async (path: string) => {
    const r = await fetch(`https://raw.githubusercontent.com/${fullName}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Could not read ${path} (${r.status}).`);
    return r.text();
  };
  const manifests = blobs.filter((b) => /(^|\/)SKILL\.md$/i.test(b.path));
  const dirOf = (p: string) => p.replace(/\/?SKILL\.md$/i, "");
  const base = (p: string) => dirOf(p).split("/").pop()!.toLowerCase();
  // Most repositories name the folder after the skill; otherwise match the front matter's name.
  let manifest = manifests.find((b) => base(b.path) === skill.toLowerCase());
  let text: string | undefined;
  if (!manifest)
    for (const b of manifests.slice(0, 25)) {
      const t = await raw(b.path);
      if (frontMatter(t).meta.name?.toLowerCase() === skill.toLowerCase()) {
        manifest = b;
        text = t;
        break;
      }
    }
  if (!manifest) throw new Error(`${repo} has no skill named ${skill}.`);
  text ??= await raw(manifest.path);
  const dir = dirOf(manifest.path);
  const inDir = blobs.filter((b) => b !== manifest && (!dir || b.path.startsWith(`${dir}/`)));
  // A skill at the repository root owns the usual skill folders, not the repo's README or tooling.
  const own = dir ? inDir : inDir.filter((b) => /^(references?|examples?|docs?|scripts?|assets|templates|bin)\//i.test(b.path));
  const rel = (p: string) => (dir ? p.slice(dir.length + 1) : p);
  const nested = manifests.filter((m) => m !== manifest && dir && m.path.startsWith(`${dir}/`));
  if (nested.length) throw new Error(`${skill} contains other skills; add them one by one.`);
  const blocked = own.filter((b) => !TEXT.test(b.path) && !SKIP.test(b.path)).map((b) => rel(b.path));
  if (blocked.length)
    throw new Error(`${skill} ships files that are not instructions (${blocked.slice(0, 5).join(", ")}${blocked.length > 5 ? ", …" : ""}). OrbytLink only adds skills made of Markdown.`);
  const docs = own.filter((b) => TEXT.test(b.path));
  if (docs.length > MAX_FILES) throw new Error(`${skill} has ${docs.length} reference files; the limit is ${MAX_FILES}.`);
  const bytes = text.length + docs.reduce((n, b) => n + (b.size || 0), 0);
  if (bytes > MAX_BYTES) throw new Error(`${skill} is ${Math.round(bytes / 1000)} KB; the limit is ${MAX_BYTES / 1000} KB.`);
  const files: { path: string; content: string }[] = [];
  // A few at a time: fast for big skills without hammering GitHub.
  for (let i = 0; i < docs.length; i += 8)
    files.push(...(await Promise.all(docs.slice(i, i + 8).map(async (b) => ({ path: rel(b.path), content: (await raw(b.path)).trim() })))));
  const { meta, body } = frontMatter(text);
  if (!body) throw new Error(`${skill}'s SKILL.md is empty.`);
  return {
    name: meta.name || skill,
    description: (meta.description || "").slice(0, 2000),
    body,
    files,
    source: { repo: fullName, path: dir, commit, license: meta.license || info.license?.spdx_id || "Not stated" },
    repoStars: typeof info.stargazers_count === "number" ? info.stargazers_count : null,
  };
}
