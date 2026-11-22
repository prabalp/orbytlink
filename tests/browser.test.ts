import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { grantCredits } from "../server/ai";
import { browse, planStep, publicPage, readAnswers, type PageState } from "../server/browser";
import { setDecision } from "../server/catalog";
import type { ServiceAdapters } from "../server/adapters";
import { inject } from "./inject";

const PAGE = "https://93.184.216.34/"; // an IP literal keeps the test off DNS
let app: Express, store: Store, cookie: string, identity: any;
let calls: { url: string; method: string; body: any }[];
let decideReply: (body: any) => Response;
let sessionDown = false;
const api = (url: string, body?: unknown, method = body ? "POST" : "GET") => inject(app, { url, method, headers: { Cookie: cookie }, body });
const balance = async () => (await api("/api/ai")).data.balance as number;
const home: PageState = {
  url: PAGE,
  title: "Acme",
  text: "Welcome to Acme",
  elements: [
    { i: 0, tag: "input", type: "search", label: "Search", value: "" },
    { i: 1, tag: "a", label: "Pricing" },
  ],
  scroll: 0,
  height: 900,
  viewport: 900,
};
const results: PageState = { ...home, url: `${PAGE}search?q=pro`, title: "Results", text: "Pro plan: $20/month", elements: [] };
// A decision model's answers, in question order, for the questions it was asked.
const answer = (body: any, picks: Record<string, string | number>) =>
  Response.json({
    model: body.model,
    answers: body.questions.map((q: any) => (q.type === "predicate" ? { type: "predicate", name: q.name, probability: Number(picks[q.name] ?? 0) } : { type: "choice", name: q.name, choice: String(picks[q.name] ?? q.choices[0].value), confidence: 0.9 })),
    usage: { input_tokens: 2000, output_tokens: 0, total_tokens: 2000 },
  });

beforeEach(async () => {
  Object.assign(process.env, { SCRAPER_URL: "http://scraper.internal:8700", SCRAPER_TOKEN: "scraper_token_123456", AI_GATEWAY_API_KEY: "vck_gateway_key_123456" });
  calls = [];
  sessionDown = false;
  // On the home page: type the user's value into the search box and press Enter. On results: done.
  decideReply = (body) => (body.input.includes("Pro plan: $20/month") ? answer(body, { operation: "DONE" }) : answer(body, { operation: "TYPE", type_target: "0", type_value: "v0", type_submit: 0.9 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init.method || "GET", body });
      if (url.endsWith("/decisions")) return decideReply(body);
      if (url === "http://scraper.internal:8700/session") return sessionDown ? new Response("down", { status: 502 }) : Response.json({ id: "s1", state: home });
      if (url === "http://scraper.internal:8700/session/s1/act") return Response.json({ ok: true, error: null, state: results });
      if (url === "http://scraper.internal:8700/session/s1") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    }),
  );
  store = new Store(":memory:");
  app = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters).app;
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  identity = (await api("/api/state")).data.identity;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["SCRAPER_URL", "SCRAPER_TOKEN", "AI_GATEWAY_API_KEY"]) delete process.env[k];
});

it("only opens public https pages", async () => {
  for (const bad of ["http://93.184.216.34/", "https://127.0.0.1/admin", "https://169.254.169.254/latest", "https://user:pw@93.184.216.34/", "https://[::1]/"])
    await expect(publicPage(bad), bad).rejects.toThrow();
  await expect(publicPage(PAGE)).resolves.toBeInstanceOf(URL);
});

it("asks only questions the page can answer, and accepts only options it offered", () => {
  const page: PageState = { ...home, height: 3000, elements: [...home.elements, { i: 2, tag: "select", label: "Plan", options: ["Free", "Pro"] }, { i: 3, tag: "button", label: "Off", disabled: true }] };
  const plan = planStep(page, ["pro"], 0);
  expect(plan.operations).toEqual(["CLICK", "TYPE", "SELECT", "SCROLL_DOWN", "DONE", "BLOCKED"]);
  expect(plan.questions.map((q) => q.name)).toEqual(["operation", "click_target", "type_target", "type_value", "type_submit", "select_target"]);
  const click = plan.questions.find((q) => q.name === "click_target") as any;
  expect(click.choices.map((c: any) => c.value)).toEqual(["0", "1"]); // not the dropdown, not the disabled button
  expect((plan.questions.find((q) => q.name === "select_target") as any).choices.map((c: any) => c.value)).toEqual(["2:0", "2:1"]);
  // With no values to type, typing isn't offered at all.
  expect(planStep(page, [], 0).operations).not.toContain("TYPE");
  const choice = (name: string, value: string) => ({ type: "choice", name, choice: value });
  expect(readAnswers(plan, { operation: choice("operation", "SELECT"), select_target: choice("select_target", "2:1") }, page, ["pro"])).toMatchObject({ action: "select", index: 2, text: "Pro" });
  expect(readAnswers(plan, { operation: choice("operation", "CLICK"), click_target: choice("click_target", "3") }, page, ["pro"])).toBeNull();
  expect(readAnswers(plan, { operation: choice("operation", "BACK") }, page, ["pro"])).toBeNull();
});

it("drives the page with decision models only, charging their tokens plus a fee per page action", async () => {
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price", values: ["pro"] }, "agent")).rejects.toMatchObject({ status: 402 });
  expect(calls).toHaveLength(0);
  grantCredits(store, identity.workspace, 1_000_000, "operator");
  const r = await browse(store, identity, { url: PAGE, goal: "Find the Pro price", values: ["pro"], maxSteps: 10 }, "agent");
  expect(r).toMatchObject({ status: "done", steps: 1, finalUrl: `${PAGE}search?q=pro`, models: ["Jev"] });
  expect(r.result).toContain("Pro plan: $20/month");
  expect(r.result).toContain('type "pro" into [0] "Search" + Enter');
  const decisions = calls.filter((c) => c.url.endsWith("/decisions"));
  expect(decisions).toHaveLength(2);
  expect(decisions[0]).toMatchObject({ url: "https://ai-gateway.vercel.sh/v1/decisions", body: { model: "typesafe-ai/jev" } });
  expect(decisions[0].body.input).toContain('[0] input search "Search" = empty');
  expect(calls.some((c) => c.url.endsWith("/chat/completions"))).toBe(false);
  expect(calls.find((c) => c.url.endsWith("/act"))!.body).toMatchObject({ action: "type", index: 0, text: "pro", enter: true });
  expect(calls.at(-1)).toMatchObject({ url: "http://scraper.internal:8700/session/s1", method: "DELETE" });
  // Two decisions: 2000 input tokens at Jev's $0.042 (cost) × 1.05 per 1M, plus one step's fee.
  const decision = Math.ceil(2000 * 0.0441);
  expect(r.costMicro).toBe(2 * decision + 1_000);
  expect(await balance()).toBe(1_000_000 - r.costMicro);
  expect((await api("/api/ai")).data.usage.map((u: any) => u.model)).toEqual(["orbytlink/browser-step", "typesafe-ai/jev", "typesafe-ai/jev"]);
});

it("moves to the next decision model when one fails, and gives the fee back when the page can't open", async () => {
  grantCredits(store, identity.workspace, 1_000_000, "operator");
  const first = decideReply;
  decideReply = (body) => (body.model === "typesafe-ai/jev" ? new Response("overloaded", { status: 503 }) : first(body));
  const r = await browse(store, identity, { url: PAGE, goal: "Find the Pro price", values: ["pro"] }, "agent");
  expect(r).toMatchObject({ status: "done", models: ["Decider Flash V1.2 4B"] });

  setDecision(store, ["liquid/d1"]);
  sessionDown = true;
  const before = await balance();
  await expect(browse(store, identity, { url: PAGE, goal: "Find the Pro price" }, "agent")).rejects.toMatchObject({ status: 502 });
  expect(await balance()).toBe(before);
});

it("is offered only while the scraper runs and a decision model can be called", async () => {
  expect((await api("/api/state")).data.browser).toMatchObject({ configured: true, models: [{ name: "Jev" }, { name: "Decider Flash V1.2 4B" }, { name: "Decision-1" }] });
  expect((await api("/api/state")).data.workflowStepTools.map((t: any) => t.name)).toContain("orbytlink__browse");
  delete process.env.AI_GATEWAY_API_KEY;
  expect((await api("/api/state")).data.workflowStepTools.map((t: any) => t.name)).not.toContain("orbytlink__browse");
  process.env.AI_GATEWAY_API_KEY = "vck_gateway_key_123456";
  delete process.env.SCRAPER_URL;
  expect((await api("/api/state")).data.browser.configured).toBe(false);
});
