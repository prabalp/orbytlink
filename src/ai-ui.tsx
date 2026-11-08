// AI models in the console: a model's details with a charged "try it", and the workspace's
// AI credit (balance, monthly limit, recent usage). Calls go through OrbytLink's own gateway key;
// the browser only ever talks to /api/ai.
import { useEffect, useState } from "react";
import { LoaderCircle, Play } from "./icons";

type Data = Record<string, any>;
type Call = (path: string, body?: unknown, method?: string) => Promise<any>;
export type ModelRow = { id: string; name: string; provider: string; category: string; context: number | null; input: [string, string] | null; output: [string, string] | null; from?: boolean };
export const dollars = (micro: number, digits = 2) => `$${(micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 6) })}`;
const price = (r: [string, string] | null, from?: boolean, scale = 1) => (r ? `${from ? "From " : ""}$${(Number(r[0]) * scale).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} / ${r[1]}` : "—");
// Only text models priced per token can be called for now; the server checks the same rule.
export const callable = (m: ModelRow) => m.category === "Text & reasoning" && m.input?.[1] === "1M tokens" && m.output?.[1] === "1M tokens";

export function ModelDetail({ model: m, ai, call, onSpent }: { model: ModelRow; ai: Data; call: Call; onSpent: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(512);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const ready = ai.configured && ai.enabled && callable(m);
  const why = !callable(m)
    ? "Only text models can be called through OrbytLink for now."
    : !ai.configured
      ? "AI models are not switched on for this OrbytLink server yet."
      : !ai.enabled
        ? "An admin has turned AI models off for this workspace (Settings → AI credit)."
        : "";
  return (
    <div className="form-body model-detail">
      <dl className="model-facts">
        <div><dt>Model ID</dt><dd><code>{m.id}</code></dd></div>
        <div><dt>Type</dt><dd>{m.category}</dd></div>
        <div><dt>Context</dt><dd>{m.context ? `${m.context.toLocaleString("en-US")} tokens` : "—"}</dd></div>
        <div><dt>Input</dt><dd>{price(m.input, m.from, ai.priceScale || 1)}</dd></div>
        <div><dt>Output</dt><dd>{price(m.output, m.from, ai.priceScale || 1)}</dd></div>
        <div><dt>Your AI credit</dt><dd>{dollars(ai.balance)}</dd></div>
      </dl>
      {why ? (
        <div className="info-row"><p>{why}</p></div>
      ) : (
        <>
          <div className="wf-section">
            <div className="wf-section-head"><h3>Use it</h3><small>Charged to this workspace’s AI credit at the price above.</small></div>
            <p className="muted model-use">
              Agents call <code>orbytlink__ai_generate</code> with <code>{`{ "model": "${m.id}", "prompt": "…" }`}</code>. In a workflow, add a step with the tool <em>Ask an AI model</em> and set <code>model</code> to <code>{m.id}</code>.
            </p>
          </div>
          <form
            className="wf-section"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setResult(null);
              try {
                setResult(await call("/ai/try", { model: m.id, prompt, maxTokens }));
                onSpent();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="wf-section-head"><h3>Try it</h3><small>A real call: it uses credit.</small></div>
            <label className="field">
              <span>Prompt</span>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={20_000} placeholder="Ask anything" />
            </label>
            <label className="field">
              <span>Longest reply</span>
              <select value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))}>
                {[256, 512, 1024, 4096].map((n) => <option key={n} value={n}>{n.toLocaleString("en-US")} tokens</option>)}
              </select>
              <small>Credit for the whole reply is held during the call; you pay only for what is used.</small>
            </label>
            {error && <div className="error">{error}</div>}
            {result && (
              <div className="model-reply">
                <pre className="code-block wf-text">{result.text || "(empty reply)"}</pre>
                <small className="muted">{result.inputTokens.toLocaleString("en-US")} input and {result.outputTokens.toLocaleString("en-US")} output tokens · charged {dollars(result.costMicro, 6)}</small>
              </div>
            )}
            <div className="form-footer">
              <button className="primary" disabled={busy || !ready || !prompt.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={13} />} Run</button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

export function AiCredit({ call, canConfigure, onSaved }: { call: Call; canConfigure: boolean; onSaved: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [limit, setLimit] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () =>
    call("/ai").then((d) => {
      setData(d);
      setEnabled(d.enabled);
      setLimit(d.monthlyLimit === null ? "" : String(d.monthlyLimit / 1_000_000));
    }, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return error ? <div className="error">{error}</div> : <p className="muted"><LoaderCircle size={15} className="spin" /> Loading…</p>;
  return (
    <>
      <section className="setting-section">
        <h3>AI credit</h3>
        <div className="wf-stats ai-stats">
          <div className="wf-stat"><small>Balance</small><strong>{dollars(data.balance)}</strong></div>
          <div className="wf-stat"><small>Spent this month</small><strong>{dollars(data.monthSpent)}</strong></div>
          <div className="wf-stat"><small>Monthly limit</small><strong>{data.monthlyLimit === null ? "None" : dollars(data.monthlyLimit)}</strong></div>
        </div>
        <p className="muted ai-note">
          {data.configured ? "Text models from Catalog → AI models are billed to this credit at the listed prices." : "AI models are not switched on for this OrbytLink server yet."} Credit is added by OrbytLink for now; online top-ups are coming.
        </p>
      </section>
      {canConfigure && (
        <form
          className="setting-section"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await call("/ai/settings", { enabled, monthlyLimitUsd: limit.trim() === "" ? null : Number(limit) }, "PUT");
              await load();
              onSaved();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>Limits</h3>
          <label className="check-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Allow AI models in this workspace<small>When off, agents and workflows cannot call models and nothing is charged.</small></span>
          </label>
          <label className="field">
            <span>Monthly limit (USD)</span>
            <input type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" />
            <small>Calls that could take this month’s spend past the limit are refused.</small>
          </label>
          {error && <div className="error">{error}</div>}
          <div><button className="primary" disabled={busy}>Save limits</button></div>
        </form>
      )}
      <section className="setting-section">
        <h3>Recent usage</h3>
        {data.usage.length ? (
          <div className="table-scroll">
            <table className="models-table">
              <thead><tr><th>Model</th><th>Tokens</th><th>Cost</th><th>By</th><th>When</th></tr></thead>
              <tbody>
                {data.usage.map((u: Data) => (
                  <tr key={u.id}>
                    <td><code>{u.model}</code></td>
                    <td className="muted">{u.inputTokens.toLocaleString("en-US")} in · {u.outputTokens.toLocaleString("en-US")} out</td>
                    <td>{dollars(u.micro, 6)}</td>
                    <td className="muted">{({ agent: "Agent", workflow: "Workflow", console: "Console" } as Data)[u.via]} · {u.user}</td>
                    <td className="muted">{new Date(u.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No AI calls yet.</p>
        )}
      </section>
    </>
  );
}
