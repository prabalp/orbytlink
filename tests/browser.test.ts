import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { browse, publicPage } from "../server/browser";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

const PAGE = "https://93.184.216.34/pricing"; // an IP literal keeps the test off DNS
let app: Express, store: Store, cookie: string, identity: any;
let sidecar: { body: any; auth: string | null }[], answer: () => Response;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const balance = async () => (await api("/api/ai")).data.balance as number;

beforeEach(async () => {
  process.env.BROWSER_URL = "http://browser.internal:8800";
  process.env.BROWSER_TOKEN = "browser_token_123456";
  sidecar = [];
  answer = () => Response.json({ status: "done", result: "Pro costs $20/month", steps: 4, finalUrl: "https://93.184.216.34/pricing" });
  vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
    sidecar.push({ body: JSON.parse(init.body), auth: new Headers(init.headers).get("authorization") });
    return answer();
  }));
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  identity = (await api("/api/state")).data.identity;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BROWSER_URL;
  delete process.env.BROWSER_TOKEN;
});

it("only opens public https pages", async () => {
  for (const bad of ["http://93.184.216.34/", "https://127.0.0.1/admin", "https://169.254.169.254/latest", "https://user:pw@93.184.216.34/", "https://[::1]/"])
    await expect(publicPage(bad), bad).rejects.toThrow();
  await expect(publicPage(PAGE)).resolves.toBeInstanceOf(URL);
});

it("charges the steps actually taken, holds the most it could cost, and refuses without credit", async () => {
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price" }, "agent")).rejects.toMatchObject({ status: 402 });
  expect(sidecar).toHaveLength(0);
  grantCredits(store, identity.workspace, 1_000_000, "operator");
  const r = await browse(store, identity, { url: PAGE, goal: "Find the Pro price", maxSteps: 10 }, "agent");
  expect(r).toMatchObject({ status: "done", result: "Pro costs $20/month", steps: 4, costMicro: 40_000 });
  expect(sidecar[0]).toMatchObject({ auth: "Bearer browser_token_123456", body: { url: PAGE, maxSteps: 10 } });
  expect(await balance()).toBe(960_000);
  expect((await api("/api/ai")).data.usage[0]).toMatchObject({ model: "browser", micro: 40_000, via: "agent" });
});

it("gives the whole hold back when the service is down", async () => {
  grantCredits(store, identity.workspace, 1_000_000, "operator");
  answer = () => new Response("nope", { status: 500 });
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price" }, "agent")).rejects.toMatchObject({ status: 502 });
  expect(await balance()).toBe(1_000_000);
});

it("is offered as a workflow step only while the browser service is configured", async () => {
  expect((await api("/api/state")).data.workflowStepTools.map((t: any) => t.name)).toContain("orbytlink__browse");
  delete process.env.BROWSER_URL;
  expect((await api("/api/state")).data.workflowStepTools.map((t: any) => t.name)).not.toContain("orbytlink__browse");
});
