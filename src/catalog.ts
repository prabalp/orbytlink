// Ready-made connections. Every entry here was checked against the vendor's own
// documentation (see docs/CATALOG-RESEARCH.md); add new ones the same way, never from memory.
// More vendor-hosted servers, researched and probed in bulk, come from catalog-researched.ts.
import { researchedPresets } from "./catalog-researched";

export type Preset = {
  id: string;
  name: string;
  segment: string;
  description: string;
  endpoint: string;
  auth: "oauth" | "bearer" | "api-key" | "none";
  authHeader?: string;
  oauth?: {
    mode: "discover" | "manual";
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    scopeParam?: "scope" | "user_scope";
    tokenAuth?: "body" | "basic";
    authParams?: Record<string, string>;
  };
  // The provider needs your own registered OAuth client (client ID and secret).
  ownClient?: boolean;
  preview?: boolean;
  // Kept in the data but not listed in the Catalog page. Remove the flag to show it.
  hidden?: boolean;
  notes: string[];
  docs: string;
};

// Catalog sections appear in this order; Search & Data and Sales & Leads lead.
export const segments = [
  "Search & Data",
  "Sales & Leads",
  "Documents & Files",
  "Communication",
  "Calendar & Contacts",
  "Project Management",
  "Developer Tools",
  "Payments & Finance",
  "AI & Content",
  "Education",
  "Platforms",
] as const;

const g = (...names: string[]) => names.map((n) => `https://www.googleapis.com/auth/${n}`);
const googleOAuth = (scopes: string[]) => ({
  mode: "manual" as const,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes,
  // Offline access gives a refresh token; without it sign-in lapses about hourly.
  authParams: { access_type: "offline", prompt: "consent" },
});
const GOOGLE_DOCS = "https://developers.google.com/workspace/guides/configure-mcp-servers";
const googleNotes = [
  "Google Workspace MCP servers are in Developer Preview: your Google Cloud project must be enrolled in the Workspace Developer Preview Program, with this MCP service enabled.",
  "Create an OAuth client (Web application) with “Use this client for an AI-powered agent” selected, and add the redirect URI shown below.",
];
const google = (
  id: string,
  name: string,
  segment: string,
  subdomain: string,
  description: string,
  scopes: string[],
  host = `${subdomain}.googleapis.com`,
): Preset => ({
  id,
  name,
  segment,
  description,
  endpoint: `https://${host}/mcp/v1`,
  auth: "oauth",
  oauth: googleOAuth(scopes),
  ownClient: true,
  preview: true,
  notes: googleNotes,
  docs: GOOGLE_DOCS,
});

export const catalog: Preset[] = [
  google("google-drive", "Google Drive", "Documents & Files", "drivemcp", "Search, read and organise files in Drive.", g("drive.readonly", "drive.file")),
  google("google-docs", "Google Docs", "Documents & Files", "docsmcp", "Read and edit Google Docs.", g("drive.readonly", "drive.file", "documents.readonly", "documents")),
  google("google-sheets", "Google Sheets", "Documents & Files", "sheetsmcp", "Read and update spreadsheets.", g("drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets")),
  google("google-slides", "Google Slides", "Documents & Files", "slidesmcp", "Read and edit presentations.", g("drive.readonly", "drive.file", "presentations.readonly", "presentations")),
  {
    id: "notion",
    name: "Notion",
    segment: "Documents & Files",
    description: "Search, read, create and update pages and databases.",
    endpoint: "https://mcp.notion.com/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Notion and pick the workspace to share. No client setup needed.",
      "On Business or Enterprise plans you can instead create an MCP token in Notion’s Developer portal and use it as a bearer token (change Authentication to Bearer token).",
    ],
    docs: "https://developers.notion.com/docs/get-started-with-mcp",
  },
  {
    id: "slack",
    name: "Slack",
    segment: "Communication",
    description: "Search messages, read channels and threads, send messages, canvases.",
    endpoint: "https://mcp.slack.com/mcp",
    auth: "oauth",
    oauth: {
      mode: "manual",
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
      scopes: ["search:read.public", "channels:history", "chat:write", "users:read"],
    },
    ownClient: true,
    notes: [
      "Slack only lets directory-published or internal apps use its MCP server. Create an internal Slack app for your workspace and have an admin approve it.",
      "Add the redirect URI shown below to the app, then edit the scopes to match what the app was granted.",
    ],
    docs: "https://docs.slack.dev/ai/mcp-server",
  },
  google("gmail", "Gmail", "Communication", "gmailmcp", "Search, read and draft email.", g("gmail.readonly", "gmail.compose")),
  google(
    "google-chat",
    "Google Chat",
    "Communication",
    "chatmcp",
    "Read spaces and messages, post messages.",
    g("chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create"),
  ),
  google(
    "google-calendar",
    "Google Calendar",
    "Calendar & Contacts",
    "calendarmcp",
    "Check availability and read events.",
    g("calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly"),
  ),
  google(
    "google-people",
    "Google Contacts",
    "Calendar & Contacts",
    "people",
    "Look up people and contacts (People API).",
    g("directory.readonly", "userinfo.profile", "contacts.readonly"),
    "people.googleapis.com",
  ),
  {
    id: "linear",
    name: "Linear",
    segment: "Project Management",
    description: "Find, create and update issues, projects and comments.",
    endpoint: "https://mcp.linear.app/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Linear. No client setup needed.",
      "Prefer a token? Create a Linear API key (Read-only is available) and use it as a bearer token. For read-only access over OAuth, use the endpoint https://mcp.linear.app/mcp/readonly.",
    ],
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira & Confluence)",
    segment: "Project Management",
    description: "Jira, Confluence, Jira Service Management, Bitbucket and more.",
    endpoint: "https://mcp.atlassian.com/v2/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: ["Sign in with Atlassian (OAuth 2.1). An API token is available as an alternative in Atlassian’s documentation."],
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
  },
  {
    id: "github",
    name: "GitHub",
    segment: "Developer Tools",
    description: "Repositories, issues, pull requests and more.",
    endpoint: "https://api.githubcopilot.com/mcp/",
    auth: "bearer",
    notes: [
      "Paste a GitHub personal access token. The server gets the token’s scopes, so grant only what you need.",
      "Enterprise Managed Users: personal access tokens are disabled unless an enterprise admin enables them.",
    ],
    docs: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
  },
  {
    id: "stripe",
    name: "Stripe",
    segment: "Payments & Finance",
    description: "Customers, payments, invoices, subscriptions and the Stripe docs.",
    endpoint: "https://mcp.stripe.com",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Stripe and choose which accounts and permissions to grant. Stripe asks for human confirmation before refunds and payouts.",
      "For an autonomous setup, use a Stripe agent API key as a bearer token instead. Stripe stops accepting ordinary secret and restricted keys on this server from December 2026.",
    ],
    docs: "https://docs.stripe.com/mcp",
  },
  google(
    "google-classroom",
    "Google Classroom",
    "Education",
    "classroommcp",
    "Courses, rosters, announcements and coursework.",
    g(
      "classroom.announcements",
      "classroom.courses.readonly",
      "classroom.coursework.students",
      "classroom.courseworkmaterials",
      "classroom.rosters.readonly",
      "classroom.student-submissions.students.readonly",
      "classroom.topics.readonly",
    ),
  ),
  {
    id: "firecrawl",
    name: "Firecrawl",
    segment: "Search & Data",
    description: "Scrape, crawl, search and extract web pages into clean data.",
    endpoint: "https://mcp.firecrawl.dev/v2/mcp",
    auth: "bearer",
    notes: [
      "Paste your Firecrawl API key as the bearer token. Firecrawl also offers a browser sign-in endpoint (/v2/mcp-oauth), not used here.",
    ],
    docs: "https://docs.firecrawl.dev/mcp-server",
  },
  {
    id: "exa",
    name: "Exa",
    segment: "Search & Data",
    description: "Web search, page fetching and a research agent.",
    endpoint: "https://mcp.exa.ai/mcp",
    auth: "api-key",
    authHeader: "x-api-key",
    notes: [
      "Create an API key at dashboard.exa.ai/api-keys. New accounts start with free credits.",
      "Without a key the server runs keyless with a free rate limit, and the research agent is unavailable.",
    ],
    docs: "https://docs.exa.ai/reference/exa-mcp",
  },
  {
    id: "parallel",
    name: "Parallel",
    segment: "Search & Data",
    description: "Web search, page fetch and deep research for agents.",
    endpoint: "https://mcp.parallel.ai/mcp",
    auth: "bearer",
    notes: [
      "Create an API key at platform.parallel.ai and paste it as the bearer token. Use the URL exactly as shown: a trailing slash returns 404.",
    ],
    docs: "https://docs.parallel.ai/integrations/mcp/quickstart",
  },
  {
    id: "apify",
    name: "Apify",
    segment: "Search & Data",
    description: "Run Apify Actors (scrapers and automations) and search the Actor store.",
    endpoint: "https://mcp.apify.com",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Apify and approve access.",
      "Prefer a token? Create one in Apify Console under API & integrations and use it as a bearer token.",
    ],
    docs: "https://docs.apify.com/platform/integrations/mcp",
  },
  {
    id: "semrush",
    name: "Semrush",
    segment: "Search & Data",
    description: "SEO and market data from Semrush’s APIs.",
    endpoint: "https://mcp.semrush.com/v2/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Semrush. Needs a plan that includes API units.",
    ],
    docs: "https://developer.semrush.com/api/basics/semrush-mcp/",
  },
  {
    id: "dataforseo",
    name: "DataForSEO",
    segment: "Search & Data",
    description: "SERP, keyword and backlink data.",
    endpoint: "https://mcp.dataforseo.com/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with DataForSEO and click Approve. Data calls are billed to your DataForSEO account.",
    ],
    docs: "https://dataforseo.com/help-center/connecting-the-remote-dataforseo-mcp-server-using-oauth",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    segment: "Developer Tools",
    description: "Manage accounts, zones, Workers and DNS through the Cloudflare API.",
    endpoint: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Cloudflare and choose the permissions to grant.",
      "Prefer a token? Create a Cloudflare API token (user or account) and use it as a bearer token.",
    ],
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    id: "alpha-vantage",
    name: "Alpha Vantage",
    segment: "Payments & Finance",
    description: "Stock, forex, crypto and economic data.",
    endpoint: "https://mcp.alphavantage.co/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in, or enter a free Alpha Vantage API key in the browser step.",
    ],
    docs: "https://mcp.alphavantage.co/",
  },
  {
    id: "coingecko",
    name: "CoinGecko",
    segment: "Payments & Finance",
    description: "Crypto prices, market data and on-chain data.",
    endpoint: "https://mcp.pro-api.coingecko.com/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Needs a CoinGecko Demo or Pro API key, which you paste on CoinGecko’s page during sign-in.",
      "The keyless server at mcp.api.coingecko.com/mcp is not offered here because the gateway needs a sign-in or key.",
    ],
    docs: "https://docs.coingecko.com/docs/mcp-server",
  },
  {
    id: "twelve-data",
    name: "Twelve Data",
    segment: "Payments & Finance",
    description: "Stock, forex, crypto and ETF data, fundamentals and indicators.",
    endpoint: "https://mcp.twelvedata.com/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with a Twelve Data account. No API key needed.",
      "Twelve Data marks dynamic client registration as deprecated; if sign-in fails, this is the first thing to check.",
    ],
    docs: "https://twelvedata.com/docs/ai/mcp-server",
  },
  {
    id: "apollo",
    name: "Apollo.io",
    segment: "Sales & Leads",
    description: "Search prospects, enrich contacts and companies, manage sequences.",
    endpoint: "https://mcp.apollo.io/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with Apollo. Needs an active account with credits; free accounts on a personal email cannot use people or company search.",
      "This server can read and change records. Apollo prohibits AI model training on its MCP data, so turn training off in your AI client.",
    ],
    docs: "https://docs.apollo.io/docs/apollo-mcp",
  },
  {
    id: "hunter",
    name: "Hunter",
    segment: "Sales & Leads",
    description: "Find and verify professional emails and enrich companies.",
    endpoint: "https://mcp.hunter.io/mcp",
    auth: "api-key",
    authHeader: "X-API-KEY",
    notes: [
      "Create an API key at hunter.io/api-keys. Email verification uses credits.",
      "Hunter also offers one-click OAuth, not used here because its discovery details are undocumented.",
    ],
    docs: "https://hunter.io/mcp",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    segment: "AI & Content",
    description: "Manage voice agents and generate text to speech.",
    endpoint: "https://api.elevenlabs.io/v1/mcp",
    auth: "oauth",
    oauth: { mode: "discover" },
    notes: [
      "Sign in with ElevenLabs, choose a workspace and authorize.",
      "Changes made through MCP publish directly to the target branch, not as a draft. Accounts with EU, India or Singapore data residency need the regional endpoint from the docs.",
    ],
    docs: "https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp",
  },
  ...researchedPresets,
  {
    id: "composio",
    name: "Composio",
    segment: "Platforms",
    hidden: true,
    description: "One connection to 1,000+ apps. Composio runs each app’s sign-in and tools.",
    endpoint: "",
    auth: "api-key",
    authHeader: "x-api-key",
    notes: [
      "Create an MCP server in Composio and generate its URL (it is specific to a user and server). Paste that URL as the endpoint and your Composio API key as the credential.",
      "Composio is a hosted, paid service with its own free tier. Each user must connect the apps in Composio first.",
    ],
    docs: "https://docs.composio.dev/docs/mcp-overview",
  },
];
