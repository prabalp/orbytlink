---
name: OrbytLink Blog
description: A quiet, text-first reading surface on orbytlink.com for one post a day.
colors:
  bg: "#fff"
  text: "#0d0d0d"
  text-strong: "#000"
  text-2: "#5e5e62"
  muted: "#6e6e73"
  tert: "#a1a1a6"
  border: "#e8e8ea"
  border-strong: "#dadadd"
  hover: "#f4f4f5"
  raised: "#fafafa"
  link: "#0b6bcb"
  btn-bg: "#0d0d0d"
  btn-fg: "#fff"
  dark-bg: "#000"
  dark-text: "#edf2f5"
  dark-text-2: "#9f9f9f"
  dark-muted: "#828282"
  dark-border: "#232323"
  dark-raised: "#0a0a0b"
  dark-link: "#47a8ff"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "48px"
    fontWeight: 500
    lineHeight: "56px"
    letterSpacing: "-1.08px"
  h2:
    fontFamily: "Inter, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: "32px"
    letterSpacing: "-0.3px"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "28px"
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
rounded:
  control: "8px"
  panel: "12px"
spacing:
  step-8: "8px"
  step-16: "16px"
  step-24: "24px"
  step-32: "32px"
  step-48: "48px"
  step-64: "64px"
  step-96: "96px"
---

# Design System: OrbytLink Blog

## Overview

**Creative North Star: “A page you finish.”** The blog serves people who found a post through search or a link and want one clear answer about connecting agents to their tools. It is a reading surface first: one column of text, almost no chrome, nothing that competes with the sentence being read. The surface mode is **inform**; the quiet action at the end of every post is **Get started**.

Scope: `landing/blog/` on orbytlink.com (Cloudflare Pages). It follows the **inner pages** of the marketing site (`landing/about.html`, `pricing.html`): Inter, black/white themes, 1px borders, 8/12px radii. It is deliberately *not* the lilac/Manrope home page (`docs/LANDING-DESIGN.md`) and not the product console (`docs/DESIGN.md`). Don't borrow from either.

## Colors

Neutral only. Light is the default; dark follows the saved `ol-theme` preference like the rest of the site. The single accent is the link blue, used for inline links and nothing else. Body copy is `text-2`; headings, bold and the post title are `text`. No gradients, no tinted cards, no coloured tags. Status colour never appears in the blog.

## Typography

Inter 400/500 only (the same Google Fonts request as the other inner pages). Weight 600+ is not loaded; emphasis uses weight 500 and colour.

| Role | Size / line | Use |
| --- | --- | --- |
| Post title | 48/56, 36/40 under 768px | One `h1` per page |
| Section heading | 24/32 | `h2`, preceded by a 1px rule and 48px gap |
| Subheading | 16/24 weight 500 | `h3`; never go deeper than `h3` |
| Body | 17/28 | Article text, `text-2` |
| Intro | 18/28 | First paragraph only |
| Meta and labels | 14/20 | Date, reading time, breadcrumbs, tags |
| Code | 14/22 `ui-monospace, "SF Mono", Menlo, monospace` | Inline and blocks |

Measure is capped at 704px (about 70 characters). Headings wrap balanced; paragraphs wrap pretty.

## Layout

Same shell as `about.html`: sticky 56px header with logo, Log in and Get started; fixed 1px column guides; footer with the site links plus **Blog** (and RSS). Content wrapper is `min(1200px, 100% - 48px)` with 32px gutters, 16px gutters and `100% - 24px` under 768px.

- **Index (`/blog/`)**: breadcrumb, `h1` “Blog”, one line of purpose, then a single list of posts, newest first. Each row is title (18/28, weight 500), one-sentence summary (`text-2`), and a meta line (date · reading time). Rows are separated by 1px borders and have no card, image or thumbnail. 20 posts per page, then “Older posts” links to `/blog/page/2/`. Tag pages reuse this list.
- **Post (`/blog/<slug>/`)**: breadcrumb (Home / Blog), title, meta line, then the 220px sticky table of contents beside the 704px article (as in `about.html`). The table of contents is built from `h2`s and is omitted on posts with fewer than three. Under 900px it stacks above the article.
- **Post end**: a 12px-radius `raised` note with a one-line pitch and the Get started button, followed by up to three related posts as plain rows. No newsletter form, comments, share buttons or author cards.

## Elevation & Depth

Flat. Borders are inset 1px box-shadows or real 1px borders; there are no drop shadows. The header uses the existing translucent fill and 12px backdrop blur.

## Shapes

Controls 8px, notes, code blocks and tables 12px/8px as on the inner pages. Images are 12px-radius with a 1px border. No circles, no pills.

## Components

- **Breadcrumb**: 14px `muted`, links darken on hover.
- **Post row**: as above; the whole row is one link, title underlines on hover, focus shows the 2px outline.
- **Callout (`.note`)**: 16×20 padding, 12px radius, `raised` background, 14/22 text. For “Heads up” and “Related” asides, at most one per post.
- **Code block**: `raised` background, 1px border, 12px radius, 16px padding, horizontal scroll, no syntax-colour theme beyond `text` and `muted`. Include a copy button only on blocks of three or more lines.
- **Table**: the inner-page table (14/20, `raised` header, 1px row borders) inside a scrolling wrapper.
- **Images and diagrams**: optional, one per post at most before the first `h2`. Prefer inline SVG that uses theme tokens. Every image has alt text, explicit width/height, and loads lazily unless it is the first. No stock photography, no generated hero art, no screenshots with real customer data.
- **Buttons**: the existing `.btn` (32px high, 14/20 weight 500, `btn-bg`).

Motion is limited to the 300ms colour transitions already used on the site. No scroll effects, reveal animations or autoplay media.

## Content model

Posts live in the repo as Markdown with front matter, one file per post: `landing/blog-src/YYYY-MM-DD-slug.md`.

```markdown
---
title: How one /mcp endpoint replaces a pile of server configs
slug: one-mcp-endpoint
date: 2026-11-24
updated: 2026-11-24        # optional; shown when different from date
summary: One sentence, under 160 characters, used on the index and as the meta description.
tags: [mcp, gateway]       # 1 to 3, lower-case
draft: false               # drafts are built locally but never emitted or listed
---

Intro paragraph (rendered as the 18px intro).

## Section heading
...
```

Rules:

- `slug` is permanent. Renaming a post needs a redirect in `landing/_redirects`.
- Posts dated in the future are not emitted, so a batch can be queued and one goes live per day when the site is rebuilt.
- Markdown subset: `h2`/`h3`, paragraphs, lists, bold, inline code, fenced code, tables, blockquote (rendered as a callout), links, images. No raw HTML.
- One author voice: “we” (Orbytlabs). No bylines.

## Build and publishing

A single script, `scripts/build-blog.mjs` (no framework, no client JS), reads `landing/blog-src/`, and writes static files into `landing/blog/`. Generated output is committed so Cloudflare Pages needs no build step. Per run it must:

1. Render each non-draft post whose date is today or earlier to `landing/blog/<slug>/index.html` using the shared shell above, with theme script, tokens and footer identical to `about.html`.
2. Render the index, paginated index and tag pages.
3. Write `landing/blog/rss.xml` (latest 20, full text) and add `<link rel="alternate" type="application/rss+xml">` to the index and every post.
4. Append every post and the index to `landing/sitemap.xml` with `lastmod` set to `updated` or `date`, and keep the existing non-blog entries untouched.
5. Add the blog's post list to `landing/llms.txt` under a “Blog” heading (title, URL, one-line summary).
6. Fail the build on: missing front-matter field, duplicate slug, summary over 160 characters, image without alt text, broken internal link, or more than one `h1`.

Daily routine: write the file, run `node scripts/build-blog.mjs`, check the post at 390px and 1440px in light and dark, commit and push to `github.com/prabalp` (never the other account), then let Cloudflare Pages deploy. Commit as the identity in the project's git rules.

## SEO and sharing

- `<title>`: `Post title · OrbytLink Blog`; `description` is the summary; `canonical` is the absolute `https://orbytlink.com/blog/<slug>/` URL.
- Open Graph and Twitter tags as on `about.html`, with `og:type` set to `article` and `article:published_time`. Use `og-image.png` until per-post images exist; don't generate one per post.
- JSON-LD `BlogPosting` (headline, datePublished, dateModified, author and publisher Orbytlabs) on posts and `Blog` on the index.
- One `h1`, a logical `h2`/`h3` order, descriptive link text, and trailing-slash URLs everywhere.

## Writing guidance

- Lead with the answer or the problem in the first two sentences. Titles say what the reader will learn, in plain words, under 70 characters.
- 600 to 1,200 words. One idea per post; link to earlier posts instead of repeating them.
- Only claim what the product does today. Describe planned features as planned, and label illustrative numbers as illustrative, as in the landing rules. No invented customer stories or benchmarks.
- Prefer concrete examples: the actual tool call, config or workflow, not an abstraction of it.
- Avoid em dashes, filler openers (“In today's fast-paced world”) and closing summaries that repeat the post.

## Do's and Don'ts

- **Do** reuse the inner-page shell, tokens and footer so the blog feels like the rest of orbytlink.com.
- **Do** keep every post readable with JavaScript off, at 390px, and in both themes.
- **Do** keep the page weight small: no webfont beyond Inter 400/500, no third-party scripts or analytics embeds.
- **Don't** add pop-ups, cookie-style banners, sticky CTAs, share bars or related-post carousels.
- **Don't** use the home page's lilac fields, Manrope, or oversized display type here.
- **Don't** edit generated files in `landing/blog/` by hand; change the source or the script and rebuild.
- **Don't** touch `docs/DESIGN.md` (console) or `docs/LANDING-DESIGN.md` (home page) when changing the blog.
