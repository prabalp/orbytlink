---
title: "Claude MCP for Sales Prospecting: Cut Tool Overload and Credit Spend"
slug: claude-mcp-sales-prospecting-one-endpoint
date: 2026-11-23
summary: Connect Claude to Apollo, Clay and HubSpot through one MCP gateway. Load fewer tool tokens, put approval on credits and keep keys out of agents.
tags: [mcp, gateway, gtm]
draft: false
---

Claude can run sales prospecting end to end through MCP: find accounts, find the right people, enrich them and write them to your CRM. What works for one person gets expensive and risky for a team, because every agent loads every tool, holds every credential and can spend enrichment credits unchecked. An MCP gateway fixes all three by putting one endpoint between your agents and your apps. This guide shows how it works, where the savings come from, and when you do not need one.

> **Key takeaways**
> - Connecting agents to apps directly takes agents × apps connections and credential sets. A gateway takes agents + apps.
> - Loading every tool up front is costly. In Anthropic's own example, 58 tools from five servers used about 55K tokens before the conversation began, and tool search cut that to about 8.7K.
> - Search before you enrich. In Apollo, people search uses no credits while enrichment does. Set credit-consuming actions to require approval.
> - Save a run that works as a workflow, so repeat runs follow fixed steps instead of a model deciding every step again.
> - A gateway is not worth it for one person with one or two servers. It pays off once a team shares tools.

## What a Claude MCP sales prospecting stack looks like

A typical GTM setup has three parts, and each has its own MCP connector today:

- **A data source** for people and companies. [Apollo's connector](https://docs.apollo.io/docs/apollo-mcp) offers people search, company search, enrichment and sequence tools. [Clay](https://university.clay.com/courses/clay-mcps-for-reps) offers an MCP for finding and enriching contacts and researching accounts, and says it is designed for small batches of records.
- **A CRM** that holds the record. [HubSpot's connector](https://knowledge.hubspot.com/integrations/set-up-and-use-the-hubspot-connector-for-claude) reads engagement history and can create and update contacts, companies, deals and tickets.
- **An agent** such as Claude or Cursor that decides which tool to call.

Connecting each of these to one agent works fine. The trouble starts when a second agent, then a second person, then a second tool arrives.

## Why direct MCP connections get expensive

Every agent that connects directly to an app needs its own connection and its own credentials. Add a teammate and you repeat the whole setup.

![Three agents each connected to three apps with nine crossing lines](figures/without-gateway.svg "Without a gateway, every agent connects to every app. The count grows with agents × apps.")

### Tool definitions fill the context window

An MCP server describes every one of its tools to the model, and those descriptions travel with each request. Anthropic's [advanced tool use post](https://www.anthropic.com/engineering/advanced-tool-use) gives a worked example: a five-server setup (GitHub with 35 tools, Slack with 11, Sentry and Grafana with 5 each, Splunk with 2) came to 58 tools and about 55K tokens before the conversation even started. With a tool search step in front, the model loaded only a search tool and the three to five tools it needed, for about 8.7K tokens, which Anthropic describes as an 85% reduction.

![Two bars: about 55K tokens with all tools loaded up front against about 8.7K tokens with tool search](figures/tool-tokens.svg "Tool definitions loaded before the first message, in Anthropic's published example.")

Tokens are only half of it. Anthropic reported that tool search also lifted accuracy on its MCP evaluations, from 49% to 74% for Opus 4. The [RAG-MCP paper](https://arxiv.org/abs/2505.03275) found the same direction on its own benchmark, with tool selection accuracy rising from 13.62% to 43.13%. Treat these as vendor and research benchmarks, not guarantees: your numbers depend on how many tools you connect. Some clients now do their own tool search, so check what yours does.

### Credentials spread

Each agent, on each laptop, holds its own tokens for Apollo, HubSpot and anything else. When someone leaves, you rotate keys in several places and hope you found them all.

### Credits are spent silently

Enrichment costs money. Apollo's docs say people search does not use credits, while company search and enrichment do, and recommend setting any action that consumes credits to "Approval required". The same applies to any pay-per-use tool: someone has to decide when it is allowed to run.

## How an MCP gateway works

An MCP gateway is a server that sits between your agents and your tools. You connect each app to it once. Every agent then connects to the gateway alone and reaches all of those apps through it.

![Three agents connect to one OrbytLink endpoint, which connects to three apps](figures/with-gateway.svg "With a gateway, agents and apps each connect once. The count grows with agents + apps.")

OrbytLink is built this way. You connect each app once, as an MCP server or as any API with a key or OAuth sign-in. Every agent then uses a single MCP endpoint with one token per agent. Credentials stay in OrbytLink instead of in each agent, and the agent sees only the tools it needs. For a GTM team, that means:

1. Add your data source and CRM to a shared workspace.
2. Invite teammates with the member role. They use the connections without ever seeing the secrets.
3. Point each person's Claude or Cursor at the one OrbytLink endpoint.

## How to cut MCP token and credit costs

Four things in this setup save money, and the first three are worth measuring in your own account.

### 1. Fewer tool tokens on every request

OrbytLink lists app tools directly while a workspace has up to 30 of them. Beyond that, an agent gets a search tool (`orbytlink__find_tools`), a call tool and the few tools it uses most, so only the tools that match the task load their full definitions.

You can estimate your own saving with simple arithmetic. Take Anthropic's example: 55K minus 8.7K is about 46K fewer input tokens per request. If an agent makes 100 requests in a day (an illustrative figure, not a measurement), that is roughly 4.6 million fewer input tokens a day. Multiply by your model's input price per million tokens to get your number. Prompt caching can discount definitions that repeat, but they still take up context and still affect which tool the model picks.

### 2. No wasted enrichment credits

Order the work so that free steps come first and paid steps need your approval. In Apollo, that means people search, a shortlist you review, and only then enrichment.

### 3. Repeat runs without paying for the thinking again

When a prospecting run goes well, OrbytLink can capture it as a [workflow](https://orbytlink.com/workflows.html): a fixed list of tool calls that runs the same way every time, on a schedule or on demand, without a model in the loop for the fixed steps. A workflow can include decision steps, retries, saved state and cached results, and it keeps a step-by-step run log. You pay for the exploration once and then repeat the result. You can also save the instructions as a [skill](https://orbytlink.com/skills.html) that your team shares, so everyone prospects the same way.

### 4. Less time spent on access

Because credentials live in the gateway, removing a teammate or revoking an agent's token cuts its access to every connected app in one step, instead of rotating keys across each person's setup.

## Direct MCP connections vs a DIY proxy vs a gateway

| | Direct connections | DIY proxy | OrbytLink gateway |
| --- | --- | --- | --- |
| New agent or teammate | Add every server again | Point at your proxy | Point at one endpoint |
| Where credentials live | In each agent's config | On your proxy, secured by you | In OrbytLink, never in the agent |
| Tool definitions in context | Every tool of every server | Whatever you build | Search mode above 30 tools, so only matches load |
| Spend control | Settings in each provider | Whatever you build | Approval settings stay in each provider; admins can cap AI model spend |
| Repeating a good run | Prompt it again | Whatever you build | Save it as a workflow |
| Removing a teammate | Rotate keys in each place | Remove at the proxy | Remove the member or revoke the token |
| Cost of the layer | None | Your engineering time and hosting | Free in early access; AI models are billed from prepaid credit |
| Best for | One person, one or two servers | Teams with platform engineers and special requirements | Teams that want it hosted and ready |

A direct connection is the right call when you are the only user and you connect one or two servers. A DIY proxy makes sense if you have special requirements and engineers to run it. A hosted gateway fits the middle: a team that wants shared connections without building the plumbing.

## A prospecting run, step by step

Once connected, you can ask for the job in plain language:

> Find 25 VPs of RevOps at B2B SaaS companies with 50 to 200 employees. Use people search first. Enrich only the ones that match my ICP. Then create them as contacts in HubSpot and tell me how many credits you used.

![Four steps: search people, shortlist, you approve, then enrich and write to the CRM](figures/spend-control.svg "People search is free in Apollo. Approval sits before the step that spends credits.")

The agent calls the people-search tool, which does not use Apollo credits on a paid plan, and shows you a shortlist. It then calls the enrichment tool only on the people you approve, and creates the contacts in the CRM. Keep the CRM as the source of truth: HubSpot recommends setting write tools to "Needs Approval", and that is a good default for any record you did not review.

## Set it up with Claude Code

In Claude Code, adding a remote MCP server is one command. Apollo's own docs show the pattern: `claude mcp add --transport http apollo https://mcp.apollo.io/mcp`. With a gateway you run the same kind of command once, with your OrbytLink endpoint, and you do not add Apollo and HubSpot separately.

```
claude mcp add --transport http orbytlink <your-orbytlink-mcp-url>
```

Copy your endpoint URL from the app; the one above is a placeholder. Claude opens a sign-in when you connect. Clients that cannot sign in use a per-agent token instead.

## FAQ

### What is an MCP gateway?

An MCP gateway is one server that connects your agents to many apps. You connect each app to the gateway once, and every agent reaches them all through a single MCP endpoint.

### Does a gateway make Claude cheaper to run?

It can reduce input tokens by loading fewer tool definitions, and it stops paid tools running without approval. How much you save depends on how many tools you connect, so measure it on your own workload. Anthropic's example shows about 55K tokens falling to about 8.7K for a 58-tool setup.

### Does it work with Claude Code, Cursor and other agents?

Yes. Claude, Cursor or any MCP client can use the single OrbytLink endpoint.

### Is Apollo search free?

People search does not use credits, while company search and enrichment do, according to Apollo's docs. Apollo also says free accounts registered with a personal email cannot use people or company search and enrichment through the connector.

### Where are my credentials stored?

In OrbytLink, on the server. Agents never hold the keys, so a laptop or a shared agent config does not expose them.

### How much does OrbytLink cost?

The gateway is free in early access. AI models used through OrbytLink are billed per token from prepaid credit, at the price listed for each model in the catalog. Failed calls are free, and admins can set a monthly limit. See [pricing](https://orbytlink.com/pricing).
