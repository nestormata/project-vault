# Story 12.1: Project Information Architecture

Status: review

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

- [x] Task 1 — Project overview route (AC: 1, 2, 3, 4, 5, 17)
  - [x] Add `apps/web/src/routes/(app)/projects/[projectId]/+page.server.ts` loading project
        metadata + summary-tile data from existing project-scoped API endpoints
  - [x] Add `apps/web/src/routes/(app)/projects/[projectId]/+page.svelte` rendering the overview
        (name, description/tags, ownership, summary tiles, archived badge)
  - [x] Reuse existing 404/malformed-ID handling pattern from the credentials sub-route loader
  - [x] Write `project-overview-page.server.test.ts` covering AC-1 through AC-5
  - [x] **Scope-affecting discovery (flagged per Dev Notes' own instruction, not silently worked
        around):** no existing project-scoped endpoint returns name/description/tags/archived-state
        for a single project, nor a viewer-safe member count (`GET /:projectId/members` is
        project-admin/owner-or-org-admin/owner-gated — a project viewer would 403 on it, breaking
        the persona journey's Riley-viewer case). Added one new endpoint,
        `GET /api/v1/projects/:projectId` (apps/api/src/modules/projects/routes.ts), returning
        `ProjectOverview` (`ProjectDetail` + `tags` + `memberCount`), following the exact same
        visibility-check-before-any-read pattern as the adjacent `GET .../dashboard` route (AC-3
        no-leak requirement). This is the one deliberate deviation from "no apps/api/** changes"
        in Dev Notes, and Dev Notes explicitly names this exact scenario as the correct call.
- [x] Task 2 — Persistent project sub-nav component (AC: 8, 9, 10, 11, 15, 16, 18)
  - [x] Create `apps/web/src/lib/components/shell/ProjectNav.svelte` (new component; mirrors
        `PrimaryNav.svelte` + `nav-model.ts`'s structure — `project-nav-model.ts` lists the 9 tabs
        and reuses `nav-model.ts`'s `isActiveNavItem` for every tab except Overview, which needs a
        strict-equality match instead of the prefix match or it would also light up on every
        deeper project screen)
  - [x] Wired `ProjectNav` into `apps/web/src/routes/(app)/projects/[projectId]/+layout.svelte`
        (+ `+layout.server.ts` supplying `orgRole`/`project` to every sub-route) — confirmed this is
        the correct SvelteKit mechanism; avoids touching any of the 9 existing `+page.svelte` files
  - [x] Role-gating (AC-9): investigated every sub-route's list endpoint directly rather than
        assuming. Members/Machine Users/Services/Certificates/Domains/Status Page all gracefully
        degrade to an empty/limited view for a viewer role (confirmed via their existing
        `+page.server.ts` loaders and tests) — no 403 risk, no gating needed. The one real risk:
        `GET /:projectId/service-endpoints` and `GET /:projectId/alerts`
        (apps/api/src/modules/monitoring/routes.ts) require org role >= member, and the Endpoints
        page's own loader only catches 404 — an org-viewer hitting that tab today gets an uncaught
        403 that surfaces as SvelteKit's generic error page. `project-nav-model.ts` hides the
        Endpoints tab for `orgRole === 'viewer'` to prevent exactly that.
  - [x] Focus-visible (AC-15): applied `outline-offset-2` so the focus ring renders in the gap
        outside each tab, over the page's light background, rather than directly on the tab's own
        fill color — this is the fix for the exact invisible-ring-on-a-dark-background pattern the
        audit flagged, applied uniformly so it doesn't matter whether a given tab is active
        (bg-brand-600) or inactive (light/transparent).
  - [x] Landmark (AC-16): `<nav aria-label="Project navigation">`, distinct from `PrimaryNav`'s
        `aria-label="Primary navigation"`.
  - [x] `ProjectNav.test.ts` (rendering/active-tab/role-gating/archived-badge/landmark) +
        `ProjectNav.route-exists.test.ts` (AC-18: asserts identical 9-tab rendering across 3 project
        sub-routes with the active tab tracking the route, and that every tab href resolves to a
        real `+page.svelte` — extended `apps/web/src/lib/test/route-exists.ts` with
        `projectRouteExists()` since the existing helper can't see past the `[projectId]` dynamic
        segment)
- [x] Task 3 — Re-point dashboard/list links (AC: 6, 7, 12, 13, 14)
  - [x] Updated `apps/web/src/routes/(app)/projects/+page.svelte` project card's name to link to
        `/projects/${project.id}`; the existing "View credentials" secondary action is unchanged
  - [x] Audited `apps/web/src/routes/(app)/dashboard/+page.svelte`: only the selected-project `<h1>`
        (line ~85) was a project-level (not credential/rotation-level) link candidate — it was plain
        text before, now links to `/projects/${data.selectedProject.id}`. The 6 other links the
        story's Background section calls out (lines 64/132/171/208/220/227) are all
        credential/rotation/quick-action deep links and were confirmed unchanged.
  - [x] Added `projects-list-page.test.ts` and `dashboard-page.test.ts` (neither page had a
        component-level test before this story) asserting the new hrefs
- [x] Task 4 — Regression pass
  - [x] Full web test suite: 188 files / 1491 tests passed, no regressions. Full API project-routes
        suite: 22/22 passed (127/127 across all `apps/api/src/modules/projects/**` tests). Also
        fixed a pre-existing-pattern gap the new route tripped: `route-audit.test.ts` requires every
        `secureRoute` to have an entry in `ROUTE_ACTION_CLASSIFICATIONS`
        (apps/api/src/lib/route-exemptions.ts) — added one for the new `GET /:projectId` route,
        mirroring the adjacent dashboard route's classification.
  - [x] Manually verified the persona journey end-to-end against a locally bootstrapped Docker
        stack (`make docker-up` + vault init) using live Chrome browser automation — see Dev Agent
        Record → Completion Notes for the full walkthrough and what was checked.

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
- **Implementation summary**: added the missing `/projects/:id` overview route (name, description,
  tags, ownership, archived badge, three honest summary tiles), a new persistent `ProjectNav`
  sub-nav wired via a shared `+layout.svelte`/`+layout.server.ts` across all 9 project screens, and
  re-pointed the projects-list card link + the dashboard's selected-project heading to the new
  overview page. One new API endpoint (`GET /api/v1/projects/:projectId`) was added as a flagged
  scope-affecting discovery — see Task 1's note above.
- **Manual verification (live Chrome, local Docker stack)**: bootstrapped the full stack with
  `make docker-up`, initialized the vault (`POST /api/v1/vault/init` with a bootstrap token — the
  UI's remote-init path needs `VAULT_BOOTSTRAP_TOKEN` wired, since `VAULT_ALLOW_REMOTE_INIT` is not
  actually passed through `docker-compose.yml`'s `api` service environment despite being documented
  as the alternative), registered a new org/owner, ran onboarding, and created a "Payments API"
  project with one credential. Verified end-to-end via `mcp__claude-in-chrome`:
  - Golden path: clicking the project name on `/projects` landed on `/projects/:id` showing
    `<h1>Payments API</h1>`, "Created Jul 13, 2026 · Your role: owner", and three tiles reading
    "1 member", "Nothing expiring soon", "No services configured yet" (honest empty state, AC-2
    edge case) — never a blank tile or a fabricated 0.
  - Sub-nav persistence: navigated Overview → Credentials → Members via the tab bar (not back
    button); the 9-tab bar rendered identically each time with no flicker/reorder, and the correct
    tab carried `aria-current="page"` at each stop, exactly matching the persona journey stub.
  - Dashboard: the "Payments API" heading on `/dashboard` is now a link to `/projects/:id`; clicking
    it landed on the overview page.
  - 404/edge cases: `GET /projects/<random-uuid>` (nonexistent) rendered an honest "Project not
    found" message with the sub-nav still present, no data leak. `GET /projects/not-a-uuid`
    (malformed) rendered the app's existing generic 500 error page — confirmed byte-for-byte
    identical to `GET /projects/not-a-uuid/credentials`'s existing behavior (same screenshot), so
    AC-4's "reuse the established pattern" is satisfied even though that established pattern is a
    bare 500, not a friendly 400/404.
  - Archived state: set `archived_at` directly via `psql` (the archive API route requires MFA
    enrollment, out of scope to enroll for this check) and reloaded the overview — an "Archived"
    badge rendered both in the sub-nav and next to the project name, then reverted the DB change
    afterward.
  - Non-project pages (`/dashboard`, `/projects`) render with no stray project sub-nav, confirming
    AC-10.
  - Not exercised live: a genuine second-org-viewer browser session for the Endpoints-tab-hidden
    case (AC-9) — provisioning a real second authenticated session inside this environment was
    disproportionate effort for a case already covered by a real Postgres-backed API integration
    test (a true `project_memberships` viewer role hitting the new endpoint) plus 6 dedicated
    `ProjectNav` unit/component tests exercising the exact hide-for-viewer logic.
- **Docker/env note for future manual verification**: `docker-compose.yml` only wires
  `VAULT_BOOTSTRAP_TOKEN` through to the `api` service, not `VAULT_ALLOW_REMOTE_INIT` — despite the
  latter being documented in `.env.example` as the dev-friendly alternative. Set
  `VAULT_BOOTSTRAP_TOKEN` in `.env` and pass it as the `x-vault-bootstrap-token` header (or via the
  UI's "Bootstrap token" field) to init a fresh Docker stack; this is out of this story's scope to
  fix but is worth flagging for whoever hits it next.

### File List

**New files**

- `apps/web/src/routes/(app)/projects/[projectId]/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/+layout.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/+layout.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/project-overview-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/project-overview-page.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/project-layout.server.test.ts`
- `apps/web/src/lib/components/shell/ProjectNav.svelte`
- `apps/web/src/lib/components/shell/project-nav-model.ts`
- `apps/web/src/lib/components/shell/project-nav-model.test.ts`
- `apps/web/src/lib/components/shell/ProjectNav.test.ts`
- `apps/web/src/lib/components/shell/ProjectNav.route-exists.test.ts`
- `apps/web/src/routes/(app)/projects/projects-list-page.test.ts`
- `apps/web/src/routes/(app)/dashboard/dashboard-page.test.ts`

**Modified files**

- `apps/web/src/routes/(app)/projects/+page.svelte` (project card name now links to overview)
- `apps/web/src/routes/(app)/dashboard/+page.svelte` (selected-project heading now links to overview)
- `apps/web/src/lib/api/projects.ts` (added `getProject`)
- `apps/web/src/lib/test/route-exists.ts` (added `projectRouteExists` helper)
- `apps/api/src/modules/projects/routes.ts` (added `GET /:projectId` overview route)
- `apps/api/src/modules/projects/schema.ts` (added `ProjectOverviewResponseSchema`)
- `apps/api/src/modules/projects/member-management.ts` (added `getProjectMemberCount`)
- `apps/api/src/modules/projects/routes.test.ts` (added overview + archived-state route tests)
- `apps/api/src/lib/route-exemptions.ts` (added route-audit classification for the new endpoint)
- `packages/shared/src/schemas/projects.ts` (added `ProjectOverviewSchema`/`ProjectOverview`)

### Change Log

- 2026-07-13: Implemented Story 12.1 — project overview page, persistent project sub-nav, and
  dashboard/list link re-pointing. Added one new API endpoint (`GET /api/v1/projects/:projectId`)
  as a flagged scope-affecting discovery (see Task 1). All ACs satisfied; 188/188 web test files
  (1491/1491 tests) and 127/127 API project-module tests passing. Manually verified end-to-end
  against a locally bootstrapped Docker stack via live Chrome browser automation.
