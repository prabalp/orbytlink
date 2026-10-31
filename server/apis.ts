import { isIP } from "node:net";
import { z } from "zod";
import { load as loadYaml } from "js-yaml";
import type { Store, Row } from "./store.js";
import { safeEndpoint, boundedText } from "./adapters.js";

// APIs: a base URL, its documentation and a key, kept in the vault. OrbytLink makes every
// request from its own server and attaches the key itself, so agents (and the browser) can
// build against an API without ever holding the key.
const READ = ["GET", "HEAD"] as const;
const WRITE = ["POST", "PUT", "PATCH", "DELETE"] as const;
const paramName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "Use a valid header or parameter name");
export const apiSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(""),
    baseUrl: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
    }, "Use an HTTPS base URL without credentials, query parameters or fragments"),
    docsUrl: z
      .union([
        z.literal(""),
        z.url().refine((v) => {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password && !u.hash;
        }, "Use an HTTPS docs URL"),
      ])
      .default(""),
    // Pasted documentation, for APIs whose docs are not public.
    docsText: z.string().max(200_000).optional(),
    auth: z.enum(["none", "bearer", "header", "query", "basic"]).default("bearer"),
    authName: paramName.default("X-API-Key"),
    key: z.string().min(1).max(4096).optional(),
    // Agents may only use the methods allowed here; writes are opt-in.
    access: z.enum(["read", "write"]).default("read"),
    // Fixed, non-secret headers some APIs require, e.g. anthropic-version or Notion-Version.
    headers: z
      .record(
        paramName.refine((v) => !/^(authorization|proxy-authorization|cookie|host|content-length|connection|transfer-encoding|x-api-key|api[_-]?key|token|secret|password)$/i.test(v), "Put keys in the key field, not in headers"),
        z.string().max(500),
      )
      .refine((v) => Object.keys(v).length <= 10, "Use at most 10 headers")
      .default({}),
    // Stripe and Twilio take form-encoded bodies; most APIs take JSON.
    bodyFormat: z.enum(["json", "form"]).default("json"),
    enabled: z.boolean().default(true),
  })
  .refine((a) => !(a.auth === "header" && /^(host|content-length|cookie|connection|transfer-encoding)$/i.test(a.authName)), {
    path: ["authName"],
    message: "This header is managed by the gateway",
  });

export const allowedMethods = (api: Row): string[] => (api.access === "write" ? [...READ, ...WRITE] : [...READ]);

const textOfHtml = (html: string) =>
  html
    .replace(/<(script|style|nav|footer|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|li|tr|pre|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

type Endpoint = { method: string; path: string; summary: string };
// OpenAPI 3 / Swagger 2 in JSON or YAML: a compact endpoint index plus the spec text.
function readSpec(text: string): { format: string; endpoints: Endpoint[]; server?: string; reference: string } | undefined {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = loadYaml(text, { json: true });
    } catch {
      return;
    }
  }
  if (!doc || typeof doc !== "object" || !(doc.openapi || doc.swagger) || typeof doc.paths !== "object") return;
  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths))
    for (const method of ["get", "post", "put", "patch", "delete", "head"])
      if (item?.[method] && endpoints.length < 1000)
        endpoints.push({ method: method.toUpperCase(), path, summary: String(item[method].summary || item[method].operationId || "").slice(0, 200) });
  const server = doc.servers?.[0]?.url || (doc.host ? `${(doc.schemes || ["https"])[0]}://${doc.host}${doc.basePath || ""}` : undefined);
  return { format: doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`, endpoints, server, reference: reference(doc) };
}
// Large specs (GitHub's is 14 MB) don't fit as raw text, so agents get a compact reference:
// each endpoint with its summary and parameters, which is what they need to make a call.
function reference(doc: any) {
  const lines: string[] = [];
  const title = doc.info?.title ? `${doc.info.title}${doc.info.version ? ` (${doc.info.version})` : ""}` : "API";
  lines.push(`# ${title}`, "");
  for (const [path, item] of Object.entries<any>(doc.paths))
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item?.[method];
      if (!op) continue;
      lines.push(`${method.toUpperCase()} ${path}${op.summary ? ` - ${String(op.summary).slice(0, 160)}` : ""}`);
      const params = [...(item.parameters || []), ...(op.parameters || [])]
        .filter((p: any) => p && p.name && p.in !== "header")
        .map((p: any) => `${p.name}${p.required ? "*" : ""} (${p.in})`);
      if (params.length) lines.push(`  params: ${params.slice(0, 20).join(", ")}`);
      const body = op.requestBody?.content?.["application/json"]?.schema || op.requestBody?.content?.["application/x-www-form-urlencoded"]?.schema;
      const props = body?.properties ? Object.keys(body.properties) : [];
      if (props.length) lines.push(`  body: ${props.slice(0, 20).join(", ")}${props.length > 20 ? ", …" : ""}`);
    }
  return lines.join("\n");
}

export function ingestDocs(text: string, source: "url" | "pasted", contentType = "") {
  const spec = readSpec(text);
  if (spec)
    return { docs: spec.reference.slice(0, 200_000), docsFormat: spec.format, endpoints: spec.endpoints, specServer: spec.server, docsSource: source, docsFetchedAt: new Date().toISOString() };
  const plain = /html/.test(contentType) || /^\s*<(!doctype|html)/i.test(text) ? textOfHtml(text) : text;
  return { docs: plain.slice(0, 200_000), docsFormat: "Text", endpoints: [], docsSource: source, docsFetchedAt: new Date().toISOString() };
}

export async function fetchDocs(url: string) {
  // The docs host goes through the same outbound checks as everything else.
  const u = new URL(url);
  await safeEndpoint(`${u.origin}${u.pathname}`);
  const r = await fetch(u, {
    headers: { Accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, text/plain;q=0.7" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`The docs URL answered ${r.status}`), { status: 409 });
  // Published specs can be large (Cloudflare's is about 28 MB); only the compact reference is kept.
  return ingestDocs(await boundedText(r, 40_000_000), "url", r.headers.get("content-type") || "");
}

// Logos: best effort, fetched once on save from the API's own site (api.example.com, then
// example.com) through the same outbound checks, and kept as a small data URL so the browser
// never contacts the site itself. No key or custom header is ever sent with these requests.
const LOGO_BYTES = 64_000;
async function readUpTo(r: Response, limit: number) {
  const reader = r.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    complete = true;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > limit) {
        complete = false;
        await reader.cancel();
        break;
      }
    }
  return { bytes: Buffer.concat(chunks).subarray(0, limit), complete };
}
// Redirects are followed by hand so every hop passes the outbound checks.
async function safeGet(url: URL, accept: string, signal: AbortSignal) {
  for (let hop = 0; hop < 4; hop++) {
    await safeEndpoint(`${url.origin}${url.pathname}`);
    const r = await fetch(url, { headers: { Accept: accept }, redirect: "manual", signal });
    const to = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!to) return { r, url };
    await r.body?.cancel();
    url = new URL(to, url);
  }
  throw new Error("Too many redirects");
}
// The type comes from the bytes, not the server's Content-Type, which is often wrong for icons.
export function imageType(b: Buffer) {
  const head = b.subarray(0, 12).toString("latin1");
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("\x00\x00\x01\x00")) return "image/x-icon";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(b.subarray(0, 2000).toString("utf8"))) return "image/svg+xml";
}
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
// <link rel="icon"> candidates from the home page, best first: SVG, then the largest bitmap up to 256px.
export function pageIcons(html: string, page: URL) {
  const found: { url: URL; score: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, "rel") || "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href || !(rel.includes("icon") || rel.includes("apple-touch-icon"))) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), page);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const svg = /\.svg$/i.test(url.pathname) || /svg/i.test(attr(tag, "type") || "");
    const size = Math.max(0, ...(attr(tag, "sizes") || "").split(/\s+/).map((s) => parseInt(s, 10) || 0));
    const px = size || (rel.includes("apple-touch-icon") ? 180 : 16);
    found.push({ url, score: svg ? 1000 : px <= 256 ? px : 256 - px / 100 });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.url);
}
async function image(url: URL, signal: AbortSignal) {
  const { r } = await safeGet(url, "image/*", signal);
  if (!r.ok) return null;
  const { bytes, complete } = await readUpTo(r, LOGO_BYTES);
  const type = complete && bytes.length ? imageType(bytes) : undefined;
  return type ? `data:${type};base64,${bytes.toString("base64")}` : null;
}
export async function fetchLogo(baseUrl: string): Promise<string | null> {
  const signal = AbortSignal.timeout(8000);
  const host = new URL(baseUrl).hostname;
  const labels = host.split(".");
  // api.example.com -> example.com, but never a public suffix like co.uk.
  const parent = labels.length > 2 && !isIP(host) && !(labels.length === 3 && labels[2].length === 2 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[1])) ? labels.slice(1).join(".") : null;
  for (const h of [parent, host]) {
    if (!h || signal.aborted) continue;
    const icons = await safeGet(new URL(`https://${h}/`), "text/html", signal)
      .then(async ({ r, url }) => (r.ok && /html/i.test(r.headers.get("content-type") || "") ? pageIcons((await readUpTo(r, 500_000)).bytes.toString("utf8"), url) : []))
      .catch(() => []);
    for (const url of [...icons.slice(0, 3), new URL(`https://${h}/favicon.ico`)]) {
      const logo = await image(url, signal).catch(() => null);
      if (logo) return logo;
    }
  }
  return null;
}

export const requestSchema = z.object({
  method: z.enum([...READ, ...WRITE]).default("GET"),
  path: z
    .string()
    .max(1000)
    .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, "Use a path starting with /, without a query string")
    .refine((p) => !p.split("/").includes(".."), "Paths cannot leave the API")
    .default("/"),
  query: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean()])).refine((q) => Object.keys(q).length <= 50).default({}),
  body: z.unknown().optional(),
});

export type ApiResponse = { status: number; ok: boolean; ms: number; contentType: string; body: unknown; truncated: boolean };

export async function apiCall(store: Store, workspace: string, api: Row, input: unknown): Promise<ApiResponse> {
  const req = requestSchema.parse(input);
  if (!api.enabled) throw Object.assign(new Error(`${api.name} is turned off.`), { status: 409 });
  if (!allowedMethods(api).includes(req.method))
    throw Object.assign(new Error(`${api.name} allows read requests only (GET, HEAD). An admin can allow writes.`), { status: 403 });
  const base = await safeEndpoint(api.baseUrl);
  const url = new URL(base.href.replace(/\/$/, "") + req.path);
  // Requests stay on the API's own origin and under its base path.
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, "")))
    throw Object.assign(new Error("The path leaves the API"), { status: 403 });
  for (const [k, v] of Object.entries(req.query)) {
    if (api.auth === "query" && k.toLowerCase() === String(api.authName).toLowerCase()) continue;
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...(api.headers || {}) };
  const key = api.auth === "none" ? undefined : store.secret(workspace, api.id);
  if (api.auth !== "none" && !key) throw Object.assign(new Error(`${api.name} has no key saved.`), { status: 409 });
  if (api.auth === "bearer") headers.Authorization = `Bearer ${key}`;
  if (api.auth === "header") headers[api.authName] = key!;
  if (api.auth === "basic") headers.Authorization = `Basic ${Buffer.from(key!, "utf8").toString("base64")}`;
  if (api.auth === "query") url.searchParams.set(api.authName, key!);
  const hasBody = req.body !== undefined && !["GET", "HEAD"].includes(req.method);
  const form = api.bodyFormat === "form";
  if (hasBody) headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
  const started = Date.now();
  let r: Response;
  try {
    r = await fetch(url, { method: req.method, headers, body: hasBody ? (form ? formEncode(req.body) : JSON.stringify(req.body)) : undefined, redirect: "error", signal: AbortSignal.timeout(20000) });
  } catch {
    throw Object.assign(new Error(`${api.name} could not be reached.`), { status: 409 });
  }
  // An oversized reply keeps its first 200 KB and is marked truncated.
  const read = await readUpTo(r, 200_000).catch(() => ({ bytes: Buffer.alloc(0), complete: false }));
  const text = read.bytes.toString("utf8"),
    truncated = !read.complete;
  const contentType = r.headers.get("content-type") || "";
  let body: unknown = text;
  if (/json/.test(contentType))
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  // The key is never echoed back, even if the API reflects it.
  const out = { status: r.status, ok: r.ok, ms: Date.now() - started, contentType, body: store.redact(workspace, body), truncated };
  store.put(workspace, "api_calls", { apiId: api.id, api: api.name, method: req.method, path: req.path, status: r.status, ms: out.ms, createdAt: new Date().toISOString() });
  store.trim(workspace, "api_calls", 1000);
  return out;
}

// What the browser and agents may see: never the key, only that one is saved and its last 4.
export const publicApi = (a: Row) => {
  const { docs: _docs, ...rest } = a;
  return { ...rest, docsLength: a.docs?.length || 0, endpointCount: a.endpoints?.length || 0, endpoints: undefined };
};

// Nested objects use bracket keys (metadata[order]=6735, items[0][price]=p_1), as Stripe expects.
export function formEncode(body: unknown) {
  const out = new URLSearchParams();
  const walk = (value: unknown, key: string) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    else out.append(key, String(value));
  };
  if (body && typeof body === "object") walk(body, "");
  return out.toString();
}
