// Generated from bundled skills, verified connection presets and workflow templates.
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
      "category": "Research & knowledge"
    },
    {
      "name": "AccuWeather",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Ahrefs",
      "category": "Search & web data"
    },
    {
      "name": "AI judgment",
      "category": "AI & content"
    },
    {
      "name": "AI Visibility / AEO",
      "category": "Search & web data"
    },
    {
      "name": "Airbnb",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Akta",
      "category": "Other APIs"
    },
    {
      "name": "Alpha Vantage",
      "category": "Finance & markets"
    },
    {
      "name": "Amazon",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "API Ninjas",
      "category": "Other APIs"
    },
    {
      "name": "API-Sports",
      "category": "Other APIs"
    },
    {
      "name": "Apify",
      "category": "Search & web data"
    },
    {
      "name": "Apollo",
      "category": "People & companies"
    },
    {
      "name": "Apollo.io",
      "category": "Sales & Leads"
    },
    {
      "name": "Apple App Store",
      "category": "Social & media"
    },
    {
      "name": "Apple Maps",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Apple Music",
      "category": "Social & media"
    },
    {
      "name": "Artificial Analysis",
      "category": "AI & content"
    },
    {
      "name": "Atlassian (Jira & Confluence)",
      "category": "Project management"
    },
    {
      "name": "Bing Keyword Data",
      "category": "Search & web data"
    },
    {
      "name": "Black Forest Labs",
      "category": "AI & content"
    },
    {
      "name": "Bluesky",
      "category": "Social & media"
    },
    {
      "name": "Booking.com",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Bright Data",
      "category": "Search & web data"
    },
    {
      "name": "Browser Use",
      "category": "Search & web data"
    },
    {
      "name": "CarsXE",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Clay",
      "category": "People & companies"
    },
    {
      "name": "Cloro",
      "category": "Search & web data"
    },
    {
      "name": "Cloudflare",
      "category": "Developer tools"
    },
    {
      "name": "Cloudflare Api Key",
      "category": "Jobs & developer tools"
    },
    {
      "name": "CoinGecko",
      "category": "Finance & markets"
    },
    {
      "name": "Company data",
      "category": "People & companies"
    },
    {
      "name": "CompanyEnrich",
      "category": "People & companies"
    },
    {
      "name": "Composio",
      "category": "Platforms"
    },
    {
      "name": "ContactOut",
      "category": "People & companies"
    },
    {
      "name": "Context.dev",
      "category": "Search & web data"
    },
    {
      "name": "Creators & influencers",
      "category": "Advertising & creators"
    },
    {
      "name": "Crunchbase",
      "category": "People & companies"
    },
    {
      "name": "Crustdata",
      "category": "People & companies"
    },
    {
      "name": "Crypto Market Data",
      "category": "Finance & markets"
    },
    {
      "name": "DataForSEO",
      "category": "Search & web data"
    },
    {
      "name": "Deepgram",
      "category": "AI & content"
    },
    {
      "name": "DeepSeek",
      "category": "AI & content"
    },
    {
      "name": "DuckDuckGo SERP",
      "category": "Search & web data"
    },
    {
      "name": "eBay",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "Economic indicators",
      "category": "Finance & markets"
    },
    {
      "name": "ElevenLabs",
      "category": "AI & content"
    },
    {
      "name": "EODHD APIs",
      "category": "Finance & markets"
    },
    {
      "name": "Etsy",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "Exa",
      "category": "Search & web data"
    },
    {
      "name": "Exa Search",
      "category": "Search & web data"
    },
    {
      "name": "Facebook",
      "category": "Social & media"
    },
    {
      "name": "Fal.ai",
      "category": "AI & content"
    },
    {
      "name": "Finnhub",
      "category": "Finance & markets"
    },
    {
      "name": "Firecrawl",
      "category": "Search & web data"
    },
    {
      "name": "Firecrawl Scrape URL",
      "category": "Search & web data"
    },
    {
      "name": "Fish Audio",
      "category": "AI & content"
    },
    {
      "name": "Gemini",
      "category": "AI & content"
    },
    {
      "name": "GitHub",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Glassdoor",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Gmail",
      "category": "Communication"
    },
    {
      "name": "Google Ads",
      "category": "Advertising & creators"
    },
    {
      "name": "Google Analytics (GA4)",
      "category": "Search & web data"
    },
    {
      "name": "Google Business Profile",
      "category": "Search & web data"
    },
    {
      "name": "Google Calendar",
      "category": "Calendar & contacts"
    },
    {
      "name": "Google Chat",
      "category": "Communication"
    },
    {
      "name": "Google Classroom",
      "category": "Education"
    },
    {
      "name": "Google Contacts",
      "category": "Calendar & contacts"
    },
    {
      "name": "Google Docs",
      "category": "Documents & files"
    },
    {
      "name": "Google Drive",
      "category": "Documents & files"
    },
    {
      "name": "Google Keyword Data",
      "category": "Search & web data"
    },
    {
      "name": "Google Maps",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Google Maps Geocoding",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Google Play",
      "category": "Social & media"
    },
    {
      "name": "Google Search Console",
      "category": "Search & web data"
    },
    {
      "name": "Google Sheets",
      "category": "Documents & files"
    },
    {
      "name": "Google Slides",
      "category": "Documents & files"
    },
    {
      "name": "Google Tag Manager",
      "category": "Search & web data"
    },
    {
      "name": "GraphHopper",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Hacker News",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Health & biomedical",
      "category": "Research & knowledge"
    },
    {
      "name": "Higgsfield",
      "category": "AI & content"
    },
    {
      "name": "Home Depot",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "HTML/CSS to Image",
      "category": "AI & content"
    },
    {
      "name": "Hunter",
      "category": "People & companies"
    },
    {
      "name": "Icypeas",
      "category": "People & companies"
    },
    {
      "name": "Ignav Flights",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Image generation",
      "category": "AI & content"
    },
    {
      "name": "IMDb",
      "category": "Social & media"
    },
    {
      "name": "Indeed",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Instagram",
      "category": "Social & media"
    },
    {
      "name": "IPinfo",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Jev",
      "category": "Other APIs"
    },
    {
      "name": "Job Search",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Just One API",
      "category": "Other APIs"
    },
    {
      "name": "Kick",
      "category": "Social & media"
    },
    {
      "name": "Lazada",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "LeadMagic",
      "category": "People & companies"
    },
    {
      "name": "Lemon8",
      "category": "Social & media"
    },
    {
      "name": "LimaData",
      "category": "People & companies"
    },
    {
      "name": "Linear",
      "category": "Project management"
    },
    {
      "name": "Link-in-bio pages",
      "category": "Social & media"
    },
    {
      "name": "LinkedIn",
      "category": "People & companies"
    },
    {
      "name": "Listen Notes",
      "category": "Social & media"
    },
    {
      "name": "Logo.dev",
      "category": "Other APIs"
    },
    {
      "name": "Luma Labs",
      "category": "AI & content"
    },
    {
      "name": "Lusha",
      "category": "People & companies"
    },
    {
      "name": "MagicSlides",
      "category": "AI & content"
    },
    {
      "name": "Marketstack",
      "category": "Finance & markets"
    },
    {
      "name": "Mathpix",
      "category": "AI & content"
    },
    {
      "name": "Medium",
      "category": "Research & knowledge"
    },
    {
      "name": "Memelord",
      "category": "AI & content"
    },
    {
      "name": "Meta Ads",
      "category": "Advertising & creators"
    },
    {
      "name": "Microsoft Advertising",
      "category": "Advertising & creators"
    },
    {
      "name": "MiniMax",
      "category": "AI & content"
    },
    {
      "name": "Mistral AI",
      "category": "AI & content"
    },
    {
      "name": "MrScraper",
      "category": "Search & web data"
    },
    {
      "name": "Music generation",
      "category": "AI & content"
    },
    {
      "name": "Notion",
      "category": "Documents & files"
    },
    {
      "name": "Open web & SEO data",
      "category": "Search & web data"
    },
    {
      "name": "OpenAI",
      "category": "AI & content"
    },
    {
      "name": "OpenAlex",
      "category": "Research & knowledge"
    },
    {
      "name": "OpenRouter",
      "category": "AI & content"
    },
    {
      "name": "OpenWeb Ninja",
      "category": "Search & web data"
    },
    {
      "name": "Other market data",
      "category": "Finance & markets"
    },
    {
      "name": "Package registries",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Parallel",
      "category": "Search & web data"
    },
    {
      "name": "PDF.co",
      "category": "AI & content"
    },
    {
      "name": "People & contact data",
      "category": "People & companies"
    },
    {
      "name": "People Data Labs",
      "category": "People & companies"
    },
    {
      "name": "PhotoRoom",
      "category": "AI & content"
    },
    {
      "name": "Pinterest",
      "category": "Social & media"
    },
    {
      "name": "Pinterest Ads",
      "category": "Advertising & creators"
    },
    {
      "name": "Places (local search)",
      "category": "Maps, travel & weather"
    },
    {
      "name": "PredictLeads",
      "category": "People & companies"
    },
    {
      "name": "Product Hunt",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Prospeo",
      "category": "People & companies"
    },
    {
      "name": "Reddit",
      "category": "Social & media"
    },
    {
      "name": "Remote OK",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Rumble",
      "category": "Social & media"
    },
    {
      "name": "ScrapeCreators",
      "category": "Search & web data"
    },
    {
      "name": "Semrush",
      "category": "Search & web data"
    },
    {
      "name": "SEOptimer",
      "category": "Search & web data"
    },
    {
      "name": "SerpApi",
      "category": "Search & web data"
    },
    {
      "name": "Serper",
      "category": "Search & web data"
    },
    {
      "name": "Shopee",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "Shopify stores",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "Slack",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Snapchat",
      "category": "Social & media"
    },
    {
      "name": "Snapchat Ads",
      "category": "Advertising & creators"
    },
    {
      "name": "Social Media Cross-Platform Search",
      "category": "Social & media"
    },
    {
      "name": "SoundCloud",
      "category": "Social & media"
    },
    {
      "name": "Spotify",
      "category": "Social & media"
    },
    {
      "name": "Stack Overflow",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Steam",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "Stock Market Data",
      "category": "Finance & markets"
    },
    {
      "name": "Strale",
      "category": "Other APIs"
    },
    {
      "name": "Stripe",
      "category": "Payments & finance"
    },
    {
      "name": "Substack",
      "category": "Research & knowledge"
    },
    {
      "name": "Supadata",
      "category": "Search & web data"
    },
    {
      "name": "Surf",
      "category": "Search & web data"
    },
    {
      "name": "Tavily",
      "category": "Search & web data"
    },
    {
      "name": "Telegram",
      "category": "Social & media"
    },
    {
      "name": "Temu",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "The Companies API",
      "category": "People & companies"
    },
    {
      "name": "Threads",
      "category": "Social & media"
    },
    {
      "name": "TikHub",
      "category": "Search & web data"
    },
    {
      "name": "TikTok",
      "category": "Social & media"
    },
    {
      "name": "TikTok Ads",
      "category": "Advertising & creators"
    },
    {
      "name": "TikTok Shop",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "TinyFish",
      "category": "Search & web data"
    },
    {
      "name": "Tomba",
      "category": "People & companies"
    },
    {
      "name": "Tripadvisor",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Trustpilot",
      "category": "Other APIs"
    },
    {
      "name": "Truth Social",
      "category": "Social & media"
    },
    {
      "name": "Twelve Data",
      "category": "Finance & markets"
    },
    {
      "name": "Twitch",
      "category": "Social & media"
    },
    {
      "name": "Twitter",
      "category": "Social & media"
    },
    {
      "name": "Vaquill",
      "category": "Research & knowledge"
    },
    {
      "name": "Video generation",
      "category": "AI & content"
    },
    {
      "name": "Voice generation",
      "category": "AI & content"
    },
    {
      "name": "Walmart",
      "category": "Shopping & marketplaces"
    },
    {
      "name": "We Work Remotely",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Weather",
      "category": "Maps, travel & weather"
    },
    {
      "name": "Web3 Career",
      "category": "Jobs & developer tools"
    },
    {
      "name": "Wikipedia",
      "category": "Research & knowledge"
    },
    {
      "name": "X (Twitter)",
      "category": "Social & media"
    },
    {
      "name": "Yahoo SERP",
      "category": "Search & web data"
    },
    {
      "name": "Yelp",
      "category": "Maps, travel & weather"
    },
    {
      "name": "You.com",
      "category": "Search & web data"
    },
    {
      "name": "YouTube",
      "category": "Social & media"
    },
    {
      "name": "ZeroBounce",
      "category": "People & companies"
    },
    {
      "name": "Zillow",
      "category": "Maps, travel & weather"
    }
  ],
  "workflows": [
    {
      "name": "File an issue and announce it",
      "category": "Workflow templates",
      "description": "Create a Linear issue, then post its title to a Slack channel. The issue is filed even if the announcement fails.",
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
      "description": "Create a page in Notion, then post a note about it in Slack. The page is kept even if the note fails.",
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
      "name": "Draft an email from notes",
      "category": "Workflow templates",
      "description": "Turn rough notes into a Gmail draft, ready to review and send. The wording is a decision: the agent (or an AI model, if you switch it) writes it.",
      "steps": [
        {
          "app": "Decision",
          "label": "Write the email"
        },
        {
          "app": "Gmail",
          "label": "Create a draft"
        }
      ]
    },
    {
      "name": "Summarise open issues for the team",
      "category": "Workflow templates",
      "description": "Read your Linear issues, have them summarised into a short digest, and post it to Slack. Set it to AI and a schedule to run unattended.",
      "steps": [
        {
          "app": "Linear",
          "label": "List issues"
        },
        {
          "app": "Decision",
          "label": "Write the digest"
        },
        {
          "app": "Slack",
          "label": "Send a Slack message"
        }
      ]
    }
  ]
};
