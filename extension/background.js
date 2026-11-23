import { actClick, actScroll, actSelect, actType, fillLogin, hasPassword, readState, showBanner } from "./page.js";
import { loginFor, lock, unlock, vaultStatus, saveLogin, forgetLogin } from "./vault.js";

// The extension only ever connects outward to OrbytLink: it asks for work (a long poll), does it in
// this browser profile, and sends back what the page looked like. Choosing the next step happens on
// the OrbytLink server; this side opens pages, clicks and types, and asks the person before anything
// new or risky.
const DEFAULT_SERVER = "https://app.orbytlink.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: async () => ({ server: DEFAULT_SERVER, privateWindow: false, allowed: [], ...(await chrome.storage.local.get(["server", "token", "label", "privateWindow", "allowed"])) }),
  set: (patch) => chrome.storage.local.set(patch),
};

// ── Pairing and status ───────────────────────────────────────────────────────
let lastOk = 0;
let lastError = "";
async function pair({ server, code, label }) {
  const base = (server || DEFAULT_SERVER).replace(/\/+$/, "");
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("The server address must start with https://");
  const r = await fetch(`${base}/api/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, label: label || "Chrome", browser: navigator.userAgent.slice(0, 100) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `OrbytLink refused the code (HTTP ${r.status}).`);
  await store.set({ server: base, token: data.token, label: data.label });
  loop();
  return { label: data.label };
}
async function status() {
  const c = await store.get();
  return {
    paired: !!c.token,
    label: c.label || "",
    server: c.server,
    online: Date.now() - lastOk < 60_000,
    error: lastError,
    privateWindow: c.privateWindow,
    incognito: await chrome.extension.isAllowedIncognitoAccess(),
    allowed: c.allowed,
    vault: await vaultStatus(),
  };
}

// ── The poll loop ────────────────────────────────────────────────────────────
let polling = false;
async function loop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const c = await store.get();
      if (!c.token) return;
      let r;
      try {
        r = await fetch(`${c.server}/api/device/poll?private=${c.privateWindow ? 1 : 0}`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(30_000) });
      } catch {
        lastError = "Can't reach OrbytLink. Retrying.";
        await sleep(4000);
        continue;
      }
      if (r.status === 401) {
        // Removed in OrbytLink: forget the token so the panel offers pairing again.
        await chrome.storage.local.remove(["token", "label"]);
        lastError = "This browser was removed in OrbytLink. Pair it again.";
        return;
      }
      if (!r.ok) {
        lastError = `OrbytLink answered HTTP ${r.status}. Retrying.`;
        await sleep(5000);
        continue;
      }
      lastOk = Date.now();
      lastError = "";
      const { commands = [] } = await r.json().catch(() => ({}));
      for (const command of commands) await answer(c, command);
    }
  } finally {
    polling = false;
  }
}
async function answer(c, command) {
  let result;
  try {
    result = await run(command);
  } catch (error) {
    result = { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
  await fetch(`${c.server}/api/device/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: command.id, ...result }),
  }).catch(() => undefined);
}
// A service worker can be stopped between polls; the alarm and the browser start-up wake it again.
chrome.alarms.create("orbytlink-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void loop());
chrome.runtime.onStartup.addListener(() => void loop());
chrome.runtime.onInstalled.addListener(() => void loop());
void loop();

// ── Approvals: a small window the person answers ────────────────────────────
const asking = new Map();
async function ask(kind, host, detail) {
  const id = crypto.randomUUID();
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(`approve.html?id=${id}&kind=${kind}&host=${encodeURIComponent(host)}&detail=${encodeURIComponent(detail || "")}`), type: "popup", width: 440, height: 330, focused: true });
  return new Promise((resolve) => {
    const done = (answer) => {
      clearTimeout(timer);
      chrome.windows.onRemoved.removeListener(closed);
      asking.delete(id);
      if (win.id) chrome.windows.remove(win.id).catch(() => undefined);
      resolve(answer);
    };
    const closed = (windowId) => windowId === win.id && done("deny");
    chrome.windows.onRemoved.addListener(closed);
    const timer = setTimeout(() => done("deny"), 90_000);
    asking.set(id, done);
  });
}
const hostMatch = (list, host) => list.some((h) => host === h || host.endsWith(`.${h}`));
async function allowHost(host) {
  const c = await store.get();
  if (hostMatch(c.allowed, host)) return true;
  const a = await ask("site", host);
  if (a === "always") await store.set({ allowed: [...new Set([...c.allowed, host])] });
  return a === "always" || a === "once";
}
// Buying, sending, deleting and the like: asked every time, never remembered.
const RISKY = /\b(pay|buy|purchase|place order|order now|checkout|delete|remove|send|post|publish|tweet|reply|submit|confirm|transfer|withdraw|unsubscribe|close account|sign out|log out|logout)\b/i;

// ── One run = one tab in its own window ──────────────────────────────────────
const sessions = new Map();
const stopped = (s) => !!s?.stopped;
async function tabOf(session) {
  const s = sessions.get(session);
  if (!s) throw new Error("That browser session has ended.");
  try {
    return await chrome.tabs.get(s.tabId);
  } catch {
    throw new Error("The window was closed.");
  }
}
async function settle(tabId) {
  const end = Date.now() + 12_000;
  await sleep(300);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete") break;
    await sleep(250);
  }
  await sleep(500);
}
const exec = async (tabId, func, args = []) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r?.result;
};
async function snapshot(session) {
  const s = sessions.get(session);
  const tab = await tabOf(session);
  let state;
  for (let i = 0; i < 4 && !state; i++) {
    try {
      state = await exec(tab.id, readState, [150]);
    } catch {
      await sleep(600);
    }
  }
  if (!state) throw new Error("This page can't be read (it may be a browser page).");
  s.elements = state.elements;
  await exec(tab.id, showBanner, [session, `OrbytLink is working in this window${s.private ? " (private)" : ""}`]).catch(() => undefined);
  return state;
}
// After any navigation: a site the person hasn't approved yet needs approval before it is read.
async function checkLanded(session) {
  const tab = await tabOf(session);
  let host = "";
  try {
    host = new URL(tab.url || tab.pendingUrl || "").hostname;
  } catch {
    return;
  }
  if (!host || (await allowHost(host))) return;
  await chrome.tabs.goBack(tab.id).catch(() => undefined);
  const e = new Error(`You didn't allow ${host}.`);
  e.denied = true;
  throw e;
}

async function run(command) {
  if (command.type === "open") return open(command);
  if (command.type === "close") return close(command);
  if (command.type === "act") return act(command);
  throw new Error("Unknown command.");
}
async function open({ session, url }) {
  const host = new URL(url).hostname;
  if (!(await allowHost(host))) return { ok: false, error: `You didn't allow ${host}.` };
  const c = await store.get();
  const wantPrivate = !!c.privateWindow;
  if (wantPrivate && !(await chrome.extension.isAllowedIncognitoAccess()))
    return { ok: false, error: 'Private windows are off for this extension. In chrome://extensions open OrbytLink, turn on "Allow in Incognito", or turn off "Use a private window".' };
  const win = await chrome.windows.create({ url, incognito: wantPrivate, focused: false, state: "normal" });
  const tabId = win.tabs[0].id;
  sessions.set(session, { windowId: win.id, tabId, private: wantPrivate, stopped: false, elements: [] });
  await settle(tabId);
  await checkLanded(session);
  return { ok: true, state: await snapshot(session) };
}
async function close({ session }) {
  const s = sessions.get(session);
  sessions.delete(session);
  if (s) await chrome.windows.remove(s.windowId).catch(() => undefined);
  return { ok: true };
}

async function act(command) {
  const { session, action } = command;
  const s = sessions.get(session);
  if (!s) return { ok: false, error: "That browser session has ended." };
  if (stopped(s)) return { ok: false, stop: true, error: "Stopped by you." };
  const tab = await tabOf(session);
  let r = { ok: true };
  try {
    if (action === "click") {
      const label = s.elements.find((e) => e.i === command.index)?.label || "";
      if (RISKY.test(label)) {
        const host = new URL(tab.url).hostname;
        if ((await ask("action", host, `Click "${label}"`)) === "deny") return { ok: false, error: "You declined that click.", state: await snapshot(session) };
      }
      r = await exec(tab.id, actClick, [command.index]);
    } else if (action === "type") r = await exec(tab.id, actType, [command.index, String(command.text ?? ""), !!command.enter]);
    else if (action === "select") r = await exec(tab.id, actSelect, [command.index, String(command.text ?? "")]);
    else if (action === "scroll") r = await exec(tab.id, actScroll, [command.direction]);
    else if (action === "back") await chrome.tabs.goBack(tab.id);
    else if (action === "goto") {
      const host = new URL(command.url).hostname;
      if (!(await allowHost(host))) return { ok: false, error: `You didn't allow ${host}.`, state: await snapshot(session) };
      await chrome.tabs.update(tab.id, { url: command.url });
    } else if (action === "wait") await sleep(2000);
    else if (action === "wait_for_user") return await waitForUser(session);
  } catch (error) {
    r = { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
  await settle(tab.id);
  if (stopped(s)) return { ok: false, stop: true, error: "Stopped by you." };
  try {
    await checkLanded(session);
  } catch (error) {
    return { ok: false, error: error.message, state: await snapshot(session) };
  }
  return { ok: !!r?.ok, error: r?.ok ? null : r?.error || "The action didn't work.", state: await snapshot(session) };
}

// A sign-in page: fill it from the local vault if this site is saved there, then give the window to
// the person to finish (two-factor codes, captchas) and wait until the sign-in form is gone.
async function waitForUser(session) {
  const s = sessions.get(session);
  let tab = await tabOf(session);
  await chrome.windows.update(s.windowId, { focused: true });
  await exec(tab.id, showBanner, [session, "Sign in here, then OrbytLink carries on"]).catch(() => undefined);
  const saved = await loginFor(new URL(tab.url).hostname);
  if (saved) {
    const filled = await exec(tab.id, fillLogin, [saved.user, saved.pass]).catch(() => null);
    if (filled?.ok) await settle(tab.id);
  }
  const end = Date.now() + 180_000;
  while (Date.now() < end && !stopped(s)) {
    await sleep(1500);
    tab = await tabOf(session);
    const more = await exec(tab.id, hasPassword).catch(() => true);
    if (!more) break;
  }
  await chrome.windows.update(s.windowId, { focused: false }).catch(() => undefined);
  if (stopped(s)) return { ok: false, stop: true, error: "Stopped by you." };
  await settle(tab.id);
  try {
    await checkLanded(session);
  } catch (error) {
    return { ok: false, error: error.message, state: await snapshot(session) };
  }
  return { ok: true, state: await snapshot(session) };
}

// ── Messages from the panel, the approval window and the in-page Stop button ─
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    if (m.type === "status") return status();
    if (m.type === "pair") return pair(m);
    if (m.type === "unpair") {
      await chrome.storage.local.remove(["token", "label"]);
      return {};
    }
    if (m.type === "setting") {
      await store.set({ [m.key]: m.value });
      return {};
    }
    if (m.type === "forget-site") {
      const c = await store.get();
      await store.set({ allowed: c.allowed.filter((h) => h !== m.host) });
      return {};
    }
    if (m.type === "unlock") return void (await unlock(m.passphrase));
    if (m.type === "lock") return void (await lock());
    if (m.type === "save-login") return void (await saveLogin(m.host, m.user, m.pass));
    if (m.type === "forget-login") return void (await forgetLogin(m.host));
    if (m.type === "answer") return void asking.get(m.id)?.(m.answer);
    // Only this extension's own pages and the banner it put in a page may stop a run.
    if (m.type === "stop" && sender.id === chrome.runtime.id) {
      const s = sessions.get(m.session);
      if (s) s.stopped = true;
      for (const done of asking.values()) done("deny");
      return {};
    }
  })().then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});
