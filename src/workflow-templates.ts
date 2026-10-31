// Starting points for common workflows. Upstream tool names and argument names differ by
// app and version, so a template never assumes them: each step names the app, a pattern for
// the kind of tool it needs, and patterns for the arguments it can fill. The editor binds
// these to the tools actually connected, and leaves anything it can't match for the person.
export type TemplateStep = {
  id: string;
  app: string;
  logo: string;
  label: string;
  tool: RegExp;
  args: [RegExp, string][];
};
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  inputs: { name: string; description: string; required: boolean }[];
  steps: TemplateStep[];
};

const slackPost = (id: string, text: string): TemplateStep => ({
  id,
  app: "Slack",
  logo: "slack",
  label: "Send a Slack message",
  tool: /slack.*__.*(send|post).*message/i,
  args: [
    [/channel/i, "{{input.channel}}"],
    [/^(text|message|content|body)$/i, text],
  ],
});

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "issue-announce",
    name: "File an issue and announce it",
    description: "Create a Linear issue, then post its title to a Slack channel.",
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
      },
      slackPost("post", "New issue: {{input.title}}"),
    ],
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
      },
    ],
  },
  {
    id: "notion-share",
    name: "Write a Notion page and share it",
    description: "Create a page in Notion, then post a note about it in Slack.",
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
      },
      slackPost("post", "New page in Notion: {{input.title}}"),
    ],
  },
  {
    id: "email-draft",
    name: "Draft an email",
    description: "Prepare a Gmail draft from a subject and body, ready to review and send.",
    inputs: [
      { name: "to", description: "Recipient address", required: true },
      { name: "subject", description: "Subject line", required: true },
      { name: "body", description: "Message body", required: true },
    ],
    steps: [
      {
        id: "draft",
        app: "Gmail",
        logo: "gmail",
        label: "Create a draft",
        tool: /gmail.*__.*draft/i,
        args: [
          [/^to$/i, "{{input.to}}"],
          [/^subject$/i, "{{input.subject}}"],
          [/^(body|text|content)$/i, "{{input.body}}"],
        ],
      },
    ],
  },
];
