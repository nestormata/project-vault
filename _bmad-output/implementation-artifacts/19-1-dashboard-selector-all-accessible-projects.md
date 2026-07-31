# Story 19.1: Dashboard Selector Includes Every Accessible Project

Status: ready-for-dev
Surface scope: web

## Story

As Riley, a member who can access multiple projects,
I want the dashboard project selector to include every active project I can access,
so that selecting a project outside the first API page still shows its real monitoring data
instead of silently falling back to a different project.

## Persona Journey

Riley signs in, opens `/dashboard`, and sees a project selector containing all active projects for
which Riley has access. Riley chooses a project that is not on the first projects API page, submits
the selector, and sees that project's dashboard metrics, certificates, domains, alerts, rotations,
and recent activity. A bookmarked `?projectId=` for an accessible project remains usable; an ID for
an inaccessible or deleted project falls back to the first currently accessible project without
revealing whether the rejected ID exists.

## Acceptance Criteria

1. **All accessible projects are selectable.** The dashboard loader must obtain the complete active
   project set, not only the default first page of `GET /api/v1/projects`. A user with 101 accessible
   projects must be able to select project 101, and the rendered selector must include it. The
   implementation must reuse the existing project-list API and its access-controlled membership
   query; do not introduce an org-wide or client-controlled project source.

2. **Pagination is complete, bounded, and deterministic.** Page requests use the existing API
   pagination contract (`page`, `limit`, `total`, `hasNext`) with the largest supported page size,
   request pages sequentially rather than creating an unbounded burst, stop when `hasNext` is false,
   and fail honestly if a subsequent page cannot be loaded. A malformed or contradictory pagination
   response must not create an infinite loop or silently present a partial selector. The boundaries
   are explicit: zero projects is a valid empty state; exactly 100 projects completes in one page;
   101 projects requires page 2; an empty page with `hasNext=true`, a non-advancing page, duplicate
   project IDs, or a `total` lower than the accumulated items is an incomplete/invalid response and
   must fail closed rather than being normalized into a successful list.

3. **Selection and fallback semantics remain safe.** An explicit `projectId` is selected only when
   it appears in the complete access-controlled list. An inaccessible, archived-by-default, deleted,
   or malformed ID falls back to the first accessible active project using the existing behavior.
   The selected project ID is passed to the existing project-dashboard, certificate, and domain
   requests; no request may be made for an ID that was not returned by the access-controlled list.

4. **Tenant/RLS and authorization boundaries remain intact.** Add or update focused API/client/load
   tests proving that pagination cannot expose another organization's project or a project without
   an explicit membership row for member/viewer roles. Owner/admin behavior must continue to follow
   the existing project-list authorization contract. No migration or RLS-policy change is expected;
   if implementation requires one, stop and reconcile the architecture before proceeding. Treat a
   URL `projectId` from an attacker as untrusted input: authorization must be rechecked by the
   existing downstream project-scoped APIs after selection, and the dashboard must not distinguish
   an inaccessible project's existence from an invalid or deleted ID.

5. **Failure and rate-limit behavior is honest.** A page-2 or later list failure must not be treated
   as an empty successful page and must not render a partial selector that implies completeness. The
   loader/client must avoid parallel page fan-out and respect the existing authenticated project-list
   rate limit. Existing vault-sealed, 404, dashboard partial-failure, and monitoring-card streaming
   behavior remains unchanged. No client-controlled API base URL or alternate project source may be
   introduced, and membership revocation between list loading and the downstream dashboard request
   must resolve through the existing authorization/error path.

6. **Selector accessibility and surface contract remain compliant.** The selector retains a visible
   label and submit action, has localized visible explanatory text connected through
   `aria-describedby` under Product Surface Contract G5, and remains usable at narrow viewport
   widths. The URL-based selection remains bookmarkable and does not depend on browser storage.

7. **Regression coverage exercises the real boundary.** Focused tests cover: zero projects, exactly
   100 projects, 101 projects with selection on page 2, an empty page with `hasNext=true`, a
   non-advancing page, duplicate IDs, a `total` lower than accumulated items, an
   invalid/inaccessible URL project, a later-page request failure, contradictory pagination metadata,
   and preservation of existing dashboard/API request routing. Tests must verify request order and
   page parameters as well as rendered selection.

8. **Playwright journey is demonstrated.** Against the local running stack, use a deterministic test
   fixture or setup helper to create/access enough projects to cross the API page boundary, then use
   Playwright in a real browser to open the dashboard, choose the later-page project, submit, and
   verify the selected project heading and at least one project-scoped dashboard result. Also verify
   that an inaccessible project ID does not load another user's project. Record the journey and
   command/result in the Dev Agent Record.

## Tasks / Subtasks

- [ ] Task 1: Inspect and specify the existing project-list pagination/client contract (AC: 1, 2, 4)
  - [ ] Confirm the API's maximum supported limit and `hasNext` semantics in the shared schema,
        route, and project route tests.
  - [ ] Confirm the existing RLS/membership join remains the only source of dashboard-selectable
        projects.
- [ ] Task 2: Implement complete project loading for the dashboard (AC: 1, 2, 3, 5)
  - [ ] Add a focused client helper or equivalent loader logic that requests all pages sequentially
        and returns one ordered project list.
  - [ ] Add explicit termination/contradiction handling so incomplete pagination cannot be mistaken
        for a complete list.
  - [ ] Preserve URL selection, first-accessible fallback, vault-sealed handling, and downstream
        project-scoped requests.
- [ ] Task 3: Keep the selector accessible and responsive (AC: 6)
  - [ ] Add localized explanatory text for the select and wire `aria-describedby`.
  - [ ] Verify the selector remains usable with 1, 20, 101, and narrow-viewport project lists.
- [ ] Task 4: Add focused regression tests before implementation (AC: 4, 5, 7)
  - [ ] Add red tests for later-page selection, ordered page requests, invalid selection fallback,
        pagination contradiction, and page failure.
  - [ ] Add/adjust membership-isolation coverage if the existing project route tests do not prove
        the later-page query remains scoped.
- [ ] Task 5: Run targeted validation and browser journey (AC: 7, 8)
  - [ ] Run the affected web/client/load tests and any directly affected API project tests.
  - [ ] Run lint/typecheck for changed packages only.
  - [ ] Run the Playwright journey against the isolated local stack with worktree-specific ports;
        follow AGENTS.md Docker port isolation instructions before Docker commands.
- [ ] Task 6: Review and record completion (AC: 1-8)
  - [ ] Run adversarial code review for tenant/RLS, pagination termination, auth/session lifecycle,
        rate limits, operational logging, deployment assumptions, and accessibility.
  - [ ] Update the Dev Agent Record, File List, Change Log, and status only after all evidence is
        captured; do not push a branch or open a PR during the Epic 19 local loop.

## Dev Notes

### Implementation guidance

- Story 18.12 already introduced the dashboard selector and URL semantics. The current loader calls
  `listProjects(fetch)` once, and `listProjects` currently requests the API default page; the
  remaining bug is completeness, not permission logic.
- `GET /api/v1/projects` already supports page-based pagination with a maximum limit of 100 and
  returns `items`, `total`, `page`, `limit`, and `hasNext`. Its route uses an inner membership join
  for member/viewer roles and the established org-role behavior for owner/admin roles. Reuse this
  contract instead of adding a dashboard-only endpoint.
- The dashboard must not aggregate across projects. The project dashboard, certificate list, and
  domain list remain scoped to the one validated selected project, preserving the existing G3
  dashboard-truth and tenant-boundary behavior.
- A sequential all-pages helper is preferred to concurrent fan-out because the endpoint is rate
  limited and the selector needs an ordered, complete list. It must have explicit behavior for
  `hasNext=true` with no progress or impossible metadata. Boundary decisions are: an empty first
  page is a valid no-projects state only when `hasNext=false`; an empty continuation page, repeated
  page number, duplicate project ID, or total/count contradiction is an error; a failed page is
  never replaced with an empty page; and the loop must have a finite safety bound even when a server
  incorrectly keeps returning `hasNext=true`.
- The selector currently has a visible `<label>` but no explanatory description. G5 applies here;
  coordinate copy with the localization conventions and avoid leaving this control as an implicit
  exception while Story 19.3 audits the rest of the product.

### ADR-19.1: Load the complete selector through the existing paginated API

- **Decision:** Extend the web loader/client project-list flow to request the existing
  `/api/v1/projects` pages sequentially with `limit=100`, validate the pagination metadata, and
  preserve the ordered, access-controlled result for URL selection. Do not add an endpoint, schema
  change, migration, or client-controlled data source.
- **Alternatives considered:** Increasing one request beyond the API maximum was rejected because it
  violates the established contract; adding a dashboard-only all-projects endpoint was rejected
  because it duplicates authorization and pagination logic; aggregating projects client-side from
  organization data was rejected because it weakens the membership/RLS boundary.
- **Consequences:** Large project sets require additional sequential requests and can surface a
  list-load error instead of a misleading partial selector. In exchange, the selector becomes
  complete while the existing membership enforcement and downstream project-scoped authorization
  remain the source of truth.

### Required invariant coverage

- **Tenant/RLS:** member/viewer users only receive projects with explicit membership; a project ID
  supplied in the URL is never trusted until it is present in the returned access-controlled list.
- **Audit:** this is read-only work and must not invent audit events. Preserve the existing
  `writeAuditEvent: false` behavior for project listing.
- **Auth/session:** unauthenticated and expired-session requests continue through the existing API
  client/auth guard behavior; do not add a client-only project discovery path.
- **Concurrency/replay:** repeated navigation or back/forward URL replay must produce the same
  selected project for the same access snapshot; no mutable browser storage is required.
- **Rate limits/operations:** page requests are sequential and bounded by valid pagination metadata;
  errors remain observable through the existing loader error path and are not converted to empty
  success.
- **Migrations/runtime schema:** no schema migration is expected. Any changed API response shape
  requires contract/spec updates and compatibility review before implementation.
- **Deployment hardening:** browser validation must use the isolated worktree's ports and must not
  rely on a developer-only localhost URL or a preexisting user's data.

### Security audit persona findings

- **Untrusted member:** can supply another organization's or another member's project ID in the URL;
  the ID must be accepted only if it is in the access-controlled list, and downstream APIs remain
  authoritative if membership changes after listing.
- **Enumeration attacker:** must not learn whether a rejected project exists from status, fallback,
  selector contents, timing-specific client behavior, or error copy; invalid, inaccessible, and
  deleted IDs use the same safe fallback semantics.
- **Abuse/rate-limit attacker:** cannot cause an unbounded request burst by manipulating pagination;
  page requests are sequential, bounded, and use the existing authenticated endpoint.
- **Operator/auditor:** this read-only list operation does not create a new audit event and preserves
  the existing `writeAuditEvent: false` contract; page failures remain observable through normal
  loader/API error handling.

### Cross-story dependencies

- Depends on Story 18.12's dashboard selector, URL parameter, and monitoring-card behavior.
- Must consume the G5 input-explanation rule added by the Epic 18 retro; Story 19.3 will perform the
  wider audit and fix remaining controls, but it must not remove this story's selector guidance.
- Story 19.2 and 19.4 are independent. Epic 19's final retrospective should verify that all four
  stories are done and that the local-only execution/publish-safety process was followed.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` — Epic 19]
- [Source: `_bmad-output/planning-artifacts/prd.md` — FR7, FR93, FR97 and Sam's multi-project dashboard journey]
- [Source: `_bmad-output/planning-artifacts/architecture.md` — tenant/RLS, dashboard and pagination invariants]
- [Source: `_bmad-output/implementation-artifacts/18-12-fix-dashboard-not-showing-certificates-alerts-and-domains.md` — AC-1b, AC-3, AC-7, AC-8 and review finding]
- [Source: `apps/web/src/routes/(app)/dashboard/+page.server.ts` — current project selection and downstream requests]
- [Source: `apps/web/src/lib/api/projects.ts` — current listProjects client contract]
- [Source: `apps/web/src/lib/components/dashboard/DashboardProjectSelector.svelte` — selector surface]
- [Source: `apps/api/src/modules/projects/routes.ts` and `schema.ts` — access-controlled project pagination]
- [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md` — G3, G4, G5]
- [Source: `AGENTS.md` — TDD, product surface, Docker ports, and story readiness requirements]

## Dev Agent Record

### Agent Model Used

Codex

### Debug Log References

### Completion Notes List

### File List

### Change Log

- 2026-07-31: Story created from Epic 18 Finding 2 with pagination, tenant-safety, accessibility,
  targeted-test, and Playwright requirements.
