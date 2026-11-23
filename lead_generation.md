---
name: lead-generation
description: Find sales leads through OrbytLink — local businesses, people posting a need on LinkedIn/Reddit/X/Facebook, organizations of a category, or named decision-makers by job title — then enrich, qualify against an ideal customer profile and export them. Use when the user asks to find leads, prospects, contacts, companies or people to sell to.
---

# Lead generation through OrbytLink

You find leads with the apps and APIs connected to OrbytLink. You never send outreach and never
spend credits without the user's approval. Follow these rules exactly; they exist because lead
data costs money and the user must stay in control of what is spent.

## 0. Before anything: see what is connected

1. Call `orbytlink__list_apps` (or `orbytlink__find_tools` with the kind of tool you need, e.g.
   "places search", "web search", "people search", "email finder", "scrape page").
2. Use tools by their exact `app__tool` names as listed. Never guess a tool name.
3. Stored APIs (Catalog → APIs) are called with `orbytlink__api_request`; read their endpoints
   first with `orbytlink__api_docs`.
4. If no connected app can do a step, say which app is needed and call `orbytlink__connect_app`
   to give the user the link. Do not silently switch to a different kind of source.
5. Check whether a `workflow__*` tool already does the task. If so, one call is enough.

Preferred source per job (use the first one that is connected):

| Job | Sources, in order |
|---|---|
| Local businesses (shops, clinics, plumbers…) | Google Maps → Apify (Google Maps scraper Actor) → Yelp-style directory via web search |
| Web search, intent posts, organizations | Exa → Tavily → Firecrawl search → TinyFish → Perplexity → stored Serper API |
| Reading a website for contacts | Firecrawl scrape → Exa/Tavily page fetch → TinyFish fetch → `orbytlink__browse` (last resort: paid per page action) |
| Named people by title/company | Apollo.io → Clay → Prospeo → LeadMagic → Lusha → stored BetterContact API |
| Email for a known person or domain | Hunter → Prospeo → LeadMagic → Apollo → Lusha |
| Company facts (funding, size, industry) | Crunchbase → Crustdata → Clay |
| Saving results | Google Sheets (if connected), otherwise a table in the chat |

## 1. Pick the right surface — and only that one

There are four independent kinds of lead. Decide from the user's words which one they asked for:

| The ideal lead is… | Surface |
|---|---|
| A local, physical business in a place | **A. Local businesses** |
| Someone already posting that they need the thing | **B. Intent posts** |
| An organization of a category (associations, agencies, firms of a type), often nationwide | **C. Organizations** |
| A named person with a job title (CISO, VP Marketing, IT director) | **D. People** |

- Run the surface the user asked for first. If they want more than one, run them **one after
  another**, in the order they asked. Never chain a second surface they didn't ask for.
- A bare "find leads" request runs discovery only: no website visits, no paid lookups, no second
  surface. Show the list, then ask.

## 2. The spending rules (never break these)

- **Discovery is free-first.** Search and list only. Do not reveal emails, enrich, or visit every
  website as part of discovery.
- **After showing a list, ask** whether the user wants enrichment (website contacts, emails,
  phone numbers). Only an explicit yes allows it.
- **Paid lookups default to zero.** Before any paid reveal/enrichment, say which provider, how many
  people/companies at most, and that each hit may cost a credit. Wait for a yes and a number.
- **Hard cap:** never make more than **50** paid lookups in one request, even if asked for more;
  say so and offer to continue in another batch. Count attempts, not hits.
- **Never re-pay.** Before revealing, drop anyone who already has an email in the current list or
  in the user's lead sheet (see §7).
- Never ask for or accept a LinkedIn, X, Facebook or Reddit password. Social accounts are connected
  only through the app's own sign-in in OrbytLink.

## 3. Surface A — local businesses

Inputs: `niche` (e.g. "coffee shops"), `location` (e.g. "Austin, TX"), `max_results` (default 20),
optional `icp`.

1. Search places with the query `"<niche> in <location>"`. Ask for up to `max_results`; page if
   the tool supports a page token, and stop at `max_results`.
2. Keep per business: `business_name`, `category`, `website`, `phone`, `address`, `maps_url`,
   `lat`, `lon`, `rating`, `rating_count`, and any email or social link the listing already shows.
3. Remove duplicates: same website domain, else same `name + address`.
4. If `icp` is given, qualify (§8). Show the table and the count, then ask:
   *"Do you want me to visit these websites for emails and social profiles?"*
5. Google Maps content must not be stored long term: do not write Maps results to a sheet unless
   the user asks, and then keep only what they need.

**Enrichment (only after yes):** for each business with a website (skip those without one),
read the home page, and if it has no email, up to two pages whose link contains `contact`,
`about`, `impressum` or `get-in-touch`. Extract:

- **Emails:** `mailto:` links first, then addresses in the visible text. Drop junk:
  `example.com`, `domain.com`, `yourdomain`, `sentry`, `wixpress.com`, `godaddy.com`,
  `noreply@`/`no-reply@`, image-like strings (`@2x`, `.png`, `.jpg`, `.svg`, `.webp`).
- **Phones:** `tel:` links first, then written numbers with 8–15 digits.
- **Socials:** the first profile link per platform (instagram, facebook, linkedin, x/twitter,
  youtube, tiktok), ignoring share buttons (`/sharer`, `/intent`, `?url=`).
- **Storefront:** note Shopify / WooCommerce / Wix / Squarespace if the page shows it.

Keep the Maps values; enrichment only fills blanks. Unreachable sites stay in the list with a
note, they never stop the run.

## 4. Surface B — intent posts (people asking for the thing)

Inputs: `query` (the need, e.g. "looking for a wedding photographer"), optional `location`,
`max_results` (default 20), optional `sites` (default linkedin, reddit, x, facebook).

1. One web search per site: `<query> <location> site:linkedin.com` (then `site:reddit.com`,
   `site:x.com`, `site:facebook.com`). Up to 10 results each.
2. Keep: `source` (site), `author` if visible, `community` (subreddit/group), `post_title`,
   `post_body` (snippet), `url`, `date`, any email in the snippet.
3. Remove duplicates by URL. Drop results that are profiles, job ads or company pages rather than
   a post expressing the need.
4. If `icp` is given, qualify (§8). Show the list with links. Do not contact anyone.

## 5. Surface C — organizations of a category

Inputs: `category` (e.g. "regional homebuilder associations"), optional `location`,
`max_results` (default 20).

1. Run these searches (location appended when given):
   `<category>`, `list of <category>`, `<category> directory`, `member associations <category>`,
   `<category> association website`.
2. Each result is a candidate: `org_name` (title), `domain` (the result URL's host without
   `www.`), `description` (snippet), `url`.
3. Exclude aggregator domains (they are never the organization):
   wikipedia.org, linkedin.com, facebook.com, twitter.com, x.com, youtube.com, reddit.com,
   indeed.com, glassdoor.com, google.com, bing.com, yelp.com, crunchbase.com, zoominfo.com,
   instagram.com, pinterest.com, quora.com, amazon.com, apple.com, ziprecruiter.com.
4. One row per domain. Qualify if `icp` is given. Show the list.
5. Natural next step (ask first): people at these organizations → Surface D with
   `company_domains` = the `domain` column.

## 6. Surface D — named people

Inputs: `job_titles` (list), `location` (company HQ), `max_results` (default 20), optional
`seniorities`, `headcount_min/max`, `industries`, `technologies`, `company_domains`, `icp`.

1. Search people with the provider's free search. Map filters to the tool's own parameter names
   (read its schema). Companies can only be targeted by **domain**, never by name.
2. **Location format matters:** use full names — "Austin, Texas", "Florida, United States".
   Expand US state abbreviations (TX → Texas) and add ", United States" to a bare state name.
3. If a search returns ~100 and the user wants more, vary seniority, then headcount bands, in
   further rounds (at most 10 rounds); identical filters return identical people.
4. Keep: `full_name`, `title`, `company_name`, `company_domain`, `linkedin_url`, `email` (blank),
   `source_provider`. Remove duplicates by provider id, then LinkedIn URL, then name + company.
5. Qualify against `icp` (§8) **before** offering reveals, so credits go to the best fits first.
6. Show the list, then ask whether to reveal emails and for how many (§2 caps apply). Reveal the
   qualified people first, in batch if the provider supports it. A miss usually costs nothing,
   a hit costs a credit — say so.

**Stored BetterContact API** (if that is the people source): it is asynchronous.
`POST /lead_finder/async` with `{"filters": {"lead_job_title": {"include": [...]},
"lead_location": {"include": ["Austin, Texas"]}, "lead_seniority": {...},
"company_headcount_min": n, "company_headcount_max": n, "company": {"include": [domains]}}}`
returns `request_id`; then `GET /lead_finder/async/<request_id>` every few seconds until
`status` is `terminated` (never judge by the HTTP code: `202` means still running). Leads are in
`leads` (`contact_full_name`, `contact_job_title`, `company_name`, `company_domain`,
`contact_linkedin_profile_url`). Email reveal is a separate, paid request: the same endpoint with
`{"filters": {"lead_linkedin_url": {"include": [urls]}}, "enrich_email_address": true}` — only
after the user approves.

## 7. Remembering leads (so nothing is found or paid for twice)

If Google Sheets is connected and the user wants a running lead list:

1. Keep one sheet per surface (`Businesses`, `Posts`, `Organizations`, `People`) with the columns
   in §9 plus `found_at`.
2. Before showing results, read the sheet's key column and mark each lead `is_new` (true if not
   there). Before any paid reveal, skip people who already have an email in the sheet.
3. Append only new rows. Never overwrite the user's edits.

Without a sheet, de-duplicate within the conversation only, and say so.

## 8. Qualifying against an ideal customer profile (ICP)

You are the judge; there is no separate scoring service.

- For each lead decide `qualified` (true/false), a `score` (0–1) and a one-line `reason` that
  cites evidence from the lead's own data (category, title, snippet, website text).
- When evidence is missing, say `unknown` rather than guessing; keep the lead.
- Rank qualified leads first. Never drop rejected leads silently — show them below, collapsed or
  counted.
- Use the same ICP wording for the whole request so judgments stay consistent.

## 9. Output

Show a compact table (most useful columns first) and the totals: found, new, qualified,
enriched, paid lookups used. Column sets:

- **Businesses:** business_name, category, website, email, phone, address, socials, maps_url,
  is_new, qualified, reason.
- **Posts:** source, post_title, url, author, community, date, is_new, qualified, reason.
- **Organizations:** org_name, domain, description, url, is_new, qualified, reason.
- **People:** full_name, title, company_name, company_domain, linkedin_url, email,
  source_provider, is_new, qualified, reason.

Offer to save to Google Sheets. End with the one next step that makes sense (enrich, reveal
emails, people at these organizations), phrased as a question.

## 10. Make it one call next time

After a lead request the user is likely to repeat (same surface, different niche or place),
offer: *"Save this as a workflow?"* If yes, call `orbytlink__save_workflow` with the tools you
used in order, the user's values as inputs (`niche`, `location`, `job_titles`, `icp`…), and a
judgment for the ICP qualification. Never include paid reveal steps in a saved workflow unless
the user explicitly asks; keep reveals a separate, approved step.

## What you must not do

- Scrape sites that forbid it, or log in to LinkedIn/Facebook/X/Reddit on the user's behalf.
- Invent leads, emails, phone numbers or company facts. Every value comes from a tool result.
- Send emails, messages or connection requests. This skill finds leads; it does not contact them.
- Spend credits beyond what the user approved, or exceed 50 paid lookups in one request.
