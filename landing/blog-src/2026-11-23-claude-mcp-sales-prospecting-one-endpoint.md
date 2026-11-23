---
title: "Claude MCP for Sales Prospecting: One Endpoint for Your Stack"
slug: claude-mcp-sales-prospecting-one-endpoint
date: 2026-11-23
summary: Connect Claude to your CRM and enrichment tools through one MCP endpoint. Keep credentials out of agents and credit spend under approval.
tags: [mcp, gateway, gtm]
draft: false
---

You can run prospecting from a Claude chat: find accounts, find the right people, enrich them and write them to your CRM. The hard part is not the prompt. It is wiring up three or four MCP servers, keeping their credentials safe and stopping the agent from burning enrichment credits. This post shows a setup that handles all three.

## What the stack looks like

A typical GTM setup has three parts, and each has its own MCP connector today:

- **A data source** for people and companies. [Apollo's connector](https://docs.apollo.io/docs/apollo-mcp) offers people search, company search, enrichment and sequence tools. [Clay](https://university.clay.com/courses/clay-mcps-for-reps) offers an MCP for finding and enriching contacts and researching accounts.
- **A CRM** that holds the record. [HubSpot's connector](https://knowledge.hubspot.com/integrations/set-up-and-use-the-hubspot-connector-for-claude) reads engagement history and can create and update contacts, companies, deals and tickets.
- **An agent** such as Claude or Cursor that decides which tool to call.

Connecting each of these to each agent works fine for one person. It gets messy fast for a team.

## Where it breaks down

**Credentials spread.** Each agent, on each laptop, holds its own tokens for Apollo, HubSpot and anything else. When someone leaves, you are revoking keys in several places.

**Tool overload.** Every connected server adds its tools to the agent's context, and accuracy tends to drop as the tool count grows. The [RAG-MCP paper](https://arxiv.org/abs/2505.03275) reported that retrieving only the relevant tools raised selection accuracy from 13.62% to 43.13% on its benchmark. Treat the exact figures as one benchmark, not a law.

**Silent spend.** Enrichment costs money. In Apollo's connector, people search does not use credits, but company search and enrichment do, and Apollo recommends setting actions that consume credits to "Approval required". The same goes for any pay-per-use tool: someone has to decide when it is allowed to run.

## One gateway instead of many connections

OrbytLink sits between your agents and your tools. You connect each app once, as an MCP server or as any API with a key or OAuth sign-in. Every agent then reaches all of them through a single MCP endpoint, with one token per agent. Credentials stay in OrbytLink instead of in each agent, and the agent sees only the tools it needs.

For a GTM team, that means:

1. Add your data source and CRM to a shared workspace.
2. Invite teammates with the member role. They use the connections without ever seeing the secrets.
3. Point each person's Claude or Cursor at the one OrbytLink endpoint.

In Claude Code, adding a remote MCP server is one command. Apollo's own docs show the pattern for its server: `claude mcp add --transport http apollo https://mcp.apollo.io/mcp`. With a gateway, you run the same kind of command once, with your OrbytLink endpoint, and you do not add Apollo and HubSpot separately.

```
claude mcp add --transport http orbytlink <your-orbytlink-mcp-url>
```

Copy your endpoint URL from the app; the one above is a placeholder. Claude opens a sign-in when you connect. Clients that can't sign in use a per-agent token instead.

## A prospecting run, step by step

Once connected, you can ask for the job in plain language:

> Find 25 VPs of RevOps at B2B SaaS companies with 50 to 200 employees. Use search first. Enrich only the ones that match my ICP. Then create them as contacts in HubSpot and tell me how many credits you used.

The agent calls the people-search tool, which does not use Apollo credits on a paid plan, and shows you a shortlist. It then calls the enrichment tool only on the people you approve, and creates the contacts in the CRM. Keep the CRM as the source of truth: HubSpot recommends setting write tools to ask for approval, and that is a good default for any record you did not review.

## Control cost before it surprises you

Three habits keep pay-per-use tools predictable:

- **Search before enrich.** Where the data source has a search that costs no credits, such as people search in Apollo, make that the first step in your instructions, as in the prompt above.
- **Require approval on spending tools.** Set credit-consuming tools to ask first in each provider's own settings.
- **Cap model spend.** If you also use AI models through OrbytLink, they are billed per token from prepaid credit, at the price listed for each model in the catalog. Failed calls are free. Workspace admins can set a monthly limit or turn models off, and the usage log lists each charge with its model, tokens and cost. See [pricing](https://orbytlink.com/pricing).

## Turn the good run into a routine

When a prospecting run goes well, you do not have to re-prompt it every week. OrbytLink can capture a finished task as a [workflow](https://orbytlink.com/workflows.html), a fixed list of tool calls that runs the same way every time, on a schedule or on demand, without a model in the loop for the fixed steps. A workflow can include decision steps, retries and a step-by-step run log. You can also save the instructions as a [skill](https://orbytlink.com/skills.html) that your team shares, so everyone prospects the same way.

[Get started](https://app.orbytlink.com/)
