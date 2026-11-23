// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

// The extension's own scripts are plain browser JavaScript; load them by a computed path so the
// TypeScript build doesn't treat them as part of the app.
const load = async (name: string): Promise<any> => import(/* @vite-ignore */ `../extension/${name}.js` as string);

beforeEach(() => {
  // happy-dom lays nothing out, so give every element a size and the page a viewport.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20, toJSON() {} } as DOMRect);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ visibility: "visible", display: "block", opacity: "1" } as CSSStyleDeclaration);
  vi.stubGlobal("getComputedStyle", window.getComputedStyle);
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  document.body.innerHTML = `
    <h1>Sign in</h1>
    <form>
      <input type="email" aria-label="Email" value="">
      <input type="password" aria-label="Password" value="hunter2">
      <select aria-label="Plan"><option>Free</option><option>Pro</option></select>
      <button type="button">Delete account</button>
    </form>`;
});

it("reads the page the way the server's browser does, and never reads a password", async () => {
  const { readState } = await load("page");
  const s = readState(150);
  expect(s.title).toBe("");
  expect(s.elements.map((e: any) => [e.i, e.tag, e.type, e.label])).toEqual([
    [0, "input", "email", "Email"],
    [1, "input", "password", "Password"],
    [2, "select", undefined, "Plan"],
    [3, "button", "button", "Delete account"],
  ]);
  expect(s.elements[1].value).toBe(""); // the typed password stays in the page
  expect(JSON.stringify(s)).not.toContain("hunter2");
  expect(s.elements[2]).toMatchObject({ value: "Free", options: ["Free", "Pro"] });
  expect(document.querySelector('[data-orbyt-i="3"]')?.textContent).toBe("Delete account");
});

it("types and selects through the page, but refuses a password field", async () => {
  const { readState, actType, actSelect, hasPassword } = await load("page");
  readState(150);
  expect(actType(0, "me@example.com", false)).toEqual({ ok: true });
  expect((document.querySelector("input[type=email]") as HTMLInputElement).value).toBe("me@example.com");
  expect(actType(1, "anything", false)).toMatchObject({ ok: false, error: expect.stringMatching(/never types into a password/i) });
  expect((document.querySelector("input[type=password]") as HTMLInputElement).value).toBe("hunter2");
  expect(actSelect(2, "pro")).toEqual({ ok: true });
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("Pro");
  expect(actSelect(2, "Enterprise")).toMatchObject({ ok: false });
  expect(actType(99, "x", false)).toMatchObject({ ok: false });
  expect(hasPassword()).toBe(true);
  document.querySelector("input[type=password]")!.remove();
  expect(hasPassword()).toBe(false);
});

it("fills a saved sign-in into the right fields and submits it", async () => {
  const { fillLogin } = await load("page");
  const form = document.querySelector("form") as HTMLFormElement;
  const submit = vi.fn();
  form.requestSubmit = submit;
  expect(fillLogin("me@example.com", "s3cret")).toEqual({ ok: true, filled: "both" });
  expect((document.querySelector("input[type=email]") as HTMLInputElement).value).toBe("me@example.com");
  expect((document.querySelector("input[type=password]") as HTMLInputElement).value).toBe("s3cret");
  expect(submit).toHaveBeenCalledOnce();
  document.body.innerHTML = "<p>No form here</p>";
  expect(fillLogin("a", "b")).toMatchObject({ ok: false });
});

it("keeps saved sign-ins encrypted, locked without the passphrase, and matched by site", async () => {
  // A stand-in for chrome.storage: local persists, session is memory only.
  const area = () => {
    const data: Record<string, any> = {};
    return {
      data,
      get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
      set: async (o: Record<string, any>) => void Object.assign(data, o),
      remove: async (k: string) => void delete data[k],
    };
  };
  const local = area();
  let session = area();
  vi.stubGlobal("chrome", { storage: { local, get session() { return session; } } });
  const vault = await load("vault");

  expect(await vault.vaultStatus()).toEqual({ exists: false, unlocked: false, sites: [] });
  await expect(vault.unlock("short")).rejects.toThrow(/at least 8/);
  await vault.unlock("correct horse battery");
  await vault.saveLogin("GitHub.com", "me@example.com", "p@ss w0rd");
  expect(await vault.vaultStatus()).toEqual({ exists: true, unlocked: true, sites: ["github.com"] });
  // Nothing readable is stored.
  const stored = JSON.stringify(local.data);
  expect(stored).not.toContain("p@ss w0rd");
  expect(stored).not.toContain("me@example.com");

  expect(await vault.loginFor("github.com")).toEqual({ user: "me@example.com", pass: "p@ss w0rd" });
  expect(await vault.loginFor("gist.github.com")).toEqual({ user: "me@example.com", pass: "p@ss w0rd" });
  expect(await vault.loginFor("notgithub.com")).toBeNull();

  // Closing the browser clears the session storage: locked again, and the wrong passphrase is refused.
  session = area();
  expect((await vault.vaultStatus()).unlocked).toBe(false);
  expect(await vault.loginFor("github.com")).toBeNull();
  await expect(vault.unlock("wrong passphrase!")).rejects.toThrow(/wrong/);
  await vault.unlock("correct horse battery");
  expect(await vault.loginFor("github.com")).toMatchObject({ user: "me@example.com" });
  await vault.forgetLogin("github.com");
  expect(await vault.loginFor("github.com")).toBeNull();
  vi.unstubAllGlobals();
});
