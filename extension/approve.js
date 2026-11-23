const q = new URLSearchParams(location.search);
const kind = q.get("kind");
const host = q.get("host") || "";
const detail = q.get("detail") || "";
const title = document.getElementById("title");
const body = document.getElementById("body");
const buttons = document.getElementById("buttons");
const answer = (value) => chrome.runtime.sendMessage({ type: "answer", id: q.get("id"), answer: value });
const add = (label, value, secondary) => {
  const b = document.createElement("button");
  b.textContent = label;
  if (secondary) b.className = "secondary";
  b.addEventListener("click", () => answer(value));
  buttons.append(b);
};
if (kind === "site") {
  title.textContent = `Let OrbytLink use ${host}?`;
  body.textContent = "Your agent wants to open this site in your browser, where you may already be signed in. It will read the page and click or type on it.";
  add("Don't allow", "deny", true);
  add("Just this time", "once", true);
  add("Always allow", "always");
} else {
  title.textContent = detail || "Allow this action?";
  body.textContent = `On ${host}. This looks like something that buys, sends, posts or deletes. Allow it only if you asked for it.`;
  add("Don't allow", "deny", true);
  add("Allow", "once");
}
