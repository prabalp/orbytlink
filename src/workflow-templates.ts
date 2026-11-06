// Starting points for common workflows. Upstream tool names and argument names differ by
// app and version, so a template never assumes them: each step names the app, a pattern for
// the kind of tool it needs, and patterns for the arguments it can fill. The editor binds
// these to the tools actually connected, and leaves anything it can't match for the person.
//
// Templates use the whole engine: a decision step (written by an AI model or the agent running
// it), retries, "carry on if this fails", the run screen's field types and result view, and a
// default for who decides. A decision step needs no app, so it never blocks a template.
export type TemplateStep = {
  id: string;
  app: string;
  logo: string;
  label: string;
  tool: RegExp;
  args: [RegExp, string][];
  // A decision rather than an app call: what to decide, and the shape of the answer.
  judge?: { prompt: string; returns?: string };
  retries?: number;
  // "continue" keeps the run going if this step fails (e.g. an announcement after the real work).
  onError?: "stop" | "continue";
};
export type FieldType = "text" | "textarea" | "number" | "date" | "email" | "url" | "select" | "checkbox";
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  inputs: { name: string; description: string; required: boolean }[];
  steps: TemplateStep[];
  // Who makes the decisions by default. "agent" pauses and asks whoever runs it; "ai" is automatic
  // and uses AI credit, so it is only the default where no one is there to ask.
  judgment?: "ai" | "agent";
  ui?: { inputs?: Record<string, { type?: FieldType; label?: string }>; output?: { from?: string; view?: string } };
  keepLastResult?: boolean;
  notes?: string;
};

const slackPost = (id: string, text: string, onError?: "continue"): TemplateStep => ({
  id,
  app: "Slack",
  logo: "slack",
  label: "Send a Slack message",
  tool: /slack.*__.*(send|post).*message/i,
  args: [
    [/channel/i, "{{input.channel}}"],
    [/^(text|message|content|body)$/i, text],
  ],
  retries: 2,
  ...(onError ? { onError } : {}),
});

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "issue-announce",
    name: "File an issue and announce it",
    description: "Create a Linear issue, then post its title to a Slack channel. The issue is filed even if the announcement fails.",
    inputs: [
      { name: "title", description: "Issue title", required: true },
      { name: "details", description: "Issue description", required: false },
      { name: "channel", description: "Slack channel ID", required: true },
    ],
    steps: [
      {
        id: "issue",
        app: "Linear",
        logo: "linear",
        label: "Create a Linear issue",
        tool: /linear.*__.*(create|save).*issue/i,
        args: [
          [/^(title|name)$/i, "{{input.title}}"],
          [/^(description|body)$/i, "{{input.details}}"],
        ],
        retries: 2,
      },
      slackPost("post", "New issue: {{input.title}}", "continue"),
    ],
    ui: { inputs: { title: { type: "text" }, details: { type: "textarea" } }, output: { from: "issue", view: "auto" } },
  },
  {
    id: "update-log",
    name: "Post an update and log it",
    description: "Share an update in Slack and append it as a row in a Google Sheet.",
    inputs: [
      { name: "update", description: "The update to share", required: true },
      { name: "channel", description: "Slack channel ID", required: true },
      { name: "spreadsheet", description: "Google Sheet ID", required: true },
    ],
    steps: [
      slackPost("post", "{{input.update}}"),
      {
        id: "log",
        app: "Google Sheets",
        logo: "google-sheets",
        label: "Append a row",
        tool: /sheets.*__.*append/i,
        args: [
          [/spreadsheet/i, "{{input.spreadsheet}}"],
          [/^range$/i, "Sheet1!A:A"],
          [/^values$/i, '[["{{input.update}}"]]'],
        ],
        retries: 2,
      },
    ],
    ui: { inputs: { update: { type: "textarea" } }, output: { from: "log", view: "auto" } },
  },
  {
    id: "notion-share",
    name: "Write a Notion page and share it",
    description: "Create a page in Notion, then post a note about it in Slack. The page is kept even if the note fails.",
    inputs: [
      { name: "title", description: "Page title", required: true },
      { name: "content", description: "Page content", required: false },
      { name: "channel", description: "Slack channel ID", required: true },
    ],
    steps: [
      {
        id: "page",
        app: "Notion",
        logo: "notion",
        label: "Create a Notion page",
        tool: /notion.*__.*create.*page/i,
        args: [
          [/^title$/i, "{{input.title}}"],
          [/^(content|body|text)$/i, "{{input.content}}"],
        ],
        retries: 2,
      },
      slackPost("post", "New page in Notion: {{input.title}}", "continue"),
    ],
    ui: { inputs: { title: { type: "text" }, content: { type: "textarea" } }, output: { from: "page", view: "auto" } },
  },
  {
    id: "email-draft",
    name: "Draft an email from notes",
    description: "Turn rough notes into a Gmail draft, ready to review and send. The wording is a decision: the agent (or an AI model, if you switch it) writes it.",
    inputs: [
      { name: "to", description: "Recipient address", required: true },
      { name: "subject", description: "Subject line", required: true },
      { name: "notes", description: "What the email should say, in rough notes", required: true },
    ],
    steps: [
      {
        id: "write",
        app: "Decision",
        logo: "gmail",
        label: "Write the email",
        tool: /^judge$/,
        args: [],
        judge: {
          prompt: "Write a short, polite email from these notes. Subject: {{input.subject}}. Notes: {{input.notes}}",
          returns: "the email body as plain text, with no subject line",
        },
      },
      {
        id: "draft",
        app: "Gmail",
        logo: "gmail",
        label: "Create a draft",
        tool: /gmail.*__.*draft/i,
        args: [
          [/^to$/i, "{{input.to}}"],
          [/^subject$/i, "{{input.subject}}"],
          [/^(body|text|content)$/i, "{{steps.write.text}}"],
        ],
        retries: 2,
      },
    ],
    judgment: "agent",
    ui: { inputs: { to: { type: "email" }, notes: { type: "textarea" } }, output: { from: "draft", view: "auto" } },
  },
  {
    id: "issue-digest",
    name: "Summarise open issues for the team",
    description: "Read your Linear issues, have them summarised into a short digest, and post it to Slack. Set it to AI and a schedule to run unattended.",
    inputs: [{ name: "channel", description: "Slack channel ID", required: true }],
    steps: [
      {
        id: "issues",
        app: "Linear",
        logo: "linear",
        label: "List issues",
        tool: /linear.*__.*(list|search).*issues?/i,
        args: [],
        retries: 2,
      },
      {
        id: "digest",
        app: "Decision",
        logo: "linear",
        label: "Write the digest",
        tool: /^judge$/,
        args: [],
        judge: {
          prompt: "Summarise these issues into a digest of at most 6 bullets, grouped by theme, flagging anything blocked or urgent:\n{{steps.issues.text}}",
          returns: "Markdown bullets",
        },
      },
      slackPost("post", "{{steps.digest.text}}"),
    ],
    judgment: "agent",
    keepLastResult: true,
    ui: { output: { from: "digest", view: "text" } },
  },
];

// ── Binding a template to the tools actually connected ────────────────────────
type ToolLike = { name: string; def: { inputSchema?: { properties?: Record<string, unknown> } } & Record<string, unknown> };
export function bindTemplate(t: WorkflowTemplate, tools: ToolLike[]) {
  const uiInputs = Object.fromEntries(Object.entries(t.ui?.inputs || {}).filter(([k]) => t.inputs.some((i) => i.name === k)));
  return {
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    enabled: false,
    judgment: t.judgment || "agent",
    keepLastResult: !!t.keepLastResult,
    notes: t.notes || "",
    ...(t.ui ? { ui: { inputs: uiInputs, output: { path: "", view: "auto", ...(t.ui.output || {}) } } } : {}),
    steps: t.steps.map((st) => {
      const retries = st.retries ? { retries: st.retries } : {};
      const onError = st.onError ? { onError: st.onError } : {};
      // A decision needs no app.
      if (st.judge) return { id: st.id, tool: "judge", args: { prompt: st.judge.prompt, ...(st.judge.returns ? { returns: st.judge.returns } : {}) }, ...retries, ...onError };
      const match = tools.find((x) => st.tool.test(x.name));
      const props = Object.keys(match?.def.inputSchema?.properties || {});
      const args: Record<string, string> = {};
      for (const key of props) {
        const hint = st.args.find(([re]) => re.test(key));
        if (hint) args[key] = hint[1];
      }
      return { id: st.id, tool: match?.name || "", args, ...retries, ...onError, hint: match ? undefined : { app: st.app, label: st.label } };
    }),
  };
}
// The apps a template needs that aren't connected (decision steps need none).
export const missingApps = (t: WorkflowTemplate, tools: { name: string }[]) =>
  [...new Set(t.steps.filter((st) => !st.judge && !tools.some((x) => st.tool.test(x.name))).map((st) => st.app))];
// Marks shown on the card: one per app, not per step.
export const templateLogos = (t: WorkflowTemplate) => [...new Set(t.steps.filter((st) => !st.judge).map((st) => st.logo))];
