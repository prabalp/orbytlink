# OrbytLink

OrbytLink is a configurable AI operations workstation: connections, Markdown skills, ordered workflows, scoped agents, model configuration, execution previews, runs, human approvals, and usage accounting. The interface is an original, responsive black-and-white control panel. There are no invented activity metrics or connected services.

**Current status:** a working local first version with persisted configuration and demo execution. Live MCP/API and OpenRouter adapters are implemented and covered with test doubles; no real service credentials or endpoints were supplied, so no live service has been verified. Code execution is a simulation. Payments are not implemented. Production deployment requires the identity, networking, secrets, and operations work described below.

## Run locally

Use Node **24.12+** (verified here on Node 26.8.2) and npm. SQLite is supplied by Node; no database daemon is needed.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:3100** and select **Open local demo**. The local identity and workspace are `prabalp`. Demo sessions are issued only in development to loopback requests with a loopback Host. They last one hour and cannot make live connection tests, provider tests, inference calls, or tool calls. The interface still permits saving configuration for later live use.

Configuration is loaded from `.env`. All values in `.env.example` are placeholders or development defaults. Never use `VITE_*` variables for credentials. Development stores an encryption key and SQLite database in the ignored `.data/` directory, protected by a directory mode of 0700 and a key mode of 0600. Back up both to preserve saved credentials. Use a stable externally supplied key in production.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e  # requires Chromium and permission to open local sockets
```

For browser tests, first run `npx playwright install chromium` if the matching browser is unavailable. The Playwright configuration starts the application when needed and also supports a separately running local server. It saves desktop and mobile screenshots in `test-results/` when the tests reach those screens.

To serve the production build:

```sh
npm run build
# Supply SECRET_KEY, APP_ORIGIN and OIDC settings in .env first.
npm start
```

Production disables local demo login. There is no default production password, anonymous workspace, registration, or automatically trusted identity header. Use an HTTPS reverse proxy and keep the Node listener private.

## First tour

1. Overview starts with zero runs and unconfigured Mail Orbit and Lead Orbit connections. Counts and costs come from the workspace database.
2. Run **Find leads and prepare an outreach sequence** in demo mode. It produces a fictional lead with an `example.invalid` address, a draft, and a simulated Mail Orbit draft reference.
3. Open **Runs & approvals**. The final checkpoint waits for explicit approval or rejection. Review the destination and preview, check the confirmation box, and record the decision. Approving this checkpoint does **not** send email.
4. Open the run to inspect step inputs, outputs, decisions, timestamps, and errors. View $0 demo records under Usage.
5. Create or edit skills, workflows, agents, connections, and workspace settings. All persist in SQLite. Try the work environment preview to inspect simulated logs and download a demo text artifact.

All demo results are labeled. A demo job does not evaluate code, launch a process, access host files, inject secrets, or use the network. Demo and live mode are stored on each run; the runner chooses its demo branch before invoking any service adapter.

## Architecture

```text
React workstation ── authenticated Express policy gateway ── workspace-scoped SQLite
                                    │
                   permissions / limits / approvals / audit
                                    │
                      persisted ordered workflow runner
                        │                     │
                  MCP/API adapters       model adapter
                        │                     │
                verified remote hosts      OpenRouter

Authenticated AI client ── official SDK /mcp endpoint ── same gateway + runner
Execution screen ── demo execution adapter (no runtime configured)
```

- `src/main.tsx`: UI screens, configuration forms, workflow and skill editors, run inspection, approval confirmation, usage and branding controls. `src/styles.css` provides responsive, neutral styles; it fetches no external fonts or images.
- `server/app.ts`: authentication, permission middleware, validation, workspace-scoped configuration, rate limiting, same-origin checks, model/connection verification, invocation, and MCP exposure. The gateway remains the policy boundary; clients do not call upstream tools directly.
- `server/store.ts`: parameterized SQLite storage scoped by `(workspace, kind, id)`, encrypted secrets in a separate table, redaction, audit records, and atomic approval transactions. Product schemas live in `server/schema.ts`.
- `server/adapters.ts`: the `ServiceAdapters` interface separates product policy from official MCP client transports, generic HTTPS GET, and OpenRouter model verification/inference. Tests replace this interface, not the gateway’s security rules.
- `server/runner.ts`: immutable workflow/skill snapshots, current agent permission checks, ordered steps, named output references, queue scheduling, usage reservations, and persisted state transitions. It uses the maintained **p-queue** library for single-process concurrency rather than implementing a scheduler. Approval waits persist; they do not occupy a queue slot. There is one execution slot, no unattended retries, and no automatic replay of uncertain external actions.
- `/mcp`: official SDK Streamable HTTP server. It registers only tools allowed by the authenticated caller’s permissions. It exposes workspace metadata discovery and saved-workflow invocation, not arbitrary remote tool forwarding or an approval bypass.

### Open-source reuse and tradeoffs

The repository was empty: no existing authentication, database, runner, gateway, or sandbox could be reused. Upstream repositories, license files, and installed package licenses were checked before selecting dependencies. `package-lock.json` pins the installed graph; several package specifications use exact official npm tarball URLs because this environment could only install from its existing package cache. This is a deployment choice, not vendored product UI.

| Component                       | Evaluated / selected                                                                                                                                           | License and decision                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web UI                          | React, Vite, TypeScript; Lucide icons                                                                                                                          | React/Vite MIT, TypeScript Apache-2.0, Lucide ISC. Original product UI; no copied dashboard. Established tooling, no hosted service dependency.                                                                                                                                                                                                                                                                                                                    |
| Gateway / traffic               | Express 5 + express-rate-limit; evaluated [Envoy](https://github.com/envoyproxy/envoy/blob/main/LICENSE)                                                       | Selected packages MIT, license text checked in installed packages. Express is maintained and straightforward to self-host. Envoy Apache-2.0 adds a separate control plane; defer to larger deployments. Product authorization and usage enforcement remain in OrbytLink even behind Envoy. Standard response headers are a small middleware; no custom TLS, OAuth, or security protocol is implemented.                                                            |
| MCP client, server, aggregation | [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), installed 1.30.1                                                  | Installed release MIT (its LICENSE is authoritative; other upstream branches have different license notices). Uses official discovery, transport, tool calls, and schemas. Each connection has its own tool registry; no third-party aggregator can bypass the gateway. HTTP Streamable transport only; no process-spawning stdio or deprecated SSE adapter.                                                                                                       |
| OAuth / identity                | [Keycloak](https://github.com/keycloak/keycloak/blob/main/LICENSE.txt) or an existing OIDC issuer + [jose](https://github.com/panva/jose/blob/main/LICENSE.md) | Keycloak Apache-2.0; jose MIT. Maintained, self-hostable identity service plus a maintained token verification library avoids a custom password/identity system. Only the verifier is integrated; Keycloak is not deployed for you. Interactive browser OAuth and upstream OAuth refresh are not implemented.                                                                                                                                                      |
| Workflows / background jobs     | [p-queue](https://github.com/sindresorhus/p-queue) now; evaluated [Temporal](https://github.com/temporalio/temporal/blob/main/LICENSE)                         | p-queue MIT; Temporal server and TypeScript SDK MIT. The local bounded linear runner needs no scheduler cluster. Product step/approval state is deliberately small and stored in SQLite. Temporal is a suitable future durable execution service; it requires worker/server operations absent here. An older cached `@xstate/fsm` package was rejected for the final build rather than relying on a legacy package. No claim of distributed durable orchestration. |
| Data / secrets / audit          | [SQLite](https://www.sqlite.org/copyright.html) via Node; evaluated [OpenBao](https://github.com/openbao/openbao/blob/main/LICENSE)                            | SQLite public domain; Node’s distribution includes its own license notices. SQLite fits local, single-instance deployment without native addons. AES-256-GCM uses Node’s maintained crypto implementation. OpenBao MPL-2.0 is a self-hostable secrets service; not deployed. MPL obligations would apply to distributed modifications to covered files, not this independent UI. Audit history is ordinary workspace storage, not tamper-proof archival logging.   |
| Input validation                | Zod + Ajv                                                                                                                                                      | Both MIT. Zod validates product writes; Ajv validates live tool arguments against actual discovered JSON schemas. No custom JSON schema validator.                                                                                                                                                                                                                                                                                                                 |
| Isolated execution              | Evaluated [gVisor](https://github.com/google/gvisor/blob/master/LICENSE)                                                                                       | Apache-2.0, self-hostable Linux sandbox. It requires a configured Linux host/container runtime and enforced egress/resources. Those are absent; the chosen adapter is a labeled simulation. Node `vm`, host shell execution, and unisolated Docker are not presented as security boundaries.                                                                                                                                                                       |
| Metering / payments             | Local usage ledger; evaluated [Stripe Node](https://github.com/stripe/stripe-node/blob/master/LICENSE)                                                         | Stripe SDK MIT; Stripe payment processing is a proprietary external service and cannot be self-hosted. No SDK, processor, invoices, or charges are integrated. The ledger is product accounting, not a replacement payment processor. Choose a processor and verify applicable terms before charging.                                                                                                                                                              |

MIT/ISC/Apache components permit commercial incorporation and a white-labeled product, with their notice/license requirements retained; component trademarks are separate. No third-party trademarks or interfaces are used as OrbytLink branding. No assertion is made that an optional service is deployed, audited, or compatible with a particular unknown Mail Orbit/Lead Orbit installation. The dependency graph was installed and checked from the local cache; run an up-to-date vulnerability scan in network-enabled CI before deploying. Current upstream maintenance does not make a pinned version permanently safe.

## Environment variables

| Variable         | Purpose                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`           | HTTP port, default `3100`.                                                                                                           |
| `HOST`           | Bind address, default `127.0.0.1`. Keep private behind a proxy.                                                                      |
| `APP_ORIGIN`     | Exact browser origin for mutation requests, including scheme and port. Development default `http://127.0.0.1:3100`.                  |
| `DATA_DIR`       | Directory for SQLite and development encryption key. Default `.data`.                                                                |
| `SECRET_KEY`     | Production-required 64-character hexadecimal AES key. Generate a fresh 32-byte key; do not use an example value.                     |
| `OIDC_ISSUER`    | Exact trusted issuer identifier.                                                                                                     |
| `OIDC_AUDIENCE`  | Required access-token audience.                                                                                                      |
| `OIDC_JWKS_URL`  | Trusted issuer’s JWKS endpoint. Use HTTPS in production. Never accept this URL from a caller.                                        |
| `OUTBOUND_HOSTS` | Comma-separated exact hostnames allowed for generic MCP/API outbound traffic. Empty denies all. OpenRouter uses a fixed adapter URL. |
| `NODE_ENV`       | `production` disables demo session creation and enables secure cookies/CSP/HSTS. Set automatically by `npm start`.                   |

## Identity and permissions

Configure the trusted identity provider to issue short-lived RS256/ES256 access tokens with `sub`, `iss`, `aud`, `iat`, `exp`, an administrator-controlled `workspace` string, and an administrator-controlled `permissions` array. Tokens may last at most one hour. Supported permissions are `read`, `configure`, `run`, and `approve`. Do not expose workspace or permissions claims as editable self-service profile fields. There is no fallback to an unsigned workspace header.

Example **claim shape**, not a usable token:

```json
{
  "sub": "prabalp",
  "workspace": "your-workspace-id",
  "permissions": ["read", "configure", "run", "approve"],
  "iss": "your-trusted-issuer",
  "aud": "orbytlink",
  "iat": 0,
  "exp": 900
}
```

Use the sign-in screen’s access-token field, or an `Authorization: Bearer …` header for APIs/MCP. Browser sessions use HTTP-only SameSite=Strict cookies, Secure in production. The access token is never put in localStorage. Interactive OIDC authorization-code login, MFA administration, invitations, refresh-token handling, and an identity-management UI are deployment follow-ups. Use the identity provider for those functions rather than adding custom password storage.

A selected agent has explicit skills, allowed connections, a model preference, enablement, and read/write permissions. Current permissions are rechecked at each step. All live tool calls require a separate human approval even if a tool or workflow labels the action as read-only; untrusted tool annotations cannot grant authority. Model preferences must match the verified configured provider in this version. A workspace operator can run without an agent using their gateway permissions.

## Connect Mail Orbit, Lead Orbit, MCP, or an API

No Mail Orbit or Lead Orbit endpoint, authentication method, scope, or tool name is assumed.

1. Obtain the **actual** service endpoint, its documented authentication details, and a least-privilege credential from the service owner. Use a short-lived token where available.
2. Add its hostname to the server’s `OUTBOUND_HOSTS`. Restart after environment changes. Enforce the same allowlist at the network/egress layer before production.
3. Sign in with an OIDC identity. Local demo identities deliberately cannot perform live verification.
4. Add or configure a connection. Choose Mail Orbit, Lead Orbit, generic MCP, or generic HTTP API. Supply an HTTPS endpoint with **no embedded credentials, query parameters, or fragment**.
5. Select documented auth: none, bearer token, or `X-API-Key`. OAuth access tokens can be entered as bearer credentials; refresh is manual. Additional vendor-specific headers/auth and interactive OAuth need adapters once their real requirements are known.
6. Set an honest external cost estimate per call. Save. Saved secrets are never returned. Blank credential fields on edit preserve the existing secret; removing a connection deletes its secret.
7. Test. MCP uses the official SDK’s handshake and paginated `tools/list`; generic API verification uses a real authenticated GET. Disabled, incomplete, and unreachable configurations remain Disabled, Not configured, or Error. Generic API tests may incur provider read charges; OrbytLink never calls them in demo mode.
8. Inspect discovered tool descriptions and input schemas in the connection detail. Replace the sample workflow’s `demo:*` placeholders with **actual discovered tool names** and correct inputs. No placeholder can be invoked live.

Generic APIs currently support a configured fixed-endpoint **GET only**. Query strings and arbitrary HTTP writes are deliberately unavailable; use an MCP tool adapter or add a narrowly scoped service adapter for real vendor-specific writes. Generic API tests prove a successful GET, not MCP capability.

Workflow input values may reference a previously named output using an object such as `{"$ref":"drafts"}`. This is data substitution, not JavaScript evaluation. The model step receives attached enabled skill instructions, the prompt, and the previous step’s output. Workflows save without live configuration; step IDs and output names must be unique. The editor supports ordering, adding/removing steps, risk classification, explicit JSON inputs, and output names.

For a real send, add the actual sending tool as a distinct external step **after** the draft checkpoint. The sample’s final approval only records the decision; it never invents or calls a sending tool. Every live tool invocation also pauses before dispatch. Approvals show resolved arguments, target, preview, tool, risk, and cost estimate. Changing a connection after its action was reviewed invalidates that approval. Approvals/rejections and run transitions persist atomically. A failed or uncertain external call is never automatically retried; reconcile it with the provider before starting another run. A cancelled already-dispatched call may still finish externally.

## OpenRouter

In Agents & models, configure an API key, an exact OpenRouter model ID, and a per-call reservation. Save and test with an OIDC session. Verification checks `/api/v1/key` and model availability from `/api/v1/models`. A model is not marked verified because a key was merely saved. Live inference uses `/api/v1/chat/completions` behind `ServiceAdapters.infer`.

The initial adapter caps prompt text at 12,000 UTF-8 bytes and completion at 512 tokens, with a router price ceiling of $1 per million prompt/completion tokens. Some models/providers cannot satisfy these constraints and will fail rather than silently routing at a higher price. Reserve at least $0.02 per call. Consult [OpenRouter’s current API documentation](https://openrouter.ai/docs/api/reference/overview) and provider console for actual billing behavior. Keys and prompts are transmitted only to the fixed HTTPS OpenRouter API, with timeouts.

A reservation is inserted **before** inference. A successful response replaces it with the provider-reported cost and token count. If the request fails, the cost is unavailable, or reconciliation is needed, the reservation remains conservatively counted. This is not proof of an actual charge; reconcile against provider invoices. Model inference, external API estimates, and OrbytLink fees are distinct categories. Platform fees are zero in this version. No automatic card or wallet charge occurs.

## MCP clients: Claude, ChatGPT, and other compatible clients

Endpoint: **`https://your-deployment.example/mcp`**, Streamable HTTP POST. This is a placeholder; use your actual deployment URL. Authenticate with a short-lived bearer access token issued by the configured OIDC provider. Do not put the token in the URL. Configure that server URL and authorization in clients that support bearer-authenticated Streamable HTTP. Remote clients cannot reach your machine’s loopback address; deploy behind HTTPS.

Available tools depend on the token’s workspace and permissions:

| Permission | Tools                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `read`     | `list_workflows`, `list_runs`, `list_connections`, `estimate_workflow`         |
| `run`      | `run_workflow` and `run_demo_workflow` with workflow ID and idempotency key    |
| `approve`  | Human approval remains in the workstation UI; no MCP approval tool is exposed. |

Settings can mint a read/run **demo token** lasting 15 minutes for a local compatible client; it is displayed once and not persisted in browser storage. Server restart invalidates development tokens. An OIDC session instead obtains tokens from its issuer.

Example using the official SDK, for a configured compatible client host:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "orbytlink-client", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.ORBYTLINK_MCP_URL!), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.ORBYTLINK_ACCESS_TOKEN}`,
      },
    },
  }),
);
console.log(await client.listTools());
await client.close();
```

**Compatibility boundary:** Claude/ChatGPT configurations vary by client, plan, and authentication support. This version does not implement MCP OAuth resource discovery, dynamic client registration, or an interactive OAuth authorization server. A client that mandates that flow cannot connect directly yet; integrate the configured identity provider’s standard OAuth flow before claiming plug-and-play support. The official SDK client initializes, discovers, estimates, and invokes the official SDK endpoint in an in-process integration test. Raw upstream tool forwarding and approval bypasses are not exposed. `run_workflow` defaults to demo; live invocation requires an OIDC identity and explicit `acceptEstimatedCost: true` after reviewing `estimate_workflow`. Live tool steps still pause for approval in the workstation. MCP discovery and run responses omit private workflow and skill instruction snapshots.

## Security and deployment boundaries

- Every protected API read/write authenticates a token and enforces its operation permission. All object access is scoped using the verified workspace. Zod validates configuration, limits request size, and rejects credential-bearing URLs; Ajv checks actual discovered tool schemas. Prepared statements prevent user input from becoming SQL.
- AES-256-GCM encrypts saved keys/tokens with a fresh nonce per write. Production needs a protected, stable `SECRET_KEY` and preferably an external secrets service such as OpenBao. Losing the key loses access to saved credentials. Key rotation/migration is not automated.
- Saved credential values, bearer strings, and sensitive named output properties are redacted from returned state and persisted tool results. Raw transport errors are not returned by verification routes. Do not embed secrets in skill text or workflow literals; use connection credential fields. Redaction cannot recognize every arbitrary secret supplied by an external service.
- HTTP calls have 10–30 second timeouts. MCP discovery is bounded and tool results are size checked. Generic redirects are rejected. Only exact allowlisted HTTPS hosts resolving to public IPv4 are eligible; private/reserved addresses and IPv6 are blocked. DNS checks alone do **not** defeat DNS rebinding: production requires a network egress policy/proxy that pins and filters destinations. Upstream MCP metadata/results are untrusted data, never permission grants.
- Rate limits use a maintained middleware and an in-memory store. The service defaults to loopback, does not trust proxy headers, checks mutation Origins, and emits standard security response headers. Configure proxy trust and a shared limiter deliberately before multi-instance hosting. Terminate HTTPS at a maintained reverse proxy; no custom TLS stack is present.
- SQLite plus p-queue is a **single-instance** first-version adapter. There is no distributed lock, scheduler cluster, periodic polling of upstream systems, transactional outbox, or exactly-once delivery claim. Startup marks queued/in-flight runs failed for manual reconciliation; waiting approvals remain available. Deploy Temporal or another maintained durable orchestration service before horizontal workers or long-lived unattended production jobs.
- Spending enforcement stops new reservations above the workspace’s lifetime budget. External tool prices are user estimates; provider-side budgets are required for a hard external bill cap. Failed calls retain estimates/reservations. Administrative reconciliation/refunds, billing periods, payments, tax, invoices, and webhook verification are not built.
- Audit records persist configuration changes, tests, step completions, decisions, and jobs. They are not cryptographically append-only or protected from a database administrator. Add independent retention/export and tamper-resistant storage before compliance-sensitive deployment.
- No secure VM or sandbox is configured. A real execution adapter needs isolated Linux infrastructure (for example a correctly configured gVisor service), per-job identity, resource/time limits, restricted egress, ephemeral mounts, secret injection policy, artifact scanning/storage, cleanup, and independent isolation testing. Do not replace the demo adapter with host `exec` or Node `vm`.
- Branding supports configurable product/workspace name and primary color. Asset upload/custom logo and per-domain tenant routing are future work. Skills are free and workspace-owned. Downloaded or shared Markdown can be copied; no DRM or skill marketplace is claimed. Private workflow execution can remain behind the gateway; this version does not offer paid protected workflows.

## Verification performed in this environment

The latest run passed **34 tests**; type checking, lint, and the production build also passed.

`npm test` exercises the actual Express middleware stack using in-process HTTP requests and signed test OIDC tokens, plus runner/storage tests and real React DOM interactions under Happy DOM. Coverage includes startup/health, navigation, form persistence, connection validation, missing/unreachable MCP states, secret encryption/redaction, Markdown validation/editing, workflow validation, output references, success/failure/cancellation, approval/rejection, approval binding, authorization/workspace isolation, offline demo behavior, OpenRouter states, usage reservations, and stop-on-limit behavior. Test doubles stand in for remote services; these are not claims of live endpoint verification.

The environment blocks TCP listeners (`EPERM`) and Chromium’s macOS launch IPC (`MachPortRendezvous … Permission denied`). Browser tests were attempted and could not run here; automated screenshot/layout verification remains outstanding. The maintained Playwright suite is included for a normal local/CI environment. DOM tests are a fallback for interaction verification, not a claim of visual browser QA. No remote was added, no push was performed, and no account outside `prabalp` was used.
