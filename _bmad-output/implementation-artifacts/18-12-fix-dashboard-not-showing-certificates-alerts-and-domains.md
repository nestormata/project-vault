# Story 18.12: Fix Dashboard Not Showing Certificates, Alerts, and Domains

Status: in-progress

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who has configured certificates, alerts, and domains,
I want the dashboard to actually show them,
so that the dashboard is trustworthy instead of implying I haven't configured anything when I have.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-member, who has configured certificates, domains, and has active alerts across one or more projects, opens the dashboard and sees real counts/data for all three — not permanent "not configured" placeholder copy, and not just the first project's data if they belong to multiple projects.

## Acceptance Criteria

1. **Confirmed root cause, two distinct bugs — both must be fixed**:
   (a) `apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.svelte`'s "Certificates and domains" and "Alerts" cards are **hardcoded to always render placeholder/empty-state copy** (`dashboardEmptyStateCopy.noCertificates`, `.noAlerts`) regardless of actual data — confirmed via the component's own comment ("have no backing per-project metric to gate on yet, so they remain permanent honest placeholders"). These cards must be wired to real queries so they reflect actual certificate/domain/alert data when it exists, following the G3 dashboard-truth rule (no hardcoded counts when backing data exists).
   (b) `apps/web/src/routes/(app)/dashboard/+page.server.ts` selects `selectedProject = projects.items[0] ?? null` (line ~24) — the dashboard is scoped to only the user's *first* project. If a user's certificates/domains/alerts live under a different project, they never surface on the dashboard regardless of (a). Determine the correct fix: either an explicit project selector on the dashboard (consistent with how other multi-project surfaces in the app let the user pick/switch project, if such a pattern exists), or an org-wide aggregate view — do not silently keep single-project scoping without at least making the scoping visible to the user (e.g. "Showing data for <project name>"). **Given this decision has direct cross-tenant-adjacent data-exposure stakes if an org-wide aggregate is chosen (see AC-3), get this specific choice confirmed before implementation begins**, rather than letting it be resolved ad hoc by whichever path is simpler to build.
2. Note there is **already a working, correctly-wired "Alerts" count** elsewhere on the same dashboard page (`data.dashboard.unresolvedAlertCount`, line ~108) — the broken one is specifically `DashboardPlaceholderGrid`'s duplicate "Alerts" card. Resolve this duplication: either wire the placeholder-grid card to the same real data source, or remove the redundant dead card and ensure the working count is the single source of truth for alerts on the dashboard (avoid two "Alerts" widgets telling different stories).
3. "Certificates and domains" gets a real backing query (project-scoped or org-wide per AC-1(b)'s resolution) — reuse existing certificate/domain listing queries from the monitoring module (`apps/api/src/modules/monitoring/`) rather than writing new ones, consistent with G3's "no hardcoded counts when backing data exists." If AC-1(b)'s resolution is an org-wide aggregate, the underlying queries must still respect the requesting user's actual project memberships (not just org membership) — a user who is a member of some but not all of an org's projects must never see aggregate counts that include data from projects they don't belong to; add an explicit test proving this.
4. If, after investigation, some sub-metric genuinely has no backing data source yet (should not be the case per AC-1's findings, but verify), it must follow AC-E2f: an explicit, honest "not configured" empty state — never a fabricated zero or success state.
5. While the certificates/domains/alerts queries are in flight, the dashboard shows an explicit loading/skeleton state for those cards rather than flashing the "not configured" empty-state copy first and then replacing it once data arrives (which would misleadingly look like confirmation that nothing is configured).
6. If one of the dashboard's data calls fails while the others succeed (e.g. the certificates query errors but alerts succeeds), the cards degrade independently — the failing card shows an honest error/unavailable state while the succeeding cards still render their real data. This is the required outcome, not merely a documented decision that may reasonably conclude "leave it all-or-nothing" — Story 18.12's own AC-8 test coverage already assumes per-card degradation as tested behavior, so satisfying this AC requires restructuring `+page.server.ts`'s existing whole-request try/catch (the "sealed vault" fallback that currently discards everything on any single call failing, per its own inline comment) to actually support independent per-card failure, e.g. by moving from a single `Promise.all` to `Promise.allSettled` or per-widget error boundaries.
7. If AC-1(b)'s resolution introduces a project selector, its default selection and any persistence-across-visits behavior is specified (not left implicit), along with basic mobile/narrow-viewport layout consideration.
8. New/updated tests cover: dashboard cards render real data when certificates/domains/alerts exist (across more than just the user's first project, per AC-1(b)'s fix), correctly show an honest empty state only when there's genuinely no data, the specific repro scenario from the original bug report (a user with zero data in their first-created/first-listed project but real certificates/domains/alerts in a different project they belong to), the AC-3 cross-project-membership scoping guarantee if an org-wide aggregate is chosen, and the AC-6 partial-failure degradation behavior.

## Tasks / Subtasks

- [x] Task 1: Wire "Certificates and domains" card to real data (AC: 1a, 3)
- [x] Task 2: Resolve duplicate/dead "Alerts" card (AC: 1a, 2)
- [x] Task 3: Fix single-first-project dashboard scoping (AC: 1b)
- [x] Task 4: Verify/apply honest-empty-state fallback (AC: 4)
- [x] Task 5: Tests (AC: 5)

## Dev Notes

- This is a **confirmed, real bug** (not a misunderstanding of intentional scope) with two independent causes, both must be addressed for the user's report to actually be resolved:
  1. `DashboardPlaceholderGrid.svelte` (lines ~4-6 comment) explicitly documents these cards as permanent unwired placeholders — this was a deliberate scope decision at some point in the past that is now stale given monitoring data (certificates/domains/alerts) does exist elsewhere in the product (Epic 6). Wire them up rather than leaving the comment's rationale unchallenged.
  2. `apps/web/src/routes/(app)/dashboard/+page.server.ts:24` — `selectedProject = projects.items[0] ?? null` — this alone would explain "I have things configured but the dashboard shows nothing" for any user whose relevant project isn't first in the list, independent of bug (a).
- `data.dashboard.unresolvedAlertCount` (dashboard `+page.svelte:108`) is already correctly wired — use it as the reference implementation for "how this dashboard correctly queries real data" when fixing the certificates/domains card, and to resolve the duplicate-Alerts-card question in AC-2.
- Check `apps/api/src/modules/monitoring/` for existing certificate/domain listing/count queries (built for Epic 6's services/certificates/domains features) before writing new ones.
- Cross-reference Epic 12's dashboard-staleness trust bug fix (Story 12-2, `invalidateAll()`-based fix) for related "dashboard doesn't reflect real state" precedent in this codebase, though that was a different specific bug (staleness after action, not never-wired data).

### Project Structure Notes

- Changes concentrated in `apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.svelte`, `apps/web/src/routes/(app)/dashboard/+page.server.ts`, `apps/web/src/routes/(app)/dashboard/+page.svelte`, and possibly a new/reused query in `apps/api/src/modules/monitoring/`.

### References

- [Source: apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.svelte]
- [Source: apps/web/src/routes/(app)/dashboard/+page.server.ts]
- [Source: apps/web/src/routes/(app)/dashboard/+page.svelte]
- [Source: apps/api/src/modules/monitoring/]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

- Red phase: new dashboard tests failed against the hardcoded cards, first-project selection, and whole-request failure handling.
- Green phase: focused dashboard tests passed after wiring project-scoped monitoring queries and `Promise.allSettled` handling.
- Broader validation: apps/web Vitest 222 files / 1931 tests passed; web typecheck and targeted ESLint passed.

### Completion Notes List

- Chose the explicit project-selector path, consistent with ADR-2.1-08's project-list cross-project model; no org-wide aggregate was introduced.
- Dashboard defaults to the first currently accessible project, accepts `?projectId=` for another accessible project, and preserves selection through the URL only.
- Certificate and domain counts reuse the existing web clients for the monitoring list endpoints; the visible project list and API project gates preserve tenant/project membership boundaries.
- Removed the duplicate placeholder Alerts card. The existing dashboard Alerts summary is the single source of truth, with an unavailable state when its dashboard query fails.
- Certificate/domain loading skeletons, honest zero-data copy, and independent unavailable states are covered by tests; no audit, auth, rate-limit, migration, or deployment surface changed.

### File List

- apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.svelte
- apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.test.ts
- apps/web/src/routes/(app)/dashboard/+page.server.ts
- apps/web/src/routes/(app)/dashboard/+page.svelte
- apps/web/src/routes/(app)/dashboard/dashboard-page.server.test.ts
- apps/web/src/routes/dashboard.test.ts

### Change Log

- 2026-07-31: Implemented Story 18.12 dashboard monitoring counts, explicit project selection, duplicate-alert removal, loading/empty/error states, and independent failure handling; status moved to review.

### Review Findings

- [x] [Review][Patch] Stream monitoring-card loading states during dashboard data fetches [apps/web/src/routes/(app)/dashboard/+page.server.ts:88] — fixed by streaming independent certificate/domain state promises and rendering pending skeletons in `DashboardPlaceholderGrid`.
- [ ] [Review][Patch] Project selector only exposes the first paginated project page [apps/web/src/routes/(app)/dashboard/+page.server.ts:14] — the dashboard can select among the default first 20 accessible projects, but users with later accessible projects need project-list pagination or an all-projects loader; left unfixed because this review was authorized to apply Critical/High fixes only.
