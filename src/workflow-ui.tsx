// A workflow's own run screen. Each workflow stores a small description of it (field types for
// its inputs, how to show its result), written when the workflow is created, by the agent or
// in the editor. One renderer here draws every workflow from that description, so no code is
// generated or loaded per workflow. Anything it doesn't describe falls back to a sensible guess.
import type { ReactNode } from "react";

type Data = Record<string, any>;
export const fieldTypes = ["text", "textarea", "number", "date", "email", "url", "select", "checkbox"] as const;
export const outputViews = ["auto", "table", "list", "cards", "stats", "text", "json"] as const;
const viewLabels: Record<string, string> = { auto: "Automatic", table: "Table", list: "List", cards: "Cards", stats: "Numbers", text: "Text", json: "Raw JSON" };

// A field type from the input's name, when the workflow does not say.
export function guessType(name: string): string {
  if (/(^|_)(date|day|since|until|from|to|deadline|due)($|_)/.test(name)) return "date";
  if (/email/.test(name)) return "email";
  if (/(url|link|website)/.test(name)) return "url";
  if (/(count|limit|number|amount|qty|quantity|max|min|days)/.test(name)) return "number";
  if (/(body|message|text|details|description|notes|prompt|content|summary)/.test(name)) return "textarea";
  return "text";
}
export const fieldOf = (wf: Data, input: Data) => {
  const ui = wf.ui?.inputs?.[input.name] || {};
  return { label: ui.label || input.description || input.name, type: ui.type || guessType(input.name), options: ui.options || [], placeholder: ui.placeholder || "" };
};

export function RunFields({ workflow, values, setValues }: { workflow: Data; values: Record<string, string>; setValues: (v: Record<string, string>) => void }) {
  const inputs: Data[] = workflow.inputs || [];
  if (!inputs.length) return <p className="muted">This workflow takes no inputs.</p>;
  return (
    <div className="wf-run-fields">
      {inputs.map((input) => {
        const f = fieldOf(workflow, input);
        const value = values[input.name] ?? "";
        const set = (v: string) => setValues({ ...values, [input.name]: v });
        const required = input.required !== false;
        let control: ReactNode;
        if (f.type === "checkbox")
          return (
            <label className="check-row" key={input.name}>
              <input type="checkbox" checked={value === "true"} onChange={(e) => set(e.target.checked ? "true" : "false")} /> {f.label}
            </label>
          );
        if (f.type === "textarea") control = <textarea value={value} onChange={(e) => set(e.target.value)} required={required} placeholder={f.placeholder} />;
        else if (f.type === "select")
          control = (
            <select value={value} onChange={(e) => set(e.target.value)} required={required}>
              <option value="">Choose…</option>
              {f.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
            </select>
          );
        else control = <input type={f.type} value={value} onChange={(e) => set(e.target.value)} required={required} placeholder={f.placeholder} />;
        return (
          <label className="field" key={input.name}>
            <span>{f.label}{!required && <small> · optional</small>}</span>
            {control}
          </label>
        );
      })}
    </div>
  );
}

const at = (value: unknown, path?: string) =>
  (path || "").split(".").filter(Boolean).reduce<any>((v, k) => (v == null ? undefined : v[/^\d+$/.test(k) && Array.isArray(v) ? Number(k) : k]), value);
const isObj = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
const show = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
const label = (key: string) => key.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
// Links open only for http(s) addresses; anything else is shown as text.
const safeUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined);
function Cell({ value }: { value: unknown }) {
  const url = safeUrl(value);
  if (url) return <a href={url} target="_blank" rel="noopener noreferrer">{url.replace(/^https?:\/\//, "").slice(0, 60)}</a>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  return <>{show(value).slice(0, 300)}</>;
}
// Which view fits a value, when the workflow says "automatic".
export function autoView(data: unknown) {
  if (typeof data === "string") return "text";
  if (Array.isArray(data)) return data.length && data.every(isObj) ? "table" : "list";
  if (isObj(data)) return Object.values(data).every(scalar) && Object.keys(data).length <= 12 ? "stats" : "json";
  return "text";
}
const keysOf = (rows: Data[]) => {
  const keys: string[] = [];
  for (const r of rows.slice(0, 20)) for (const [k, v] of Object.entries(r)) if (scalar(v) && !keys.includes(k)) keys.push(k);
  return keys.slice(0, 6);
};

export function ResultView({ workflow, data, text }: { workflow: Data; data?: unknown; text?: string }) {
  const o: Data = workflow.ui?.output || {};
  const value = data === undefined || data === null ? text || "" : data;
  if (value === "") return <p className="muted">The run returned nothing to show.</p>;
  let view = o.view && o.view !== "auto" ? o.view : autoView(value);
  const rows: unknown[] = Array.isArray(value) ? value : isObj(value) && ["table", "list", "cards"].includes(view) ? [value] : [];
  if (["table", "list", "cards"].includes(view) && !rows.length) view = typeof value === "string" ? "text" : "json";
  if (view === "stats" && !isObj(value)) view = "json";
  if (view === "table") {
    const objects = rows.filter(isObj);
    const cols: { key: string; label: string }[] = o.columns?.length ? o.columns : keysOf(objects).map((k) => ({ key: k, label: label(k) }));
    return (
      <div className="wf-result table-scroll">
        <table>
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {objects.slice(0, 200).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key}><Cell value={at(r, c.key)} /></td>)}</tr>)}
          </tbody>
        </table>
        {objects.length > 200 && <small className="muted">Showing 200 of {objects.length} rows.</small>}
      </div>
    );
  }
  if (view === "list" || view === "cards") {
    const titleKey = (r: Data) => o.title || Object.keys(r).find((k) => typeof r[k] === "string") || "";
    return (
      <div className={view === "cards" ? "wf-cards" : "wf-list"}>
        {rows.slice(0, 100).map((r, i) => {
          if (!isObj(r)) return <div className="wf-item" key={i}><Cell value={r} /></div>;
          const title = at(r, titleKey(r));
          const url = safeUrl(at(r, o.link || ""));
          const extra = view === "cards" ? Object.entries(r).filter(([k, v]) => scalar(v) && k !== titleKey(r) && k !== o.subtitle && k !== o.link).slice(0, 4) : [];
          return (
            <div className="wf-item" key={i}>
              <strong>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{show(title) || url}</a> : show(title) || `Item ${i + 1}`}</strong>
              {o.subtitle && <small>{show(at(r, o.subtitle))}</small>}
              {extra.map(([k, v]) => <small key={k}><span className="muted">{label(k)}:</span> <Cell value={v} /></small>)}
            </div>
          );
        })}
      </div>
    );
  }
  if (view === "stats")
    return (
      <div className="wf-stats">
        {Object.entries(value as Data).filter(([, v]) => scalar(v)).slice(0, 12).map(([k, v]) => (
          <div className="wf-stat" key={k}><small>{label(k)}</small><strong><Cell value={v} /></strong></div>
        ))}
      </div>
    );
  if (view === "text") return <pre className="code-block wf-text">{show(value).slice(0, 20_000)}</pre>;
  return <pre className="code-block">{JSON.stringify(value, null, 2).slice(0, 20_000)}</pre>;
}

// ── Editor parts ─────────────────────────────────────────────────────────────
export function StepOptions({ step, onChange }: { step: Data; onChange: (patch: Data) => void }) {
  const set = (patch: Data) => onChange(patch);
  const open = !!(step.forEach || step.when || step.retries || step.onError === "continue");
  return (
    <details className="wf-options" open={open}>
      <summary>Loop, condition and errors</summary>
      <label className="wf-arg"><span>For each</span><input value={step.forEach || ""} onChange={(e) => set({ forEach: e.target.value || undefined })} placeholder="{{steps.find.json.items}} — then use {{item}} in arguments" /></label>
      <div className="wf-arg">
        <span>Run only when</span>
        <div className="wf-when">
          <input aria-label="Condition value" value={step.when?.value || ""} onChange={(e) => set({ when: e.target.value ? { op: "truthy", to: "", ...step.when, value: e.target.value } : undefined })} placeholder="{{input.mode}}" />
          <select aria-label="Condition" value={step.when?.op || "truthy"} disabled={!step.when} onChange={(e) => set({ when: { ...step.when, op: e.target.value } })}>
            <option value="truthy">has a value</option>
            <option value="falsy">is empty</option>
            <option value="equals">equals</option>
            <option value="not_equals">does not equal</option>
            <option value="contains">contains</option>
            <option value="not_contains">does not contain</option>
          </select>
          {step.when && !["truthy", "falsy"].includes(step.when.op) && <input aria-label="Compare to" value={step.when.to || ""} onChange={(e) => set({ when: { ...step.when, to: e.target.value } })} placeholder="value" />}
        </div>
      </div>
      <div className="wf-arg">
        <span>If it fails</span>
        <div className="wf-when">
          <select aria-label="Retries" value={step.retries || 0} onChange={(e) => set({ retries: Number(e.target.value) })}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n ? `Retry ${n}×` : "No retry"}</option>)}
          </select>
          <select aria-label="On error" value={step.onError || "stop"} onChange={(e) => set({ onError: e.target.value })}>
            <option value="stop">then stop the run</option>
            <option value="continue">then carry on</option>
          </select>
        </div>
      </div>
    </details>
  );
}

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function describeSchedule(s?: Data | null) {
  if (!s) return "";
  const time = s.every === "hour" ? `at :${s.at.slice(3)}` : `at ${s.at}`;
  const when = { hour: "Every hour", day: "Every day", weekday: "Weekdays", week: `Every ${days[s.day ?? 1]}` }[s.every as string];
  return `${when} ${time}${s.every === "hour" ? "" : ` (${s.timezone})`}`;
}

export function WorkflowSettings({ wf, set, canConfigure }: { wf: Data; set: (patch: Data) => void; canConfigure: boolean }) {
  const ui: Data = wf.ui || { inputs: {}, output: { view: "auto", path: "" } };
  const out: Data = ui.output || { view: "auto", path: "" };
  const setUi = (patch: Data) => set({ ui: { ...ui, ...patch } });
  const setOut = (patch: Data) => setUi({ output: { ...out, ...patch } });
  const setField = (name: string, patch: Data) => setUi({ inputs: { ...ui.inputs, [name]: { ...ui.inputs?.[name], ...patch } } });
  const s: Data | null = wf.schedule || null;
  const setSchedule = (patch: Data | null) => set({ schedule: patch && { every: "day", at: "09:00", timezone: zone(), inputs: {}, ...s, ...patch } });
  const columns = (out.columns || []).map((c: Data) => (c.label && c.label !== c.key ? `${c.key}:${c.label}` : c.key)).join(", ");
  return (
    <>
      <div className="wf-section">
        <div className="wf-section-head"><h3>Run screen</h3><small>What people see when they run it here. Agents that draft a workflow fill this in.</small></div>
        {wf.inputs.map((input: Data) => {
          const f = fieldOf(wf, input);
          return (
            <div className="wf-arg" key={input.name}>
              <span><code>{input.name}</code></span>
              <div className="wf-when">
                <select aria-label={`Field type for ${input.name}`} value={wf.ui?.inputs?.[input.name]?.type || ""} onChange={(e) => setField(input.name, { type: e.target.value || undefined })}>
                  <option value="">Automatic ({f.type})</option>
                  {fieldTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {f.type === "select" && <input aria-label="Choices" value={(f.options || []).join(", ")} onChange={(e) => setField(input.name, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="Choices, separated by commas" />}
              </div>
            </div>
          );
        })}
        <div className="wf-arg">
          <span>Show the result as</span>
          <div className="wf-when">
            <select aria-label="Result view" value={out.view || "auto"} onChange={(e) => setOut({ view: e.target.value })}>
              {outputViews.map((v) => <option key={v} value={v}>{viewLabels[v]}</option>)}
            </select>
            <select aria-label="From step" value={out.from || ""} onChange={(e) => setOut({ from: e.target.value || undefined })}>
              <option value="">from the last step</option>
              {wf.steps.filter((st: Data) => st.id).map((st: Data) => <option key={st.id} value={st.id}>from {st.id}</option>)}
            </select>
            <input aria-label="Path in the result" className="code-input" value={out.path || ""} onChange={(e) => setOut({ path: e.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} placeholder="path, e.g. items" />
          </div>
        </div>
        {out.view === "table" && (
          <label className="wf-arg"><span>Columns</span><input value={columns} onChange={(e) => setOut({ columns: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8).map((x) => { const [key, ...rest] = x.split(":"); return { key: key.trim().replace(/[^A-Za-z0-9_.-]/g, ""), label: (rest.join(":") || key).trim() }; }).filter((c: Data) => c.key) || undefined })} placeholder="name:Name, email:Email (blank = automatic)" /></label>
        )}
        {(out.view === "list" || out.view === "cards") && (
          <div className="wf-arg">
            <span>Item fields</span>
            <div className="wf-when">
              {(["title", "subtitle", "link"] as const).map((k) => <input key={k} aria-label={k} className="code-input" value={out[k] || ""} onChange={(e) => setOut({ [k]: e.target.value.replace(/[^A-Za-z0-9_.-]/g, "") || undefined })} placeholder={`${k} key`} />)}
            </div>
          </div>
        )}
      </div>

      <div className="wf-section">
        <div className="wf-section-head"><h3>Schedule and access</h3></div>
        <div className="wf-arg">
          <span>Who can use it</span>
          <select aria-label="Visibility" value={canConfigure ? wf.visibility || "workspace" : "private"} disabled={!canConfigure} onChange={(e) => set({ visibility: e.target.value })}>
            <option value="workspace">Everyone in this workspace</option>
            <option value="private">Only me (my agents and me)</option>
          </select>
        </div>
        <div className="wf-arg">
          <span>Run on a schedule</span>
          <div className="wf-when">
            <select aria-label="Schedule" value={s?.every || ""} onChange={(e) => setSchedule(e.target.value ? { every: e.target.value, ...(e.target.value === "week" ? { day: s?.day ?? 1 } : {}) } : null)}>
              <option value="">Off</option>
              <option value="hour">Every hour</option>
              <option value="day">Every day</option>
              <option value="weekday">Weekdays</option>
              <option value="week">Every week</option>
            </select>
            {s?.every === "week" && (
              <select aria-label="Day" value={s.day ?? 1} onChange={(e) => setSchedule({ day: Number(e.target.value) })}>
                {days.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {s && <input aria-label="Time" type="time" value={s.at} onChange={(e) => setSchedule({ at: e.target.value || "09:00" })} />}
          </div>
        </div>
        {s && (
          <>
            <small className="muted wf-note">Runs in {s.timezone}, as you, with your access at the time. The run screen is not used.</small>
            {wf.inputs.map((input: Data) => (
              <label className="wf-arg" key={input.name}>
                <span><code>{input.name}</code>{input.required !== false && <em>required</em>}</span>
                <input value={s.inputs?.[input.name] || ""} onChange={(e) => setSchedule({ inputs: { ...s.inputs, [input.name]: e.target.value } })} placeholder="Value for scheduled runs" />
              </label>
            ))}
          </>
        )}
        <label className="check-row">
          <input type="checkbox" checked={!!wf.keepLastResult} onChange={(e) => set({ keepLastResult: e.target.checked })} />
          <span>Keep the latest result<small>Stored for each person, so the run screen shows it again (for example after a scheduled run). Off by default: runs otherwise keep no data.</small></span>
        </label>
      </div>
    </>
  );
}
