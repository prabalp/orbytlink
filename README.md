# OrbytLink

A gateway that lets Claude reach many apps through one connection. Connect MCP
servers and HTTP APIs once, keep their credentials in an encrypted server-side vault,
and give Claude a single MCP endpoint (`/mcp`) that exposes every connected app's
tools, namespaced as `app__tool`.

## Run

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3100. One Express process in `server/` serves the API, the MCP
gateway, and the React console in `src/` (through Vite in development, `dist/` in
production). Production: `npm run build`, then `npm start`.

Set `OUTBOUND_HOSTS` (see `.env.example`) before connecting apps; it is empty, and so
blocks every outbound connection, by default.

## How it works

1. **Connections** – add an MCP server (Streamable HTTP or SSE) or an HTTP API with
   declared operations, plus its credential (bearer, API-key header, or basic).
2. **Test** – a live test discovers the tools. Only enabled connections that passed a
   test are exposed. Any edit takes a connection offline until it is tested again.
3. **Catalog** – ready-made connections grouped by segment (Documents & Files,
   Communication, Project Management, …). Pick an app and its endpoint, sign-in
   method and scopes are pre-filled. Entries are checked against vendor docs; see
   `docs/CATALOG-RESEARCH.md` and `src/catalog.ts`.
4. **Tool access** – turn individual tools off; the change applies immediately.
5. **Connect agents** – create a gateway token and follow the steps for your agent
   (Claude Code, Claude Desktop, Codex, ChatGPT desktop, Cursor, VS Code, Gemini CLI,
   Windsurf, Grok via the xAI API, Hermes Agent, OpenClaw, or any MCP client). For
   example, add the endpoint to Claude Code
   (`claude mcp add --transport http …`) or Claude Desktop (via `mcp-remote`).
   claude.ai custom connectors need OAuth, which is not implemented yet.

## APIs

Store an API's base URL, documentation and key; OrbytLink makes every request from its own
server and attaches the key, so agents build against the API without ever holding it.

- **Docs**: a URL (OpenAPI JSON or YAML gives an endpoint index; any page is kept as text) or
  pasted text, up to 200 KB. Agents read them with `orbytlink__api_docs` (searchable).
- **Requests**: agents use `orbytlink__api_request`; admins and members can try requests in the
  console. Paths must stay under the base URL; the key's header or query parameter can't be
  overridden; read-only (GET/HEAD) unless an admin allows writes.
- **Key safety**: AES-256-GCM in the vault, bound to the workspace and API; never returned (only
  its last four characters, for keys of 12+); redacted if an API echoes it; deleted with the API.
  Changing the base URL's host discards the saved key, so a key can't be redirected elsewhere.
  Every request goes through the outbound checks (HTTPS, `OUTBOUND_HOSTS`, public addresses, no
  redirects, size and time limits) and is logged by method, path, status and time.

## Skills

Sixteen published agent skills are bundled (`server/skills-data.ts`), copied from
`anthropics/skills` (Apache-2.0) and `mattpocock/skills` (MIT) at pinned commits by
`node scripts/vendor-skills.mjs`. Review the diff before shipping a refresh: skill text is
delivered to agents. Popularity shown is real and dated: install counts from skills.sh where
the skill is listed there, otherwise the source repository's GitHub stars (`server/skills.ts`).

Turning a skill on serves it to every agent on the workspace through `/mcp`, both as an MCP
prompt and through the `orbytlink__use_skill` tool, for clients that don't support prompts.

## Workflows

A workflow is a fixed, ordered list of tool calls. Step arguments are templates:
`{{input.name}}`, `{{steps.<id>.text}}`, `{{steps.<id>.json.path}}` (a whole-field placeholder keeps
its type, and non-string schema fields are parsed as JSON). Runs stop at the first failed step,
and record each step's status and timing but not inputs or outputs.

- **Run** from the console, or agents call each enabled workflow as one `workflow__<name>` tool.
- **Templates** bind to the tools you have actually connected, by name pattern; unmatched steps
  are left for you to pick.
- **From requirements**: agents get `orbytlink__create_workflow`. Describe a task to your agent
  and it drafts a workflow from the tools it can see. Drafts are always saved disabled; an admin
  reviews and enables them, and members can run only enabled workflows.

## OAuth to connected apps

Connections can sign in to the app with OAuth instead of a pasted credential
(Authentication → OAuth sign-in):

- **Automatic**: follows the MCP authorization spec (protected-resource and
  authorization-server metadata, then dynamic client registration). Works for servers
  that support it, such as Notion, Linear, Atlassian and Stripe, with no setup.
- **My own OAuth client**: authorization URL, token URL, client ID/secret and scopes,
  for providers that need a registered client (Google Workspace, Slack). Register
  `<APP_ORIGIN>/api/oauth/callback` as the redirect URI.
- Authorization code with **PKCE (S256)**; the state, verifier and requester travel in
  a signed, HttpOnly, `SameSite=Lax` cookie scoped to `/api/oauth`, and the person must
  still be an admin when they return.
- Access and refresh tokens, and any client secret, are encrypted in the vault (bound to
  the workspace and connection) and never sent to the browser, Claude, or logs. Access
  tokens refresh automatically; concurrent calls share one refresh. A revoked grant takes
  the connection offline with "Authorization expired", and a transient failure does not.
- Every request to a provider (discovery, registration, tokens) uses the same HTTPS,
  allowlist and public-address checks as connections, so add the provider's hosts to
  `OUTBOUND_HOSTS`. Discovered endpoints are re-checked before use.
- Changing the endpoint, client or scopes discards the existing authorization;
  deleting the connection destroys its tokens.

## Organizations

Every account has a personal workspace. Anyone can create an **organization**, a shared
workspace with its own connections, credentials, tokens and activity, and becomes its
first admin. The Team page and the sidebar's workspace switcher manage them.

| Role | Can |
|---|---|
| **admin** | Everything: connections, tool access, settings, invites, roles, removing members, deleting the organization. Any member can be made an admin. |
| **member** | See what is connected and use it through their own gateway tokens. Cannot change anything or see credentials. |

- **Invites**: an admin creates a single-use link (7 days, member or admin role). The
  link is shown once and only its hash is stored; whoever opens it while signed in
  joins. Pending invites can be revoked.
- **Safeguards**: an organization always keeps at least one admin; removing a member
  (or leaving) immediately revokes their gateway tokens for it; deleting an
  organization requires typing its name and destroys its connections and credentials.
- **Tokens** belong to the workspace they were created in and stop working if their
  owner leaves it. Admins see and can revoke every token in the organization.

## Security model

- **Vault**: credentials are AES-256-GCM encrypted with `SECRET_KEY` (required in
  production; a local key file is generated in development). The workspace and
  connection ID are bound as authenticated data, so a ciphertext cannot be replayed
  under another workspace or connection. Credentials never appear in API responses,
  MCP responses (upstream echoes are redacted), or logs.
- **Outbound**: HTTPS only, no URL credentials or query strings, host allowlist, every
  resolved address must be public (IPv4 and IPv6), redirects refused, 15–20 s timeouts,
  100 kB response cap.
- **Gateway tokens**: random 256-bit, stored only as SHA-256 hashes, shown once, named,
  expire in at most a year, revocable individually. They carry only the `call`
  permission: list and call tools. They cannot read configuration, change
  connections, or mint tokens. Password change and "sign out everywhere" revoke all.
- **Google sign-in** (optional, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`): OpenID Connect
  with PKCE, state and nonce; the ID token is verified against Google's keys and only
  verified emails are accepted. A Google account links to an existing account with the
  same email once, by its stable subject ID.
- **Console**: email/password (scrypt), HTTP-only `SameSite=Strict` session cookies,
  origin checks on state-changing requests, rate limits on sign-in and on `/mcp` (per
  token).
- **Audit**: configuration changes and every tool call (tool, connection, result,
  duration) are logged. Arguments and responses are not stored.

Known limitation: DNS is resolved for validation and again by `fetch`, so a hostile
DNS server for an allowlisted host could rebind between the two. Keep
`OUTBOUND_HOSTS` to hosts you trust.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

UI rules (layout, type, spacing, components) are in `docs/DESIGN.md`.

`v0/` is the retired LibreChat-based frontend and API, kept only as reference.
`migration/` holds source backups taken before each restructuring.
