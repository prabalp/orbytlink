import { afterEach, beforeEach, expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ map: {} as Record<string, string> }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (host: string) => [{ address: dns.map[host] ?? "93.184.216.34", family: 4 }]) }));
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { ServiceAdapters } from "../server/adapters";
import { extract, looksBlocked, robotsAllow, robotsRules, scrape, scrapeMaps, scraperUsage } from "../server/scraper";
import { inject } from "./inject";

type Reply = { status?: number; body?: string; type?: string; location?: string };
let sites: Record<string, Reply>, sidecarCalls: { path: string; body: any }[], store: Store;
const page = (body: string) => `<!doctype html><html><head><title>Bean There</title><meta name="description" content="Coffee in Austin"></head><body><p>Bean There roasts small batches in Austin and serves espresso, filter coffee and pastries every day from seven.</p>${body}${" ".repeat(250)}</body></html>`;

beforeEach(() => {
  process.env.OUTBOUND_HOSTS = "*";
  delete process.env.SCRAPER_DAILY_PAGES;
  process.env.SCRAPER_URL = "http://scraper.internal:8700";
  process.env.SCRAPER_TOKEN = "tok";
  dns.map = {};
  sidecarCalls = [];
  store = new Store(":memory:");
  sites = {
    "https://bean.example/robots.txt": { status: 404, body: "" },
    "https://bean.example/": {
      body: page(`<a href="mailto:hello@bean.example">Email</a> <a href="tel:+1 512 555 0100">Call</a>
        <a href="https://instagram.com/beanthere">IG</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
        <a href="/contact-us">Contact</a> <p class="price">$4</p><p class="price">$5</p> noreply@bean.example
        <script src="https://cdn.shopify.com/s/x.js"></script>`),
    },
    "https://bean.example/contact-us": { body: page(`Write to orders@bean.example or call (512) 555-0199. <a href="https://www.linkedin.com/company/bean">in</a>`) },
    "https://shy.example/robots.txt": { body: "User-agent: *\nDisallow: /private\n", type: "text/plain" },
    "https://shy.example/private/page": { body: page("secret") },
    "https://walled.example/robots.txt": { status: 404 },
    "https://walled.example/": { status: 403, body: "Forbidden" },
    "https://hop.example/robots.txt": { status: 404 },
    "https://hop.example/": { status: 302, location: "http://intranet.example/admin" },
  };
  dns.map["intranet.example"] = "10.0.0.7";
  dns.map["private.example"] = "192.168.1.5";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input instanceof URL ? input.href : input);
      if (url.startsWith("http://scraper.internal:8700")) {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        sidecarCalls.push({ path, body });
        if (path === "/fetch") return Response.json({ status: 200, finalUrl: body.url, html: page(`Rendered by the browser. <a href="mailto:team@walled.example">mail</a>`) });
        return Response.json({ query: body.query, partial: false, places: [{ name: "Jo's Coffee", category: "Coffee shop", website: "https://joscoffee.example/", phone: "+1 512-852-2300", address: "1300 S Congress Ave", plusCode: "", rating: 4.4, reviews: 2013, email: "", socials: {}, mapsUrl: "https://www.google.com/maps/place/Jo/data=!3d30.25!4d-97.74?authuser=0&hl=en", lat: 30.25, lon: -97.74 }] });
      }
      if (url === "https://www.google.com/robots.txt") return new Response("User-agent: *\nDisallow: /maps/\nAllow: /maps/search/\nAllow: /maps/place/\n", { headers: { "content-type": "text/plain" } });
      const r = sites[url];
      if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", ...(r.location ? { location: r.location } : {}) } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("pulls contacts, socials, the store platform and selected parts out of a page", () => {
  const base = new URL("https://bean.example/");
  const f = extract(sites["https://bean.example/"].body!, base, { prices: ".price" });
  expect(f.title).toBe("Bean There");
  expect(f.description).toBe("Coffee in Austin");
  expect(f.emails).toEqual(["hello@bean.example"]);
  expect(f.phones).toEqual(["+15125550100"]);
  expect(f.socials).toEqual({ instagram: "https://instagram.com/beanthere" });
  expect(f.storefront).toEqual(["shopify"]);
  expect(f.contactPages).toEqual(["https://bean.example/contact-us"]);
  expect(f.selected).toEqual({ prices: ["$4", "$5"] });
});

it("reads robots.txt the way crawlers do: longest rule wins, * and $ work", () => {
  const rules = robotsRules("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /maps/\nAllow: /maps/search/\nAllow: /maps/$\nDisallow: /*.pdf$\n");
  expect(robotsAllow(rules, "/maps/search/coffee")).toBe(true);
  expect(robotsAllow(rules, "/maps/")).toBe(true);
  expect(robotsAllow(rules, "/maps/api/js")).toBe(false);
  expect(robotsAllow(rules, "/files/a.pdf")).toBe(false);
  expect(robotsAllow(rules, "/about")).toBe(true);
  expect(robotsAllow(robotsRules("User-agent: OrbytLink\nDisallow: /\n\nUser-agent: *\nAllow: /\n"), "/x")).toBe(false);
});

it("reads a site with plain requests and follows its contact page", async () => {
  const out: any = await scrape(store, "w1", { url: "https://bean.example/", contacts: true });
  expect(out).toMatchObject({ via: "fast", status: 200, title: "Bean There" });
  expect(out.emails).toEqual(["hello@bean.example", "orders@bean.example"]);
  expect(out.phones).toEqual(["+15125550100", "5125550199"]);
  expect(out.socials).toEqual({ instagram: "https://instagram.com/beanthere", linkedin: "https://www.linkedin.com/company/bean" });
  expect(sidecarCalls).toEqual([]);
  expect(scraperUsage(store, "w1").pages).toBe(2);
});

it("switches to the stealth browser when a site blocks plain requests", async () => {
  const out: any = await scrape(store, "w1", { url: "https://walled.example/" });
  expect(out).toMatchObject({ via: "stealth", status: 200, emails: ["team@walled.example"] });
  expect(sidecarCalls.map((c) => c.path)).toEqual(["/fetch"]);
  expect(scraperUsage(store, "w1")).toMatchObject({ pages: 1, stealth: 1 });
  // mode fast never uses the browser
  const fast: any = await scrape(store, "w1", { url: "https://walled.example/", mode: "fast" });
  expect(fast).toMatchObject({ via: "fast", status: 403 });
  expect(sidecarCalls).toHaveLength(1);
});

it("without the stealth service, a blocked site comes back as it was", async () => {
  delete process.env.SCRAPER_URL;
  const out: any = await scrape(store, "w1", { url: "https://walled.example/" });
  expect(out).toMatchObject({ via: "fast", status: 403, error: "The site answered HTTP 403." });
  await expect(scrapeMaps(store, "w1", { query: "coffee" })).rejects.toThrow(/isn't running/);
});

it("refuses private addresses, also behind a redirect, and pages robots.txt rules out", async () => {
  const out: any = await scrape(store, "w1", { urls: ["http://private.example/", "https://hop.example/", "https://shy.example/private/page", "", "https://bean.example/"] });
  expect(out.pages.map((p: any) => p.error ?? "ok")).toEqual([
    "Private and reserved addresses can't be read.",
    "Private and reserved addresses can't be read.",
    "The site's robots.txt asks crawlers not to read this page.",
    "No address given.",
    "ok",
  ]);
  expect(sidecarCalls).toEqual([]);
  await expect(scrape(store, "w1", { url: "file:///etc/passwd" })).resolves.toMatchObject({ error: expect.stringMatching(/public http/) });
});

it("stops at the workspace's daily allowance", async () => {
  process.env.SCRAPER_DAILY_PAGES = "2";
  await scrape(store, "w1", { url: "https://bean.example/" });
  await scrape(store, "w1", { url: "https://bean.example/" });
  await expect(scrape(store, "w1", { url: "https://bean.example/" })).rejects.toThrow(/read today's 2 pages/);
  // Another workspace has its own allowance.
  await expect(scrape(store, "w2", { url: "https://bean.example/" })).resolves.toMatchObject({ status: 200 });
});

it("searches Google Maps through the stealth service", async () => {
  const out: any = await scrapeMaps(store, "w1", { query: "coffee shops", location: "Austin, TX", maxResults: "5" });
  expect(sidecarCalls).toEqual([{ path: "/maps", body: { query: "coffee shops in Austin, TX", maxResults: 5, timeoutSeconds: 100 } }]);
  expect(out).toMatchObject({ query: "coffee shops in Austin, TX", count: 1, places: [{ name: "Jo's Coffee", website: "https://joscoffee.example/", mapsUrl: "https://www.google.com/maps/place/Jo/data=!3d30.25!4d-97.74" }] });
  expect(scraperUsage(store, "w1").maps).toBe(1);
});

it("is a workflow step and shows in the console's catalog state", async () => {
  const services: ServiceAdapters = { test: vi.fn(), call: vi.fn() };
  const { app } = createApp(store, services);
  const r = await inject(app, { url: "/api/auth/register", method: "POST", body: { name: "Alice", email: "alice@example.invalid", password: "Correct-horse-ship-2026" } });
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  const api = (url: string, body?: unknown) => inject(app, { url, method: body ? "POST" : "GET", headers: { Cookie: cookie }, body });
  const state = (await api("/api/state")).data;
  expect(state.scraper).toMatchObject({ stealth: true, usage: { pages: 0, limits: { pages: 3000, stealth: 300, maps: 30 } } });
  expect(state.workflowStepTools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["orbytlink__scrape", "orbytlink__scrape_maps"]));
  const wf = (
    await api("/api/workflows", {
      name: "Business contacts",
      enabled: true,
      inputs: [{ name: "query", required: true }],
      steps: [
        { id: "places", tool: "orbytlink__scrape_maps", args: { query: "{{input.query}}", maxResults: "3" } },
        { id: "sites", tool: "orbytlink__scrape", args: { urls: "{{steps.places.json.places.0.website}}" }, when: { value: "{{steps.places.json.count}}" } },
      ],
    })
  ).data;
  sites["https://joscoffee.example/robots.txt"] = { status: 404 };
  sites["https://joscoffee.example/"] = { body: page(`<a href="mailto:hi@joscoffee.example">mail</a>`) };
  // A single website as urls: the step turns it into a list of one.
  wf.steps[1].args.urls = '["{{steps.places.json.places.0.website}}"]';
  await inject(app, { url: `/api/workflows/${wf.id}`, method: "PUT", headers: { Cookie: cookie }, body: wf });
  const run = (await api(`/api/workflows/${wf.id}/run`, { inputs: { query: "coffee in Austin" } })).data;
  expect(run.status, JSON.stringify(run)).toBe("succeeded");
  expect(run.data.pages[0]).toMatchObject({ emails: ["hi@joscoffee.example"] });
});

it("knows a JavaScript shell from a real page", () => {
  expect(looksBlocked(200, `<html><body><div id="root"></div><script src="/app.js"></script>${" ".repeat(300)}</body></html>`)).toBe(true);
  expect(looksBlocked(200, page("A real page with enough words in it to be read without a browser at all, about coffee and opening hours."))).toBe(false);
  expect(looksBlocked(429, page("x"))).toBe(true);
});
