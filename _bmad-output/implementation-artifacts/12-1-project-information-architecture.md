# Story 12.1: Project Information Architecture

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- Ad-hoc, audit-driven story with no epics.md entry — epic-12 was registered directly from
     docs/usability-audit-2026-07-13.md (own live-browser navigation + independent UX-expert and
     accessibility-expert subagent reviews + product-owner findings), same precedent as epics 6-5,
     1-14, 1-15, 11. This story is a split of the original bundled story
     `12-1-usability-and-navigation-fixes` (now removed) — it carries AC group A only (the project
     information-architecture rework). The sibling split, `12-2-usability-trust-accessibility-fixes`,
     covers everything else from the audit (first-run dashboard staleness, onboarding escape hatch,
     sealed-vault explanation, accessibility fixes, naming/content consistency) and is fully
     independent of this story — a developer can implement either split without reading the other. -->

## Story

As an org owner, admin, or member managing a project in Project Vault,
I want a real project overview page with a persistent sub-nav across every project screen,
so that "Credentials" stops acting as a de facto project hub and I always have a way back to the
project's home without relying on the browser's back button.

## Background (read this before starting — do not skip)

Project Vault has no dedicated project overview page today. `apps/web/src/routes/(app)/projects/[projectId]/`
has sub-route folders for `credentials`, `certificates`, `domains`, `machine-users`, `members`,
`service-endpoints`, `services`, and `status-page` — **but no `+page.svelte` at the `[projectId]`
segment itself**. Visiting `/projects/:id` directly today falls through to a 404 (see
`12-2-usability-trust-accessibility-fixes` AC-D4 for the bare-404-page fix; that AC is about the
404 page's shell, not about this route existing — this story is what makes `/projects/:id` resolve
to something meaningful in the first place).

Confirmed via direct source read (2026-07-13, this worktree):

- `apps/web/src/routes/(app)/projects/+page.svelte` line 273: the project list's link target is
  `` href={resolve(`/projects/${project.id}/credentials`)} `` — the project card/name links straight
  to Credentials, never to a project overview.
- `apps/web/src/routes/(app)/dashboard/+page.svelte` lines 64, 132, 171, 208, 220, 227: every
  project-scoped link on the dashboard points at `/projects/${id}/credentials/...` — same pattern,
  no overview link exists anywhere in the app today.
- `apps/web/src/lib/components/shell/PrimaryNav.svelte` (top-level app nav, rendered by
  `AppShell.svelte`) has no concept of a secondary/contextual nav — it is a single flat list
  (`nav-model.ts`: Dashboard, Projects, Credentials, Alerts, Health, Settings [, Platform Admin]).
  There is no existing "sub-nav" or "tab bar" component anywhere in
  `apps/web/src/lib/components/` to extend — this story introduces the pattern from scratch.
- Each project sub-page (`certificates`, `domains`, `machine-users`, `members`, `service-endpoints`,
  `services`, `status-page`, `credentials`) is reachable only via links planted inside the
  Credentials page today (per the audit's finding P2/P3) — the routes themselves already exist as
  standalone SvelteKit routes, so this is **primarily a navigation/IA change, not a rebuild of those
  pages' content**.

Full rationale, severity ranking, and the UX expert's concrete IA recommendation live in
`docs/usability-audit-2026-07-13.md` section 2 ("Recommended information architecture (UX expert,
addressing P1–P3)"). This story implements that recommendation's four steps almost verbatim:
(1) real project home at `/projects/:id`, (2) demote Credentials to a sibling route, (3) persistent
sub-nav across every project screen, (4) dashboard/list cards link to the overview page.

**This story does not need `docs/usability-audit-2026-07-13.md` or the sibling
`12-2-usability-trust-accessibility-fixes` story to be understood or implemented — everything
required is in this file.**

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A (AC-2 defines the honest-placeholder rule for summary tiles when a sub-area has zero data) |
| **Persona journey** | See below |

### Persona journey stub

Morgan-member logs in and lands on `/dashboard`. Morgan clicks a project's name on the dashboard's
project list — instead of jumping straight into that project's Credentials list, Morgan lands on
`/projects/:id`, a project overview page showing the project's name, description/tags, owner, and
a small at-a-glance summary (member count; services/certs expiring soon; endpoint/status-page
health). Under the project name, a row of tabs — Overview, Credentials, Members, Machine Users,
Services, Certificates, Domains, Endpoints, Status Page — is visible, with "Overview" shown as the
active tab. Morgan clicks "Credentials" and lands on `/projects/:id/credentials`; the same tab row
is still there, now with "Credentials" active. Morgan then clicks "Members" from that same tab row
(not by navigating back) and lands on the members page, tab row still present, "Members" active.
At every point, clicking "Overview" (or the project name in a breadcrumb/header, if present) returns
Morgan to `/projects/:id` — Morgan never needs the browser back button to get back to the project's
home. Riley-viewer (read-only role) sees the identical tab row and overview page with no
edit-affordance differences (this story does not change per-tab authorization — see AC-9).

## Acceptance Criteria

### Route and page: project overview (`/projects/:id`)

1. **Overview route exists and renders real data (happy path).** `GET /projects/:id` (an existing,
   valid project the signed-in user's org owns) renders `apps/web/src/routes/(app)/projects/[projectId]/+page.svelte`
   showing: the project's name (as the page's `<h1>`), description/tags (if set), and ownership
   info (created-by / org). Example: an org owner navigates to `/projects/a1b2c3d4-.../` for a
   project named "Payments API" with description "Stripe + billing webhooks" — the page shows
   `<h1>Payments API</h1>` and the description text, not a redirect to `/projects/:id/credentials`
   and not a 404.
2. **At-a-glance summary tiles, real data or honest placeholder.** The overview page shows three
   summary tiles: member count, services/certs expiring soon (next 30 days), and endpoint/status-page
   health. Each tile queries real backing data via the existing project-scoped API endpoints (do not
   hardcode `0` — this is a G3 product-surface-contract requirement). Positive example: a project
   with 4 members and 2 certificates expiring within 30 days shows "4 members" and "2 expiring soon".
   Edge case: a brand-new project with zero members beyond the creator and zero
   certs/services/endpoints configured shows an explicit empty state per tile (e.g. "1 member" and
   "Nothing expiring soon" / "No services configured yet"), never a blank tile or a fabricated
   non-zero number.
3. **Nonexistent or foreign-org project ID.** `GET /projects/:id` for a `:id` that does not exist,
   or that exists but belongs to a different org than the signed-in user's, renders the same 404
   behavior the app already uses for other unmapped/forbidden project-scoped routes today (verify
   the existing pattern in `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.server.ts`
   or equivalent — do not invent a new one). It must **not** leak the target project's name,
   description, or summary data before the 404/403 check completes.
4. **Malformed project ID.** `GET /projects/not-a-uuid` renders the same 400/404 behavior the
   existing sub-routes (e.g. `/projects/not-a-uuid/credentials`) already produce for a malformed ID
   — do not add new validation logic that diverges from the established pattern; reuse whatever the
   credentials route currently does for the same malformed input.
5. **Archived project.** Visiting the overview page for an archived project (see the existing
   archival feature at `apps/api/src/modules/projects/projects-archival.routes.test.ts`) shows the
   project's data with a visible "Archived" indicator on the overview page and sub-nav, consistent
   with however archived state is already surfaced elsewhere in the app (check the projects list
   page for its existing archived-badge treatment and reuse it) — it must not silently render as if
   the project were active.

### Route change: Credentials becomes a sibling, not the landing page

6. **Credentials route unchanged in path, changed in framing.** `/projects/:id/credentials`
   continues to resolve to the existing credentials list page (no URL change required by this
   story — the audit's recommendation explicitly allows the URL to stay the same). The page now
   renders under the persistent sub-nav (AC-7) with "Credentials" as one tab among equals, not as
   the implicit project home. No existing credentials functionality (list, create, rotate, import)
   changes behavior.
7. **No orphaned internal links to a "credentials-as-home" mental model.** Every internal link that
   previously pointed at `/projects/:id/credentials` *as if* it were the project's landing page
   (the dashboard links enumerated in Background, and the projects-list card link at
   `apps/web/src/routes/(app)/projects/+page.svelte:273`) is updated per AC-11/AC-12 to point at
   `/projects/:id` instead, except where a direct-to-credentials shortcut is intentionally kept (e.g.
   a "View credentials" quick-action button is fine to keep pointing at `/projects/:id/credentials`
   directly, per the UX recommendation's step 4 — but the *primary* project name/card link must go
   to the overview).

### Persistent project sub-nav

8. **Sub-nav renders identically across every project screen.** A tab bar (or sub-sidebar) fixed
   under the project header shows: Overview, Credentials, Members, Machine Users, Services,
   Certificates, Domains, Endpoints, Status Page — and appears, in the same order with the same
   labels, on `/projects/:id`, `/projects/:id/credentials`, `/projects/:id/members`,
   `/projects/:id/machine-users`, `/projects/:id/services`, `/projects/:id/certificates`,
   `/projects/:id/domains`, `/projects/:id/service-endpoints`, and `/projects/:id/status-page`.
   Positive example: navigating from Overview to Certificates via the tab, the tab bar does not
   flicker, reorder, or disappear — only the active-tab indicator moves.
9. **Active tab reflects current route and role-appropriate tabs only.** The tab matching the
   current route has `aria-current="page"` (same convention as the existing top-level
   `PrimaryNav.svelte` — see `nav-model.ts`'s `isActiveNavItem`, reuse or mirror that function
   rather than reinventing route-matching logic). If a tab's destination is role-gated (e.g. Members
   management may already be owner/admin-only at the API level — check
   `apps/api/src/modules/projects/member-management.routes.test.ts` for the existing authz rule
   before assuming), the tab is either hidden or shown-but-disabled with an explanatory tooltip for
   a viewer role — it must never link a viewer into a 403 page with no explanation. Example: a
   viewer role project member sees the same tab set but a disabled/greyed "Members" tab (or the tab
   is fully hidden, per whichever existing convention `PrimaryNav`/role-gating in this codebase
   already uses) rather than a working link that then 403s.
10. **Sub-nav does not appear outside the `/projects/:id/**` tree.** The dashboard, top-level
    projects list (`/projects`), settings, health, notifications, and platform-admin screens render
    unchanged — no stray project sub-nav leaks onto non-project-scoped pages. Verify by checking
    `/dashboard` and `/projects` render identically to their current snapshot/DOM structure aside
    from the link-target change in AC-11/AC-12.
11. **Sub-nav works with zero JavaScript / on first paint (progressive enhancement).** Since this is
    a SvelteKit app, the sub-nav must be server-rendered as real `<a>` tags with `resolve(...)` hrefs
    (matching the existing `PrimaryNav.svelte` pattern), not JS-only click handlers — a user with
    JS disabled or on a slow connection can still navigate the full tab set before hydration
    completes.

### Dashboard / project-list linking

12. **Project list card links to the overview.** On `/projects`, clicking the project's name (or the
    whole card, per the audit's P1 finding) navigates to `/projects/:id`, not
    `/projects/:id/credentials`. Positive example: clicking "Payments API" on the projects list
    lands on that project's overview page showing summary tiles. If a separate explicit
    "Manage"/"View credentials" affordance is kept on the card (optional, per UX recommendation
    step 4), it must be a visually distinct secondary action, not the same link duplicated.
13. **Dashboard's project references link to the overview where the link represents "go to this
    project"**, not a specific credential/action. Example: if the dashboard shows a "your projects"
    list/summary widget (distinct from the specific-credential deep links at
    `apps/web/src/routes/(app)/dashboard/+page.svelte` lines 64/132/171, which correctly stay
    pointed at the specific credential/rotation they represent and must NOT be changed by this
    story), that widget's project-level link points at `/projects/:id`. Deep links to a specific
    credential, rotation event, or "create credential"/"add endpoint" quick action correctly remain
    pointed at their specific sub-page/action and are out of scope for this AC.
14. **No regression to existing dashboard tests.** `apps/web/src/routes/(app)/dashboard/dashboard.test.ts`
    (or equivalent) continues to pass after the link-target change; add/update assertions for the
    new `/projects/:id` href where the old test asserted `/projects/:id/credentials` for a
    project-level (not credential-level) link.

### Accessibility and consistency of the new surface

15. **Sub-nav meets the same focus-visible bar the rest of the app is required to meet.** The tab
    bar's focus indicator on each tab must be visibly distinguishable against its background (WCAG
    2.1 AA 2.4.7) — do not reuse the invisible-focus-ring pattern flagged in
    `docs/usability-audit-2026-07-13.md`'s accessibility findings for dark/slate-950 buttons; verify
    computed focus-ring contrast the same way that audit did (DOM/computed-style inspection), not
    just visual inspection.
16. **Sub-nav landmark and labeling.** The tab bar is exposed as a `<nav aria-label="Project
    navigation">` (or `role="tablist"` with a labelled group, pick one convention and apply it
    consistently) distinct from the top-level `aria-label="Primary navigation"` nav in
    `PrimaryNav.svelte`, so a screen-reader user can distinguish "primary app nav" from "this
    project's nav" when both are present on the page.

### Automated test coverage

17. A new page-server test file (mirroring the existing pattern at, e.g.,
    `apps/web/src/routes/(app)/projects/[projectId]/credentials/credentials-list-page.server.test.ts`)
    covers the overview page's loader for: happy path (AC-1/AC-2), nonexistent/foreign-org project
    (AC-3), malformed ID (AC-4), and archived project (AC-5).
18. A component/integration test covers the sub-nav rendering identically across at least three
    distinct project sub-routes and correctly marking the active tab (AC-8/AC-9), reusing or
    extending the existing `route-exists.ts` test helper at
    `apps/web/src/lib/test/route-exists.ts` if applicable so the sub-nav's hrefs are asserted to
    resolve to real routes (G3 navigation-truth requirement).

## Tasks / Subtasks

- [ ] Task 1 — Project overview route (AC: 1, 2, 3, 4, 5, 17)
  - [ ] Add `apps/web/src/routes/(app)/projects/[projectId]/+page.server.ts` loading project
        metadata + summary-tile data from existing project-scoped API endpoints
  - [ ] Add `apps/web/src/routes/(app)/projects/[projectId]/+page.svelte` rendering the overview
        (name, description/tags, ownership, summary tiles, archived badge)
  - [ ] Reuse existing 404/malformed-ID handling pattern from the credentials sub-route loader
  - [ ] Write `project-overview-page.server.test.ts` covering AC-1 through AC-5
- [ ] Task 2 — Persistent project sub-nav component (AC: 8, 9, 10, 11, 15, 16, 18)
  - [ ] Create `apps/web/src/lib/components/shell/ProjectNav.svelte` (new component; mirror
        `PrimaryNav.svelte` + `nav-model.ts`'s structure — a `project-nav-model.ts` listing the 9
        tabs, and reusing/mirroring `isActiveNavItem`)
  - [ ] Wire `ProjectNav` into a shared layout for the `[projectId]` route tree — check whether
        introducing `apps/web/src/routes/(app)/projects/[projectId]/+layout.svelte` is the right
        SvelteKit mechanism (it is the idiomatic way to share UI across all sub-routes without
        duplicating markup in every `+page.svelte`) rather than importing the component into each
        of the 9 pages individually
  - [ ] Implement role-gating/disabled-tab behavior per AC-9
  - [ ] Verify focus-visible contrast (AC-15) and landmark labeling (AC-16)
  - [ ] Write sub-nav rendering/active-tab test (AC-18)
- [ ] Task 3 — Re-point dashboard/list links (AC: 6, 7, 12, 13, 14)
  - [ ] Update `apps/web/src/routes/(app)/projects/+page.svelte:273` project card link to
        `/projects/${project.id}` (add a secondary "View credentials" affordance if kept)
  - [ ] Audit `apps/web/src/routes/(app)/dashboard/+page.svelte` for project-level (not
        credential/rotation-level) links and re-point only those per AC-13
  - [ ] Update/add assertions in existing dashboard and projects-list tests for the new hrefs
- [ ] Task 4 — Regression pass
  - [ ] Run full web test suite; confirm no route-exists / navigation-truth check regresses
  - [ ] Manually verify (or via Playwright, if `10-1-playwright-e2e-test-automation` tooling is
        available) the persona journey stub above end-to-end

## Dev Notes

### Migration / rollout considerations (read before starting — explicitly requested for this story)

- **No feature flag needed.** This app has no existing feature-flag infrastructure for UI rollout
  (confirmed: no flag/toggle system found in `apps/web/src/lib` during research for this story) — the
  established pattern for UI changes in this codebase (see `11-1-branding-visual-identity`, a
  comparable shared-shell change touching many pages) is to ship directly, guarded by tests, not
  behind a flag. Follow that precedent: ship this behind normal PR review + the tests in AC-17/18,
  not a flag.
- **No redirect needed for the Credentials URL.** Per the UX recommendation and AC-6, the
  `/projects/:id/credentials` URL does **not** change — only *what links to it and how it's framed*
  changes. There is therefore no old-URL-to-redirect concern for Credentials itself. The only URL
  that starts resolving to new content is `/projects/:id`, which currently 404s for everyone (it is
  not a URL any existing bookmark/link could have depended on rendering something else) — so no
  redirect or deprecation period is needed there either.
- **Sequencing within this story, if the dev agent wants to split work into multiple PRs**: the UX
  recommendation's own sequencing note applies — the sub-nav (Task 2) is the load-bearing piece and
  can ship against the existing sub-pages before the Overview page's summary tiles are fully built
  out (start Task 1 as a thin page: project metadata + sub-nav, iterate on tile richness after). The
  card-link fix (Task 3) is low-risk and can ship independently/first if desired. This is guidance,
  not a hard requirement — a single PR covering all tasks is also acceptable.
- **This is a shared-component change touching ~8 existing pages' rendering context** (every
  `[projectId]/**` sub-route now renders inside the new layout/sub-nav). Regression risk is
  primarily visual/layout (content reflow under the new tab bar), not functional — the 8 existing
  pages' own data-fetching and mutation logic must not be touched by this story. Confirm each
  existing sub-page's own test suite still passes unmodified (aside from any snapshot updates for
  the new surrounding chrome).

### Architecture / pattern compliance

- Follow SvelteKit route conventions already established in this repo: `+page.server.ts` for data
  loading, `+page.svelte` for rendering, `resolve()` from `$app/paths` for all internal hrefs (never
  hardcode paths — see every existing example cited above).
- Reuse `apps/web/src/lib/components/shell/nav-model.ts`'s `isActiveNavItem` pattern for the new
  sub-nav's active-tab logic rather than writing new route-matching logic from scratch.
- The existing `[projectId]` sub-routes (credentials, members, machine-users, services,
  certificates, domains, service-endpoints, status-page) already exist and already work — this story
  is about the page that's *missing* (`/projects/:id` itself) and the *navigation chrome* wrapping
  all of them, not about rebuilding any of those 8 pages' content or data logic.
- G3 (navigation & dashboard truth) applies directly: every new href introduced by this story must
  resolve to a real route (verified via `route-exists.ts` or equivalent), and the summary tiles must
  never hardcode a `0`/empty value when backing data exists (AC-2).

### Project Structure Notes

- New files: `apps/web/src/routes/(app)/projects/[projectId]/+page.server.ts`,
  `apps/web/src/routes/(app)/projects/[projectId]/+page.svelte`, likely
  `apps/web/src/routes/(app)/projects/[projectId]/+layout.svelte` (for the shared sub-nav — confirm
  this is the right SvelteKit layering before implementing; the alternative of importing `ProjectNav`
  into each of the 9 `+page.svelte` files individually is more error-prone and should be avoided).
- New component: `apps/web/src/lib/components/shell/ProjectNav.svelte` +
  `apps/web/src/lib/components/shell/project-nav-model.ts` (naming mirrors the existing
  `PrimaryNav.svelte` / `nav-model.ts` pair for consistency).
- Modified files: `apps/web/src/routes/(app)/projects/+page.svelte` (card link),
  `apps/web/src/routes/(app)/dashboard/+page.svelte` (project-level link only — do not touch the
  credential/rotation-level deep links).
- No new files or changes required in `apps/api/**` for this story — all summary-tile data should be
  obtainable from existing project-scoped endpoints (member listing, services/certs
  expiry, endpoint/status-page health) already used elsewhere in the app; if any summary tile turns
  out to require a genuinely new API aggregate that doesn't exist yet, that is a scope-affecting
  discovery — flag it rather than silently faking the number (see AC-2's honest-placeholder rule).

### References

- [Source: docs/usability-audit-2026-07-13.md#2-recommended-information-architecture-ux-expert-addressing-p1p3]
- [Source: docs/usability-audit-2026-07-13.md#1-product-owner-findings-nestor] (P1, P2, P3)
- [Source: apps/web/src/lib/components/shell/nav-model.ts]
- [Source: apps/web/src/lib/components/shell/PrimaryNav.svelte]
- [Source: apps/web/src/routes/(app)/projects/+page.svelte] (line 273 card link)
- [Source: apps/web/src/routes/(app)/dashboard/+page.svelte] (lines 64, 132, 171, 208, 220, 227)
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- Sibling split (independent, not a dependency): `_bmad-output/implementation-artifacts/12-2-usability-trust-accessibility-fixes.md`

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

### Completion Notes List

- Story created by splitting the original bundled `12-1-usability-and-navigation-fixes` story into
  this IA-focused story and the sibling `12-2-usability-trust-accessibility-fixes`. Grounded in
  direct source inspection of the current routing/nav structure (2026-07-13) rather than assumption.

### File List
