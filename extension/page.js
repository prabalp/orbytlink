// Functions that run INSIDE the web page (chrome.scripting.executeScript serializes each one), so each
// must be self-contained: nothing here may refer to anything outside its own body.
// readState mirrors the server browser's page reader, so the same decision models can drive either one.

export function readState(limit) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (v, n) => (v || "").replace(/\s+/g, " ").trim().slice(0, n);
  document.querySelectorAll("[data-orbyt-i]").forEach((el) => el.removeAttribute("data-orbyt-i"));
  const sel =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=switch], [contenteditable=true]';
  const all = [...document.querySelectorAll(sel)].filter(visible);
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  };
  const ordered = [...all.filter(inView), ...all.filter((el) => !inView(el))].slice(0, limit);
  const elements = ordered.map((el, i) => {
    el.setAttribute("data-orbyt-i", String(i));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const label = clean(
      el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.querySelector("img")?.getAttribute("alt") || el.getAttribute("name") || (tag === "a" ? el.getAttribute("href") : ""),
      80,
    );
    const out = { i, tag, label };
    const role = el.getAttribute("role");
    if (role) out.role = role;
    if (type) out.type = type;
    // What is in a password field is never read.
    if (tag === "input" || tag === "textarea") out.value = clean(type === "password" ? "" : el.value, 60);
    if (tag === "select") {
      out.value = clean(el.options[el.selectedIndex]?.text, 60);
      out.options = [...el.options].slice(0, 15).map((o) => clean(o.text, 40));
    }
    if (el.checked) out.checked = true;
    if (el.isContentEditable) out.editable = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.disabled = true;
    if (!inView(el)) out.offscreen = true;
    return out;
  });
  return {
    url: location.href,
    title: clean(document.title, 200),
    text: clean(document.body?.innerText, 8000),
    elements,
    scroll: Math.round(scrollY),
    height: Math.round(document.documentElement.scrollHeight),
    viewport: innerHeight,
  };
}

export function actClick(index) {
  const el = document.querySelector(`[data-orbyt-i="${index}"]`);
  if (!el) return { ok: false, error: "That element is no longer on the page." };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new MouseEvent(t, at));
  el.click();
  return { ok: true };
}

export function actType(index, text, enter) {
  const el = document.querySelector(`[data-orbyt-i="${index}"]`);
  if (!el) return { ok: false, error: "That field is no longer on the page." };
  // The agent never types a password; the person does, or the local vault fills it.
  if (el.type === "password") return { ok: false, error: "OrbytLink never types into a password field." };
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (enter) {
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keypress", key));
    el.dispatchEvent(new KeyboardEvent("keyup", key));
    if (go && el.form) el.form.requestSubmit();
  }
  return { ok: true };
}

export function actSelect(index, text) {
  const el = document.querySelector(`[data-orbyt-i="${index}"]`);
  if (!el || el.tagName !== "SELECT") return { ok: false, error: "That dropdown is no longer on the page." };
  const want = String(text).trim().toLowerCase();
  const option = [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => o.value.toLowerCase() === want);
  if (!option) return { ok: false, error: "That option isn't in the dropdown." };
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

export function actScroll(direction) {
  window.scrollBy({ top: (direction === "up" ? -1 : 1) * Math.round(innerHeight * 0.8), behavior: "instant" });
  return { ok: true };
}

// Is a sign-in form on screen? Used while waiting for the person to finish signing in.
export function hasPassword() {
  return [...document.querySelectorAll("input[type=password]")].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  });
}

// Fill (and submit) a sign-in form from the local vault. Two-factor codes are left to the person.
export function fillLogin(user, pass) {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  };
  const set = (el, v) => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const password = [...document.querySelectorAll("input[type=password]")].find(shown);
  const scope = password?.form || document;
  const userField = [...scope.querySelectorAll("input[type=email], input[type=text], input[type=tel], input:not([type])")]
    .filter(shown)
    .filter((el) => !password || password.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
    .pop();
  // Two-step sign-in: the first page has only the username.
  const field = password || userField;
  if (!field) return { ok: false, error: "No sign-in form found." };
  if (userField && !userField.value) set(userField, user);
  if (password) set(password, pass);
  const form = field.form;
  if (form) form.requestSubmit();
  else field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  return { ok: true, filled: password ? "both" : "username" };
}

// A bar in the page that says OrbytLink is driving it, with a Stop button.
export function showBanner(session, text) {
  let host = document.getElementById("orbytlink-banner");
  if (!host) {
    host = document.createElement("div");
    host.id = "orbytlink-banner";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%)";
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:12px;font:500 13px/18px system-ui,sans-serif;color:#fff;background:#111;border:1px solid #333;border-radius:10px;padding:8px 8px 8px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35)";
    const label = document.createElement("span");
    label.className = "label";
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.style.cssText = "font:inherit;color:#111;background:#fff;border:0;border-radius:7px;padding:5px 12px;cursor:pointer";
    stop.addEventListener("click", () => chrome.runtime.sendMessage({ type: "stop", session }));
    box.append(label, stop);
    root.append(box);
    host.__label = label;
    (document.body || document.documentElement).append(host);
  }
  host.__label.textContent = text;
}
