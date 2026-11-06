import { dump, load } from "js-yaml";
import type { Row } from "./store.js";
import { workflowSchema } from "./workflows.js";

// workflow_<name>.md: a workflow as a file people can read, diff and keep in a repository.
//   ---               front matter: what it is and how it runs
//   name, description, inputs, judgment, visibility, …
//   ---
//   free notes (Markdown)
//   ```yaml workflow   the steps, and the run screen and schedule when set
//   steps: …
//   ```
// Exporting and importing again gives the same workflow.
const FENCE = /```ya?ml workflow\r?\n([\s\S]*?)\r?\n```/;
const yaml = (value: unknown) => dump(value, { lineWidth: 120, noRefs: true, sortKeys: false }).trimEnd();

export const workflowFileName = (w: Row) => `workflow_${String(w.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "untitled"}.md`;

export function toMarkdown(w: Row) {
  const head: Record<string, unknown> = { name: w.name, description: w.description || "" };
  if (w.inputs?.length) head.inputs = w.inputs.map((i: Row) => ({ name: i.name, ...(i.description ? { description: i.description } : {}), ...(i.required === false ? { required: false } : {}) }));
  head.judgment = w.judgment || "agent";
  if (w.judgeModel && w.judgment === "ai") head.judgeModel = w.judgeModel;
  head.visibility = w.visibility || "workspace";
  if (w.keepLastResult) head.keepLastResult = true;
  if (w.logData === false) head.logData = false;
  // Only what a step sets: defaults stay out, so the file reads cleanly.
  const steps = (w.steps || []).map((s: Row) => ({
    id: s.id,
    tool: s.tool,
    ...(s.args && Object.keys(s.args).length ? { args: s.args } : {}),
    ...(s.forEach ? { forEach: s.forEach } : {}),
    ...(s.when ? { when: s.when } : {}),
    ...(s.retries ? { retries: s.retries } : {}),
    ...(s.onError && s.onError !== "stop" ? { onError: s.onError } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.cache ? { cache: s.cache } : {}),
    ...(s.remember && Object.keys(s.remember).length ? { remember: s.remember } : {}),
  }));
  const body: Record<string, unknown> = { steps };
  if (w.ui) body.ui = w.ui;
  if (w.schedule) body.schedule = w.schedule;
  const notes = String(w.notes || "").trim() || `# ${w.name}\n\n${w.description || ""}`.trim();
  return `---\n${yaml(head)}\n---\n\n${notes}\n\n\`\`\`yaml workflow\n${yaml(body)}\n\`\`\`\n`;
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400, safe: true });
// Read a workflow_<name>.md back into a workflow (validated like any other; saved as a draft).
export function fromMarkdown(text: string) {
  if (text.length > 400_000) throw bad("A workflow file can be at most 400 KB.");
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!front) throw bad("A workflow file starts with front matter between --- lines.");
  const block = FENCE.exec(text);
  if (!block) throw bad("A workflow file needs its steps in a ```yaml workflow block.");
  let head: any, body: any;
  try {
    head = load(front[1]) || {};
    body = load(block[1]) || {};
  } catch (e) {
    throw bad(`The file's YAML could not be read: ${(e as Error).message.split("\n")[0]}`);
  }
  if (typeof head !== "object" || typeof body !== "object") throw bad("The front matter and the workflow block must each be a YAML map.");
  const notes = text.slice(front[0].length).replace(block[0], "").trim();
  return workflowSchema.parse({ ...head, ...body, notes, enabled: false, schedule: body.schedule ?? null });
}
