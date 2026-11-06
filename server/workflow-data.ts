import { createHash } from "node:crypto";
import type { Store } from "./store.js";

// Everything a workflow keeps between and during runs, in four small tables of the one database:
//   workflow_state       named values a workflow remembers from run to run (per workflow)
//   step_cache           a step's result reused for a while (per workspace, keyed on tool + arguments)
//   run_logs             what went into and came out of each step of recent runs, truncated
//   run_checkpoints      where a run got to, so a restart can carry on instead of starting over
// All are bounded, indexed, and pruned, so they stay small however many workflows there are.
const ready = new WeakSet<Store>();
export function ensure(store: Store) {
  if (ready.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_state(workflow_id TEXT NOT NULL, key TEXT NOT NULL, workspace TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workflow_id, key));
    CREATE TABLE IF NOT EXISTS step_cache(workspace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(workspace, key));
    CREATE INDEX IF NOT EXISTS step_cache_expiry ON step_cache(expires_at);
    CREATE TABLE IF NOT EXISTS run_logs(run_id TEXT NOT NULL, idx INTEGER NOT NULL, workflow_id TEXT NOT NULL, workspace TEXT NOT NULL, step_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, input TEXT, output TEXT, ms INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, idx));
    CREATE INDEX IF NOT EXISTS run_logs_workflow ON run_logs(workflow_id, created_at);
    CREATE TABLE IF NOT EXISTS run_checkpoints(run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workspace TEXT NOT NULL, user TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  ready.add(store);
}
export const dataLimits = { stateKeys: 50, stateValue: 20_000, logText: 1500, logRuns: 10, logDays: 14, checkpoint: 500_000, checkpointDays: 7, cacheRows: 20_000 };
const safe = (message: string) => Object.assign(new Error(message), { safe: true });

// ── State ────────────────────────────────────────────────────────────────────
export function loadState(store: Store, workflowId: string): Record<string, string> {
  ensure(store);
  const rows = store.db.prepare("SELECT key, value FROM workflow_state WHERE workflow_id=?").all(workflowId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export function listState(store: Store, workflowId: string) {
  ensure(store);
  return (store.db.prepare("SELECT key, substr(value,1,300) AS preview, length(value) AS size, updated_at AS updatedAt FROM workflow_state WHERE workflow_id=? ORDER BY key").all(workflowId) as any[]).map((r) => ({ ...r }));
}
export function saveState(store: Store, workspace: string, workflowId: string, key: string, value: string) {
  ensure(store);
  if (value.length > dataLimits.stateValue) throw safe(`Saved value "${key}" is too large (over ${dataLimits.stateValue.toLocaleString()} characters).`);
  const exists = store.db.prepare("SELECT 1 FROM workflow_state WHERE workflow_id=? AND key=?").get(workflowId, key);
  if (!exists) {
    const n = (store.db.prepare("SELECT count(*) AS n FROM workflow_state WHERE workflow_id=?").get(workflowId) as { n: number }).n;
    if (n >= dataLimits.stateKeys) throw safe(`A workflow can remember up to ${dataLimits.stateKeys} values.`);
  }
  store.db.prepare("INSERT INTO workflow_state(workflow_id, key, workspace, value, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workflow_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(workflowId, key, workspace, value, Date.now());
}
export function forgetState(store: Store, workflowId: string, key?: string) {
  ensure(store);
  if (key) store.db.prepare("DELETE FROM workflow_state WHERE workflow_id=? AND key=?").run(workflowId, key);
  else store.db.prepare("DELETE FROM workflow_state WHERE workflow_id=?").run(workflowId);
}

// ── Step cache ───────────────────────────────────────────────────────────────
const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v);
export const cacheKey = (tool: string, args: Record<string, unknown>) => createHash("sha256").update(`${tool}\n${JSON.stringify(canonical(args))}`).digest("hex").slice(0, 40);
export function cacheGet(store: Store, workspace: string, key: string): string | undefined {
  ensure(store);
  const row = store.db.prepare("SELECT value, expires_at AS exp FROM step_cache WHERE workspace=? AND key=?").get(workspace, key) as { value: string; exp: number } | undefined;
  return row && row.exp > Date.now() ? row.value : undefined;
}
export function cachePut(store: Store, workspace: string, key: string, value: string, seconds: number) {
  ensure(store);
  store.db.prepare("INSERT INTO step_cache(workspace, key, value, expires_at) VALUES (?,?,?,?) ON CONFLICT(workspace, key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at").run(workspace, key, value, Date.now() + seconds * 1000);
}
export function clearCache(store: Store, workspace: string) {
  ensure(store);
  return Number(store.db.prepare("DELETE FROM step_cache WHERE workspace=?").run(workspace).changes);
}

// ── Step logs ────────────────────────────────────────────────────────────────
const clip = (s: string) => (s.length > dataLimits.logText ? `${s.slice(0, dataLimits.logText)}… (${s.length.toLocaleString()} characters)` : s);
export type StepLog = { runId: string; idx: number; workflowId: string; workspace: string; stepId: string; tool: string; status: string; input?: string; output?: string; ms: number };
export function logStep(store: Store, l: StepLog) {
  ensure(store);
  store.db.prepare("INSERT OR REPLACE INTO run_logs(run_id, idx, workflow_id, workspace, step_id, tool, status, input, output, ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(l.runId, l.idx, l.workflowId, l.workspace, l.stepId, l.tool, l.status, clip(l.input ?? ""), clip(l.output ?? ""), l.ms, Date.now());
}
export function stepLogs(store: Store, workspace: string, runId: string) {
  ensure(store);
  return store.db.prepare("SELECT idx, step_id AS stepId, tool, status, input, output, ms FROM run_logs WHERE workspace=? AND run_id=? ORDER BY idx").all(workspace, runId) as any[];
}
// Keep only a workflow's most recent runs.
export function trimLogs(store: Store, workflowId: string) {
  ensure(store);
  store.db.prepare("DELETE FROM run_logs WHERE workflow_id=? AND run_id NOT IN (SELECT run_id FROM run_logs WHERE workflow_id=? GROUP BY run_id ORDER BY max(created_at) DESC LIMIT ?)").run(workflowId, workflowId, dataLimits.logRuns);
}

// ── Checkpoints ──────────────────────────────────────────────────────────────
export function saveCheckpoint(store: Store, c: { runId: string; workflowId: string; workspace: string; user: string; data: unknown }) {
  ensure(store);
  const text = JSON.stringify(c.data);
  // A run holding too much data is simply not resumable; it never fails because of it.
  if (text.length > dataLimits.checkpoint) return void dropCheckpoint(store, c.runId);
  store.db.prepare("INSERT INTO run_checkpoints(run_id, workflow_id, workspace, user, data, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").run(c.runId, c.workflowId, c.workspace, c.user, text, Date.now());
}
export function loadCheckpoint(store: Store, workspace: string, runId: string) {
  ensure(store);
  const r = store.db.prepare("SELECT workflow_id AS workflowId, user, data FROM run_checkpoints WHERE workspace=? AND run_id=?").get(workspace, runId) as { workflowId: string; user: string; data: string } | undefined;
  return r && { workflowId: r.workflowId, user: r.user, data: JSON.parse(r.data) };
}
export function dropCheckpoint(store: Store, runId: string) {
  ensure(store);
  store.db.prepare("DELETE FROM run_checkpoints WHERE run_id=?").run(runId);
}
export const hasCheckpoint = (store: Store, runId: string) => (ensure(store), !!store.db.prepare("SELECT 1 FROM run_checkpoints WHERE run_id=?").get(runId));

// ── Housekeeping ─────────────────────────────────────────────────────────────
export function forgetWorkflowData(store: Store, workflowId: string) {
  ensure(store);
  for (const t of ["workflow_state", "run_logs", "run_checkpoints"]) store.db.prepare(`DELETE FROM ${t} WHERE workflow_id=?`).run(workflowId);
}
export function pruneWorkflowData(store: Store, now = Date.now()) {
  ensure(store);
  store.db.prepare("DELETE FROM step_cache WHERE expires_at<?").run(now);
  const over = (store.db.prepare("SELECT count(*) AS n FROM step_cache").get() as { n: number }).n - dataLimits.cacheRows;
  if (over > 0) store.db.prepare("DELETE FROM step_cache WHERE rowid IN (SELECT rowid FROM step_cache ORDER BY expires_at LIMIT ?)").run(over);
  store.db.prepare("DELETE FROM run_logs WHERE created_at<?").run(now - dataLimits.logDays * 86_400_000);
  store.db.prepare("DELETE FROM run_checkpoints WHERE updated_at<?").run(now - dataLimits.checkpointDays * 86_400_000);
}
