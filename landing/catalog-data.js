// Generated from bundled skills, verified connection presets, workflow templates and docs/pay-per-call-tools.csv.
window.orbytCatalog = {
  "skills": [
    {
      "name": "Internal comms",
      "category": "Communication",
      "description": "A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).",
      "source": "anthropics/skills",
      "url": "https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/internal-comms"
    },
    {
      "name": "Frontend design",
      "category": "Design",
      "description": "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.",
      "source": "anthropics/skills",
      "url": "https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design"
    },
    {
      "name": "Discernment check",
      "category": "Thinking",
      "description": "After you give a substantive answer or draft that the user may act on — advice or recommendations, drafted artifacts such as goals, plans, pitches, proposals, or emails, estimates or projections, analysis or interpretation of data, factual claims they may rely on, or a multi-step argument — invoke this skill BEFORE finalizing your reply and then, if it applies, append 2-3 short follow-up questions, each tied to something specific in what you just produced, that help the user check key facts, probe the reasoning or assumptions, and notice missing context. Do this at most once per conversation. Skip it when the user asked a trivial how-to or simple lookup, wants a purely educational explanation, asked you only to format, convert, or assemble a file from content they provided, is writing code they will run, is doing creative writing or casual chat, or already asked you to double-check, cite, or review — the skill file explains these boundaries and the exact output format.",
      "source": "anthropics/skills",
      "url": "https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/discernment-nudge"
    },
    {
      "name": "Grilling",
      "category": "Thinking",
      "description": "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/productivity/grilling"
    },
    {
      "name": "Handoff",
      "category": "Planning",
      "description": "Compact the current conversation into a handoff document for another agent to pick up.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/productivity/handoff"
    },
    {
      "name": "Teach",
      "category": "Writing & learning",
      "description": "Teach the user a new skill or concept, within this workspace.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/productivity/teach"
    },
    {
      "name": "Writing for agents",
      "category": "Writing & learning",
      "description": "Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/productivity/writing-for-agents"
    },
    {
      "name": "Spec from conversation",
      "category": "Planning",
      "description": "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/to-spec"
    },
    {
      "name": "Tickets from a plan",
      "category": "Planning",
      "description": "Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/to-tickets"
    },
    {
      "name": "Issue triage",
      "category": "Engineering",
      "description": "Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/triage"
    },
    {
      "name": "Test-driven development",
      "category": "Engineering",
      "description": "Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions \"red-green-refactor\", or wants integration tests.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/tdd"
    },
    {
      "name": "Code review",
      "category": "Engineering",
      "description": "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \\\"review since X\\\".",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/code-review"
    },
    {
      "name": "Domain modeling",
      "category": "Engineering",
      "description": "Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a GLOSSARY.md, or recording or editing an ADR.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/domain-modeling"
    },
    {
      "name": "Architecture review",
      "category": "Engineering",
      "description": "Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/improve-codebase-architecture"
    },
    {
      "name": "Codebase design",
      "category": "Engineering",
      "description": "Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/codebase-design"
    },
    {
      "name": "Prototype",
      "category": "Engineering",
      "description": "Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.",
      "source": "mattpocock/skills",
      "url": "https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/prototype"
    }
  ],
  "tools": [
    {
      "name": "Academic literature",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "AccuWeather",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Ahrefs",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "AI judgment",
      "category": "AI & content",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "AI Visibility / AEO",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Airbnb",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Akta",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Alpha Vantage",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Amazon",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "6 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "API Ninjas",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "API-Sports",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Apify",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Apollo",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Apollo.io",
      "category": "Sales & Leads",
      "sources": []
    },
    {
      "name": "Apple App Store",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Apple Maps",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Apple Music",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Artificial Analysis",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Atlassian (Jira & Confluence)",
      "category": "Project management",
      "sources": []
    },
    {
      "name": "Bing Keyword Data",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Black Forest Labs",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Bluesky",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Booking.com",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Bright Data",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Browser Use",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "CarsXE",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Clay",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Cloro",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Cloudflare",
      "category": "Developer tools",
      "sources": []
    },
    {
      "name": "Cloudflare Api Key",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "CoinGecko",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Company data",
      "category": "People & companies",
      "sources": [
        {
          "name": "treg.to",
          "notes": "47 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "CompanyEnrich",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Composio",
      "category": "Platforms",
      "sources": []
    },
    {
      "name": "ContactOut",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Context.dev",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Creators & influencers",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Crunchbase",
      "category": "People & companies",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Crustdata",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Crypto Market Data",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "treg.to",
          "notes": "4 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "DataForSEO",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Deepgram",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "DeepSeek",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "DuckDuckGo SERP",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "eBay",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Economic indicators",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "ElevenLabs",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "EODHD APIs",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Etsy",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Exa",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Exa Search",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Facebook",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "7 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "5 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Fal.ai",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Finnhub",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Firecrawl",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Firecrawl Scrape URL",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Fish Audio",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Gemini",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "GitHub",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Glassdoor",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Gmail",
      "category": "Communication",
      "sources": []
    },
    {
      "name": "Google Ads",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Google Analytics (GA4)",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Google Business Profile",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Google Calendar",
      "category": "Calendar & contacts",
      "sources": []
    },
    {
      "name": "Google Chat",
      "category": "Communication",
      "sources": []
    },
    {
      "name": "Google Classroom",
      "category": "Education",
      "sources": []
    },
    {
      "name": "Google Contacts",
      "category": "Calendar & contacts",
      "sources": []
    },
    {
      "name": "Google Docs",
      "category": "Documents & files",
      "sources": []
    },
    {
      "name": "Google Drive",
      "category": "Documents & files",
      "sources": []
    },
    {
      "name": "Google Keyword Data",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "16 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Google Maps",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Google Maps Geocoding",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Google Play",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Google Search Console",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Google Sheets",
      "category": "Documents & files",
      "sources": []
    },
    {
      "name": "Google Slides",
      "category": "Documents & files",
      "sources": []
    },
    {
      "name": "Google Tag Manager",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "GraphHopper",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Hacker News",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Health & biomedical",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Higgsfield",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Home Depot",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "HTML/CSS to Image",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Hunter",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Icypeas",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Ignav Flights",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Image generation",
      "category": "AI & content",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "IMDb",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "22 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Indeed",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Instagram",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "8 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "7 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "IPinfo",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Jev",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Job Search",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Just One API",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "Supported by Instant; price not captured, see composio.dev/pricing"
        }
      ]
    },
    {
      "name": "Kick",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Lazada",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "LeadMagic",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Lemon8",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "LimaData",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "16 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Linear",
      "category": "Project management",
      "sources": []
    },
    {
      "name": "Link-in-bio pages",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "LinkedIn",
      "category": "People & companies",
      "sources": [
        {
          "name": "treg.to",
          "notes": "18 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Listen Notes",
      "category": "Social & media",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "24 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Logo.dev",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Luma Labs",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Lusha",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "4 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "MagicSlides",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Marketstack",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "22 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Mathpix",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Medium",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Memelord",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "20 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Meta Ads",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "8 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Microsoft Advertising",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "MiniMax",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Mistral AI",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "MrScraper",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Music generation",
      "category": "AI & content",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Notion",
      "category": "Documents & files",
      "sources": []
    },
    {
      "name": "Open web & SEO data",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "34 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "OpenAI",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "OpenAlex",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "5 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "OpenRouter",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "OpenWeb Ninja",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "40 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Other market data",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Package registries",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Parallel",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "PDF.co",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "40 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "People & contact data",
      "category": "People & companies",
      "sources": [
        {
          "name": "treg.to",
          "notes": "50 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "People Data Labs",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "26 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "PhotoRoom",
      "category": "AI & content",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Pinterest",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Pinterest Ads",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Places (local search)",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "PredictLeads",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "7 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Product Hunt",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Prospeo",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "8 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Reddit",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "6 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Remote OK",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Rumble",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "ScrapeCreators",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "60+ tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Semrush",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "12 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "SEOptimer",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "SerpApi",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "50+ tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Serper",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "10 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Shopee",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "9 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Shopify stores",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Slack",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Snapchat",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Snapchat Ads",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum; no price listed"
        }
      ]
    },
    {
      "name": "Social Media Cross-Platform Search",
      "category": "Social & media",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "SoundCloud",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Spotify",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Stack Overflow",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Steam",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Stock Market Data",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "treg.to",
          "notes": "10 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Strale",
      "category": "Other APIs",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Stripe",
      "category": "Payments & finance",
      "sources": []
    },
    {
      "name": "Substack",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Supadata",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "10 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Surf",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "100+ tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Tavily",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Telegram",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Temu",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "The Companies API",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "6 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Threads",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "4 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "TikHub",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "~282 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "TikTok",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "7 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "8 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "TikTok Ads",
      "category": "Advertising & creators",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "TikTok Shop",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "7 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "TinyFish",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "2 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Tomba",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "15 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Tripadvisor",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "4 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Trustpilot",
      "category": "Other APIs",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Truth Social",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Twelve Data",
      "category": "Finance & markets",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "71 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Twitch",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Twitter",
      "category": "Social & media",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "3 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Vaquill",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "22 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Video generation",
      "category": "AI & content",
      "sources": [
        {
          "name": "treg.to",
          "notes": "5 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Voice generation",
      "category": "AI & content",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Walmart",
      "category": "Shopping & marketplaces",
      "sources": [
        {
          "name": "treg.to",
          "notes": "3 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "We Work Remotely",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Weather",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Web3 Career",
      "category": "Jobs & developer tools",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Wikipedia",
      "category": "Research & knowledge",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "X (Twitter)",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "7 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Yahoo SERP",
      "category": "Search & web data",
      "sources": [
        {
          "name": "treg.to",
          "notes": "2 provider(s); price is the 'from' minimum"
        }
      ]
    },
    {
      "name": "Yelp",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "4 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "10 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "You.com",
      "category": "Search & web data",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "1 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "YouTube",
      "category": "Social & media",
      "sources": [
        {
          "name": "treg.to",
          "notes": "9 provider(s); price is the 'from' minimum"
        },
        {
          "name": "Composio Instant Tools",
          "notes": "7 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "ZeroBounce",
      "category": "People & companies",
      "sources": [
        {
          "name": "Composio Instant Tools",
          "notes": "6 tools; 0% markup on provider cost; each call also uses one Composio tool call"
        }
      ]
    },
    {
      "name": "Zillow",
      "category": "Maps, travel & weather",
      "sources": [
        {
          "name": "treg.to",
          "notes": "1 provider(s); price is the 'from' minimum"
        }
      ]
    }
  ],
  "workflows": [
    {
      "name": "File an issue and announce it",
      "category": "Workflow templates",
      "description": "Create a Linear issue, then post its title to a Slack channel.",
      "steps": [
        {
          "app": "Linear",
          "label": "Create a Linear issue"
        },
        {
          "app": "Slack",
          "label": "Send a Slack message"
        }
      ]
    },
    {
      "name": "Post an update and log it",
      "category": "Workflow templates",
      "description": "Share an update in Slack and append it as a row in a Google Sheet.",
      "steps": [
        {
          "app": "Slack",
          "label": "Send a Slack message"
        },
        {
          "app": "Google Sheets",
          "label": "Append a row"
        }
      ]
    },
    {
      "name": "Write a Notion page and share it",
      "category": "Workflow templates",
      "description": "Create a page in Notion, then post a note about it in Slack.",
      "steps": [
        {
          "app": "Notion",
          "label": "Create a Notion page"
        },
        {
          "app": "Slack",
          "label": "Send a Slack message"
        }
      ]
    },
    {
      "name": "Draft an email",
      "category": "Workflow templates",
      "description": "Prepare a Gmail draft from a subject and body, ready to review and send.",
      "steps": [
        {
          "app": "Gmail",
          "label": "Create a draft"
        }
      ]
    }
  ]
};
