import session from "express-session";
import { Passport } from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import {
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Express, Request, Response, NextFunction } from "express";
import { Store } from "./store.js";
import { gatewayPermissions, type Identity } from "./schema.js";
import { identityFor, initializeOrgTables } from "./orgs.js";
import { configureGoogleAuth, googleConfigured } from "./google.js";
const scryptAsync = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
const duration = 8 * 60 * 60 * 1000,
  idle = 60 * 60 * 1000;
export type Account = {
  id: string;
  email: string;
  name: string;
  workspace: string;
  password_hash: string;
  disabled: number;
  active_workspace?: string | null;
};
const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(12).max(128),
});
const signinSchema = signupSchema.pick({ email: true, password: true });
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const derive = (store: Store, label: string) =>
  Buffer.from(
    hkdfSync("sha256", store.key, Buffer.alloc(0), label, 32),
  ).toString("hex");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt)) as Buffer;
  return `scrypt:32768:8:3:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash?: string) {
  const [_scheme, _n, _r, _p, salt, key] = (
    hash || `scrypt:32768:8:3:${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  if (!salt || !key) return false;
  const actual = (await scryptAsync(password, salt)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected) &&
    !!hash
  );
}
export function initializeAuthTables(store: Store) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,workspace TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(sid_hash TEXT PRIMARY KEY,account_id TEXT,expires INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS access_tokens(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires INTEGER NOT NULL,permissions TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_account ON access_tokens(account_id);`);
  // Gateway tokens are named and listed; the earlier 15-minute tokens had neither.
  const columns = (
    store.db.prepare("PRAGMA table_info(access_tokens)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!columns.includes("id")) {
    store.db.exec(`DELETE FROM access_tokens;
ALTER TABLE access_tokens ADD COLUMN id TEXT;
ALTER TABLE access_tokens ADD COLUMN name TEXT;
ALTER TABLE access_tokens ADD COLUMN created_at INTEGER;
ALTER TABLE access_tokens ADD COLUMN last_used INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS tokens_id ON access_tokens(id);`);
  }
  const accountColumns = (
    store.db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!accountColumns.includes("google_sub"))
    store.db.exec(`ALTER TABLE accounts ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_google ON accounts(google_sub) WHERE google_sub IS NOT NULL;`);
  initializeOrgTables(store);
}
export async function createAccount(store: Store, input: unknown) {
  const data = signupSchema.parse(input),
    hash = await passwordHash(data.password),
    id = randomUUID(),
    workspace = randomUUID();
  return store.transaction(() => {
    store.db
      .prepare(
        "INSERT INTO accounts(id,email,name,workspace,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, data.email, data.name, workspace, hash, Date.now());
    store.seed(workspace);
    store.audit(workspace, data.email, "account.created", id);
    return store.db
      .prepare("SELECT * FROM accounts WHERE id=?")
      .get(id) as Account;
  });
}
export async function resetAccountPassword(
  store: Store,
  email: string,
  password: string,
) {
  const normalized = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email())
    .parse(email);
  const valid = z.string().min(12).max(128).parse(password),
    hash = await passwordHash(valid);
  return store.transaction(() => {
    const account = store.db
      .prepare("SELECT * FROM accounts WHERE email=?")
      .get(normalized) as Account | undefined;
    if (!account) throw new Error("Account not found");
    store.db
      .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
      .run(hash, account.id);
    store.db.prepare("DELETE FROM sessions WHERE account_id=?").run(account.id);
    store.db
      .prepare("DELETE FROM access_tokens WHERE account_id=?")
      .run(account.id);
    store.audit(
      account.workspace,
      account.email,
      "account.password-changed",
      account.id,
    );
  });
}
class SqliteSessionStore extends session.Store {
  constructor(private store: Store) {
    super();
  }
  get(
    sid: string,
    callback: (error: any, data?: session.SessionData | null) => void,
  ) {
    try {
      const record = this.store.db
        .prepare("SELECT data FROM sessions WHERE sid_hash=? AND expires>?")
        .get(digest(sid), Date.now()) as { data: string } | undefined;
      callback(null, record ? JSON.parse(record.data) : null);
    } catch (error) {
      callback(error);
    }
  }
  set(
    sid: string,
    data: session.SessionData,
    callback?: (error?: any) => void,
  ) {
    try {
      const expires = Math.min(
        Date.now() + idle,
        Number(data.createdAt) + duration,
      );
      if (!Number.isFinite(expires) || expires <= Date.now()) {
        this.destroy(sid, callback);
        return;
      }
      this.store.db
        .prepare("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)")
        .run(
          digest(sid),
          (data as any).passport?.user || null,
          expires,
          JSON.stringify(data),
        );
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }
  touch(
    sid: string,
    data: session.SessionData,
    callback?: (error?: any) => void,
  ) {
    try {
      const expires = Math.min(
        Date.now() + idle,
        Number(data.createdAt) + duration,
      );
      if (!Number.isFinite(expires) || expires <= Date.now()) {
        this.destroy(sid, callback);
        return;
      }
      // A request finishing after revocation must never recreate a deleted session.
      this.store.db
        .prepare("UPDATE sessions SET expires=? WHERE sid_hash=?")
        .run(expires, digest(sid));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }
  destroy(sid: string, callback?: (error?: any) => void) {
    try {
      this.store.db
        .prepare("DELETE FROM sessions WHERE sid_hash=?")
        .run(digest(sid));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }
}
export function configureEmailAuth(app: Express, store: Store) {
  initializeAuthTables(store);
  const production = process.env.NODE_ENV === "production";
  // Trust only a deliberately configured, private reverse proxy. The default trusts none.
  if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
  if (production && !process.env.APP_ORIGIN?.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must be HTTPS");
  // Expired sessions and gateway tokens are already unusable; remove them hourly.
  const sweep = () =>
    store.transaction(() => {
      store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
      store.db.prepare("DELETE FROM access_tokens WHERE expires<=?").run(Date.now());
    });
  sweep();
  setInterval(() => {
    try {
      sweep();
    } catch {
      // The database is closing; nothing to sweep.
    }
  }, 60 * 60 * 1000).unref();
  const passport = new Passport();
  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password" },
      async (email: string, password: string, done: any) => {
        try {
          const account = store.db
            .prepare("SELECT * FROM accounts WHERE email=?")
            .get(email.trim().toLowerCase()) as Account | undefined;
          const valid = await verifyPassword(password, account?.password_hash);
          if (!valid || !account || account.disabled) {
            done(null, false);
            return;
          }
          done(null, { id: account.id });
        } catch {
          done(new Error("Sign-in could not be completed"));
        }
      },
    ),
  );
  passport.serializeUser((user: any, done) => done(null, user.id));
  passport.deserializeUser((id: string, done) => {
    try {
      const account = store.db
        .prepare("SELECT * FROM accounts WHERE id=? AND disabled=0")
        .get(id) as Account | undefined;
      done(null, account ? { id: account.id, ...identityFor(store, account) } : false);
    } catch (error) {
      done(error);
    }
  });
  app.use(
    ["/api", "/mcp"],
    session({
      name: "orbyt_session",
      secret: derive(store, "orbytlink:session:v1"),
      store: new SqliteSessionStore(store),
      resave: false,
      saveUninitialized: false,
      rolling: false,
      unset: "destroy",
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: production,
        maxAge: duration,
        path: "/",
      },
    }),
  );
  app.use("/api/auth", (req, res, next) => {
    if (production && !req.secure) {
      res.status(426).json({ error: "HTTPS is required for authentication." });
      return;
    }
    next();
  });
  app.use(["/api", "/mcp"], passport.initialize());
  app.use(["/api", "/mcp"], passport.session());
  app.get("/api/auth/config", (_req, res) =>
    res.json({
      signupEnabled: process.env.ALLOW_SIGNUP !== "false",
      method: "email-password",
      google: googleConfigured(),
    }),
  );
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many attempts. Try again in 15 minutes." },
  });
  const accountLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) =>
      digest(
        `${ipKeyGenerator(req.ip || "127.0.0.1")}:${String(req.body?.email || "").toLowerCase()}`,
      ),
    message: { error: "Too many attempts. Try again in 15 minutes." },
  });
  const finishLogin = (
    req: Request,
    res: Response,
    next: NextFunction,
    account: { id: string },
  ) =>
    req.logIn(account, (error) => {
      if (error) {
        next(error);
        return;
      }
      req.session.createdAt = Date.now();
      req.session.save((error) => {
        if (error) {
          next(error);
          return;
        }
        // Passport initially receives only the account ID; hydrate the public profile.
        const row = store.db.prepare("SELECT * FROM accounts WHERE id=?").get(account.id) as Account;
        res.json({ ok: true, token: "cookie-session", user: {
          id: row.email, _id: row.email, name: row.name, username: row.name, email: row.email,
          role: "USER", provider: "local", emailVerified: true, plugins: [], avatar: "", termsAccepted: true,
        } });
      });
    });
  configureGoogleAuth(
    app,
    store,
    derive(store, "orbytlink:google:v1"),
    authLimit,
    (req, _res, id, done) =>
      req.logIn({ id }, (error) => {
        if (error) return done(error);
        req.session.createdAt = Date.now();
        req.session.save(done);
      }),
  );
  app.post(
    "/api/auth/register",
    authLimit,
    accountLimit,
    async (req, res, next) => {
      if (process.env.ALLOW_SIGNUP === "false") {
        res.status(403).json({
          error:
            "Account registration is disabled. Contact your administrator.",
        });
        return;
      }
      const result = signupSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          error: result.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }
      try {
        const account = await createAccount(store, result.data);
        finishLogin(req, res, next, { id: account.id });
      } catch {
        res.status(400).json({
          error:
            "Could not create an account with these details. Try signing in or contact your administrator.",
        });
      }
    },
  );
  app.post("/api/auth/login", authLimit, accountLimit, (req, res, next) => {
    const result = signinSchema.safeParse(req.body);
    if (!result.success) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    req.body = result.data;
    passport.authenticate("local", (error: any, user: any) => {
      if (error) {
        res.status(503).json({ error: "Sign-in is temporarily unavailable." });
        return;
      }
      if (!user) {
        res.status(401).json({ error: "Email or password is incorrect." });
        return;
      }
      finishLogin(req, res, next, user);
    })(req, res, next);
  });
  app.post("/api/auth/password", authLimit, async (req, res, next) => {
    const user = req.user as any;
    if (!user?.id) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const data = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(12).max(128),
      })
      .safeParse(req.body);
    if (!data.success) {
      res
        .status(400)
        .json({ error: "Use a new password of 12 to 128 characters." });
      return;
    }
    const account = store.db
      .prepare("SELECT * FROM accounts WHERE id=?")
      .get(user.id) as Account;
    if (
      !(await verifyPassword(data.data.currentPassword, account.password_hash))
    ) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    await resetAccountPassword(store, account.email, data.data.newPassword);
    finishLogin(req, res, next, { id: account.id });
  });
  app.post("/api/session/demo", (_req, res) =>
    res.status(410).json({
      error:
        "Demo sign-in has been removed. Sign in with your email and password.",
    }),
  );
  app.post(["/api/session/logout", "/api/auth/logout"], (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("orbyt_session", { path: "/" });
      res.json({ ok: true });
    });
  });
  app.post("/api/auth/logout-all", (req, res) => {
    const user = req.user as any;
    if (!user?.id) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    store.transaction(() => {
      store.db.prepare("DELETE FROM sessions WHERE account_id=?").run(user.id);
      store.db
        .prepare("DELETE FROM access_tokens WHERE account_id=?")
        .run(user.id);
    });
    req.session.destroy(() => {
      res.clearCookie("orbyt_session", { path: "/" });
      res.json({ ok: true });
    });
  });
  return {
    browserIdentity: (req: Request): Identity | undefined => {
      const user = req.user as any;
      return user?.id &&
        req.session.createdAt &&
        Date.now() - req.session.createdAt < duration
        ? {
            user: user.user,
            email: user.email,
            displayName: user.displayName,
            workspace: user.workspace,
            workspaceName: user.workspaceName,
            role: user.role,
            org: user.org,
            permissions: user.permissions,
            demo: false,
            authMethod: "email",
          }
        : undefined;
    },
    verifyAccessToken: (token: string): Identity | undefined => {
      if (!token.startsWith("ol_")) return;
      const hash = digest(token);
      const row = store.db
        .prepare(
          "SELECT a.*,t.permissions,t.last_used,t.workspace AS token_workspace FROM access_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.token_hash=? AND t.expires>? AND a.disabled=0",
        )
        .get(hash, Date.now()) as
        | (Account & { permissions: string; last_used: number | null; token_workspace: string | null })
        | undefined;
      if (!row) return;
      // A token works only while its owner is still a member of the workspace it was made for.
      const who = identityFor(store, row, row.token_workspace ?? row.workspace);
      if (!who) return;
      // Record use at most once a minute to keep MCP traffic from writing on every call.
      if (!row.last_used || Date.now() - row.last_used > 60000)
        store.db
          .prepare("UPDATE access_tokens SET last_used=? WHERE token_hash=?")
          .run(Date.now(), hash);
      const granted = JSON.parse(row.permissions) as string[];
      return {
        ...who,
        permissions: granted.filter((p) => who.permissions.includes(p)),
        authMethod: "token",
      };
    },
    createToken: (req: Request, name: string, days: number) => {
      const user = req.user as any;
      if (!user?.id) throw new Error("Email session required to create a token");
      const token = `ol_${randomBytes(32).toString("base64url")}`,
        id = randomUUID(),
        now = Date.now(),
        expires = now + days * 24 * 60 * 60 * 1000;
      store.db
        .prepare(
          "INSERT INTO access_tokens(token_hash,account_id,expires,permissions,id,name,created_at,last_used,workspace) VALUES(?,?,?,?,?,?,?,NULL,?)",
        )
        .run(digest(token), user.id, expires, JSON.stringify(gatewayPermissions), id, name, now, user.workspace);
      store.audit(user.workspace, user.email, "token.created", name);
      // The plaintext token is returned once and never stored.
      return { id, name, token, createdAt: now, expiresAt: expires };
    },
    // Your own tokens in this workspace; organization admins also see everyone else's.
    listTokens: (req: Request) => {
      const user = req.user as any;
      if (!user?.id) return [];
      const all = user.org && user.role === "admin" ? 1 : 0;
      return (
        store.db
          .prepare(
            "SELECT t.id,t.name,t.created_at,t.expires,t.last_used,t.account_id,a.email FROM access_tokens t JOIN accounts a ON a.id=t.account_id WHERE t.workspace=? AND t.expires>? AND t.id IS NOT NULL AND (t.account_id=? OR ?) ORDER BY t.created_at DESC",
          )
          .all(user.workspace, Date.now(), user.id, all) as any[]
      ).map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.created_at,
        expiresAt: t.expires,
        lastUsedAt: t.last_used,
        owner: t.email,
        mine: t.account_id === user.id,
      }));
    },
    revokeToken: (req: Request, id: string) => {
      const user = req.user as any;
      if (!user?.id) throw Object.assign(new Error("Authentication required"), { status: 401 });
      const row = store.db
        .prepare("SELECT name,account_id FROM access_tokens WHERE id=? AND workspace=?")
        .get(id, user.workspace) as { name: string; account_id: string } | undefined;
      if (!row || (row.account_id !== user.id && !(user.org && user.role === "admin")))
        throw Object.assign(new Error("Record not found"), { status: 404 });
      store.db.prepare("DELETE FROM access_tokens WHERE id=?").run(id);
      store.audit(user.workspace, user.email, "token.revoked", row.name);
    },
  };
}
