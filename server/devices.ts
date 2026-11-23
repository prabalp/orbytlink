import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Store, Row } from "./store.js";

// "Your browser": an extension a person installs in their own Chrome profile. It pairs with a
// workspace once (a short code from the console), then asks this server for work over HTTP long-polling
// and answers with the same page state the server's own browser produces. The extension only connects
// outward, so nothing on the person's machine is reachable from here. Page actions are carried out
// there, in the person's real, logged-in browser; the choosing of the next action stays on the server.
//
// A device row holds a label and a hash of its token, never the token itself. Pending work lives in
// memory: a restart simply makes the extension re-poll, and an agent's call falls back to the server's
// browser when no device answers.
export type Command = { id: string; type: "open" | "act" | "wait_for_user" | "close"; [key: string]: unknown };
export type DeviceReply = { id: string; ok: boolean; error?: string | null; state?: unknown; stop?: boolean };
type Waiter = { resolve: (r: DeviceReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; device: string };
type Live = { queue: Command[]; poll?: (commands: Command[]) => void; seen: number; private?: boolean };

const POLL_MS = 20_000;
const ONLINE_MS = 45_000;
const PAIR_MS = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status, safe: true });

const live = new Map<string, Live>();
const waiting = new Map<string, Waiter>();
const codes = new Map<string, { workspace: string; user: string; exp: number }>();

export type DeviceInfo = { id: string; label: string; online: boolean; lastSeen: string | null; createdAt: string; browser?: string; privateWindow?: boolean };
const devicesOf = (store: Store, w: string) => store.list(w, "devices");
export const deviceSummary = (store: Store, w: string): DeviceInfo[] =>
  devicesOf(store, w).map((d) => ({
    id: d.id,
    label: d.label,
    online: isOnline(d.id),
    lastSeen: live.get(d.id)?.seen ? new Date(live.get(d.id)!.seen).toISOString() : d.lastSeen || null,
    createdAt: d.createdAt,
    browser: d.browser,
    privateWindow: live.get(d.id)?.private,
  }));
const isOnline = (id: string) => Date.now() - (live.get(id)?.seen ?? 0) < ONLINE_MS;
export const onlineDevices = (store: Store, w: string) => devicesOf(store, w).filter((d) => isOnline(d.id));
export const hasDevices = (store: Store, w: string) => devicesOf(store, w).length > 0;

// The newest-seen online device, or the one the caller named.
export function pickDevice(store: Store, w: string, label?: string): Row | undefined {
  const online = onlineDevices(store, w);
  const named = label ? online.filter((d) => d.label.toLowerCase() === label.toLowerCase()) : online;
  return named.sort((a, b) => (live.get(b.id)?.seen ?? 0) - (live.get(a.id)?.seen ?? 0))[0];
}

// A short code the person types into the extension. It is good for ten minutes and for one pairing.
export function startPairing(store: Store, w: string, user: string) {
  for (const [code, c] of codes) if (c.exp < Date.now()) codes.delete(code);
  let code = "";
  do code = randomBytes(4).toString("hex").toUpperCase().replace(/(.{4})/, "$1-");
  while (codes.has(code));
  const exp = Date.now() + PAIR_MS;
  codes.set(code, { workspace: w, user, exp });
  store.audit(w, user, "browser.pairing-started", "extension");
  return { code, expiresAt: new Date(exp).toISOString() };
}
export function removeDevice(store: Store, w: string, user: string, id: string) {
  const d = store.get(w, "devices", id);
  store.remove(w, "devices", id);
  const l = live.get(id);
  l?.poll?.([]);
  live.delete(id);
  for (const [cid, wt] of waiting)
    if (wt.device === id) {
      clearTimeout(wt.timer);
      waiting.delete(cid);
      wt.reject(fail("That browser was removed."));
    }
  store.audit(w, user, "browser.device-removed", d.label);
}

function deviceFor(store: Store, req: Request): { workspace: string; device: Row } {
  const m = /^Bearer od_([a-f0-9]{16})\.([A-Za-z0-9_-]{32,})$/.exec(String(req.headers.authorization || ""));
  if (!m) throw fail("Pair this browser again.", 401);
  const found = store.db.prepare("SELECT workspace FROM records WHERE kind='devices' AND id=?").get(m[1]) as { workspace: string } | undefined;
  const device = found && devicesOf(store, found.workspace).find((d) => d.id === m[1]);
  const ok = device && timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash(m[2])));
  if (!found || !device || !ok) throw fail("Pair this browser again.", 401);
  return { workspace: found.workspace, device };
}

// Run a command on a device and wait for its reply. A device that doesn't pick the command up in time
// is treated as offline so the caller can use the server's browser instead.
export function sendCommand(deviceId: string, command: Omit<Command, "id">, timeoutMs: number, pickupMs = 8_000): Promise<DeviceReply> {
  const l = live.get(deviceId);
  if (!l || !isOnline(deviceId)) return Promise.reject(Object.assign(fail("Your browser isn't connected right now.", 503), { offline: true }));
  const id = randomBytes(9).toString("base64url");
  const full = { ...command, id } as Command;
  return new Promise((resolve, reject) => {
    let pickedUp = false;
    const timer = setTimeout(() => {
      waiting.delete(id);
      l.queue = l.queue.filter((c) => c.id !== id);
      reject(Object.assign(fail(pickedUp ? "Your browser took too long to answer." : "Your browser isn't connected right now.", pickedUp ? 504 : 503), { offline: !pickedUp }));
    }, timeoutMs);
    // If nothing has collected the command shortly, the device is gone: stop waiting early.
    const pickup = setTimeout(() => {
      if (l.queue.some((c) => c.id === id)) {
        clearTimeout(timer);
        waiting.delete(id);
        l.queue = l.queue.filter((c) => c.id !== id);
        reject(Object.assign(fail("Your browser isn't connected right now.", 503), { offline: true }));
      }
      pickedUp = true;
    }, pickupMs);
    waiting.set(id, {
      device: deviceId,
      timer,
      resolve: (r) => {
        clearTimeout(timer);
        clearTimeout(pickup);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        clearTimeout(pickup);
        reject(e);
      },
    });
    l.queue.push(full);
    if (l.poll) {
      const send = l.poll;
      l.poll = undefined;
      send(l.queue.splice(0));
      pickedUp = true;
    }
  });
}

const registerSchema = z.object({
  code: z.string().trim().min(4).max(20),
  label: z.string().trim().min(1).max(40).default("My browser"),
  browser: z.string().trim().max(120).optional(),
});
const resultSchema = z.object({
  id: z.string().max(40),
  ok: z.boolean(),
  error: z.string().max(500).nullish(),
  state: z.unknown().optional(),
  stop: z.boolean().optional(),
  private: z.boolean().optional(),
});

// Routes the extension uses. They sit before the session check: the pairing code and the device token
// are their own credentials.
export function configureDevices(app: Express, store: Store, rate: (req: Request, res: Response, next: () => void) => void) {
  app.post("/api/device/register", rate, (req, res) => {
    const input = registerSchema.parse(req.body);
    const c = codes.get(input.code.toUpperCase());
    if (!c || c.exp < Date.now()) throw fail("That code has expired or is wrong. Make a new one in OrbytLink.", 400);
    codes.delete(input.code.toUpperCase());
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    // The same label twice would make "use my Work browser" ambiguous.
    const taken = new Set(devicesOf(store, c.workspace).map((d) => d.label.toLowerCase()));
    let label = input.label,
      n = 2;
    while (taken.has(label.toLowerCase())) label = `${input.label} ${n++}`;
    store.put(c.workspace, "devices", { id, label, tokenHash: hash(secret), user: c.user, browser: input.browser, createdAt: new Date().toISOString() });
    store.audit(c.workspace, c.user, "browser.device-added", label);
    res.json({ token: `od_${id}.${secret}`, label });
  });
  // Long poll: answer as soon as there is work, or with nothing after POLL_MS.
  app.get("/api/device/poll", rate, (req, res) => {
    const { device } = deviceFor(store, req);
    const l = live.get(device.id) ?? { queue: [], seen: 0 };
    live.set(device.id, l);
    l.seen = Date.now();
    if (req.query.private !== undefined) l.private = req.query.private === "1";
    l.poll?.([]);
    if (l.queue.length) return void res.json({ commands: l.queue.splice(0) });
    const finish = (commands: Command[]) => {
      clearTimeout(timer);
      if (l.poll === finish) l.poll = undefined;
      l.seen = Date.now();
      if (!res.headersSent) res.json({ commands });
    };
    const timer = setTimeout(() => finish([]), POLL_MS);
    l.poll = finish;
    // The response's close, not the request's: a request reports "close" once its body is read.
    res.on("close", () => {
      clearTimeout(timer);
      if (l.poll === finish) l.poll = undefined;
    });
  });
  app.post("/api/device/result", rate, (req, res) => {
    const { device } = deviceFor(store, req);
    const r = resultSchema.parse(req.body);
    const w = waiting.get(r.id);
    if (!w || w.device !== device.id) return void res.json({ ok: true });
    waiting.delete(r.id);
    w.resolve(r);
    res.json({ ok: true });
  });
}
