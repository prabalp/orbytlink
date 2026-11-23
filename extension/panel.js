// The toolbar popup and the full options page are the same screen.
const $ = (id) => document.getElementById(id);
const tab = new URLSearchParams(location.search).has("options");
document.body.classList.toggle("tab", tab);
const call = async (message) => {
  const r = await chrome.runtime.sendMessage(message);
  if (!r?.ok) throw new Error(r?.error || "Something went wrong.");
  return r.value;
};
const show = (id, on) => ($(id).hidden = !on);
function list(ul, items, onRemove) {
  ul.replaceChildren(
    ...items.map((name) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = name;
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = "Remove";
      b.addEventListener("click", () => onRemove(name));
      li.append(span, b);
      return li;
    }),
  );
}

let editing = false;
async function render() {
  const s = await call({ type: "status" });
  show("pairing", !s.paired);
  show("connected", s.paired);
  show("options", s.paired);
  show("sites", s.paired);
  show("vault", s.paired);
  $("state").replaceChildren();
  if (s.paired) {
    const dot = document.createElement("span");
    dot.className = `dot${s.online ? " on" : ""}`;
    $("state").append(dot, s.online ? "Online" : "Offline");
  }
  if (!editing) $("server").value = s.server;
  $("name").textContent = s.label;
  $("connError").textContent = s.error;
  $("private").checked = s.privateWindow;
  show("incognitoNote", s.privateWindow && !s.incognito);
  list($("siteList"), s.allowed, async (host) => {
    await call({ type: "forget-site", host });
    render();
  });
  show("noSites", s.allowed.length === 0);
  show("locked", !s.vault.unlocked);
  show("unlocked", s.vault.unlocked);
  $("unlock").textContent = s.vault.exists ? "Unlock" : "Set passphrase";
  list($("loginList"), s.vault.sites, async (host) => {
    await call({ type: "forget-login", host });
    render();
  });
}

$("advanced").addEventListener("click", () => {
  editing = true;
  show("serverRow", true);
});
$("pair").addEventListener("click", async () => {
  $("pairError").textContent = "";
  try {
    await call({ type: "pair", code: $("code").value.trim(), label: $("label").value.trim(), server: $("server").value.trim() });
    $("code").value = "";
    render();
  } catch (error) {
    $("pairError").textContent = error.message;
  }
});
$("unpair").addEventListener("click", async () => {
  await call({ type: "unpair" });
  render();
});
$("private").addEventListener("change", async () => {
  await call({ type: "setting", key: "privateWindow", value: $("private").checked });
  render();
});
$("unlock").addEventListener("click", async () => {
  $("vaultError").textContent = "";
  try {
    await call({ type: "unlock", passphrase: $("pass").value });
    $("pass").value = "";
    render();
  } catch (error) {
    $("vaultError").textContent = error.message;
  }
});
$("lock").addEventListener("click", async () => {
  await call({ type: "lock" });
  render();
});
$("save").addEventListener("click", async () => {
  const host = $("host").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host || !$("user").value || !$("secret").value) return;
  await call({ type: "save-login", host, user: $("user").value, pass: $("secret").value });
  for (const id of ["host", "user", "secret"]) $(id).value = "";
  render();
});

render().catch(() => undefined);
setInterval(() => {
  if (!document.hidden) render().catch(() => undefined);
}, 2500);
