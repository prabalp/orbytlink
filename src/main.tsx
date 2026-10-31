import React, {
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  CircleHelp,
  Code2,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  BookOpen,
  Folder,
  KeyRound,
  LayoutGrid,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Moon,
  Play,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
  Users,
  Workflow,
  UserRound,
  X,
  Zap,
} from "./icons";
import { catalog, segments, type Preset } from "./catalog";
import { brands, monograms } from "./brand-icons";
import { agents } from "./agents";
import { workflowTemplates, type WorkflowTemplate } from "./workflow-templates";
import { apiCategories, apiPresets, type ApiPreset } from "./api-presets";
import "./styles.css";
type Data = Record<string, any>;
const nav = [
  ["Connections", Link2],
  ["Catalog", LayoutGrid],
  ["APIs", Code2],
  ["Skills", BookOpen],
  ["Workflows", Workflow],
  ["Connect agents", Zap],
  ["Team", Users],
  ["Activity", Activity],
  ["Settings", Settings2],
] as const;
const slug = (s: string) => s.toLowerCase().replace(/ /g, "-");
const mcpUrl = () => `${location.origin}/mcp`;
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function forgetInvite() {
  try {
    sessionStorage.removeItem("orbytlink:invite");
  } catch {
    // Nothing stored, nothing to forget.
  }
}
const when = (s?: string | number) =>
  s
    ? new Date(s).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";
function Status({ value }: { value: string }) {
  return (
    <span
      className={`status ${["Connected", "Verified", "succeeded", "approved", "Enabled"].includes(value) ? "good" : ["Error", "failed", "rejected"].includes(value) ? "bad" : ["waiting-for-approval", "pending", "Authorization needed", "Draft"].includes(value) ? "pending" : ""}`}
    >
      <i />
      {value.replaceAll("-", " ")}
    </span>
  );
}
function Empty({
  icon: Icon = Folder,
  title,
  children,
  action,
}: {
  icon?: any;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={23} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const container = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary",
        ) || [],
      );
    focusable()[0]?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", fn);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", fn);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function App() {
  const [state, setState] = useState<Data | null>(null),
    [auth, setAuth] = useState(false),
    [page, setPage] = useState(location.hash.slice(1) || "connections"),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [expanded, setExpanded] = useState(() => {
      try {
        return localStorage.getItem("orbytlink:sidebar") !== "collapsed";
      } catch {
        return true;
      }
    }),
    [dialog, setDialog] = useState<{ type: string; data?: Data } | null>(null),
    [search, setSearch] = useState(""),
    // The token just created, kept in memory only so the setup snippets can include it.
    [freshToken, setFreshToken] = useState<Data | null>(null);
  const refresh = async () => {
    try {
      // Defaults keep the console usable against an older server that lacks newer fields.
      setState({ skills: [], workflows: [], workflowRuns: [], apis: [], apiCalls: [], workspaces: [], tokens: [], gatewayTools: [], org: null, ...(await api("/state")) });
      setAuth(false);
    } catch (e) {
      if ((e as Error).message === "Authentication required") setAuth(true);
      else setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    const route = () => {
      setPage(location.hash.slice(1) || "connections");
      setMobile(false);
      setSearch("");
    };
    window.addEventListener("hashchange", route);
    return () => {
      clearInterval(t);
      window.removeEventListener("hashchange", route);
    };
  }, []);
  // A theme picked in this browser (v0's "color-theme" key) wins over the workspace default.
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem("color-theme");
    } catch {
      return null;
    }
  });
  const appearance = theme ?? state?.settings?.[0]?.appearance ?? "dark";
  const changeTheme = (value: string) => {
    setTheme(value);
    try {
      localStorage.setItem("color-theme", value);
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit.
    }
  };
  const dark = (value: string) =>
    value === "dark" ||
    (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    document.title = `${state?.settings?.[0]?.name || "OrbytLink"} · Gateway`;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = dark(appearance) ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance, state?.settings?.[0]?.name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        changeTheme(dark(appearance) ? "light" : "dark");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [appearance]);
  // An invite link is kept across sign-in (and Google's redirect) until the person answers it.
  const joinChecked = useRef(false);
  useEffect(() => {
    const m = location.hash.match(/^#invite=(oi_[A-Za-z0-9_-]+)$/);
    if (!m) return;
    try {
      sessionStorage.setItem("orbytlink:invite", m[1]);
    } catch {
      // Without storage the link still works if the person is already signed in.
    }
    history.replaceState(null, "", "#team");
    setPage("team");
  }, []);
  useEffect(() => {
    if (!state || joinChecked.current) return;
    let token: string | null = null;
    try {
      token = sessionStorage.getItem("orbytlink:invite");
    } catch {
      return;
    }
    if (!token) return;
    joinChecked.current = true;
    api("/invites/preview", { token }).then(
      (d) => setDialog({ type: "join", data: { token, ...d } }),
      (e) => {
        forgetInvite();
        setError((e as Error).message);
      },
    );
  }, [state]);
  // Back from an app's sign-in page: test the new connection, or explain what went wrong.
  const oauthHandled = useRef(false);
  useEffect(() => {
    if (!state || oauthHandled.current) return;
    const done = location.hash.match(/^#oauth-connected=([A-Za-z0-9-]+)$/);
    const failed = location.hash.match(/^#oauth-error=([a-z-]+)$/);
    if (!done && !failed) return;
    oauthHandled.current = true;
    history.replaceState(null, "", "#connections");
    setPage("connections");
    if (failed) {
      setError(oauthErrors[failed[1]] || oauthErrors["oauth-failed"]);
      return;
    }
    api(`/connections/${done![1]}/test`, {}).then(
      (c) => {
        setToast(c.status === "Connected" ? `Connected. ${c.tools.length} tools discovered.` : "Signed in, but the connection test failed. Check it below.");
        void refresh();
      },
      (e) => setError((e as Error).message),
    );
  }, [state]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const act = async (
    fn: () => Promise<unknown>,
    success = "Saved",
    close = true,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      if (close) setDialog(null);
      setToast((result as { toast?: string } | undefined)?.toast || success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Send the person to the app's own sign-in page; the callback brings them back here.
  const connectOAuth = (id: string) =>
    act(
      async () => {
        const { url } = await api(`/connections/${id}/oauth/start`, {});
        location.href = url;
      },
      "Redirecting to sign in…",
      false,
    );
  const copy = (text: string, label: string) =>
    void navigator.clipboard.writeText(text).then(() => setToast(`${label} copied`));
  if (auth)
    return (
      <EmailLogin
        busy={busy}
        error={error}
        onSubmit={(data, register) =>
          act(
            () => api(register ? "/auth/register" : "/auth/login", data),
            register ? "Your gateway is ready" : "Signed in",
          )
        }
        clearError={() => setError("")}
        dark={dark(appearance)}
        onToggleTheme={() => changeTheme(dark(appearance) ? "light" : "dark")}
      />
    );
  if (!state)
    return (
      <div className="loading">
        <LoaderCircle className="spin" /> Loading gateway…
        {error && <p>{error}</p>}
      </div>
    );
  const s = state,
    settings = s.settings[0],
    // Old links to #connect-claude still land on the renamed page.
    title = nav.find(([n]) => slug(n) === (page === "connect-claude" ? "connect-agents" : page))?.[0] || "Connections",
    filtered = s.connections.filter((c: Data) =>
      `${c.name} ${c.description || ""} ${c.endpoint || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    exposed = (c: Data) =>
      s.gatewayTools.filter((t: Data) => t.connectionId === c.id).length;
  const canConfigure = s.identity.permissions.includes("configure");
  const isAdmin = s.identity.role === "admin";
  const close = () => {
    if (dialog?.type === "join") forgetInvite();
    setDialog(null);
    setError("");
  };
  // On small screens the sidebar is an overlay and always shows labels.
  const open = expanded || mobile;
  const toggleExpanded = (value: boolean) => {
    setExpanded(value);
    try {
      localStorage.setItem("orbytlink:sidebar", value ? "expanded" : "collapsed");
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit.
    }
  };
  const initial = (s.identity.displayName || s.identity.user).slice(0, 1).toUpperCase();
  return (
    <div className={`app-shell ${open ? "" : "sidebar-collapsed"}`}>
      {mobile && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? "open" : ""}`} aria-label="Control panel">
        <div className="sidebar-top">
          {open ? (
            <>
              <a className="brand" href="#connections"><OrbitLogo /><span>{settings.name}</span></a>
              <button className="rail-button collapse-button" title="Collapse sidebar" aria-label="Collapse sidebar" aria-expanded="true" onClick={() => (mobile ? setMobile(false) : toggleExpanded(false))}><PanelLeft size={18} /></button>
            </>
          ) : (
            <button className="rail-button logo-button" title="Open sidebar" aria-label="Open sidebar" aria-expanded="false" onClick={() => toggleExpanded(true)}><OrbitLogo /></button>
          )}
        </div>
        <nav aria-label="Gateway navigation">
          {nav.map(([name, Icon]) => (
            <a href={`#${slug(name)}`} key={name} className={title === name ? "active" : ""} aria-current={title === name ? "page" : undefined} title={open ? undefined : name} aria-label={open ? undefined : name}>
              <Icon size={16} />
              {open && <span>{name}</span>}
            </a>
          ))}
        </nav>
        {open && (
          <div className="gateway-summary">
            <span className="sidebar-label">Workspace</span>
            <button className="secondary compact workspace-switch" title="Switch workspace" onClick={() => setDialog({ type: "workspaces" })}><Users size={16} /><span>{s.identity.workspaceName}</span></button>
            <button className="secondary compact" onClick={() => copy(mcpUrl(), "MCP URL")}><Copy size={16} /> Copy MCP URL</button>
          </div>
        )}
        <div className="sidebar-bottom">
          <button className="sidebar-help" title={open ? undefined : "How the gateway works"} aria-label="How the gateway works" onClick={() => setDialog({ type: "help" })}><CircleHelp size={16} />{open && <> How the gateway works <ArrowUpRight size={14} /></>}</button>
          <button className="account-button" title={open ? undefined : "Account"} aria-label="Account" onClick={() => setDialog({ type: "session" })}><span className="avatar">{initial}</span>{open && <><span><strong>{s.identity.displayName || s.identity.user}</strong><small>{s.identity.email || s.identity.workspaceName}</small></span><Ellipsis size={18} /></>}</button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div><button className="icon-button mobile-menu" onClick={() => setMobile(!mobile)} aria-label="Toggle navigation"><Menu size={20} /></button><span className="topbar-title">{title}</span></div>
        </header>
        <main className="workspace-main">
          {/* Connect agents opens with its own centred introduction instead of the page heading. */}
          {title !== "Connect agents" && (
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p>
                {({
                  Connections: "Connect MCP servers and APIs once. Claude reaches all of them through one endpoint.",
                  Catalog: "Ready-made connections for popular apps. Pick one, sign in, and its tools appear in Claude.",
                  APIs: "Keys and docs for the APIs you build on, kept in the vault. OrbytLink calls them from its server, so agents never see a key.",
                  Skills: "Proven instructions your agents load when a task calls for them. Turn one on and every connected agent can use it.",
                  Workflows: "Fixed sequences of tool calls across your apps. Run them here, or let agents call each one as a single tool.",
                  "Connect agents": "Connect Claude, Codex, Cursor and any other MCP client to every app in this gateway.",
                  Team: s.org ? `Members of ${s.org.name}, and who can change what.` : "Share this gateway with teammates by creating an organization.",
                  Activity: "Every tool call and configuration change in this gateway.",
                  Settings: "Your workspace, account and gateway preferences.",
                } as Data)[title]}
              </p>
            </div>
            <div className="heading-actions">
              {title === "Connections" && canConfigure && <button className="primary" onClick={() => setDialog({ type: "connection" })}><Plus size={16} /> Add connection</button>}
              {title === "APIs" && canConfigure && <button className="primary" onClick={() => setDialog({ type: "api" })}><Plus size={16} /> Add API</button>}
              {title === "Workflows" && canConfigure && <button className="primary" onClick={() => setDialog({ type: "workflow", data: { draft: blankWorkflow() } })}><Plus size={16} /> New workflow</button>}
              {title === "Team" && s.org && isAdmin && <button className="primary" onClick={() => setDialog({ type: "invite" })}><Plus size={16} /> Invite member</button>}
              
            </div>
          </div>
          )}
          {error && !dialog && (
            <div className="error" role="alert">
              {error}
              <button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}
          {title === "Connections" && (
            <>
              <Toolbar search={search} setSearch={setSearch} placeholder="Search connections…" count={`${s.connections.length} connections`} />
              <section className="panel">
                {filtered.length > 0 && <div className="table-scroll">
                  <table>
                    <thead><tr><th>Connection</th><th>Endpoint</th><th>Status</th><th>Tools in Claude</th><th>Actions</th></tr></thead>
                    <tbody>
                      {filtered.map((c: Data) => (
                        <tr key={c.id}>
                          <td><div className="table-name"><AppLogo preset={presetFor(c)} kind={c.protocol || c.kind} /><div><strong>{c.name}</strong><small>{connectorType(c)}</small></div></div></td>
                          <td><span className="endpoint">{c.endpoint || "Endpoint not configured"}</span><small>{c.hasSecret ? "Credential stored · encrypted" : c.auth === "none" ? "No authentication" : "Credential missing"}</small></td>
                          <td><Status value={!c.enabled ? "Disabled" : c.auth === "oauth" && !c.oauthState?.connected && c.status !== "Error" ? "Authorization needed" : c.status} /><small className="muted">{when(c.lastChecked)}</small></td>
                          <td>{c.tools.length ? (canConfigure ? <button className="text-button" onClick={() => setDialog({ type: "tools", data: c })}>{exposed(c)} of {c.tools.length} on</button> : <span>{exposed(c)} of {c.tools.length} on</span>) : <span className="muted">{canConfigure ? "Test to discover" : "Not tested"}</span>}</td>
                          <td>
                            {canConfigure ? <div className="row-actions">
                              {c.auth === "oauth" && !c.oauthState?.connected
                                ? <button className="secondary compact" disabled={busy || !c.enabled} onClick={() => void connectOAuth(c.id)}>Connect</button>
                                : <button className="secondary compact" disabled={busy || !c.enabled} onClick={() => act(() => api(`/connections/${c.id}/test`, {}), "Connection test complete", false)}>Test</button>}
                              <button className="text-button" onClick={() => setDialog({ type: "connection", data: c })}>Configure</button>
                              <button className="icon-button" aria-label={`Remove ${c.name}`} onClick={() => setDialog({ type: "delete", data: c })}><Trash2 size={15} /></button>
                            </div> : <span className="muted">Admins only</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
                {!filtered.length && (
                  <Empty icon={Link2} title={search ? "No connections found" : canConfigure ? "Connect your first app" : "Nothing connected yet"} action={!search && canConfigure && <button className="primary" onClick={() => setDialog({ type: "connection" })}><Plus size={16} /> Add connection</button>}>
                    {canConfigure ? "Add any MCP server or HTTP API. Once it passes a live test, its tools appear in Claude." : "An admin of this organization has not connected any apps yet."}
                  </Empty>
                )}
              </section>
              <div className="info-row">
                <LockKeyhole size={17} />
                <p>
                  Credentials are encrypted with AES-256-GCM on the server, bound to this
                  workspace and connection, and never returned to the browser or to Claude.
                  Only connections that pass a live test are exposed, and any change takes
                  them offline until they are tested again.
                </p>
              </div>
            </>
          )}
          {title === "Connect agents" && (
            <AgentsPage
              state={s}
              busy={busy}
              copy={copy}
              freshToken={freshToken}
              onQuickCreate={(name: string) =>
                act(async () => setFreshToken(await api("/tokens", { name, expiresInDays: 90 })), "Token ready. It’s in every step below.", false)
              }
              onCreate={() => setDialog({ type: "new-token" })} onRevoke={(t: Data) => setDialog({ type: "revoke", data: t })} />
          )}
          {title === "Catalog" && (
            <CatalogPage state={s} canConfigure={canConfigure} search={search} setSearch={setSearch} onConnect={(p: Preset) => setDialog({ type: "connection", data: presetDraft(p) })} />
          )}
          {title === "APIs" && (
            <ApisPage state={s} busy={busy} canConfigure={canConfigure} onOpen={(a: Data) => setDialog({ type: "api-detail", data: a })} onPreset={(p: ApiPreset) => setDialog({ type: "api", data: presetApiDraft(p) })} onToggle={(a: Data, enabled: boolean) => act(() => api(`/apis/${a.id}`, { ...apiPayload(a), enabled }, "PUT"), enabled ? `${a.name} is on` : `${a.name} is off`, false)} />
          )}
          {title === "Skills" && (
            <SkillsPage state={s} busy={busy} canConfigure={canConfigure} search={search} setSearch={setSearch} onOpen={(skill: Data) => setDialog({ type: "skill", data: skill })} onToggle={(skill: Data, enabled: boolean) => act(() => api(`/skills/${skill.id}`, { enabled }, "PUT"), enabled ? `${skill.title} is on for your agents` : `${skill.title} is off`, false)} />
          )}
          {title === "Workflows" && (
            <WorkflowsPage
              state={s}
              busy={busy}
              canConfigure={canConfigure}
              onEdit={(wf: Data) => setDialog({ type: "workflow", data: { id: wf.id, draft: wf } })}
              onTemplate={(t: WorkflowTemplate) => setDialog({ type: "workflow", data: { draft: bindTemplate(t, toolIndex(s)), template: true } })}
              onRun={(wf: Data) => setDialog({ type: "run", data: wf })}
              onToggle={(wf: Data) => act(() => api(`/workflows/${wf.id}`, { ...cleanWorkflow(wf), enabled: !wf.enabled }, "PUT"), wf.enabled ? "Workflow disabled" : "Workflow enabled", false)}
              onDelete={(wf: Data) => setDialog({ type: "delete-workflow", data: wf })}
            />
          )}
          {title === "Team" && (
            <TeamPage state={s} busy={busy} isAdmin={isAdmin} onDialog={setDialog} onRole={(m: Data, role: string) => act(() => api(`/org/members/${m.id}`, { role }, "PUT"), "Role updated", false)} onRevokeInvite={(i: Data) => act(() => api(`/org/invites/${i.id}`, {}, "DELETE"), "Invite revoked", false)} />
          )}
          {title === "Activity" && (
            <>
              <section className="panel">
                <div className="section-heading"><h2>Tool calls</h2><span className="count">{s.calls.length}</span></div>
                {s.calls.length ? <div className="table-scroll">
                  <table>
                    <thead><tr><th>Tool</th><th>Connection</th><th>Result</th><th>Duration</th><th>When</th></tr></thead>
                    <tbody>
                      {s.calls.map((c: Data) => (
                        <tr key={c.id}><td><code>{c.tool}</code></td><td>{c.connection}</td><td><Status value={c.status === "ok" ? "succeeded" : "failed"} /></td><td className="muted">{c.ms} ms</td><td className="muted">{when(c.createdAt)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div> : <Empty icon={Activity} title="No tool calls yet">Calls Claude makes through the gateway appear here. Arguments and responses are not stored.</Empty>}
              </section>
              <section className="panel">
                <div className="section-heading"><h2>Audit trail</h2><span className="count">{s.audit.length}</span></div>
                <div className="audit-list">
                  {s.audit.map((a: Data) => (
                    <div key={a.id}><Activity size={14} /><strong>{a.action}</strong><span>{a.target}</span><small>{when(a.createdAt)}</small></div>
                  ))}
                  {!s.audit.length && <p className="muted">Configuration changes are recorded here.</p>}
                </div>
              </section>
            </>
          )}
          {title === "Settings" && (
            <SettingsPage
              state={s}
              busy={busy}
              canConfigure={canConfigure}
              appearance={appearance}
              copy={copy}
              onDialog={setDialog}
              onName={(name: string) => act(() => api("/settings", { name, appearance: settings.appearance || "dark" }, "PUT"), "Name saved", false)}
              onTheme={(value: string) => {
                changeTheme(value);
                // Admins also make it the workspace default for people who haven't picked one.
                if (canConfigure) void api("/settings", { name: settings.name, appearance: value }, "PUT").catch(() => undefined);
              }}
              onSignOut={() => act(() => api("/session/logout", {}), "Signed out")}
              onSignOutEverywhere={() => act(() => api("/auth/logout-all", {}), "All sessions and gateway tokens revoked")}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast("")}><X size={14} /></button>
        </div>
      )}
      {dialog && (
        <Modal
          key={`${dialog.type}:${dialog.data?.id || "new"}`}
          title={({
            connection: dialog.data?.id ? "Configure connection" : dialog.data?._preset ? `Connect ${dialog.data.name}` : "Add connection",
            tools: `Tools from ${dialog.data?.name}`,
            delete: "Remove connection",
            "new-token": "Create gateway token",
            token: "Your gateway token",
            revoke: "Revoke token",
            help: "How the gateway works",
            session: "Your session",
            password: "Change password",
            workspaces: "Workspaces",
            "new-org": "Create organization",
            invite: "Invite a member",
            "invite-link": "Invite link",
            join: "Join organization",
            "remove-member": dialog.data?.you ? "Leave organization" : "Remove member",
            "delete-org": "Delete organization",
            skill: dialog.data?.title,
            api: dialog.data?.id ? `Edit ${dialog.data.name}` : dialog.data?._preset ? `Connect ${dialog.data.name}` : "Add API",
            "api-detail": dialog.data?.name,
            "delete-api": "Remove API",
            workflow: dialog.data?.id ? "Edit workflow" : dialog.data?.template ? "New workflow from template" : "New workflow",
            run: `Run · ${dialog.data?.name}`,
            "delete-workflow": "Delete workflow",
          } as Data)[dialog.type]}
          subtitle={dialog.type === "tools" ? "Choose which tools Claude can see and call." : dialog.type === "skill" ? dialog.data?.description : undefined}
          onClose={close}
          wide={["tools", "skill", "workflow", "run", "api-detail"].includes(dialog.type)}
        >
          {error && <div className="error modal-error" role="alert">{error}</div>}
          {dialog.type === "connection" && (
            <ConnectionForm
              data={dialog.data}
              busy={busy}
              redirectUri={s.oauthRedirectUri}
              copy={copy}
              onCancel={close}
              onOAuth={(action: "connect" | "disconnect") =>
                action === "connect"
                  ? connectOAuth(dialog.data!.id)
                  : act(() => api(`/connections/${dialog.data!.id}/oauth/disconnect`, {}), "Disconnected. Its tokens were deleted.")
              }
              onSave={(d: Data) =>
                act(
                  async () => {
                    const row = await api(`/connections${dialog.data?.id ? `/${dialog.data.id}` : ""}`, d, dialog.data?.id ? "PUT" : "POST");
                    // A new OAuth connection goes straight to the app's sign-in page.
                    if (d.auth === "oauth" && !dialog.data?.id) {
                      try {
                        const { url } = await api(`/connections/${row.id}/oauth/start`, {});
                        location.href = url;
                        return;
                      } catch (e) {
                        // Saved, but sign-in could not start: keep the dialog on the saved record.
                        setDialog({ type: "connection", data: row });
                        throw e;
                      }
                    }
                    // Tools reach /mcp only after a successful test, so test right away instead of leaving it "Not tested".
                    if (!row.enabled || !row.endpoint || (d.auth === "oauth" && !row.oauthState)) return;
                    const tested = await api(`/connections/${row.id}/test`, {});
                    return {
                      toast: tested.status === "Connected"
                        ? `Connected. ${tested.tools.length} tools are now available in Claude.`
                        : `Saved, but the test failed: ${tested.error || "check the connection below."}`,
                    };
                  },
                  "Connection saved.",
                )
              }
            />
          )}
          {dialog.type === "tools" && (
            <ToolsForm
              data={s.connections.find((c: Data) => c.id === dialog.data!.id) || dialog.data}
              busy={busy}
              onCancel={close}
              onSave={(disabledTools: string[]) =>
                act(() => api(`/connections/${dialog.data!.id}/tools`, { disabledTools }, "PUT"), "Tool access updated")
              }
            />
          )}
          {dialog.type === "delete" && (
            <div className="form-body">
              <p>Remove <strong>{dialog.data!.name}</strong>? Its encrypted credential is destroyed and its tools disappear from Claude immediately.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Keep connection</button>
                <button className="danger" disabled={busy} onClick={() => act(() => api(`/connections/${dialog.data!.id}`, {}, "DELETE"), "Connection removed")}>Remove connection</button>
              </div>
            </div>
          )}
          {dialog.type === "new-token" && (
            <form
              className="form-body"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void act(async () => {
                  const token = await api("/tokens", { name: f.get("name"), expiresInDays: Number(f.get("expires")) });
                  setFreshToken(token);
                  setDialog({ type: "token", data: token });
                }, "Token created", false);
              }}
            >
              <Field label="Token name" hint="Where it will be used, so you can recognise and revoke it later.">
                <input name="name" required minLength={2} maxLength={80} autoFocus placeholder="e.g. Claude Code on my laptop" />
              </Field>
              <Field label="Expires after">
                <select name="expires" defaultValue="90">
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">1 year</option>
                </select>
              </Field>
              <p className="muted">The token can list and call your connected tools. It cannot read credentials, change connections, or sign in to this console.</p>
              <FormActions busy={busy} onCancel={close} label="Create token" />
            </form>
          )}
          {dialog.type === "token" && (
            <div className="form-body">
              <div className="info-row">
                <LockKeyhole size={18} />
                <p>Copy this token now. It is shown once and only its hash is stored. Treat it like a password.</p>
              </div>
              <textarea className="token" readOnly value={dialog.data!.token} rows={3} aria-label="Gateway token" />
              <button className="primary" onClick={() => copy(dialog.data!.token, "Token")}><Copy size={15} /> Copy token</button>
              <p className="muted">It is also filled into the setup steps on this page until you leave it.</p>
              <div className="form-footer"><button className="secondary" onClick={close}>Done</button></div>
            </div>
          )}
          {dialog.type === "revoke" && (
            <div className="form-body">
              <p>Revoke <strong>{dialog.data!.name}</strong>? Any Claude client using it loses access immediately.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Keep token</button>
                <button className="danger" disabled={busy} onClick={() => act(async () => { await api(`/tokens/${dialog.data!.id}`, {}, "DELETE"); if (freshToken?.id === dialog.data!.id) setFreshToken(null); }, "Token revoked")}>Revoke token</button>
              </div>
            </div>
          )}
          {dialog.type === "help" && (
            <div className="form-body help-content">
              <ol>
                <li><strong>Connect apps.</strong> Add each MCP server or HTTP API once, with its credential. The server operator must allowlist its host in <code>OUTBOUND_HOSTS</code>.</li>
                <li><strong>Test.</strong> A live test discovers the app's tools. Only tested, enabled connections are exposed.</li>
                <li><strong>Choose tools.</strong> Turn off any tool Claude should not see.</li>
                <li><strong>Connect agents.</strong> Create a token and add <code>{mcpUrl()}</code> to Claude, Codex, Cursor or any MCP client. They see every app's tools, named <code>app__tool</code>.</li>
              </ol>
              <h3>What stays on the gateway</h3>
              <p>App credentials never leave the server. Claude only holds a revocable gateway token that can list and call tools, nothing else. Calls are logged without their arguments or responses.</p>
            </div>
          )}
          {dialog.type === "session" && (
            <div className="form-body">
              <p>Signed in as <strong>{s.identity.displayName || s.identity.user}</strong>{s.identity.email && <> ({s.identity.email})</>}.</p>
              <p className="muted">Sessions expire after one hour of inactivity or eight hours from sign-in.</p>
              <button className="secondary" onClick={() => act(() => api("/session/logout", {}), "Signed out")}>Sign out</button>
              {s.identity.authMethod === "email" && <button className="secondary" onClick={() => setDialog({ type: "password" })}>Change password</button>}
              <button className="text-button" onClick={() => act(() => api("/auth/logout-all", {}), "All sessions and gateway tokens revoked")}>Sign out everywhere</button>
              <p className="muted">Signing out everywhere also revokes every gateway token, disconnecting Claude.</p>
            </div>
          )}
          {dialog.type === "workspaces" && (
            <div className="form-body">
              <div className="member-list">
                {s.workspaces.map((w: Data) => (
                  <div className="member-row" key={w.id}>
                    <span><strong>{w.name}</strong><small>{w.kind === "org" ? `Organization · ${w.role}` : "Personal · only you"}</small></span>
                    {w.current ? <span className="tag">Current</span> : <button className="secondary compact" disabled={busy} onClick={() => act(() => api("/workspaces/switch", { workspace: w.id }), "Workspace switched")}>Switch</button>}
                  </div>
                ))}
              </div>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Close</button>
                <button className="primary" onClick={() => setDialog({ type: "new-org" })}><Plus size={16} /> Create organization</button>
              </div>
            </div>
          )}
          {dialog.type === "new-org" && (
            <form
              className="form-body"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void act(async () => {
                  await api("/orgs", { name: f.get("name") });
                  location.hash = "#team";
                }, "Organization created. Invite your team from here.");
              }}
            >
              <Field label="Organization name" hint="You become its first admin, and can make any member an admin.">
                <input name="name" required minLength={2} maxLength={80} autoFocus placeholder="e.g. Acme Corp" />
              </Field>
              <p className="muted">An organization has its own connections and credentials, separate from your personal workspace. Members share them through the gateway without ever seeing the credentials.</p>
              <FormActions busy={busy} onCancel={close} label="Create organization" />
            </form>
          )}
          {dialog.type === "invite" && (
            <form
              className="form-body"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void act(async () => {
                  const invite = await api("/org/invites", { role: f.get("role") });
                  setDialog({ type: "invite-link", data: invite });
                }, "Invite created", false);
              }}
            >
              <Field label="Role" hint="You can change anyone's role later.">
                <select name="role" defaultValue="member">
                  <option value="member">Member: uses the gateway, cannot change it</option>
                  <option value="admin">Admin: manages connections, members and settings</option>
                </select>
              </Field>
              <p className="muted">You get a one-time link to send them. It works for one person and expires in 7 days.</p>
              <FormActions busy={busy} onCancel={close} label="Create invite link" />
            </form>
          )}
          {dialog.type === "invite-link" && (
            <div className="form-body">
              <div className="info-row">
                <LockKeyhole size={18} />
                <p>Copy this link now. It is shown once and only its hash is stored. Anyone who opens it while signed in can join as {dialog.data!.role === "admin" ? "an admin" : "a member"}, once.</p>
              </div>
              <CodeLine text={`${location.origin}/#invite=${dialog.data!.token}`} copy={copy} label="Invite link" />
              <div className="form-footer"><button className="primary" onClick={close}>Done</button></div>
            </div>
          )}
          {dialog.type === "join" && (
            <div className="form-body">
              <p>You have been invited to join <strong>{dialog.data!.org}</strong> as {dialog.data!.role === "admin" ? "an admin" : "a member"}.</p>
              <p className="muted">You will share its connected apps through the gateway. Your personal workspace stays separate, and you can switch between them any time.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Not now</button>
                <button className="primary" disabled={busy} onClick={() => act(async () => { await api("/invites/accept", { token: dialog.data!.token }); forgetInvite(); location.hash = "#team"; }, `You joined ${dialog.data!.org}`)}>Join organization</button>
              </div>
            </div>
          )}
          {dialog.type === "remove-member" && (
            <div className="form-body">
              <p>{dialog.data!.you ? <>Leave <strong>{s.org?.name}</strong>?</> : <>Remove <strong>{dialog.data!.name}</strong> ({dialog.data!.email}) from <strong>{s.org?.name}</strong>?</>} {dialog.data!.you ? "You" : "They"} lose access immediately and {dialog.data!.you ? "your" : "their"} gateway tokens for this organization are revoked.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Cancel</button>
                <button className="danger" disabled={busy} onClick={() => act(() => api(`/org/members/${dialog.data!.id}`, {}, "DELETE"), dialog.data!.you ? "You left the organization" : "Member removed")}>{dialog.data!.you ? "Leave organization" : "Remove member"}</button>
              </div>
            </div>
          )}
          {dialog.type === "delete-org" && (
            <form
              className="form-body"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void act(() => api("/org", { confirm: f.get("confirm") }, "DELETE"), "Organization deleted");
              }}
            >
              <p>Delete <strong>{s.org?.name}</strong>? Every connection and its encrypted credential, every member's access and every gateway token for it are destroyed. This cannot be undone.</p>
              <Field label={`Type “${s.org?.name}” to confirm`}>
                <input name="confirm" required autoFocus autoComplete="off" />
              </Field>
              <div className="form-footer">
                <button type="button" className="secondary" onClick={close}>Cancel</button>
                <button className="danger" disabled={busy}>Delete organization</button>
              </div>
            </form>
          )}
          {dialog.type === "api" && (
            <ApiForm
              data={dialog.data}
              busy={busy}
              onCancel={close}
              onSave={(d: Data) =>
                act(async () => {
                  const row = await api(`/apis${dialog.data?.id ? `/${dialog.data.id}` : ""}`, d, dialog.data?.id ? "PUT" : "POST");
                  setDialog({ type: "api-detail", data: row });
                }, dialog.data?.id ? "API saved" : "API added. Its key is encrypted and won’t be shown again.", false)
              }
            />
          )}
          {dialog.type === "api-detail" && (
            <ApiDetail
              api={s.apis.find((a: Data) => a.id === dialog.data!.id) || dialog.data}
              busy={busy}
              canConfigure={canConfigure}
              onEdit={() => setDialog({ type: "api", data: s.apis.find((a: Data) => a.id === dialog.data!.id) || dialog.data })}
              onDelete={() => setDialog({ type: "delete-api", data: dialog.data })}
              onRefreshDocs={() => act(() => api(`/apis/${dialog.data!.id}/docs`, {}), "Docs refreshed", false)}
            />
          )}
          {dialog.type === "delete-api" && (
            <div className="form-body">
              <p>Remove <strong>{dialog.data!.name}</strong>? Its encrypted key is destroyed and agents can no longer call it.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Keep API</button>
                <button className="danger" disabled={busy} onClick={() => act(() => api(`/apis/${dialog.data!.id}`, {}, "DELETE"), "API removed")}>Remove API</button>
              </div>
            </div>
          )}
          {dialog.type === "skill" && (
            <SkillDetail skill={s.skills.find((k: Data) => k.id === dialog.data!.id) || dialog.data} busy={busy} canConfigure={canConfigure} onToggle={(enabled: boolean) => act(() => api(`/skills/${dialog.data!.id}`, { enabled }, "PUT"), enabled ? "On for your agents" : "Turned off", false)} />
          )}
          {dialog.type === "workflow" && (
            <WorkflowEditor
              state={s}
              data={dialog.data}
              busy={busy}
              copy={copy}
              onCancel={close}
              onSave={(wf: Data) =>
                act(
                  () => api(`/workflows${dialog.data?.id ? `/${dialog.data.id}` : ""}`, { ...wf, ...(dialog.data?.template ? { source: "template" } : {}) }, dialog.data?.id ? "PUT" : "POST"),
                  wf.enabled ? "Workflow saved and enabled" : "Workflow saved as a draft",
                )
              }
            />
          )}
          {dialog.type === "run" && <RunWorkflow workflow={dialog.data!} onDone={() => void refresh()} />}
          {dialog.type === "delete-workflow" && (
            <div className="form-body">
              <p>Delete <strong>{dialog.data!.name}</strong>? Agents lose its tool immediately. Its run history is kept.</p>
              <div className="form-footer">
                <button className="secondary" onClick={close}>Keep workflow</button>
                <button className="danger" disabled={busy} onClick={() => act(() => api(`/workflows/${dialog.data!.id}`, {}, "DELETE"), "Workflow deleted")}>Delete workflow</button>
              </div>
            </div>
          )}
          {dialog.type === "password" && (
            <form
              className="form-body"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                if (form.get("newPassword") !== form.get("confirmPassword")) {
                  setError("New passwords do not match.");
                  return;
                }
                void act(
                  () => api("/auth/password", { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }),
                  "Password changed. Other sessions and gateway tokens were revoked.",
                );
              }}
            >
              <Field label="Current password"><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></Field>
              <Field label="New password" hint="Use 12 to 128 characters and a unique password."><input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field>
              <Field label="Confirm new password"><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field>
              <p className="muted">Changing your password signs out your other devices and revokes all gateway tokens.</p>
              <FormActions busy={busy} onCancel={close} label="Change password" />
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
const oauthErrors: Record<string, string> = {
  "oauth-cancelled": "Sign-in was cancelled. The app is not connected.",
  "oauth-forbidden": "Only organization admins can connect apps.",
  "oauth-failed": "Sign-in could not be completed. Try Connect again.",
};
const googleErrors: Record<string, string> = {
  "google-not-configured": "Google sign-in is not set up on this server yet. Use email and password.",
  "google-cancelled": "Google sign-in was cancelled.",
  "google-unverified": "Your Google account's email address is not verified.",
  "google-mismatch": "This email is linked to a different Google account.",
  "signup-closed": "No account exists for this Google account, and registration is closed.",
  "account-disabled": "This account is disabled. Contact your administrator.",
  "google-failed": "Google sign-in could not be completed. Try again.",
};
function GoogleIcon() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true">
      <path fill="#fbbb00" d="M113.47 309.408 95.648 375.94l-65.139 1.378C11.042 341.211 0 299.9 0 256c0-42.451 10.324-82.483 28.624-117.732h.014L86.63 148.9l25.404 57.644c-5.317 15.501-8.215 32.141-8.215 49.456.002 18.792 3.406 36.797 9.651 53.408z" />
      <path fill="#518ef8" d="M507.527 208.176C510.467 223.662 512 239.655 512 256c0 18.328-1.927 36.206-5.598 53.451-12.462 58.683-45.025 109.925-90.134 146.187l-.014-.014-73.044-3.727-10.338-64.535c29.932-17.554 53.324-45.025 65.646-77.911h-136.89V208.176h245.899z" />
      <path fill="#28b446" d="m416.253 455.624.014.014C372.396 490.901 316.666 512 256 512c-97.491 0-182.252-54.491-225.491-134.681l82.961-67.91c21.619 57.698 77.278 98.771 142.53 98.771 28.047 0 54.323-7.582 76.87-20.818l83.383 68.262z" />
      <path fill="#f14336" d="m419.404 58.936-82.933 67.896C313.136 112.246 285.552 103.82 256 103.82c-66.729 0-123.429 42.957-143.965 102.724l-83.397-68.276h-.014C71.23 56.123 157.06 0 256 0c62.115 0 119.068 22.126 163.404 58.936z" />
    </svg>
  );
}
// Mirrors the v0 sign-in and registration screens (components/Auth in v0).
function EmailLogin({
  busy,
  error,
  onSubmit,
  clearError,
  dark,
  onToggleTheme,
}: {
  busy: boolean;
  error: string;
  onSubmit: (data: Data, register: boolean) => void;
  clearError: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  // The landing page's early-access form links to #signup=<email>: open on registration with it filled in.
  const [invitedEmail] = useState(() => {
    const raw = /^#signup=([^&]*)$/.exec(location.hash)?.[1];
    if (raw === undefined) return null;
    history.replaceState(null, "", location.pathname);
    try {
      return decodeURIComponent(raw).slice(0, 254);
    } catch {
      return "";
    }
  });
  const [register, setRegister] = useState(invitedEmail !== null),
    [signup, setSignup] = useState(true),
    [mismatch, setMismatch] = useState(false),
    [oauthError] = useState(() => {
      // Google sign-in reports failures by redirecting to #auth-error=<code>.
      const code = /^#auth-error=([a-z-]+)$/.exec(location.hash)?.[1];
      if (!code) return "";
      history.replaceState(null, "", location.pathname);
      return googleErrors[code] || googleErrors["google-failed"];
    });
  useEffect(() => {
    void api("/auth/config")
      .then((data) => {
        setSignup(data.signupEnabled);
        if (!data.signupEnabled) setRegister(false);
      })
      .catch(() => setSignup(false));
  }, []);
  const switchMode = () => {
    setRegister(!register);
    setMismatch(false);
    clearError();
  };
  return (
    <div className="auth">
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-brand">
            <img src="/assets/logo.svg" alt="" aria-hidden="true" />
            <span>OrbytLink</span>
          </div>
          <h1>{register ? "Create your account" : "Welcome back"}</h1>
          {(error || oauthError) && <div className="auth-error" role="alert">{error || oauthError}</div>}
          <form
            className="auth-form"
            aria-label={register ? "Registration form" : "Login form"}
            key={register ? "register" : "login"}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (register && form.get("password") !== form.get("confirm_password")) {
                setMismatch(true);
                return;
              }
              setMismatch(false);
              onSubmit(
                {
                  email: form.get("email"),
                  password: form.get("password"),
                  ...(register ? { name: form.get("name") } : {}),
                },
                register,
              );
            }}
          >
            {register && <AuthInput id="name" label="Full name" autoComplete="name" minLength={2} maxLength={80} />}
            <AuthInput id="email" label="Email address" type="email" autoComplete="email" maxLength={254} defaultValue={invitedEmail || undefined} />
            <AuthInput id="password" label="Password" secret autoComplete={register ? "new-password" : "current-password"} minLength={12} maxLength={128} />
            {register && (
              <AuthInput id="confirm_password" label="Confirm password" secret autoComplete="new-password" minLength={12} maxLength={128} error={mismatch ? "Passwords do not match" : undefined} />
            )}
            <button className="auth-submit" type="submit" aria-label="Continue" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : "Continue"}
            </button>
          </form>
          {register ? (
            <p className="auth-switch">
              Already have an account?{" "}
              <button type="button" aria-label="Login" onClick={switchMode}>Login</button>
            </p>
          ) : (
            signup && (
              <p className="auth-switch">
                Don&apos;t have an account?{" "}
                <button type="button" onClick={switchMode}>Sign up</button>
              </p>
            )
          )}
          <div className="auth-divider"><span>Or</span></div>
          <a className="auth-social" href="/api/auth/google" aria-label="Continue with Google">
            <GoogleIcon />
            <span>Continue with Google</span>
          </a>
        </div>
      </main>
      <button className="auth-theme" type="button" aria-label="Toggle theme" aria-keyshortcuts="Ctrl+Shift+T" onClick={onToggleTheme}>
        {dark ? <Moon size={22} /> : <Sun size={22} />}
      </button>
    </div>
  );
}
function AuthInput({
  id,
  label,
  secret = false,
  type = "text",
  error,
  ...props
}: {
  id: string;
  label: string;
  secret?: boolean;
  type?: string;
  error?: string;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  defaultValue?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-field">
      <div className="auth-control">
        <input
          id={id}
          name={id}
          type={secret && !visible ? "password" : secret ? "text" : type}
          placeholder=" "
          required
          aria-label={label}
          aria-invalid={!!error}
          className={secret ? "with-toggle" : ""}
          {...props}
        />
        <label htmlFor={id}>{label}</label>
        {secret && (
          <button type="button" className="auth-reveal" aria-label={visible ? "Hide password" : "Show password"} onClick={() => setVisible(!visible)}>
            {visible ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {error && <span className="auth-field-error" role="alert">{error}</span>}
    </div>
  );
}
function OrbitLogo() {
  return (
    <img
      className="product-logo"
      src="/assets/logo.svg"
      alt=""
      aria-hidden="true"
      width="28"
      height="28"
    />
  );
}

// The app's own mark on a white tile (readable in both themes); a coloured monogram when
// there is no mark; the generic link/API glyph for connections that are not in the catalog.
// An app's own mark on a white tile (readable in both themes), or a coloured monogram.
function BrandTile({ id, name }: { id: string; name: string }) {
  const brand = brands[id];
  if (brand)
    return (
      <div className="app-icon logo" title={name}>
        <svg viewBox="0 0 24 24" width="22" height="22" role="img" aria-label={`${name} logo`}>
          <path fill={`#${brand.hex}`} d={brand.path} />
        </svg>
      </div>
    );
  return (
    <div className="app-icon logo mono" style={{ background: `#${monograms[id] || "18181B"}` }} title={name} aria-label={`${name} logo`}>
      {name.slice(0, 1)}
    </div>
  );
}
// Catalog apps get their brand tile; other connections keep the generic link/API glyph.
function AppLogo({ preset, kind }: { preset?: Preset; kind?: string }) {
  if (preset && (brands[preset.id] || monograms[preset.id])) return <BrandTile id={preset.id} name={preset.name} />;
  return <div className="app-icon"><ConnectionIcon kind={kind} /></div>;
}
const presetFor = (c: Data) => catalog.find((p) => p.endpoint && p.endpoint === c.endpoint);
function ConnectionIcon({ kind }: any) {
  return kind === "api" ? <Code2 size={18} /> : <Link2 size={18} />;
}
function connectorType(c: Data) {
  const label: Data = { mcp: "MCP server", api: "HTTP API" };
  if (c.kind !== "auto") return label[c.kind] || "Connector";
  return c.protocol
    ? `Auto-detected · ${label[c.protocol]}`
    : "Auto-detect · MCP or HTTP API";
}

function Toolbar({
  search,
  setSearch,
  placeholder,
  count,
}: {
  search: string;
  setSearch: (v: string) => void;
  placeholder: string;
  count: string;
}) {
  return (
    <div className="toolbar">
      <div className="search-box">
        <Search size={16} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <span>{count}</span>
    </div>
  );
}
function FormActions({
  busy,
  onCancel,
  label = "Save changes",
}: {
  busy: boolean;
  onCancel: () => void;
  label?: string;
}) {
  return (
    <div className="form-footer">
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      <button className="primary" disabled={busy}>
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Check size={15} />
        )}{" "}
        {label}
      </button>
    </div>
  );
}
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
function presetDraft(p: Preset): Data {
  return {
    _preset: p,
    name: p.name,
    description: p.description,
    kind: "mcp",
    endpoint: p.endpoint,
    auth: p.auth,
    authHeader: p.authHeader,
    oauth: p.oauth && {
      mode: p.oauth.mode,
      clientId: "",
      authorizationUrl: p.oauth.authorizationUrl || "",
      tokenUrl: p.oauth.tokenUrl || "",
      scopes: p.oauth.scopes || [],
      scopeParam: p.oauth.scopeParam || "scope",
      tokenAuth: p.oauth.tokenAuth || "body",
      authParams: p.oauth.authParams || {},
    },
  };
}
function CatalogPage({ state: s, canConfigure, search, setSearch, onConnect }: any) {
  const [segment, setSegment] = useState("All");
  const q = search.toLowerCase();
  const listed = catalog.filter((p) => !p.hidden);
  const shown = listed.filter(
    (p) => (segment === "All" || p.segment === segment) && `${p.name} ${p.description} ${p.segment}`.toLowerCase().includes(q),
  );
  const present = segments.filter((seg) => listed.some((p) => p.segment === seg));
  const existing = (p: Preset) => (p.endpoint ? s.connections.find((c: Data) => c.endpoint === p.endpoint) : undefined);
  return (
    <>
      <Toolbar search={search} setSearch={setSearch} placeholder="Search apps…" count={`${shown.length} apps`} />
      <div className="catalog-filters" role="radiogroup" aria-label="Segment">
        {["All", ...present].map((seg) => (
          <button type="button" role="radio" aria-checked={segment === seg} className={segment === seg ? "active" : ""} key={seg} onClick={() => setSegment(seg)}>{seg}</button>
        ))}
      </div>
      {present.map((seg) => {
        const items = shown.filter((p) => p.segment === seg);
        if (!items.length) return null;
        return (
          <section className="catalog-segment" key={seg} aria-label={seg}>
            {segment === "All" && <h2>{seg}</h2>}
            <div className="catalog-grid">
              {items.map((p) => {
                const added = existing(p),
                  on = !!added,
                  live = added?.enabled && added.status === "Connected";
                // The whole card is the action: connect it, or open it if it is already connected.
                return (
                  <button
                    type="button"
                    className="catalog-card"
                    key={p.id}
                    aria-label={on ? `Open ${p.name}` : `Connect ${p.name}`}
                    title={!on && !canConfigure ? "Only admins can connect apps" : undefined}
                    disabled={!on && !canConfigure}
                    onClick={() => (on ? (location.hash = "#connections") : onConnect(p))}
                  >
                    <AppLogo preset={p} kind="mcp" />
                    <span className="catalog-body">
                      <span className="catalog-name">
                        {p.name}
                        {on && <span className={`catalog-status ${live ? "" : "idle"}`}><i />{live ? "Connected" : "Added"}</span>}
                      </span>
                      <span className="catalog-desc">{p.description}</span>
                    </span>
                    <ArrowUpRight className="catalog-arrow" size={16} />
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {!shown.length && <section className="panel"><Empty icon={LayoutGrid} title="No apps found">Try another search, or add any MCP server or API yourself from Connections.</Empty></section>}
    </>
  );
}
function ConnectionForm({ data: d, busy, onSave, onCancel, onOAuth, redirectUri, copy }: any) {
  const [kind, setKind] = useState(d?.kind || "auto"),
    [auth, setAuth] = useState(d?.auth || "none"),
    [operations, setOperations] = useState<Data[]>(d?.operations || []),
    [oauthMode, setOauthMode] = useState<string>(d?.oauth?.mode || "discover"),
    [error, setError] = useState("");
  const preset: Preset | undefined = d?._preset;
  const authParamText = Object.entries(d?.oauth?.authParams || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const headerText = Object.entries(d?.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const setOperation = (i: number, key: string, value: string) =>
    setOperations(
      operations.map((o, n) => (n === i ? { ...o, [key]: value } : o)),
    );
  return (
    <form
      className="form-body"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const headers: Data = {};
        for (const line of String(f.get("headers") || "").split("\n")) {
          if (!line.trim()) continue;
          const at = line.indexOf(":");
          if (at < 1) {
            setError(`Write each header as "Name: value" (${line.trim()})`);
            return;
          }
          headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        const authParams: Data = {};
        for (const line of String(f.get("authParams") || "").split("\n")) {
          if (!line.trim()) continue;
          const at = line.indexOf("=");
          if (at < 1) {
            setError(`Write each OAuth parameter as "name=value" (${line.trim()})`);
            return;
          }
          authParams[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        setError("");
        onSave({
          ...(auth === "oauth"
            ? {
                oauth: {
                  mode: oauthMode,
                  clientId: String(f.get("clientId") || "").trim(),
                  authorizationUrl: oauthMode === "manual" ? String(f.get("authorizationUrl") || "").trim() : "",
                  tokenUrl: oauthMode === "manual" ? String(f.get("tokenUrl") || "").trim() : "",
                  scopes: String(f.get("scopes") || "").split(/\s+/).filter(Boolean),
                  scopeParam: f.get("scopeParam") || "scope",
                  tokenAuth: f.get("tokenAuth") || "body",
                  authParams,
                },
                clientSecret: f.get("clientSecret") || undefined,
              }
            : {}),
          name: f.get("name"),
          description: f.get("description") || "",
          kind,
          endpoint: f.get("endpoint"),
          auth,
          authHeader: f.get("authHeader") || "X-API-Key",
          headers,
          operations: kind === "mcp" ? [] : operations,
          secret: f.get("secret") || undefined,
          enabled: f.get("enabled") === "on",
        });
      }}
    >
      {preset && (
        <div className="preset-notes">
          <div className="info-row">
            <LockKeyhole size={17} />
            <div>{preset.notes.map((n) => <p key={n}>{n}</p>)}</div>
          </div>
          <a className="text-button" href={preset.docs} target="_blank" rel="noopener noreferrer">Provider documentation <ArrowUpRight size={13} /></a>
        </div>
      )}
      <div className="form-grid">
        <Field label="Connection name">
          <input
            autoFocus
            name="name"
            defaultValue={d?.name || ""}
            required
            minLength={2}
            maxLength={80}
            placeholder="e.g. GitHub, CRM, internal API"
          />
        </Field>
        <Field label="What it’s for" hint="Optional. Shown next to its tools in Claude.">
          <input
            name="description"
            defaultValue={d?.description || ""}
            maxLength={300}
            placeholder="e.g. Finds companies and contacts"
          />
        </Field>
      </div>
      <div className="field">
        <span>Connection type</span>
        <div className="segmented" role="radiogroup" aria-label="Connection type">
          {[
            ["auto", "Auto-detect"],
            ["mcp", "MCP server"],
            ["api", "HTTP API"],
          ].map(([value, label]) => (
            <button
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={kind === value ? "active" : ""}
              key={value}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <small>
          {kind === "auto"
            ? "Testing tries MCP (Streamable HTTP, then SSE) and falls back to a plain HTTP API."
            : kind === "mcp"
              ? "Tools are discovered from the server when you test."
              : "Name the API calls you want to expose below; each becomes a tool in Claude."}
        </small>
      </div>
      <Field
        label="Endpoint"
        hint="Its HTTPS base URL. The host must be allowlisted on the server; credentials and query parameters are not permitted in URLs."
      >
        <input
          name="endpoint"
          type="url"
          defaultValue={d?.endpoint || ""}
          placeholder={
            kind === "api"
              ? "https://api.your-service.example/v1"
              : "https://your-server.example/mcp"
          }
        />
      </Field>
      <div className="form-grid">
        <Field label="Authentication">
          <select value={auth} onChange={(e) => setAuth(e.target.value)}>
            <option value="none">No authentication</option>
            <option value="bearer">Bearer token</option>
            <option value="api-key">API key in a header</option>
            <option value="basic">Basic auth · user:password</option>
            <option value="oauth">OAuth sign-in</option>
          </select>
        </Field>
        {auth === "api-key" && (
          <Field label="Header name">
            <input
              name="authHeader"
              defaultValue={d?.authHeader || "X-API-Key"}
              pattern="[A-Za-z0-9!#$%&'*+.^_`|~\-]{1,64}"
              required
            />
          </Field>
        )}
      </div>
      {auth === "oauth" && (
        <div className="oauth-box">
          {d?.id && (
            <div className="info-row">
              <LockKeyhole size={17} />
              <p>{d.oauthState?.connected ? "Signed in. The gateway keeps encrypted tokens and refreshes them automatically." : "Not signed in yet."}</p>
              <button type="button" className="secondary compact" disabled={busy} onClick={() => onOAuth("connect")}>{d.oauthState?.connected ? "Reconnect" : "Connect"}</button>
              {d.oauthState?.connected && <button type="button" className="text-button" disabled={busy} onClick={() => onOAuth("disconnect")}>Disconnect</button>}
            </div>
          )}
          <Field label="Client setup" hint={oauthMode === "discover" ? "The server publishes its sign-in details and registers OrbytLink automatically." : "Use a client you registered with the provider. Its secret is encrypted on the server."}>
            <select value={oauthMode} onChange={(e) => setOauthMode(e.target.value)}>
              <option value="discover">Automatic registration</option>
              <option value="manual">My own OAuth client</option>
            </select>
          </Field>
          {oauthMode === "manual" && (
            <div className="form-grid">
              <Field label="Authorization URL"><input name="authorizationUrl" type="url" required defaultValue={d?.oauth?.authorizationUrl || ""} placeholder="https://accounts.example.com/oauth/authorize" /></Field>
              <Field label="Token URL"><input name="tokenUrl" type="url" required defaultValue={d?.oauth?.tokenUrl || ""} placeholder="https://accounts.example.com/oauth/token" /></Field>
            </div>
          )}
          <div className="form-grid">
            <Field label="Client ID" hint={oauthMode === "manual" ? undefined : "Only if the server needs a pre-registered client."}>
              <input name="clientId" required={oauthMode === "manual"} defaultValue={d?.oauth?.clientId || ""} maxLength={300} autoComplete="off" />
            </Field>
            <Field label={d?.hasClientSecret ? "Replace client secret" : "Client secret"} hint={d?.hasClientSecret ? "Leave blank to keep the saved secret." : "Optional for public clients."}>
              <input name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} placeholder={d?.hasClientSecret ? "Leave blank to keep saved secret" : ""} />
            </Field>
          </div>
          <Field label="Scopes" hint="Separated by spaces or new lines. Leave empty to use the provider’s defaults.">
            <textarea name="scopes" rows={3} className="code-input" defaultValue={(d?.oauth?.scopes || []).join("\n")} />
          </Field>
          <div className="field">
            <span>Redirect URI</span>
            <CodeLine text={redirectUri} copy={copy} label="Redirect URI" />
            <small>Register exactly this address with the provider.</small>
          </div>
          <details className="advanced">
            <summary>OAuth advanced</summary>
            <div className="form-grid">
              <Field label="Scope parameter">
                <select name="scopeParam" defaultValue={d?.oauth?.scopeParam || "scope"}>
                  <option value="scope">scope</option>
                  <option value="user_scope">user_scope</option>
                </select>
              </Field>
              <Field label="Client authentication">
                <select name="tokenAuth" defaultValue={d?.oauth?.tokenAuth || "body"}>
                  <option value="body">Client ID and secret in the request body</option>
                  <option value="basic">HTTP Basic</option>
                </select>
              </Field>
            </div>
            <Field label="Extra authorization parameters" hint="One per line, as name=value, e.g. access_type=offline.">
              <textarea name="authParams" rows={2} className="code-input" defaultValue={authParamText} />
            </Field>
          </details>
        </div>
      )}
      {auth !== "none" && auth !== "oauth" && (
        <Field
          label={d?.hasSecret ? "Replace credential" : "Credential"}
          hint={
            d?.hasSecret
              ? "A credential is saved. Leave blank to keep it. Saved values are never returned."
              : auth === "basic"
                ? "Enter as user:password. Encrypted on the server."
                : "Encrypted on the server. Never saved in browser storage."
          }
        >
          <input
            name="secret"
            type="password"
            autoComplete="new-password"
            placeholder={
              d?.hasSecret
                ? "Leave blank to keep saved credential"
                : "Paste credential"
            }
            maxLength={4096}
          />
        </Field>
      )}
      {kind !== "mcp" && (
        <div className="field operations">
          <span>HTTP operations</span>
          <small>
            Paths are relative to the endpoint. Use {"{name}"} for values taken
            from tool inputs; other inputs become query parameters (GET,
            DELETE) or the JSON body. The endpoint itself is always available
            as GET.
          </small>
          {operations.map((o, i) => (
            <div className="operation-row" key={i}>
              <input
                aria-label="Operation name"
                value={o.name || ""}
                onChange={(e) => setOperation(i, "name", e.target.value)}
                placeholder="find_contacts"
                pattern="[A-Za-z0-9_.\-]{1,64}"
                required
              />
              <select
                aria-label="Method"
                value={o.method || "GET"}
                onChange={(e) => setOperation(i, "method", e.target.value)}
              >
                {methods.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                aria-label="Path"
                className="code-input"
                value={o.path || ""}
                onChange={(e) => setOperation(i, "path", e.target.value)}
                placeholder="/contacts/{id}"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove operation ${o.name || i + 1}`}
                onClick={() =>
                  setOperations(operations.filter((_, n) => n !== i))
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary compact"
            disabled={operations.length >= 50}
            onClick={() =>
              setOperations([
                ...operations,
                { name: "", method: "GET", path: "", description: "" },
              ])
            }
          >
            <Plus size={14} /> Add operation
          </button>
        </div>
      )}
      <details className="advanced">
        <summary>Advanced</summary>
        <Field
          label="Extra headers"
          hint="One per line, as Name: value. Not encrypted; keep credentials in the credential field."
        >
          <textarea
            name="headers"
            rows={3}
            className="code-input"
            defaultValue={headerText}
            placeholder={"Accept: application/json\nX-Workspace: acme"}
          />
        </Field>
      </details>
      <label className="check-row">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={d?.enabled ?? true}
        />{" "}
        Enable connection
      </label>
      {(error || d?.error) && <div className="error">{error || d.error}</div>}
      <FormActions busy={busy} onCancel={onCancel} label="Save connection" />
    </form>
  );
}
const TOKEN_PLACEHOLDER = "<YOUR_GATEWAY_TOKEN>";
function CodeLine({ text, copy, label }: { text: string; copy: (t: string, l: string) => void; label: string }) {
  return (
    <div className="code-line">
      <code>{text}</code>
      <button className="icon-button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(text, label)}><Copy size={16} /></button>
    </div>
  );
}
// The token as shown on screen: enough to recognise it, never the whole secret.
const maskToken = (t: string) => `${t.slice(0, 7)}••••••••${t.slice(-4)}`;
function CodeBlock({ code, copyText, copy, file }: { code: string; copyText: string; copy: (t: string, l: string) => void; file?: string }) {
  return (
    <div className="snippet">
      {file && <div className="snippet-file">{file}</div>}
      <pre>{code}</pre>
      <button className="icon-button snippet-copy" aria-label="Copy snippet" onClick={() => copy(copyText, "Snippet")}><Copy size={15} /></button>
    </div>
  );
}
function AgentsPage({ state: s, busy, copy, freshToken, onQuickCreate, onCreate, onRevoke }: any) {
  const presets = agents.filter((a) => a.id !== "mcp"),
    generic = agents.find((a) => a.id === "mcp")!;
  // Nothing picked means "any client": the URL and token are all it needs.
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem("orbytlink:agent");
    } catch {
      return null;
    }
  });
  const agent = presets.find((a) => a.id === selected) || generic;
  const [methodId, setMethodId] = useState<string>(agent.methods[0].id);
  const method = agent.methods.find((m) => m.id === methodId) || agent.methods[0];
  const pick = (id: string | null) => {
    setSelected(id);
    setMethodId((presets.find((a) => a.id === id) || generic).methods[0].id);
    try {
      if (id) localStorage.setItem("orbytlink:agent", id);
      else localStorage.removeItem("orbytlink:agent");
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit.
    }
  };
  const url = mcpUrl(),
    real = freshToken?.token || TOKEN_PLACEHOLDER,
    shown = freshToken ? maskToken(freshToken.token) : TOKEN_PLACEHOLDER;
  return (
    <div className="agents-experience">
      <header className="agents-hero">
        <BrandTile id="agent-mcp" name="MCP" />
        <h1>Connect any agent</h1>
        <p>One address gives any MCP client every app in this gateway. Paste it in, add your token, and you’re done.</p>
        <div className="hero-url">
          <code>{url}</code>
          <button className="primary compact" onClick={() => copy(url, "MCP URL")}><Copy size={14} /> Copy</button>
        </div>
        {/* One click: a token named after the chosen agent, valid 90 days. Custom names and expiry live in the tokens table. */}
        {freshToken ? (
          <div className="hero-token ready">
            <span className="token-pill">
              <KeyRound size={14} />
              <code>{shown}</code>
              <button className="icon-button" aria-label="Copy token" onClick={() => copy(freshToken.token, "Token")}><Copy size={14} /></button>
            </span>
            <small>{freshToken.name} · expires {new Date(freshToken.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · filled into every step below</small>
          </div>
        ) : (
          <div className="hero-token">
            <button className="token-cta" disabled={busy} onClick={() => onQuickCreate(`${agent === generic ? "Agent" : agent.name} · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`)}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}
              Generate a token{agent === generic ? "" : ` for ${agent.name}`}
            </button>
            <small>Valid for 90 days. Revoke it any time. <button className="text-button" onClick={onCreate}>Custom name or expiry</button></small>
          </div>
        )}
      </header>

      <section className="agents-presets" aria-label="Quick setup">
        <span className="agents-label">Quick setup for</span>
        <div className="agent-chips" role="radiogroup" aria-label="Agent">
          {presets.map((a) => (
            <button
              type="button"
              role="radio"
              aria-checked={a.id === selected}
              className={`agent-chip ${a.id === selected ? "active" : ""}`}
              key={a.id}
              onClick={() => pick(a.id === selected ? null : a.id)}
            >
              <BrandTile id={a.logo} name={a.name} />
              {a.name}
            </button>
          ))}
        </div>
      </section>

      <section className="agent-guide" aria-label={`Set up ${agent.name}`}>
        <div className="agent-guide-head">
          <div className="agent-heading">
            <BrandTile id={agent.logo} name={agent.name} />
            <div><h2>{agent === generic ? "Any MCP client" : agent.name}</h2><small>{agent === generic ? "Works with every client that supports Streamable HTTP" : agent.kind}</small></div>
          </div>
          {agent.methods.length > 1 && (
            <div className="segmented" role="radiogroup" aria-label="Setup method">
              {agent.methods.map((m) => (
                <button type="button" role="radio" aria-checked={m.id === method.id} className={m.id === method.id ? "active" : ""} key={m.id} onClick={() => setMethodId(m.id)}>{m.label}</button>
              ))}
            </div>
          )}
        </div>
        <ol className="setup-steps">
          {method.steps.map((step, i) => (
            <li key={i}>
              <p>{step.text}</p>
              {step.code && <CodeBlock code={step.code(url, shown)} copyText={step.code(url, real)} copy={copy} file={step.file} />}
            </li>
          ))}
        </ol>
        {(agent.note || agent.docs) && (
          <div className="agent-guide-foot">
            {agent.note && <p>{agent.note}</p>}
            {agent.docs && <a className="text-button docs-link" href={agent.docs} target="_blank" rel="noopener noreferrer">{agent.name} docs <ArrowUpRight size={13} /></a>}
          </div>
        )}
      </section>

      <section className="panel agents-tokens">
        <div className="section-heading"><h2>Gateway tokens</h2><span className="count">{s.tokens.length}</span></div>
        {s.tokens.length ? <div className="table-scroll">
          <table>
            <thead><tr><th>Name</th>{s.tokens.some((t: Data) => !t.mine) && <th>Owner</th>}<th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {s.tokens.map((t: Data) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  {s.tokens.some((x: Data) => !x.mine) && <td className="muted">{t.mine ? "You" : t.owner}</td>}
                  <td className="muted">{when(t.createdAt)}</td>
                  <td className="muted">{t.lastUsedAt ? when(t.lastUsedAt) : "Never"}</td>
                  <td className="muted">{when(t.expiresAt)}</td>
                  <td><button className="text-button" disabled={busy} onClick={() => onRevoke(t)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div> : <Empty icon={LockKeyhole} title="No gateway tokens" action={<button className="primary" onClick={onCreate}><Plus size={16} /> Create token</button>}>Create one token per agent or device, so you can revoke each independently.</Empty>}
      </section>
    </div>
  );
}
function ToolsForm({ data: c, busy, onSave, onCancel }: any) {
  const [off, setOff] = useState<Set<string>>(new Set(c.disabledTools || []));
  const [filter, setFilter] = useState("");
  const toggle = (name: string) => {
    const next = new Set(off);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOff(next);
  };
  const tools = (c.tools as Data[]).filter((t) =>
    `${t.name} ${t.description || ""}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <form className="form-body" onSubmit={(e) => { e.preventDefault(); onSave([...off]); }}>
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools…" aria-label="Filter tools" /></div>
        <span>{c.tools.length - off.size} of {c.tools.length} on</span>
        <button type="button" className="text-button" onClick={() => setOff(new Set())}>All on</button>
        <button type="button" className="text-button" onClick={() => setOff(new Set(c.tools.map((t: Data) => t.name)))}>All off</button>
      </div>
      <div className="tool-list">
        {tools.map((t) => (
          <label className="check-row" key={t.name}>
            <input type="checkbox" checked={!off.has(t.name)} onChange={() => toggle(t.name)} />
            <span><code>{t.name}</code>{t.annotations?.readOnlyHint && <span className="tag">read-only</span>}{t.annotations?.destructiveHint && <span className="tag danger-tag">destructive</span>}<small>{t.description}</small></span>
          </label>
        ))}
        {!tools.length && <p className="muted">No tools match.</p>}
      </div>
      <FormActions busy={busy} onCancel={onCancel} label="Save tool access" />
    </form>
  );
}
// Mirrors v0's settings: tabs on the left, uppercase section labels, and bordered lists of
// rows with the label on the left and the control on the right. Changes apply in place.
function SettingSection({ heading, danger, children }: { heading: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className="setting-section">
      <h3 className={danger ? "setting-danger" : ""}>{heading}</h3>
      <div className={`setting-list ${danger ? "setting-danger" : ""}`}>{children}</div>
    </section>
  );
}
function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text"><div>{label}</div>{hint && <small>{hint}</small>}</div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}
function SettingsPage({ state: s, busy, canConfigure, appearance, copy, onDialog, onName, onTheme, onSignOut, onSignOutEverywhere }: any) {
  const tabs = [
    ["general", "General", Settings2],
    ["account", "Account", UserRound],
    ...(s.org ? [["organization", "Organization", Users]] : []),
    ["gateway", "Gateway", Zap],
  ] as [string, string, any][];
  const [tab, setTab] = useState("general");
  const active = tabs.some(([id]) => id === tab) ? tab : "general";
  const settings = s.settings[0];
  const [name, setName] = useState(settings.name);
  const me = s.org?.members?.find((m: Data) => m.you);
  return (
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label="Settings sections" role="tablist">
        {tabs.map(([id, label, Icon]) => (
          <button type="button" role="tab" aria-selected={active === id} className={active === id ? "active" : ""} key={id} onClick={() => setTab(id)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>
      <div className="settings-content" role="tabpanel">
        {active === "general" && (
          <>
            <SettingSection heading="Workspace">
              <SettingRow label="Name" hint={s.org ? "The organization’s name, shown to every member." : "Shown in the sidebar and the browser tab."}>
                <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); onName(name.trim()); }}>
                  <input aria-label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canConfigure} minLength={2} maxLength={80} required />
                  {name.trim() !== settings.name && canConfigure && <button className="primary compact" disabled={busy || name.trim().length < 2}>Save</button>}
                </form>
              </SettingRow>
              <SettingRow label="Current workspace" hint={s.org ? `Organization · you are ${s.identity.role === "admin" ? "an admin" : "a member"}` : "Personal · only you"}>
                <button className="secondary compact" onClick={() => onDialog({ type: "workspaces" })}>Switch</button>
              </SettingRow>
            </SettingSection>
            <SettingSection heading="Appearance">
              <SettingRow label="Theme" hint={<>Ctrl+Shift+T switches between light and dark.</>}>
                <select aria-label="Theme" value={appearance} onChange={(e) => onTheme(e.target.value)}>
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </SettingRow>
            </SettingSection>
            {!canConfigure && <p className="muted settings-note">Only organization admins can rename this workspace.</p>}
          </>
        )}
        {active === "account" && (
          <>
            <SettingSection heading="Profile">
              <SettingRow label="Name" hint={s.identity.displayName || s.identity.user} />
              <SettingRow label="Email" hint={s.identity.email || "Not set"} />
            </SettingSection>
            <SettingSection heading="Security">
              <SettingRow label="Password" hint="Changing it signs out your other devices and revokes your gateway tokens.">
                <button className="secondary compact" onClick={() => onDialog({ type: "password" })}>Change</button>
              </SettingRow>
              <SettingRow label="This session" hint="Sessions end after an hour of inactivity, or eight hours after sign-in.">
                <button className="secondary compact" disabled={busy} onClick={onSignOut}>Sign out</button>
              </SettingRow>
            </SettingSection>
            <SettingSection heading="Danger zone" danger>
              <SettingRow label="Sign out everywhere" hint="Ends every session and revokes all your gateway tokens, disconnecting your agents.">
                <button className="danger compact" disabled={busy} onClick={onSignOutEverywhere}>Sign out everywhere</button>
              </SettingRow>
            </SettingSection>
          </>
        )}
        {active === "organization" && s.org && (
          <>
            <SettingSection heading="Organization">
              <SettingRow label="Your role" hint={s.identity.role === "admin" ? "You can manage connections, members and settings." : "You can use connected apps but not change them."}>
                <span className="tag">{s.identity.role}</span>
              </SettingRow>
              <SettingRow label="Members" hint={`${s.org.members.length} ${s.org.members.length === 1 ? "person" : "people"}${s.org.invites.length ? ` · ${s.org.invites.length} pending invite${s.org.invites.length === 1 ? "" : "s"}` : ""}`}>
                <a className="secondary compact button-link" href="#team">Manage</a>
              </SettingRow>
            </SettingSection>
            <SettingSection heading="Danger zone" danger>
              {s.identity.role === "admin" ? (
                <SettingRow label="Delete organization" hint="Destroys every connection and credential in it and removes all members.">
                  <button className="danger compact" onClick={() => onDialog({ type: "delete-org" })}>Delete</button>
                </SettingRow>
              ) : (
                <SettingRow label="Leave organization" hint="You lose access immediately and your tokens for it are revoked.">
                  <button className="danger compact" disabled={!me} onClick={() => onDialog({ type: "remove-member", data: me })}>Leave</button>
                </SettingRow>
              )}
            </SettingSection>
          </>
        )}
        {active === "gateway" && (
          <>
            <SettingSection heading="Endpoints">
              <SettingRow label="MCP URL" hint={<code>{mcpUrl()}</code>}>
                <button className="icon-button" aria-label="Copy MCP URL" onClick={() => copy(mcpUrl(), "MCP URL")}><Copy size={15} /></button>
              </SettingRow>
              <SettingRow label="OAuth redirect URI" hint={<><code>{s.oauthRedirectUri}</code><br />Register this with apps you connect through your own OAuth client.</>}>
                <button className="icon-button" aria-label="Copy redirect URI" onClick={() => copy(s.oauthRedirectUri, "Redirect URI")}><Copy size={15} /></button>
              </SettingRow>
            </SettingSection>
            <SettingSection heading="Security">
              <SettingRow label="Credential vault" hint="AES-256-GCM, bound to this workspace and each connection. Never sent to the browser or to agents." />
              <SettingRow label="Outbound access" hint="Only HTTPS hosts allowed by the server’s OUTBOUND_HOSTS, never private addresses." />
              <SettingRow label="Gateway tokens" hint={`${s.tokens.length} active · each can list and call tools, nothing else.`}>
                <a className="secondary compact button-link" href="#connect-agents">Manage</a>
              </SettingRow>
            </SettingSection>
          </>
        )}
      </div>
    </div>
  );
}
function TeamPage({ state: s, busy, isAdmin, onDialog, onRole, onRevokeInvite }: any) {
  if (!s.org)
    return (
      <section className="panel">
        <Empty icon={Users} title="Create an organization" action={<button className="primary" onClick={() => onDialog({ type: "new-org" })}><Plus size={16} /> Create organization</button>}>
          Share connections with teammates. Whoever creates an organization is its first admin and can make anyone else an admin.
        </Empty>
      </section>
    );
  const members: Data[] = s.org.members;
  return (
    <>
      <section className="panel">
        <div className="section-heading"><h2>Members</h2><span className="count">{members.length}</span></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Member</th><th>Role</th><th>Joined</th><th>Actions</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td><div className="table-name"><span className="avatar">{(m.name || m.email).slice(0, 1).toUpperCase()}</span><div><strong>{m.name}{m.you && <span className="tag you-tag">You</span>}</strong><small>{m.email}</small></div></div></td>
                  <td><span className="tag">{m.role}</span></td>
                  <td className="muted">{when(m.joinedAt)}</td>
                  <td>
                    <div className="row-actions">
                      {isAdmin && <button className="text-button" disabled={busy} onClick={() => onRole(m, m.role === "admin" ? "member" : "admin")}>{m.role === "admin" ? "Make member" : "Make admin"}</button>}
                      {(isAdmin || m.you) && <button className="text-button" disabled={busy} onClick={() => onDialog({ type: "remove-member", data: m })}>{m.you ? "Leave" : "Remove"}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {isAdmin && (
        <section className="panel">
          <div className="section-heading"><h2>Pending invites</h2><span className="count">{s.org.invites.length}</span></div>
          {s.org.invites.length ? (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Role</th><th>Created</th><th>Expires</th><th /></tr></thead>
                <tbody>
                  {s.org.invites.map((i: Data) => (
                    <tr key={i.id}><td><span className="tag">{i.role}</span></td><td className="muted">{when(i.createdAt)}</td><td className="muted">{when(i.expiresAt)}</td><td><button className="text-button" disabled={busy} onClick={() => onRevokeInvite(i)}>Revoke</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={Users} title="No pending invites">
              Invite links are single use and expire after 7 days.
            </Empty>
          )}
        </section>
      )}
      {isAdmin && (
        <section className="panel">
          <div className="section-heading"><h2>Delete organization</h2></div>
          <div className="settings-body">
            <p className="muted">Destroys every connection and credential in this organization and removes all members.</p>
            <button className="danger" onClick={() => onDialog({ type: "delete-org" })}><Trash2 size={15} /> Delete organization</button>
          </div>
        </section>
      )}
    </>
  );
}

// ── Skills ────────────────────────────────────────────────────────────────────
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const parseCount = (v: string | null) => {
  if (!v) return 0;
  const m = /^([\d.]+)([KM]?)$/.exec(v);
  return m ? Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1) : 0;
};
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}
// One honest signal per skill: installs where skills.sh lists the skill, otherwise repository stars.
function SkillSignal({ skill }: { skill: Data }) {
  return skill.installs ? (
    <span className="signal"><span><strong>{skill.installs}</strong> installs</span><small>skills.sh</small></span>
  ) : (
    <span className="signal"><span><strong>{compact(skill.repoStars)}</strong> stars</span><small>GitHub repo</small></span>
  );
}
function SkillsPage({ state: s, busy, canConfigure, search, setSearch, onOpen, onToggle }: any) {
  const [category, setCategory] = useState("All");
  const skills: Data[] = s.skills;
  const categories = [...new Set(skills.map((k) => k.category))];
  const q = search.toLowerCase();
  const shown = skills
    .filter((k) => (category === "All" || (category === "On" ? k.enabled : k.category === category)) && `${k.title} ${k.id} ${k.description}`.toLowerCase().includes(q))
    .sort((a, b) => parseCount(b.installs) - parseCount(a.installs) || (b.repoStars || 0) - (a.repoStars || 0) || a.title.localeCompare(b.title));
  const on = skills.filter((k) => k.enabled).length;
  return (
    <>
      <Toolbar search={search} setSearch={setSearch} placeholder="Search skills…" count={`${on} of ${skills.length} on`} />
      <div className="catalog-filters" role="radiogroup" aria-label="Category">
        {["All", ...categories, ...(on ? ["On"] : [])].map((c) => (
          <button type="button" role="radio" aria-checked={category === c} className={category === c ? "active" : ""} key={c} onClick={() => setCategory(c)}>{c === "On" ? `Turned on · ${on}` : c}</button>
        ))}
      </div>
      <section className="panel">
        {shown.length ? (
          <div className="skill-list">
            {shown.map((k) => (
              <div className={`skill-row ${k.enabled ? "on" : ""}`} key={k.id}>
                <div className="skill-main">
                  <button type="button" className="skill-name" onClick={() => onOpen(k)}>{k.title}</button>
                  <span className="skill-meta"><code>{k.id}</code> · {k.category} · {k.source.repo} · {k.source.license}</span>
                  <p>{k.description}</p>
                </div>
                <SkillSignal skill={k} />
                <Switch checked={k.enabled} label={`Use ${k.title}`} disabled={busy || !canConfigure} onChange={(v) => onToggle(k, v)} />
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={BookOpen} title="No skills found">Try another search or category.</Empty>
        )}
      </section>
      <p className="footnote">
        Install counts are from skills.sh and stars from GitHub, as of {new Date(skills[0]?.signalsAsOf || Date.now()).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}. Skills are bundled from their repositories at a pinned commit and reach your agents only when turned on{canConfigure ? "" : "; an admin turns them on"}.
      </p>
    </>
  );
}
function SkillDetail({ skill, busy, canConfigure, onToggle }: any) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/skills/${skill.id}`).then((d) => setText(d.text), (e) => setError((e as Error).message));
  }, [skill.id]);
  return (
    <div className="form-body skill-detail">
      <div className="skill-facts">
        <div><small>Source</small><a href={skill.url} target="_blank" rel="noopener noreferrer">{skill.source.repo} <ArrowUpRight size={12} /></a></div>
        <div><small>Licence</small><span>{skill.source.license}</span></div>
        <div><small>Version</small><code>{skill.source.commit.slice(0, 7)}</code></div>
        <div><small>Popularity</small><SkillSignal skill={skill} /></div>
        <div className="skill-toggle">
          <small>{skill.enabled ? "On for your agents" : "Off"}</small>
          <Switch checked={skill.enabled} label={`Use ${skill.title}`} disabled={busy || !canConfigure} onChange={onToggle} />
        </div>
      </div>
      <p className="muted">Agents load it as the <code>{skill.id}</code> prompt, or through the <code>orbytlink__use_skill</code> tool.</p>
      <div className="skill-doc">{error ? <p className="error">{error}</p> : text ? <Markdown text={text} /> : <LoaderCircle className="spin" size={18} />}</div>
    </div>
  );
}
// A small, safe Markdown renderer for skill documents: no HTML is ever injected.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return /^https:\/\//.test(link[2]) ? <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a> : <span key={i}>{link[1]}</span>;
    return part;
  });
}
function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  const special = /^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|---+\s*$|>|\|)/;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(<pre key={i}>{code.join("\n")}</pre>);
    } else if (/^#{1,4}\s/.test(l)) {
      const level = l.indexOf(" ");
      const Tag = (["h2", "h3", "h4", "h5"] as const)[Math.min(level, 4) - 1];
      blocks.push(<Tag key={i}>{inline(l.slice(level + 1))}</Tag>);
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={i}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</List>);
    } else if (/^---+\s*$/.test(l)) {
      blocks.push(<hr key={i} />);
      i++;
    } else if (l.startsWith(">")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={i}>{inline(quote.join(" "))}</blockquote>);
    } else if (l.startsWith("|")) {
      const rows: string[] = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
      blocks.push(<pre key={i}>{rows.join("\n")}</pre>);
    } else if (!l.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !special.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(<p key={i}>{inline(para.join(" "))}</p>);
    }
  }
  return <div className="markdown">{blocks}</div>;
}

// ── Workflows ─────────────────────────────────────────────────────────────────
type ToolInfo = { name: string; app: string; connection?: Data; def: Data };
function toolIndex(s: Data): ToolInfo[] {
  return s.gatewayTools.map((t: Data) => {
    const connection = s.connections.find((c: Data) => c.id === t.connectionId);
    return { name: t.name, app: connection?.name || "", connection, def: connection?.tools?.find((x: Data) => x.name === t.tool) || { name: t.tool } };
  });
}
const blankWorkflow = () => ({ name: "", description: "", inputs: [], steps: [{ id: "step_1", tool: "", args: {} }], enabled: false });
const cleanWorkflow = (wf: Data) => ({
  name: wf.name,
  description: wf.description || "",
  inputs: (wf.inputs || []).map((i: Data) => ({ name: i.name, description: i.description || "", required: i.required !== false })),
  steps: (wf.steps || []).map((st: Data) => ({
    id: st.id,
    tool: st.tool,
    args: Object.fromEntries(Object.entries(st.args || {}).filter(([, v]) => String(v).trim() !== "")),
  })),
  enabled: !!wf.enabled,
});
// Bind a template to the tools actually connected; unmatched steps keep a hint for the person.
function bindTemplate(t: WorkflowTemplate, tools: ToolInfo[]) {
  return {
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    enabled: false,
    steps: t.steps.map((st) => {
      const match = tools.find((x) => st.tool.test(x.name));
      const props = Object.keys(match?.def.inputSchema?.properties || {});
      const args: Record<string, string> = {};
      for (const key of props) {
        const hint = st.args.find(([re]) => re.test(key));
        if (hint) args[key] = hint[1];
      }
      return { id: st.id, tool: match?.name || "", args, hint: match ? undefined : { app: st.app, label: st.label } };
    }),
  };
}
function AppMarks({ tools, steps }: { tools: ToolInfo[]; steps: Data[] }) {
  const apps: ToolInfo[] = [];
  for (const st of steps) {
    const t = tools.find((x) => x.name === st.tool);
    if (t && !apps.some((a) => a.app === t.app)) apps.push(t);
  }
  if (!apps.length) return null;
  return (
    <span className="app-marks">
      {apps.slice(0, 4).map((a) => <AppLogo key={a.app} preset={a.connection && presetFor(a.connection)} kind="mcp" />)}
    </span>
  );
}
function WorkflowsPage({ state: s, busy, canConfigure, onEdit, onTemplate, onRun, onToggle, onDelete }: any) {
  const tools = toolIndex(s);
  const workflows: Data[] = s.workflows;
  const drafts = workflows.filter((w) => !w.enabled && w.source === "agent").length;
  const runs: Data[] = s.workflowRuns;
  return (
    <>
      {drafts > 0 && canConfigure && (
        <div className="info-row"><Workflow size={17} /><p><strong>{drafts} {drafts === 1 ? "draft" : "drafts"} from agents</strong> {drafts === 1 ? "needs" : "need"} review. Open it, check each step, then enable it.</p></div>
      )}
      <section className="panel">
        <div className="section-heading"><h2>Your workflows</h2><span className="count">{workflows.length}</span></div>
        {workflows.length ? (
          <div className="table-scroll">
            <table className="wf-table">
              <thead><tr><th>Workflow</th><th>Apps</th><th>Status</th><th>Last run</th><th>Actions</th></tr></thead>
              <tbody>
                {workflows.map((wf) => (
                  <tr key={wf.id}>
                    <td>
                      <div className="wf-name"><strong>{wf.name}</strong>{wf.source === "agent" && <span className="tag">by agent</span>}</div>
                      <small>{wf.description || `${wf.steps.length} ${wf.steps.length === 1 ? "step" : "steps"}`}</small>
                    </td>
                    <td><div className="wf-apps"><AppMarks tools={tools} steps={wf.steps} /><small>{wf.steps.length} {wf.steps.length === 1 ? "step" : "steps"}</small></div></td>
                    <td><Status value={wf.enabled ? "Enabled" : "Draft"} /></td>
                    <td>{wf.lastRunAt ? <div className="wf-last"><Status value={wf.lastStatus} /><small>{when(wf.lastRunAt)}</small></div> : <small>Never</small>}</td>
                    <td>
                      <div className="row-actions">
                        <button className="secondary compact" disabled={busy || (!wf.enabled && !canConfigure)} onClick={() => onRun(wf)}><Play size={12} /> Run</button>
                        {canConfigure && <button className="text-button" onClick={() => onEdit(wf)}>{wf.source === "agent" && !wf.enabled ? "Review" : "Edit"}</button>}
                        {canConfigure && <button className="text-button" disabled={busy} onClick={() => onToggle(wf)}>{wf.enabled ? "Disable" : "Enable"}</button>}
                        {canConfigure && <button className="icon-button" aria-label={`Delete ${wf.name}`} onClick={() => onDelete(wf)}><Trash2 size={15} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Workflow} title="No workflows yet">Start from a template below, build one step by step, or ask your agent to draft one.</Empty>
        )}
      </section>
      <section className="catalog-segment" aria-label="Templates">
        <h2>Start from a template</h2>
        <div className="catalog-grid">
          {workflowTemplates.map((t) => {
            const missing = t.steps.filter((st) => !tools.some((x) => st.tool.test(x.name))).map((st) => st.app);
            return (
              <button type="button" className="catalog-card" key={t.id} disabled={!canConfigure} onClick={() => onTemplate(t)} aria-label={`Use template: ${t.name}`}>
                <span className="template-marks">{[...new Set(t.steps.map((st) => st.logo))].map((l) => <BrandTile key={l} id={l} name={l} />)}</span>
                <span className="catalog-body">
                  <span className="catalog-name">{t.name}</span>
                  <span className="catalog-desc">{t.description}</span>
                  {missing.length > 0 && <span className="template-needs">Needs {[...new Set(missing)].join(" and ")}</span>}
                </span>
                <ArrowUpRight className="catalog-arrow" size={16} />
              </button>
            );
          })}
        </div>
      </section>
      <div className="info-row">
        <Workflow size={17} />
        <p>Or describe the task to your agent, for example: <em>“Make an OrbytLink workflow that files a Linear issue and posts it in #eng.”</em> It drafts one with <code>orbytlink__create_workflow</code>, and the draft waits here until an admin enables it.</p>
      </div>
      <section className="panel">
        <div className="section-heading"><h2>Recent runs</h2><span className="count">{runs.length}</span></div>
        {runs.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Workflow</th><th>Result</th><th>Steps</th><th>Started by</th><th>When</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.workflow}</strong></td>
                    <td><Status value={r.status} /></td>
                    <td className="muted">{r.steps.filter((x: Data) => x.status === "ok").length}/{r.steps.length} · {r.steps.reduce((n: number, x: Data) => n + x.ms, 0)} ms</td>
                    <td className="muted">{r.trigger === "agent" ? "Agent" : "Console"} · {r.user}</td>
                    <td className="muted">{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Activity} title="No runs yet">Runs record each step’s result and timing. Inputs and outputs are not stored.</Empty>
        )}
      </section>
    </>
  );
}
function WorkflowEditor({ state: s, data, busy, copy, onSave, onCancel }: any) {
  const tools = toolIndex(s);
  const [wf, setWf] = useState<Data>(() => JSON.parse(JSON.stringify(data.draft)));
  const [error, setError] = useState("");
  const set = (patch: Data) => setWf((w) => ({ ...w, ...patch }));
  const setStep = (i: number, patch: Data) => set({ steps: wf.steps.map((st: Data, n: number) => (n === i ? { ...st, ...patch } : st)) });
  const setInput = (i: number, patch: Data) => set({ inputs: wf.inputs.map((x: Data, n: number) => (n === i ? { ...x, ...patch } : x)) });
  const apps = [...new Set(tools.map((t) => t.app))];
  return (
    <form
      className="form-body wf-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (wf.steps.some((st: Data) => !st.tool)) return setError("Choose a tool for every step.");
        setError("");
        onSave(cleanWorkflow(wf));
      }}
    >
      <div className="form-grid">
        <Field label="Name"><input value={wf.name} onChange={(e) => set({ name: e.target.value })} required minLength={2} maxLength={80} placeholder="e.g. File and announce a bug" /></Field>
        <Field label="Description" hint="Shown to agents next to the workflow’s tool."><input value={wf.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} /></Field>
      </div>

      <div className="wf-section">
        <div className="wf-section-head"><h3>Inputs</h3><small>Values given at each run. Use them in steps as <code>{"{{input.name}}"}</code>.</small></div>
        {wf.inputs.map((input: Data, i: number) => (
          <div className="wf-input" key={i}>
            <input aria-label="Input name" className="code-input" value={input.name} onChange={(e) => setInput(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="name" required />
            <input aria-label="Input description" value={input.description} onChange={(e) => setInput(i, { description: e.target.value })} placeholder="What it is" />
            <label className="check-row"><input type="checkbox" checked={input.required !== false} onChange={(e) => setInput(i, { required: e.target.checked })} /> Required</label>
            <button type="button" className="icon-button" aria-label="Remove input" onClick={() => set({ inputs: wf.inputs.filter((_: Data, n: number) => n !== i) })}><Trash2 size={15} /></button>
          </div>
        ))}
        <button type="button" className="text-button add-row" disabled={wf.inputs.length >= 10} onClick={() => set({ inputs: [...wf.inputs, { name: `input_${wf.inputs.length + 1}`, description: "", required: true }] })}><Plus size={14} /> Add input</button>
      </div>

      <div className="wf-section">
        <div className="wf-section-head"><h3>Steps</h3><small>Run in order. A failed step stops the run.</small></div>
        {!tools.length && <div className="info-row"><LockKeyhole size={17} /><p>No tools are available yet. Connect an app and pass its test first.</p></div>}
        <ol className="wf-steps">
          {wf.steps.map((st: Data, i: number) => {
            const tool = tools.find((t) => t.name === st.tool);
            const props: Record<string, Data> = tool?.def.inputSchema?.properties || {};
            const required: string[] = tool?.def.inputSchema?.required || [];
            const keys = [...new Set([...Object.keys(props), ...Object.keys(st.args || {})])];
            const refs = [...wf.inputs.map((x: Data) => `{{input.${x.name}}}`), ...wf.steps.slice(0, i).map((p: Data) => `{{steps.${p.id}.text}}`)];
            return (
              <li className="wf-step" key={i}>
                <div className="wf-step-head">
                  <span className="wf-step-n">{i + 1}</span>
                  <input aria-label="Step id" className="code-input wf-step-id" value={st.id} onChange={(e) => setStep(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} required />
                  <select aria-label="Tool" value={st.tool} onChange={(e) => setStep(i, { tool: e.target.value, args: {}, hint: undefined })} required>
                    <option value="">{st.hint ? `Choose a ${st.hint.app} tool…` : "Choose a tool…"}</option>
                    {apps.map((app) => (
                      <optgroup label={app} key={app}>
                        {tools.filter((t) => t.app === app).map((t) => <option value={t.name} key={t.name}>{t.def.title || t.def.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <button type="button" className="icon-button" aria-label={`Remove step ${i + 1}`} disabled={wf.steps.length === 1} onClick={() => set({ steps: wf.steps.filter((_: Data, n: number) => n !== i) })}><Trash2 size={15} /></button>
                </div>
                {st.hint && !st.tool && <p className="wf-hint">This template step needs {st.hint.app} ({st.hint.label.toLowerCase()}). Connect {st.hint.app} and test it, or choose another tool.</p>}
                {tool && (
                  <div className="wf-args">
                    {keys.length === 0 && <p className="muted">This tool takes no arguments.</p>}
                    {keys.map((key) => (
                      <label className="wf-arg" key={key}>
                        <span><code>{key}</code>{required.includes(key) && <em>required</em>}</span>
                        <input value={st.args?.[key] ?? ""} onChange={(e) => setStep(i, { args: { ...st.args, [key]: e.target.value } })} placeholder={props[key]?.description || props[key]?.type || ""} />
                      </label>
                    ))}
                    {refs.length > 0 && (
                      <div className="wf-refs">
                        <small>Insert:</small>
                        {refs.map((r: string) => <button type="button" key={r} className="ref-chip" onClick={() => copy(r, "Reference")}>{r}</button>)}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <button type="button" className="text-button add-row" disabled={wf.steps.length >= 20} onClick={() => set({ steps: [...wf.steps, { id: `step_${wf.steps.length + 1}`, tool: "", args: {} }] })}><Plus size={14} /> Add step</button>
      </div>

      <label className="check-row"><input type="checkbox" checked={!!wf.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enable: agents can call it as <code>workflow__…</code> and members can run it</label>
      {error && <div className="error">{error}</div>}
      <FormActions busy={busy} onCancel={onCancel} label="Save workflow" />
    </form>
  );
}
function RunWorkflow({ workflow, onDone }: { workflow: Data; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Data | null>(null);
  const [error, setError] = useState("");
  return (
    <form
      className="form-body"
      onSubmit={async (e) => {
        e.preventDefault();
        setRunning(true);
        setError("");
        setResult(null);
        try {
          setResult(await api(`/workflows/${workflow.id}/run`, { inputs: values }));
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setRunning(false);
        }
      }}
    >
      {!workflow.enabled && <div className="info-row"><LockKeyhole size={17} /><p>This is a draft. Running it here is how you test it before enabling.</p></div>}
      {(workflow.inputs || []).map((i: Data) => (
        <Field key={i.name} label={i.description || i.name} hint={`{{input.${i.name}}}`}>
          <input value={values[i.name] || ""} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} required={i.required !== false} />
        </Field>
      ))}
      {!(workflow.inputs || []).length && <p className="muted">This workflow takes no inputs.</p>}
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="run-result">
          <ol>
            {result.steps.map((st: Data) => (
              <li key={st.id} className={`run-${st.status}`}>
                <span className="run-dot" />
                <code>{st.id}</code>
                <span className="muted">{st.tool}</span>
                <span className="run-ms">{st.status === "skipped" ? "skipped" : `${st.ms} ms`}</span>
                {st.error && <p>{st.error}</p>}
              </li>
            ))}
          </ol>
          {result.output && <><small className="muted">Output of the last step</small><pre className="code-block">{result.output.slice(0, 4000)}</pre></>}
        </div>
      )}
      <div className="form-footer">
        <button className="primary" disabled={running}>{running ? <LoaderCircle size={15} className="spin" /> : <Play size={13} />} {result ? "Run again" : "Run workflow"}</button>
      </div>
    </form>
  );
}

// ── APIs ──────────────────────────────────────────────────────────────────────
const authLabels: Record<string, string> = { bearer: "Bearer token", header: "Header", query: "Query parameter", basic: "Basic auth", none: "No key" };
// What the server needs to save an API again without touching its key or docs.
const apiPayload = (a: Data) => ({ name: a.name, description: a.description || "", baseUrl: a.baseUrl, docsUrl: a.docsUrl || "", auth: a.auth, authName: a.authName || "X-API-Key", headers: a.headers || {}, bodyFormat: a.bodyFormat || "json", access: a.access, enabled: a.enabled });
const presetApiDraft = (p: ApiPreset): Data => ({
  _preset: p,
  name: p.name,
  description: p.description,
  baseUrl: p.baseUrl,
  docsUrl: p.docsUrl,
  auth: p.auth,
  authName: p.authName,
  headers: p.headers || {},
  bodyFormat: p.bodyFormat || "json",
  access: "read",
  enabled: true,
});
const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).hostname;
  } catch {
    return "";
  }
};
// A saved API takes its preset's look when it is on the preset's host ({placeholders} match one label).
const presetForApi = (a: Data) => {
  const host = hostOf(a.baseUrl);
  return apiPresets.find((p) => {
    const pattern = p.baseUrl.split("/")[2].split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^.]+");
    return new RegExp(`^${pattern}$`, "i").test(host);
  });
};
// Brand mark first, then the logo fetched from the API's site, then a monogram.
function ApiLogo({ a }: { a: Data }) {
  const preset = presetForApi(a);
  if (preset && brands[`api-${preset.id}`]) return <BrandTile id={`api-${preset.id}`} name={a.name} />;
  if (a.logo)
    return (
      <div className="app-icon logo" title={a.name}>
        <img src={a.logo} alt={`${a.name} logo`} width={22} height={22} />
      </div>
    );
  return <BrandTile id={`api-${preset?.id || a.id}`} name={a.name} />;
}
function ApiPresets({ apis, canConfigure, onPreset, compact }: { apis: Data[]; canConfigure: boolean; onPreset: (p: ApiPreset) => void; compact: boolean }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const q = query.toLowerCase();
  const shown = apiPresets.filter((p) => (category === "All" || p.category === category) && `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q));
  const added = (p: ApiPreset) => apis.some((a) => presetForApi(a)?.id === p.id);
  return (
    <section className="api-presets" aria-label="Popular APIs">
      <div className="api-presets-head">
        <div>
          <h2>{compact ? "Add another API" : "Popular APIs"}</h2>
          <p>Pick one, paste your key, and its docs and endpoints are set up for you.</p>
        </div>
        <div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${apiPresets.length} APIs…`} aria-label="Search APIs" /></div>
      </div>
      <div className="catalog-filters" role="radiogroup" aria-label="API category">
        {["All", ...apiCategories].map((c) => (
          <button type="button" role="radio" aria-checked={category === c} className={category === c ? "active" : ""} key={c} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      {shown.length ? (
        <div className="catalog-grid">
          {shown.map((p) => {
            const on = added(p);
            return (
              <button type="button" className="catalog-card" key={p.id} disabled={!canConfigure} title={canConfigure ? undefined : "Only admins can add APIs"} aria-label={`Connect ${p.name}`} onClick={() => onPreset(p)}>
                <BrandTile id={`api-${p.id}`} name={p.name} />
                <span className="catalog-body">
                  <span className="catalog-name">{p.name}{on && <span className="catalog-status idle"><i />Added</span>}</span>
                  <span className="catalog-desc">{p.description}</span>
                </span>
                <ArrowUpRight className="catalog-arrow" size={16} />
              </button>
            );
          })}
        </div>
      ) : (
        <p className="muted">No preset matches. Use Add API for any other HTTPS API.</p>
      )}
    </section>
  );
}
function KeyState({ a }: { a: Data }) {
  if (a.auth === "none") return <span className="api-chip">No key needed</span>;
  return a.hasKey ? <span className="api-chip"><KeyRound size={12} />{a.keyHint ? `••••${a.keyHint}` : "Key saved"}</span> : <span className="api-chip warn">No key</span>;
}
function ApisPage({ state: s, busy, canConfigure, onOpen, onPreset, onToggle }: any) {
  const apis: Data[] = s.apis;
  const calls: Data[] = s.apiCalls;
  return (
    <>
      {apis.length > 0 && (
        <section className="panel">
          <div className="api-list">
            {apis.map((a) => (
              <div className="api-row" key={a.id}>
                <button type="button" className="api-open" onClick={() => onOpen(a)} aria-label={`Open ${a.name}`}>
                  <ApiLogo a={a} />
                  <span className="api-text">
                    <strong>{a.name}</strong>
                    <code>{a.baseUrl}</code>
                  </span>
                </button>
                <span className="api-chips">
                  <span className="api-chip">{a.docsFormat ? (a.endpointCount ? `${a.docsFormat} · ${a.endpointCount} endpoints` : `Docs · ${a.docsFormat.toLowerCase()}`) : a.docsError ? "Docs unavailable" : "No docs"}</span>
                  <KeyState a={a} />
                  <span className="api-chip">{a.access === "write" ? "Read & write" : "Read only"}</span>
                </span>
                <Switch checked={!!a.enabled} label={`Use ${a.name}`} disabled={busy || !canConfigure} onChange={(v) => onToggle(a, v)} />
              </div>
            ))}
          </div>
        </section>
      )}
      <ApiPresets apis={apis} canConfigure={canConfigure} onPreset={onPreset} compact={apis.length > 0} />
      <div className="info-row">
        <LockKeyhole size={17} />
        <p>Keys are encrypted with AES-256-GCM, never shown again, and only ever sent to the host they were saved for. Moving an API to another host discards its key. Agents use <code>orbytlink__api_docs</code> and <code>orbytlink__api_request</code>; writes are off unless you allow them.</p>
      </div>
      {calls.length > 0 && (
        <section className="panel">
          <div className="section-heading"><h2>Recent requests</h2><span className="count">{calls.length}</span></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>API</th><th>Request</th><th>Status</th><th>Time</th><th>When</th></tr></thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.api}</strong></td>
                    <td><code className="api-req"><b>{c.method}</b> {c.path}</code></td>
                    <td><span className={`http ${c.status < 300 ? "ok" : c.status < 500 ? "warn" : "bad"}`}>{c.status}</span></td>
                    <td className="muted">{c.ms} ms</td>
                    <td className="muted">{when(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
function ApiForm({ data: d, busy, onSave, onCancel }: any) {
  const preset: ApiPreset | undefined = d?._preset;
  const [auth, setAuth] = useState(d?.auth || "bearer");
  const headerText = Object.entries(d?.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
  const [error, setError] = useState("");
  const [docsMode, setDocsMode] = useState(d?.docsSource === "pasted" ? "paste" : "url");
  const [access, setAccess] = useState(d?.access || "read");
  const [baseUrl, setBaseUrl] = useState(d?.baseUrl || "");
  const sameHost = (() => {
    try {
      return !d?.baseUrl || new URL(baseUrl).origin === new URL(d.baseUrl).origin;
    } catch {
      return true;
    }
  })();
  return (
    <form
      className="form-body"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        if (/[{}]/.test(baseUrl)) return setError("Replace the {placeholders} in the base URL with your account’s values.");
        const headers: Data = {};
        for (const line of String(f.get("headers") || "").split("\n")) {
          if (!line.trim()) continue;
          const at = line.indexOf(":");
          if (at < 1) return setError(`Write each header as "Name: value" (${line.trim()})`);
          headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        setError("");
        onSave({
          headers,
          bodyFormat: f.get("bodyFormat") || "json",
          name: f.get("name"),
          description: f.get("description") || "",
          baseUrl,
          docsUrl: docsMode === "url" ? f.get("docsUrl") || "" : d?.docsUrl || "",
          ...(docsMode === "paste" && String(f.get("docsText") || "").trim() ? { docsText: f.get("docsText") } : {}),
          auth,
          authName: f.get("authName") || "X-API-Key",
          ...(f.get("key") ? { key: f.get("key") } : {}),
          access,
          enabled: f.get("enabled") === "on",
        });
      }}
    >
      {preset && (
        <div className="preset-notes">
          <div className="info-row">
            <KeyRound size={17} />
            <div>
              <p>{preset.keyHint}</p>
              {preset.note && <p>{preset.note}</p>}
              <p>The server must allow <code>{hostOf(preset.baseUrl)}</code> in <code>OUTBOUND_HOSTS</code>.</p>
            </div>
          </div>
        </div>
      )}
      <div className="form-grid">
        <Field label="Name"><input name="name" defaultValue={d?.name || ""} required minLength={2} maxLength={80} autoFocus={!preset} placeholder="e.g. Stripe, Billing API" /></Field>
        <Field label="What it’s for" hint="Optional. Agents see it."><input name="description" defaultValue={d?.description || ""} maxLength={300} placeholder="e.g. Invoices and customers" /></Field>
      </div>
      <Field label="Base URL" hint={/[{}]/.test(baseUrl) ? "Replace the parts in {braces} with your account’s values." : "HTTPS. Requests can only go to paths under it. The host must be allowed in OUTBOUND_HOSTS."}>
        <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder="https://api.example.com/v1" className="code-input" />
      </Field>
      <div className="field">
        <span>Documentation</span>
        <div className="segmented" role="radiogroup" aria-label="Documentation source">
          {[["url", "Docs URL"], ["paste", "Paste docs"]].map(([v, l]) => (
            <button type="button" role="radio" aria-checked={docsMode === v} className={docsMode === v ? "active" : ""} key={v} onClick={() => setDocsMode(v)}>{l}</button>
          ))}
        </div>
        {docsMode === "url" ? (
          <input name="docsUrl" type="url" defaultValue={d?.docsUrl || ""} placeholder="https://api.example.com/openapi.json" className="code-input" />
        ) : (
          <textarea name="docsText" rows={6} className="code-input" placeholder="Paste an OpenAPI spec (JSON or YAML) or the docs as text" />
        )}
        <small>{docsMode === "url" ? "An OpenAPI spec (JSON or YAML) gives agents an endpoint index; any docs page works as text." : "For private APIs. Up to 200 KB."}</small>
      </div>
      <div className="form-grid">
        <Field label="Authentication">
          <select value={auth} onChange={(e) => setAuth(e.target.value)}>
            {Object.entries(authLabels).map(([v, l]) => <option value={v} key={v}>{v === "none" ? "No key" : l}</option>)}
          </select>
        </Field>
        {(auth === "header" || auth === "query") && (
          <Field label={auth === "header" ? "Header name" : "Parameter name"}>
            <input name="authName" defaultValue={d?.authName || (auth === "header" ? "X-API-Key" : "api_key")} required pattern="[A-Za-z0-9!#$%&'*+.^_`|~\-]{1,64}" className="code-input" />
          </Field>
        )}
      </div>
      {auth !== "none" && (
        <Field
          label={d?.hasKey && sameHost ? "Replace key" : "Key"}
          hint={
            d?.hasKey && !sameHost
              ? "This moves the API to another host, so the saved key will be discarded. Enter the key for the new host."
              : d?.hasKey
                ? `A key ending ${d.keyHint || "…"} is saved. Leave blank to keep it.`
                : auth === "basic"
                  ? "Enter as user:password. Encrypted on the server and never shown again."
                  : "Encrypted on the server and never shown again."
          }
        >
          <input name="key" type="password" autoComplete="new-password" maxLength={4096} required={!d?.hasKey || !sameHost} autoFocus={!!preset} placeholder={d?.hasKey && sameHost ? "Leave blank to keep the saved key" : "Paste the key"} />
        </Field>
      )}
      <div className="field">
        <span>Agent access</span>
        <div className="access-options" role="radiogroup" aria-label="Agent access">
          {[
            ["read", "Read only", "GET and HEAD requests."],
            ["write", "Read and write", "Also POST, PUT, PATCH and DELETE. Agents can change data."],
          ].map(([v, l, h]) => (
            <button type="button" role="radio" aria-checked={access === v} className={`access-option ${access === v ? "active" : ""}`} key={v} onClick={() => setAccess(v)}>
              <strong>{l}</strong><small>{h}</small>
            </button>
          ))}
        </div>
      </div>
      <details className="advanced">
        <summary>Advanced{Object.keys(d?.headers || {}).length ? ` · ${Object.keys(d.headers).length} fixed ${Object.keys(d.headers).length === 1 ? "header" : "headers"}` : ""}{d?.bodyFormat === "form" ? " · form bodies" : ""}</summary>
        <Field label="Fixed headers" hint="Non-secret headers sent with every request, one per line as Name: value. Keys belong in the key field.">
          <textarea name="headers" rows={2} className="code-input" defaultValue={headerText} placeholder="Notion-Version: 2022-06-28" />
        </Field>
        <Field label="Request body format">
          <select name="bodyFormat" defaultValue={d?.bodyFormat || "json"}>
            <option value="json">JSON</option>
            <option value="form">Form-encoded (Stripe, Twilio)</option>
          </select>
        </Field>
      </details>
      <label className="check-row"><input type="checkbox" name="enabled" defaultChecked={d?.enabled ?? true} /> Available to agents</label>
      {error && <div className="error">{error}</div>}
      <FormActions busy={busy} onCancel={onCancel} label={d?.id ? "Save API" : preset ? `Connect ${preset.name}` : "Add API"} />
    </form>
  );
}
function ApiDetail({ api: a, busy, canConfigure, onEdit, onDelete, onRefreshDocs }: any) {
  const [tab, setTab] = useState(a.endpointCount ? "endpoints" : "try");
  const [docs, setDocs] = useState<Data | null>(null);
  const [filter, setFilter] = useState("");
  const methods = a.access === "write" ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] : ["GET", "HEAD"];
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/apis/${a.id}/docs`).then(setDocs, () => setDocs({ endpoints: [], docs: "" }));
  }, [a.id, a.docsFetchedAt]);
  const endpoints: Data[] = (docs?.endpoints || []).filter((e: Data) => `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(filter.toLowerCase()));
  const send = async () => {
    setSending(true);
    setError("");
    setResult(null);
    try {
      const q: Data = {};
      for (const line of query.split("\n")) {
        const at = line.indexOf("=");
        if (line.trim() && at > 0) q[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      let parsed: unknown;
      if (body.trim() && !["GET", "HEAD"].includes(method)) {
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error("The body must be valid JSON.");
        }
      }
      setResult(await api(`/apis/${a.id}/request`, { method, path, query: q, ...(parsed !== undefined ? { body: parsed } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="form-body api-detail">
      <div className="skill-facts">
        <ApiLogo a={a} />
        <div><small>Base URL</small><code>{a.baseUrl}</code></div>
        <div><small>Key</small><span>{authLabels[a.auth]} · <KeyState a={a} /></span></div>
        <div><small>Agents</small><span>{a.enabled ? (a.access === "write" ? "Read and write" : "Read only") : "Off"}</span></div>
        <div><small>Docs</small><span>{a.docsFormat ? `${a.docsFormat}${a.docsFetchedAt ? ` · ${when(a.docsFetchedAt)}` : ""}` : "None"}</span></div>
        {canConfigure && (
          <div className="api-actions">
            {a.docsUrl && <button className="secondary compact" disabled={busy} onClick={onRefreshDocs}>Refresh docs</button>}
            <button className="secondary compact" onClick={onEdit}>Edit</button>
            <button className="icon-button" aria-label={`Remove ${a.name}`} onClick={onDelete}><Trash2 size={15} /></button>
          </div>
        )}
      </div>
      {a.docsError && <div className="error">{a.docsError}</div>}
      <div className="segmented" role="tablist" aria-label="API sections">
        {[["endpoints", `Endpoints${a.endpointCount ? ` · ${a.endpointCount}` : ""}`], ["docs", "Docs"], ["try", "Try a request"]].map(([v, l]) => (
          <button type="button" role="tab" aria-selected={tab === v} className={tab === v ? "active" : ""} key={v} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      {tab === "endpoints" && (
        <div className="api-endpoints">
          {docs?.endpoints?.length ? (
            <>
              <div className="search-box"><Search size={16} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter endpoints…" aria-label="Filter endpoints" /></div>
              <div className="endpoint-list">
                {endpoints.slice(0, 300).map((e, i) => (
                  <button type="button" key={i} className="endpoint" disabled={!methods.includes(e.method)} title={methods.includes(e.method) ? "Try this request" : "Writes are not allowed for this API"} onClick={() => { setMethod(e.method); setPath(e.path); setTab("try"); }}>
                    <b className={`verb ${e.method.toLowerCase()}`}>{e.method}</b>
                    <code>{e.path}</code>
                    <span>{e.summary}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="muted">No endpoint index. Add an OpenAPI spec as the docs to get one; agents can still read any docs as text.</p>
          )}
        </div>
      )}
      {tab === "docs" && <div className="skill-doc">{docs?.docs ? <pre className="api-docs">{docs.docs}</pre> : <p className="muted">No documentation stored.</p>}</div>}
      {tab === "try" && (
        <div className="api-try">
          <div className="api-line">
            <select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map((m) => <option key={m}>{m}</option>)}</select>
            <div className="api-path"><span>{a.baseUrl.replace(/\/$/, "")}</span><input aria-label="Path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/resource" /></div>
            <button className="primary" disabled={sending || !a.enabled} onClick={send}>{sending ? <LoaderCircle size={15} className="spin" /> : "Send"}</button>
          </div>
          <div className="form-grid">
            <label className="field"><span>Query</span><textarea rows={3} className="code-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={"limit=10\nstatus=open"} /></label>
            <label className="field"><span>JSON body</span><textarea rows={3} className="code-input" value={body} onChange={(e) => setBody(e.target.value)} disabled={["GET", "HEAD"].includes(method)} placeholder={["GET", "HEAD"].includes(method) ? "Not sent with GET or HEAD" : '{ "amount": 500 }'} /></label>
          </div>
          <p className="muted">Sent from OrbytLink’s server with the saved key attached. The key never reaches this browser.</p>
          {error && <div className="error">{error}</div>}
          {result && (
            <div className="api-response">
              <div className="api-response-head"><span className={`http ${result.status < 300 ? "ok" : result.status < 500 ? "warn" : "bad"}`}>{result.status}</span><span className="muted">{result.ms} ms{result.contentType ? ` · ${result.contentType.split(";")[0]}` : ""}{result.truncated ? " · truncated" : ""}</span></div>
              <pre>{typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
