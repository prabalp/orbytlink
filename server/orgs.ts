import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Express, Request } from "express";
import type { Store } from "./store.js";
import { allPermissions, type Identity } from "./schema.js";

// An organization is a shared workspace: connections, credentials, tokens and activity
// belong to the workspace, and memberships decide who may use or change them. A person's
// own workspace is always theirs alone; every account keeps it next to any organizations.
export type Role = "admin" | "member";
// Admins configure; members use the gateway and see what is connected, nothing more.
export const rolePermissions: Record<Role, string[]> = {
  admin: allPermissions,
  member: ["read", "call"],
};
const INVITE_DAYS = 7,
  MAX_ORGS = 10,
  MAX_INVITES = 50;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Business-rule failures whose message is safe to show.
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const forbidden = (message: string) => Object.assign(new Error(message), { status: 403 });

type AccountRow = {
  id: string;
  email: string;
  name: string;
  workspace: string;
  active_workspace?: string | null;
};

export function initializeOrgTables(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(account_id TEXT NOT NULL,workspace TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('admin','member')),created_at INTEGER NOT NULL,PRIMARY KEY(account_id,workspace));
CREATE INDEX IF NOT EXISTS memberships_workspace ON memberships(workspace);
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,role TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS invites_workspace ON invites(workspace);`);
  const has = (table: string, column: string) =>
    (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
  if (!has("accounts", "active_workspace"))
    store.db.exec("ALTER TABLE accounts ADD COLUMN active_workspace TEXT");
  // A gateway token belongs to one workspace; earlier tokens belonged to their owner's own.
  if (!has("access_tokens", "workspace"))
    store.db.exec("ALTER TABLE access_tokens ADD COLUMN workspace TEXT");
  store.db.exec(
    "UPDATE access_tokens SET workspace=(SELECT workspace FROM accounts WHERE accounts.id=access_tokens.account_id) WHERE workspace IS NULL",
  );
  store.db.exec(
    "INSERT OR IGNORE INTO memberships(account_id,workspace,role,created_at) SELECT id,workspace,'admin',created_at FROM accounts",
  );
}

export function roleIn(store: Store, accountId: string, workspace: string): Role | undefined {
  return (
    store.db
      .prepare("SELECT role FROM memberships WHERE account_id=? AND workspace=?")
      .get(accountId, workspace) as { role: Role } | undefined
  )?.role;
}
const orgOf = (store: Store, workspace: string) =>
  store.db.prepare("SELECT * FROM orgs WHERE id=?").get(workspace) as
    | { id: string; name: string; created_by: string }
    | undefined;

// Who an account is acting as: its active workspace when it is still a member, otherwise its own.
// With `workspace` set (gateway tokens), membership is required and there is no fallback.
export function identityFor(store: Store, a: AccountRow, workspace?: string): Identity | undefined {
  store.db
    .prepare("INSERT OR IGNORE INTO memberships(account_id,workspace,role,created_at) VALUES(?,?,'admin',?)")
    .run(a.id, a.workspace, Date.now());
  let w = workspace ?? a.active_workspace ?? a.workspace;
  let role = roleIn(store, a.id, w);
  if (!role) {
    if (workspace) return;
    w = a.workspace;
    role = "admin";
  }
  const org = orgOf(store, w);
  return {
    user: a.email,
    email: a.email,
    displayName: a.name,
    workspace: w,
    workspaceName: org?.name ?? `${a.name}’s workspace`,
    role,
    org: !!org,
    permissions: rolePermissions[role],
    demo: false,
    authMethod: "email",
  };
}

// Everything the console needs to render workspaces, members and invites for this viewer.
export function describe(store: Store, accountId: string | undefined, identity: Identity) {
  if (!accountId) return { workspaces: [], org: null };
  const me = store.db.prepare("SELECT name,workspace FROM accounts WHERE id=?").get(accountId) as
    | { name: string; workspace: string }
    | undefined;
  const workspaces = (
    store.db
      .prepare(
        "SELECT m.workspace,m.role,o.name FROM memberships m LEFT JOIN orgs o ON o.id=m.workspace WHERE m.account_id=? ORDER BY (o.id IS NOT NULL),o.name",
      )
      .all(accountId) as { workspace: string; role: Role; name: string | null }[]
  ).map((m) => ({
    id: m.workspace,
    name: m.name ?? `${me?.name}’s workspace`,
    kind: m.name === null ? "personal" : "org",
    role: m.role,
    current: m.workspace === identity.workspace,
  }));
  if (!identity.org) return { workspaces, org: null };
  const org = orgOf(store, identity.workspace)!;
  const members = (
    store.db
      .prepare(
        "SELECT a.id,a.name,a.email,m.role,m.created_at FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.workspace=? AND a.disabled=0 ORDER BY m.role,m.created_at",
      )
      .all(identity.workspace) as { id: string; name: string; email: string; role: Role; created_at: number }[]
  ).map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.created_at, you: m.id === accountId }));
  const invites =
    identity.role === "admin"
      ? (
          store.db
            .prepare("SELECT id,role,created_at,expires FROM invites WHERE workspace=? AND expires>? ORDER BY created_at DESC")
            .all(identity.workspace, Date.now()) as { id: string; role: Role; created_at: number; expires: number }[]
        ).map((i) => ({ id: i.id, role: i.role, createdAt: i.created_at, expiresAt: i.expires }))
      : [];
  return { workspaces, org: { id: org.id, name: org.name, role: identity.role, members, invites } };
}

// An organization renamed from Settings keeps its name here in step.
export function syncOrgName(store: Store, workspace: string, name: string) {
  store.db.prepare("UPDATE orgs SET name=? WHERE id=?").run(name, workspace);
}

const nameSchema = z.object({ name: z.string().trim().min(2).max(80) });
const roleSchema = z.object({ role: z.enum(["admin", "member"]) });
const tokenSchema = z.object({ token: z.string().regex(/^oi_[A-Za-z0-9_-]{43}$/) });

export function configureOrgs(app: Express, store: Store) {
  const caller = (req: Request) => {
    const identity = (req.res as any).locals.identity as Identity;
    const accountId = (req.user as any)?.id as string | undefined;
    // Organization management is for people signed in to the console, never for gateway tokens.
    if (identity.authMethod !== "email" || !accountId)
      throw forbidden("Sign in with your account to manage organizations.");
    return { identity, accountId };
  };
  const admin = (req: Request) => {
    const c = caller(req);
    if (!c.identity.org) throw conflict("This is your personal workspace. Create an organization first.");
    if (c.identity.role !== "admin") throw forbidden("Only organization admins can do this.");
    return c;
  };
  const admins = (workspace: string) =>
    (store.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace=? AND role='admin'").get(workspace) as { n: number }).n;
  const detach = (accountId: string, workspace: string) => {
    store.db.prepare("DELETE FROM memberships WHERE account_id=? AND workspace=?").run(accountId, workspace);
    store.db.prepare("DELETE FROM access_tokens WHERE account_id=? AND workspace=?").run(accountId, workspace);
    store.db.prepare("UPDATE accounts SET active_workspace=NULL WHERE id=? AND active_workspace=?").run(accountId, workspace);
  };

  app.post("/api/orgs", (req, res) => {
    const { identity, accountId } = caller(req);
    const { name } = nameSchema.parse(req.body);
    const owned = (store.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE created_by=?").get(accountId) as { n: number }).n;
    if (owned >= MAX_ORGS) throw conflict(`You can create up to ${MAX_ORGS} organizations.`);
    const id = randomUUID();
    store.transaction(() => {
      store.db.prepare("INSERT INTO orgs(id,name,created_by,created_at) VALUES(?,?,?,?)").run(id, name, accountId, Date.now());
      // Whoever creates an organization is its first admin.
      store.db.prepare("INSERT INTO memberships(account_id,workspace,role,created_at) VALUES(?,?,'admin',?)").run(accountId, id, Date.now());
      store.put(id, "settings", { id: "workspace", name, appearance: "dark" });
      store.db.prepare("UPDATE accounts SET active_workspace=? WHERE id=?").run(id, accountId);
      store.audit(id, identity.user, "org.created", name);
    });
    res.json({ id, name });
  });

  app.post("/api/workspaces/switch", (req, res) => {
    const { accountId } = caller(req);
    const { workspace } = z.object({ workspace: z.string().max(64) }).parse(req.body);
    if (!roleIn(store, accountId, workspace)) throw forbidden("You are not a member of that workspace.");
    store.db.prepare("UPDATE accounts SET active_workspace=? WHERE id=?").run(workspace, accountId);
    res.json({ ok: true });
  });

  app.put("/api/org", (req, res) => {
    const { identity } = admin(req);
    const { name } = nameSchema.parse(req.body);
    store.transaction(() => {
      syncOrgName(store, identity.workspace, name);
      const settings = store.get(identity.workspace, "settings", "workspace");
      store.put(identity.workspace, "settings", { ...settings, name });
      store.audit(identity.workspace, identity.user, "org.renamed", name);
    });
    res.json({ ok: true });
  });

  app.delete("/api/org", (req, res) => {
    const { identity } = admin(req);
    const org = orgOf(store, identity.workspace)!;
    // Deleting destroys every connection credential, so the admin must type the name.
    if (z.object({ confirm: z.string() }).parse(req.body).confirm !== org.name)
      throw conflict("Type the organization name exactly to delete it.");
    const w = identity.workspace;
    store.transaction(() => {
      for (const table of ["records", "secrets", "invites", "memberships", "access_tokens"])
        store.db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(w);
      store.db.prepare("UPDATE accounts SET active_workspace=NULL WHERE active_workspace=?").run(w);
      store.db.prepare("DELETE FROM orgs WHERE id=?").run(w);
    });
    res.json({ ok: true });
  });

  app.post("/api/org/invites", (req, res) => {
    const { identity, accountId } = admin(req);
    const { role } = roleSchema.parse(req.body);
    store.db.prepare("DELETE FROM invites WHERE expires<=?").run(Date.now());
    const pending = (store.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE workspace=?").get(identity.workspace) as { n: number }).n;
    if (pending >= MAX_INVITES) throw conflict("Revoke some pending invites before creating more.");
    // Possession of the link is the invitation: shown once, stored only as a hash, single use.
    const token = `oi_${randomBytes(32).toString("base64url")}`,
      id = randomUUID(),
      expires = Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000;
    store.db
      .prepare("INSERT INTO invites(id,workspace,token_hash,role,created_by,created_at,expires) VALUES(?,?,?,?,?,?,?)")
      .run(id, identity.workspace, digest(token), role, accountId, Date.now(), expires);
    store.audit(identity.workspace, identity.user, "invite.created", role);
    res.json({ id, token, role, expiresAt: expires });
  });

  app.delete("/api/org/invites/:id", (req, res) => {
    const { identity } = admin(req);
    const gone = store.db.prepare("DELETE FROM invites WHERE id=? AND workspace=?").run(String(req.params.id), identity.workspace);
    if (!gone.changes) throw Object.assign(new Error("Record not found"), { status: 404 });
    store.audit(identity.workspace, identity.user, "invite.revoked", String(req.params.id).slice(0, 8));
    res.json({ ok: true });
  });

  const findInvite = (token: string) =>
    store.db
      .prepare("SELECT i.*,o.name AS org_name FROM invites i JOIN orgs o ON o.id=i.workspace WHERE i.token_hash=? AND i.expires>?")
      .get(digest(token), Date.now()) as
      | { id: string; workspace: string; role: Role; org_name: string }
      | undefined;
  const invalid = () => conflict("This invite link is invalid, expired or already used.");

  app.post("/api/invites/preview", (req, res) => {
    caller(req);
    const invite = findInvite(tokenSchema.parse(req.body).token);
    if (!invite) throw invalid();
    res.json({ org: invite.org_name, role: invite.role });
  });

  app.post("/api/invites/accept", (req, res) => {
    const { identity, accountId } = caller(req);
    const { token } = tokenSchema.parse(req.body);
    const w = store.transaction(() => {
      const invite = findInvite(token);
      if (!invite) throw invalid();
      // Joining twice keeps the existing role and leaves the invite for its intended person.
      if (!roleIn(store, accountId, invite.workspace)) {
        store.db.prepare("DELETE FROM invites WHERE id=?").run(invite.id);
        store.db.prepare("INSERT INTO memberships(account_id,workspace,role,created_at) VALUES(?,?,?,?)").run(accountId, invite.workspace, invite.role, Date.now());
        store.audit(invite.workspace, identity.user, "member.joined", invite.role);
      }
      store.db.prepare("UPDATE accounts SET active_workspace=? WHERE id=?").run(invite.workspace, accountId);
      return invite.workspace;
    });
    res.json({ workspace: w });
  });

  app.put("/api/org/members/:id", (req, res) => {
    const { identity } = admin(req);
    const { role } = roleSchema.parse(req.body);
    const target = String(req.params.id),
      current = roleIn(store, target, identity.workspace);
    if (!current) throw Object.assign(new Error("Record not found"), { status: 404 });
    if (current === "admin" && role === "member" && admins(identity.workspace) <= 1)
      throw conflict("An organization needs at least one admin. Make someone else an admin first.");
    store.db.prepare("UPDATE memberships SET role=? WHERE account_id=? AND workspace=?").run(role, target, identity.workspace);
    const who = store.db.prepare("SELECT email FROM accounts WHERE id=?").get(target) as { email: string };
    store.audit(identity.workspace, identity.user, "member.role-changed", `${who.email} · ${role}`);
    res.json({ ok: true });
  });

  // Admins remove anyone; anyone may remove themselves (leave).
  app.delete("/api/org/members/:id", (req, res) => {
    const { identity, accountId } = caller(req);
    if (!identity.org) throw conflict("This is your personal workspace.");
    const target = String(req.params.id),
      self = target === accountId;
    if (!self && identity.role !== "admin") throw forbidden("Only organization admins can remove members.");
    const current = roleIn(store, target, identity.workspace);
    if (!current) throw Object.assign(new Error("Record not found"), { status: 404 });
    if (current === "admin" && admins(identity.workspace) <= 1)
      throw conflict("You are the only admin. Make someone else an admin, or delete the organization.");
    const who = store.db.prepare("SELECT email FROM accounts WHERE id=?").get(target) as { email: string };
    store.transaction(() => {
      detach(target, identity.workspace);
      store.audit(identity.workspace, identity.user, self ? "member.left" : "member.removed", who.email);
    });
    res.json({ ok: true });
  });
}
