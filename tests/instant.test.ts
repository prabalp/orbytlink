import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { aiSummary, grantCredits } from "../server/ai";
import { callInstant, resetBreakers, instantPlatform, instantTool, priceList, rebuild, searchInstant, setQuote, setWallet, syncCatalog, walletReport } from "../server/instant";
import { scrub } from "../server/instant/upstream";
import { setSources, sources } from "../server/instant/sources";
import { sourceA } from "../server/instant/treg";
import { priceFromText } from "../server/instant/composio";
import type { CallOutcome, Route, Upstream } from "../server/instant/upstream";
import { inject } from "./inject";

const original = sources();
const group = { slug: "web", label: "Open web & SEO data", category: "SEO/AEO", summary: "" };
const route = (upstream: string, ref: string, over: Partial<Route> = {}): Route => ({
  upstream,
  ref,
  key: "serper:POST /search",
  provider: "Serper",
  name: "Google search",
  summary: "Organic results",
  job: "Search Google",
  group,
  method: "POST",
  path: "/search",
  best: false,
  costUsd: 0.001,
  costType: "per_call",
  unit: "call",
  per: 1,
  input: null,
  example: null,
  reliability: null,
  docs: "",
  ...over,
});
type Fake = Upstream & { calls: { ref: string; input: any }[]; next: (r: Route) => CallOutcome; routes: Route[] };
const fake = (id: string, routes: Route[], balance?: number): Fake => {
  const f: Fake = {
    id,
    routes,
    calls: [],
    next: () => ({ status: 200, json: { ok: id, note: "served by composio" }, text: "{}", costMicro: Math.round((routes[0].costUsd ?? 0) * 1e6) }),
    configured: () => true,
    catalog: async () => f.routes,
    call: async (r, input) => {
      f.calls.push({ ref: r.ref, input });
      return f.next(r);
    },
    ...(balance !== undefined ? { balance: async () => balance } : {}),
  };
  return f;
};
let store: Store;
const me = { user: "alice@example.invalid", workspace: "ws_1", permissions: ["call", "configure"] } as any;
beforeEach(() => {
  resetBreakers();
  store = new Store(":memory:");
  delete process.env.INSTANT_MARKUP_PERCENT;
});
afterEach(() => {
  setSources(original);
  vi.unstubAllGlobals();
});

it("merges the same call from several sources into one tool, and keeps the rest side by side", async () => {
  const a = fake("a", [route("a", "serper.web.search", { id: "serper.web.search", costUsd: 0.001 }), route("a", "treg.web.search", { id: "best.web.search", key: "best:best.web.search", best: true, provider: "Best available", costUsd: null })]);
  const b = fake("b", [route("b", "serper|/search", { key: "serper:ANY /search", method: "ANY", costUsd: 0.0008 }), route("b", "serpapi|/duckduckgo/maps", { key: "serpapi:ANY /duckduckgo/maps", method: "ANY", provider: "SerpApi", name: "Search private maps", costUsd: 0.015 })]);
  const e = fake("e", [route("e", "EXA_SEARCH", { key: "e:EXA_SEARCH", id: "exa.search", provider: "Exa", name: "Exa search", costUsd: 0.007 })]);
  setSources([a, b, e]);
  const out = await syncCatalog(store);
  // The routed tool has no published cost, so it waits for the operator's price before it is sold.
  expect(out).toMatchObject({ tools: 3, merged: 1 });
  expect(() => instantTool(store, "best.web.search")).toThrow(/No instant tool/);
  setQuote(store, "best.web.search", 0.02, "operator");
  rebuild(store);
  expect(instantTool(store, "best.web.search").price.usd).toBe(0.02);
  const serper = instantTool(store, "serper.web.search");
  expect(serper).not.toHaveProperty("routes");
  expect(JSON.stringify(instantPlatform(store, "web"))).not.toMatch(/"routes"|upstream|composio/i);
  expect(priceList(store).find((p) => p.tool === "serper.web.search")).toMatchObject({ routes: "ab", cheapestCostUsd: 0.0008 });
  expect(searchInstant(store, "search").map((t) => t.id)).toContain("exa.search");
});

it("quotes each tool once from its cheapest route plus the markup, and keeps the operator's price", async () => {
  setSources([fake("a", [route("a", "x", { id: "serper.web.search", costUsd: 0.001 })]), fake("b", [route("b", "y", { key: "serper:ANY /search", method: "ANY", costUsd: 0.0034 })])]);
  await syncCatalog(store);
  // $0.001 + 5% = $0.00105, rounded up to the next $0.0001: $0.0011.
  expect(instantTool(store, "serper.web.search").price.usd).toBe(0.0011);
  // A new markup applies at once, with nothing to recompute: $0.001 + 20% = $0.0012.
  process.env.INSTANT_MARKUP_PERCENT = "20";
  expect(instantTool(store, "serper.web.search").price.usd).toBe(0.0012);
  expect(priceList(store)[0]).toMatchObject({ priceUsd: 0.0012, setBy: "markup 20%" });
  // A quote an earlier version saved for every tool doesn't pin the price.
  store.put("_instant", "instant_prices", { id: "serper.web.search", micro: 1100, by: "default" });
  rebuild(store);
  expect(instantTool(store, "serper.web.search").price.usd).toBe(0.0012);
  expect(store.list("_instant", "instant_prices")).toHaveLength(0);
  setQuote(store, "serper.web.search", 0.01, "operator");
  rebuild(store);
  expect(instantTool(store, "serper.web.search").price.usd).toBe(0.01);
  expect(priceList(store)[0]).toMatchObject({ tool: "serper.web.search", priceUsd: 0.01, setBy: "operator" });
});

it("sends a call to the cheapest source with money for it, charges the quote, and spends from that wallet", async () => {
  const a = fake("a", [route("a", "x", { id: "serper.web.search", costUsd: 0.001 })], 5_000_000);
  const b = fake("b", [route("b", "y", { key: "serper:ANY /search", method: "ANY", costUsd: 0.0008 })]);
  const e = fake("e", [route("e", "z", { key: "serper:ANY /search", method: "ANY", costUsd: 0.0005 })]);
  setSources([a, b, e]);
  await syncCatalog(store);
  setQuote(store, "serper.web.search", 0.01, "operator");
  grantCredits(store, "ws_1", 1_000_000, "operator");
  // e is cheapest but its wallet (kept by hand) is empty; b has no balance API and no wallet row: assumed funded.
  setWallet(store, "e", 0);
  const r = await callInstant(store, me, { id: "serper.web.search", body: { q: "coffee" } }, "agent");
  expect(e.calls).toHaveLength(0);
  expect(b.calls).toHaveLength(1);
  expect(b.calls[0].input).toMatchObject({ body: { q: "coffee" }, tag: "ws_1" });
  // The source may charge at most the quote less the 5% margin.
  expect(b.calls[0].input.maxCostUsd).toBeCloseTo(0.00952, 5);
  expect(r).toMatchObject({ id: "serper.web.search", costUsd: 0.01, result: { ok: "b", note: "served by OrbytLink" } });
  expect(aiSummary(store, "ws_1").balance).toBe(990_000);
  // With money in e's wallet, e takes the next call and its wallet goes down by what it cost.
  setWallet(store, "e", 12);
  await callInstant(store, me, { id: "serper.web.search", body: { q: "tea" } }, "agent");
  expect(e.calls).toHaveLength(1);
  expect(walletReport(store).find((w) => w.source === "e")!.wallet!.micro).toBe(12_000_000 - 500);
  // a reported its balance through its API.
  expect(walletReport(store).find((w) => w.source === "a")!.wallet).toMatchObject({ from: "api", micro: 5_000_000 });
});

it("moves on when a source is down or out of money, stops on a refused request, and charges nothing then", async () => {
  const a = fake("a", [route("a", "x", { id: "serper.web.search", costUsd: 0.0005 })]);
  const b = fake("b", [route("b", "y", { key: "serper:ANY /search", method: "ANY", costUsd: 0.0008 })]);
  setSources([a, b]);
  await syncCatalog(store);
  // The default quote follows the cheapest source, so the dearer one would lose money: it is skipped.
  a.next = () => ({ status: 503, text: "", costMicro: 0, unavailable: true });
  grantCredits(store, "ws_1", 1_000_000, "operator");
  await expect(callInstant(store, me, { id: "serper.web.search", body: {} }, "agent")).rejects.toThrow(/briefly unavailable/);
  expect(b.calls).toHaveLength(0);
  // A quote that covers both lets the dearer source step in.
  setQuote(store, "serper.web.search", 0.01, "operator");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  a.next = () => ({ status: 402, text: "", costMicro: 0, unavailable: true, accountProblem: "402 insufficient_balance" });
  const r = await callInstant(store, me, { id: "serper.web.search", body: { q: "x" } }, "agent");
  expect(r.result).toEqual({ ok: "b", note: "served by OrbytLink" });
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("account problem"));
  const before = aiSummary(store, "ws_1").balance;
  b.next = () => ({ status: 400, text: "", costMicro: 0, refusal: "q is required" });
  a.next = () => ({ status: 503, text: "", costMicro: 0, unavailable: true });
  await expect(callInstant(store, me, { id: "serper.web.search", body: {} }, "agent")).rejects.toThrow("q is required");
  expect(aiSummary(store, "ws_1").balance).toBe(before);
  b.next = () => ({ status: 503, text: "", costMicro: 0, unavailable: true });
  await expect(callInstant(store, me, { id: "serper.web.search", body: {} }, "agent")).rejects.toThrow(/briefly unavailable/);
  expect(aiSummary(store, "ws_1").balance).toBe(before);
  errors.mockRestore();
});

it("refuses a call the workspace can't pay for, before any source is asked", async () => {
  const a = fake("a", [route("a", "x", { id: "serper.web.search" })]);
  setSources([a]);
  await syncCatalog(store);
  await expect(callInstant(store, me, { id: "serper.web.search", body: {} }, "agent")).rejects.toThrow(/Not enough credit/);
  expect(a.calls).toHaveLength(0);
});

it("shows workspaces one catalog with quotes and never a source", async () => {
  setSources([fake("a", [route("a", "x", { id: "serper.web.search" })]), fake("e", [route("e", "EXA_SEARCH", { key: "e:EXA_SEARCH", id: "exa.search", provider: "Exa", name: "Exa search, via Composio", costUsd: 0.007 })])]);
  await syncCatalog(store);
  const { app } = createApp(store, { test: vi.fn(), call: vi.fn() } as ServiceAdapters);
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  const groups = (await inject(app, { url: "/api/instant", headers: { Cookie: cookie } })).data;
  const web = (await inject(app, { url: "/api/instant/web", headers: { Cookie: cookie } })).data;
  expect(groups.platforms).toEqual([expect.objectContaining({ slug: "web", tools: 2 })]);
  expect(JSON.stringify([groups, web])).not.toMatch(/composio|monid|orthogonal|o11|treg|"routes"|upstream/i);
});

it("scrubs every source's name", () => {
  const text = scrub("call treg.people.email.find via https://treg.to/call/x; see X-Treg-Route-Waterfall: 0. Composio's key, monid.ai, Orthogonal, o11 and tools-registry by Superdesign");
  expect(text).not.toMatch(/treg|composio|monid|orthogonal|o11|superdesign|registry/i);
  expect(scrub("_treg.domain_match")).toBe("_route.domain_match");
  expect(priceFromText("$0.007 per search")).toBe(0.007);
  expect(priceFromText("$0.001 per 10 API calls")).toBeCloseTo(0.0001, 10);
  expect(priceFromText("$5 per 1,000 calls")).toBeCloseTo(0.005, 10);
  expect(priceFromText("$2 / 1k requests")).toBeCloseTo(0.002, 10);
  expect(priceFromText("$0.001 per credit used; typically 5 credits ($0.005) per request")).toBe(0.005);
  expect(priceFromText("From $0.5 per 1,000 requests; billed at actual cost")).toBeCloseTo(0.0005, 10);
  expect(priceFromText("Free during beta")).toBeNull();
});

it("source a: relays the native call with its token, the workspace tag, a cost ceiling and an idempotency key", async () => {
  process.env.INSTANT_TOKEN = "tok_secret";
  const calls: { url: string; init: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ output: [], _treg: { served_by: "serper" } }), { headers: { "X-Treg-Cost-Micro": "900", "X-Treg-Served-By": "serper" } });
    }),
  );
  const out = await sourceA.call(route("a", "treg.web.search", { best: true }), { body: { q: "x" }, options: { waterfall: false }, maxCostUsd: 0.02, tag: "ws_1", idempotencyKey: "k1" });
  expect(out).toMatchObject({ status: 200, costMicro: 900, servedBy: "serper" });
  expect(calls[0].url).toMatch(/\/call\/treg\.web\.search$/);
  expect(calls[0].init.headers).toMatchObject({ "X-Treg-Token": "tok_secret", "X-Treg-Meta": "customer=ws_1", "X-Treg-Route-Max-Cost": "0.020000", "Idempotency-Key": "k1", "X-Treg-Route-Waterfall": "0" });
  delete process.env.INSTANT_TOKEN;
});
