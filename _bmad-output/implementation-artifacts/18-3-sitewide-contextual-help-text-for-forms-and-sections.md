# Story 18.3: Sitewide Contextual Help Text for Forms and Sections

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who isn't a cron/ops expert,
I want plain-language explanations under non-obvious fields (like "Rotation schedule (cron)" and "Cacheable by offline agents") and short descriptions under section headings (like "Dependent systems"),
so that I can fill out forms and understand what a section is for without leaving the app to look things up.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Alex-viewer opens a credential's Lifecycle form, sees "Rotation schedule (cron)" with a one-line explainer and example underneath (e.g. "Standard 5-field cron syntax: minute hour day month weekday. Example: `0 0 1 * *` = midnight on the 1st of every month."), and can fill it in without leaving the page. Alex also sees a short description under "Dependent systems" explaining that these are external systems/consumers that use this credential and must be updated when it rotates.

## Acceptance Criteria

1. A shared, reusable field-help pattern is introduced (generalizing the existing `helperText` prop pattern already used by `TotpCodeInput.svelte`) so help text can be added under any form field consistently — either a new shared `FormField` component or a lightweight shared helper-text snippet/style, whichever fits the codebase's current lack of a shared form-field component without triggering a full form-system rewrite (see Dev Notes — keep this additive, not a forced migration of every existing form). The pattern renders help text as **always-visible static text** directly under the field (not an icon-triggered popover/tooltip) — pinning this down so different fields don't end up with inconsistent interaction patterns — and wires it to the associated input via `aria-describedby` so screen-reader users get the same information sighted users do, not just a visually-adjacent paragraph.
2. "Rotation schedule (cron)" field (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte:806-822`) gets help text explaining standard 5-field cron syntax with a concrete example, plus a link/reference to the existing `nextCronOccurrence` preview if the UI doesn't already show a human-readable "next run" preview — if a next-run preview does not exist, add one using `packages/shared/src/validation/rotation-cron.ts`'s `nextCronOccurrence`.
3. "Cacheable by offline agents" checkbox (same file, lines 824-827) gets help text explaining what enabling it does in plain language (that machine agents without live connectivity may cache/reuse the value locally, and the tradeoff that implies) — copy must be reviewed against the actual behavior gated by the `cacheable` field (`packages/shared/src/schemas/credentials.ts:75`) so it's accurate, not just plausible-sounding.
4. The "Dependent systems" section (credential detail page, ~lines 1082-1267) gets a short description under its heading explaining what dependent systems are and why tracking them matters (they're external consumers of this credential that need updating when it rotates). **Explicit sequencing**: Story 18.7 (checkbox removal/conditional-hide + collapsible add-form) also edits this same section of the same file and must land first; this story rebases its section-description edit onto 18.7's already-merged structural changes rather than the two being implemented in parallel against the same unmodified baseline.
5. At minimum the following fields/sections get help text or a section description (this is the concrete floor): "Add dependent system" form (System type select, Scope-to-field select, Link URL), SSO domain form (`apps/web/src/routes/(app)/settings/sso-domains/+page.svelte`) domain input, machine user creation form's scope/role-affecting fields. Purely self-explanatory fields (e.g. a plain free-text "Name" field with no hidden behavior) may be skipped.
6. **Explicit scope acknowledgment**: the originating feedback asked broadly for "most/all input fields" to have explanations and "most sections" to have descriptions. This story deliberately narrows that to the concrete floor in AC-2/AC-3/AC-4/AC-5 (a named, bounded set of fields and one section) rather than attempting an exhaustive sitewide sweep in a single story — the reusable pattern from AC-1 makes extending coverage to additional forms/sections cheap in a future pass, but that further extension is explicitly out of scope here, not silently dropped.
7. Help text follows a consistent visual style (small, muted, positioned directly under the field/heading it explains) matching `TotpCodeInput.svelte`'s existing `helperText` rendering (`<p class="text-sm text-slate-600">`).
8. New help-text copy is added through the existing Paraglide i18n message system (not hardcoded English strings) — this app already ships `en`/`es` locales (see Story 15.1 and Story 18.11 in this same epic) and new user-facing strings should follow that convention from the start rather than creating an English-only gap to backfill later.
9. No existing form validation, submission behavior, or field values change — this story is copy/UI-only.
10. New/updated component tests assert the help text renders for each touched field/section and is reachable via `aria-describedby` from its input.

## Tasks / Subtasks

- [ ] Task 1: Introduce shared help-text pattern (AC: 1, 7)
- [ ] Task 2: Cron schedule help text + optional next-run preview (AC: 2)
- [ ] Task 3: Cacheable checkbox help text (AC: 3)
- [ ] Task 4: Dependent Systems section description (AC: 4, 6)
- [ ] Task 5: Audit + add help text to remaining major forms (AC: 5)
- [ ] Task 6: Tests (AC: 10)

## Dev Notes

- **No shared FormField/Label component currently exists** — every form hand-rolls `<label class="block text-sm font-medium text-slate-800">` + `<input class="w-full rounded-xl border border-slate-300 px-3 py-2">` inline. Don't force a full migration of every form to a new component as part of this story (that's a much larger refactor); instead add an additive, opt-in pattern (new shared component or a small reusable snippet) and apply it to the fields named in the ACs. Broader adoption can follow in a later story.
- Best existing precedent: `apps/web/src/lib/components/settings/TotpCodeInput.svelte` takes a `helperText: string` prop and renders `<p class="text-sm text-slate-600">{helperText}</p>` under the input — model the new pattern after this.
- The monitoring feature already has a partial field-abstraction worth reviewing for conventions: `apps/web/src/lib/components/monitoring/FieldInput.svelte`, `FieldSelect.svelte`, `ReadOnlyField.svelte`, `CertificateFormFields.svelte`, `DomainFormFields.svelte`.
- Cron field: `packages/shared/src/validation/rotation-cron.ts` exposes `validateRotationCron` and `nextCronOccurrence` (uses `cron-parser`, UTC-pinned, rejects >1/hour frequency) — reuse `nextCronOccurrence` for a live "next run" preview rather than just static help text if feasible; check first whether the form already surfaces a preview before adding one.
- Cacheable field: backed by `cacheable: z.boolean()` in `packages/shared/src/schemas/credentials.ts:75`, DB column from `packages/db/src/migrations/0032_machine_key_rotation_dormancy_cacheable.sql` — read the migration/schema comments and any related rotation/dormancy logic before writing the help copy, to avoid describing behavior it doesn't actually have.
- Dependent Systems list/form all live in `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` lines ~1082-1267.

### Project Structure Notes

- Prefer landing any new shared component under `apps/web/src/lib/components/` (project convention — see `monitoring/` subfolder for a precedent of a feature-scoped shared-component folder).

### References

- [Source: apps/web/src/lib/components/settings/TotpCodeInput.svelte]
- [Source: apps/web/src/lib/components/monitoring/FieldInput.svelte]
- [Source: packages/shared/src/validation/rotation-cron.ts]
- [Source: packages/shared/src/schemas/credentials.ts]
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
