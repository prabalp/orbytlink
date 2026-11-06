import { z } from "zod";
import type { Store, Row } from "./store.js";
import type { ServiceAdapters } from "./adapters.js";
import type { Identity } from "./schema.js";
import { callStoredApi, gatewayTools, visibleWorkflowTools, API_REQUEST_TOOL } from "./gateway.js";
import { credentialFor } from "./oauth.js";
import { identityFor } from "./orgs.js";
import { AI_TOOL, aiInputSchema, generate } from "./ai.js";

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
});
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

const PLACEHOLDER = /\{\{\s*(?:(input|steps)\.([a-z][a-z0-9_]*)(?:\.(text|json)((?:\.[A-Za-z0-9_-]+)*))?|(item)((?:\.[A-Za-z0-9_-]+)*))\s*\}\}/g;
function references(value: string) {
  return [...value.matchAll(PLACEHOLDER)].map((m) => (m[5] ? { kind: "item" as const, name: "" } : { kind: m[1] as "input" | "steps", name: m[2] }));
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
export function render(value: string, inputs: Record<string, unknown>, steps: Record<string, StepResult>, item?: unknown): unknown {
  const resolve = (m: RegExpMatchArray | string[]) => {
    if (m[5]) return at(item, m[6] || "");
    if (m[1] === "input") return inputs[m[2]];
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
export function holds(c: z.infer<typeof condition>, inputs: Record<string, unknown>, steps: Record<string, StepResult>) {
  const value = render(c.value, inputs, steps);
  const to = asText(render(c.to, inputs, steps));
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
  status: "succeeded" | "failed";
  steps: { id: string; tool: string; status: "ok" | "error" | "skipped"; ms: number; error?: string; note?: string; items?: number }[];
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

async function execute(
  store: Store,
  services: ServiceAdapters,
  identity: Identity,
  workflow: Row,
  rawInputs: Record<string, unknown>,
  trigger: "console" | "agent" | "schedule" | "workflow",
  parent?: Run,
): Promise<RunOutcome> {
  const w = identity.workspace;
  const inputs: Record<string, unknown> = {};
  for (const i of workflow.inputs || []) {
    const v = rawInputs?.[i.name];
    if ((v === undefined || v === "") && i.required) throw Object.assign(new Error(`Missing input "${i.name}"`), { status: 409 });
    if (v !== undefined) inputs[i.name] = typeof v === "string" ? v.slice(0, 4000) : v;
  }
  const run: Run = parent ? { ...parent, stack: [...parent.stack, workflow.id] } : { deadline: Date.now() + 120_000, calls: 0, stack: [workflow.id] };
  const results: Record<string, StepResult> = {};
  const outcome: RunOutcome = { status: "succeeded", steps: [], output: "" };
  let stopped = false,
    last: string | undefined;
  for (const s of workflow.steps as Row[]) {
    if (stopped) {
      outcome.steps.push({ id: s.id, tool: s.tool, status: "skipped", ms: 0 });
      continue;
    }
    const started = Date.now();
    try {
      if (Date.now() > run.deadline) throw new Error("Workflow took longer than two minutes");
      if (s.when && !holds(s.when, inputs, results)) {
        outcome.steps.push({ id: s.id, tool: s.tool, status: "skipped", ms: 0, note: "Condition not met" });
        continue;
      }
      const properties = schemaFor(store, identity, s.tool);
      const argsFor = (item?: unknown) => {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(s.args || {})) {
          const v = coerce(render(String(value), inputs, results, item), properties[key]);
          if (v !== undefined && v !== "") args[key] = v;
        }
        return args;
      };
      const once = (item?: unknown) => withRetries(s.retries || 0, run.deadline, () => callStep(store, services, identity, s.tool, argsFor(item), run));
      if (s.forEach) {
        let items = render(s.forEach, inputs, results);
        if (typeof items === "string") items = parseJson(items);
        if (!Array.isArray(items)) throw new Error("For each did not get a list. Point it at a JSON array, e.g. {{steps.find.json.items}}");
        if (items.length > MAX_ITEMS) throw new Error(`For each got ${items.length} items; the limit is ${MAX_ITEMS}`);
        const texts: string[] = [];
        for (const item of items) texts.push(await once(item));
        results[s.id] = { text: JSON.stringify(texts), json: texts.map((t) => parseJson(t) ?? t) };
        outcome.steps.push({ id: s.id, tool: s.tool, status: "ok", ms: Date.now() - started, items: items.length });
      } else {
        const text = await once();
        results[s.id] = { text, json: parseJson(text) };
        outcome.steps.push({ id: s.id, tool: s.tool, status: "ok", ms: Date.now() - started });
      }
      outcome.output = results[s.id].text;
      last = s.id;
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[${new Date().toISOString()}] workflow "${workflow.name}" step ${s.id} failed: ${String(message).slice(0, 300)}`);
      // Credit, limit and model errors are written to be shown.
      const shown = (error as any)?.safe ? message : (error as any)?.issues ? `Invalid arguments: ${(error as any).issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : shownError(message);
      outcome.steps.push({ id: s.id, tool: s.tool, status: "error", ms: Date.now() - started, error: shown });
      if (s.onError === "continue") continue;
      outcome.status = "failed";
      outcome.error = `Step "${s.id}": ${shown}`;
      stopped = true;
    }
  }
  const view = workflow.ui?.output;
  const source = results[view?.from || last || ""];
  if (source) {
    const data = view?.path ? at(source.json, view.path) : (source.json ?? source.text);
    if (data !== undefined && JSON.stringify(data).length <= MAX_RESULT) outcome.data = data;
  }
  // Runs record what happened, not the data that moved: no inputs or outputs are stored,
  // except the latest result of a workflow set to keep it, for the person who ran it.
  store.put(w, "workflow_runs", {
    workflowId: workflow.id,
    workflow: workflow.name,
    status: outcome.status,
    steps: outcome.steps,
    trigger,
    user: identity.user,
    createdAt: new Date().toISOString(),
  });
  store.trim(w, "workflow_runs", 500);
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
export const runWorkflow = (store: Store, services: ServiceAdapters, identity: Identity, workflow: Row, inputs: Record<string, unknown>, trigger: "console" | "agent" | "schedule") =>
  execute(store, services, identity, workflow, inputs, trigger);
export function lastResult(store: Store, identity: Identity, workflowId: string) {
  return store.list(identity.workspace, "workflow_results").find((r) => r.id === `${workflowId}:${identity.user}`) || null;
}
export function forgetResults(store: Store, w: string, workflowId: string) {
  for (const r of store.list(w, "workflow_results")) if (r.workflowId === workflowId) store.remove(w, "workflow_results", r.id);
}

const forbidden = (message: string) => Object.assign(new Error(message), { status: 403 });
// Saving from the console or from an agent. Agents only ever create disabled drafts. Members
// (who can call tools but not configure) may keep private workflows of their own; sharing a
// workflow with the workspace, or scheduling one for it, takes an admin.
export function saveWorkflow(store: Store, identity: Identity, input: unknown, existing?: Row, source: "console" | "agent" | "template" = "console") {
  const data = workflowSchema.parse(input);
  const w = identity.workspace;
  const admin = identity.permissions.includes("configure");
  if (existing && !manageable(existing, identity)) throw forbidden("Only an admin or the workflow's owner can change it.");
  if (!admin && data.visibility !== "private") throw forbidden("Only an admin can share a workflow with the workspace. Keep it private.");
  if (!existing && store.list(w, "workflows").length >= 100) throw Object.assign(new Error("A workspace can hold up to 100 workflows."), { status: 409 });
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
  store.audit(w, identity.user, existing ? "workflow.updated" : source === "agent" ? "workflow.drafted-by-agent" : "workflow.created", row.name);
  return row;
}

// ── Schedules ────────────────────────────────────────────────────────────────
// A schedule is due in the minute it names, in its own time zone. The minute's key is stored on
// the workflow, so a minute runs once however often the scheduler ticks.
export function dueKey(s: Record<string, any>, now: Date): string | undefined {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const [h, m] = String(s.at).split(":").map(Number);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (Number(parts.minute) !== m) return;
  if (s.every !== "hour" && Number(parts.hour) !== h) return;
  if (s.every === "weekday" && (day === 0 || day === 6)) return;
  if (s.every === "week" && day !== s.day) return;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
export async function runDueWorkflows(store: Store, services: ServiceAdapters, now = new Date()) {
  const workspaces = store.db.prepare("SELECT DISTINCT workspace FROM records WHERE kind='workflows'").all() as { workspace: string }[];
  const started: Promise<unknown>[] = [];
  for (const { workspace } of workspaces)
    for (const wf of store.list(workspace, "workflows")) {
      if (!wf.enabled || !wf.schedule || !wf.scheduledBy) continue;
      const key = dueKey(wf.schedule, now);
      if (!key || wf.lastScheduledKey === key) continue;
      store.put(workspace, "workflows", { ...wf, lastScheduledKey: key });
      const account = store.db.prepare("SELECT id,email,name,workspace,active_workspace FROM accounts WHERE email=? AND disabled=0").get(wf.scheduledBy) as any;
      const identity = account && identityFor(store, account, workspace);
      // Someone who has left the workspace, or lost access to the workflow, no longer runs it.
      if (!identity || !identity.permissions.includes("call") || !visibleTo(wf, identity)) {
        store.audit(workspace, wf.scheduledBy, "workflow.schedule-skipped", wf.name);
        continue;
      }
      started.push(execute(store, services, identity, wf, wf.schedule.inputs || {}, "schedule").catch((e) => console.warn(`[${now.toISOString()}] scheduled workflow "${wf.name}" failed: ${e.message}`)));
    }
  await Promise.all(started);
  return started.length;
}
export function startScheduler(store: Store, services: ServiceAdapters) {
  const timer = setInterval(() => void runDueWorkflows(store, services).catch((e) => console.error("Workflow scheduler", e)), 20_000);
  timer.unref();
  return timer;
}
