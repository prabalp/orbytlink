// A workflow drawn as a flow: where it starts, each step with what it does (loop, condition,
// retries, cache, what it remembers), and where the result comes from. The same drawing shows a
// finished run, colouring each step and opening what went in and out of it. It is built from the
// workflow's own data by one component, so nothing is generated per workflow.
import type { ReactNode } from "react";
import { Bolt, Clock3 as Clock, Database, Filter, Flag, Play, RefreshCw, Repeat, SkipForward, Sparkles, UserRound } from "./icons";

type Data = Record<string, any>;
export type StepNote = { status: string; ms?: number; note?: string; cached?: number; items?: number; error?: string; input?: string; output?: string };
export type Describe = (tool: string) => { title: string; app?: string; mark?: ReactNode };

const every = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : "1 day");
export const cacheOptions = [0, 60, 300, 3600, 86400];
export const cacheText = (s: number) => (s ? `Reused for ${every(s)}` : "Always fresh");
const STATE_REF = /\{\{\s*state\.([a-z][a-z0-9_]*)/g;
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
// Which steps save and which read each remembered value.
export function memoryOf(steps: Data[]) {
  const keys = new Map<string, { writers: string[]; readers: string[] }>();
  const entry = (k: string) => keys.get(k) || keys.set(k, { writers: [], readers: [] }).get(k)!;
  for (const st of steps) {
    for (const k of Object.keys(st.remember || {})) entry(k).writers.push(st.id);
    for (const text of strings({ args: st.args, forEach: st.forEach, when: st.when })) for (const m of text.matchAll(STATE_REF)) if (!entry(m[1]).readers.includes(st.id)) entry(m[1]).readers.push(st.id);
  }
  return [...keys].map(([key, v]) => ({ key, ...v }));
}
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);
const conditionText = (c: Data) => {
  const v = clip(String(c.value || ""), 28);
  return { truthy: `${v} has a value`, falsy: `${v} is empty`, equals: `${v} = ${c.to}`, not_equals: `${v} ≠ ${c.to}`, contains: `${v} contains ${c.to}`, not_contains: `${v} lacks ${c.to}` }[c.op as string] || v;
};

export function FlowDiagram({ workflow, describe, notes, memory }: { workflow: Data; describe: Describe; notes?: Record<string, StepNote>; memory?: ReactNode }) {
  const steps: Data[] = workflow.steps || [];
  const inputs: Data[] = workflow.inputs || [];
  const mem = memoryOf(steps);
  const out = workflow.ui?.output;
  const from = steps.find((s) => s.id === out?.from) || [...steps].reverse().find((s) => s.tool) || steps[steps.length - 1];
  return (
    <div className="flow-wrap">
      <ol className="flow" aria-label="How this workflow runs">
        <li className="flow-step">
          <div className="flow-node start">
            <div className="flow-head">
              <span className="flow-mark"><Play size={14} /></span>
              <div className="flow-title"><strong>Starts when run</strong><small>By you, an agent{workflow.schedule ? ", or its schedule" : ""}</small></div>
            </div>
            <div className="flow-chips">
              {inputs.length ? inputs.map((i) => <span className="flow-chip" key={i.name}>{i.name}{i.required === false ? "" : " *"}</span>) : <span className="flow-chip quiet">No inputs</span>}
              {workflow.schedule && <span className="flow-chip"><Clock size={12} /> {workflow.schedule.every === "hour" ? "Hourly" : workflow.schedule.every === "week" ? "Weekly" : workflow.schedule.every === "weekday" ? "Weekdays" : "Daily"} {workflow.schedule.at}</span>}
            </div>
          </div>
        </li>
        {steps.map((st, i) => {
          const isDecision = st.tool === "judge";
          const d = st.tool ? describe(st.tool) : st.hint ? { title: st.hint.label, app: `${st.hint.app} · not connected`, mark: undefined } : { title: "Choose a tool", app: undefined, mark: undefined };
          const n = notes?.[st.id];
          const mode = st.mode || workflow.judgment || "agent";
          const writes = Object.keys(st.remember || {});
          return (
            <li className="flow-step" key={`${st.id}-${i}`}>
              <span className="flow-link" aria-hidden />
              <div className={`flow-slot${st.when ? " bypass" : ""}${st.forEach ? " loops" : ""}`}>
                <div className={`flow-node${isDecision ? " decision" : ""}${n ? ` ran-${n.status}` : ""}`}>
                  <div className="flow-head">
                    <span className="flow-mark">{isDecision ? mode === "ai" ? <Sparkles size={14} /> : <UserRound size={14} /> : d.mark || <span className="flow-n">{i + 1}</span>}</span>
                    <div className="flow-title">
                      <strong>{isDecision ? (mode === "ai" ? "AI decides" : "You or your agent decide") : d.title}</strong>
                      <small>{isDecision ? "Decision" : d.app || "No tool yet"} · <code>{st.id}</code></small>
                    </div>
                    {n && (
                      <span className={`flow-state is-${n.status === "error" ? "bad" : n.status}`}>
                        <i />
                        {n.status === "skipped" ? n.note || "Skipped" : n.cached ? "From cache" : `${n.ms ?? 0} ms`}
                      </span>
                    )}
                  </div>
                  {isDecision && st.args?.prompt && <p className="flow-prompt">{clip(String(st.args.prompt).replace(/\s+/g, " "), 120)}</p>}
                  <div className="flow-chips">
                    {st.forEach && <span className="flow-chip"><Repeat size={12} /> For each{n?.items !== undefined ? ` · ${n.items}` : ""}</span>}
                    {st.when && <span className="flow-chip"><Filter size={12} /> Only if {conditionText(st.when)}</span>}
                    {st.retries > 0 && <span className="flow-chip"><RefreshCw size={12} /> Retries {st.retries}×</span>}
                    {st.onError === "continue" && <span className="flow-chip"><SkipForward size={12} /> Carries on if it fails</span>}
                    {st.cache > 0 && <span className="flow-chip"><Bolt size={12} /> {cacheText(st.cache)}</span>}
                    {writes.map((k) => <span className="flow-chip memo" key={k}><Database size={12} /> Saves {k}</span>)}
                  </div>
                  {n?.error && <p className="flow-error">{n.error}</p>}
                  {(n?.input || n?.output) && (
                    <details className="flow-data">
                      <summary>Data</summary>
                      {n.input && <><small>Went in</small><pre className="code-block">{n.input}</pre></>}
                      {n.output && <><small>Came out</small><pre className="code-block">{n.output}</pre></>}
                    </details>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        <li className="flow-step">
          <span className="flow-link" aria-hidden />
          <div className="flow-node end">
            <div className="flow-head">
              <span className="flow-mark"><Flag size={14} /></span>
              <div className="flow-title"><strong>Result</strong><small>{from ? <>From <code>{from.id}</code>{out?.view && out.view !== "auto" ? ` · shown as ${out.view}` : ""}</> : "Nothing yet"}</small></div>
            </div>
          </div>
        </li>
      </ol>
      {(mem.length > 0 || memory) && (
        <aside className="flow-memory" aria-label="What it remembers">
          <h3><Database size={14} /> Remembers</h3>
          {mem.map((m) => (
            <div className="flow-mem-row" key={m.key}>
              <code>{m.key}</code>
              <small>{m.writers.length ? `Saved by ${m.writers.join(", ")}` : "Never saved"}{m.readers.length ? ` · used by ${m.readers.join(", ")}` : ""}</small>
            </div>
          ))}
          {memory}
        </aside>
      )}
    </div>
  );
}
