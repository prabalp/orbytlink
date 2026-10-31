import { expect, it, vi } from "vitest";
import express from "express";
import { Store } from "../server/store";
import { truncateResult, RESULT_LIMIT } from "../server/adapters";
import { errorHandler } from "../server/app";
import { inject } from "./inject";

it("redacts secrets of any length without corrupting the data around them", () => {
  const store = new Store(":memory:");
  store.secret("w", "short", "1234");
  store.secret("w", "colon", ":");
  store.secret("w", "long", "sk_live_51Hsecret");
  const out = store.redact("w", { name: "Stripe", count: 12345, pin: "1234", note: "key sk_live_51Hsecret leaked", list: [":"] });
  expect(out).toEqual({ name: "Stripe", count: 12345, pin: "[REDACTED]", note: "key [REDACTED] leaked", list: ["[REDACTED]"] });
  expect(store.redact("w", { auth: "Bearer abc.def" })).toEqual({ auth: "Bearer [REDACTED]" });
});

it("cuts oversized tool results down to their text instead of failing", () => {
  const small = { content: [{ type: "text", text: "hi" }] };
  expect(truncateResult(small)).toBe(small);
  const big = truncateResult({ content: [{ type: "text", text: "x".repeat(RESULT_LIMIT * 2) }], isError: true });
  expect(JSON.stringify(big).length).toBeLessThan(RESULT_LIMIT + 1000);
  expect(big.isError).toBe(true);
  expect(big.content[0].text).toMatch(/Truncated by OrbytLink: the full result was 200 KB/);
});

it("answers 500 for server bugs, logs them, and keeps details out of the response", async () => {
  const app = express();
  app.get("/bug", () => {
    throw new TypeError("secret internals");
  });
  app.get("/input", () => {
    throw new Error("Endpoint is not configured");
  });
  app.use(errorHandler);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const bug = await inject(app, { url: "/bug", method: "GET" });
  expect(bug.status).toBe(500);
  expect(JSON.stringify(bug.data)).not.toContain("secret internals");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("GET /bug → 500"), expect.stringContaining("secret internals"));
  // Plain errors stay 400 as before, and are still logged since nothing gave them a status.
  expect((await inject(app, { url: "/input", method: "GET" })).status).toBe(400);
  expect(log).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
