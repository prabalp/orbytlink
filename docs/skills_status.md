# OrbytLink skills: status and roadmap

As of 2026-11-06.

Skills are ready for a first release: a shared library on the server, per-person access control, and agent tools that respect both. 146 unit tests and 7 end-to-end tests pass locally, and the library handles 50,000 skills with 2–3 ms searches.

None of it is live yet. The work is uncommitted on the development machine, and app.orbytlink.com still runs commit `cbe7ff3`. Paid skills are deliberately deferred.

## How skills work today

- **Where they live:** one SQLite database on the server, the same file as the rest of the app (`.data/orbytlink.sqlite`), so backups and deploys cover it.
  - `library_skills`: one row per skill (name, description, source, licence, owner, visibility, size, uses, blocked).
  - `library_bodies`: the full instructions and reference files, read only when a skill is used.
  - `library_fts`: the FTS5 search index, kept in step by triggers.
  - `skill_access`: who a shared skill is shared with (`user:<email>` or `org:<workspace id>`).
  - Per workspace, only which skills are turned on (`skills` records).
- **The 16 bundled skills** stay in code (`server/skills-data.ts`), not in the library.
- **Visibility:**

  | Setting | Who can see and use it |
  | --- | --- |
  | Only me (`private`) | The author |
  | Shared (`shared`) | The author, the people named by email, everyone in the named organizations |
  | Everyone (`public`) | All users. Skills added from skills.sh are always public. |

- **On vs. not on:**
  - **On:** agents in that workspace see the skill automatically, as a prompt and in the `use_skill` tool description.
  - **Not on:** agents can still load any skill their person can see, on request or after searching.
  - Turning a skill on never overrides who can see it.
- **Agents** use `orbytlink__find_skills`, `orbytlink__use_skill` and `orbytlink__add_skill`.

## Done

| Area | What works | Where |
| --- | --- | --- |
| Bundled skills | 16 skills from anthropics/skills and mattpocock/skills, pinned to a commit | `server/skills-data.ts` |
| Shared library | One store for every skill on the server; full text read only when a skill is used | `server/library.ts` |
| Search | FTS5 full-text search with prefix matching, ranked by relevance then installs; 2–3 ms at 50,000 skills | `librarySearch` |
| skills.sh import | Search skills.sh and add a skill to the library. Checks: listed, 1,000+ installs, open licence, Markdown only (no scripts), pinned commit, at most 400 KB | `addToLibrary` |
| Written skills | Anyone can write or upload a SKILL.md (front matter read), plus Markdown reference files | `POST /api/skills/authored` |
| Access control | Only me, chosen people and organizations, or everyone; enforced on every search, load and agent call, in the same query | `skill_access` |
| Ownership | Only the author edits or deletes a skill they wrote; making it private again revokes access at once | `updateAuthored`, `deleteAuthored` |
| Per-workspace on/off | Admins turn skills on for every agent in a workspace; members without access never receive it | `skills` records |
| Agent tools | `find_skills` (workspace, library, skills.sh), `use_skill` (any visible skill), `add_skill` (any member adds to the library; admins also turn it on), MCP prompts for skills that are on | `server/gateway.ts` |
| Console | Skills page with Your skills / Library views, scope filters (All, Created by me, Shared with me, Public), New skill editor, Edit and Delete for authors, Remove from workspace for admins | `src/library-ui.tsx`, `src/skill-editor.tsx` |
| Moderation | Operator blocks a skill everywhere: hidden from search, cannot be loaded or re-added | `npm run account -- skills block <id>` |
| Migration | Skills added per workspace before the library move into it on startup, still turned on | `migrateWorkspaceSkills` |
| Tests | Access rules (verified by deliberately breaking them), licence refusal, blocking, migration, 50,000-skill speed test | `tests/library.test.ts`, `tests/skill-access.test.ts`, `tests/skill-registry.test.ts` |

## Not done yet (known gaps)

- **Not deployed.** Commit, push to github.com/prabalp, then deploy to the VPS. The tables are created automatically on first start.
- **No review of public skills.** Anyone can make a skill they wrote public; the only control is the operator block command. Decide on a review step or a report button before real users publish.
- **No updates for skills.sh skills.** A skill stays pinned to the commit it was added at. There is no "check for a newer version" or refresh.
- **Sharing by email is unchecked.** A skill can be shared with any email, including ones with no account yet, and nobody is notified.
- **No group sharing inside an organization.** Sharing is with whole organizations or named people, not with teams or roles.
- **No version history.** Editing a written skill overwrites it; there is no undo or history.
- **GitHub rate limits.** Without `GITHUB_TOKEN`, adding skills from skills.sh is limited to about 60 GitHub requests an hour per server, and each skill takes several.
- **No usage analytics** beyond a simple use counter per skill.
- **Not tested at scale on the VPS.** The 50,000-skill benchmark ran locally, not on the production machine.
- **Drive backup not built.** It was agreed that Google Drive should hold backups only, not live skills; the nightly copy to Drive is not built.

## Future roadmap

In suggested order:

1. **Ship what exists:** commit, deploy, set `GITHUB_TOKEN` on the server, and check one real skills.sh import and one shared skill in production.
2. **Moderation for public skills:** a report button, a review queue for skills made public by users, or limit "Everyone" to verified accounts.
3. **Keep skills.sh skills current:** show when a newer version exists and let admins update, keeping the pinned version until they do.
4. **Better sharing:** sharing with teams or roles inside an organization, a notice when something is shared with you, and the option to restrict sharing to existing accounts.
5. **Version history for written skills:** keep earlier versions, show what changed, roll back.
6. **Usage and quality signals:** uses per workspace, last used, and ratings from people in the app.
7. **Nightly backup to Google Drive** of the whole database, as disaster recovery, never in the request path.
8. **Paid skills (deferred).** Two routes when this comes back:
   - Connect an existing marketplace such as Agensi through its MCP server, once its purchase and entitlement API is confirmed. OrbytLink stays the middleware.
   - Or sell skills directly: a "has paid" entry in `skill_access` grants access, with Stripe for payments and payouts. Remember that a skill is plain text handed to the buyer's agent, so it cannot be protected from copying once bought.
9. **Bigger scale (only if needed):** move to Postgres if OrbytLink runs on several servers or the library reaches millions of skills.

## Operator reference

| Task | How |
| --- | --- |
| Block a skill everywhere | `npm run account -- skills block <skill id>` |
| Unblock it | `npm run account -- skills unblock <skill id>` |
| Allow skills.sh skills without an open licence | `LIBRARY_OPEN_LICENSES_ONLY=false` |
| Change the minimum installs for skills.sh imports | `SKILL_MIN_INSTALLS` (default 1000) |
| Raise the GitHub rate limit for imports | `GITHUB_TOKEN` |

| Limit | Value |
| --- | --- |
| Size of one skill (instructions + references) | 400 KB |
| Reference files per written skill | 30 |
| Written skills per person | 500 |
| Search results per page | 30 |
| Typical skill size | about 10 KB; 50,000 skills ≈ 0.5 GB on disk |
