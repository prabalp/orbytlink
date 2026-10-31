// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { createAccount } from "../server/auth";
import { Store } from "../server/store";
import { inject } from "./inject";
import { App } from "../src/main";
let root: Root,
  store: Store,
  cookie = "",
  workspace = "";
const pause = () => new Promise((r) => setTimeout(r, 5));
async function settle() {
  await act(async () => {
    await pause();
  });
}
async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
    await pause();
  });
}
function button(name: string) {
  return (
    [...document.querySelectorAll("button")].find(
      (e) => e.textContent?.trim() === name,
    ) || null
  );
}
async function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await pause();
  });
}
async function route(hash: string) {
  await act(async () => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await pause();
  });
}
async function login() {
  await fill(
    document.querySelector("input[name=email]")!,
    "prabalp@example.invalid",
  );
  await fill(
    document.querySelector("input[name=password]")!,
    "Correct-horse-ship-2026",
  );
  await click(document.querySelector("button[aria-label=Continue]"));
  for (
    let i = 0;
    i < 100 &&
    document.querySelector("h1")?.textContent !== "Connections";
    i++
  )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  expect(document.querySelector("h1")?.textContent).toBe("Connections");
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  cookie = "";
  location.hash = "connections";
  store = new Store(":memory:");
  const { app } = createApp(store);
  const account = await createAccount(store, {
    name: "prabalp",
    email: "prabalp@example.invalid",
    password: "Correct-horse-ship-2026",
  });
  workspace = account.workspace;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = new URL(String(input), "http://127.0.0.1:3100");
      const r = await inject(app, {
        url: url.pathname,
        method: init.method || "GET",
        headers: { Cookie: cookie },
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (r.headers["set-cookie"])
        cookie = String(r.headers["set-cookie"]).split(";")[0];
      return { ok: r.status < 400, status: r.status, json: async () => r.data };
    }),
  );
  root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(App));
    await pause();
  });
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  store.db.close();
  vi.unstubAllGlobals();
});
it("shows only gateway screens, with no chat or agent features", async () => {
  await login();
  for (const [hash, heading] of [
    ["connect-agents", "Connect any agent"],
    ["activity", "Activity"],
    ["settings", "Settings"],
    ["connections", "Connections"],
  ]) {
    await route(hash);
    expect(document.querySelector("h1")?.textContent).toBe(heading);
  }
  const text = document.body.textContent || "";
  for (const gone of ["Chat", "Outreach", "Runs & approvals"])
    expect(text).not.toContain(gone);
});
it("saves a connection without revealing its credential", async () => {
  await login();
  await click(button("Add connection"));
  await fill(document.querySelector("input[name=name]")!, "Private CRM");
  await fill(document.querySelector("input[name=endpoint]")!, "https://crm.example/mcp");
  const auth = document.querySelector(".modal select") as HTMLSelectElement;
  await act(async () => {
    auth.value = "bearer";
    auth.dispatchEvent(new Event("change", { bubbles: true }));
    await pause();
  });
  await fill(document.querySelector("input[name=secret]")!, "browser-submitted-secret");
  await click(button("Save connection"));
  await settle();
  expect(document.body.textContent).toContain("Private CRM");
  expect(document.body.textContent).toContain("Credential stored");
  expect(document.body.innerHTML).not.toContain("browser-submitted-secret");
  const rows = store.list(workspace, "connections");
  expect(JSON.stringify(rows)).not.toContain("browser-submitted-secret");
});
it("creates a gateway token, shows it once, and revokes it", async () => {
  await login();
  await route("connect-agents");
  await click(button("Create token"));
  await fill(document.querySelector("input[name=name]")!, "Claude Code laptop");
  await click([...document.querySelectorAll(".modal button")].find((b) => b.textContent?.trim() === "Create token") || null);
  await settle();
  const shown = (document.querySelector("textarea.token") as HTMLTextAreaElement).value;
  expect(shown).toMatch(/^ol_/);
  // With no agent picked the page shows the universal setup; picking Claude Code shows its command.
  expect(document.body.textContent).toContain("Any MCP client");
  await click(document.querySelector("[aria-label='Close dialog']"));
  await settle();
  await click([...document.querySelectorAll(".agent-chip")].find((b) => b.textContent?.includes("Claude Code")) || null);
  expect(document.body.textContent).toContain("claude mcp add --transport http --scope user orbytlink");
  // Snippets show the token masked; only the copy action carries it in full.
  expect(document.body.textContent).toContain(shown.slice(0, 7) + "••••••••");
  expect(document.body.textContent).toContain("Claude Code laptop");
  expect(document.body.innerHTML).not.toContain(shown);
  await click(button("Revoke"));
  await click(button("Revoke token"));
  await settle();
  expect(document.body.textContent).toContain("No gateway tokens");
});
