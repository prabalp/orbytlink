# OrbytLink

An MCP/API gateway: users connect apps once (`server/`), and Claude reaches all of them
through one endpoint, `/mcp`, along with enabled skills and workflows. The UI is the React console in `src/`. `v0/` is retired
reference code; don't build on it.

## UI work

Before creating or changing any screen, read `docs/DESIGN.md` and follow it: one
collapsible sidebar whose logo opens it when collapsed, no top bar or footer, a 1152px
content column with 20px gaps, 12/14/16/30px type with the Inter weight mapping, and
8px-radius bordered boxes with compact tables. Reuse the existing components in
`src/main.tsx` and the tokens in `src/design-tokens.css`.

## Checks

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`.
