import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Row } from "./store.js";
import type { ServiceAdapters } from "./adapters.js";
import type { Identity } from "./schema.js";
import { callStoredApi, gatewayTools, visibleWorkflowTools, API_REQUEST_TOOL } from "./gateway.js";
import { credentialFor } from "./oauth.js";
import { identityFor } from "./orgs.js";
import { AI_TOOL, aiInputSchema, generate } from "./ai.js";
import { BROWSER_TOOL, browse, browseText, browserInputSchema } from "./browser.js";
import { cacheGet, cacheKey, cachePut, dropCheckpoint, ensure as ensureData, loadCheckpoint, loadState, logStep, pruneWorkflowData, saveCheckpoint, saveState, trimLogs } from "./workflow-data.js";

// A workflow is a fixed, ordered list of tool calls on this gateway. Arguments are templates
// that can use the run's inputs, earlier steps' results and, inside a loop, the current item;
// nothing is decided by a model at run time, so a run does the same thing every time and each
// step is logged. A step can be an app tool, a stored API (orbytlink__api_request, which is also
// how a person adds their own AI model call) or another workflow.
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and underscores, starting with a letter");
const template = z.string().max(4000);
const jsonPath = z.string().max(200).regex(/^[A-Za-z0-9_.-]*$/, "Use a dotted path, e.g. items.0.name");
const condition = z.object({
  value: template,
  op: z.enum(["truthy", "falsy", "equals", "not_equals", "contains", "not_contains"]).default("truthy"),
  to: template.default(""),
});
const step = z.object({
  id: ident,
  tool: z.string().min(1).max(64),
  args: z.record(z.string().max(64), template).refine((v) => Object.keys(v).length <= 30, "Use at most 30 arguments").default({}),
  // Run the step once per item of a list (a template that resolves to an array); {{item}} is the item.
  forEach: template.optional(),
  // Run the step only when the condition holds; otherwise it is skipped and the run goes on.
  when: condition.optional(),
  retries: z.number().int().min(0).max(3).default(0),
  onError: z.enum(["stop", "continue"]).default("stop"),
  // A judgment step (tool "judge"): who decides, overriding the workflow's preset.
  mode: z.enum(["ai", "agent"]).optional(),
  // Reuse this step's result for this many seconds when it is called again with the same arguments
  // (for reads: a step that changes something should not be cached).
  cache: z.number().int().min(0).max(86_400).default(0),
  // Values to remember for the next run, set after the step succeeds; read back with {{state.name}}.
  remember: z.record(ident, template).refine((v) => Object.keys(v).length <= 10, "Remember at most 10 values per step").default({}),
});
// A step whose tool is "judge" is a decision rather than a call: args.prompt says what to decide
// (a template over earlier results) and args.returns what shape the answer takes.
export const JUDGE = "judge";
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-haiku-4.5";
// The run screen, written once when the workflow is created (by the agent or in the editor) and
// drawn by one fixed renderer in the console. It is data, never code.
export const fieldTypes = ["text", "textarea", "number", "date", "email", "url", "select", "checkbox"] as const;
export const outputViews = ["auto", "text", "table", "list", "cards", "stats", "json"] as const;
const ui = z.object({
  inputs: z
    .record(
      ident,
      z.object({
        label: z.string().trim().max(80).optional(),
        type: z.enum(fieldTypes).default("text"),
        options: z.array(z.string().max(100)).max(30).optional(),
        placeholder: z.string().max(200).optional(),
      }),
    )
    .default({}),
  output: z
    .object({
      from: ident.optional(),
      path: jsonPath.default(""),
      view: z.enum(outputViews).default("auto"),
      columns: z.array(z.object({ key: jsonPath, label: z.string().trim().max(60) })).max(8).optional(),
      title: jsonPath.optional(),
      subtitle: jsonPath.optional(),
      link: jsonPath.optional(),
    })
    .default({ path: "", view: "auto" }),
});
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const schedule = z.object({
  every: z.enum(["hour", "day", "weekday", "week"]),
  // HH:MM in the schedule's time zone; an hourly schedule uses only the minutes.
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 09:00"),
  day: z.number().int().min(0).max(6).optional(),
  timezone: z.string().max(64).refine(validZone, "Unknown time zone").default("UTC"),
  inputs: z.record(ident, z.string().max(4000)).default({}),
});
export const workflowSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(""),
    inputs: z
      .array(z.object({ name: ident, description: z.string().trim().max(200).default(""), required: z.boolean().default(true) }))
      .max(10)
      .default([]),
    steps: z.array(step).min(1, "Add at least one step").max(20),
    enabled: z.boolean().default(false),
    // "private" workflows belong to the person who made them: only their agents see the tool.
    visibility: z.enum(["workspace", "private"]).default("workspace"),
    ui: ui.optional(),
    schedule: schedule.nullable().optional(),
    // Keep the latest result (per person) so the run screen can show it again.
    keepLastResult: z.boolean().default(false),
    // Keep what went into and came out of each step of the latest runs (truncated, for debugging).
    logData: z.boolean().default(true),
    // Who makes judgment calls by default: an AI model with a fixed prompt (automatic, uses AI
    // credit), or the agent / person running it (the run pauses and asks).
    judgment: z.enum(["ai", "agent"]).default("agent"),
    judgeModel: z.string().trim().min(3).max(120).default(DEFAULT_JUDGE_MODEL),
    // Free notes kept with the workflow (the prose of its workflow_<name>.md).
    notes: z.string().max(20_000).default(""),
  })
  .superRefine((w, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const inputs = new Set(w.inputs.map((i) => i.name));
    if (inputs.size !== w.inputs.length) issue(["inputs"], "Input names must be unique");
    const seen = new Set<string>();
    w.steps.forEach((s, i) => {
      if (seen.has(s.id)) issue(["steps", i, "id"], "Step ids must be unique");
      const check = (value: string, path: (string | number)[], allowItem: boolean) => {
        for (const ref of references(value)) {
          if (ref.kind === "input" && !inputs.has(ref.name)) issue(path, `Unknown input "${ref.name}"`);
          if (ref.kind === "steps" && !seen.has(ref.name)) issue(path, `"${ref.name}" is not an earlier step`);
          if (ref.kind === "item" && !allowItem) issue(path, "{{item}} works only in a step with For each");
        }
      };
      for (const [key, value] of Object.entries(s.args)) check(value, ["steps", i, "args", key], !!s.forEach);
      if (s.forEach) check(s.forEach, ["steps", i, "forEach"], false);
      if (s.tool === JUDGE) {
        if (!s.args.prompt?.trim()) issue(["steps", i, "args", "prompt"], "A judgment step needs a prompt: what to decide");
        if (s.forEach) issue(["steps", i, "forEach"], "A judgment step can't loop");
      }
      if (s.tool === JUDGE && s.cache) issue(["steps", i, "cache"], "A decision can't be cached");
      if (s.tool === JUDGE && Object.keys(s.remember).length) issue(["steps", i, "remember"], "A decision step can't save values; save them in the step after it");
      for (const [key, value] of Object.entries(s.remember)) {
        for (const ref of references(value)) {
          if (ref.kind === "input" && !inputs.has(ref.name)) issue(["steps", i, "remember", key], `Unknown input "${ref.name}"`);
          if (ref.kind === "steps" && !seen.has(ref.name) && ref.name !== s.id) issue(["steps", i, "remember", key], `"${ref.name}" is not an earlier step`);
          if (ref.kind === "item") issue(["steps", i, "remember", key], "{{item}} can't be saved");
        }
      }
      if (s.when) {
        check(s.when.value, ["steps", i, "when", "value"], false);
        check(s.when.to, ["steps", i, "when", "to"], false);
      }
      seen.add(s.id);
    });
    for (const name of Object.keys(w.ui?.inputs || {})) if (!inputs.has(name)) issue(["ui", "inputs", name], `Unknown input "${name}"`);
    const from = w.ui?.output.from;
    if (from && !seen.has(from)) issue(["ui", "output", "from"], `Unknown step "${from}"`);
    if (w.schedule) {
      if (w.schedule.every === "week" && w.schedule.day === undefined) issue(["schedule", "day"], "Choose a day for a weekly schedule");
      for (const i of w.inputs)
        if (i.required && !w.schedule.inputs[i.name]?.trim()) issue(["schedule", "inputs", i.name], `A scheduled run needs a value for "${i.name}"`);
    }
  });
export type Workflow = z.infer<typeof workflowSchema>;

const PLACEHOLDER = /\{\{\s*(?:(input|steps|state)\.([a-z][a-z0-9_]*)(?:\.(text|json)((?:\.[A-Za-z0-9_-]+)*))?|(item)((?:\.[A-Za-z0-9_-]+)*))\s*\}\}/g;
function references(value: string) {
  return [...value.matchAll(PLACEHOLDER)].map((m) => (m[5] ? { kind: "item" as const, name: "" } : { kind: m[1] as "input" | "steps" | "state", name: m[2] }));
}

type StepResult = { text: string; json?: unknown };
const textOf = (result: any) =>
  Array.isArray(result?.content)
    ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
    : typeof result === "string"
      ? result
      : JSON.stringify(result);
function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
export const at = (value: unknown, path: string) =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<any>((v, k) => (v == null ? undefined : v[/^\d+$/.test(k) && Array.isArray(v) ? Number(k) : k]), value);

// A template that is exactly one placeholder keeps the value's type; anything else is text.
export function render(value: string, inputs: Record<string, unknown>, steps: Record<string, StepResult>, item?: unknown, state: Record<string, string> = {}): unknown {
  const resolve = (m: RegExpMatchArray | string[]) => {
    if (m[5]) return at(item, m[6] || "");
    if (m[1] === "input") return inputs[m[2]];
    if (m[1] === "state") {
      const v = state[m[2]];
      return v === undefined || m[3] !== "json" ? v : at(parseJson(v), m[4] || "");
    }
    const s = steps[m[2]];
    if (!s) return undefined;
    return m[3] === "json" ? at(s.json, m[4] || "") : s.text;
  };
  const trimmed = value.trim();
  const whole = [...trimmed.matchAll(PLACEHOLDER)];
  if (whole.length === 1 && whole[0][0] === trimmed) return resolve(whole[0]);
  return value.replace(PLACEHOLDER, (...m) => {
    const v = resolve(m as unknown as string[]);
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Text becomes JSON where the tool's schema wants another type ("5" → 5, "[1,2]" → [1,2]), or
// where the schema does not say and the text is a JSON object or list.
function coerce(value: unknown, schema: any) {
  if (typeof value !== "string" || schema?.type === "string") return value;
  if (!schema?.type && !/^\s*[[{]/.test(value)) return value;
  const parsed = parseJson(value);
  return parsed === undefined ? value : parsed;
}
const truthy = (v: unknown) =>
  !(v == null || v === false || v === 0 || (typeof v === "string" && ["", "false", "0", "null", "no"].includes(v.trim().toLowerCase())) || (Array.isArray(v) && !v.length));
const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
export function holds(c: z.infer<typeof condition>, inputs: Record<string, unknown>, steps: Record<string, StepResult>, state: Record<string, string> = {}) {
  const value = render(c.value, inputs, steps, undefined, state);
  const to = asText(render(c.to, inputs, steps, undefined, state));
  switch (c.op) {
    case "falsy":
      return !truthy(value);
    case "equals":
      return asText(value).trim() === to.trim();
    case "not_equals":
      return asText(value).trim() !== to.trim();
    case "contains":
      return asText(value).toLowerCase().includes(to.toLowerCase());
    case "not_contains":
      return !asText(value).toLowerCase().includes(to.toLowerCase());
    default:
      return truthy(value);
  }
}

export const workflowToolName = (w: Row) =>
  `workflow__${w.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "run"}`;

export function workflowInputSchema(w: Row) {
  return {
    type: "object",
    properties: Object.fromEntries((w.inputs || []).map((i: Row) => [i.name, { type: "string", description: i.description || undefined }])),
    required: (w.inputs || []).filter((i: Row) => i.required).map((i: Row) => i.name),
  };
}

// Who may see and use a workflow: workspace ones everyone; private ones only their owner,
// though admins can still see, disable and delete them.
export const visibleTo = (wf: Row, identity: Identity) => wf.visibility !== "private" || wf.createdBy === identity.user;
export const manageable = (wf: Row, identity: Identity) => identity.permissions.includes("configure") || (wf.visibility === "private" && wf.createdBy === identity.user);
export const listedFor = (store: Store, identity: Identity) =>
  store.list(identity.workspace, "workflows").filter((wf) => visibleTo(wf, identity) || identity.permissions.includes("configure"));

export type RunOutcome = {
  status: "succeeded" | "failed" | "waiting";
  runId?: string;
  // A paused run: what has to be decided, and in what shape, before it can go on.
  question?: string;
  returns?: string;
  steps: { id: string; tool: string; status: "ok" | "error" | "skipped"; ms: number; error?: string; note?: string; items?: number; cached?: number }[];
  output: string;
  // The value the run screen shows: the chosen step's JSON (or text) at the chosen path.
  data?: unknown;
  error?: string;
};

const SAFE_ERROR = /^(Authorization (required|expired|denied)|Missing path input|Tool inputs do not match|API request failed with status \d+|Response too large|Tool response too large|Operation path leaves)/;
const shownError = (message: string) =>
  SAFE_ERROR.test(message) ||
  /^(Tool .* is not available|Workflow took longer|.* returned an error:|For each |Too many tool calls|Workflows can nest|.* calls itself|HTTP \d{3})|OUTBOUND_HOSTS|Private and reserved/.test(message)
    ? message
    : "The tool call failed";
const MAX_ITEMS = 50,
  MAX_CALLS = 200,
  MAX_DEPTH = 3,
  MAX_RESULT = 200_000;
export const retryDelay = { ms: 300 };
type Run = { deadline: number; calls: number; stack: string[] };

// One call of a step's tool: an app tool, a stored API or another workflow.
async function callStep(store: Store, services: ServiceAdapters, identity: Identity, tool: string, args: Record<string, unknown>, run: Run): Promise<string> {
  const w = identity.workspace;
  if (++run.calls > MAX_CALLS) throw new Error(`Too many tool calls in one run (over ${MAX_CALLS})`);
  if (tool === AI_TOOL) return (await generate(store, identity, args, "workflow")).text;
  if (tool === BROWSER_TOOL) {
    const r = await browse(store, identity, args, "workflow");
    if (r.status === "failed") throw new Error(browseText(r));
    return browseText(r);
  }
  if (tool === API_REQUEST_TOOL) {
    const r = await callStoredApi(store, identity, args);
    // Never let an API echo a stored key into a run result.
    const text = String(store.redact(w, textOf(r)));
    if (r.isError) throw new Error(/^HTTP \d{3}/.test(text) ? text.slice(0, 300) : `Stored API returned an error: ${text.slice(0, 300)}`);
    return text.replace(/^HTTP \d{3}(?: \(response truncated\))?\n\n/, "");
  }
  if (tool.startsWith("workflow__")) {
    const nested = visibleWorkflowTools(store, identity).find((t) => t.name === tool);
    if (!nested) throw new Error(`Tool ${tool} is not available. Check that the workflow is enabled`);
    if (run.stack.includes(nested.workflow.id)) throw new Error(`Workflow "${nested.workflow.name}" calls itself`);
    if (run.stack.length >= MAX_DEPTH) throw new Error(`Workflows can nest at most ${MAX_DEPTH} deep`);
    const inner = await execute(store, services, identity, nested.workflow, args, "workflow", run);
    if (inner.status !== "succeeded") throw new Error(`Workflow "${nested.workflow.name}" returned an error: ${inner.error}`);
    return inner.output;
  }
  // Resolved against current configuration: a disabled tool or connection stops the run.
  const entry = gatewayTools(store, w).find((t) => t.name === tool);
  if (!entry) throw new Error(`Tool ${tool} is not available. Check that its connection is enabled and tested`);
  const result = await services.call(entry.connection, entry.tool.name, args, await credentialFor(store, w, entry.connection));
  const safe = store.redact(w, result);
  if (safe?.isError) throw new Error(`${entry.connection.name} returned an error: ${textOf(safe).slice(0, 300)}`);
  return textOf(safe).slice(0, 100_000);
}
function schemaFor(store: Store, identity: Identity, tool: string): Record<string, any> {
  if (tool === API_REQUEST_TOOL) return { query: { type: "object" }, body: {} };
  if (tool === AI_TOOL) return aiInputSchema.properties;
  if (tool === BROWSER_TOOL) return browserInputSchema.properties;
  if (tool.startsWith("workflow__")) return {};
  return gatewayTools(store, identity.workspace).find((t) => t.name === tool)?.tool.inputSchema?.properties || {};
}
async function withRetries<T>(retries: number, deadline: number, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const wait = retryDelay.ms * 2 ** attempt;
      if (attempt >= retries || Date.now() + wait > deadline) throw error;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

type Trigger = "console" | "agent" | "schedule" | "workflow";
type Resume = { runId: string; index: number; inputs: Record<string, unknown>; results: Record<string, StepResult>; steps: RunOutcome["steps"]; last?: string };
async function execute(
  store: Store,
  services: ServiceAdapters,
  identity: Identity,
  workflow: Row,
  rawInputs: Record<string, unknown>,
  trigger: Trigger,
  parent?: Run,
  resume?: Resume,
): Promise<RunOutcome> {
  const w = identity.workspace;
  const inputs: Record<string, unknown> = resume ? resume.inputs : {};
  if (!resume)
    for (const i of workflow.inputs || []) {
      const v = rawInputs?.[i.name];
      if ((v === undefined || v === "") && i.required) throw Object.assign(new Error(`Missing input "${i.name}"`), { status: 409 });
      if (v !== undefined) inputs[i.name] = typeof v === "string" ? v.slice(0, 4000) : v;
    }
  const run: Run = parent ? { ...parent, stack: [...parent.stack, workflow.id] } : { deadline: Date.now() + 120_000, calls: 0, stack: [workflow.id] };
  const results: Record<string, StepResult> = resume ? resume.results : {};
  const runId = resume?.runId ?? randomUUID();
  const outcome: RunOutcome = { status: "succeeded", runId, steps: resume ? [...resume.steps] : [], output: "" };
  const createdAt = new Date().toISOString();
  // The run is on record while it goes: a restart in the middle leaves it "interrupted", not lost.
  if (trigger !== "workflow") store.put(w, "workflow_runs", { id: runId, workflowId: workflow.id, workflow: workflow.name, status: "running", steps: outcome.steps, trigger, user: identity.user, createdAt });
  let stopped = false,
    last: string | undefined = resume?.last;
  const steps = workflow.steps as Row[];
  // What this workflow remembers is read once per run, and only if a step asks for it.
  const state: Record<string, string> = /\{\{\s*state\./.test(JSON.stringify(steps)) ? loadState(store, workflow.id) : {};
  const rd = (v: string, item?: unknown) => render(v, inputs, results, item, state);
  const top = trigger !== "workflow";
  const log = (s: Row, status: string, input: string, output: string, ms: number) => {
    if (top && workflow.logData !== false) logStep(store, { runId, idx: outcome.steps.length - 1, workflowId: workflow.id, workspace: w, stepId: s.id, tool: s.tool, status, input: String(store.redact(w, input)), output: String(store.redact(w, output)), ms });
  };
  for (let index = resume ? resume.index : 0; index < steps.length; index++) {
    const s = steps[index];
    if (stopped) {
      outcome.steps.push({ id: s.id, tool: s.tool, status: "skipped", ms: 0 });
      continue;
    }
    // Where the run has got to: a restart can carry on from here (the step then in flight runs again).
    if (top && steps.length > 1) saveCheckpoint(store, { runId, workflowId: workflow.id, workspace: w, user: identity.user, data: { index, inputs, results, steps: outcome.steps, last } });
    const started = Date.now();
    let firstArgs: Record<string, unknown> | undefined;
    try {
      if (Date.now() > run.deadline) throw new Error("Workflow took longer than two minutes");
      if (s.when && !holds(s.when, inputs, results, state)) {
        outcome.steps.push({ id: s.id, tool: s.tool, status: "skipped", ms: 0, note: "Condition not met" });
        continue;
      }
      if (s.tool === JUDGE) {
        const mode = s.mode || workflow.judgment || "agent";
        const returns = s.args.returns ? asText(rd(String(s.args.returns))).slice(0, 2000) : "";
        const question = asText(rd(String(s.args.prompt))).slice(0, 20_000);
        if (mode === "ai") {
          const ask = `${question}${returns ? `\n\nAnswer with ${returns}. Reply with the answer only.` : ""}`;
          const text = (await generate(store, identity, { model: workflow.judgeModel || DEFAULT_JUDGE_MODEL, prompt: ask, maxTokens: 2048, json: /json/i.test(returns) }, "workflow")).text;
          results[s.id] = { text, json: parseJson(text) };
          outcome.steps.push({ id: s.id, tool: s.tool, status: "ok", ms: Date.now() - started, note: "Decided by AI" });
          log(s, "ok", question, text, Date.now() - started);
          outcome.output = text;
          last = s.id;
          continue;
        }
        // The agent or the person decides: save where the run is and hand back the question.
        if (trigger === "schedule" || trigger === "workflow")
          throw Object.assign(new Error(`Step "${s.id}" needs a decision from a person or agent, so it can't run ${trigger === "schedule" ? "on a schedule" : "inside another workflow"}. Set its judgment to AI to run it unattended.`), { safe: true });
        const state = { workflowId: workflow.id, user: identity.user, stepId: s.id, index: index + 1, inputs, results, steps: [...outcome.steps, { id: s.id, tool: s.tool, status: "ok", ms: 0, note: "Decided by agent" }], last: s.id, question, returns, createdAt, expiresAt: Date.now() + WAIT_MS };
        if (JSON.stringify(state).length > 2_000_000) throw Object.assign(new Error("This run holds too much data to pause for a decision."), { safe: true });
        store.put(w, "workflow_waits", { id: runId, ...state });
        outcome.status = "waiting";
        outcome.question = question;
        outcome.returns = returns;
        outcome.steps.push({ id: s.id, tool: s.tool, status: "skipped", ms: 0, note: "Waiting for a decision" });
        break;
      }
      const properties = schemaFor(store, identity, s.tool);
      const argsFor = (item?: unknown) => {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(s.args || {})) {
          const v = coerce(rd(String(value), item), properties[key]);
          if (v !== undefined && v !== "") args[key] = v;
        }
        return args;
      };
      let hits = 0;
      const once = async (item?: unknown) => {
        const args = argsFor(item);
        firstArgs ??= args;
        const key = s.cache ? cacheKey(s.tool, args) : "";
        if (key) {
          const hit = cacheGet(store, w, key);
          if (hit !== undefined) return hits++, hit;
        }
        const text = await withRetries(s.retries || 0, run.deadline, () => callStep(store, services, identity, s.tool, args, run));
        if (key) cachePut(store, w, key, text, s.cache);
        return text;
      };
      if (s.forEach) {
        let items = rd(s.forEach);
        if (typeof items === "string") items = parseJson(items);
        if (!Array.isArray(items)) throw new Error("For each did not get a list. Point it at a JSON array, e.g. {{steps.find.json.items}}");
        if (items.length > MAX_ITEMS) throw new Error(`For each got ${items.length} items; the limit is ${MAX_ITEMS}`);
        const texts: string[] = [];
        for (const item of items) texts.push(await once(item));
        results[s.id] = { text: JSON.stringify(texts), json: texts.map((t) => parseJson(t) ?? t) };
        outcome.steps.push({ id: s.id, tool: s.tool, status: "ok", ms: Date.now() - started, items: items.length, ...(hits ? { cached: hits } : {}) });
        log(s, "ok", `${items.length} items. First: ${JSON.stringify(firstArgs ?? {})}`, results[s.id].text, Date.now() - started);
      } else {
        const text = await once();
        results[s.id] = { text, json: parseJson(text) };
        outcome.steps.push({ id: s.id, tool: s.tool, status: "ok", ms: Date.now() - started, ...(hits ? { cached: hits } : {}) });
        log(s, "ok", JSON.stringify(firstArgs ?? {}), text, Date.now() - started);
      }
      for (const [key, value] of Object.entries(s.remember || {}) as [string, string][]) {
        const v = asText(rd(value));
        saveState(store, w, workflow.id, key, v);
        state[key] = v;
      }
      outcome.output = results[s.id].text;
      last = s.id;
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[${new Date().toISOString()}] workflow "${workflow.name}" step ${s.id} failed: ${String(message).slice(0, 300)}`);
      // Credit, limit and model errors are written to be shown.
      const shown = (error as any)?.safe ? message : (error as any)?.issues ? `Invalid arguments: ${(error as any).issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : shownError(message);
      outcome.steps.push({ id: s.id, tool: s.tool, status: "error", ms: Date.now() - started, error: shown });
      log(s, "error", firstArgs ? JSON.stringify(firstArgs) : "", shown, Date.now() - started);
      if (s.onError === "continue") continue;
      outcome.status = "failed";
      outcome.error = `Step "${s.id}": ${shown}`;
      stopped = true;
    }
  }
  if (top) {
    dropCheckpoint(store, runId);
    trimLogs(store, workflow.id);
  }
  if (outcome.status === "waiting") {
    if (trigger !== "workflow") store.put(w, "workflow_runs", { id: runId, workflowId: workflow.id, workflow: workflow.name, status: "waiting", steps: outcome.steps, trigger, user: identity.user, createdAt });
    return outcome;
  }
  const view = workflow.ui?.output;
  const source = results[view?.from || last || ""];
  if (source) {
    const data = view?.path ? at(source.json, view.path) : (source.json ?? source.text);
    if (data !== undefined && JSON.stringify(data).length <= MAX_RESULT) outcome.data = data;
  }
  // Runs record what happened, not the data that moved: no inputs or outputs are stored,
  // except the latest result of a workflow set to keep it, for the person who ran it.
  if (trigger !== "workflow") {
    store.put(w, "workflow_runs", { id: runId, workflowId: workflow.id, workflow: workflow.name, status: outcome.status, steps: outcome.steps, trigger, user: identity.user, createdAt });
    store.trim(w, "workflow_runs", 500);
  }
  if (workflow.keepLastResult && trigger !== "workflow")
    store.put(w, "workflow_results", {
      id: `${workflow.id}:${identity.user}`,
      workflowId: workflow.id,
      user: identity.user,
      status: outcome.status,
      data: outcome.data ?? null,
      output: outcome.data === undefined ? outcome.output.slice(0, 20_000) : "",
      createdAt: new Date().toISOString(),
    });
  store.put(w, "workflows", { ...store.get(w, "workflows", workflow.id), lastRunAt: new Date().toISOString(), lastStatus: outcome.status });
  store.audit(w, identity.user, outcome.status === "succeeded" ? "workflow.ran" : "workflow.failed", workflow.name);
  return outcome;
}
// ── Running at scale ─────────────────────────────────────────────────────────
// Runs mostly wait on the network, so one process holds many at once; these limits keep one busy
// workspace from starving the rest. A run waits up to QUEUE_MS for a slot, then is refused.
export const limits = { global: Number(process.env.WORKFLOW_CONCURRENCY) || 32, perWorkspace: Number(process.env.WORKFLOW_CONCURRENCY_PER_WORKSPACE) || 4, queueMs: 30_000 };
const WAIT_MS = 24 * 3600_000;
let active = 0;
const busy = new Map<string, number>();
const queue: { w: string; go: () => void }[] = [];
export const runStats = () => ({ active, queued: queue.length });
function pump() {
  for (let i = 0; i < queue.length && active < limits.global; ) {
    const q = queue[i];
    if ((busy.get(q.w) || 0) >= limits.perWorkspace) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    q.go();
  }
}
async function slot(w: string): Promise<() => void> {
  const take = () => {
    active++;
    busy.set(w, (busy.get(w) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active--;
      const n = (busy.get(w) || 1) - 1;
      if (n) busy.set(w, n);
      else busy.delete(w);
      pump();
    };
  };
  if (active < limits.global && (busy.get(w) || 0) < limits.perWorkspace && !queue.length) return take();
  return new Promise((resolve, reject) => {
    const entry = { w, go: () => (clearTimeout(timer), resolve(take())) };
    const timer = setTimeout(() => {
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      reject(Object.assign(new Error("OrbytLink is busy running other workflows. Try again in a moment."), { status: 503, safe: true }));
    }, limits.queueMs);
    queue.push(entry);
    pump();
  });
}
export async function runWorkflow(store: Store, services: ServiceAdapters, identity: Identity, workflow: Row, inputs: Record<string, unknown>, trigger: "console" | "agent" | "schedule") {
  const release = await slot(identity.workspace);
  try {
    return await execute(store, services, identity, workflow, inputs, trigger);
  } finally {
    release();
  }
}
// Go on with a run that paused for a decision. Only the person it paused for can answer.
export async function resumeWorkflow(store: Store, services: ServiceAdapters, identity: Identity, runId: string, answer: string, trigger: "console" | "agent") {
  const w = identity.workspace;
  const wait = store.list(w, "workflow_waits").find((r) => r.id === runId);
  if (!wait || wait.user !== identity.user) throw Object.assign(new Error("No run is waiting for you under that id."), { status: 404, safe: true });
  if (wait.expiresAt < Date.now()) {
    store.remove(w, "workflow_waits", runId);
    throw Object.assign(new Error("That run waited more than a day and was dropped. Start it again."), { status: 409, safe: true });
  }
  const workflow = store.list(w, "workflows").find((r) => r.id === wait.workflowId);
  if (!workflow) throw Object.assign(new Error("The workflow behind that run was deleted."), { status: 409, safe: true });
  store.remove(w, "workflow_waits", runId);
  const text = String(answer).slice(0, 20_000);
  const results = { ...wait.results, [wait.stepId]: { text, json: parseJson(text) } };
  const release = await slot(w);
  try {
    return await execute(store, services, identity, workflow, {}, trigger, undefined, { runId, index: wait.index, inputs: wait.inputs, results, steps: wait.steps, last: wait.last });
  } finally {
    release();
  }
}
// After a restart, runs that were in progress can't continue (their calls may have half happened).
// A run that has reached a checkpoint can be carried on by the person who started it.
export function markInterrupted(store: Store) {
  ensureData(store);
  store.db.exec("UPDATE records SET data=json_set(data,'$.status','interrupted','$.resumable',json(CASE WHEN EXISTS(SELECT 1 FROM run_checkpoints c WHERE c.run_id=records.id) THEN 'true' ELSE 'false' END)) WHERE kind='workflow_runs' AND json_extract(data,'$.status')='running'");
}
export async function continueRun(store: Store, services: ServiceAdapters, identity: Identity, runId: string) {
  const w = identity.workspace;
  const gone = (message: string) => Object.assign(new Error(message), { status: 409, safe: true });
  const run = store.list(w, "workflow_runs").find((r) => r.id === runId);
  const cp = loadCheckpoint(store, w, runId);
  if (!run || !cp || cp.user !== identity.user || run.status !== "interrupted") throw gone("That run can't be continued. Start the workflow again.");
  const workflow = store.list(w, "workflows").find((r) => r.id === cp.workflowId);
  if (!workflow || !visibleTo(workflow, identity)) throw gone("The workflow behind that run was deleted.");
  const release = await slot(w);
  try {
    return await execute(store, services, identity, workflow, {}, (["console", "agent", "schedule"].includes(run.trigger) ? run.trigger : "console") as Trigger, undefined, { runId, index: cp.data.index, inputs: cp.data.inputs, results: cp.data.results, steps: cp.data.steps, last: cp.data.last });
  } finally {
    release();
  }
}
export function lastResult(store: Store, identity: Identity, workflowId: string) {
  return store.list(identity.workspace, "workflow_results").find((r) => r.id === `${workflowId}:${identity.user}`) || null;
}
export function forgetResults(store: Store, w: string, workflowId: string) {
  for (const r of store.list(w, "workflow_results")) if (r.workflowId === workflowId) store.remove(w, "workflow_results", r.id);
}

const forbidden = (message: string) => Object.assign(new Error(message), { status: 403 });
const MAX_WORKFLOWS = 500;
const countWorkflows = (store: Store, w: string) => (store.db.prepare("SELECT count(*) AS n FROM records WHERE workspace=? AND kind='workflows'").get(w) as { n: number }).n;
// Saving from the console or from an agent. Agents only ever create disabled drafts. Members
// (who can call tools but not configure) may keep private workflows of their own; sharing a
// workflow with the workspace, or scheduling one for it, takes an admin.
export function saveWorkflow(store: Store, identity: Identity, input: unknown, existing?: Row, source: "console" | "agent" | "template" = "console") {
  const data = workflowSchema.parse(input);
  const w = identity.workspace;
  const admin = identity.permissions.includes("configure");
  if (existing && !manageable(existing, identity)) throw forbidden("Only an admin or the workflow's owner can change it.");
  if (!admin && data.visibility !== "private") throw forbidden("Only an admin can share a workflow with the workspace. Keep it private.");
  if (!existing && countWorkflows(store, w) >= MAX_WORKFLOWS) throw Object.assign(new Error(`A workspace can hold up to ${MAX_WORKFLOWS} workflows.`), { status: 409 });
  const owner = existing?.createdBy ?? identity.user;
  const row = store.put(w, "workflows", {
    ...(existing || {}),
    ...data,
    enabled: source === "agent" ? false : data.enabled,
    schedule: data.schedule ?? null,
    // A schedule runs as the person who set it, with their access at the time of each run.
    scheduledBy: data.schedule ? (JSON.stringify(data.schedule) === JSON.stringify(existing?.schedule) ? existing?.scheduledBy || identity.user : identity.user) : null,
    source: existing?.source ?? source,
    createdBy: owner,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  if (existing && !data.keepLastResult) forgetResults(store, w, row.id);
  syncSchedule(store, w, row);
  store.audit(w, identity.user, existing ? "workflow.updated" : source === "agent" ? "workflow.drafted-by-agent" : "workflow.created", row.name);
  return row;
}

// ── Schedules ────────────────────────────────────────────────────────────────
// Each scheduled, enabled workflow has one row in workflow_schedule with the time it is next due;
// a tick reads only rows that are due, so its cost doesn't grow with the number of workflows.
export const scheduleClock = { now: () => Date.now() };
export function initializeWorkflows(store: Store) {
  ensureData(store);
  store.db.exec("CREATE TABLE IF NOT EXISTS workflow_schedule(workflow_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, next_due INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS workflow_schedule_due ON workflow_schedule(next_due);");
  // Built once from the workflows themselves the first time (and after any loss).
  const indexed = (store.db.prepare("SELECT count(*) AS n FROM workflow_schedule").get() as { n: number }).n;
  if (!indexed)
    for (const r of store.db.prepare("SELECT workspace, data FROM records WHERE kind='workflows' AND json_extract(data,'$.schedule') IS NOT NULL").all() as { workspace: string; data: string }[])
      syncSchedule(store, r.workspace, JSON.parse(r.data));
}
export function syncSchedule(store: Store, w: string, wf: Row) {
  const next = wf.enabled && wf.schedule && wf.scheduledBy ? nextDue(wf.schedule, scheduleClock.now()) : undefined;
  if (next === undefined) store.db.prepare("DELETE FROM workflow_schedule WHERE workflow_id=?").run(wf.id);
  else store.db.prepare("INSERT INTO workflow_schedule(workflow_id, workspace, next_due) VALUES (?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET workspace=excluded.workspace, next_due=excluded.next_due").run(wf.id, w, next);
}
export const unschedule = (store: Store, id: string) => store.db.prepare("DELETE FROM workflow_schedule WHERE workflow_id=?").run(id);
const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (tz: string) => {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })));
  return f;
};
// A schedule is due in the minute it names, in its own time zone.
export function dueKey(s: Record<string, any>, now: Date): string | undefined {
  const parts = Object.fromEntries(formatFor(s.timezone || "UTC").formatToParts(now).map((p) => [p.type, p.value]));
  const [h, m] = String(s.at).split(":").map(Number);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (Number(parts.minute) !== m) return;
  if (s.every !== "hour" && Number(parts.hour) !== h) return;
  if (s.every === "weekday" && (day === 0 || day === 6)) return;
  if (s.every === "week" && day !== s.day) return;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
// The first due minute at or after `from`. Every time zone's offset is a whole number of quarter
// hours, so only minutes whose UTC minute matches the schedule's minute, modulo 15, can be due.
export function nextDue(s: Record<string, any>, from: number): number | undefined {
  const m = Number(String(s.at).split(":")[1]) % 15;
  let t = Math.ceil(from / 60_000) * 60_000;
  while (new Date(t).getUTCMinutes() % 15 !== m) t += 60_000;
  for (const end = t + 8 * 86_400_000; t <= end; t += 15 * 60_000) if (dueKey(s, new Date(t))) return t;
}
export async function runDueWorkflows(store: Store, services: ServiceAdapters, now = new Date()) {
  const due = store.db.prepare("SELECT workflow_id, workspace, next_due FROM workflow_schedule WHERE next_due <= ? ORDER BY next_due LIMIT 500").all(now.getTime()) as { workflow_id: string; workspace: string; next_due: number }[];
  const started: Promise<unknown>[] = [];
  for (const d of due) {
    const wf = store.list(d.workspace, "workflows").find((r) => r.id === d.workflow_id);
    if (!wf?.enabled || !wf.schedule || !wf.scheduledBy) {
      unschedule(store, d.workflow_id);
      continue;
    }
    // Claim this minute before running, so a slow run is never started twice.
    const next = nextDue(wf.schedule, Math.max(now.getTime(), d.next_due) + 60_000);
    if (next === undefined) unschedule(store, wf.id);
    else store.db.prepare("UPDATE workflow_schedule SET next_due=? WHERE workflow_id=?").run(next, wf.id);
    const account = store.db.prepare("SELECT id,email,name,workspace,active_workspace FROM accounts WHERE email=? AND disabled=0").get(wf.scheduledBy) as any;
    const identity = account && identityFor(store, account, d.workspace);
    // Someone who has left the workspace, or lost access to the workflow, no longer runs it.
    if (!identity || !identity.permissions.includes("call") || !visibleTo(wf, identity)) {
      store.audit(d.workspace, wf.scheduledBy, "workflow.schedule-skipped", wf.name);
      continue;
    }
    started.push(runWorkflow(store, services, identity, wf, wf.schedule.inputs || {}, "schedule").catch((e) => console.warn(`[${now.toISOString()}] scheduled workflow "${wf.name}" failed: ${e.message}`)));
  }
  await Promise.all(started);
  return started.length;
}
export function startScheduler(store: Store, services: ServiceAdapters) {
  markInterrupted(store);
  let ticks = 0;
  const timer = setInterval(() => {
    void runDueWorkflows(store, services).catch((e) => console.error("Workflow scheduler", e));
    if (++ticks % 15 === 0) pruneWorkflowData(store);
  }, 20_000);
  timer.unref();
  return timer;
}
