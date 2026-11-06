---
name: OrbytLink Landing
description: A light lilac workflow instruction sheet for early access.
colors:
  bg: "#fbfbf9"
  text: "#202122"
  text-strong: "#101112"
  text-2: "#505256"
  muted: "#606268"
  tert: "#71747b"
  border: "#dededc"
  border-strong: "#c4c4c2"
  surface: "#eeeef0"
  surface-2: "#e6e6e9"
  hover: "#e2d9f6"
  raised: "#fff"
  card: "#f1f0f3"
  btn-bg: "#222326"
  btn-fg: "#fff"
  btn-hover: "#45404d"
  chip-bg: "#e4dcf6"
  chip-text: "#4f3a75"
  success: "#276849"
  logo-fill: "#222326"
  header-bg: "rgb(251 251 249 / .94)"
  lilac: "#d8c8f1"
  lilac-ink: "#30243e"
  paper: "#f9f7fc"
  f-bg: "#181818"
  f-side: "#1f1f1f"
  f-card: "#272727"
  dark-bg: "#181818"
  dark-text: "#f3f2ef"
  dark-text-strong: "#fff"
  dark-text-2: "#c5c2ca"
  dark-muted: "#b4b0ba"
  dark-tert: "#aaa3b3"
  dark-border: "#313131"
  dark-border-strong: "#555"
  dark-surface: "#272727"
  dark-surface-2: "#313131"
  dark-hover: "#313131"
  dark-raised: "#1f1f1f"
  dark-card: "#272727"
  dark-btn-bg: "#e4d8f6"
  dark-btn-fg: "#25202d"
  dark-btn-hover: "#cbb4ed"
  dark-logo-fill: "#f3f2ef"
  dark-header-bg: "rgb(24 24 24 / .94)"
  focus: "#7d56ac"
typography:
  display:
    fontFamily: "Manrope, sans-serif"
    fontSize: "96px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Manrope, sans-serif"
    fontSize: "48px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Manrope, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Manrope, sans-serif"
    fontSize: "14px"
    lineHeight: "20px"
rounded:
  tab: "6px"
  control: "8px"
  panel: "12px"
  feature: "16px"
spacing:
  step-4: "4px"
  step-8: "8px"
  step-12: "12px"
  step-16: "16px"
  step-24: "24px"
  step-32: "32px"
  step-48: "48px"
  step-64: "64px"
  step-80: "80px"
  step-96: "96px"
components:
  button-primary:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.btn-fg}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.btn-hover}"
  result-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.lilac-ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

# Design System: OrbytLink Landing

## Overview

**Creative North Star: “The workflow instruction sheet.”** Light paper, lilac fields, large asymmetric type, and a concrete task-to-workflow demonstration explain what users keep after an agent finishes a job. The surface mode is **persuade**; the primary action is **Get early access**. This is the implemented direction, not an approved visual comp.

Scope: `landing/index.html`, its final override stylesheet `landing/redesign.css`, and `landing/redesign.js`. Inline base styles and scripts still supply supporting components and existing interactions. This document does not govern the unchanged product console; preserve `docs/DESIGN.md`. The original page is retained at `landing/previous/index.html`.

## Colors

The frontmatter records the implemented light tokens and explicit dark overrides. Lilac is the signature section field; lilac ink and paper keep the workflow illustration and signup readable in either theme. Neutral page chrome follows the saved `ol-theme` preference, defaulting to light. Dark mode retains lilac sections and fixed dark product examples.

Product frames inherit additional fixed colors from `index.html`: text `#FAFAFA`, dim text `#A8A8AD`, faint text `#636366`, lines `#FFFFFF14` / `#FFFFFF22`, and contextual blue, teal, purple, coral, green, red, and yellow status accents. These are illustration colors, not additional marketing accents.

## Typography

Manrope 400/500/600/700 is loaded from Google Fonts, with sans-serif fallback. Technical excerpts retain `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`.

Hero: 96/96px at weight 500, 72/72px at ≤1050px, and **36/40px at ≤700px** (the final CSS rule overrides an earlier 48px declaration). Section headings are 48/48px, reducing to 36/40px; the statement is 60/60px, reducing to 36/40px. Cards use 24/32px, body copy 16/24px, hero lead 20/28px (18/28px on mobile), and labels 12/16px or 14/20px. Headings use balanced wrapping; paragraphs use pretty wrapping.

## Layout

The inherited wrapper resolves to `min(1280px, 100% - 48px)` with 32px internal gutters; at ≤700px it becomes 100% with 24px gutters. Sections use 96px vertical padding (64px mobile). The hero pairs left-aligned oversized type with a right-side action and a full-width lilac demonstration below.

The demo uses `1.1fr 1fr 1fr`; at ≤1050px it becomes two columns and hides the route; at ≤700px request and result stack. The 64px-tall sticky header sits 16px from the top, shifting to 8px on mobile. Navigation collapses at 1050px. Inherited ≤900px rules stack supporting layouts and select one workflow stage; desktop stage selection also follows scroll. Mobile ≤700px rules finish the single-column conversion, four-column integration grid, and stacked signup. The inherited ≤767px compact rules still apply where not overridden.

## Elevation & Depth

Broad tonal fields and flat panels create depth. Major cards, frames, and buttons remove shadows. The sticky header uses a translucent fill, 1px border, and 16px backdrop blur; the mobile menu uses 24px blur. Small inherited technical rows retain inset borders. The primary button lifts 2px on hover and controls depress 1px on activation.

## Shapes

Controls use 8px corners, selected tabs 6px, panels 12px, and the header/work surface 16px. Route nodes are circular. FAQ dividers are 1px lines. Keep the larger fields spacious and reserve dense detail for the dark workflow and Markdown examples.

## Components

- **Navigation:** retained logo, section links, login, theme toggle, early access, and mobile menu. A skip link and 3px focus outline with 4px offset support keyboard navigation.
- **Buttons:** primary uses themed button tokens; secondary uses surface-2. Both use 14/20px semibold type, 8×12px padding, and 40px minimum height. Large actions use 16/24px and 48px minimum height.
- **Task-to-workflow demonstration:** an illustrative reconciliation request, three route steps, and paper result panel. The toggle switches between the first run and the retained workflow, exposes `aria-pressed`, and offers a reversible action.
- **Workflow motion:** Static descriptions of Runs 1, 5, and 20 sit on the left. The right embeds a 15-second HyperFrames composition: tool discovery, focused toolset, and reusable workflow. No sticky positioning, viewport-sized stages, or scroll-linked stage changes. Playback starts when visible, pauses offscreen, and holds its final frame; buttons seek to each chapter, pause, or replay. Reduced-motion preferences show the final state without autoplay. The player adjusts composition typography for narrow screens. Original availability badges and benchmark caption remain removed.
- **Files and trust:** retained Markdown/skill tabs, copy actions, sample download, permissions, approval, fallback, audit, and version examples. Keep technical panels dark in either theme.
- **Integration marks:** existing inline brand paths and rotating task-specific highlights. Existing OrbytLink inline SVG logo and icon sprite remain; no generated raster assets were added.
- **FAQ and signup:** native disclosure rows precede a lilac CTA. The email input uses paper, 8px corners, and 12×16px padding; validation feedback precedes the existing app signup handoff. Login and legal links remain.

Motion uses `cubic-bezier(.22,1,.36,1)`, 300ms color/opacity and 500ms transform transitions. Statement words reveal at 90ms intervals. Reduced-motion disables CSS animation/transitions and the new statement sequence; existing scripted demonstrations also consult reduced-motion preference.

## Do's and Don'ts

- **Do** keep the landing identity scoped to this surface and preserve the original backup.
- **Do** retain theme support, functional controls, visible focus, responsive layouts, and early-access labels.
- **Do** build illustrations from the existing HTML, CSS, inline SVG, and real interactions.
- **Don't** treat illustrative metrics, brand marks, or sample output as verified customer proof.
- **Don't** apply this marketing direction to the product console or replace its design document.

### Internal tool examples

The software section uses three open columns with descriptions above flat product previews, replacing the old nested dark dashboards and crossed-out replacement tags. Previews show a single refund review, a vendor checklist, and a written revenue brief. The center preview uses the existing lilac field; the outer previews use the theme surface. Preview padding is 24px, radius 12px, and desktop minimum height 400px. Below 900px each description sits beside its preview; below 600px they stack at full width with 368px minimum preview height. These are static illustrative artifacts, with no simulated clickable actions.

### Trust and controls

The trust section replaces nested mini dashboards and decorative toggles with a permission register and a lilac recovery note. Explicit text communicates access states; colored dots are secondary. Recovery uses a meaningful three-step sequence and retains its early-access disclosure. Approval, audit, and version history follow as open rows, each pairing an explanation with a concrete example. The main grid is 1.2fr/1fr with 32px gaps and padding; surfaces use 12px radius. Below 760px the register, note and supporting rows stack. Verified at 1440, 1000, 768 and 390 pixels without horizontal overflow or script errors.

User refinement: restored the original three supporting blocks (Approval steps, Audit log, Version history), including their small examples, beneath the redesigned permission and recovery cards. The corrected audit-log wording remains.
