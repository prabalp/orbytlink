// Ready-made API setups. Base URLs and key schemes come from each API's own published OpenAPI
// spec where one exists (docsUrl), otherwise from its official docs; every docsUrl was fetched
// to confirm it is live. `{placeholders}` in a base URL are account-specific and must be filled in.
export type ApiPreset = {
  id: string;
  name: string;
  category: string;
  description: string;
  baseUrl: string;
  docsUrl: string;
  auth: "bearer" | "header" | "query" | "basic";
  authName?: string;
  headers?: Record<string, string>;
  bodyFormat?: "json" | "form";
  // How to find the key, and its exact format when it isn't just the key.
  keyHint: string;
  note?: string;
};

export const apiCategories = ["AI", "Payments", "Developer", "Productivity", "Communication", "CRM & Support", "Commerce", "Data"] as const;

export const apiPresets: ApiPreset[] = [
  // AI
  { id: "openai", name: "OpenAI", category: "AI", description: "Models, embeddings, images, audio and files.", baseUrl: "https://api.openai.com/v1", docsUrl: "https://raw.githubusercontent.com/openai/openai-openapi/manual_spec/openapi.yaml", auth: "bearer", keyHint: "Create a secret key in the OpenAI platform under API keys." },
  { id: "anthropic", name: "Anthropic", category: "AI", description: "Claude models through the Messages API.", baseUrl: "https://api.anthropic.com/v1", docsUrl: "https://docs.claude.com/llms.txt", auth: "header", authName: "x-api-key", headers: { "anthropic-version": "2023-06-01" }, keyHint: "Create a key in the Claude Console under API keys." },
  { id: "gemini", name: "Google Gemini", category: "AI", description: "Gemini models through the Gemini API.", baseUrl: "https://generativelanguage.googleapis.com/v1beta", docsUrl: "https://ai.google.dev/api/llms.txt", auth: "header", authName: "x-goog-api-key", keyHint: "Create a key in Google AI Studio." },
  { id: "mistral", name: "Mistral AI", category: "AI", description: "Mistral models, embeddings and agents.", baseUrl: "https://api.mistral.ai", docsUrl: "https://docs.mistral.ai/openapi.yaml", auth: "bearer", keyHint: "Create a key in La Plateforme under API keys." },
  { id: "groq", name: "Groq", category: "AI", description: "Fast inference with an OpenAI-compatible API.", baseUrl: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/docs/api-reference", auth: "bearer", keyHint: "Create a key in the Groq console under API keys." },
  { id: "perplexity", name: "Perplexity", category: "AI", description: "Search-grounded answers through the Sonar API.", baseUrl: "https://api.perplexity.ai", docsUrl: "https://docs.perplexity.ai/llms.txt", auth: "bearer", keyHint: "Create a key in Perplexity's API settings." },
  // Payments
  { id: "stripe", name: "Stripe", category: "Payments", description: "Customers, payments, invoices and subscriptions.", baseUrl: "https://api.stripe.com", docsUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json", auth: "bearer", bodyFormat: "form", keyHint: "Use a restricted key from the Stripe Dashboard, with only the permissions you need.", note: "Paths include the version, e.g. /v1/customers." },
  { id: "razorpay", name: "Razorpay", category: "Payments", description: "Orders, payments, refunds and settlements.", baseUrl: "https://api.razorpay.com/v1", docsUrl: "https://razorpay.com/docs/api/", auth: "basic", keyHint: "Enter key_id:key_secret from the Razorpay Dashboard under API keys." },
  // Developer
  { id: "github", name: "GitHub", category: "Developer", description: "Repositories, issues, pull requests and Actions.", baseUrl: "https://api.github.com", docsUrl: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json", auth: "bearer", headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, keyHint: "Create a fine-grained personal access token limited to the repositories you need." },
  { id: "gitlab", name: "GitLab", category: "Developer", description: "Projects, merge requests, pipelines and issues.", baseUrl: "https://gitlab.com", docsUrl: "https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v2.yaml", auth: "header", authName: "PRIVATE-TOKEN", keyHint: "Create a personal or project access token in GitLab.", note: "Paths include the version, e.g. /api/v4/projects." },
  { id: "vercel", name: "Vercel", category: "Developer", description: "Projects, deployments, domains and environment variables.", baseUrl: "https://api.vercel.com", docsUrl: "https://openapi.vercel.sh/", auth: "bearer", keyHint: "Create a token in your Vercel account settings under Tokens." },
  { id: "cloudflare", name: "Cloudflare", category: "Developer", description: "Zones, DNS, Workers, R2 and more.", baseUrl: "https://api.cloudflare.com/client/v4", docsUrl: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json", auth: "bearer", keyHint: "Create an API token (not the global API key) scoped to what you need." },
  { id: "sentry", name: "Sentry", category: "Developer", description: "Issues, events, releases and projects.", baseUrl: "https://sentry.io", docsUrl: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json", auth: "bearer", keyHint: "Create an auth token in Sentry under User settings or an internal integration.", note: "Paths start with /api/0/." },
  { id: "supabase", name: "Supabase", category: "Developer", description: "Management API: projects, databases, functions and secrets.", baseUrl: "https://api.supabase.com", docsUrl: "https://api.supabase.com/api/v1-json", auth: "bearer", keyHint: "Create a personal access token in your Supabase account settings." },
  // Productivity
  { id: "notion", name: "Notion", category: "Productivity", description: "Pages, databases, blocks and search.", baseUrl: "https://api.notion.com/v1", docsUrl: "https://developers.notion.com/llms.txt", auth: "bearer", headers: { "Notion-Version": "2022-06-28" }, keyHint: "Create an internal integration in Notion and copy its secret. Share pages with the integration." },
  { id: "airtable", name: "Airtable", category: "Productivity", description: "Bases, tables and records.", baseUrl: "https://api.airtable.com/v0", docsUrl: "https://airtable.com/developers/web/api/introduction", auth: "bearer", keyHint: "Create a personal access token in Airtable's developer hub, scoped to your bases." },
  { id: "linear", name: "Linear", category: "Productivity", description: "Issues, projects and cycles through GraphQL.", baseUrl: "https://api.linear.app", docsUrl: "https://linear.app/developers/graphql", auth: "header", authName: "Authorization", keyHint: "Create a personal API key in Linear under Settings → Security & access.", note: "GraphQL: send POST /graphql with a query. Allow writes so agents can POST." },
  { id: "asana", name: "Asana", category: "Productivity", description: "Tasks, projects, workspaces and teams.", baseUrl: "https://app.asana.com/api/1.0", docsUrl: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml", auth: "bearer", keyHint: "Create a personal access token in the Asana developer console." },
  { id: "clickup", name: "ClickUp", category: "Productivity", description: "Tasks, lists, spaces and time tracking.", baseUrl: "https://api.clickup.com/api", docsUrl: "https://developer.clickup.com/openapi/clickup-api-v2-reference.json", auth: "header", authName: "Authorization", keyHint: "Copy your personal API token from ClickUp settings under Apps.", note: "Paths start with /v2/." },
  // Communication
  { id: "slack", name: "Slack", category: "Communication", description: "Channels, messages, users and files (Web API).", baseUrl: "https://slack.com/api", docsUrl: "https://api.slack.com/specs/openapi/v2/slack_web.json", auth: "bearer", keyHint: "Install a Slack app to your workspace and copy its bot token (xoxb-…)." },
  { id: "discord", name: "Discord", category: "Communication", description: "Guilds, channels, messages and members.", baseUrl: "https://discord.com/api/v10", docsUrl: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json", auth: "header", authName: "Authorization", keyHint: "Enter it as Bot <your bot token>, from the Discord developer portal." },
  { id: "twilio", name: "Twilio", category: "Communication", description: "SMS, voice calls and phone numbers.", baseUrl: "https://api.twilio.com", docsUrl: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json", auth: "basic", bodyFormat: "form", keyHint: "Enter AccountSID:AuthToken, or an API key as SID:Secret, from the Twilio Console.", note: "Paths include the version, e.g. /2010-04-01/Accounts/{AccountSid}/Messages.json." },
  { id: "sendgrid", name: "SendGrid", category: "Communication", description: "Transactional email sending.", baseUrl: "https://api.sendgrid.com", docsUrl: "https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_mail_v3.json", auth: "bearer", keyHint: "Create an API key in SendGrid under Settings → API Keys.", note: "Paths start with /v3/." },
  { id: "resend", name: "Resend", category: "Communication", description: "Email sending, domains and audiences.", baseUrl: "https://api.resend.com", docsUrl: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml", auth: "bearer", keyHint: "Create an API key in the Resend dashboard." },
  { id: "postmark", name: "Postmark", category: "Communication", description: "Transactional email and message streams.", baseUrl: "https://api.postmarkapp.com", docsUrl: "https://postmarkapp.com/developer/api/overview", auth: "header", authName: "X-Postmark-Server-Token", keyHint: "Copy a server API token from your Postmark server's API Tokens tab." },
  { id: "mailchimp", name: "Mailchimp", category: "Communication", description: "Audiences, campaigns and automations.", baseUrl: "https://{dc}.api.mailchimp.com/3.0", docsUrl: "https://mailchimp.com/developer/marketing/api/", auth: "basic", keyHint: "Enter anystring:<your API key>. Replace {dc} with the part after the dash in your key, e.g. us21." },
  // CRM & Support
  { id: "hubspot", name: "HubSpot", category: "CRM & Support", description: "Contacts, companies, deals and tickets.", baseUrl: "https://api.hubapi.com", docsUrl: "https://developers.hubspot.com/docs/api/overview", auth: "bearer", keyHint: "Create a private app in HubSpot and copy its access token." },
  { id: "pipedrive", name: "Pipedrive", category: "CRM & Support", description: "Deals, persons, organizations and activities.", baseUrl: "https://api.pipedrive.com/v1", docsUrl: "https://developers.pipedrive.com/docs/api/v1/openapi.yaml", auth: "header", authName: "x-api-token", keyHint: "Copy your personal API token from Pipedrive under Personal preferences → API." },
  { id: "intercom", name: "Intercom", category: "CRM & Support", description: "Conversations, contacts, companies and articles.", baseUrl: "https://api.intercom.io", docsUrl: "https://raw.githubusercontent.com/intercom/Intercom-OpenAPI/main/descriptions/2.11/api.intercom.io.yaml", auth: "bearer", keyHint: "Create an app in the Intercom Developer Hub and copy its access token." },
  { id: "zendesk", name: "Zendesk", category: "CRM & Support", description: "Tickets, users, organizations and help center.", baseUrl: "https://{subdomain}.zendesk.com", docsUrl: "https://developer.zendesk.com/zendesk/oas.yaml", auth: "basic", keyHint: "Enter you@company.com/token:<API token>. Replace {subdomain} with your Zendesk subdomain.", note: "Paths start with /api/v2/." },
  // Commerce
  { id: "shopify", name: "Shopify", category: "Commerce", description: "Products, orders, customers and inventory (Admin API).", baseUrl: "https://{store}.myshopify.com/admin/api/{version}", docsUrl: "https://shopify.dev/docs/api/admin-rest", auth: "header", authName: "X-Shopify-Access-Token", keyHint: "Create a custom app in your store admin and copy its Admin API access token. Replace {store}, and {version} with a supported version such as 2026-07." },
  // Data
  { id: "openweather", name: "OpenWeather", category: "Data", description: "Current weather, forecasts and air quality.", baseUrl: "https://api.openweathermap.org/data/2.5", docsUrl: "https://openweathermap.org/current", auth: "query", authName: "appid", keyHint: "Copy an API key from your OpenWeather account under API keys." },
];
