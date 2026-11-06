import { z } from "zod";
import type { Row, Store } from "./store.js";
import type { Identity } from "./schema.js";
import { JUDGE, manageable, saveWorkflow, visibleTo, workflowToolName } from "./workflows.js";

// Workflows made from real work. Every tool call an agent makes goes through the gateway, so the
// gateway keeps a short memory of each person's recent calls and results. "Save this as a
// workflow" then builds the steps from the calls that actually ran, not from the agent's memory of
// them: values the person gave become inputs, values that came out of an earlier step become
// references to it, and the rest stay fixed.
//
// The memory is bounded and short-lived on purpose: at most PER_KEY calls per person, each cut to a
// few KB, gone after TTL, and BUDGET bytes in all (oldest people dropped first). Secrets are
// redacted before anything is kept.
export type Call = { at: number; tool: string; args: Record<string, unknown>; text: string; json?: unknown; ok: boolean; size: number };
const PER_KEY = 30,
  TTL = 3 * 3600_000,
  MAX_TEXT = 6_000,
  MAX_ARGS = 4_000,
  BUDGET = Number(process.env.CAPTURE_MEMORY_BYTES) || 64 * 1024 * 1024;
const memory = new Map<string, { at: number; calls: Call[]; bytes: number }>();
let bytes = 0;
export const keyFor = (identity: Pick<Identity, "workspace" | "user">) => `${identity.workspace}\u0000${identity.user}`;
const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
export function recordCall(key: string, tool: string, args: Record<string, unknown>, text: string, ok: boolean, now = Date.now()) {
  const a = JSON.stringify(args ?? {});
  if (a.length > MAX_ARGS) return; // too big to replay usefully; not kept
  const t = String(text ?? "").slice(0, MAX_TEXT);
  const call: Call = { at: now, tool, args: JSON.parse(a), text: t, json: parse(t), ok, size: a.length + t.length * 2 };
  let m = memory.get(key);
  if (m) memory.delete(key); // re-added below, so the most recently used come last
  else m = { at: now, calls: [], bytes: 0 };
  memory.set(key, m);
  m.at = now;
  m.calls.push(call);
  m.bytes += call.size;
  bytes += call.size;
  while (m.calls.length > PER_KEY) {
    const old = m.calls.shift()!;
    m.bytes -= old.size;
    bytes -= old.size;
  }
  for (const [k, v] of memory) {
    if (bytes <= BUDGET && now - v.at < TTL) break;
    if (k === key && bytes <= BUDGET) break;
    memory.delete(k);
    bytes -= v.bytes;
  }
}
export const recentCalls = (key: string, now = Date.now()) => {
  const m = memory.get(key);
  return m && now - m.at < TTL ? m.calls : [];
};
export const memoryStats = () => ({ people: memory.size, bytes });

// ── Noticing repeated work ───────────────────────────────────────────────────
// The same run of tool calls on three separate occasions (at least SPLIT apart) is worth saving.
// Kept per person for two weeks, at most 100 patterns each; held in memory only.
const SPLIT = 10 * 60_000,
  KEEP = 14 * 86_400_000,
  TIMES = 3;
type Pattern = { tools: string[]; count: number; lastAt: number; suggestedAt?: number };
const patterns = new Map<string, Map<string, Pattern>>();
export function noticeRepeat(key: string, now = Date.now()): Pattern | undefined {
  const calls = recentCalls(key, now).filter((c) => c.ok && !c.tool.startsWith("orbytlink__find") && c.tool !== "orbytlink__use_skill");
  if (calls.length < 2) return;
  let mine = patterns.get(key);
  if (!mine) patterns.set(key, (mine = new Map()));
  let found: Pattern | undefined;
  // Runs of 2 to 5 calls ending with this one; the longest that reaches the bar wins.
  for (let k = 2; k <= Math.min(5, calls.length); k++) {
    const run = calls.slice(-k);
    if (now - run[0].at > 30 * 60_000) break; // one task's calls sit close together
    const tools = run.map((c) => c.tool);
    if (new Set(tools).size === 1) continue; // one tool called repeatedly is a loop, not a task
    const sig = tools.join(" > ");
    let p = mine.get(sig);
    if (!p) mine.set(sig, (p = { tools, count: 0, lastAt: 0 }));
    if (now - p.lastAt >= SPLIT) p.count++;
    p.lastAt = now;
    if (p.count >= TIMES && (!p.suggestedAt || now - p.suggestedAt > 7 * 86_400_000)) found = p;
  }
  for (const [sig, p] of mine) if (now - p.lastAt > KEEP) mine.delete(sig);
  if (mine.size > 100) [...mine.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, mine.size - 100).forEach(([sig]) => mine!.delete(sig));
  if (found) found.suggestedAt = now;
  return found;
}
export const suggestionsFor = (key: string) =>
  [...(patterns.get(key)?.values() || [])].filter((p) => p.count >= TIMES).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, 10);
export const dismissSuggestion = (key: string, tools: string[]) => patterns.get(key)?.delete(tools.join(" > "));
// A sequence already saved as a workflow is not suggested again.
export const alreadySaved = (store: Store, identity: Identity, tools: string[]) =>
  store.list(identity.workspace, "workflows").some((w) => visibleTo(w, identity) && (w.steps || []).filter((s: Row) => s.tool !== JUDGE).map((s: Row) => s.tool).join(" > ") === tools.join(" > "));
export function resetCapture() {
  memory.clear();
  patterns.clear();
  bytes = 0;
}

// ── Building the workflow ────────────────────────────────────────────────────
export const captureSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(""),
  // The tools used, in order, as the agent called them; the latest such run of calls is taken.
  // Without it: every successful call since the last save (at most 20).
  tools: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
  // Values the person gave that change from run to run: name → the value used this time.
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(4000), z.number(), z.object({ value: z.union([z.string().max(4000), z.number()]), description: z.string().max(200).optional() })])).default({}),
  // Decisions made along the way: before which step (1 = before the first), what to decide.
  judgments: z.array(z.object({ before: z.number().int().min(1).max(21), prompt: z.string().min(5).max(4000), returns: z.string().max(500).optional(), mode: z.enum(["ai", "agent"]).optional() })).max(5).default([]),
  judgment: z.enum(["ai", "agent"]).optional(),
  // Exact argument templates to set, after the automatic ones: step number (1-based) + argument.
  overrides: z.array(z.object({ step: z.number().int().min(1).max(25), arg: z.string().min(1).max(64), value: z.string().max(4000) })).max(40).default([]),
  visibility: z.enum(["private", "workspace"]).default("private"),
  // Update this existing workflow instead of making a new one (for example after it broke).
  replaces: z.string().max(80).optional(),
});
export type CaptureInput = z.input<typeof captureSchema>;
const bad = (message: string) => Object.assign(new Error(message), { status: 400, safe: true });

// Every leaf of an earlier result, by value, with the path that reaches it.
function leaves(json: unknown) {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.size > 3000 || depth > 6 || v == null) return;
    if (Array.isArray(v)) return v.slice(0, 200).forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), depth + 1));
    if (typeof v === "object") return Object.entries(v as Record<string, unknown>).forEach(([k, x]) => /^[A-Za-z0-9_-]+$/.test(k) && walk(x, path ? `${path}.${k}` : k, depth + 1));
    const s = String(v);
    if ((typeof v === "number" && Math.abs(v) > 1) || (typeof v === "string" && s.length >= 3)) if (!out.has(s)) out.set(s, path);
  };
  walk(json, "", 0);
  return out;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function stepId(tool: string, taken: Set<string>) {
  const base = (tool.split("__").pop() || "step").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 34) || "step";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

export function buildFromCalls(calls: Call[], input: z.infer<typeof captureSchema>) {
  const inputs = Object.entries(input.inputs).map(([name, v]) => ({ name, value: String(typeof v === "object" ? v.value : v), description: typeof v === "object" ? v.description || "" : "" }));
  const taken = new Set<string>();
  const made: { id: string; tool: string; args: Record<string, string> }[] = [];
  const index: { id: string; values: Map<string, string> }[] = [];
  const linked: string[] = [];
  const usedInputs = new Set<string>();
  for (const c of calls) {
    const id = stepId(c.tool, taken);
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.args || {})) {
      let text = typeof v === "string" ? v : JSON.stringify(v);
      // The person's own values first: the whole argument, or inside it.
      const whole = inputs.find((i) => i.value === text);
      if (whole) {
        args[k] = `{{input.${whole.name}}}`;
        usedInputs.add(whole.name);
        continue;
      }
      for (const i of inputs)
        if (i.value.length >= 3 && text.includes(i.value)) {
          text = text.replace(new RegExp(escape(i.value), "g"), `{{input.${i.name}}}`);
          usedInputs.add(i.name);
        }
      // Then values that came out of an earlier step, the latest step first.
      let ref: string | undefined;
      for (const e of [...index].reverse())
        if (e.values.has(text)) {
          const path = e.values.get(text);
          ref = `{{steps.${e.id}.json${path ? `.${path}` : ""}}}`;
          linked.push(`${id}.${k} ← ${e.id}`);
          break;
        }
      if (ref) {
        args[k] = ref;
        continue;
      }
      for (const e of [...index].reverse())
        for (const [val, path] of e.values)
          if (val.length >= 8 && text.includes(val) && !text.includes(`{{steps.${e.id}`)) {
            text = text.replace(new RegExp(escape(val), "g"), `{{steps.${e.id}.json${path ? `.${path}` : ""}}}`);
            linked.push(`${id}.${k} ← ${e.id}`);
          }
      args[k] = text;
    }
    made.push({ id, tool: c.tool, args });
    index.push({ id, values: leaves(c.json) });
  }
  const unused = inputs.filter((i) => !usedInputs.has(i.name)).map((i) => i.name);
  if (unused.length) throw bad(`These inputs weren't found in any call: ${unused.join(", ")}. Give the value exactly as it was used.`);
  // Decisions go in before the step they shape.
  const steps: Row[] = [...made];
  [...input.judgments].sort((a, b) => b.before - a.before).forEach((j, n) => {
    const id = stepId(`decide_${input.judgments.length - n}`, taken);
    steps.splice(Math.min(j.before - 1, steps.length), 0, { id, tool: JUDGE, args: { prompt: j.prompt, ...(j.returns ? { returns: j.returns } : {}) }, ...(j.mode ? { mode: j.mode } : {}) });
  });
  for (const o of input.overrides) {
    const s = steps[o.step - 1];
    if (!s) throw bad(`There is no step ${o.step}.`);
    s.args = { ...s.args, [o.arg]: o.value };
  }
  return { steps, inputs: inputs.map((i) => ({ name: i.name, description: i.description, required: true })), linked };
}

// Find the calls to save: the latest run matching the tool list, or everything since the last save.
export function pickCalls(calls: Call[], tools?: string[]) {
  const ok = calls.filter((c) => c.ok && !c.tool.startsWith("orbytlink__find") && !["orbytlink__use_skill", "orbytlink__list_apps", "orbytlink__save_workflow", "orbytlink__export_workflow"].includes(c.tool));
  if (!tools) return ok.slice(-20);
  // Walk back from the newest call, matching the list from its end.
  const picked: Call[] = [];
  let want = tools.length - 1;
  for (let i = ok.length - 1; i >= 0 && want >= 0; i--)
    if (ok[i].tool === tools[want]) {
      picked.unshift(ok[i]);
      want--;
    }
  if (want >= 0) throw bad(`No recent successful call of ${tools[want]} was found, in that order. Run the task first, then save it.`);
  return picked;
}

export function captureWorkflow(store: Store, identity: Identity, raw: unknown, calls?: Call[]) {
  const input = captureSchema.parse(raw);
  const picked = pickCalls(calls ?? recentCalls(keyFor(identity)), input.tools);
  if (!picked.length) throw bad("No recent tool calls to save. Run the task through OrbytLink first, then save it.");
  const built = buildFromCalls(picked, input);
  const existing = input.replaces ? store.list(identity.workspace, "workflows").find((w) => w.name.toLowerCase() === input.replaces!.toLowerCase() && manageable(w, identity)) : undefined;
  if (input.replaces && !existing) throw bad(`No workflow named "${input.replaces}" that you can change.`);
  const row = saveWorkflow(
    store,
    identity,
    {
      ...(existing || {}),
      name: input.name,
      description: input.description,
      inputs: built.inputs,
      steps: built.steps,
      judgment: input.judgment ?? existing?.judgment ?? "agent",
      visibility: existing?.visibility ?? input.visibility,
      enabled: false,
      schedule: existing?.schedule ?? null,
      notes: existing?.notes ?? "",
    },
    existing,
    "agent",
  );
  return { row, linked: built.linked, tool: workflowToolName(row), fixed: built.steps.filter((s: Row) => s.tool !== JUDGE).flatMap((s: Row) => Object.entries(s.args).filter(([, v]) => !String(v).includes("{{")).map(([k, v]) => `${s.id}.${k} = ${String(v).slice(0, 40)}`)) };
}
