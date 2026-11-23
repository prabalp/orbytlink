import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { browse, localPage, planStep, type PageState } from "../server/browser";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

const PAGE = "https://93.184.216.34/";
let app: Express, store: Store, cookie: string, identity: any;
let serverCalls: string[];
let decideReply: (body: any) => Response;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const home: PageState = { url: PAGE, title: "Acme", text: "Welcome", elements: [{ i: 0, tag: "input", type: "search", label: "Search", value: "" }], scroll: 0, height: 900, viewport: 900 };
const results: PageState = { ...home, url: `${PAGE}search?q=pro`, title: "Results", text: "Pro plan: $20/month", elements: [] };
const answer = (body: any, picks: Record<string, string | number>) =>
  Response.json({
    model: body.model,
    answers: body.questions.map((q: any) => (q.type === "predicate" ? { type: "predicate", name: q.name, probability: Number(picks[q.name] ?? 0) } : { type: "choice", name: q.name, choice: String(picks[q.name] ?? q.choices[0].value), confidence: 0.9 })),
    usage: { input_tokens: 2000, output_tokens: 0, total_tokens: 2000 },
  });

// A paired extension: poll for commands and answer them the way the extension does.
function fakeDevice(token: string, onCommand: (c: any) => { ok: boolean; error?: string; state?: PageState; stop?: boolean }) {
  const seen: any[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const r = await inject(app, { url: "/api/device/poll", headers: { Authorization: `Bearer ${token}` } });
      // Removed from the account (or the test is over): the extension stops, as it does on a 401.
      if (r.status !== 200) return;
      for (const c of r.data.commands || []) {
        seen.push(c);
        await inject(app, { url: "/api/device/result", method: "POST", headers: { Authorization: `Bearer ${token}` }, body: { id: c.id, ...onCommand(c) } });
      }
    }
  })();
  return { seen, stop: () => (running = false), loop };
}
async function pair(label = "Work") {
  const { code } = (await api("/api/devices/pair", {})).data;
  const r = await inject(app, { url: "/api/device/register", method: "POST", body: { code, label, browser: "Chrome" } });
  return { code, token: r.data.token as string, label: r.data.label as string, status: r.status };
}
// A poll that stays open marks the device as connected, as the extension's own polling does.
const online = async (token: string) => {
  void inject(app, { url: "/api/device/poll", headers: { Authorization: `Bearer ${token}` } });
  await new Promise((r) => setTimeout(r, 20));
};

beforeEach(async () => {
  Object.assign(process.env, { SCRAPER_URL: "http://scraper.internal:8700", SCRAPER_TOKEN: "scraper_token_123456", AI_GATEWAY_API_KEY: "vck_gateway_key_123456" });
  serverCalls = [];
  decideReply = (body) => (body.input.includes("Pro plan: $20/month") ? answer(body, { operation: "DONE" }) : answer(body, { operation: "TYPE", type_target: "0", type_value: "v0", type_submit: 0.9 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/decisions")) return decideReply(body);
      if (url.startsWith("http://scraper.internal")) serverCalls.push(`${init.method || "GET"} ${url}`);
      if (url === "http://scraper.internal:8700/session") return Response.json({ id: "s1", state: home });
      if (url === "http://scraper.internal:8700/session/s1/act") return Response.json({ ok: true, error: null, state: results });
      if (url === "http://scraper.internal:8700/session/s1") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    }),
  );
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  identity = (await api("/api/state")).data.identity;
  grantCredits(store, identity.workspace, 1_000_000, "operator");
});
afterEach(async () => {
  for (const d of (await api("/api/state")).data.browser.devices) await api(`/api/devices/${d.id}`, undefined, "DELETE");
  vi.unstubAllGlobals();
  for (const k of ["SCRAPER_URL", "SCRAPER_TOKEN", "AI_GATEWAY_API_KEY"]) delete process.env[k];
});

it("pairs with a single-use code and keeps only a hash of the token", async () => {
  const bad = await inject(app, { url: "/api/device/register", method: "POST", body: { code: "NOPE-NOPE", label: "x" } });
  expect(bad.status).toBe(400);
  const p = await pair("Work");
  expect(p.status).toBe(200);
  expect(p.token).toMatch(/^od_[a-f0-9]{16}\.[\w-]{32,}$/);
  // The code works once.
  expect((await inject(app, { url: "/api/device/register", method: "POST", body: { code: p.code, label: "again" } })).status).toBe(400);
  // A second profile with the same name is told apart.
  expect((await pair("Work")).label).toBe("Work 2");
  const row = store.list(identity.workspace, "devices")[0];
  expect(JSON.stringify(row)).not.toContain(p.token.split(".")[1]);
  // A made-up token is refused.
  expect((await inject(app, { url: "/api/device/poll", headers: { Authorization: "Bearer od_0000000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status).toBe(401);
  // The extension may post cross-origin without a cookie; a browser tab may not post here with one.
  const ext = await inject(app, { url: "/api/device/register", method: "POST", headers: { Origin: "chrome-extension://abc" }, body: { code: "NOPE-NOPE" } });
  expect(ext.status).toBe(400);
  const tab = await inject(app, { url: "/api/devices/pair", method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" }, body: {} });
  expect(tab.status).toBe(403);
});

it("runs in the person's own browser first, costing only the decisions", async () => {
  const { token } = await pair("Work");
  const dev = fakeDevice(token, (c) => (c.type === "open" ? { ok: true, state: home } : c.type === "act" ? { ok: true, state: results } : { ok: true }));
  await new Promise((r) => setTimeout(r, 20));
  const before = (await api("/api/ai")).data.balance;
  const r = await browse(store, identity, { url: PAGE, goal: "Find the Pro price", values: ["pro"] }, "agent");
  expect(r).toMatchObject({ status: "done", steps: 1, where: 'your browser "Work"' });
  expect(r.result).toContain("Pro plan: $20/month");
  expect(dev.seen.map((c) => c.type)).toEqual(["open", "act", "close"]);
  expect(dev.seen[1]).toMatchObject({ action: "type", index: 0, text: "pro", enter: true });
  // The server's browser was never touched and no per-action fee was charged.
  expect(serverCalls).toEqual([]);
  const decision = Math.ceil(2000 * 0.0441);
  expect(r.costMicro).toBe(2 * decision);
  expect((await api("/api/ai")).data.balance).toBe(before - r.costMicro);
  dev.stop();
});

it("falls back to the server's browser when no device is connected, and says where it ran", async () => {
  // Paired, but its extension never polled: not connected.
  await pair("Work");
  const r = await browse(store, identity, { url: PAGE, goal: "Find the Pro price", values: ["pro"] }, "agent");
  expect(r).toMatchObject({ status: "done", where: "the server's browser" });
  expect(serverCalls).toContain("POST http://scraper.internal:8700/session");
  // "local" never falls back.
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price", where: "local" }, "agent")).rejects.toThrow(/No browser of yours is connected/);
  // A named profile that isn't connected is reported by name.
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price", where: "local", device: "Home" }, "agent")).rejects.toThrow(/named "Home"/);
});

it("falls back when the device stops answering mid-air, but not when the person refuses a site", async () => {
  const { token } = await pair("Work");
  // Connected a moment ago (its poll just ended), but nothing collects the command: offline after the pickup wait.
  const { sendCommand } = await import("../server/devices");
  vi.useFakeTimers();
  const poll = inject(app, { url: "/api/device/poll", headers: { Authorization: `Bearer ${token}` } });
  await vi.advanceTimersByTimeAsync(20_100);
  await poll;
  const caught = sendCommand(store.list(identity.workspace, "devices")[0].id, { type: "open", url: PAGE }, 90_000, 8_000).catch((e) => e);
  await vi.advanceTimersByTimeAsync(8_100);
  expect(await caught).toMatchObject({ offline: true });
  vi.useRealTimers();

  const dev = fakeDevice(token, (c) => (c.type === "open" ? { ok: false, error: "You didn't allow that site." } : { ok: true }));
  await new Promise((r) => setTimeout(r, 20));
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price" }, "agent")).rejects.toThrow(/didn't allow that site/);
  expect(serverCalls).toEqual([]);
  dev.stop();
});

it("offers a sign-in wait only in the person's own browser, and a stop ends the run", async () => {
  const login: PageState = { ...home, title: "Sign in", text: "Sign in to continue", elements: [{ i: 0, tag: "input", type: "email", label: "Email", value: "" }, { i: 1, tag: "input", type: "password", label: "Password", value: "" }] };
  expect(planStep(login, [], 0, true).operations).toContain("WAIT_FOR_USER");
  expect(planStep(login, [], 0, false).operations).not.toContain("WAIT_FOR_USER");
  expect(planStep(login, [], 0, true).questions[0].instructions).toMatch(/Never type a password/);

  const { token } = await pair("Work");
  decideReply = (body) => answer(body, { operation: body.input.includes("Signed in") ? "DONE" : "WAIT_FOR_USER" });
  const signedIn: PageState = { ...home, title: "Inbox", text: "Signed in. 3 new messages", elements: [] };
  const dev = fakeDevice(token, (c) => (c.type === "open" ? { ok: true, state: login } : c.type === "act" && c.action === "wait_for_user" ? { ok: true, state: signedIn } : { ok: true }));
  await new Promise((r) => setTimeout(r, 20));
  const r = await browse(store, identity, { url: "https://mail.example.com/", goal: "Read my newest message" }, "agent");
  expect(r).toMatchObject({ status: "done", steps: 1 });
  expect(r.result).toContain("wait for you to sign in");
  expect(r.result).toContain("3 new messages");
  dev.stop();

  const { token: t2 } = await pair("Home");
  const dev2 = fakeDevice(t2, (c) => (c.type === "open" ? { ok: true, state: home } : c.type === "act" ? { ok: false, error: "stopped", stop: true, state: home } : { ok: true }));
  await new Promise((r) => setTimeout(r, 20));
  decideReply = (body) => answer(body, { operation: "TYPE", type_target: "0", type_value: "v0" });
  const stopped = await browse(store, identity, { url: PAGE, goal: "Search", values: ["x"], device: "Home" }, "agent");
  expect(stopped).toMatchObject({ status: "stopped" });
  expect(stopped.result).toContain("You stopped the browser");
  dev2.stop();
});

it("lets the person's browser open any https site but never a private address", () => {
  expect(() => localPage("https://mail.google.com/")).not.toThrow();
  for (const bad of ["http://mail.google.com/", "https://localhost/", "https://192.168.1.5/", "https://intranet/", "https://printer.local/", "https://u:p@mail.google.com/"]) expect(() => localPage(bad), bad).toThrow();
});

it("shows the connected browsers in state and lets the person remove one", async () => {
  const { token } = await pair("Work");
  await online(token);
  let state = (await api("/api/state")).data.browser;
  expect(state.devices).toMatchObject([{ label: "Work", online: true }]);
  expect(JSON.stringify(state.devices)).not.toContain("tokenHash");
  await api(`/api/devices/${state.devices[0].id}`, undefined, "DELETE");
  state = (await api("/api/state")).data.browser;
  expect(state.devices).toEqual([]);
  expect((await inject(app, { url: "/api/device/poll", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
});
