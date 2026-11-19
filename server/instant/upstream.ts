// What every wholesale source of instant tools looks like to OrbytLink. A source lists the tools it
// sells (each a "route": one way to do one job, at its own cost), runs a call, and, where it can,
// says how much money is left in OrbytLink's account with it. Nothing here is ever shown to a
// workspace: sources are internal, and their names never leave the server.
export type Group = { slug: string; label: string; category: string; summary: string };
export type Route = {
  upstream: string;
  // The source's own id for the tool.
  ref: string;
  // Routes with the same key do the same thing with the same inputs, so a call can go to any of them.
  key: string;
  // OrbytLink's id for the tool, when the source suggests one (otherwise it is made from the key).
  id?: string;
  provider: string;
  name: string;
  summary: string;
  job: string;
  group: Group;
  method: string;
  path?: string;
  best: boolean;
  // What OrbytLink pays the source for one call, in USD (null: not published).
  costUsd: number | null;
  costType: string;
  unit: string;
  per: number;
  input: unknown;
  example: unknown;
  reliability: { okRate: number; samples: number; p50Ms: number | null } | null;
  docs: string;
};
export type CallInput = {
  query?: Record<string, unknown>;
  body?: unknown;
  options: { waterfall?: boolean; strictFilters?: boolean; verify?: boolean; complete?: boolean; domainMatch?: "strict" };
  // The most this call may cost at the source, in USD.
  maxCostUsd: number;
  // Who the call is for (a workspace id), for the source's own records.
  tag: string;
  idempotencyKey: string;
};
export type CallOutcome = {
  status: number;
  json?: unknown;
  text: string;
  // What the source charged, in micro-USD (0 when it charged nothing).
  costMicro: number;
  servedBy?: string;
  pending?: boolean;
  // The source could not take the call (down, busy, out of money): another source may.
  unavailable?: boolean;
  // A problem with OrbytLink's own account at the source (never shown; logged for the operator).
  accountProblem?: string;
  // A refusal that is about the request itself, safe to show (already scrubbed).
  refusal?: string;
};
export interface Upstream {
  id: string;
  configured(): boolean;
  catalog(): Promise<Route[]>;
  call(route: Route, input: CallInput): Promise<CallOutcome>;
  // Money left with the source, in micro-USD; undefined when it has no balance API.
  balance?(): Promise<number | undefined>;
}

export const safeFail = (message: string, status = 409) => Object.assign(new Error(message), { status, safe: true });

// Names that must never reach a workspace: every source, and the companies behind them.
const NAMES = /\b(treg(\.to)?|tools-registry|superdesign(\.dev)?|composio(\.dev)?|monid(\.ai)?|orthogonal(\.com)?|o11(\.ai)?)\b/gi;
const OPTIONS: [string, string][] = [
  ["Max-Cost", "maxCost"],
  ["Waterfall", "waterfall"],
  ["Strict-Filters", "strictFilters"],
  ["Verify", "verify"],
  ["Complete", "complete"],
  ["Domain-Match", "domainMatch"],
  ["Prefer", "prefer"],
];
export function scrub(text: string): string {
  let t = text;
  for (const [h, o] of OPTIONS) t = t.replace(new RegExp(`X-Treg-Route-${h}(:\\s*[\\w.$-]+)?`, "gi"), (_m, v) => `the ${o} option${v ? ` (${v.replace(/^:\s*/, "")})` : ""}`);
  return t
    .replace(/,?\s*\b0% markup\b,?/gi, "")
    .replace(/\(default \$1\)/g, "(default $0.25)")
    .replace(/\(?fx\.yaml kind: treg_\w+\)?/gi, "")
    .replace(/\btreg_\w+/gi, "")
    .replace(/X-Treg-Served-By/gi, "_route.served_by")
    .replace(/X-Treg-[A-Za-z-]+/g, "a response field")
    .replace(/https?:\/\/[a-z0-9.-]*(treg\.to|composio\.dev|monid\.ai|orthogonal\.com|o11\.ai)[^\s"')]*/gi, "OrbytLink")
    .replace(/\b_treg\b/g, "_route")
    .replace(/\btreg\.(?=[a-z])/g, "best.")
    .replace(/\b(treg|composio|monid|orth|o11) (call|catalog|login|topup|balance|org|execute|tools)\b[^\n"]*/gi, "")
    .replace(/\b(treg|composio|monid|orthogonal|o11)'s\b/gi, "OrbytLink's")
    .replace(NAMES, "OrbytLink");
}
// Deep-scrub a JSON value, keys and strings. The catalog is scrubbed harder (any trace at all);
// call results only where a source speaks, so real data that happens to contain the letters stays.
export function clean(v: unknown, hard = false): unknown {
  if (typeof v === "string") return hard ? scrub(v).replace(/treg|composio|monid|orthogonal/gi, "") : scrub(v);
  if (Array.isArray(v)) return v.map((x) => clean(x, hard));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === "_treg" ? "_route" : k.replace(/^_(composio|monid|orth|o11)/i, "_route"), clean(x, hard)]));
  return v;
}
export const docsLink = (u: unknown) => {
  try {
    const url = new URL(String(u || ""));
    if (url.protocol !== "https:" || NAMES.test(url.hostname)) return "";
    url.search = "";
    return url.href;
  } catch {
    return "";
  } finally {
    NAMES.lastIndex = 0;
  }
};
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
// The key that says two routes are the same call: the same provider's same native method and path.
export const nativeKey = (provider: string, method: string, path: string) => `${provider.toLowerCase().replace(/[^a-z0-9]/g, "")}:${method.toUpperCase()} ${path.replace(/\/+$/, "") || "/"}`;
// Every request to a source goes through this: a timeout, and a dropped connection told apart from an answer.
export async function send(url: string, init: RequestInit & { timeoutMs?: number }) {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 110_000) });
  } catch {
    return undefined;
  }
}
export const readJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
