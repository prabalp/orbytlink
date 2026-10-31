import { z } from "zod";
const credentialName =
  /^(authorization|proxy-authorization|cookie|x-api-key|api[_-]?key|password|secret|token|access[_-]?token)$/i;
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "Use a valid HTTP header name")
  .refine(
    (v) =>
      !/^(host|content-length|connection|transfer-encoding|upgrade|te|trailer|keep-alive)$/i.test(
        v,
      ),
    "This header is managed by the connector",
  );
export const operationSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]{1,64}$/,
      "Operation names use letters, numbers, dots, dashes, or underscores",
    ),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .max(500)
    .regex(
      /^(\/[A-Za-z0-9._~!$&'()*+,;=:@{}%-]*)*$/,
      "Use a path relative to the endpoint, e.g. /contacts/{id}, without a query string",
    )
    .refine(
      (v) => !v.split("/").includes(".."),
      "Paths cannot leave the endpoint",
    )
    .default(""),
  description: z.string().max(300).default(""),
});
// Parameters the gateway sets itself; a connection may not override them.
const reservedAuthParams =
  /^(state|code_challenge|code_challenge_method|client_id|redirect_uri|response_type|scope|user_scope|resource)$/;
const httpsUrl = z.url().refine((value) => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.hash;
}, "Use an HTTPS URL without credentials or fragments");
// OAuth sign-in to the upstream app. "discover" follows the MCP authorization spec
// (metadata discovery and dynamic client registration); "manual" uses a registered client.
export const oauthSchema = z.object({
  mode: z.enum(["discover", "manual"]).default("discover"),
  clientId: z.string().trim().max(300).default(""),
  authorizationUrl: z.union([z.literal(""), httpsUrl]).default(""),
  tokenUrl: z.union([z.literal(""), httpsUrl]).default(""),
  scopes: z.array(z.string().regex(/^\S{1,200}$/, "Scopes cannot contain spaces")).max(50).default([]),
  scopeParam: z.enum(["scope", "user_scope"]).default("scope"),
  tokenAuth: z.enum(["body", "basic"]).default("body"),
  authParams: z
    .record(
      z.string().regex(/^[a-z_]{1,40}$/, "Use lowercase parameter names"),
      z.string().max(200),
    )
    .refine((v) => Object.keys(v).length <= 10, "Use at most 10 extra parameters")
    .refine(
      (v) => !Object.keys(v).some((k) => reservedAuthParams.test(k)),
      "These parameters are set by the gateway",
    )
    .default({}),
});
// One connector for anything: an MCP server or an HTTP API, detected on test.
export const connectionSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(""),
  kind: z.preprocess(
    // Older workspaces stored product-specific kinds; they were MCP servers.
    (v) => (v === "mail-orbit" || v === "lead-orbit" ? "mcp" : v),
    z.enum(["auto", "mcp", "api"]).default("auto"),
  ),
  endpoint: z
    .union([
      z.literal(""),
      z.url().refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "Use HTTPS without URL credentials, query parameters, or fragments"),
    ])
    .default(""),
  auth: z.enum(["none", "bearer", "api-key", "basic", "oauth"]).default("none"),
  oauth: oauthSchema.optional(),
  // Client secret for OAuth; stored in the vault like any credential.
  clientSecret: z.string().max(4096).optional(),
  authHeader: headerName.default("X-API-Key"),
  headers: z
    .record(
      headerName.refine(
        (v) => !credentialName.test(v),
        "Put credentials in the encrypted credential field, not in headers",
      ),
      z.string().max(1000),
    )
    .refine((v) => Object.keys(v).length <= 20, "Use at most 20 headers")
    .default({}),
  operations: z
    .array(operationSchema)
    .max(50)
    .refine(
      (v) => new Set(v.map((o) => o.name)).size === v.length,
      "Operation names must be unique",
    )
    .default([]),
  secret: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
  // Discovered tools the gateway must not expose to clients.
  disabledTools: z.array(z.string().max(200)).max(500).default([]),
}).superRefine((c, ctx) => {
  if (c.auth !== "oauth") return;
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (!c.endpoint) issue("endpoint", "OAuth needs the server endpoint");
  const o = c.oauth;
  if (o?.mode === "manual") {
    if (!o.clientId) issue("oauth.clientId", "Enter the OAuth client ID");
    if (!o.authorizationUrl) issue("oauth.authorizationUrl", "Enter the authorization URL");
    if (!o.tokenUrl) issue("oauth.tokenUrl", "Enter the token URL");
  }
});
export type Operation = z.infer<typeof operationSchema>;
export const settingsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  appearance: z.enum(["light", "dark", "system"]).default("dark"),
});
export const tokenSchema = z.object({
  name: z.string().trim().min(2).max(80),
  // Gateway tokens always expire; the longest lifetime is one year.
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).default(90),
});
export type Identity = {
  user: string;
  email?: string;
  displayName?: string;
  workspaceName?: string;
  // Set for console sessions: the person's role in the active workspace, and whether it is an organization.
  role?: "admin" | "member";
  org?: boolean;
  authMethod?: "email" | "oidc" | "token";
  workspace: string;
  permissions: string[];
  demo: boolean;
};
// "call" lets an MCP client list and invoke connected tools; it cannot change configuration.
export const allPermissions = ["read", "configure", "call"];
export const gatewayPermissions = ["call"];
