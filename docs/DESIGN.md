# OrbytLink design system

Every OrbytLink screen follows these rules. They match the v0 product UI (app.orbytlink.com)
and the landing site, so new pages must look like they belong to the same product. When in
doubt, copy an existing page in `src/main.tsx` rather than inventing a new pattern.

Source of truth for values: `src/design-tokens.css` (tokens, fonts) and `src/styles.css`
(components). Never hard-code a colour; use a token.

## 1. Principles

- **Dense, not airy.** Content starts near the top of the page. No decorative hero blocks,
  no marketing panels inside the app, no footers.
- **Monochrome.** Black, white and greys. Colour only carries meaning: green = success,
  red = error/destructive, amber = pending/warning.
- **Strong type.** Headings and labels use bold Inter weights; secondary text is grey, not small.
- **One navigation.** A single sidebar. Never add a second nav layer, a top bar that repeats
  the page title, or tabs that duplicate the sidebar.

## 2. Colour

Dark is the default theme. Light mirrors it.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#000000` | `#ffffff` | Page |
| `--foreground` | `#edf2f5` | `#0d0d0d` | Primary text |
| `--muted-foreground` | `#9f9f9f` | `#626262` | Secondary text, table headers, meta |
| `--sidebar` | `#0e0e10` | `#f7f7f8` | Sidebar background |
| `--secondary` | `#131313` | `#f7f7f8` | Inputs, code blocks, subtle fills |
| `--accent` | `#1b1b1b` | `#f3f3f4` | Hover, active nav item |
| `--active` | `#252525` | `#e4e4e6` | Table row hover, pressed |
| `--border` | white 8% | black 8% | Dividers inside boxes |
| `--input` | white 12% | black 14% | Box outlines, input borders |
| `--primary` | `#ffffff` | `#0d0d0d` | Primary button fill |
| `--destructive` / `--success` / `--warning` | `#ff6568` / `#6ee7b7` / `#fcd34d` | darker variants | Status only |

## 3. Typography

Font: **Inter** (`/fonts`), mono: **Roboto Mono**. All Inter faces use `size-adjust: 94%`.

Weight mapping (the reason the UI looks "bold" like v0, keep it exactly):

| CSS weight | File |
|---|---|
| 400 | Inter-Regular |
| 500 | Inter-SemiBold |
| 600+ | Inter-Bold |

Only three sizes for UI text, the Tailwind scale v0 uses:

| Size | Use |
|---|---|
| **12px** | Meta: `small`, hints under fields, timestamps, tags, status pills, counts |
| **14px** | Everything else: body, table cells and headers, nav, buttons, inputs, descriptions |
| **16px** | Section titles (`h2`, weight 600) |

Plus: page title `h1` 30px / 600 / letter-spacing -0.025em; modal title 18px / 600.
Never use 10, 11, 13 or 15px. Do not shrink text to signal "secondary"; make it grey instead.

## 4. Layout

```
┌──────────┬────────────────────────────────────────────┐
│ Sidebar  │  40px top padding                          │
│ 248px    │  ┌── content column, max 1152px, centred ─┐│
│ (57px    │  │ Title (30px)              [Primary btn] ││
│ collapsed│  │ Subtitle (14px grey, 4px below)         ││
│ )        │  │ ── 20px gap ──                          ││
│          │  │ Toolbar: search (40px)      count       ││
│          │  │ ── 20px gap ──                          ││
│          │  │ Bordered box / table                    ││
│          │  └─────────────────────────────────────────┘│
└──────────┴────────────────────────────────────────────┘
```

- `.workspace-main`: `padding: 40px max(24px, (100% − 1152px) / 2) 32px`, flex column, **gap 20px**.
  Children have no vertical margins of their own; the gap does the spacing.
- Page heading: title + subtitle on the left, the page's single primary action on the right,
  aligned to the bottom (`align-items: flex-end`).
- No top bar on desktop. The top bar exists only ≤768px, to hold the menu button.
- No page footer.

## 5. Sidebar

One collapsible sidebar, never a rail plus a second panel.

- **Expanded (248px):** logo + product name top-left, collapse button (panel icon) top-right;
  nav links with icon + label, matching v0's nav: 36px rows, 0 8px padding, 10px icon gap,
  2px between rows, 8px radius. **Labels are `--foreground`** (never grey) at 14px; icons are
  16px `--muted-foreground`. Hover = `--accent`, active = `--active` (a step stronger).
  Secondary sidebar actions (workspace switch, copy URL, help) are the same quiet rows, not
  bordered buttons. Help link and account button are pinned to the bottom.
- **Collapsed (57px):** icons only, centred, with `title` tooltips. **The logo is the button
  that opens the sidebar** — no separate expand icon.
- The choice persists in `localStorage` (`orbytlink:sidebar`).
- ≤768px: the sidebar is an off-canvas overlay, always shown expanded, with a scrim.

## 6. Components

**Boxes / panels** — `border: 1px solid var(--input)`, radius 8px, transparent background.
Header row: 12px 16px padding, min-height 52px, `h2` on the left, tag/count/control on the
right, bottom border `--border`. Body padding 16px.

**Tables** (inside a box) — 14px text. Header: 48px tall, 0 16px padding, grey, weight 500,
no background fill. Cells: 12px 16px padding, divider `--border` between rows, none after
the last row, row hover `--active`. Primary cell text weight 500; a second line uses `small`
(12px grey) 2px below.

**Buttons** — 40px tall, 0 16px padding, radius 8px, 14px / 500.
`.primary` (white fill in dark), `.secondary` (outline), `.danger` (red text),
`.compact` (30px, 12px text) for in-row actions, `.text-button` for low-emphasis links,
`.icon-button` 32px square. One primary button per view.

**Inputs** — 40px tall, radius 8px, `--input` border. Search fields use `--secondary` fill.
Field label 14px / 500 above, hint 12px grey below, 20px between fields.

**Status** — dot + 12px text: green `good`, red `bad`, amber `pending`, grey otherwise.
**Tags / counts** — 12px grey, `--secondary` fill, 5px radius.

**Empty state** — inside the box that would hold the data: icon, 14px/600 title, one 14px grey
sentence (max 420px), optional primary action. Padding 48px 24px. Never a large illustration.

**Info note** — one-line bordered row with a lock/info icon and 14px grey text, 12px 16px padding.

**Code** — single-line copyable value: `.code-line` (mono 12px, `--secondary` fill, copy button
on the right). Multi-line: `.code-block`.

**Modal** — 560px (840px `.wide`), radius 16px, header 24px padding with title + optional
14px grey subtitle, body `.form-body` 24px, footer actions right-aligned (Cancel secondary,
confirm primary/danger).

**Toast** — bottom-centre, auto-dismiss after 4s.

**Settings** (after v0's settings dialog) — a 230px tab list on the left (40px rows, 12px radius,
grey text; active = `--active` + foreground) and a content column of sections. Each section is
a 12px uppercase grey label above a 12px-radius bordered list of rows: label (14px) with a 12px
grey description on the left, the control (36px input/select, `.compact` button) on the right,
`--border` dividers. Changes apply in place; a name field shows Save only once edited. The
danger section uses a red label and a faint red border. Never a single long form.

## 7. Exception: Connect agents

The Connect agents page is an introduction, not a form, and is the one page without the
standard heading. It opens with a centred block: the MCP mark, a 30px title, one 16px grey
sentence, the MCP URL as a large copyable field (the page's primary action), and one line
about the token. Below it, agent presets are round chips (logo + name) in a centred row;
choosing one opens a single guide card (12px radius, numbered steps, copyable snippets).
Nothing selected means "any MCP client". The column is 820px wide and centred. Tokens sit
at the bottom in a normal box. Don't copy this layout to other pages.

## 8. Writing

- Page subtitle: one sentence on what the page is for.
- Buttons: verb + noun ("Add connection", "Create token", "Revoke token").
- Destructive confirmations say exactly what is lost ("Its encrypted credential is destroyed…").
- Never show secrets after saving; say so in the UI.

## 9. Checklist for a new page

- [ ] Uses the page heading pattern and the 20px-gap column; no top bar, no footer.
- [ ] Only 12 / 14 / 16 / 30px text; headings weight 600.
- [ ] Data lives in an 8px-radius bordered box; tables follow §6.
- [ ] Exactly one primary button; row actions use `.compact` / `.text-button`.
- [ ] Empty state is inside the box and one sentence long.
- [ ] Works collapsed, expanded, and at 420px wide; no horizontal page scroll.
- [ ] Only tokens, no raw colours.
