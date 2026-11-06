import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./schema.js";
import { addBalance, addMonth, aiSummary, usd } from "./ai.js";
import { hostAllowed, isPublicAddress } from "./adapters.js";

// A browser for tasks that have no API or MCP server. OrbytLink does not drive Chrome itself: it
// asks a small sidecar service (browser/, running Jev Ultrafast with headless Chrome) to open a
// page and work towards a goal, then returns what it found. The sidecar is configured with
// BROWSER_URL and BROWSER_TOKEN and is never exposed to the internet.
//
// Billing is the same hold-and-settle as AI models: the most a run could cost (every allowed step)
// is held up front, then settled to the steps actually taken. A run that could not start is free.
export const BROWSER_TOOL = "orbytlink__browse";
export const browserConfigured = () => !!process.env.BROWSER_URL && !!process.env.BROWSER_TOKEN;
const perStep = () => Number(process.env.BROWSER_MICRO_PER_STEP) || 10_000; // $0.01 per page action
export const browserSummary = () => ({ configured: browserConfigured(), microPerStep: perStep(), maxSteps: 40 });
const MAX_STEPS = 40;
export const browserInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Public https page to start from, e.g. https://www.example.com/pricing" },
    goal: { type: "string", description: "What to do or find, in plain words. Be specific about the answer you want back." },
    maxSteps: { type: "integer", description: `Most page actions (clicks, typing, scrolling) to allow, 1-${MAX_STEPS}; default 15. Credit for all of them is held until the run ends.` },
  },
  required: ["url", "goal"],
};
const schema = z.object({ url: z.string().url().max(2000), goal: z.string().trim().min(3).max(4000), maxSteps: z.number().int().min(1).max(MAX_STEPS).default(15) });
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status, safe: true });

// The browser follows links wherever they lead, so the start page must at least be a public website.
export async function publicPage(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password) throw fail("Start from a public https page without a username or password in the address.", 400);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw fail("That address is private or could not be found. The browser only opens public websites.", 400);
  // BROWSER_BLOCK_HOSTS lets an operator keep the browser off particular sites.
  if (process.env.BROWSER_BLOCK_HOSTS && hostAllowed(u.hostname, process.env.BROWSER_BLOCK_HOSTS)) throw fail("The browser is not allowed to open that site.", 400);
  return u;
}

export type BrowseResult = { status: "done" | "stopped" | "failed"; result: string; steps: number; finalUrl?: string; costMicro: number };
export async function browse(store: Store, identity: Identity, input: unknown, via: "agent" | "workflow"): Promise<BrowseResult> {
  const w = identity.workspace;
  if (!browserConfigured()) throw fail("The browser is not switched on for this OrbytLink server yet.");
  const req = schema.parse(input);
  const start = await publicPage(req.url);
  const hold = req.maxSteps * perStep();
  const s = aiSummary(store, w);
  if (!s.enabled) throw fail("An admin has turned AI and browser use off for this workspace.");
  if (s.balance < hold) throw fail(`Not enough credit: this run can cost up to $${usd(hold).toFixed(2)} and the balance is $${usd(s.balance).toFixed(2)}.`, 402);
  if (s.monthlyLimit !== null && s.monthSpent + hold > s.monthlyLimit) throw fail(`This run would pass the workspace's monthly limit of $${usd(s.monthlyLimit).toFixed(2)}.`, 402);
  addBalance(store, w, -hold);
  addMonth(store, w, hold);
  let charged = 0;
  try {
    const r = await fetch(`${process.env.BROWSER_URL!.replace(/\/+$/, "")}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.BROWSER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: start.href, goal: req.goal, maxSteps: req.maxSteps, timeoutSeconds: 110 }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !body) throw fail(`The browser service refused the run (HTTP ${r.status}). No credit was used.`, 502);
    const steps = Math.min(req.maxSteps, Math.max(1, Number(body.steps) || 1));
    charged = steps * perStep();
    const status = body.status === "done" ? "done" : body.status === "failed" ? "failed" : "stopped";
    store.put(w, "ai_usage", { model: "browser", inputTokens: 0, outputTokens: 0, micro: charged, user: identity.user, via, createdAt: new Date().toISOString() });
    store.trim(w, "ai_usage", 2000);
    return { status, result: String(body.result ?? "").slice(0, 20_000), steps, finalUrl: typeof body.finalUrl === "string" ? body.finalUrl.slice(0, 500) : undefined, costMicro: charged };
  } catch (error) {
    if ((error as any)?.safe) throw error;
    throw fail((error as any)?.name === "TimeoutError" ? "The browser took longer than two minutes. No credit was used." : "The browser service could not be reached. No credit was used.", 502);
  } finally {
    addBalance(store, w, hold - charged);
    addMonth(store, w, charged - hold);
  }
}
// What an agent or a workflow step reads back. "stopped" means the step limit or time ran out first.
export const browseText = (r: BrowseResult) =>
  `${r.status === "done" ? "" : r.status === "failed" ? "The browser could not finish this task. " : "The browser stopped before the goal was met (step or time limit). "}${r.result || "(no result)"}${r.finalUrl ? `\n\nLast page: ${r.finalUrl}` : ""}`;
