# App catalog research (2026-10-29)

Only facts checked against the vendor's or project's own pages are marked **verified**.
Anything else is a lead to check before it goes in a catalog.

## Where a catalog can come from

| Source | What it gives | Use |
|---|---|---|
| **Official MCP Registry** (`registry.modelcontextprotocol.io/v0.1/servers`, cursor-paged) | Name, description, version, `remotes[]` (type + URL) for thousands of servers. **No auth info, no categories.** API frozen at v0.1. | Discovery and "add by name". Check its terms before bundling a copy. |
| **Vendor docs** | Exact endpoint, auth type, scopes, status. | The only reliable source for our presets. Curate by hand. |
| **Composio** (1,610 toolkits, 20 categories) | Toolkit names and categories on the public page. Auth types and tool counts are not on it. Full data needs their API and an account. | Category ideas, and an optional upstream (see below). Don't scrape or copy their catalog. |

## Composio, what it is

- SDKs are MIT (`ComposioHQ/composio`); the platform that stores user OAuth and runs the tools is hosted and needs `COMPOSIO_API_KEY`.
- Catalog: 1,610 toolkits across 20 overlapping categories: Productivity & PM 203, Developer Tools 200, Data & Analytics 158 (+88 Analytics), AI/ML 146, Marketing & Social 124, Document & File 118, Sales & Support 100, Finance 97, Collaboration & Comms 79, CRM 69, Design 68, Workflow Automation 65, E-commerce 51, Advertising 46, Scheduling 34, Entertainment 32, HR 31, Education 17, Social 12.
- Pricing: Hobby free (100K calls/mo; 20K if using Composio-managed OAuth apps), Pro $29/mo, Enterprise custom. Reselling is not addressed on the pricing page; ask support@composio.dev.
- MCP: `composio.mcp.generate(user_id, config)` returns a per-user URL; clients send `x-api-key`. Users must connect each toolkit first. Our `api-key` auth (custom header) can carry `x-api-key`, so Composio works as one upstream connection today.

## Verified presets: Google Workspace (Developer Preview)

All Streamable HTTP, OAuth 2.0 with your own client marked "Use this client for an AI-powered agent". Needs the Workspace Developer Preview Program and the MCP service enabled per Google Cloud project. Request `access_type=offline` for a refresh token, otherwise sign-in lapses about hourly.

| App | Endpoint | Scopes (prefix `https://www.googleapis.com/auth/`) |
|---|---|---|
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | gmail.readonly, gmail.compose |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` | drive.readonly, drive.file |
| Docs | `https://docsmcp.googleapis.com/mcp/v1` | drive.readonly, drive.file, documents.readonly, documents |
| Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | drive.readonly, drive.file, spreadsheets.readonly, spreadsheets |
| Slides | `https://slidesmcp.googleapis.com/mcp/v1` | drive.readonly, drive.file, presentations.readonly, presentations |
| Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | calendar.calendarlist.readonly, calendar.events.freebusy, calendar.events.readonly |
| Chat | `https://chatmcp.googleapis.com/mcp/v1` | chat.spaces.readonly, chat.memberships.readonly, chat.messages.readonly, chat.messages.create, … (needs a Chat app) |
| People | `https://people.googleapis.com/mcp/v1` | directory.readonly, userinfo.profile, contacts.readonly |
| Classroom | `https://classroommcp.googleapis.com/mcp/v1` | classroom.* (7 scopes) |

## Verified presets: Slack

- `https://mcp.slack.com/mcp`, Streamable HTTP only (no SSE, no Dynamic Client Registration).
- Confidential OAuth: `https://slack.com/oauth/v2_user/authorize`, token `https://slack.com/api/oauth.v2.user.access`.
- Only directory-published or **internal** apps may use it; admins approve the app. An organization can use its own internal Slack app.
- Tools: search messages/files/users/channels, read channels and threads, send/schedule/draft messages, canvases, lists, reactions, file upload.

## Verified presets: Notion

- Hosted: `https://mcp.notion.com/mcp` (Streamable HTTP, recommended) or `/sse` (fallback).
- Auth: interactive OAuth, **or** an MCP token (Business/Enterprise, created by a workspace owner in the Developer portal) sent as `Authorization: Bearer`. These are not integration tokens.
- The open-source `makenotion/notion-mcp-server` (stdio, integration token) is no longer maintained; Notion calls it a last resort.

## Verified presets: others

| App | Endpoint | Auth |
|---|---|---|
| Linear | `https://mcp.linear.app/mcp` (`/mcp/readonly` for read-only) | OAuth 2.1 with dynamic registration, or an API key / OAuth token as bearer |
| GitHub | `https://api.githubcopilot.com/mcp/` | OAuth, or a personal access token as bearer (PATs disabled by default for Enterprise Managed Users) |
| Atlassian Rovo | `https://mcp.atlassian.com/v2/mcp` | OAuth 2.1 (API token optional) |
| Stripe | `https://mcp.stripe.com` | OAuth, or an *agent* API key as bearer. Ordinary secret/restricted keys stop working on this server in December 2026. |

Not yet verified, so not in the catalog: Sentry (docs redirect to mcp.sentry.dev), and anything else.

## What our gateway can connect today (updated)

OAuth sign-in is implemented (automatic discovery and registration, or your own client), so
the Google Workspace, Slack, Notion, Linear, Atlassian and Stripe presets connect end to end.
Real providers have not been exercised yet: the flow is tested against mocked authorization servers.

## Historical note: before OAuth

Upstream auth was a stored static credential: none, bearer, API-key header, basic.

Upstream auth is a stored static credential: none, bearer, API-key header, basic. No upstream OAuth.

| Works now | Needs upstream OAuth first |
|---|---|
| Notion (MCP token, paid plans), Composio (`x-api-key`), any server that takes an API key or PAT | Google Workspace, Slack, Notion on free/Plus plans, most other official hosted servers |
