import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { parse, type HTMLElement } from "node-html-parser";
import { z } from "zod";
import type { Store } from "./store.js";
import { hostAllowed, isPublicAddress } from "./adapters.js";
import { textOfHtml } from "./apis.js";

// The scraper that comes with OrbytLink, carried over from Lead Orbyt. Pages are read with a plain
// request first (fast, free); a site that blocks plain requests or needs JavaScript goes to the
// stealth scraper (scraper/, an undetected Chromium on this server). Google Maps searches always go
// there. It obeys robots.txt, backs off from a site that pushes back, reads public addresses only
// and has a daily allowance per workspace, so one workspace can't wear the server out.
export const SCRAPE_TOOL = "orbytlink__scrape";
export const MAPS_TOOL = "orbytlink__scrape_maps";
export const scraperConfigured = () => !!process.env.SCRAPER_URL && !!process.env.SCRAPER_TOKEN;
const MAX_URLS = 25,
  MAX_BYTES = 2_000_000,
  FAST_TIMEOUT = 10_000,
  BUDGET = 100_000,
  PARALLEL = 5,
  REDIRECTS = 5;
const UA = "Mozilla/5.0 (compatible; OrbytLink/1.0; +https://orbytlink.com)";
const limits = () => ({
  pages: Number(process.env.SCRAPER_DAILY_PAGES) || 3000,
  stealth: Number(process.env.SCRAPER_DAILY_STEALTH) || 300,
  maps: Number(process.env.SCRAPER_DAILY_MAPS) || 30,
});
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status, safe: true });

export const scrapeInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "A public web page, e.g. https://www.example.com" },
    urls: { type: "array", items: { type: "string" }, description: `Several pages at once (at most ${MAX_URLS}), read in parallel. Empty entries are skipped.` },
    contacts: { type: "boolean", description: "Also read up to two contact or about pages per site and add what they list (emails, phones, socials). Default false." },
    mode: { type: "string", enum: ["auto", "fast", "stealth"], description: "auto (default): a plain request, then a real browser if the site blocks it or needs JavaScript. fast: plain request only. stealth: always the browser (slower; counts against the smaller stealth allowance)." },
    select: { type: "object", additionalProperties: { type: "string" }, description: 'Parts of the page to pull out, name → CSS selector, e.g. {"prices": ".price", "headings": "h2"}. Each gives the text of up to 50 matches.' },
    waitFor: { type: "string", description: "Browser only: a CSS selector to wait for before reading the page." },
  },
};
export const mapsInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: 'What to look for, e.g. "coffee shops" or "dentists in Pune"' },
    location: { type: "string", description: 'Where, e.g. "Austin, TX" (added to the query)' },
    maxResults: { type: "integer", minimum: 1, maximum: 60, description: "How many places, 1-60 (default 20). About 3 seconds per place." },
  },
  required: ["query"],
};
const flag = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const scrapeSchema = z
  .object({
    url: z.string().max(2000).optional(),
    urls: z.array(z.string().max(2000).nullable()).max(MAX_URLS, `Read at most ${MAX_URLS} pages at once`).optional(),
    contacts: flag.default(false),
    mode: z.enum(["auto", "fast", "stealth"]).default("auto"),
    select: z
      .union([z.record(z.string().max(40), z.string().max(300)), z.string().transform((s) => (s.trim() ? JSON.parse(s) : undefined))])
      .optional()
      .refine((v) => !v || Object.keys(v).length <= 20, "Select at most 20 parts"),
    waitFor: z.string().max(300).optional(),
  })
  .refine((v) => v.url !== undefined || v.urls !== undefined, "Give url or urls");
const mapsSchema = z.object({
  query: z.string().trim().min(2).max(250),
  location: z.string().trim().max(150).default(""),
  maxResults: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(60)).default(20),
});

// ── Daily allowance ──────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
export function scraperUsage(store: Store, w: string) {
  const row = store.list(w, "scraper_usage").find((r) => r.id === today());
  return { date: today(), pages: row?.pages || 0, stealth: row?.stealth || 0, maps: row?.maps || 0, limits: limits() };
}
function spend(store: Store, w: string, kind: "pages" | "stealth" | "maps") {
  const u = scraperUsage(store, w);
  if (u[kind] >= u.limits[kind])
    throw fail(
      kind === "maps"
        ? `This workspace has used today's ${u.limits.maps} Google Maps searches. It resets at midnight UTC.`
        : kind === "stealth"
          ? `This workspace has used today's ${u.limits.stealth} browser page reads. Plain reads still work (mode fast); it resets at midnight UTC.`
          : `This workspace has read today's ${u.limits.pages} pages. It resets at midnight UTC.`,
      429,
    );
  store.put(w, "scraper_usage", { id: u.date, pages: u.pages, stealth: u.stealth, maps: u.maps, [kind]: u[kind] + 1 });
  // Keep a month of days.
  const old = store.list(w, "scraper_usage").slice(31);
  for (const r of old) store.remove(w, "scraper_usage", r.id);
}

// ── Public addresses only ────────────────────────────────────────────────────
async function publicUrl(value: string) {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw fail("That is not a web address.");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw fail("Give a public http or https address without a username or password.");
  if (!hostAllowed(u.hostname)) throw fail("This server is not allowed to reach that site (OUTBOUND_HOSTS).");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw fail("That site could not be found.");
  if (addresses.some((a) => !isPublicAddress(a.address))) throw fail("Private and reserved addresses can't be read.");
  u.hash = "";
  return u;
}

// ── robots.txt ───────────────────────────────────────────────────────────────
type Rule = { allow: boolean; path: string };
const robotsCache = new Map<string, { until: number; rules: Rule[] }>();
export function robotsRules(text: string): Rule[] {
  // The rules for every crawler (*), or for OrbytLink by name when the site names it.
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) current.rules.push({ allow: key === "allow", path: value });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes("orbytlink")));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}
export function robotsAllow(rules: Rule[], pathAndQuery: string) {
  // The longest matching rule wins; Allow wins a tie. "*" matches anything, "$" ends the path.
  let best: Rule | undefined;
  for (const r of rules) {
    if (!r.path) continue;
    const pattern = new RegExp(`^${r.path.replace(/[.+?^(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$")}`);
    if (!pattern.test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
async function allowedByRobots(u: URL, deadline: number) {
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || entry.until < Date.now()) {
    let rules: Rule[] = [];
    try {
      // Followed by hand: a redirect must lead to a public address too.
      let at = new URL("/robots.txt", u.origin);
      for (let hop = 0; hop < 4; hop++) {
        const r = await fetch(at, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(Math.max(500, Math.min(5000, deadline - Date.now()))) });
        const location = r.headers.get("location");
        if (r.status >= 300 && r.status < 400 && location) {
          await r.body?.cancel().catch(() => undefined);
          at = await publicUrl(new URL(location, at).href);
          continue;
        }
        // No robots.txt (404) or an error page means no rules.
        if (r.ok && /text\/plain/i.test(r.headers.get("content-type") || "text/plain")) rules = robotsRules(await readCapped(r, 500_000));
        else await r.body?.cancel().catch(() => undefined);
        break;
      }
    } catch {
      rules = [];
    }
    entry = { until: Date.now() + 3_600_000, rules };
    robotsCache.set(key, entry);
    if (robotsCache.size > 5000) robotsCache.clear();
  }
  return robotsAllow(entry.rules, u.pathname + u.search);
}

// ── Per-site backoff ─────────────────────────────────────────────────────────
// A site that blocks us is left alone for a while (3 s, doubling to 60 s), shared by every workspace.
const backoff = new Map<string, { until: number; blocks: number }>();
const siteOf = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
async function waitForSite(u: URL, deadline: number) {
  const b = backoff.get(siteOf(u));
  if (!b || b.until <= Date.now()) return;
  if (b.until > deadline - 2000) throw fail("That site asked us to slow down; try again in a minute.", 429);
  await new Promise((r) => setTimeout(r, b.until - Date.now()));
}
function noteBlock(u: URL) {
  const b = backoff.get(siteOf(u)) || { until: 0, blocks: 0 };
  b.blocks++;
  b.until = Date.now() + Math.min(60_000, 3000 * 2 ** (b.blocks - 1));
  backoff.set(siteOf(u), b);
  if (backoff.size > 10_000) backoff.clear();
}
const noteOk = (u: URL) => backoff.delete(siteOf(u));

// ── Reading ──────────────────────────────────────────────────────────────────
async function readCapped(r: Response, limit = MAX_BYTES) {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
const BLOCKED = new Set([401, 403, 407, 429, 444, 500, 502, 503, 504]);
// A page that came back empty, refused, or is a shell that needs JavaScript to show anything.
export function looksBlocked(status: number, html: string) {
  if (BLOCKED.has(status)) return true;
  if (html.length < 200) return true;
  const text = textOfHtml(html);
  return text.length < 120 && /<script/i.test(html);
}
type Got = { url: URL; status: number; html: string; via: "fast" | "stealth" };
async function fast(start: URL, deadline: number): Promise<Got> {
  let u = start;
  for (let hop = 0; ; hop++) {
    const left = deadline - Date.now();
    if (left < 500) throw fail("Ran out of time.");
    const r = await fetch(u, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "Accept-Language": "en-US,en;q=0.8" },
      signal: AbortSignal.timeout(Math.min(FAST_TIMEOUT, left)),
    });
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      await r.body?.cancel().catch(() => undefined);
      if (hop >= REDIRECTS) throw fail("Too many redirects.");
      u = await publicUrl(new URL(location, u).href);
      continue;
    }
    const type = r.headers.get("content-type") || "";
    if (type && !/html|text\/plain|xml/i.test(type)) {
      await r.body?.cancel().catch(() => undefined);
      throw fail(`That address is not a web page (${type.split(";")[0]}).`);
    }
    return { url: u, status: r.status, html: await readCapped(r), via: "fast" };
  }
}
async function sidecar<T>(path: string, body: unknown, timeout: number): Promise<T> {
  const r = await fetch(`${process.env.SCRAPER_URL!.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SCRAPER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => {
    throw fail((error as any)?.name === "TimeoutError" ? "The scraper took too long." : "The stealth scraper could not be reached.", 502);
  });
  const data: any = await r.json().catch(() => null);
  if (!r.ok || !data) throw fail(typeof data?.detail === "string" ? data.detail : `The stealth scraper refused the request (HTTP ${r.status}).`, 502);
  return data as T;
}
async function stealth(store: Store, w: string, u: URL, deadline: number, waitFor?: string): Promise<Got> {
  if (!scraperConfigured()) throw fail("The site needs a real browser, and the stealth scraper isn't running on this server.", 409);
  spend(store, w, "stealth");
  const left = deadline - Date.now();
  if (left < 6000) throw fail("Ran out of time.");
  const seconds = Math.max(5, Math.min(45, Math.floor((left - 3000) / 1000)));
  const d = await sidecar<{ status: number; finalUrl: string; html: string }>("/fetch", { url: u.href, waitFor, timeoutSeconds: seconds }, (seconds + 15) * 1000);
  return { url: new URL(d.finalUrl || u.href), status: d.status, html: String(d.html || ""), via: "stealth" };
}
async function load(store: Store, w: string, value: string, mode: "auto" | "fast" | "stealth", deadline: number, waitFor?: string): Promise<Got> {
  const u = await publicUrl(value);
  if (!(await allowedByRobots(u, deadline))) throw fail("The site's robots.txt asks crawlers not to read this page.", 403);
  await waitForSite(u, deadline);
  spend(store, w, "pages");
  let got: Got | undefined;
  if (mode !== "stealth") {
    got = await fast(u, deadline).catch((error) => {
      // An address that isn't a page, or leads somewhere private, won't do better in a browser.
      if ((error as any)?.safe) throw error;
      return undefined;
    });
    if (got && !looksBlocked(got.status, got.html)) {
      noteOk(u);
      return got;
    }
    if (got && BLOCKED.has(got.status)) noteBlock(u);
    if (mode === "fast") {
      if (got) return got;
      throw fail("The site could not be reached.");
    }
    if (!scraperConfigured() && got) return got;
  }
  try {
    const s = await stealth(store, w, got?.url ?? u, deadline, waitFor);
    if (BLOCKED.has(s.status)) noteBlock(u);
    else noteOk(u);
    return s;
  } catch (error) {
    // The browser could not do better: keep what the plain request got.
    if (got && (error as any)?.status !== 429) return got;
    throw error;
  }
}

// ── What a page says ─────────────────────────────────────────────────────────
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g;
const JUNK_EMAIL = /example\.(com|org)|yourdomain|domain\.com|sentry|wixpress\.com|godaddy\.com|@2x|\.(png|jpe?g|gif|svg|webp)$|^(no-?reply)@|@google\.com|gstatic\.com/i;
const SOCIAL: Record<string, RegExp> = {
  linkedin: /(^|\.)linkedin\.com$/,
  instagram: /(^|\.)instagram\.com$/,
  facebook: /(^|\.)(facebook\.com|fb\.com)$/,
  x: /(^|\.)(twitter\.com|x\.com)$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/,
  tiktok: /(^|\.)tiktok\.com$/,
};
const NOT_A_PROFILE = /\/(sharer|share|intent|dialog|plugins|home|login|policies|privacy|legal)([/.?]|$)|[?&](u|url|text)=/i;
const CONTACT_HINT = /contact|about|impressum|get-in-touch|kontakt/i;
// The same signatures Lead Orbyt used (Wappalyzer's open fingerprints for these platforms).
const STOREFRONTS: [string, RegExp][] = [
  ["shopify", /cdn\.shopify\.com|Shopify\.shop|var\s+Shopify\s*=/i],
  ["woocommerce", /wp-content\/plugins\/woocommerce|class="[^"]*woocommerce/i],
  ["wix", /static\.wixstatic\.com|X-Wix-/i],
  ["squarespace", /static1\.squarespace\.com|Squarespace\.Constants/i],
  ["bigcommerce", /cdn\d*\.bigcommerce\.com/i],
];
const unique = (values: string[], limit: number) => [...new Set(values)].slice(0, limit);

export function extract(html: string, base: URL, select?: Record<string, string>) {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = (root.querySelector("title")?.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const meta = root.querySelector('meta[name="description"]') || root.querySelector('meta[property="og:description"]');
  const description = (meta?.getAttribute("content") || "").trim().slice(0, 500);
  const text = textOfHtml(html);
  const emails: string[] = [];
  const phones: string[] = [];
  const socials: Record<string, string> = {};
  const contactPages: string[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    if (/^mailto:/i.test(href)) {
      emails.push(safeDecode(href.slice(7).split("?")[0]));
      continue;
    }
    if (/^tel:/i.test(href)) {
      phones.push(safeDecode(href.slice(4)));
      continue;
    }
    let link: URL;
    try {
      link = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(link.protocol)) continue;
    const host = link.hostname.toLowerCase();
    const platform = Object.keys(SOCIAL).find((p) => SOCIAL[p].test(host));
    if (platform) {
      if (!socials[platform] && link.pathname.length > 1 && !NOT_A_PROFILE.test(link.pathname + link.search)) socials[platform] = link.href;
      continue;
    }
    if (host === base.hostname.toLowerCase() && CONTACT_HINT.test(link.pathname)) contactPages.push(link.origin + link.pathname);
  }
  emails.push(...(text.match(EMAIL) || []));
  phones.push(...(text.match(PHONE) || []));
  let selected: Record<string, string[]> | undefined;
  if (select) {
    selected = {};
    for (const [name, css] of Object.entries(select)) {
      let nodes: HTMLElement[] = [];
      try {
        nodes = root.querySelectorAll(css);
      } catch {
        nodes = [];
      }
      selected[name] = nodes.slice(0, 50).map((n) => n.text.replace(/\s+/g, " ").trim().slice(0, 1000));
    }
  }
  return {
    title,
    description,
    emails: unique(
      emails.map((e) => e.replace(/^[.,;:]+|[.,;:]+$/g, "").toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !JUNK_EMAIL.test(e)),
      10,
    ),
    phones: unique(
      phones.map((p) => p.replace(/[^\d+]/g, "")).filter((p) => p.replace(/\D/g, "").length >= 8 && p.replace(/\D/g, "").length <= 15),
      5,
    ),
    socials,
    storefront: STOREFRONTS.filter(([, re]) => re.test(html)).map(([name]) => name),
    contactPages: unique(contactPages, 3),
    ...(selected ? { selected } : {}),
    text,
  };
}
function safeDecode(s: string) {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    return s.trim();
  }
}

export type ScrapedPage = {
  url: string;
  finalUrl?: string;
  status?: number;
  via?: "fast" | "stealth";
  title?: string;
  description?: string;
  emails?: string[];
  phones?: string[];
  socials?: Record<string, string>;
  storefront?: string[];
  contactPages?: string[];
  selected?: Record<string, string[]>;
  text?: string;
  error?: string;
};
const reason = (error: unknown) =>
  (error as any)?.safe ? (error as Error).message : (error as any)?.name === "TimeoutError" ? "The site took too long to answer." : "The site could not be reached.";

async function scrapeOne(store: Store, w: string, value: string, a: z.infer<typeof scrapeSchema>, deadline: number, textLimit: number): Promise<ScrapedPage> {
  const url = value.trim();
  if (!url) return { url: "", error: "No address given." };
  try {
    const got = await load(store, w, url, a.mode, deadline, a.waitFor);
    const found = extract(got.html, got.url, a.select);
    const page: ScrapedPage = { url, finalUrl: got.url.href, status: got.status, via: got.via, ...found, text: found.text.slice(0, textLimit) };
    if (got.status >= 400) page.error = `The site answered HTTP ${got.status}.`;
    // Contact and about pages often hold the email the home page leaves out.
    if (a.contacts && got.status < 400)
      for (const extra of found.contactPages.slice(0, 2)) {
        const more = await load(store, w, extra, a.mode, deadline).catch(() => undefined);
        if (!more || more.status >= 400) continue;
        const f = extract(more.html, more.url);
        page.emails = unique([...page.emails!, ...f.emails], 10);
        page.phones = unique([...page.phones!, ...f.phones], 5);
        page.socials = { ...f.socials, ...page.socials };
      }
    return page;
  } catch (error) {
    if ((error as any)?.status === 429 && /workspace has/.test((error as Error).message)) throw error;
    return { url, error: reason(error) };
  }
}

// One page, or many in parallel. A page that can't be read comes back with `error` instead of
// failing the call, so one broken website doesn't stop a list of twenty-five.
export async function scrape(store: Store, workspace: string, input: unknown): Promise<ScrapedPage | { count: number; pages: ScrapedPage[] }> {
  const a = scrapeSchema.parse(input);
  const deadline = Date.now() + BUDGET;
  if (a.urls === undefined) return scrapeOne(store, workspace, a.url || "", a, deadline, 6000);
  const urls = a.urls.map((u) => String(u ?? ""));
  const pages: ScrapedPage[] = new Array(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        pages[i] = await scrapeOne(store, workspace, urls[i], a, deadline, 800);
      }
    }),
  );
  return { count: pages.length, pages };
}

export type Place = { name: string; category: string; website: string; phone: string; address: string; plusCode: string; rating: number | null; reviews: number | null; email: string; socials: Record<string, string>; mapsUrl: string; lat: number | null; lon: number | null };
export async function scrapeMaps(store: Store, workspace: string, input: unknown) {
  const a = mapsSchema.parse(input);
  if (!scraperConfigured()) throw fail("Google Maps needs the stealth scraper, and it isn't running on this server.", 409);
  const query = a.location ? `${a.query} in ${a.location}` : a.query;
  const search = new URL(`https://www.google.com/maps/search/${encodeURIComponent(query)}`);
  if (!(await allowedByRobots(search, Date.now() + 10_000))) throw fail("Google's robots.txt no longer allows reading Maps searches.", 403);
  spend(store, workspace, "maps");
  const d = await sidecar<{ query: string; places: Place[]; partial: boolean }>("/maps", { query, maxResults: a.maxResults, timeoutSeconds: 100 }, 115_000);
  const places = (d.places || []).map((p) => ({ ...p, mapsUrl: String(p.mapsUrl || "").replace(/\?.*$/, "") }));
  return {
    query,
    count: places.length,
    ...(d.partial ? { partial: true, note: "Time ran out before every place was read; ask for fewer to get them all." } : {}),
    places,
  };
}
export const scraperSummary = (store: Store, w: string) => ({ stealth: scraperConfigured(), usage: scraperUsage(store, w) });
