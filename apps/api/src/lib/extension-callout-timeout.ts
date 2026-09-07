/**
 * Story 35.1 Task 4 — extracted from `modules/projects/routes.ts`'s previously-local
 * `PROJECT_CREATE_POLICY_TIMEOUT_MS` so the new `extension-lifecycle-notify.ts` worker can reuse
 * the exact same value (10s) for its own `raceWithTimeout()`-wrapped
 * `projectArchiveNotifier.onProjectArchived()` call, per this story's Design Decision 4 ("reused
 * verbatim, not reinvented"). Originates from Story 25.7 AC1's `extension-panel.ts`
 * `RENDER_PANEL_TIMEOUT_MS`/`module-action-handler.ts` `MODULE_ACTION_TIMEOUT_MS` precedent.
 */
export const EXTENSION_CALLOUT_TIMEOUT_MS = 10_000
