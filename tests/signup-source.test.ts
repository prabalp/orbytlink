import { beforeEach, expect, it } from "vitest";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantOperator } from "../server/admin";
import { cleanSource } from "../server/signup-source";
import { inject } from "./inject";

let store: Store, app: ReturnType<typeof createApp>["app"];
beforeEach(() => {
  store = new Store(":memory:");
  app = createApp(store).app;
});
const register = (email: string, source?: unknown) =>
  inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email, password: "Correct-horse-ship-2026", ...(source !== undefined ? { source } : {}) } });

it("keeps only short, plain values from the browser", () => {
  expect(cleanSource({ lp: "/blog/post/", ref: "Google.com", source: "newsletter", medium: "email", campaign: "launch 1" })).toBe(
    JSON.stringify({ lp: "/blog/post/", ref: "google.com", source: "newsletter", medium: "email", campaign: "launch 1" }),
  );
  // A full URL, a query string, markup, a path that isn't one, and non-objects are all dropped.
  expect(cleanSource({ lp: "https://evil.example/x", ref: "a b", source: "<b>" })).toBeNull();
  // Over-long values are cut to their limit, not kept whole.
  expect(JSON.parse(cleanSource({ medium: "x".repeat(200) })!).medium).toHaveLength(60);
  expect(cleanSource({ lp: "/pricing?email=a@b.c" })).toBeNull();
  expect(cleanSource("string")).toBeNull();
  expect(cleanSource(["a"])).toBeNull();
  expect(cleanSource(null)).toBeNull();
});

it("stores where an email signup came from, and signs up fine without it", async () => {
  expect((await register("a@example.invalid", { lp: "/blog/x/", source: "newsletter" })).status).toBe(200);
  expect((await register("b@example.invalid")).status).toBe(200);
  expect((await register("c@example.invalid", { lp: "javascript:alert(1)" })).status).toBe(200);
  const get = (email: string) => (store.db.prepare("SELECT signup_source FROM accounts WHERE email=?").get(email) as { signup_source: string | null }).signup_source;
  expect(JSON.parse(get("a@example.invalid")!)).toEqual({ lp: "/blog/x/", source: "newsletter" });
  expect(get("b@example.invalid")).toBeNull();
  expect(get("c@example.invalid")).toBeNull();
});

it("shows signups by day, landing page and channel in the admin overview", async () => {
  const first = await register("op@example.invalid", { lp: "/blog/x/", ref: "google.com" });
  const cookie = String(first.headers["set-cookie"]).split(";")[0];
  await register("b@example.invalid", { lp: "/blog/x/", source: "newsletter" });
  await register("c@example.invalid", { lp: "/pricing" });
  await register("d@example.invalid");
  // An account from before sources were recorded, and one from a year ago.
  store.db.prepare("UPDATE accounts SET created_at=? WHERE email=?").run(Date.now() - 400 * 86_400_000, "d@example.invalid");
  grantOperator(store, "op@example.invalid");
  const o = (await inject(app, { url: "/api/admin/overview?days=30", headers: { Cookie: cookie } })).data.signups;
  expect(o).toMatchObject({ total: 4, inRange: 3 });
  expect(o.byDay).toEqual([{ key: new Date().toISOString().slice(0, 10), n: 3 }]);
  expect(o.byPage).toEqual([{ key: "/blog/x/", n: 2 }, { key: "/pricing", n: 1 }]);
  expect(o.byChannel).toEqual(expect.arrayContaining([{ key: "google.com", n: 1 }, { key: "newsletter", n: 1 }, { key: "Direct", n: 1 }]));
});
