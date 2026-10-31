import { z } from "zod";
import type { Store, Row } from "./store.js";
import type { ServiceAdapters } from "./adapters.js";
import type { Identity } from "./schema.js";
import { gatewayTools } from "./gateway.js";
import { credentialFor } from "./oauth.js";

// A workflow is a fixed, ordered list of tool calls on this gateway. Arguments are templates
// that can use the run's inputs and earlier steps' results; nothing is decided by a model at
// run time, so a run does the same thing every time and each step is logged.
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and underscores, starting with a letter");
export const workflowSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(""),
    inputs: z
      .array(z.object({ name: ident, description: z.string().trim().max(200).default(""), required: z.boolean().default(true) }))
      .max(10)
      .default([]),
    steps: z
      .array(
        z.object({
          id: ident,
          tool: z.string().min(1).max(64),
          args: z.record(z.string().max(64), z.string().max(4000)).refine((v) => Object.keys(v).length <= 30, "Use at most 30 arguments").default({}),
        }),
      )
      .min(1, "Add at least one step")
      .max(20),
    enabled: z.boolean().default(false),
  })
  .superRefine((w, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const inputs = new Set(w.inputs.map((i) => i.name));
    if (inputs.size !== w.inputs.length) issue(["inputs"], "Input names must be unique");
    const seen = new Set<string>();
    w.steps.forEach((step, i) => {
      if (seen.has(step.id)) issue(["steps", i, "id"], "Step ids must be unique");
      for (const [key, value] of Object.entries(step.args))
        for (const ref of references(value)) {
          if (ref.kind === "input" && !inputs.has(ref.name)) issue(["steps", i, "args", key], `Unknown input "${ref.name}"`);
          if (ref.kind === "steps" && !seen.has(ref.name)) issue(["steps", i, "args", key], `"${ref.name}" is not an earlier step`);
        }
      seen.add(step.id);
    });
  });
export type Workflow = z.infer<typeof workflowSchema>;

const PLACEHOLDER = /\{\{\s*(input|steps)\.([a-z][a-z0-9_]*)(?:\.(text|json)((?:\.[A-Za-z0-9_-]+)*))?\s*\}\}/g;
function references(template: string) {
  return [...template.matchAll(PLACEHOLDER)].map((m) => ({ kind: m[1] as "input" | "steps", name: m[2] }));
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
const at = (value: unknown, path: string) =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<any>((v, k) => (v == null ? undefined : v[/^\d+$/.test(k) && Array.isArray(v) ? Number(k) : k]), value);

// A template that is exactly one placeholder keeps the value's type; anything else is text.
export function render(template: string, inputs: Record<string, unknown>, steps: Record<string, StepResult>): unknown {
  const value = (kind: string, name: string, mode?: string, path = "") => {
    if (kind === "input") return inputs[name];
    const s = steps[name];
    if (!s) return undefined;
    return mode === "json" ? at(s.json, path) : s.text;
  };
  const whole = /^\{\{[^}]+\}\}$/.test(template.trim()) ? [...template.trim().matchAll(PLACEHOLDER)][0] : undefined;
  if (whole && whole[0] === template.trim()) return value(whole[1], whole[2], whole[3], whole[4]);
  return template.replace(PLACEHOLDER, (_m, kind, name, mode, path) => {
    const v = value(kind, name, mode, path);
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Non-string schema types get JSON from text ("5" → 5, "[1,2]" → [1,2]).
function coerce(value: unknown, schema: any) {
  if (typeof value !== "string" || !schema?.type || schema.type === "string") return value;
  const parsed = parseJson(value);
  return parsed === undefined ? value : parsed;
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

export type RunOutcome = {
  status: "succeeded" | "failed";
  steps: { id: string; tool: string; status: "ok" | "error" | "skipped"; ms: number; error?: string }[];
  output: string;
  error?: string;
};

const SAFE_ERROR = /^(Authorization (required|expired|denied)|Missing path input|Tool inputs do not match|API request failed with status \d+|Response too large|Tool response too large|Operation path leaves)/;

export async function runWorkflow(
  store: Store,
  services: ServiceAdapters,
  identity: Identity,
  workflow: Row,
  rawInputs: Record<string, unknown>,
  trigger: "console" | "agent",
): Promise<RunOutcome> {
  const w = identity.workspace;
  const inputs: Record<string, unknown> = {};
  for (const i of workflow.inputs || []) {
    const v = rawInputs?.[i.name];
    if ((v === undefined || v === "") && i.required) throw Object.assign(new Error(`Missing input "${i.name}"`), { status: 409 });
    if (v !== undefined) inputs[i.name] = typeof v === "string" ? v.slice(0, 4000) : v;
  }
  const results: Record<string, StepResult> = {};
  const outcome: RunOutcome = { status: "succeeded", steps: [], output: "" };
  const deadline = Date.now() + 120_000;
  for (const step of workflow.steps as Row[]) {
    if (outcome.status === "failed") {
      outcome.steps.push({ id: step.id, tool: step.tool, status: "skipped", ms: 0 });
      continue;
    }
    const started = Date.now();
    try {
      if (Date.now() > deadline) throw new Error("Workflow took longer than two minutes");
      // Resolved against current configuration: a disabled tool or connection stops the run.
      const entry = gatewayTools(store, w).find((t) => t.name === step.tool);
      if (!entry) throw new Error(`Tool ${step.tool} is not available. Check that its connection is enabled and tested`);
      const properties = entry.tool.inputSchema?.properties || {};
      const args: Record<string, unknown> = {};
      for (const [key, template] of Object.entries(step.args || {})) {
        const value = coerce(render(String(template), inputs, results), properties[key]);
        if (value !== undefined && value !== "") args[key] = value;
      }
      const result = await services.call(entry.connection, entry.tool.name, args, await credentialFor(store, w, entry.connection));
      const safe = store.redact(w, result);
      if (safe?.isError) throw new Error(`${entry.connection.name} returned an error: ${textOf(safe).slice(0, 300)}`);
      const text = textOf(safe).slice(0, 100_000);
      results[step.id] = { text, json: parseJson(text) };
      outcome.steps.push({ id: step.id, tool: step.tool, status: "ok", ms: Date.now() - started });
      outcome.output = text;
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[${new Date().toISOString()}] workflow "${workflow.name}" step ${step.id} failed: ${String(message).slice(0, 300)}`);
      const shown = SAFE_ERROR.test(message) || /^(Tool .* is not available|Workflow took longer|.* returned an error:)|OUTBOUND_HOSTS|Private and reserved/.test(message) ? message : "The tool call failed";
      outcome.status = "failed";
      outcome.error = `Step "${step.id}": ${shown}`;
      outcome.steps.push({ id: step.id, tool: step.tool, status: "error", ms: Date.now() - started, error: shown });
    }
  }
  // Runs record what happened, not the data that moved: no inputs or outputs are stored.
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
  store.put(w, "workflows", { ...store.get(w, "workflows", workflow.id), lastRunAt: new Date().toISOString(), lastStatus: outcome.status });
  store.audit(w, identity.user, outcome.status === "succeeded" ? "workflow.ran" : "workflow.failed", workflow.name);
  return outcome;
}

// Saving from the console or from an agent; agents can only ever create disabled drafts.
export function saveWorkflow(store: Store, identity: Identity, input: unknown, existing?: Row, source: "console" | "agent" | "template" = "console") {
  const data = workflowSchema.parse(input);
  const w = identity.workspace;
  if (!existing && store.list(w, "workflows").length >= 100) throw Object.assign(new Error("A workspace can hold up to 100 workflows."), { status: 409 });
  const row = store.put(w, "workflows", {
    ...(existing || {}),
    ...data,
    enabled: source === "agent" ? false : data.enabled,
    source: existing?.source ?? source,
    createdBy: existing?.createdBy ?? identity.user,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  store.audit(w, identity.user, existing ? "workflow.updated" : source === "agent" ? "workflow.drafted-by-agent" : "workflow.created", row.name);
  return row;
}
