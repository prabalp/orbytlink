// The operator's admin portal (/admin): prices of everything sold, provider balances and routing,
// costs and margins, workspace credit, and a log of every change. Loaded only for operators; the
// server answers 404 to anyone else, so this file holds no secrets and no authority of its own.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Building, ChartLine, ChevronDown, Download, LoaderCircle, Menu, PanelLeft, RefreshCw, ScrollText, Server, Tag, Upload, X, Activity } from "./icons";
import { api, Empty, Modal, OrbitLogo, Toolbar } from "./main";

type Data = Record<string, any>;
const SECTIONS = [
  ["Overview", ChartLine, "Revenue, provider cost and margin from every paid call."],
  ["Pricing", Tag, "What everything sells for: AI models, services and Instant tools."],
  ["Providers", Server, "Balances at each provider, model lists, and how calls are routed."],
  ["Workspaces", Building, "Credit and spend for every workspace."],
  ["Calls", Activity, "Every paid call: what ran, through which provider, what it cost and earned."],
  ["Change log", ScrollText, "Every change made in this portal."],
] as const;
type Section = (typeof SECTIONS)[number][0];
const slug = (s: string) => s.toLowerCase().replace(/ /g, "-");

// ── Formatting ───────────────────────────────────────────────────────────────
// Micro-dollars to dollars: cents for amounts of a dollar or more, otherwise enough digits to see it.
export const money = (micro: number | null | undefined) => {
  if (micro === null || micro === undefined) return "—";
  const v = micro / 1_000_000;
  const abs = Math.abs(v);
  const digits = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${v < 0 ? "−" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const unitPrice = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${Number(v.toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "" : ""}${v}%`);
const typeLabel: Data = { model: "AI model", service: "Service", tool: "Instant tool" };

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError("");
    api(path).then(
      (d) => live && setData(d),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}
function Select({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode }) {
  return (
    <div className="catalog-select-wrap">
      <label className="sr-only">{label}</label>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
      <ChevronDown size={16} />
    </div>
  );
}
function Loading() {
  return <p className="muted models-loading"><LoaderCircle size={15} className="spin" /> Loading…</p>;
}

// ── Shell ────────────────────────────────────────────────────────────────────
export function AdminApp({ state: s }: { state: Data }) {
  const [section, setSection] = useState<Section>(() => SECTIONS.find(([n]) => slug(n) === location.hash.slice(1))?.[0] || "Overview");
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("orbytlink:sidebar") !== "collapsed";
    } catch {
      return true;
    }
  });
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState("");
  useEffect(() => {
    document.title = "Admin · OrbytLink";
    const route = () => {
      setSection(SECTIONS.find(([n]) => slug(n) === location.hash.slice(1))?.[0] || "Overview");
      setMobile(false);
    };
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const open = expanded || mobile;
  const toggle = (value: boolean) => {
    setExpanded(value);
    try {
      localStorage.setItem("orbytlink:sidebar", value ? "expanded" : "collapsed");
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit.
    }
  };
  const [, Icon, subtitle] = SECTIONS.find(([n]) => n === section)!;
  void Icon;
  return (
    <div className={`app-shell ${open ? "" : "sidebar-collapsed"}`}>
      {mobile && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? "open" : ""}`} aria-label="Admin">
        <div className="sidebar-top">
          {open ? (
            <>
              <a className="brand" href="#overview"><OrbitLogo /><span>Admin</span></a>
              <button className="rail-button collapse-button" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => (mobile ? setMobile(false) : toggle(false))}><PanelLeft size={18} /></button>
            </>
          ) : (
            <button className="rail-button logo-button" title="Open sidebar" aria-label="Open sidebar" onClick={() => toggle(true)}><OrbitLogo /></button>
          )}
        </div>
        <nav aria-label="Admin navigation">
          {SECTIONS.map(([name, I]) => (
            <a href={`#${slug(name)}`} key={name} className={section === name ? "active" : ""} aria-current={section === name ? "page" : undefined} title={open ? undefined : name} aria-label={open ? undefined : name}>
              <I size={16} />
              {open && <span>{name}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a className="sidebar-help" href="/" title={open ? undefined : "Back to console"} aria-label="Back to console"><ArrowLeft size={16} />{open && <span>Back to console</span>}</a>
          {open && <p className="admin-who"><small>Signed in as {s.identity.email}</small></p>}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div><button className="icon-button mobile-menu" onClick={() => setMobile(!mobile)} aria-label="Toggle navigation"><Menu size={20} /></button><span className="topbar-title">{section}</span></div>
        </header>
        <main className="workspace-main">
          {section === "Overview" && <OverviewPage subtitle={subtitle} />}
          {section === "Pricing" && <PricingPage subtitle={subtitle} notify={setToast} />}
          {section === "Providers" && <ProvidersPage subtitle={subtitle} notify={setToast} />}
          {section === "Workspaces" && <WorkspacesPage subtitle={subtitle} notify={setToast} />}
          {section === "Calls" && <CallsPage subtitle={subtitle} />}
          {section === "Change log" && <LogPage subtitle={subtitle} />}
        </main>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
function Heading({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) {
  return (
    <div className="page-heading">
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      {children && <div className="heading-actions">{children}</div>}
    </div>
  );
}
function ErrorRow({ message, onClose }: { message: string; onClose?: () => void }) {
  if (!message) return null;
  return <div className="error" role="alert">{message}{onClose && <button className="icon-button" onClick={onClose} aria-label="Dismiss error"><X size={16} /></button>}</div>;
}
function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "bad" }) {
  return (
    <div className="admin-stat">
      <small>{label}</small>
      <strong className={tone ? `tone-${tone}` : undefined}>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
function OverviewPage({ subtitle }: { subtitle: string }) {
  const [days, setDays] = useState(30);
  const { data, error } = useLoad<Data>(`/admin/overview?days=${days}`);
  const t = data?.totals;
  return (
    <>
      <Heading title="Overview" subtitle={subtitle}>
        <div className="segmented" role="group" aria-label="Period">
          {[7, 30, 90].map((d) => <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{d} days</button>)}
        </div>
      </Heading>
      <ErrorRow message={error} />
      {!data ? <section className="panel"><Loading /></section> : (
        <>
          <section className="panel admin-stats">
            <Stat label="Revenue" value={money(t.charged)} note={`${t.calls.toLocaleString()} paid call${t.calls === 1 ? "" : "s"}`} />
            <Stat label="Provider cost" value={money(t.cost)} note={t.costUnknown ? `${t.costUnknown} without a cost` : "every call costed"} />
            <Stat label="Margin" value={money(t.margin)} note={t.charged ? `${Math.round((t.margin / t.charged) * 1000) / 10}% of revenue` : "—"} tone={t.margin < 0 ? "bad" : t.margin > 0 ? "good" : undefined} />
            <Stat label="Failed attempts" value={t.failed.toLocaleString()} note="moved to another provider or refunded" />
            <Stat label="Credit held" value={money(data.creditHeld)} note="workspace balances, owed in service" />
          </section>
          {data.alerts.length > 0 && (
            <section className="panel">
              <div className="section-heading"><h2>Needs attention</h2><span className="count">{data.alerts.length}</span></div>
              <ul className="admin-alerts">{data.alerts.map((a: string) => <li key={a}><span className="status pending"><i /></span>{a}</li>)}</ul>
            </section>
          )}
          <div className="admin-grid">
            <Breakdown title="By provider" rows={data.bySource} keyLabel="Provider" />
            <Breakdown title="By kind" rows={data.byKind} keyLabel="Kind" />
          </div>
          <Breakdown title="Top items" rows={data.topItems} keyLabel="Item" />
          <Breakdown title="By day" rows={[...data.byDay].reverse()} keyLabel="Day" />
          <ProviderBalances providers={data.providers} />
        </>
      )}
    </>
  );
}
function Breakdown({ title, rows, keyLabel }: { title: string; rows: Data[]; keyLabel: string }) {
  return (
    <section className="panel">
      <div className="section-heading"><h2>{title}</h2><span className="count">{rows.length}</span></div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>{keyLabel}</th><th>Calls</th><th>Cost</th><th>Revenue</th><th>Margin</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><strong className="admin-key">{r.key}</strong>{r.failed > 0 && <small>{r.failed} failed</small>}</td>
                  <td>{Number(r.calls).toLocaleString()}</td>
                  <td>{money(r.cost_micro)}{r.cost_unknown > 0 && <small>{r.cost_unknown} uncosted</small>}</td>
                  <td>{money(r.charged_micro)}</td>
                  <td className={r.margin_micro < 0 ? "tone-bad" : undefined}>{money(r.margin_micro)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty icon={ChartLine} title="No paid calls in this period">Calls appear here as workspaces use paid models and tools.</Empty>}
    </section>
  );
}
function ProviderBalances({ providers }: { providers: Data[] }) {
  return (
    <section className="panel">
      <div className="section-heading"><h2>Provider balances</h2><a className="text-button" href="#providers">Manage</a></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Provider</th><th>Balance</th><th>How it’s known</th></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong><small>{p.id}</small></td>
                <td className={p.balance_micro !== null && p.balance_micro < 5_000_000 && p.balance_mode !== "postpaid" ? "tone-bad" : undefined}>{p.balance_mode === "postpaid" ? "Postpaid" : p.balance_micro === null ? "Not recorded" : money(p.balance_micro)}</td>
                <td className="muted">{p.balance_mode === "api" ? `Read from its API${p.balance_checked_at ? ` · ${when(p.balance_checked_at)}` : ""}` : p.balance_mode === "manual" ? "Recorded here; calls are taken off" : "Billed afterwards"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Pricing ──────────────────────────────────────────────────────────────────
const ruleText = (r: Data) => (r.rule === "markup" ? `Markup ${r.markup_pct}%` : r.rule === "fixed" ? "Fixed" : r.rule === "unpriced" ? "No price" : "Default");
function PricingPage({ subtitle, notify }: { subtitle: string; notify: (m: string) => void }) {
  const [type, setType] = useState("");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [edit, setEdit] = useState<Data | null>(null);
  const [upload, setUpload] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, reload } = useLoad<Data>(`/admin/pricing?type=${type}&filter=${filter}&q=${encodeURIComponent(query)}&limit=${limit}`);
  return (
    <>
      <Heading title="Pricing" subtitle={subtitle}>
        <a className="secondary button-link" href={`/api/admin/pricing.csv${type ? `?type=${type}` : ""}`} download><Download size={16} /> Download CSV</a>
        <button className="primary" onClick={() => setUpload(true)}><Upload size={16} /> Upload CSV</button>
      </Heading>
      <ErrorRow message={error} />
      {data && <Markups markups={data.markups} onSaved={(m) => (notify(m), reload())} />}
      <Toolbar
        search={q}
        setSearch={setQ}
        placeholder="Search models, services and tools…"
        count={data ? `${data.total.toLocaleString()} prices` : ""}
        control={
          <>
            <Select label="Type" value={type} onChange={(v) => (setType(v), setLimit(100))}>
              <option value="">Everything</option>
              <option value="model">AI models</option>
              <option value="service">Services</option>
              <option value="tool">Instant tools</option>
            </Select>
            <Select label="Show" value={filter} onChange={(v) => (setFilter(v), setLimit(100))}>
              <option value="all">All prices</option>
              <option value="custom">Set by hand</option>
              <option value="loss">Below cost</option>
              <option value="unpriced">No price</option>
              <option value="live">Callable now</option>
            </Select>
          </>
        }
      />
      <section className="panel">
        {!data ? <Loading /> : data.rows.length ? (
          <>
            <div className="table-scroll">
              <table className="admin-prices">
                <thead><tr><th>Item</th><th>Cost</th><th>Price</th><th>Rule</th><th>Margin</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {data.rows.map((r: Data) => (
                    <tr key={`${r.type}|${r.id}`}>
                      <td><strong>{r.name}</strong><small>{typeLabel[r.type]} · <code>{r.id}</code> · {r.unit}{r.type !== "tool" ? ` · ${r.live}/${r.routes} routes live` : ""}</small></td>
                      <td>{unitPrice(r.cost_in)}{r.type === "model" && <small>out {unitPrice(r.cost_out)}</small>}</td>
                      <td><strong>{unitPrice(r.price_in)}</strong>{r.type === "model" && <small>out {unitPrice(r.price_out)}</small>}</td>
                      <td><span className={`tag ${r.rule === "default" ? "" : "tag-strong"}`}>{ruleText(r)}</span></td>
                      <td className={r.margin_pct !== null && r.margin_pct < 0 ? "tone-bad" : undefined}>{pct(r.margin_pct)}</td>
                      <td><button className="secondary compact" onClick={() => setEdit(r)}>Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.total > data.rows.length && <div className="admin-more"><button className="text-button" onClick={() => setLimit(limit + 200)}>Show more ({(data.total - data.rows.length).toLocaleString()} left)</button></div>}
          </>
        ) : <Empty icon={Tag} title="No prices match">Try another search, type or filter.</Empty>}
      </section>
      <div className="info-row"><p className="muted">Prices are USD per unit. Models: per 1M tokens in and out. Margin is on a typical call (1,000 tokens in, 250 out). People only ever see the price.</p></div>
      {edit && <EditPrice row={edit} markups={data?.markups} onClose={() => setEdit(null)} onSaved={(m) => (setEdit(null), notify(m), reload())} />}
      {upload && <UploadCsv onClose={() => setUpload(false)} onApplied={(m) => (setUpload(false), notify(m), reload())} />}
    </>
  );
}
function Markups({ markups, onSaved }: { markups: Data; onSaved: (message: string) => void }) {
  const [ai, setAi] = useState(String(markups.ai.percent));
  const [instant, setInstant] = useState(String(markups.instant.percent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setAi(String(markups.ai.percent));
    setInstant(String(markups.instant.percent));
  }, [markups.ai.percent, markups.instant.percent]);
  const save = async (kind: "ai" | "instant", value: string) => {
    setBusy(true);
    setError("");
    try {
      await api("/admin/markups", { [kind]: value === "" ? null : Number(value) }, "PUT");
      onSaved(`${kind === "ai" ? "AI model" : "Instant tool"} markup is now ${value === "" ? "the .env value" : `${value}%`}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const from = (f: string) => (f === "admin" ? "set here" : f === ".env" ? "from .env" : "built-in default");
  return (
    <section className="panel">
      <div className="section-heading"><h2>Default markups</h2><span className="count">Used where no price is set by hand</span></div>
      <ErrorRow message={error} />
      <div className="admin-rows">
        {([["ai", "AI models and services", ai, setAi, markups.ai], ["instant", "Instant tools", instant, setInstant, markups.instant]] as const).map(([kind, label, value, set, m]) => (
          <div className="admin-row" key={kind}>
            <div><strong>{label}</strong><small>{m.percent}% over cost · {from(m.from)}</small></div>
            <div className="admin-row-control">
              <input className="admin-num" type="number" min={0} max={1000} step="0.1" value={value} onChange={(e) => set(e.target.value)} aria-label={`${label} markup in percent`} />
              <span className="muted">%</span>
              <button className="secondary compact" disabled={busy || value === String(m.percent)} onClick={() => save(kind, value)}>Save</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
function EditPrice({ row, markups, onClose, onSaved }: { row: Data; markups?: Data; onClose: () => void; onSaved: (m: string) => void }) {
  const tool = row.type === "tool";
  const [rule, setRule] = useState<string>(row.rule === "unpriced" ? "fixed" : row.rule);
  const [markup, setMarkup] = useState(String(row.markup_pct ?? (tool ? markups?.instant.percent : markups?.ai.percent) ?? 5));
  const [pin, setPin] = useState(row.price_in === null ? "" : String(row.price_in));
  const [pout, setPout] = useState(row.price_out === null ? "" : String(row.price_out));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body: Data = { type: row.type, id: row.id, rule };
      if (rule === "markup") body.markup_pct = Number(markup);
      if (rule === "fixed") Object.assign(body, { price_in: Number(pin), price_out: row.type === "model" ? Number(pout) : null });
      const after = await api("/admin/pricing", body, "PUT");
      onSaved(`${row.name} now sells at ${unitPrice(after.price_in)}${row.type === "model" ? ` / ${unitPrice(after.price_out)}` : ""}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Price of ${row.name}`} subtitle={`${typeLabel[row.type]} · ${row.unit} · costs ${unitPrice(row.cost_in)}${row.type === "model" ? ` in, ${unitPrice(row.cost_out)} out` : ""}`} onClose={onClose}>
      <form className="form-body" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorRow message={error} />
        <label className="check-row"><input type="radio" name="rule" checked={rule === "default"} onChange={() => setRule("default")} /><span>Default markup<small>{tool ? markups?.instant.percent : markups?.ai.percent}% over {tool ? "the cheapest source" : "the list price"}, and it follows any change to the default.</small></span></label>
        {!tool && <label className="check-row"><input type="radio" name="rule" checked={rule === "markup"} onChange={() => setRule("markup")} /><span>Its own markup<small>A percentage over its list price, just for this item.</small></span></label>}
        {!tool && rule === "markup" && <label className="field admin-indent"><span>Markup, %</span><input type="number" step="0.1" min={-100} max={1000} value={markup} onChange={(e) => setMarkup(e.target.value)} required /></label>}
        <label className="check-row"><input type="radio" name="rule" checked={rule === "fixed"} onChange={() => setRule("fixed")} /><span>Fixed price<small>Stays exactly this, whatever the cost does.</small></span></label>
        {rule === "fixed" && (
          <div className={row.type === "model" ? "form-grid admin-indent" : "admin-indent"}>
            <label className="field"><span>{row.type === "model" ? "Input, USD per 1M tokens" : `USD ${row.unit}`}</span><input type="number" step="any" min={0} value={pin} onChange={(e) => setPin(e.target.value)} required /></label>
            {row.type === "model" && <label className="field"><span>Output, USD per 1M tokens</span><input type="number" step="any" min={0} value={pout} onChange={(e) => setPout(e.target.value)} required /></label>}
          </div>
        )}
        <div className="form-footer">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save price"}</button>
        </div>
      </form>
    </Modal>
  );
}
function UploadCsv({ onClose, onApplied }: { onClose: () => void; onApplied: (m: string) => void }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const send = async (apply: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/pricing/import${apply ? "?apply=1" : ""}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Upload failed");
      if (apply) onApplied(`${d.applied} price${d.applied === 1 ? "" : "s"} changed`);
      else setPreview(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const describeRule = (c: Data) => (c.rule === "default" ? "Default markup" : c.rule === "markup" ? `Markup ${c.markup_pct}%` : `Fixed ${unitPrice(c.price_in)}${c.price_out != null ? ` / ${unitPrice(c.price_out)}` : ""}`);
  const before = (b: Data | null) => (!b ? "—" : b.rule === "markup" ? `Markup ${b.markup_pct}%` : `${b.rule === "fixed" ? "Fixed" : "Default"} ${unitPrice(b.price_in)}${b.price_out != null ? ` / ${unitPrice(b.price_out)}` : ""}`);
  return (
    <Modal title="Upload prices" subtitle="Download the current prices, edit them, and upload the file. Nothing changes until you apply it." onClose={onClose} wide>
      <div className="form-body">
        <ErrorRow message={error} />
        <div className="admin-upload">
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setName(f.name);
            setText(await f.text());
            setPreview(null);
          }} />
          <button className="secondary" onClick={() => input.current?.click()}><Upload size={16} /> {name ? "Choose another file" : "Choose a CSV file"}</button>
          <span className="muted">{name || "Columns: type, id, and price_in / price_out, markup_pct or rule (default)."}</span>
        </div>
        {preview && (
          <>
            {preview.errors.length > 0 && (
              <section className="panel admin-section">
                <div className="section-heading"><h2>Rows to fix</h2><span className="count">{preview.errors.length}</span></div>
                <div className="table-scroll admin-scroll"><table><thead><tr><th>Line</th><th>Problem</th></tr></thead><tbody>{preview.errors.map((e: Data) => <tr key={e.line}><td>{e.line}</td><td className="tone-bad">{e.message}</td></tr>)}</tbody></table></div>
              </section>
            )}
            <section className="panel admin-section">
              <div className="section-heading"><h2>Changes</h2><span className="count">{preview.changes.length} to change · {preview.unchanged} unchanged</span></div>
              {preview.changes.length ? (
                <div className="table-scroll admin-scroll">
                  <table><thead><tr><th>Item</th><th>Now</th><th>After</th></tr></thead>
                    <tbody>{preview.changes.map((c: Data) => <tr key={`${c.type}|${c.id}`}><td><strong>{c.name}</strong><small>{typeLabel[c.type]} · {c.id}</small></td><td className="muted">{before(c.before)}</td><td>{describeRule(c)}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : <Empty icon={Tag} title="Nothing to change">Every row matches the current prices.</Empty>}
            </section>
          </>
        )}
        <div className="form-footer">
          <button className="secondary" onClick={onClose}>Cancel</button>
          {!preview ? (
            <button className="primary" disabled={!text || busy} onClick={() => send(false)}>{busy ? "Checking…" : "Check file"}</button>
          ) : (
            <button className="primary" disabled={busy || preview.errors.length > 0 || !preview.changes.length} onClick={() => send(true)}>{busy ? "Applying…" : `Apply ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"}`}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Providers ────────────────────────────────────────────────────────────────
function ProvidersPage({ subtitle, notify }: { subtitle: string; notify: (m: string) => void }) {
  const { data, error, reload } = useLoad<Data>("/admin/providers");
  const [balanceOf, setBalanceOf] = useState<Data | null>(null);
  const [busy, setBusy] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <Heading title="Providers" subtitle={subtitle}>
        <button className="primary" disabled={!!busy} onClick={() => run("refresh", async () => (await api("/admin/providers/refresh", {}), reload(), notify("Balances re-read")))}><RefreshCw size={16} /> Refresh balances</button>
      </Heading>
      <ErrorRow message={error || err} onClose={err ? () => setErr("") : undefined} />
      <section className="panel">
        <div className="section-heading"><h2>Model providers</h2><span className="count">Last 30 days</span></div>
        {!data ? <Loading /> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Provider</th><th>Balance</th><th>Routes</th><th>Calls</th><th>Cost</th><th>Revenue</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.providers.map((p: Data) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong><small>{p.id} · {p.balance_mode === "api" ? `balance from its API${p.keySet === false ? " (key not set)" : ""}` : p.balance_mode === "manual" ? "balance recorded here" : "postpaid"}</small></td>
                    <td className={p.balance_mode !== "postpaid" && p.balance_micro !== null && p.balance_micro < 5_000_000 ? "tone-bad" : undefined}>{p.balance_mode === "postpaid" ? "Postpaid" : p.balance_micro === null ? "Not recorded" : money(p.balance_micro)}{p.balance_checked_at && <small>{when(p.balance_checked_at)}</small>}</td>
                    <td>{p.enabledRoutes}<small>of {p.routes} on</small></td>
                    <td>{p.calls30.toLocaleString()}</td>
                    <td>{money(p.cost30)}</td>
                    <td>{money(p.charged30)}</td>
                    <td>{p.id !== "orbytlink" && <button className="secondary compact" onClick={() => setBalanceOf(p)}>Set balance</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading"><h2>Model lists</h2><span className="count">Adds new models and refreshes costs; your own changes stay</span></div>
        <div className="admin-rows">
          {([["vercel-decision", "Vercel decision models", "The browser’s decision models (Jev, Decider, Gemini Decision…)."], ["vercel-chat", "Vercel chat models", "Every text model AI Gateway sells."], ["google", "Google AI Studio", "Tries each model with your Google keys and adds the ones that answer."]] as const).map(([target, label, hint]) => (
            <div className="admin-row" key={target}>
              <div><strong>{label}</strong><small>{hint}</small></div>
              <button className="secondary compact" disabled={!!busy} onClick={() => run(target, async () => setLines((await api("/admin/sync", { target })).lines))}>{busy === target ? "Syncing…" : "Sync"}</button>
            </div>
          ))}
        </div>
        {lines.length > 0 && <pre className="code-block admin-lines">{lines.join("\n")}</pre>}
      </section>
      <RoutingInspector notify={notify} />
      {data && data.instant?.length > 0 && (
        <section className="panel">
          <div className="section-heading"><h2>Instant tool sources</h2><span className="count">Never shown to workspaces</span></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Source</th><th>Key</th><th>Wallet</th><th>Status</th></tr></thead>
              <tbody>{data.instant.map((w: Data) => <tr key={w.source}><td><strong>{w.source}</strong></td><td className="muted">{w.configured ? "Set" : "Not set"}</td><td>{w.wallet ? money(w.wallet.micro) : "—"}{w.wallet && <small>{w.wallet.from === "api" ? "from its API" : "recorded"} · {when(w.wallet.checkedAt)}</small>}</td><td className={w.down ? "tone-bad" : "muted"}>{w.down ? "Resting after failures" : w.configured ? "Taking calls" : "Off"}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      {balanceOf && <BalanceModal provider={balanceOf} usdInr={data?.usdInr || 90} onClose={() => setBalanceOf(null)} onSaved={(m) => (setBalanceOf(null), notify(m), reload())} />}
    </>
  );
}
function BalanceModal({ provider: p, usdInr, onClose, onSaved }: { provider: Data; usdInr: number; onClose: () => void; onSaved: (m: string) => void }) {
  const [currency, setCurrency] = useState(p.id === "sarvam" ? "inr" : "usd");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState(p.balance_mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body: Data = { mode };
      if (mode !== "postpaid" && mode !== "api" && amount !== "") body[currency === "inr" ? "balanceInr" : "balanceUsd"] = Number(amount);
      const after = await api(`/admin/providers/${p.id}`, body);
      onSaved(`${p.name}: ${after.balance_mode === "postpaid" ? "postpaid" : after.balance_micro === null ? after.balance_mode : money(after.balance_micro)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`${p.name} balance`} subtitle="Calls only go to a provider with credit left for them. Each call’s cost comes off a recorded balance." onClose={onClose}>
      <form className="form-body" onSubmit={(e) => (e.preventDefault(), void save())}>
        <ErrorRow message={error} />
        <label className="field"><span>How the balance is known</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {p.balance_url && <option value="api">Read from the provider’s API</option>}
            <option value="manual">Recorded here (top-ups)</option>
            <option value="postpaid">Postpaid (billed afterwards, always has credit)</option>
          </select>
        </label>
        {mode === "manual" && (
          <div className="form-grid">
            <label className="field"><span>Current balance</span><input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={p.balance_micro === null ? "Not recorded" : String(p.balance_micro / 1_000_000)} /></label>
            <label className="field"><span>Currency</span><select value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="usd">USD</option><option value="inr">INR (₹{usdInr} = $1)</option></select></label>
          </div>
        )}
        <div className="form-footer">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}
function RoutingInspector({ notify }: { notify: (m: string) => void }) {
  const [item, setItem] = useState("");
  const [shown, setShown] = useState("");
  const { data, error, reload } = useLoad<Data>(shown ? `/admin/routing?item=${encodeURIComponent(shown)}` : null);
  const flag = async (source: string, change: Data) => {
    await api("/admin/routes", { item: shown, source, ...change }, "PUT");
    notify(change.priority !== undefined ? (change.priority ? `${source} is pinned for this model` : `${source} unpinned`) : change.enabled ? `${source} route on` : `${source} route off`);
    reload();
  };
  return (
    <section className="panel">
      <div className="section-heading"><h2>Routing</h2><span className="count">Credit, then manual, cost, speed, reliability</span></div>
      <form className="admin-route-search" onSubmit={(e) => (e.preventDefault(), setShown(item.trim()))}>
        <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Model id, e.g. google/gemini-3.5-flash" aria-label="Model id" />
        <button className="secondary compact">Show</button>
      </form>
      {shown && error && <ErrorRow message={error} />}
      {data && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>#</th><th>Provider</th><th>Cost of a typical call</th><th>Speed</th><th>Reliability</th><th>Credit</th><th>Pinned</th><th><span className="sr-only">On or off</span></th></tr></thead>
            <tbody>
              {data.ranked.map((c: Data, n: number) => (
                <tr key={c.source}>
                  <td>{n + 1}</td>
                  <td><strong>{c.source}</strong><small><code>{c.ref}</code></small></td>
                  <td>{money(c.expectedMicro)}</td>
                  <td>{c.latencyMs === null ? "Not measured" : `${c.latencyMs} ms`}</td>
                  <td>{Math.round(c.reliability * 100)}%</td>
                  <td>{c.balanceMicro === null ? "Postpaid" : money(c.balanceMicro)}</td>
                  <td><button className="secondary compact" onClick={() => flag(c.source, { priority: c.priority ? 0 : 1 })}>{c.priority ? "Unpin" : "Pin"}</button></td>
                  <td><button className="text-button" onClick={() => flag(c.source, { enabled: false })}>Turn off</button></td>
                </tr>
              ))}
              {data.excluded.map((c: Data) => (
                <tr key={c.source} className="muted-row">
                  <td>—</td>
                  <td><strong>{c.source}</strong><small><code>{c.ref}</code></small></td>
                  <td colSpan={5} className="muted">Not used: {c.excluded}</td>
                  <td>{!c.enabled && <button className="text-button" onClick={() => flag(c.source, { enabled: true })}>Turn on</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted admin-note">{data.item.name}: sold at {unitPrice(data.price.input)} / {unitPrice(data.price.output)} ({data.price.rule}). A typical call: {Math.round(data.typical.inTokens)} tokens in, {Math.round(data.typical.outTokens)} out.</p>
        </div>
      )}
    </section>
  );
}

// ── Workspaces ───────────────────────────────────────────────────────────────
function WorkspacesPage({ subtitle, notify }: { subtitle: string; notify: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, reload } = useLoad<Data>(`/admin/workspaces?q=${encodeURIComponent(query)}`);
  const [credit, setCredit] = useState<Data | null>(null);
  return (
    <>
      <Heading title="Workspaces" subtitle={subtitle} />
      <ErrorRow message={error} />
      <Toolbar search={q} setSearch={setQ} placeholder="Search by name or email…" count={data ? `${data.workspaces.length} workspaces` : ""} />
      <section className="panel">
        {!data ? <Loading /> : data.workspaces.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Workspace</th><th>Credit</th><th>This month</th><th>Last 30 days</th><th>Margin</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.workspaces.map((w: Data) => (
                  <tr key={w.workspace}>
                    <td><strong>{w.name}</strong><small>{w.type === "organization" ? "Organization" : w.owner}{w.disabled ? " · disabled" : ""}</small></td>
                    <td>{money(w.balance)}</td>
                    <td>{money(w.monthSpent)}</td>
                    <td>{money(w.charged30)}<small>{w.calls30.toLocaleString()} calls</small></td>
                    <td className={w.charged30 - w.cost30 < 0 ? "tone-bad" : undefined}>{money(w.charged30 - w.cost30)}</td>
                    <td><button className="secondary compact" onClick={() => setCredit(w)}>Add credit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={Building} title="No workspaces match">Try another name or email.</Empty>}
      </section>
      {credit && <CreditModal workspace={credit} onClose={() => setCredit(null)} onSaved={(m) => (setCredit(null), notify(m), reload())} />}
    </>
  );
}
function CreditModal({ workspace: w, onClose, onSaved }: { workspace: Data; onClose: () => void; onSaved: (m: string) => void }) {
  const [usd, setUsd] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Credit for ${w.name}`} subtitle={`Balance ${money(w.balance)}. Use a negative amount to take credit away.`} onClose={onClose}>
      <form className="form-body" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const s = await api(`/admin/workspaces/${encodeURIComponent(w.workspace)}/credits`, { usd: Number(usd), note });
          onSaved(`${w.name}: balance ${money(s.balance)}`);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}>
        <ErrorRow message={error} />
        <label className="field"><span>Amount, USD</span><input type="number" step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} required autoFocus /></label>
        <label className="field"><span>Note</span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why, for the change log" /></label>
        <div className="form-footer">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !usd}>{busy ? "Saving…" : Number(usd) < 0 ? "Remove credit" : "Add credit"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Calls and change log ─────────────────────────────────────────────────────
function CallsPage({ subtitle }: { subtitle: string }) {
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error } = useLoad<Data>(`/admin/calls?status=${status}&kind=${kind}&q=${encodeURIComponent(query)}&limit=200`);
  return (
    <>
      <Heading title="Calls" subtitle={subtitle} />
      <ErrorRow message={error} />
      <Toolbar
        search={q}
        setSearch={setQ}
        placeholder="Search by item or workspace…"
        count={data ? `${data.calls.length} latest` : ""}
        control={
          <>
            <Select label="Status" value={status} onChange={setStatus}><option value="">All results</option><option value="ok">Succeeded</option><option value="failed">Failed</option></Select>
            <Select label="Kind" value={kind} onChange={setKind}><option value="">All kinds</option><option value="chat">AI models</option><option value="decision">Decision models</option><option value="service">Services</option><option value="instant">Instant tools</option></Select>
          </>
        }
      />
      <section className="panel">
        {!data ? <Loading /> : data.calls.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Item</th><th>Provider</th><th>Units</th><th>Cost</th><th>Charged</th><th>Time</th></tr></thead>
              <tbody>
                {data.calls.map((c: Data) => (
                  <tr key={c.id} className={c.status === "failed" ? "muted-row" : undefined}>
                    <td className="muted">{when(c.at)}<small>{c.via}</small></td>
                    <td><strong>{c.item_name || c.item_id}</strong><small>{c.status === "failed" ? <span className="tone-bad">Failed{c.note ? `: ${c.note}` : ""}</span> : c.workspace.slice(0, 8)}</small></td>
                    <td>{c.source || "—"}{c.route_ref && <small><code>{c.route_ref}</code></small>}</td>
                    <td>{c.units_in ? Number(c.units_in).toLocaleString() : "—"}{c.units_out ? <small>{Number(c.units_out).toLocaleString()} out</small> : null}</td>
                    <td>{money(c.cost_micro)}{c.cost_basis && <small>{c.cost_basis}</small>}</td>
                    <td>{money(c.charged_micro)}</td>
                    <td className="muted">{c.latency_ms ? `${c.latency_ms} ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={Activity} title="No calls match">Paid calls appear here as they happen.</Empty>}
      </section>
    </>
  );
}
function LogPage({ subtitle }: { subtitle: string }) {
  const { data, error } = useLoad<Data>("/admin/audit");
  const detail = (d: string | null) => {
    if (!d) return "";
    try {
      const v = JSON.parse(d);
      if (Array.isArray(v)) return v.length && typeof v[0] === "string" ? v.join(" · ").slice(0, 300) : `${v.length} rows`;
      if (v.before !== undefined && v.after !== undefined) return `${short(v.before)} → ${short(v.after)}`;
      return short(v);
    } catch {
      return d.slice(0, 200);
    }
  };
  return (
    <>
      <Heading title="Change log" subtitle={subtitle} />
      <ErrorRow message={error} />
      <section className="panel">
        {!data ? <Loading /> : data.entries.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Change</th><th>Details</th></tr></thead>
              <tbody>{data.entries.map((e: Data) => <tr key={e.id}><td className="muted">{when(e.at)}</td><td>{e.operator}</td><td><strong>{e.action}</strong><small>{e.target}</small></td><td className="muted admin-detail">{detail(e.detail)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <Empty icon={ScrollText} title="No changes yet">Price, balance and credit changes made here are listed with who made them.</Empty>}
      </section>
    </>
  );
}
const short = (v: any): string =>
  v === null || v === undefined
    ? "—"
    : typeof v !== "object"
      ? String(v)
      : Object.entries(v)
          .filter(([, x]) => x !== null && x !== undefined)
          .map(([k, x]) => `${k} ${typeof x === "object" ? JSON.stringify(x) : x}`)
          .join(", ");
