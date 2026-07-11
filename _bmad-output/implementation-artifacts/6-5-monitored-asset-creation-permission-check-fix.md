# Story 6.5: Monitored Asset Creation Permission Check Fix

Status: review

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
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story fixes existing web UI, no new API-only work |
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
