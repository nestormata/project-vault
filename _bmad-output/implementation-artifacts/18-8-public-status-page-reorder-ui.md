# Story 18.8: Public Status Page Reorder UI

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a project admin managing the public status page,
I want to reorder the list of services shown to the public,
so that I can control which services appear first without relying on database insertion order.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-admin opens the project's status-page management screen and can reorder the listed services (drag-and-drop or up/down controls). The public status page immediately reflects the new order for anyone viewing it.

## Acceptance Criteria

1. **Scope correction, confirmed by direct route inspection**: the backend is already fully wired, not merely "supports ordering in principle" — `status_page_services.sortOrder` (`packages/db/src/schema/status-page-services.ts:23`) is a real column, consistently used in query ordering (`apps/api/src/modules/monitoring/status-page-service.ts`, `.orderBy(statusPageServices.sortOrder)` at multiple call sites), a reorder function already exists (`status-page-service.ts` ~lines 128-186, reassigns `sortOrder: index`), **and it is already exposed and callable**: `PUT /api/v1/projects/:projectId/status-page` (`apps/api/src/modules/monitoring/status-page-routes.ts:242-291`) already calls `updateStatusPageServices`, is rate-limited, requires MFA, and writes a `status_page.updated` audit event. Task 1 (route wiring) requires no new backend route — confirm this on start and, if still accurate, skip straight to building the web UI against the existing `PUT` route.
2. `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` (or wherever the status-page admin management UI lives — confirm exact path) gets a reorder control. It must be keyboard-operable regardless of whether drag-and-drop is also offered (up/down move buttons, or an equivalent keyboard-accessible mechanism) — drag-and-drop as the *only* input method is not acceptable, since it excludes keyboard/screen-reader users.
3. **Effective role gate must match the existing route behavior**: although the route declares `minimumRole: 'member'`, its existing `preflightOwnedProject` authorization check further requires project-owner or organization-owner access. Preserve that effective owner/org-owner gate for reorder; do not widen access or change backend authorization in this UI story. Any future decision to make members eligible requires a separate product/security decision and backend authorization change. The UI and regression tests must not assume the declared route floor is the effective gate.
4. Reordering persists via the existing `PUT /api/v1/projects/:projectId/status-page` route and updates `sortOrder` for the affected services; the public status page (unauthenticated view) reflects the new order on next load.
5. **Concurrency semantics must be explicit, not assumed benign**: `updateStatusPageServices` performs a full delete-all/reinsert-all of the service list keyed on the entire submitted array (not an incremental per-item patch) — two admins reordering concurrently will silently last-write-wins clobber each other's full list, not just risk duplicate/gapped `sortOrder` values. Critically, this clobbering risk is not limited to *order* racing *order*: if one admin's submitted array was fetched before a second admin added or removed a service, that stale array's delete-all/reinsert-all will silently delete the service the second admin added (or resurrect one they removed) — not just reorder it. Define and document the accepted resolution semantics for this specific case (not just simultaneous pure-reorders) and add a concurrency test that races a reorder submission against an intervening add/remove, not only two reorders against each other.
6. If the reorder submission fails (network/API error) after a UI reorder has already been optimistically applied, the UI surfaces the failure and reverts to the last known-persisted order rather than silently leaving the on-screen order out of sync with the server.
7. The reorder control is disabled or hidden when there are 0-1 configured services (nothing meaningful to reorder).
8. New/updated tests cover: the reorder API persists correct `sortOrder` values, role-gating matches whatever AC-3 decides, a cross-tenant negative case (an admin/member of project A cannot reorder project B's services), the concurrent-reorder resolution semantics from AC-5, and that the public status page renders services in the persisted order.

## Tasks / Subtasks

- [x] Task 1: Confirm the existing `PUT` route/service wiring still matches this description; no new route expected (AC: 1)
- [x] Task 2: Decide and document the reorder role gate (AC: 3)
- [x] Task 3: Build keyboard-operable reorder UI on the status-page admin screen (AC: 2, 6, 7)
- [x] Task 4: Wire persistence + public-page reflection (AC: 4)
- [x] Task 5: Tests incl. concurrency and cross-tenant behavior (AC: 5, 8)

## Dev Notes

- **This is a smaller story than the raw feedback implies, and smaller than this story's own first draft assumed** — the backend (ordered storage, reorder function, AND the route exposing it — `PUT /api/v1/projects/:projectId/status-page`, MFA-gated, rate-limited, audited) is already fully shipped. This is primarily a web-UI story. Re-verify this claim on start (`status-page-routes.ts:242-291`) since if it's changed since this story was written, that materially changes scope.
- Check `apps/web/src/lib/api/status-page.ts` for whatever web-side API client already exists for status-page management, and extend it rather than creating a parallel client.
- No drag-and-drop library appears to be in use elsewhere in this app (confirm via `apps/web/package.json`) — if none exists, prefer simple up/down move buttons over introducing a new drag-and-drop dependency, unless the user experience clearly warrants it and a lightweight library is justified. Whatever is chosen, keyboard operability (AC-2) is mandatory, not optional.

### Project Structure Notes

- Route/page path for the status-page admin UI should be confirmed exactly during implementation (`apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` is the best guess from existing conventions but must be verified, not assumed).

### References

- [Source: packages/db/src/schema/status-page-services.ts]
- [Source: apps/api/src/modules/monitoring/status-page-service.ts]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

- Confirmed the existing MFA-gated, rate-limited, audited PUT route and preserved its effective project-owner/org-owner authorization gate.
- Added keyboard-operable up/down controls with optimistic persistence and rollback on failure; controls are omitted for zero or one selected service.
- Added API/web regression coverage for ordering, rollback, public rendering, cross-tenant/project isolation, effective authorization, and concurrent last-write-wins behavior. Status-page replacements now serialize per project with a transaction-scoped advisory lock.
- Chrome Playwright validation passed against the isolated stack: owner enabled the public page, selected two endpoints, moved Web Service above API Service, and the unauthenticated public page rendered Web Service first.
- Focused checks passed: web status-page tests (21), API status-page route/public-page tests (44), API typecheck, and Docker web/API builds. Full local CI was not run by request.

### File List

- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte`
- `apps/web/src/routes/status-page-admin.test.ts`
- `apps/api/src/modules/monitoring/status-page-service.ts`
- `apps/api/src/modules/monitoring/status-page-routes.test.ts`
- `apps/api/src/modules/monitoring/public-status-page-routes.test.ts`
- `_bmad-output/implementation-artifacts/18-8-public-status-page-reorder-ui.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`

### Review Findings (bmad-code-review, 2026-07-30)

- [x] [Review][Patch] The API coverage did not exercise a cross-tenant write attempt or a real concurrent stale reorder versus service-add race [apps/api/src/modules/monitoring/status-page-routes.test.ts:377-436]. Added both regression tests; the existing full-replace/last-write-wins contract remains unchanged.
- [x] [Review][Contract] The original AC-3 wording treated the `minimumRole: member` floor as the effective gate, but the pre-existing `preflightOwnedProject` check requires project owner or org owner [apps/api/src/modules/monitoring/status-page-routes.ts:62-79]. Reconciled the story contract to document and preserve the effective owner/org-owner gate; widening access remains a separate product/security decision.
