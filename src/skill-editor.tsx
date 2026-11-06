// Writing or uploading a skill, and choosing who can use it: only me, specific people and
// organizations, or everyone. The server checks every rule again; this form only guides.
import { useEffect, useState } from "react";
import { LoaderCircle, Trash2 } from "./icons";

type Data = Record<string, any>;
type Call = (path: string, body?: unknown, method?: string) => Promise<any>;
// SKILL.md front matter, enough to prefill the form from an uploaded file.
function frontMatter(md: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const meta: Record<string, string> = {};
  if (m)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  return meta;
}
const readText = (f: File) => f.text();

export function SkillEditor({ id, orgs, call, onSaved, onCancel }: { id?: string; orgs: { id: string; name: string }[]; call: Call; onSaved: (s: Data) => void; onCancel: () => void }) {
  const [loading, setLoading] = useState(!!id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [visibility, setVisibility] = useState<"private" | "shared" | "public">("private");
  const [people, setPeople] = useState("");
  const [shareOrgs, setShareOrgs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    call(`/skills/authored/${id}`).then((s) => {
      setName(s.name);
      setDescription(s.description);
      setBody(s.body);
      setFiles(s.files || []);
      setVisibility(s.visibility);
      setPeople((s.share?.people || []).join(", "));
      setShareOrgs(s.share?.orgs || []);
      setLoading(false);
    }, (e) => setError(e.message));
  }, [id, call]);
  if (loading) return <div className="form-body">{error ? <div className="error">{error}</div> : <LoaderCircle className="spin" size={18} />}</div>;
  return (
    <form
      className="form-body skill-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const payload = {
            name,
            description,
            body,
            files,
            visibility,
            share: { people: people.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean), orgs: shareOrgs },
          };
          onSaved(await call(id ? `/skills/authored/${id}` : "/skills/authored", payload, id ? "PUT" : "POST"));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>Upload a SKILL.md</span>
        <input
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const text = await readText(f);
            const meta = frontMatter(text);
            setBody(text);
            if (meta.name) setName(meta.name);
            if (meta.description) setDescription(meta.description);
          }}
        />
        <small>Optional. Its name and description fill in below; or write the skill yourself.</small>
      </label>
      <div className="form-grid">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Proposal playbook" /></label>
        <label className="field"><span>When to use it</span><input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={10} maxLength={1000} placeholder="e.g. Use when writing a sales proposal" /><small>Agents read this to decide when the skill fits.</small></label>
      </div>
      <label className="field">
        <span>Instructions</span>
        <textarea className="skill-body" value={body} onChange={(e) => setBody(e.target.value)} required minLength={20} placeholder={"# Proposal playbook\n\nOpen with the customer's goal…"} />
        <small>Markdown. No scripts: skills are instructions only.</small>
      </label>
      <div className="field">
        <span>Reference files</span>
        {files.map((f, i) => (
          <div className="skill-file" key={f.path}>
            <code>{f.path}</code>
            <small className="muted">{(f.content.length / 1024).toFixed(1)} KB</small>
            <button type="button" className="icon-button" aria-label={`Remove ${f.path}`} onClick={() => setFiles(files.filter((_, n) => n !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <input
          type="file"
          multiple
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onChange={async (e) => {
            const picked = [...(e.target.files || [])];
            const added = await Promise.all(picked.map(async (f) => ({ path: `references/${f.name.replace(/[^A-Za-z0-9_.-]/g, "-")}`, content: await readText(f) })));
            setFiles([...files.filter((f) => !added.some((a) => a.path === f.path)), ...added].slice(0, 30));
            e.target.value = "";
          }}
        />
        <small>Optional Markdown files the skill refers to, such as examples or a style guide.</small>
      </div>
      <fieldset className="field skill-visibility">
        <span>Who can use it</span>
        {(
          [
            ["private", "Only me", "Your agents can use it. Nobody else sees it."],
            ["shared", "People and organizations I choose", "Shared with specific people, or everyone in an organization you belong to."],
            ["public", "Everyone on OrbytLink", "Listed in the shared library for all users."],
          ] as const
        ).map(([value, label, hint]) => (
          <label className="check-row" key={value}>
            <input type="radio" name="visibility" checked={visibility === value} onChange={() => setVisibility(value)} />
            <span>{label}<small>{hint}</small></span>
          </label>
        ))}
      </fieldset>
      {visibility === "shared" && (
        <div className="skill-share">
          <label className="field">
            <span>People</span>
            <textarea value={people} onChange={(e) => setPeople(e.target.value)} placeholder="name@company.com, other@company.com" rows={2} />
            <small>Their email addresses. They see it once they sign in with that email.</small>
          </label>
          {orgs.length > 0 && (
            <div className="field">
              <span>Organizations</span>
              {orgs.map((o) => (
                <label className="check-row" key={o.id}>
                  <input type="checkbox" checked={shareOrgs.includes(o.id)} onChange={(e) => setShareOrgs(e.target.checked ? [...shareOrgs, o.id] : shareOrgs.filter((x) => x !== o.id))} />
                  <span>Everyone in {o.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="form-footer">
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : null} {id ? "Save skill" : "Create skill"}</button>
      </div>
    </form>
  );
}
