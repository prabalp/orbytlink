import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
export type Row = { id: string; [key: string]: any };
export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(
    path = process.env.DATA_DIR || ".data",
    key = process.env.SECRET_KEY,
  ) {
    if (path !== ":memory:") mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!key && process.env.NODE_ENV === "production")
      throw new Error("SECRET_KEY is required");
    if (!key) {
      if (path === ":memory:") key = randomBytes(32).toString("hex");
      else {
        const f = `${path}/encryption.key`;
        if (!existsSync(f))
          writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
        key = readFileSync(f, "utf8").trim();
      }
    }
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error("SECRET_KEY must be 64 hex characters");
    this.key = Buffer.from(key, "hex");
    this.db = new DatabaseSync(
      path === ":memory:" ? path : `${path}/orbytlink.sqlite`,
    );
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (workspace TEXT, kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(workspace,kind,id)); CREATE TABLE IF NOT EXISTS secrets (workspace TEXT, id TEXT, value TEXT, PRIMARY KEY(workspace,id));",
    );
    this.migrateConnections();
  }
  // Older workspaces stored product-specific kinds; they were MCP servers.
  private migrateConnections() {
    const workspaces = this.db
      .prepare("SELECT DISTINCT workspace FROM records WHERE kind='connections'")
      .all() as { workspace: string }[];
    const legacy = new Set(["lead-orbit", "mail-orbit"]);
    for (const { workspace: w } of workspaces)
      for (const c of this.list(w, "connections")) {
        // An untouched placeholder from the old seed is not a real connection.
        if ((c.id === "universal" || legacy.has(c.kind)) && !c.endpoint && !c.hasSecret) {
          this.remove(w, "connections", c.id);
          continue;
        }
        const kind = legacy.has(c.kind) ? "mcp" : c.kind;
        if (c.kind === kind && c.protocol !== undefined && Array.isArray(c.disabledTools)) continue;
        this.put(w, "connections", {
          ...c,
          kind,
          protocol: c.protocol === undefined ? (kind === "auto" ? null : kind) : c.protocol,
          disabledTools: Array.isArray(c.disabledTools) ? c.disabledTools : [],
        });
      }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(w: string, k: string): Row[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM records WHERE workspace=? AND kind=? ORDER BY rowid DESC",
        )
        .all(w, k) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get(w: string, k: string, id: string): Row {
    const r = this.db
      .prepare("SELECT data FROM records WHERE workspace=? AND kind=? AND id=?")
      .get(w, k, id) as { data: string } | undefined;
    if (!r) throw Object.assign(new Error("Record not found"), { status: 404 });
    return JSON.parse(r.data);
  }
  put(w: string, k: string, row: Record<string, any>): Row {
    const r = {
      ...row,
      id: row.id || randomUUID(),
      revision: randomUUID(),
      updatedAt: new Date().toISOString(),
    } as Row;
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(w, k, r.id, JSON.stringify(r));
    return r;
  }
  remove(w: string, k: string, id: string) {
    this.get(w, k, id);
    this.db
      .prepare("DELETE FROM records WHERE workspace=? AND kind=? AND id=?")
      .run(w, k, id);
    // A connection's OAuth tokens live beside its credential as "<id>:oauth-*".
    this.db
      .prepare("DELETE FROM secrets WHERE workspace=? AND (id=? OR id LIKE ?)")
      .run(w, id, `${id}:%`);
  }
  deleteSecret(w: string, id: string) {
    this.db.prepare("DELETE FROM secrets WHERE workspace=? AND id=?").run(w, id);
  }
  // AES-256-GCM. The workspace and record ID are authenticated data, so a ciphertext
  // copied to another workspace or connection fails to decrypt.
  secret(w: string, id: string, value?: string): string | undefined {
    const aad = Buffer.from(`orbytlink:secret:v2:${w}:${id}`, "utf8");
    if (value !== undefined) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", this.key, iv);
      c.setAAD(aad);
      const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
      this.db
        .prepare("INSERT OR REPLACE INTO secrets VALUES(?,?,?)")
        .run(
          w,
          id,
          `v2:${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`,
        );
      return;
    }
    const r = this.db
      .prepare("SELECT value FROM secrets WHERE workspace=? AND id=?")
      .get(w, id) as { value: string } | undefined;
    if (!r) return;
    const parts = r.value.split(":");
    const versioned = parts[0] === "v2";
    const [iv, tag, v] = versioned ? parts.slice(1) : parts;
    const c = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "hex"));
    if (versioned) c.setAAD(aad);
    c.setAuthTag(Buffer.from(tag, "hex"));
    const plain = Buffer.concat([
      c.update(Buffer.from(v, "hex")),
      c.final(),
    ]).toString();
    // Upgrade entries written before authenticated data was bound.
    if (!versioned) this.secret(w, id, plain);
    return plain;
  }
  // Secrets are removed from string values, never from the serialized JSON, so no secret
  // (however short) can corrupt the structure. Secrets under 8 characters are too common
  // to cut out of running text; they are redacted only where they are the whole value.
  redact(w: string, value: unknown): any {
    const ids = this.db
      .prepare("SELECT id FROM secrets WHERE workspace=?")
      .all(w) as { id: string }[];
    const secrets = ids
      .map(({ id }) => this.secret(w, id))
      .filter((v): v is string => !!v)
      .sort((a, b) => b.length - a.length);
    const text = (s: string) => {
      if (secrets.includes(s)) return "[REDACTED]";
      for (const v of secrets) if (v.length >= 8) s = s.split(v).join("[REDACTED]");
      return s.replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, "$1[REDACTED]");
    };
    const scrub = (v: any): any =>
      typeof v === "string"
        ? text(v)
        : Array.isArray(v)
          ? v.map(scrub)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, val]) => [
                  k,
                  /^(password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)$/i.test(
                    k,
                  )
                    ? "[REDACTED]"
                    : scrub(val),
                ]),
              )
            : v;
    // Round-trip first so the result is plain JSON data, as callers expect.
    return scrub(JSON.parse(JSON.stringify(value) ?? "null"));
  }
  // Keep only the newest `keep` rows of an append-only log.
  trim(w: string, k: string, keep: number) {
    this.db
      .prepare(
        "DELETE FROM records WHERE workspace=? AND kind=? AND rowid NOT IN (SELECT rowid FROM records WHERE workspace=? AND kind=? ORDER BY rowid DESC LIMIT ?)",
      )
      .run(w, k, w, k, keep);
  }
  audit(w: string, user: string, action: string, target: string) {
    this.put(w, "audit", {
      user,
      action,
      target,
      createdAt: new Date().toISOString(),
    });
    this.trim(w, "audit", 2000);
  }
  seed(w: string) {
    if (this.list(w, "settings").length) return;
    this.put(w, "settings", {
      id: "workspace",
      name: "OrbytLink",
      appearance: "dark",
    });
  }
}
