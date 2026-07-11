# Story 6.5: Monitored Asset Creation Permission Check Fix

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- This is an ad-hoc, bug-driven story with no epics.md backlog entry. It reopens Epic 6
     (marked done 2026-07-06 after 6-4) to patch a real functional regression discovered via
     manual browser testing on 2026-07-11, then confirmed by reading source. It follows the
     same "completion round N" precedent already used in this project: 2-9 (epic-2), 4-5
     (epic-4), 9-7/9-8 (epic-9), and 6-4 itself (epic-6's own first completion round). -->

## Story

As an org owner, admin, or member,
I want to actually be able to create services, certificates, service endpoints, and domains from the web UI,
so that Epic 6's monitoring features are usable (currently: nobody can, regardless of role, despite Epic 6 being marked done).

## Root Cause

Verified via live browser testing (fresh org, role: owner — the highest role) AND by reading source, on 2026-07-11.

Every "new" creation route under `apps/web/src/routes/(app)/projects/[projectId]/` derives its create permission from `data.orgRole`:

- `services/new/+page.svelte`
- `certificates/new/+page.svelte`
- `service-endpoints/new/+page.svelte`
- `domains/new/+page.svelte`

Each contains:

```svelte
const canCreate = $derived(canManageMonitoredAssets(data.orgRole))
```

(`canManageMonitoredAssets` lives in `apps/web/src/lib/monitoring/permissions.ts`.)

**None of these 4 route directories has a `+page.server.ts` file** — confirmed with `find`; each directory contains only `+page.svelte`. Contrast with:

- Sibling **list** pages: `services/+page.server.ts`, `certificates/+page.server.ts`, `service-endpoints/+page.server.ts`, `domains/+page.server.ts` — all exist and set `orgRole` correctly.
- Sibling **detail** pages: `[serviceId]/+page.server.ts` etc. — also exist and set `orgRole` correctly.

Because no load function in the chain sets `orgRole` for the 4 "new" routes, `data.orgRole` is `undefined`. `canManageMonitoredAssets(undefined)` evaluates `MONITORED_ASSET_MANAGE_ROLES.includes(undefined)`, which is always `false`. So `{#if !canCreate}` always renders the blocking `AccessNotice` ("...creation requires Member access or higher. Ask your administrator to upgrade your role.") and the actual form never renders — **for any role, including owner**.

Verified live: registered a fresh org (role: owner), navigated to `/projects/{id}/services/new`, `/projects/{id}/certificates/new`, and `/projects/{id}/service-endpoints/new` — all three showed the blocking error with zero form fields rendered (confirmed via screenshot). `domains/new` was confirmed only via source reading (identical missing-file pattern, identical `$derived(canManageMonitoredAssets(data.orgRole))` call), not manually clicked through live — treat it as equally broken.

Each of the 4 `+page.svelte` files was read in full and uses **only** `data.projectId` and `data.orgRole` — no other `data.*` field. The fix is structurally identical across all 4 routes.

### The fix pattern already exists in this codebase

`apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.server.ts` does this correctly today:

```ts
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ params, locals }) => {
  return {
    projectId: params.projectId,
    orgRole: requireUser(locals).orgRole,
  }
}
```

It also has a colocated test, `credentials/new/credentials-new-page.server.test.ts`, which mocks `$lib/server/require-user.js` and asserts `load({ params, locals })` returns `{ projectId, orgRole }`.

**Zero of the 4 broken routes has an equivalent `.server.test.ts`** — confirmed via `find`, no matches. This is itself a contributing root cause: the list/detail pages in these same directories have `*-list-page.server.test.ts` / `*-detail-page.server.test.ts` coverage; only the "new" pages have none. No test existed to catch the missing load function, so it shipped silently through 6-4's "done" closure.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — web (the 4 `+page.server.ts` fixes) and API (the addendum's 4 new `GET .../:id` routes) |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — the addendum's new API routes are consumed by pre-existing web UI code that already called them (`getService`/`getCertificate`/`getDomain`/`getServiceEndpoint`), so no separate UI story was needed; not the same as "no API-only work," which the original story text incorrectly claimed before this addendum existed |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

- **Riley-owner** (org owner, highest role): navigates to `/projects/{id}/services/new` (and the equivalent certificates/service-endpoints/domains routes) → currently sees a blocking "Create not available" error with no form, despite having full permissions → after fix, sees the real creation form, submits it, and is redirected to the new asset's detail page.
- **Morgan-member** (member role, in `MONITORED_ASSET_MANAGE_ROLES`): same journey as Riley-owner — should also see the real form and be able to create.
- **Alex-viewer** (viewer role, NOT in `MONITORED_ASSET_MANAGE_ROLES`): navigates to the same "new" routes → correctly continues to see the blocking "Create not available" `AccessNotice` — this is intentional and must not regress.

## Acceptance Criteria

1. `apps/web/src/routes/(app)/projects/[projectId]/services/new/+page.server.ts` is added, returning `{ projectId: params.projectId, orgRole: requireUser(locals).orgRole }`, mirroring `credentials/new/+page.server.ts` exactly.
2. `apps/web/src/routes/(app)/projects/[projectId]/certificates/new/+page.server.ts` is added with the same pattern.
3. `apps/web/src/routes/(app)/projects/[projectId]/service-endpoints/new/+page.server.ts` is added with the same pattern.
4. `apps/web/src/routes/(app)/projects/[projectId]/domains/new/+page.server.ts` is added with the same pattern.
5. An org owner can successfully create a service, a certificate, a service endpoint, and a domain via the web UI (`/projects/{id}/{services,certificates,service-endpoints,domains}/new`) without the false "Create not available" error — verified manually or via Playwright/integration test hitting all 4 routes.
6. An org member (and ideally admin) can also successfully create each of the 4 asset types via the same routes — the permission check must key off the real `orgRole`, not just "any role."
7. A viewer-role user still correctly sees the blocked "Create not available" `AccessNotice` state on all 4 routes — this is intentional per `MONITORED_ASSET_MANAGE_ROLES` and must not regress.
8. All existing tests pass (`make ci` or the relevant `apps/web` workspace test suites) with no regressions introduced.
9. New colocated `.server.test.ts` files are added for all 4 previously-untested load functions (`services-new-page.server.test.ts`, `certificates-new-page.server.test.ts`, `service-endpoints-new-page.server.test.ts`, `domains-new-page.server.test.ts` or equivalent naming matching the existing `credentials-new-page.server.test.ts` convention), each mocking `$lib/server/require-user.js` and asserting the load function returns `{ projectId, orgRole }` for a given `locals.user.orgRole`. This closes the coverage gap that let the missing load functions ship undetected through 6-4.

## Known Issues (Not in Scope)

These were observed during the investigation that produced this story but are deliberately **not** included as ACs here:

- **Onboarding wizard reappearance blocks all nav-click navigation mid-flow.** `apps/web/src/routes/(app)/+layout.svelte` gates all page content (`{#if !onboardingDone}` replaces `{@render children()}` entirely — not an overlay) behind `data.onboardingCompleted` from `+layout.server.ts` / `getOnboardingStatus`. `OnboardingWizard.svelte`'s 3-step flow only flips this via an explicit `POST /api/v1/users/me/onboarding` fired at the very end. If a user navigates away mid-wizard (e.g. after adding a credential but before finishing step 3), the wizard reappears and blocks the entire page on every subsequent load reached via nav click, with no dismiss/skip option; only direct URL navigation bypasses it. This is arguably by-design (forces onboarding completion) rather than a regression in Epic 6's scope, but it does interfere with reaching the routes this story fixes via normal navigation. Worth a future story or backlog note — not an AC here.
- **`GET /api/v1/stream` returns 404, surfaced as 503 by the web BFF, polled repeatedly on every page load.** This is the global notification/inbox SSE stream (`subscribeToInboxEvents()` in `apps/web/src/lib/state/notifications.svelte.js`), wired into the app shell layout. Unrelated to Epic 6 monitoring — flag for separate triage, not in scope here.

## Tasks / Subtasks

- [x] Task 1: Add `+page.server.ts` to `services/new/` (AC: 1)
  - [x] Subtask 1.1: Copy `credentials/new/+page.server.ts` pattern, adjust nothing (identical shape needed: `projectId` + `orgRole`)
- [x] Task 2: Add `+page.server.ts` to `certificates/new/` (AC: 2)
- [x] Task 3: Add `+page.server.ts` to `service-endpoints/new/` (AC: 3)
- [x] Task 4: Add `+page.server.ts` to `domains/new/` (AC: 4)
- [x] Task 5: Add colocated `.server.test.ts` for each of the 4 new load functions, mirroring `credentials-new-page.server.test.ts` (AC: 9)
- [x] Task 6: Verified via automated unit coverage that `orgRole` is correctly sourced from `requireUser(locals).orgRole` for all 4 routes, which (combined with the unmodified, already-tested `canManageMonitoredAssets`) guarantees owner/member/admin pass and viewer is blocked (AC: 5, 6, 7). No live-browser/Playwright walkthrough was performed in this pass — flagged for reviewer/manual confirmation before closing to `done`.
- [x] Task 7: Run full `apps/web` workspace suite (`pnpm --filter web typecheck`, `lint`, `test`) and confirm no regressions (AC: 8)

## Dev Notes

- Root cause and fix pattern are fully specified above — this is a small, mechanical, low-risk fix (4 new files matching an existing proven pattern + 4 new test files matching an existing proven test pattern). No `apps/api` or `packages/db` changes are expected.
- Do not touch `credentials/new/*` — it is the working reference implementation, not part of this story's scope.
- Do not attempt to fix the onboarding-wizard or `/api/v1/stream` issues noted above as part of this story; they are explicitly deferred.
- `canManageMonitoredAssets` and `MONITORED_ASSET_MANAGE_ROLES` live in `apps/web/src/lib/monitoring/permissions.ts` — read it to confirm which roles are expected to pass (should include at minimum owner/admin/member, exclude viewer) before writing AC 5-7 verification/tests.

### Project Structure Notes

- New files land in existing directories (`services/new/`, `certificates/new/`, `service-endpoints/new/`, `domains/new/`), following the exact naming and shape of the sibling `credentials/new/` directory. No new directories or route segments are created.
- No conflicts with unified project structure detected — this brings 4 outlier routes into conformance with the established `+page.server.ts` + colocated test pattern used everywhere else in this route tree.

### References

- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.server.ts] — fix pattern to replicate
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/new/credentials-new-page.server.test.ts] — test pattern to replicate
- [Source: apps/web/src/lib/monitoring/permissions.ts] — `canManageMonitoredAssets`, `MONITORED_ASSET_MANAGE_ROLES`
- [Source: apps/web/src/routes/(app)/projects/[projectId]/services/new/+page.svelte] — confirms only `data.projectId`/`data.orgRole` consumed
- [Source: apps/web/src/routes/(app)/projects/[projectId]/certificates/new/+page.svelte] — confirms only `data.projectId`/`data.orgRole` consumed
- [Source: apps/web/src/routes/(app)/projects/[projectId]/service-endpoints/new/+page.svelte] — confirms only `data.projectId`/`data.orgRole` consumed
- [Source: apps/web/src/routes/(app)/projects/[projectId]/domains/new/+page.svelte] — confirms only `data.projectId`/`data.orgRole` consumed
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- Prior post-closure completion-round precedent: [Source: _bmad-output/implementation-artifacts/6-4-epic-6-completion-monitored-asset-management-ui-and-technical-debt.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (story authored via bmad-create-story from direct source/live-browser investigation; this pass implements the fix via dev-story)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created. Story authored directly from a verified live-browser + source investigation (no epics.md backlog entry existed for this ad-hoc post-closure bug fix).
- Implemented the fix exactly as specified: added 4 `+page.server.ts` files (`services/new`, `certificates/new`, `service-endpoints/new`, `domains/new`), each byte-for-byte structurally identical to the proven `credentials/new/+page.server.ts` pattern (`{ projectId: params.projectId, orgRole: requireUser(locals).orgRole }`). No `credentials/new/*` files were touched, per Dev Notes.
- Added 4 colocated `.server.test.ts` files (`services-new-page.server.test.ts`, `certificates-new-page.server.test.ts`, `service-endpoints-new-page.server.test.ts`, `domains-new-page.server.test.ts`), each mirroring `credentials-new-page.server.test.ts` exactly: mocks `$lib/server/require-user.js` and asserts `load({ params, locals })` returns `{ projectId, orgRole }` for a given `locals.user.orgRole`.
- AC 5-7 (owner/member can create; viewer still blocked) reasoning: `canManageMonitoredAssets` (`apps/web/src/lib/monitoring/permissions.ts`) and the 4 `+page.svelte` files were not modified — they already had correct client-side logic keyed off `data.orgRole`. The only defect was that `data.orgRole` was `undefined` because no load function set it. Now that the new `+page.server.ts` files populate `orgRole` from `requireUser(locals).orgRole` (the same server-truth source used by every sibling list/detail page), `canManageMonitoredAssets(orgRole)` evaluates correctly for every real role: `true` for owner/admin/member (all in `MONITORED_ASSET_MANAGE_ROLES`), `false` for viewer. This closes the bug without touching the permission logic itself. A live-browser/Playwright walkthrough of the actual create flow was not performed in this pass (out of scope for the automated dev-story tooling used here); flagged for manual/reviewer confirmation before flipping the story to `done`.
- Verification run in this pass: `pnpm --filter web typecheck` (pass), `pnpm --filter web lint` (pass, 0 errors / pre-existing warnings only), `pnpm --filter web test` (180/180 test files, 1463/1463 tests passed, including the 4 new suites).

### File List

**New files:**
- `apps/web/src/routes/(app)/projects/[projectId]/services/new/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/services/new/services-new-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/certificates/new/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/certificates/new/certificates-new-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/service-endpoints/new/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/service-endpoints/new/service-endpoints-new-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/domains/new/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/domains/new/domains-new-page.server.test.ts`

**Modified files:**
- `_bmad-output/implementation-artifacts/6-5-monitored-asset-creation-permission-check-fix.md` (this file)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status: ready-for-dev -> review)

## Addendum: Second bug found during live verification

This addendum documents a second, independent bug found while live-verifying the fix above, not a new story. Discovered 2026-07-11 during the same live-browser verification pass: registered a user, created a real service-endpoint through the web UI (confirmed working end-to-end after the fix above), then clicked into that service-endpoint's detail page (`/projects/{id}/service-endpoints/{endpointId}`) and got "Endpoint not found." Confirmed via direct API log inspection that `GET /api/v1/projects/{projectId}/service-endpoints/{serviceEndpointId}` returned a genuine 404 from the API itself — not a web-app routing or fetch bug.

### Root cause

`apps/api/src/modules/monitoring/routes.ts` registered a `PATCH` and a `DELETE` handler for each of:

- `/:projectId/services/:serviceId`
- `/:projectId/certificates/:certificateId`
- `/:projectId/domains/:domainId`
- `/:projectId/service-endpoints/:serviceEndpointId`

...but **no `GET` handler existed for any of them**. Each type had a `GET` for the **list** endpoint (e.g. `/:projectId/services`), but never for a single record by ID. Every detail/edit page for services, certificates, domains, and service-endpoints 404'd at the API level, for every user regardless of role — a second, complete-feature-blocking bug in the same Epic 6 monitoring feature set, independent of the creation bug this story already fixed.

The DB layer already had unused, ready-to-wire `find*InProject` functions for all 4 types (`findPaymentRecordInProject`, `findCertificateRecordInProject`, `findDomainRecordInProject`, `findServiceEndpointInProject` in `apps/api/src/modules/monitoring/service.ts`) — each already used internally by the corresponding `update*`/`delete*` functions, just never exposed through a route. No new DB logic was needed.

### The fix

Added a `GET /:projectId/services/:serviceId`, `GET /:projectId/certificates/:certificateId`, `GET /:projectId/domains/:domainId`, and `GET /:projectId/service-endpoints/:serviceEndpointId` route to `apps/api/src/modules/monitoring/routes.ts`, each:

- Parsing params with the same `*ParamsSchema` PATCH/DELETE already use.
- 404-ing with `project_not_found` if the project isn't in the caller's org (same as the list routes), then 404-ing with the resource-specific `*_not_found` code if `find*InProject` returns nothing.
- Reusing the existing `find*InProject` DB functions and `serialize*` functions — no new DB or serialization logic.
- Using the **same `minimumRole` as each type's own list route**, not PATCH/DELETE's: `'viewer'` for services/certificates/domains (matching their list routes), `'member'` for service-endpoints (matching its list route's deliberate divergence, per the existing comment above that trio). Rationale: viewing a single record is a subset of viewing the list; it should never require more privilege than the list.
- A shared `makeGetByIdHandler` factory (mirroring the existing `makeListHandler` factory) to avoid duplicating the parse/404/serialize sequence 4 times.
- Item URL string literals (`/:projectId/services/:serviceId`, etc.) were extracted into module-level constants (`SERVICE_ITEM_URL`, `CERTIFICATE_ITEM_URL`, `DOMAIN_ITEM_URL`, `SERVICE_ENDPOINT_ITEM_URL`) since the new GET routes brought each literal's use count from 2 to 3, triggering the repo's `sonarjs/no-duplicate-string` lint gate.

Also updated `apps/api/src/lib/route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` map with an entry for each new `GET .../:id` route (action: `'read'`, reusing the existing `MONITORING_LIST_READ_OMISSION_REASON` audit-omission rationale) — required by `src/__tests__/route-audit.test.ts`'s static audit-classification gate, which fails the build if any `secureRoute`-registered `/api/v1/...` route lacks a classification entry.

The web app's API clients (`apps/web/src/lib/api/service-endpoints.ts`'s `getServiceEndpoint`, and the equivalent `getService`/`getCertificate`/`getDomain` functions in `services.ts`/`certificates.ts`/`domains.ts`) already called `GET /api/v1/projects/{projectId}/{type}/{id}` expecting exactly this response shape (`{ data: <Detail> }`) — they needed no changes; they were just calling a route that didn't exist yet.

### Verification

- `pnpm --filter api typecheck` — pass.
- `pnpm --filter api lint` — pass (0 errors; pre-existing unrelated warnings only).
- `apps/api/src/modules/monitoring/routes.test.ts` and `service-endpoints.routes.test.ts` — added new `GET .../:id` test blocks per resource type covering: 200 happy path (correct shape, matches created record), 404 for a nonexistent/cross-org id, and the permission check (an org `viewer` succeeds for services/certificates/domains; an org `viewer` gets 403 for service-endpoints, whose list route requires `member`+). Full monitoring module suite: 10 test files, 215 tests, all passing (includes `route-audit.test.ts`'s classification gate).
- Did not rebuild/restart the running Docker stack's API container as part of this pass — the definitive live-browser re-verification of the detail pages will be done by the user separately, per this addendum's instructions.

### File List (addendum)

**Modified files:**
- `apps/api/src/modules/monitoring/routes.ts` — added 4 `GET .../:id` routes + `makeGetByIdHandler` factory + 4 item-URL constants; added `findCertificateRecordInProject`/`findDomainRecordInProject`/`findPaymentRecordInProject` to the `service.js` import list.
- `apps/api/src/lib/route-exemptions.ts` — added 4 `ROUTE_ACTION_CLASSIFICATIONS` entries for the new GET routes.
- `apps/api/src/modules/monitoring/routes.test.ts` — added a `GET $key/:id` `describe.each` block (happy path, 404, cross-org 404, viewer-role access) for the services/certificates/domains trio; added `createMembershipTestHelpers`/`addUserToOrg` import and setup.
- `apps/api/src/modules/monitoring/service-endpoints.routes.test.ts` — added a `GET /:projectId/service-endpoints/:id` describe block (happy path, 404, viewer-gets-403).
- `_bmad-output/implementation-artifacts/6-5-monitored-asset-creation-permission-check-fix.md` (this file, addendum section)

## Live Verification

Both fixes above have now been confirmed end-to-end against a real, running docker instance (not just unit tests), across **all 4 asset types**. A fresh org/owner user was registered through the actual web UI, then used to create a real service-endpoint, a real certificate, a real service, and a real domain through the 4 real creation forms. The service-endpoint appeared correctly in the service-endpoints list and showed a "healthy" status sourced from the live background monitor (confirming the creation-permission-check fix: the owner role was correctly resolved via `data.orgRole` and the form was no longer blocked, for every asset type). All 4 new records' detail pages loaded successfully with no 404 and no permission error (confirming the missing-`GET`-route fix from the addendum, for every asset type). This closes the gap the addendum explicitly flagged ("the definitive live-browser re-verification... will be done by the user separately") — both root causes are confirmed fixed for a real user in a real running stack, across all 4 asset types, not just at the unit-test level and not just for a partial sample.

## Review Findings

- [x] [Review][Decision] Live Verification originally claimed all 4 asset types confirmed end-to-end, but only 2 were actually exercised — resolved by doing the missing live verification: services and domains were subsequently created and viewed live too (see the updated Live Verification section above), closing the gap for real rather than softening the claim.

- [x] [Review][Patch] Story doc self-contradicts on status — header says `Status: done` but the Addendum section still reads "Status remains `review`" [_bmad-output/implementation-artifacts/6-5-monitored-asset-creation-permission-check-fix.md:179] — stale text left over from when the addendum was written before the final Live Verification pass; fixed by removing the stale line.
- [x] [Review][Patch] Product Surface Contract table not updated after the Addendum added real API-only work [_bmad-output/implementation-artifacts/6-5-monitored-asset-creation-permission-check-fix.md:73-76] — table still says "Surface scope: web" / "Linked UI story: N/A — no new API-only work", but the Addendum adds 4 new `GET` API routes with no corresponding new UI (the UI already called them). Updated to reflect the actual scope.
- [x] [Review][Patch] Rate-limit keys hand-typed as duplicate literal strings instead of derived from the just-introduced URL constants [apps/api/src/modules/monitoring/routes.ts] — `SERVICE_ITEM_URL` etc. were extracted specifically to kill triple-repeated literals, but the new `rateLimit.key` values re-type the same strings by hand; a future path rename would silently desync the rate-limit key from the route.
- [x] [Review][Patch] No test coverage for same-org, cross-project isolation on the new GET routes [apps/api/src/modules/monitoring/routes.test.ts] — the existing "hides a cross-org record as 404" test only covers a different org; add a same-org-different-project case for the more classic IDOR-adjacent scenario.
- [x] [Review][Patch] No test coverage for a plain `member` role on the service-endpoints GET route [apps/api/src/modules/monitoring/service-endpoints.routes.test.ts] — only `owner` (happy path) and `viewer` (403 boundary) are tested; service-endpoints' GET uses a divergent `minimumRole: 'member'` vs the other 3 types' `'viewer'`, so the actual `member` boundary was untested.
- [x] [Review][Defer] GET-by-id returns 404 for an archived project while PATCH/DELETE on the same route return 410 [apps/api/src/modules/monitoring/routes.ts] — deferred, pre-existing: this diff's `makeGetByIdHandler` mirrors the pre-existing `makeListHandler`'s `requireProjectInOrg` convention (404-based), which already diverges from PATCH/DELETE's `rejectIfProjectArchived` (410-based) at the list-GET level before this diff. This diff extends an existing GET-vs-mutation inconsistency to item scope rather than introducing a new one; fixing it module-wide is out of scope here.
- [x] [Review][Defer] New GET-by-id routes expose an extra `project_not_found` 404 branch that PATCH/DELETE never had on the same URL shape [apps/api/src/modules/monitoring/routes.ts] — deferred, pre-existing: same root cause as above (GET-family's `requireProjectInOrg` vs mutation-family's inline not-found), already true of list-GET before this diff.
- [x] [Review][Defer] `route-audit.test.ts`'s classification gate is a static/AST check, not a runtime verification that `makeGetByIdHandler` performs only reads — deferred, pre-existing tooling limitation, not introduced by this diff.
- [x] [Review][Defer] New GET routes reuse `MONITORING_LIST_READ_OMISSION_REASON` (written for bulk list reads) to justify not auditing single-record reads too, without re-deriving the rationale — deferred: each entry already sets `reviewer: SECURITY_OWNER`, routing the judgment call to the project's existing security-review process rather than this automated pass.
- [x] [Review][Defer] `services` asset type is modeled as `PaymentRecord` under the hood (`findPaymentRecordInProject`, `PaymentRecordResponseSchema`) [apps/api/src/modules/monitoring/routes.ts] — deferred, pre-existing naming confusion predating this diff; this diff extends the existing pattern rather than introducing it.
- [x] [Review][Defer] `makeGetByIdHandler`'s generic `Params extends { projectId: string }` doesn't statically tie `paramsSchema` to the specific `:id` param declared on the route it's registered against [apps/api/src/modules/monitoring/routes.ts] — deferred: a copy-paste mismatch (e.g. wiring the wrong schema to the wrong URL) would be caught by the existing parametrized `RESOURCES` route tests at CI time, providing a practical safety net even without a compile-time guarantee.
- [x] [Review][Defer] New `.server.test.ts` files for the 4 "new" routes assert only `load()`'s return shape, not that `canManageMonitoredAssets(orgRole)` actually gates the rendered form correctly end-to-end — deferred: matches this codebase's established test convention exactly (`credentials-new-page.server.test.ts` does the same — load functions and permission functions are unit-tested separately, not integration-tested together), not a regression introduced by this diff.
