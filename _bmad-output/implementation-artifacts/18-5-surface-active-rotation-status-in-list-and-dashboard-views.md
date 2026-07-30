# Story 18.5: Surface Active Rotation Status in List and Dashboard Views

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a project member,
I want to see at a glance which credentials are currently in the middle of a rotation,
so that I don't have to open each credential's detail page to find out.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Morgan-member opens the credential list for a project and sees a "Rotation in progress" badge next to any credential whose active rotation is currently mid-flight (status `staged`, `in_progress`, or `promoted` — see Dev Notes). Morgan also sees the same indicator on the dashboard's "Upcoming rotations" section for any rotation that's active rather than merely scheduled.

## Acceptance Criteria

1. `apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte` (credential list) shows a distinct badge/indicator on any credential row that has an active (non-terminal) rotation, matching whatever badge visual convention the app already uses for other statuses (e.g. the dashboard's existing `Overdue`/`Scheduled` badges).
2. The dashboard's "Upcoming rotations" section (`apps/web/src/routes/(app)/dashboard/+page.svelte:121-159`) is extended so a rotation currently in an active (non-terminal, non-`scheduled`) state gets its own badge instead of falling through with only `Overdue`/`Scheduled` states handled today.
3. "Active" is precisely defined against the real `rotations.status` state machine (`packages/db/src/schema/rotations.ts:53`, CHECK constraint values: `staged`, `in_progress`, `promoted`, `retired`, `completed`, `abandoned`, `stale_recovery`, `break_glass_complete`): `staged`/`in_progress`/`promoted` count as active/badge-worthy; `retired`/`completed`/`abandoned` are terminal and never badged. `stale_recovery` and `break_glass_complete` are security-adjacent states (the latter specifically tied to break-glass emergency access) — treat both as badge-worthy ("active"/needs-attention) by default rather than silently hiding them, since a break-glass rotation disappearing from view without an explicit badge risks being missed by whoever should be following up on it; if implementation finds a reason to exclude either, that's a deliberate product decision requiring explicit sign-off before merge, not a default left to the implementer.
4. The credential-list load function is extended to fetch each credential's active rotation status without introducing an N+1 query per row via a single new batch/joined query, using the same tenant-scoping mechanism (RLS policy / `withOrg`-style helper / WHERE-clause pattern) already used by sibling rotation queries in `apps/api/src/modules/rotation/` — this is a genuinely new query (confirmed no existing "batch active-rotation-status" helper exists as of this story's authoring), so its correctness is proven by the cross-tenant leak test in AC-8, not by a separate documentation step.
5. For a credential with multiple historical rotations, the badge reflects only the current/most-recent rotation if it is active — the query must not accidentally join to or badge based on an older, already-terminal rotation row.
6. Clicking the badge (or an adjacent link) navigates to the existing rotation detail page (reuse `data.activeRotationId` link pattern already used on the credential detail page, `.../credentials/[credentialId]/+page.svelte:1272-1279`).
7. The badge does not rely on color alone to distinguish "rotation in progress" from `Overdue`/`Scheduled` (colorblind accessibility) — pair color with an icon or distinct label text. Collapsing `staged`/`in_progress`/`promoted` into a single "Rotation in progress" label is acceptable for the badge text itself, but the precise underlying status is exposed via `title`/tooltip for users who need it.
8. New/updated tests cover: badge renders for each relevant status (including explicit cases for `stale_recovery` and `break_glass_complete` per whatever AC-3 decides), does not render for terminal/no-rotation credentials, correctly picks the latest rotation when multiple historical rotations exist for one credential, the query is proven not to leak cross-tenant rotation status (a test asserting a different org's active rotation never appears), and the list/dashboard load functions correctly attach rotation status without breaking existing pagination/filtering (including when the credential list itself is paginated — badge data is fetched per visible page, not the entire unpaginated set).

## Tasks / Subtasks

- [ ] Task 1: Define "active" rotation states precisely (AC: 3)
- [ ] Task 2: Extend credential-list load function + badge UI (AC: 1, 4, 5)
- [ ] Task 3: Extend dashboard upcoming-rotations badge logic (AC: 2, 5)
- [ ] Task 4: Tests (AC: 6)

## Dev Notes

- Rotation state machine lives in `packages/db/src/schema/rotations.ts:53` (status column + CHECK constraint at line ~118) — read the full state machine and any comments describing each state's meaning before deciding the "active" set; don't guess.
- Today rotation status is surfaced **only** on the credential detail page via `data.activeRotationId` (`.../credentials/[credentialId]/+page.svelte:1272-1279`), as a link into the rotation detail page — there is currently no badge anywhere else. This story adds it to the two list-style surfaces that lack it: the credential list and the dashboard's upcoming-rotations section.
- Dashboard section reference: `apps/web/src/routes/(app)/dashboard/+page.svelte`, lines 121-159, currently only branches on `Overdue`/`Scheduled`.
- Reuse Story 5.6's staged/promote/retire rotation model. **Confirmed during review: no existing "batch active-rotation status" helper exists** in `apps/api/src/modules/rotation/` or `apps/web/src/lib/api` — this query needs to be built new. Do not assume a shortcut exists; budget real design/review time for its tenant-scoping and N+1-avoidance rather than treating it as a quick reuse.

### Project Structure Notes

- Keep the new badge component consistent with existing badge styling used for `Overdue`/`Scheduled` on the dashboard — reuse the same component/class if one exists rather than inventing new badge markup.

### References

- [Source: packages/db/src/schema/rotations.ts]
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/+page.svelte]
- [Source: apps/web/src/routes/(app)/dashboard/+page.svelte]
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
