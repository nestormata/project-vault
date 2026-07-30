# Story 18.7: Dependent Systems List and Form UX Cleanup

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user managing a credential's dependent systems,
I want the list to only show controls that actually do something, and the "Add dependent system" form to stay out of my way until I need it,
so that the page isn't cluttered with a confusing disabled checkbox and a large always-open form I rarely use.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Morgan-member opens a credential's detail page. The Dependent Systems list shows only meaningful, actionable controls per row (the disabled checkbox — confirmed to have no purpose per AC-1 — is gone). The "Add dependent system" form starts collapsed behind an "Add dependent system" toggle/button and expands only when Morgan clicks it.

## Acceptance Criteria

1. **Investigate first, remove only if confirmed dead**: the disabled checkbox next to each dependent-system row (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`, ~lines 1092-1116, rendered with `disabled`/`title={disabledReason}`) is traced to its actual purpose — check whether it's the "Updated" confirmation checkbox tied to `rotation_checklist_items` (per Story 2.10's dependent-system-link + persistent update checkbox feature, which reuses existing rotation-checklist confirmation) and whether it's disabled only in specific contexts (e.g. no active rotation) rather than always. If it genuinely has no purpose outside an active-rotation context, confirm it correctly re-enables during an active rotation and is only "disabled with no objective" outside one — in that case, the real fix per this feedback is likely to **hide** the checkbox entirely when there's no active rotation (rather than showing a permanently-disabled control), not to delete the feature. Document the actual finding in Dev Agent Record before deciding remove-vs-hide-conditionally.
2. If AC-1's investigation confirms the checkbox is genuinely non-functional in all contexts (not just conditionally disabled), it is removed entirely, along with any now-dead `disabledReason`/related state.
3. If AC-1's investigation instead confirms it's the rotation-checklist "Updated" confirmation control (functional only during an active rotation), it is changed to render conditionally — shown and enabled during an active rotation, hidden (not shown-but-disabled) otherwise — rather than removed, since removing it would delete real Story 2.10 functionality. The checkbox must appear/disappear reactively as the credential's rotation state actually changes while a user has the page open (not only computed once at page-load time) — a user already viewing the page when a rotation starts must see the checkbox become available without needing to reload, otherwise they're silently blocked from confirming the update. The transition itself is a deliberate, non-jarring UI change (e.g. accompanied by the same context the rest of the row already gives, not an unexplained control popping in/out) so it doesn't read as the very "fragile UI" bug this epic is trying to fix elsewhere (see Story 18.4).
4. If AC-1's investigation finds a third possibility neither AC-2 nor AC-3 anticipated (e.g. disabled for some other, undocumented reason unrelated to rotation state), the finding and the chosen resolution (favor removal if truly non-functional, favor conditional-hide if it gates on any real state) are documented in Dev Agent Record as an explicit decision point — not silently forced into one of the two anticipated buckets without comment.
5. The "Add dependent system" form (same file, lines ~1171-1267, currently always fully expanded with 5 fields) is collapsed by default behind a toggle button/disclosure labeled "Add dependent system", and expands to show the form when clicked. Use a native `<details>`/`<summary>` element (or an equivalent that provides the same built-in keyboard operability and `aria-expanded` semantics) rather than a bespoke `bind:` boolean toggle with hand-rolled ARIA, unless a specific styling constraint makes that infeasible — document the choice if a custom implementation is used instead.
6. The collapsed/expanded state does not persist across page reloads (simple client-side UI state is sufficient — no new backend/preference storage needed) unless an existing local-UI-state pattern in this codebase already does so cheaply, in which case follow it.
7. Existing dependent-system creation flow (validation, submission, field behavior) is unchanged — this story only changes visibility/disclosure, not the form's fields or behavior.
8. New/updated component tests cover: the checkbox's corrected show/hide-vs-disabled behavior (per whichever of AC-2/AC-3/AC-4 applies) including the actual state transition (checkbox appearing/disappearing as a rotation starts/completes, not just static before/after snapshots), and the add-form's collapsed-by-default / keyboard-operable expand-on-activate behavior.

## Tasks / Subtasks

- [ ] Task 1: Investigate the disabled checkbox's actual purpose (AC: 1)
- [ ] Task 2: Apply the correct fix — remove or conditionally hide (AC: 2, 3)
- [ ] Task 3: Collapse "Add dependent system" form by default (AC: 4, 5, 6)
- [ ] Task 4: Tests (AC: 7)

## Dev Notes

- **Do not remove functionality blindly.** Initial research found this checkbox has `title={disabledReason ?? undefined}` — the presence of a `disabledReason` strongly suggests it's conditionally disabled with an explanation, not permanently dead. `sprint-status.yaml`'s epic-2 history references Story 2-10 adding "dependent-system link + persistent update checkbox reusing existing rotation_checklist_items confirmation" — this is almost certainly the same checkbox, and its purpose is to let a project member confirm they've updated a given dependent system after a credential rotation. If it appears "always disabled" to the user, the likely real bug is that it's disabled *outside* an active rotation but the UI gives no indication why (no title text visible, or the title is unhelpful) — read `disabledReason`'s actual value before deciding whether removal or a hide-when-inactive fix is correct.
- Dependent Systems list/form both live in `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`: list rendering lines ~1082-1169, checkbox at ~1092-1116, "Add dependent system" form at ~1171-1267 (System name, System type select, Notes textarea, conditional "Scope to field" select, Link URL — 5 fields, currently always expanded under a static `<h3>Add dependent system</h3>`).
- Use a simple disclosure pattern (native `<details>`/`<summary>` or a `bind:` boolean + conditional render) — check whether any other "collapsed by default, expand on click" pattern already exists elsewhere in the app (e.g. an accordion/disclosure component) and reuse it rather than inventing a new one.

### Project Structure Notes

- **Explicit sequencing**: this story (18.7) must be implemented and merged *before* Story 18.3 (sitewide contextual help text), which also adds a section description to this same "Dependent systems" region. 18.3 rebases onto this story's structural changes rather than the two landing in parallel against the same unmodified baseline.

### References

- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte]
- Epic 2 / Story 2-10 history: [Source: _bmad-output/implementation-artifacts/sprint-status.yaml]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
