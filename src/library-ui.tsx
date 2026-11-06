// The shared skill library in the console: search it (on the server, a page at a time), add
// skills from skills.sh to it, and turn library skills on for this workspace.
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, Search } from "./icons";

type Data = Record<string, any>;
type Call = (path: string, body?: unknown, method?: string) => Promise<any>;
const count = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

export function LibraryView({ call, canConfigure, onOpen, onChanged, notify }: { call: Call; canConfigure: boolean; onOpen: (skill: Data) => void; onChanged: () => void; notify: (message: string) => void }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "mine" | "shared" | "public">("all");
  const [items, setItems] = useState<Data[]>([]);
  const [total, setTotal] = useState(0);
  const [all, setAll] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [registry, setRegistry] = useState<Data | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const latest = useRef(0);
  // Searches run on the server as you type, a quarter second after the last key.
  const load = async (query: string, p: number) => {
    const n = ++latest.current;
    setLoading(true);
    try {
      const d = await call(`/library?q=${encodeURIComponent(query)}&page=${p}&scope=${scope}`);
      if (n !== latest.current) return;
      setItems((prev) => (p ? [...prev, ...d.items] : d.items));
      setTotal(d.total);
      setAll(d.all);
      setPage(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (n === latest.current) setLoading(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => {
      void load(q, 0);
      setRegistry(null);
      if (q.trim().length >= 2) call(`/library/registry?q=${encodeURIComponent(q.trim())}`).then(setRegistry, () => setRegistry({ items: [], error: "skills.sh could not be searched right now." }));
    }, 250);
    return () => clearTimeout(t);
  }, [q, scope]);
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      notify(done);
      onChanged();
      await load(q, 0);
      if (q.trim().length >= 2) setRegistry(await call(`/library/registry?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-search-controls">
          <div className="search-box library-search"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library and skills.sh…" aria-label="Search the skill library" /></div>
        </div>
        <span className="toolbar-count">{q ? `${total.toLocaleString("en-US")} of ${all.toLocaleString("en-US")}` : `${all.toLocaleString("en-US")} ${all === 1 ? "skill" : "skills"}`} you can use</span>
      </div>
      <div className="catalog-filters" role="radiogroup" aria-label="Show">
        {([["all", "All"], ["mine", "Created by me"], ["shared", "Shared with me"], ["public", "Public"]] as const).map(([v, label]) => (
          <button type="button" role="radio" aria-checked={scope === v} className={scope === v ? "active" : ""} key={v} onClick={() => setScope(v)}>{label}</button>
        ))}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <section className="panel">
        <div className="section-heading"><h2>Library</h2><span className="count">{({ all: "Every skill you can use", mine: "Skills you wrote", shared: "Shared with you by others", public: "Public to everyone on OrbytLink" } as Record<string, string>)[scope]}</span></div>
        {items.length ? (
          <div className="skill-list">
            {items.map((k) => (
              <div className={`skill-row lib ${k.enabled ? "on" : ""}`} key={k.id}>
                <div className="skill-main">
                  <button type="button" className="skill-name" onClick={() => onOpen(k)}>{k.title}</button>
                  <span className="skill-meta">
                    {k.origin === "authored" && <span className="tag">{k.visibility === "private" ? "Only you" : k.visibility === "shared" ? (k.mine ? "Shared by you" : `Shared by ${k.owner}`) : k.mine ? "Public · yours" : `Public · by ${k.owner}`}</span>}{" "}
                    <code>{k.id}</code>{k.origin === "authored" ? "" : ` · ${k.source.repo} · ${k.source.license}`}{k.installs ? ` · ${k.installs} installs` : ""}{k.library?.uses ? ` · used ${count(k.library.uses)} times` : ""}
                  </span>
                  <p>{k.description}</p>
                </div>
                {k.enabled ? (
                  <span className="library-on">On here</span>
                ) : canConfigure ? (
                  <button className="secondary compact" disabled={!!busy} onClick={() => act(k.id, () => call(`/skills/${k.id}`, { enabled: true }, "PUT"), `${k.title} is on for your agents`)}>
                    {busy === k.id ? <LoaderCircle size={13} className="spin" /> : null} Turn on
                  </button>
                ) : (
                  <span className="muted library-on">Agents can load it</span>
                )}
              </div>
            ))}
          </div>
        ) : loading ? (
          <p className="muted library-loading"><LoaderCircle size={15} className="spin" /> Searching…</p>
        ) : (
          <p className="muted library-empty">{q ? "No library skill matches. Add one from skills.sh below." : "The library is empty. Search skills.sh above to add the first skill."}</p>
        )}
        {items.length < total && (
          <div className="library-more"><button className="secondary compact" disabled={loading} onClick={() => load(q, page + 1)}>{loading ? "Loading…" : `Show more (${(total - items.length).toLocaleString("en-US")} left)`}</button></div>
        )}
      </section>
      {registry && (
        <section className="panel">
          <div className="section-heading"><h2>From skills.sh</h2><span className="count">Added to the library for everyone</span></div>
          {registry.error ? (
            <p className="muted library-empty">{registry.error}</p>
          ) : registry.items.length ? (
            <div className="skill-list">
              {registry.items.map((r: Data) => (
                <div className="skill-row lib" key={r.skill}>
                  <div className="skill-main">
                    <a className="skill-name" href={r.page} target="_blank" rel="noopener noreferrer">{r.name} <ArrowUpRight size={12} /></a>
                    <span className="skill-meta"><code>{r.skill}</code> · {count(r.installs)} installs</span>
                  </div>
                  <button
                    className="secondary compact"
                    disabled={!!busy || !r.canAdd}
                    title={r.canAdd ? undefined : `Only skills with at least ${count(registry.minInstalls)} installs can be added`}
                    onClick={() => act(r.skill, () => call("/library", { skill: r.skill, enable: canConfigure }), canConfigure ? `${r.name} is in the library and on for your agents` : `${r.name} is in the library`)}
                  >
                    {busy === r.skill ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />} {r.canAdd ? "Add to library" : "Too few installs"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted library-empty">Nothing new on skills.sh for “{q}”.</p>
          )}
        </section>
      )}
      <p className="footnote">
        The library holds skills people wrote, shared with you or with everyone, and public skills from skills.sh with at least 1,000 installs and an open licence, pinned to the version that was added. All are Markdown only, never scripts. Your agents can load any skill you can see on request; {canConfigure ? "turning one on" : "an admin turning one on"} gives it to every agent in this workspace automatically, but only to people allowed to see it.
      </p>
    </>
  );
}
