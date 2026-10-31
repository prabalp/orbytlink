import { vendoredSkills } from "./skills-data.js";
import type { Store } from "./store.js";

// Public signals are a dated snapshot from the source itself, never estimates: installs from
// skills.sh's all-time leaderboard (as displayed there), and stars of the source repository.
// A skill with no listing on skills.sh shows only its repository's stars.
export const SIGNALS_AS_OF = "2026-10-30";
const repoStars: Record<string, number> = { "anthropics/skills": 184993, "mattpocock/skills": 307056 };
const installs: Record<string, string> = {
  tdd: "1.2M",
  "improve-codebase-architecture": "1.2M",
  handoff: "1.1M",
  "frontend-design": "1.1M",
  grilling: "1.0M",
  triage: "1.0M",
  prototype: "1.0M",
  "domain-modeling": "909.4K",
  teach: "890.5K",
  "codebase-design": "883.7K",
  "code-review": "822.8K",
};
const meta: Record<string, { title: string; category: string }> = {
  "internal-comms": { title: "Internal comms", category: "Communication" },
  "frontend-design": { title: "Frontend design", category: "Design" },
  "discernment-nudge": { title: "Discernment check", category: "Thinking" },
  grilling: { title: "Grilling", category: "Thinking" },
  handoff: { title: "Handoff", category: "Planning" },
  teach: { title: "Teach", category: "Writing & learning" },
  "writing-for-agents": { title: "Writing for agents", category: "Writing & learning" },
  "to-spec": { title: "Spec from conversation", category: "Planning" },
  "to-tickets": { title: "Tickets from a plan", category: "Planning" },
  triage: { title: "Issue triage", category: "Engineering" },
  tdd: { title: "Test-driven development", category: "Engineering" },
  "code-review": { title: "Code review", category: "Engineering" },
  "domain-modeling": { title: "Domain modeling", category: "Engineering" },
  "improve-codebase-architecture": { title: "Architecture review", category: "Engineering" },
  "codebase-design": { title: "Codebase design", category: "Engineering" },
  prototype: { title: "Prototype", category: "Engineering" },
};

export function skillCatalog(store: Store, workspace: string) {
  const enabled = new Set(store.list(workspace, "skills").filter((r) => r.enabled).map((r) => r.id));
  return vendoredSkills.map((s) => ({
    id: s.id,
    title: meta[s.id]?.title ?? s.name,
    category: meta[s.id]?.category ?? "Other",
    description: s.description,
    source: s.source,
    url: `https://github.com/${s.source.repo}/tree/${s.source.commit}/${s.source.path}`,
    installs: installs[s.id] ?? null,
    repoStars: repoStars[s.source.repo] ?? null,
    signalsAsOf: SIGNALS_AS_OF,
    files: s.files.length,
    enabled: enabled.has(s.id),
  }));
}

// The full instructions an agent receives: SKILL.md, then each bundled reference file.
export function skillText(id: string) {
  const s = vendoredSkills.find((v) => v.id === id);
  if (!s) return;
  const refs = s.files.map((f) => `\n\n---\n\n## Reference: ${f.path}\n\n${f.content}`).join("");
  return `# Skill: ${meta[s.id]?.title ?? s.name}\n\nSource: ${s.source.repo} (${s.source.license}). Other skills it mentions can be loaded with the orbytlink__use_skill tool.\n\n${s.body}${refs}`;
}

export const enabledSkills = (store: Store, workspace: string) =>
  skillCatalog(store, workspace).filter((s) => s.enabled);
