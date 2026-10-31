// How each agent connects to the gateway. Every snippet follows the client's own docs
// (links below); keep it that way when adding one. `u` is the MCP URL, `t` the token.
export type Step = { text: string; file?: string; code?: (u: string, t: string) => string };
export type Method = { id: "cli" | "config" | "app" | "api"; label: string; steps: Step[] };
export type Agent = {
  id: string;
  name: string;
  // Key into brand-icons (a mark or a monogram).
  logo: string;
  kind: string;
  methods: Method[];
  note?: string;
  docs?: string;
};

const json = (v: unknown) => JSON.stringify(v, null, 2);
const bearer = (t: string) => `Bearer ${t}`;
// Agents that read the token from the environment keep it out of config files.
const ENV = "ORBYTLINK_TOKEN";
const exportToken = (t: string) => `export ${ENV}="${t}"`;
const envStep: Step = {
  text: "Put the token in your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal.",
  code: (_u, t) => exportToken(t),
};

export const agents: Agent[] = [
  {
    id: "claude-code",
    logo: "agent-claude",
    name: "Claude Code",
    kind: "CLI",
    methods: [
      {
        id: "cli",
        label: "Command",
        steps: [
          {
            text: "Run this once. --scope user makes OrbytLink available in every project.",
            code: (u, t) => `claude mcp add --transport http --scope user orbytlink ${u} --header "Authorization: ${bearer(t)}"`,
          },
          { text: "Start Claude Code and run /mcp to check that orbytlink is connected." },
        ],
      },
      {
        id: "config",
        label: "Project file",
        steps: [
          {
            text: "Add this to .mcp.json at the root of your project. The token is read from the environment, so the file is safe to commit.",
            file: ".mcp.json",
            code: (u) => json({ mcpServers: { orbytlink: { type: "http", url: u, headers: { Authorization: `Bearer \${${ENV}}` } } } }),
          },
          envStep,
        ],
      },
    ],
    docs: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "claude",
    logo: "agent-claude",
    name: "Claude",
    kind: "Desktop app",
    methods: [
      {
        id: "config",
        label: "Desktop config",
        steps: [
          {
            text: "In Claude Desktop open Settings → Developer → Edit config, and add this to claude_desktop_config.json. Requires Node.js.",
            file: "claude_desktop_config.json",
            code: (u, t) =>
              json({
                mcpServers: {
                  // The header value goes through env: some platforms split arguments on spaces.
                  orbytlink: {
                    command: "npx",
                    args: ["-y", "mcp-remote", u, "--header", "Authorization:${AUTH}"],
                    env: { AUTH: bearer(t) },
                  },
                },
              }),
          },
          { text: "Quit and reopen Claude Desktop. OrbytLink’s tools appear under the tools menu in a chat." },
        ],
      },
    ],
    note: "Custom connectors on claude.ai and in Claude’s Connectors settings sign in with OAuth, which the gateway does not offer to clients yet. Use the desktop config above for now.",
  },
  {
    id: "codex",
    logo: "agent-codex",
    name: "Codex",
    kind: "CLI and IDE",
    methods: [
      {
        id: "config",
        label: "config.toml",
        steps: [
          {
            text: "Add this to ~/.codex/config.toml. Codex reads the token from the environment.",
            file: "~/.codex/config.toml",
            code: (u) => `[mcp_servers.orbytlink]\nurl = "${u}"\nbearer_token_env_var = "${ENV}"`,
          },
          envStep,
          { text: "Start Codex. The ChatGPT desktop app and the Codex IDE extension share this configuration." },
        ],
      },
    ],
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    id: "chatgpt",
    logo: "agent-chatgpt",
    name: "ChatGPT",
    kind: "Desktop app",
    methods: [
      {
        id: "app",
        label: "In the app",
        steps: [
          { text: "In the ChatGPT desktop app open Settings → MCP servers → Add server, and choose Streamable HTTP." },
          { text: "Server URL:", code: (u) => u },
          { text: "Authentication: Bearer token. Paste:", code: (_u, t) => t },
        ],
      },
    ],
    note: "ChatGPT on the web connects through plugins and is not supported yet. The desktop app shares its servers with Codex.",
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    id: "cursor",
    logo: "agent-cursor",
    name: "Cursor",
    kind: "Editor",
    methods: [
      {
        id: "config",
        label: "mcp.json",
        steps: [
          {
            text: "Add this to ~/.cursor/mcp.json for every project, or .cursor/mcp.json for one. Keep the file private: it holds your token.",
            file: "~/.cursor/mcp.json",
            code: (u, t) => json({ mcpServers: { orbytlink: { url: u, headers: { Authorization: bearer(t) } } } }),
          },
          { text: "Open Cursor Settings → MCP and check that orbytlink is enabled." },
        ],
      },
    ],
    docs: "https://cursor.com/docs/context/mcp",
  },
  {
    id: "vscode",
    logo: "agent-copilot",
    name: "VS Code",
    kind: "GitHub Copilot",
    methods: [
      {
        id: "cli",
        label: "Command",
        steps: [
          {
            text: "Run this to add OrbytLink to your VS Code profile:",
            code: (u, t) =>
              `code --add-mcp '${JSON.stringify({ name: "orbytlink", type: "http", url: u, headers: { Authorization: bearer(t) } })}'`,
          },
        ],
      },
      {
        id: "config",
        label: "mcp.json",
        steps: [
          {
            text: "Add this to .vscode/mcp.json. VS Code asks for the token once and stores it securely, so nothing secret is in the file.",
            file: ".vscode/mcp.json",
            code: (u) =>
              json({
                inputs: [{ type: "promptString", id: "orbytlink-token", description: "OrbytLink gateway token", password: true }],
                servers: { orbytlink: { type: "http", url: u, headers: { Authorization: "Bearer ${input:orbytlink-token}" } } },
              }),
          },
          { text: "When prompted, paste your token:", code: (_u, t) => t },
        ],
      },
    ],
    docs: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
  },
  {
    id: "gemini",
    logo: "agent-gemini",
    name: "Gemini CLI",
    kind: "CLI",
    methods: [
      {
        id: "cli",
        label: "Command",
        steps: [
          {
            text: "Run this once. --scope user makes it available everywhere.",
            code: (u, t) => `gemini mcp add --scope user --transport http --header "Authorization: ${bearer(t)}" orbytlink ${u}`,
          },
          { text: "Start Gemini CLI and run /mcp to see OrbytLink’s tools." },
        ],
      },
      {
        id: "config",
        label: "settings.json",
        steps: [
          {
            text: "Or add this to ~/.gemini/settings.json. Streamable HTTP uses httpUrl.",
            file: "~/.gemini/settings.json",
            code: (u, t) => json({ mcpServers: { orbytlink: { httpUrl: u, headers: { Authorization: bearer(t) } } } }),
          },
        ],
      },
    ],
    docs: "https://geminicli.com/docs/tools/mcp-server/",
  },
  {
    id: "windsurf",
    logo: "agent-windsurf",
    name: "Windsurf",
    kind: "Editor",
    methods: [
      {
        id: "config",
        label: "mcp_config.json",
        steps: [
          {
            text: "Add this to ~/.codeium/windsurf/mcp_config.json, then refresh MCP servers in Windsurf.",
            file: "~/.codeium/windsurf/mcp_config.json",
            code: (u, t) => json({ mcpServers: { orbytlink: { serverUrl: u, headers: { Authorization: bearer(t) } } } }),
          },
        ],
      },
    ],
  },
  {
    id: "grok",
    logo: "agent-grok",
    name: "Grok",
    kind: "xAI API",
    methods: [
      {
        id: "api",
        label: "API",
        steps: [
          {
            text: "Add this tool to the tools array of your xAI Responses API request. Grok calls the gateway directly.",
            code: (u, t) => json({ type: "mcp", server_url: u, server_label: "orbytlink", authorization: t }),
          },
        ],
      },
    ],
    note: "Remote MCP is available through the xAI API. The grok.com app is not covered by xAI’s MCP docs.",
    docs: "https://docs.x.ai/docs/guides/tools/remote-mcp-tools",
  },
  {
    id: "hermes",
    logo: "agent-hermes",
    name: "Hermes Agent",
    kind: "Nous Research",
    methods: [
      {
        id: "config",
        label: "config.yaml",
        steps: [
          {
            text: "Add this under mcp_servers in ~/.hermes/config.yaml:",
            file: "~/.hermes/config.yaml",
            code: (u, t) => `mcp_servers:\n  orbytlink:\n    url: "${u}"\n    headers:\n      Authorization: "${bearer(t)}"`,
          },
          { text: "In Hermes, run /reload-mcp." },
        ],
      },
    ],
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
  {
    id: "openclaw",
    logo: "agent-openclaw",
    name: "OpenClaw",
    kind: "Agent",
    methods: [
      {
        id: "config",
        label: "openclaw.json",
        steps: [
          {
            text: "Merge this into ~/.openclaw/openclaw.json under mcp.servers:",
            file: "~/.openclaw/openclaw.json",
            code: (u, t) =>
              json({ mcp: { servers: { orbytlink: { url: u, transport: "streamable-http", headers: { Authorization: bearer(t) } } } } }),
          },
          { text: "Run openclaw doctor to check the configuration." },
        ],
      },
    ],
    docs: "https://docs.openclaw.ai/gateway/configuration-reference",
  },
  {
    id: "mcp",
    logo: "agent-mcp",
    name: "Any MCP client",
    kind: "URL and token",
    methods: [
      {
        id: "config",
        label: "Settings",
        steps: [
          { text: "Transport: Streamable HTTP. Server URL:", code: (u) => u },
          { text: "Send this header with every request:", code: (_u, t) => `Authorization: ${bearer(t)}` },
          {
            text: "Most clients accept this standard JSON:",
            code: (u, t) => json({ mcpServers: { orbytlink: { url: u, headers: { Authorization: bearer(t) } } } }),
          },
        ],
      },
    ],
  },
];
