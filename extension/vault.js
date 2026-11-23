// Sign-ins kept on this computer only. They are encrypted with a passphrase the person types (AES-GCM,
// key from PBKDF2) and never sent to OrbytLink or anywhere else. Once unlocked, the derived key stays in
// the browser's memory-only session storage, so quitting the browser locks the vault again.
const KEY = "vault";
const SESSION_KEY = "vaultKey";
const ROUNDS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const read = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
const write = (vault) => chrome.storage.local.set({ [KEY]: vault });

async function derive(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}
const open = async (key, box) => JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct))));
const sessionKey = async () => {
  const raw = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  return raw ? crypto.subtle.importKey("jwk", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) : null;
};

export async function vaultStatus() {
  const v = await read();
  return { exists: !!v, unlocked: !!v && !!(await sessionKey()), sites: v ? Object.keys(v.entries).sort() : [] };
}
// First use sets the passphrase; later calls check it.
export async function unlock(passphrase) {
  let v = await read();
  if (passphrase.length < 8) throw new Error("Use at least 8 characters.");
  if (!v) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(passphrase, salt);
    v = { salt: b64(salt), check: await seal(key, "orbytlink"), entries: {} };
    await write(v);
  }
  const key = await derive(passphrase, unb64(v.salt));
  try {
    if ((await open(key, v.check)) !== "orbytlink") throw new Error();
  } catch {
    throw new Error("That passphrase is wrong.");
  }
  await chrome.storage.session.set({ [SESSION_KEY]: await crypto.subtle.exportKey("jwk", key) });
}
export const lock = () => chrome.storage.session.remove(SESSION_KEY);
export async function saveLogin(host, user, pass) {
  const v = await read();
  const key = await sessionKey();
  if (!v || !key) throw new Error("Unlock the vault first.");
  v.entries[host.toLowerCase()] = await seal(key, { user, pass });
  await write(v);
}
export async function forgetLogin(host) {
  const v = await read();
  if (!v) return;
  delete v.entries[host];
  await write(v);
}
// The saved login for a page's host (or its parent domain), when the vault is unlocked.
export async function loginFor(hostname) {
  const v = await read();
  const key = await sessionKey();
  if (!v || !key) return null;
  const host = hostname.toLowerCase();
  const match = Object.keys(v.entries)
    .filter((h) => host === h || host.endsWith(`.${h}`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return null;
  try {
    return await open(key, v.entries[match]);
  } catch {
    return null;
  }
}
