# Story 13.5: Rotation Same-Value Confirmation, Dependency Field-Key Scoping, and Per-Field Rotation Values

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user rotating a multi-field secret or managing its dependent-system links,
I want the system to stop me before silently "rotating" a field to the value it already had, let me scope a dependency to a specific field at creation time, and let me set a different new value per targeted field in one rotation,
so that rotations stay meaningful, dependency checklists stay accurately scoped from the moment a dependency is created (not only after a follow-up edit), and multi-field rotations don't force every selected field to the same new value.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — amends the rotation-initiation API (`apps/api/src/modules/rotation/service.ts`/`routes.ts`/`schema.ts`) and its web UI (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte`), plus the dependency-creation API (`apps/api/src/modules/credentials/schema.ts`/`dependencies-service.ts`/`routes.ts`) and its web UI (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`, the "Add dependency" form). An API-only version of either half would silently ship a capability with no way to reach it, repeating the exact "prose limitation, no tracked UI" pattern this story exists to close (see epic-13-retro-2026-07-27.md Findings 2 & 3). |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI changes are in-scope in this same story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (org admin, rotation initiator), attempting a same-value rotation:** opens a credential's `/rotate` page, selects (or defaults to) a field, types in a new value that happens to be identical to the field's current value (e.g. pastes from an old clipboard entry by mistake), clicks "Start rotation" → instead of the rotation silently succeeding (today's behavior — a same-value rotation completes with no user-visible signal beyond a server log line), the UI shows an inline confirmation prompt: "The new value for `password` is identical to its current value. Rotate anyway?" with **Confirm** / **Cancel** buttons → if Riley clicks **Confirm**, the request is resubmitted with `confirmSameValue: true` and the rotation proceeds exactly as before (staged version created, checklist built); if Riley clicks **Cancel**, no rotation is created and Riley returns to the form with their entered value preserved so they can fix it.

**Riley-admin, scoping a dependency at creation time:** opens a multi-field credential (e.g. "Prod DB" with `username`/`password`) → clicks "Add dependency" → the existing form (system name, type, notes, link) now also shows an optional "Scope to field" dropdown (populated from the credential's current field keys, plus a default "Whole credential" option) when the credential has 2+ fields (hidden entirely for single-field/legacy credentials, matching the rotation field-selector's own `field_meta.length > 1` gating convention from Story 13.4) → Riley selects `password`, submits → the new dependency is created with `field_key: "password"` and immediately appears only on rotation checklists that target `password` or the whole secret — no follow-up edit needed.

**Riley-admin, rotating two fields to two different values in one operation:** on `/rotate` for "Prod DB", selects both `username` and `password` in the field-selector (Story 13.4's checkbox UI) → instead of one shared value textarea, the form now renders one labeled value input per selected field (`username: [____]`, `password: [____]`) → Riley enters a different value for each, submits → `POST .../rotations` body is `{ targetFields: ["username","password"], fieldValues: { username: "svc-2", password: "new-pw" } }` → the staged version has both fields updated to their respective distinct values.

**Morgan-member (dependent-system owner, checklist confirmer):** sees the same checklist UI as always — a dependency scoped to `password` at creation continues to only appear on `password`-or-whole-secret rotations, no behavior change from their perspective versus a dependency that was scoped via a later edit (this story adds no dependency-edit capability for `field_key`; that stays out of scope, see Dev Notes).

**Alex-viewer (read-only):** never reaches `/rotate` or the "Add dependency" form (existing `canManageRotations`/`canManageDependencies` gates, unchanged by this story).

**Legacy single-value secret (`schema_version = 1`) or a single-field credential:** the "Scope to field" dropdown does not render on dependency creation (mirrors the rotation field-selector's own single-field gating); a same-value rotation attempt on a legacy secret still gets the confirmation prompt (the same-value check already applies to whole-secret rotation today, this story only adds a blocking gate, not a new comparison path); the per-field value inputs never render for a whole-secret or single-field-targeted rotation — the existing single value textarea is unchanged in that case.

## Acceptance Criteria

> **Scope note:** This story closes epic-13-retro-2026-07-27.md's Findings 2 and 3 — both were prose-only "deferred to a later story" claims (13-2's "Story 13.5" forward reference for a same-value check; 13-4's two explicit scope exclusions) that never became tracked backlog rows. Investigation at story-creation time (grep + direct code read of `apps/api/src/modules/rotation/service.ts` and `apps/api/src/modules/rotation/routes.ts`, 2026-07-27) found the same-value **check** already exists and is fully correct (`computeSameValueAsPrevious()`, `constantTimeEqual()`) — it is **warn-only**, logging `ROTATION_INITIATE_SAME_VALUE_WARNING` and returning `sameValueAsPrevious: true` in the response, but never blocking or requiring confirmation. AC-1 through AC-4 below close that gap by converting the existing detection into an actual confirmation gate, not by rebuilding detection from scratch.

### AC-1: A same-value rotation is rejected before any write unless explicitly confirmed

**Given** `initiateRotation()` has already computed `sameValueAsPrevious: true` for a request (via the existing `computeSameValueAsPrevious()`, unchanged detection logic) and the request body does not include `confirmSameValue: true`,
**When** the rotation would otherwise proceed to insert its `rotations`/`credential_versions`/checklist rows,
**Then** the request is rejected before any write with `409 { code: "same_value_confirmation_required", field: "<targeted field key or null for whole-secret>" }` — no `rotations` row, no `credential_versions` row, no checklist rows, no audit entry are created on rejection (mirrors AC-3's existing "all-or-nothing" convention from Story 13.4 for `unknown_field_key`).

**Example (happy path — whole-secret, no confirmation, rejected):** Credential "API token" (legacy, `schema_version = 1`) current value `"tok_abc123"`. Riley submits `{ newValue: "tok_abc123" }` (identical, no `confirmSameValue`). Response: `409 { code: "same_value_confirmation_required", field: null }`. Zero rows written.

**Example (field-scoped, no confirmation, rejected):** Credential "Prod DB" `password` currently `"old-pw"`. Riley submits `{ targetFields: ["password"], newValue: "old-pw" }` (no `confirmSameValue`). Response: `409 { code: "same_value_confirmation_required", field: "password" }`. Zero rows written.

**Example (edge — multi-field with `fieldValues`, only one field matches):** Credential "Prod DB" `username: "svc-1"`, `password: "old-pw"`. Riley submits `{ targetFields: ["username","password"], fieldValues: { username: "svc-2", password: "old-pw" } }` (AC-5's per-field map; `password`'s new value matches its current value, `username`'s does not). `computeSameValueAsPrevious()` (extended by AC-2 below to compare per-field when `fieldValues` is present) reports same-value for the `password` field only → `409 { code: "same_value_confirmation_required", field: "password" }` — a partial same-value match on a multi-field request still blocks the whole request, consistent with AC-3-of-13.4's all-or-nothing validation convention for multi-field requests.

---

### AC-2: `confirmSameValue: true` proceeds exactly as today's warn-only rotation did, plus an audit-visible confirmation flag

**Given** a request that previously would have been rejected under AC-1 (`sameValueAsPrevious` true),
**When** the request includes `confirmSameValue: true`,
**Then** the rotation proceeds exactly as it does today (unchanged staged-version/checklist creation), the response still includes `sameValueAsPrevious: true` (unchanged field, for API-client backward compatibility with anything already reading it), and the `ROTATION_INITIATED` audit entry's payload additionally includes `sameValueConfirmed: true` — so an auditor can distinguish "rotated to an identical value, confirmed" from a normal rotation without needing to separately correlate the operational warning log line.

**Example (happy path):** Same "Prod DB" `password` scenario as AC-1's field-scoped example, resubmitted as `{ targetFields: ["password"], newValue: "old-pw", confirmSameValue: true }`. Rotation proceeds: staged version created (with `password` unchanged in value but a new `credential_versions` row/version number, matching today's existing same-value-rotation write behavior), checklist built, audit entry payload includes `sameValueConfirmed: true`. Response `201` with `sameValueAsPrevious: true`.

**Example (edge — `confirmSameValue: true` on a request that is NOT same-value):** Riley submits `{ newValue: "genuinely-new-value", confirmSameValue: true }` where the value differs from current. `sameValueAsPrevious` computes `false`; `confirmSameValue` is simply ignored (not an error) — the rotation proceeds as a completely normal rotation, and the audit payload omits `sameValueConfirmed` entirely (only present when a same-value confirmation actually happened) rather than writing `sameValueConfirmed: false` on every single rotation, keeping the audit payload's existing shape unchanged for the overwhelming majority (non-same-value) case.

---

### AC-3: The web rotation form intercepts a same-value submission client-side and shows a confirm/cancel prompt before the confirmed retry

**Given** the rotation-initiation form (`apps/web/.../rotate/+page.svelte`),
**When** the initial `POST` receives `409 same_value_confirmation_required`,
**Then** the form does not show a generic error — it shows an inline confirmation prompt naming the affected field (or "the secret" for whole-secret rotation) with **Confirm** and **Cancel** actions; **Confirm** resubmits the exact same request body plus `confirmSameValue: true`; **Cancel** dismisses the prompt and returns focus to the value input(s) with the user's entered value(s) still populated (no data loss, no page reload).

**Example (happy path):** Riley enters an identical password value on a field-scoped rotation, submits. Prompt appears: "The new value for `password` is identical to its current value. Rotate anyway?" Riley clicks Confirm → the retried request succeeds, Riley is routed to the rotation detail page exactly as any successful rotation today.

**Example (edge — Cancel, then genuinely change the value):** Same scenario, Riley clicks Cancel instead, edits the `password` field to a real new value, clicks "Start rotation" again → this second submission is a fresh request with the new (different) value and no `confirmSameValue` flag — it succeeds immediately with no prompt, since `sameValueAsPrevious` now computes `false`.

---

### AC-4: Concurrent same-value confirmation does not create a duplicate/conflicting rotation

**Given** two near-simultaneous confirmed same-value rotation requests on the same credential (e.g. a double-click on "Confirm," or two browser tabs),
**When** both reach the server,
**Then** the existing credential-level advisory lock and `409 rotation_in_progress` conflict path (Story 13.4 AC-6, unchanged) governs exactly as it does for any other concurrent rotation attempt — the same-value confirmation flow introduces no new concurrency primitive and is not exempt from the existing one-active-rotation-per-credential invariant.

**Example:** Two confirmed requests race; one wins and creates the staged rotation, the other receives `409 { code: "rotation_in_progress", rotationId: "<winner's id>" }` — identical to today's existing double-submit behavior for any rotation, same-value or not.

---

### AC-4.1 (Dev-time decision, not a new AC): break-glass rotation is deliberately exempt from the same-value confirmation gate

`POST .../rotations/break-glass` (`BreakGlassRotationBodySchema`, a distinct schema/route from normal initiation) is a separate incident-response path (Story 5.3 AC-23) used when a credential is suspected compromised. AC-1's confirmation gate is **not** applied there: an incident responder re-staging the same value on purpose (or under time pressure, unsure whether it changed) must never be blocked by a confirmation round-trip during an active incident. This is a deliberate, explicit exclusion — recorded here precisely so it does not become a third untracked "Story 13.5"-style prose deferral the way 13-2/13-4's exclusions did (the exact failure pattern this story exists to close, per epic-13-retro-2026-07-27.md). If break-glass same-value visibility is wanted later, it is a new, separately-scoped story — not an inferred extension of this one.

---

> **Scope note (AC-5/AC-6):** Closes 13-4's second undocumented scope exclusion: dependency-creation currently has no way to set `field_key` (always `NULL`/whole-credential). The read-side filter (`field_key IS NULL OR field_key = ANY(target_fields)`) already exists and is unchanged.

### AC-5: Dependency creation accepts an optional `fieldKey`, validated against the credential's current field set

**Given** `POST .../credentials/:credentialId/dependencies` (`addCredentialDependency()`, `apps/api/src/modules/credentials/dependencies-service.ts`) and a credential with `field_meta` (multi-field, `schema_version = 2`, 2+ declared fields) or without (legacy/single-field),
**When** the request body includes an optional `fieldKey: string`,
**Then** the key is normalized via the existing shared `normalizeFieldKey()` (`packages/shared/src/credential-templates.ts`, the same helper `validateTargetFields()` in `apps/api/src/modules/rotation/service.ts` already uses) and validated against the credential's current declared field keys (loaded via the credential's current version's `field_meta`, the same source rotation's own validation reads); an unrecognized key is rejected with `400 { code: "unknown_field_key", field: "<key>" }` (reusing the exact error code Story 13.3/13.4 already established for this failure shape) before any row is written; when `fieldKey` is omitted, the dependency is created with `field_key: NULL` (today's existing, unchanged default).

**Example (happy path):** Credential "Prod DB" (`username`, `password`). Riley creates a dependency `{ systemName: "Backup Script", fieldKey: "password" }`. The new `credential_dependencies` row has `field_key: "password"`. It appears on a `password`-targeted or whole-secret rotation's checklist, not on a `username`-only rotation's checklist (per the existing, unchanged `dependencyChecklistFilter()` read path).

**Example (edge — unrecognized field key rejected):** Same credential, Riley submits `{ systemName: "Ghost System", fieldKey: "ssh_key" }` (no such field exists). Response: `400 { code: "unknown_field_key", field: "ssh_key" }`. No `credential_dependencies` row is created.

**Example (edge — legacy/single-field credential, `fieldKey` provided anyway):** Credential "Legacy Token" is `schema_version = 1` (reports one synthetic field, `DEFAULT_FIELD_KEY`, per `fieldMetaForResponse()`). Riley (or a scripted API client) submits `fieldKey: "value"` matching that synthetic key — this is accepted (it validates against the synthetic single-field key exactly like any other declared key) but has no practical filtering effect, since every rotation on a legacy credential is implicitly whole-secret (`target_fields: NULL`, unfiltered checklist per Story 13.4 AC-4/AC-7) — document this as expected, not a bug: the validation is uniform across schema versions even though field-scoped filtering itself only has observable effect on multi-field credentials.

**Example (edge — omitted `fieldKey`, unchanged default):** Riley submits `{ systemName: "CI Pipeline" }` (no `fieldKey`). `field_key: NULL` — identical to every dependency created before this story; appears on every rotation's checklist regardless of `targetFields`, unchanged.

---

### AC-6: The web dependency-creation form exposes a field-scope selector for multi-field credentials, and API responses expose `fieldKey`

**Given** the "Add dependency" form (`apps/web/.../credentials/[credentialId]/+page.svelte`) and `serializeDependency()` (`apps/api/src/modules/credentials/dependencies-service.ts`),
**When** the credential has `field_meta.length > 1` (the same gating condition Story 13.4's rotation field-selector already uses),
**Then** the form renders an optional "Scope to field" dropdown (options: each declared field key, plus a default "Whole credential" entry mapping to omitted `fieldKey`) that wires into the `POST` body's `fieldKey`; for a single-field/legacy credential, the dropdown does not render at all (matches AC-5's legacy example — no dead UI for a case with no practical effect); and every dependency API response (list + create) now includes `fieldKey: string | null` via `serializeDependency()`, surfaced in the existing dependency list UI as a small scope badge (e.g. "Scoped to: password" / no badge for whole-credential) so Morgan-member can see at a glance which rotations will include a given dependency.

**Example (happy path):** Riley opens "Add dependency" on "Prod DB" (2 fields). Sees the scope dropdown, selects "password", submits. The new dependency row in the list shows a "Scoped to: password" badge.

**Example (edge — legacy credential, no dropdown):** Riley opens "Add dependency" on "Legacy Token" (1 field). No scope dropdown renders — form is visually identical to pre-this-story behavior.

**Example (edge — existing pre-story dependencies, list view):** Any dependency created before this story (or via AC-5 with `fieldKey` omitted) shows no scope badge (whole-credential) — no migration/backfill needed since `field_key` was already nullable-default-`NULL` from Story 13.4's migration 0055.

---

> **Scope note (AC-7/AC-8):** Closes 13-4's first undocumented scope exclusion: a multi-field rotation currently forces one shared `newValue` onto every targeted field. `InitiateRotationBodySchema.newValue` stays required (backward compatible with every existing API client) — `fieldValues` is a new, optional, additive per-field override.

### AC-7: Rotation accepts an optional per-field `fieldValues` map; when present, it — not the shared `newValue` — supplies each targeted field's new value

**Given** `InitiateRotationBodySchema` (`apps/api/src/modules/rotation/schema.ts`) and `buildFieldScopedSnapshot()` (`apps/api/src/modules/rotation/service.ts`),
**When** a field-scoped rotation request (`targetFields.length >= 1`) includes an optional `fieldValues: Record<string, string>`,
**Then** the request is validated so that `fieldValues`' key set, once each key is normalized via `normalizeFieldKey()`, is **exactly** equal to the normalized `targetFields` set (not a subset, not a superset) — a mismatch is rejected with `400 { code: "field_values_target_mismatch", missing: string[], extra: string[] }` before any write — and when valid, each targeted field in the new version's snapshot is set to `fieldValues[<normalized key>]` instead of the shared `newValue`; `newValue` remains required by the schema (unchanged, for backward compatibility with clients that never send `fieldValues` and with whole-secret rotation, which has no per-field concept) but is **ignored** for any field present in `fieldValues` when `fieldValues` is provided — only used as the actual rotated value for a whole-secret r0tation or a field-scoped rotation that omits `fieldValues` entirely (today's existing single-shared-value behavior, unchanged, per Story 13.4's documented judgment call).

**Example (happy path):** Credential "Prod DB" `username: "svc-1"`, `password: "old-pw"`. Riley submits `{ targetFields: ["username","password"], newValue: "unused-placeholder", fieldValues: { username: "svc-2", password: "new-pw" } }`. New staged version: `{ username: "svc-2", password: "new-pw" }` — both fields individually updated. `newValue` is present (schema-required) but not used as any field's actual value.

**Example (edge — key set mismatch, missing key):** Same credential, `{ targetFields: ["username","password"], newValue: "x", fieldValues: { username: "svc-2" } }` (missing `password`). Response: `400 { code: "field_values_target_mismatch", missing: ["password"], extra: [] }`. No rows written.

**Example (edge — key set mismatch, extra key):** `{ targetFields: ["password"], newValue: "x", fieldValues: { password: "new-pw", username: "svc-2" } }` (username not targeted). Response: `400 { code: "field_values_target_mismatch", missing: [], extra: ["username"] }`. No rows written — an "extra" key is rejected rather than silently ignored, so a client bug (stale form state including an unchecked field) fails loudly instead of writing an unintended value nobody asked to target.

**Example (edge — single targeted field, `fieldValues` omitted, unchanged behavior):** `{ targetFields: ["password"], newValue: "new-pw" }` (no `fieldValues`). Identical to Story 13.4's existing behavior — `password` set to `"new-pw"` via the shared `newValue` path.

**Example (edge — whole-secret rotation, `fieldValues` present anyway):** `{ newValue: "x", fieldValues: { password: "y" } }` (no `targetFields` — whole-secret). Rejected: `400 { code: "field_values_target_mismatch", missing: [], extra: ["password"] }`, since whole-secret rotation has an empty normalized-target-fields set and `fieldValues` supplies one key — treated identically to any other key-set mismatch, no special-cased "ignore fieldValues for whole-secret" behavior, so a client bug here also fails loudly rather than silently dropping data.

**Example (edge — two raw keys collide after normalization):** `{ targetFields: ["password"], newValue: "x", fieldValues: { "Password": "new-pw", "password ": "different-pw" } }` (two distinct JS object keys that both normalize to `password` via `normalizeFieldKey()`'s trim/lowercase). Since `fieldValues` is a plain JSON object, only one of the two raw keys survives JSON parsing as the literal last-one-wins per standard JSON semantics — this is NOT a case the server can distinguish from a client sending a single `{ password: "..." }` entry, so no new validation is needed for it; document this explicitly so a reviewer doesn't try to add unreachable "duplicate key" detection code. The only requirement is that normalization is applied consistently (same `normalizeFieldKey()` call) on both the `fieldValues` key and the `targetFields` entries before the exact-match comparison, so a raw key of `"Password"` in `fieldValues` still correctly matches a `targetFields` entry of `"password"`.

**Example (interaction with AC-1's same-value gate):** Same-value detection (AC-1) extends to compare **per-field** when `fieldValues` is present — each targeted field's `fieldValues[key]` is compared against that field's current value (not the shared `newValue`), exactly as AC-1's third example already specifies.

**Example (audit never records field values):** Riley submits the AC-7 happy-path request. The `ROTATION_INITIATED` audit payload includes `targetFields: ["username","password"]` (keys only, existing behavior) and, if applicable, `sameValueConfirmed`/`field: <key>` (AC-1/AC-2, keys only) — it never includes any entry or byte of `fieldValues`' values, `newValue`, or the `field_values_target_mismatch` error's rejected values. This follows directly from AC-9 of Story 13.4 ("record which fields, never their values") and from this codebase's blanket convention that no mutation-audit payload ever contains plaintext secret material; a reviewer implementing Task 5 must confirm the audit-write call site never receives the `fieldValues` object itself, only derived key arrays.

---

### AC-8: The web rotation form renders one value input per targeted field once 2+ fields are selected, and wires them into `fieldValues`

**Given** the rotation form's field-selector checkboxes (Story 13.4),
**When** the user has 2+ fields checked,
**Then** the form replaces the single shared value textarea with one labeled value input per checked field (label = the field key); when exactly 1 field is checked (or "Rotate whole secret" is chosen), the form shows the existing single shared textarea, unchanged; on submit with 2+ fields checked, the request body includes `fieldValues` (one entry per checked field, from its own input) and `newValue` is populated with a placeholder/first-field value purely to satisfy the schema's required-field constraint (never read server-side when `fieldValues` covers every targeted field, per AC-7).

**Example (happy path):** Riley checks `username` and `password`, form shows two inputs, Riley fills both distinctly, submits — request matches AC-7's happy-path example.

**Example (edge — 1 field checked, single input, no regression):** Riley checks only `password` — form shows exactly today's single textarea (Story 13.4's existing UI, byte-identical), `fieldValues` is omitted from the request entirely (server-side behavior identical to AC-7's "omitted" example).

**Example (edge — unchecking a field back down to 1):** Riley checks both fields (two inputs render, each with a value already typed), then unchecks `username` — the form reverts to the single-textarea layout for `password` alone; any value Riley had typed for `password` in the two-input layout is preserved into the reverted single textarea (no data loss on selection change).

## Tasks / Subtasks

- [x] **Task 1: Same-value confirmation gate (API)** (AC: #1, #2, #4)
  - [x] Extend `InitiateRotationBodySchema` (`apps/api/src/modules/rotation/schema.ts`) with optional `confirmSameValue: z.boolean().optional()`
  - [x] Add a new `InitiateRotationResult` status `{ status: 'same_value_confirmation_required'; field: string | null }` (`apps/api/src/modules/rotation/service.ts`), returned by `initiateRotation()` before any insert when `computeSameValueAsPrevious()` reports true and `input.confirmSameValue` is not `true` — mirror the existing `unknown_field_key` early-return placement (after field-key validation, before the transaction's write statements)
  - [x] Extend `resolveInitiateRotationEarlyExit()` (`apps/api/src/modules/rotation/routes.ts`) to handle the new status with `409 { code: "same_value_confirmation_required", field }`
  - [x] When `confirmSameValue: true` and the rotation proceeds, add `sameValueConfirmed: true` to the `ROTATION_INITIATED` audit payload (routes.ts, the existing `writeRotationAuditEntry` call) — omit the key entirely when not applicable (AC-2's edge example), not `false`
  - [x] Write failing tests first (TDD) for AC-1's three examples and AC-2's two examples in `apps/api/src/modules/rotation/rotation-target-fields.test.ts` (extend the existing Story 13.4 file — same module, same describe-block convention) or a new sibling `rotation-same-value-confirmation.test.ts` if the existing file is already large; confirm AC-4 needs no new code (existing lock/conflict test coverage already proves this — add one integration test asserting a confirmed same-value request still respects `rotation_in_progress`, not new production code)

- [x] **Task 2: Same-value confirmation UI** (AC: #3)
  - [x] Extend `apps/web/src/lib/api/rotations.ts`'s `initiateRotation()` client call to surface the new `409 same_value_confirmation_required` shape distinctly from other error codes (reuse the existing `mapRotationMutationError`/error-mapping pattern already used for `unknown_field_key`/`rotation_in_progress`)
  - [x] Extend `.../rotate/+page.svelte`: on receiving `same_value_confirmation_required`, show an inline Confirm/Cancel prompt (reuse this project's existing confirm-dialog component pattern if one exists in `apps/web/src/lib/components/` — check before building a new one) instead of the generic error banner; Confirm resubmits with `confirmSameValue: true` merged into the last-submitted body; Cancel dismisses and preserves form state
  - [x] Component test for the prompt's Confirm/Cancel wiring in the existing `.../rotate/rotate-page.svelte.test.ts` (created by Story 13.4)

- [x] **Task 3: Dependency `fieldKey` — API** (AC: #5, #6)
  - [x] Extend `AddDependencyBodySchema` (`apps/api/src/modules/credentials/schema.ts`) with optional `fieldKey: z.string().trim().min(1).max(64).optional()` (same length bounds as `InitiateRotationBodySchema.targetFields`'s entries)
  - [x] In `addCredentialDependency()` (`apps/api/src/modules/credentials/dependencies-service.ts`), when `body.fieldKey` is present: load the credential's current version's `field_meta`/`schemaVersion` (reuse the existing credential-detail fetch pattern — check `apps/api/src/modules/credentials/service.ts` or wherever `field_meta` is already joined for a single credential, do not duplicate a second query pattern) and validate the normalized key exists via `fieldMetaForResponse()` + `normalizeFieldKey()` (same helpers `validateTargetFields()` in rotation/service.ts already uses); reject `400 unknown_field_key` before the insert
  - [x] Set `fieldKey: input.body.fieldKey ?? null` (normalized) on the `credentialDependencies` insert — column already exists (`packages/db/src/schema/credential-dependencies.ts`, added by migration 0055 in Story 13.4), no new migration needed
  - [x] Add `fieldKey: row.fieldKey` to `serializeDependency()`'s returned object
  - [x] Write failing tests first for AC-5's four examples, extending `apps/api/src/modules/credentials/credential-dependencies.test.ts` and `serialize-dependency.test.ts`; extend the shared `addCredentialDependencyViaApi()` test helper (`apps/api/src/modules/credentials/credential-route-test-helpers.ts:58`) to accept an optional `fieldKey` param

- [x] **Task 4: Dependency `fieldKey` — UI** (AC: #6)
  - [x] Extend the "Add dependency" form component to render a "Scope to field" `<select>` when the credential's `field_meta.length > 1` (fetch already available on the credential detail page load, no new loader query needed)
  - [x] Extend the dependency list item component to show a "Scoped to: `<field>`" badge when `fieldKey` is non-null
  - [x] Component/route tests for both the dropdown's conditional render and the badge

- [x] **Task 5: Per-field `fieldValues` map (API)** (AC: #7)
  - [x] Extend `InitiateRotationBodySchema` with optional `fieldValues: z.record(z.string(), z.string().min(1).max(65536)).optional()`
  - [x] In `initiateRotation()`, when `fieldValues` is present: normalize its keys, compare the normalized key set against the normalized `targetFields` set (or the empty set, for whole-secret rotation) for exact equality; on mismatch, return a new `InitiateRotationResult` status `field_values_target_mismatch` with `missing`/`extra` arrays, handled in `resolveInitiateRotationEarlyExit()` as `400`
  - [x] Extend `buildFieldScopedSnapshot()` to accept an optional per-field value lookup (`Map<string,string>` built from `fieldValues`) instead of a single `newValue` when present — substitute each targeted field with its own looked-up value; keep the existing single-`newValue` substitution path for when `fieldValues` is absent (Story 13.4's existing behavior, unchanged)
  - [x] Extend `computeSameValueAsPrevious()`'s field-scoped branch to compare each targeted field against its own `fieldValues` entry when present, instead of the shared `newValue` (AC-7's last example)
  - [x] Write failing tests first for every AC-7 example (happy path, missing-key mismatch, extra-key mismatch, omitted-unchanged, whole-secret-with-fieldValues-rejected, same-value-interaction, mixed-case key normalization matching a lowercase `targetFields` entry) in `rotation-target-fields.test.ts` or the new sibling file from Task 1
  - [x] Write a test asserting the `ROTATION_INITIATED` audit payload never contains a `fieldValues` key or any of its values (Dev Notes — audit-value-leakage)

- [x] **Task 6: Per-field `fieldValues` map (UI)** (AC: #8)
  - [x] Extend `.../rotate/+page.svelte`'s field-selector: when `checkedFields.length >= 2`, render one labeled value input per checked field instead of the single shared textarea; preserve typed values across selection changes (AC-8's third example) using a per-field-key value map in component state, not per-checkbox-index state (index-based state would misattribute values if selection order changes)
  - [x] Wire submit to build `fieldValues` from the per-field inputs when 2+ fields are checked, set `newValue` to any placeholder value (e.g. the first field's value) purely to satisfy the schema when `fieldValues` is sent, omit `fieldValues` entirely when 0-1 fields are checked (existing single-textarea path, unchanged request shape)
  - [x] Extend `rotate-page.svelte.test.ts` for the 1-field-vs-2+-field layout switch and the value-preservation-across-uncheck case

- [x] **Task 7: Chrome verification and full regression**
  - [x] Bring up the docker stack (`make docker-up`) if not already running; verify in Chrome: (a) a same-value rotation attempt shows the confirm prompt and confirming proceeds; (b) creating a dependency with a field scope shows the scope badge and the dependency correctly appears/disappears from checklists per its scope; (c) a two-field rotation with distinct per-field values produces the expected staged snapshot (verify via the existing staged-value reveal, as Story 13.4's Debug Log did)
  - [x] Full regression: `pnpm turbo lint typecheck test` clean across `apps/api`, `apps/web`, `packages/shared`, `packages/db`; confirm no coverage regression per this project's Sonar-new-coverage convention (buffer story, still enforced)
  - [x] `make ci` green (delegated to pick-story's C3 phase, not this task list, but note here that this story's own test additions must not depend on skipped/suppressed checks)

## Dev Notes

- **This is a pure API/UI amendment story — no new migration.** `credential_dependencies.field_key` and `rotations.target_fields` already exist (migration `0055_rotation_target_fields_and_dependency_field_key.sql`, Story 13.4). Nothing in this story adds a column; AC-5/AC-6 only add an API/UI surface for *setting* a column that was already nullable-and-read. Confirm this at implementation time by re-reading `packages/db/src/schema/credential-dependencies.ts` and `rotations.ts` rather than assuming — if either has drifted, treat that as a signal to re-scope, not to add a migration silently.
- **Why a confirmation gate instead of an outright block.** A same-value rotation is not always a mistake — e.g. an operator re-staging the same credential value after a suspected-but-unconfirmed compromise, to reset the rotation clock/audit trail without actually changing the secret. Outright blocking would remove a legitimate use case; silent warn-only (today's behavior) makes the accidental case invisible to the user in the moment. A confirm gate serves both: intentional same-value rotation still works (via `confirmSameValue: true`), accidental same-value rotation gets caught before any write.
- **Reused, not rebuilt: `computeSameValueAsPrevious()`, `constantTimeEqual()`, `buildFieldScopedSnapshot()`, `normalizeFieldKey()`, `fieldMetaForResponse()`, the `unknown_field_key` error code, `dependencyChecklistFilter()`.** Every one of these already exists (`apps/api/src/modules/rotation/service.ts`, `packages/shared/src/credential-templates.ts`, `apps/api/src/modules/credentials/field-set.ts`). This story extends their call sites and, for `buildFieldScopedSnapshot()`/`computeSameValueAsPrevious()`, extends their signatures to accept an optional per-field value source — it does not duplicate any of this logic. Grep each name before writing new code with the same responsibility.
- **`InitiateRotationBodySchema.newValue` stays required.** Rejected alternative: making `newValue` optional when `fieldValues` is provided. Kept required for backward compatibility (every existing API client always sends it) and because whole-secret rotation has no `fieldValues` concept at all — a conditionally-required field is harder to express cleanly in this project's `.strict()` Zod convention than "always required, sometimes ignored." The ignored-when-superseded behavior is explicit in AC-7, not a silent footgun — document the ignoring in the schema's own inline comment (this project's established convention, see `targetFields`'s own comment in the current schema).
- **`fieldValues` key-set validation is exact-match, not subset/superset-tolerant (AC-7).** Rejected alternative: silently ignoring extra keys or defaulting missing keys to the shared `newValue`. Both were rejected because they'd hide a real client bug (stale form state) behind an unintended write — this project's established convention (per Story 13.4 AC-3's "all-or-nothing" validation, cited there for `targetFields` itself) is to fail loudly on any request-shape ambiguity rather than guess the user's intent.
- **Dependency field-key editing (PATCH) is explicitly OUT OF SCOPE for this story.** AC-5/AC-6 only add `fieldKey` at **creation** time. `PatchDependencyBodySchema` (`apps/api/src/modules/credentials/schema.ts`) already exists and is scoped narrowly to `linkUrl` only (ADR-2.10-04, cited in that schema's own comment) — extending it to also allow re-scoping `fieldKey` after creation is a separate, real product decision (does a dependency's scope change retroactively affect already-built checklists on in-flight rotations? almost certainly should not, per Story 13.4 AC-4's snapshot-at-initiation model) that this story does not resolve. If a future need arises, it is a new story, not a silent scope creep here — document this explicitly so it isn't left as another untracked prose exclusion (the exact failure mode this story exists to fix).
- **Legacy/single-field dependency `fieldKey` acceptance (AC-5's third example) is intentionally uniform, not special-cased.** Validating `fieldKey` the same way regardless of `schema_version` keeps `addCredentialDependency()`'s validation branch-free relative to schema version — the alternative (rejecting `fieldKey` outright for legacy credentials) would require threading schema-version-awareness into a code path that currently has none, for a case with no functional difference in outcome (a legacy credential's rotation is always whole-secret regardless of any dependency's `field_key`).
- **UI field-value-input layout switch (AC-8) must not use array-index-keyed state.** Svelte reactivity + a component array/object keyed by field **key** (not checkbox index) is required so unchecking/rechecking fields (AC-8's third example) doesn't misattribute a value typed for one field to a different field after a selection-order change. Follow whatever keyed-state pattern this codebase already uses elsewhere for a similar "N dynamic labeled inputs" case (check `apps/web/src/lib/components/credentials/` for the multi-field secret creation form from Story 13.2 — it already solved an analogous per-field-key input problem and should be the pattern to mirror, not reinvent).
- **Test file locations to extend**, following this module's established co-located `*.test.ts` convention:
  - `apps/api/src/modules/rotation/rotation-target-fields.test.ts` (Story 13.4's file) or a new sibling `rotation-same-value-confirmation.test.ts` — AC-1, AC-2, AC-4, AC-7 (fieldValues validation/substitution), the same-value/fieldValues interaction case
  - `apps/api/src/modules/rotation/routes.test.ts` — already has a same-value baseline test (`'POST flags sameValueAsPrevious when newValue matches the current version'`, line ~623) — extend or add adjacent tests for the new `409`/confirmed-proceed flow at the route layer
  - `apps/api/src/modules/credentials/credential-dependencies.test.ts` and `serialize-dependency.test.ts` — AC-5, AC-6's API half
  - `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/rotate-page.svelte.test.ts` (Story 13.4's file) — AC-3, AC-8
  - A component test for the "Add dependency" form and dependency list badge — locate the existing test file for that form first (likely co-located with the credential detail page or a `dependencies` component directory under `apps/web/src/lib/components/`) rather than assuming a path
  - Every new/extended test must include an explicit legacy (`schema_version = 1`) or single-field case per Epic 13's "backward compatibility is mandatory, not best-effort" mandate (`_bmad-output/planning-artifacts/epics.md` line 2484)
- **RLS/tenant isolation:** no schema change in this story, so no new RLS policy is needed — both touched tables (`rotations`, `credential_dependencies`) are already org-scoped and covered by existing policies (confirmed by Story 13.4's own `make check-rls` pass). Still, add one cross-org negative test per new/changed endpoint behavior (same-value confirmation, dependency `fieldKey` creation) proving a request scoped to org A cannot trigger or observe org B's credential state — following this project's standing convention of never assuming isolation transitively from an unrelated story's pass.
- **Audit behaviour:** AC-2's `sameValueConfirmed` flag and the existing `targetFields`/checklist-count fields on `ROTATION_INITIATED` — verify the audit entry is written inside the same transaction as the rotation insert (unchanged from Story 13.4/5.6's existing pattern: an audit write failure rolls back the whole initiation, per the existing `try/catch` around `writeRotationAuditEntry` in routes.ts).
- **Security — confirm-and-retry is not a new auth/CSRF surface.** The confirmed retry (AC-2/AC-3) is a normal, fully-authenticated `POST` identical in every auth/session/CSRF respect to the initial attempt — it carries no new token, no elevated privilege, and no bypass of any existing check (role gate, rate limit, org scoping). It only adds one boolean field to an already-authorized request. Confirm this explicitly in review: no new session state is introduced to "remember" that a same-value warning was shown (the confirmation is stateless — the client simply resends the same body plus the flag).
- **Auth/session lifecycle:** no new auth surface — reuses existing `canManageRotations`/`canManageDependencies` role gates unchanged. Add one test per new endpoint behavior proving a viewer-role request still gets the existing 403, not a new/different error shape introduced by this story's changes.
- **Concurrent access:** covered by AC-4 (same-value confirmation) — no new concurrency primitive; reuse and extend the existing rotation-lock integration tests (`rotation-promote-retire.test.ts`'s conflict tests) rather than writing a new locking mechanism.
- **Rate limits:** rotation initiation's existing rate limit (unchanged by this story) already applies to the confirmed-retry request exactly as it does to the first attempt — a user who gets rate-limited mid-confirmation should see the existing rate-limit error, not a new one; add one test confirming the retry request consumes the same rate-limit bucket as the original (not a fresh allowance), so this doesn't become an accidental rate-limit bypass.
- **Operational logging:** the existing `ROTATION_INITIATE_SAME_VALUE_WARNING` log line (`apps/api/src/modules/rotation/routes.ts:912`) should still fire on the confirmed-and-proceeding path (unchanged) — this story adds the audit-level `sameValueConfirmed` flag as a *complement* to that operational log, not a replacement; do not remove the existing warn-log call.
- **Migration compatibility:** N/A — no migration in this story (see first bullet above). If implementation discovers a genuine need for a new column (it should not), treat that as a signal to stop and re-scope with the user rather than silently expanding this story.
- **Pre-mortem — deploy-ordering risk for existing API clients hitting a same-value rotation.** AC-1 changes a previously-**always-succeeding** request (same-value rotation, warn-only) into a request that can now fail with `409` unless the caller adds `confirmSameValue: true`. Any existing script/integration (e.g. a scheduled job that intentionally re-stages an unchanged secret, or a test fixture that rotates to a known constant) that never previously needed to think about this will start failing the moment this story deploys — this is a **behavioral break for existing callers**, unlike every other change in this story (all additive/optional). Before merging: grep this codebase's own test fixtures, seed scripts, and any internal automation for a same-value rotation pattern and update them to pass `confirmSameValue: true` in the same PR; flag in the PR description that any *external* API consumer doing the same must be notified (this project has no public API-consumer changelog process today — note that gap explicitly rather than silently assuming no one is affected).
- **TDD**: write each failing test first (red), then implement (green), per this project's established convention (Story 13.4's Task list, every subtask test-first).

### Project Structure Notes

- All new service logic lands in the existing `apps/api/src/modules/rotation/service.ts` and `apps/api/src/modules/credentials/dependencies-service.ts` — no new module directory, consistent with this codebase's precedent (Story 13.4 kept all rotation logic in one file; this story extends the same file plus the sibling dependencies service).
- No new schema files or migrations (both touched columns already exist).
- Web UI changes extend the existing `.../rotate/+page.svelte` and the existing "Add dependency" form component — no new route directory.
- No detected conflicts with the unified project structure — purely additive/amendatory within existing module boundaries, matching Story 13.4's own shape.

### References

- [Source: _bmad-output/implementation-artifacts/epic-13-retro-2026-07-27.md] — Findings 2 & 3 (the two High findings this story closes), Team Agreement #2 (forward-reference deferrals are as untracked as "known limitation" prose), Action Items
- [Source: _bmad-output/implementation-artifacts/13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates.md] — lines 369-371, 472-473, 565: the phantom "Story 13.5" forward references this story formally retires
- [Source: _bmad-output/implementation-artifacts/13-4-rotate-specific-fields-of-a-multi-field-secret.md] — lines 165-166, 193, 246 (dependency-creation `field_key` scope exclusion); line 252 (same-`newValue`-for-every-field scope exclusion); the entire file as the direct structural/testing-convention precedent for this story
- [Source: apps/api/src/modules/rotation/service.ts] — `computeSameValueAsPrevious()`, `constantTimeEqual()`, `buildFieldScopedSnapshot()`, `validateTargetFields()`, `buildNewVersionInsertFields()`, `dependencyChecklistFilter()`, `ACTIVE_ROTATION_STATUSES`/`findInProgressRotationId()` (all read/confirmed 2026-07-27, all reused not rebuilt)
- [Source: apps/api/src/modules/rotation/routes.ts] — lines 909-935: existing warn-only same-value handling (`ROTATION_INITIATE_SAME_VALUE_WARNING`), `resolveInitiateRotationEarlyExit()`, the existing audit-write try/catch pattern
- [Source: apps/api/src/modules/rotation/schema.ts] — `InitiateRotationBodySchema` (line 30), current shape confirmed 2026-07-27, no `confirmSameValue`/`fieldValues` fields exist yet
- [Source: apps/api/src/modules/credentials/schema.ts] — `AddDependencyBodySchema` (line 161), current shape confirmed 2026-07-27, no `fieldKey` field exists yet
- [Source: apps/api/src/modules/credentials/dependencies-service.ts] — `addCredentialDependency()`, `serializeDependency()`, confirmed `field_key` is never read or written today despite the column existing
- [Source: packages/db/src/schema/credential-dependencies.ts] — `field_key` column, added by migration 0055 (Story 13.4), confirmed present and unused by any API surface as of this story's drafting
- [Source: packages/shared/src/credential-templates.ts] — `normalizeFieldKey()` (line 82), reused, not reimplemented
- [Source: apps/api/src/modules/credentials/field-set.ts] — `fieldMetaForResponse()`, `DEFAULT_FIELD_KEY`, reused for dependency-creation field-key validation
- [Source: apps/api/src/modules/rotation/rotation-target-fields.test.ts] and [Source: apps/api/src/modules/rotation/routes.test.ts] (line ~623, existing same-value baseline test) — testing conventions to extend
- [Source: apps/api/src/modules/credentials/credential-route-test-helpers.ts] (line 58, `addCredentialDependencyViaApi()`) — test helper to extend with an optional `fieldKey` param
- [Source: _bmad-output/planning-artifacts/prd.md] — FR18 (re-amended, Story 5.6): rotation staging model this story's confirmation gate and per-field values both sit within, unchanged; FR12 (amended): full-field-set-snapshot invariant, unchanged by per-field value substitution (still a full snapshot, just multiple fields substituted individually instead of one)
- [Source: _bmad-output/planning-artifacts/epics.md] — Epic 13 preamble (line ~2477-2485); confirmed via grep that epics.md never defined a "Story 13.5" — this story's numbering follows `sprint-status.yaml`'s already-registered `13-5-rotation-same-value-and-dependency-scoping` key (added by the retro), not an epics.md source AC set
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- Full API test suite (`pnpm exec vitest run` in `apps/api`) run in background during Chrome
  verification; scoped rotation/credentials suites (351 tests) and web suite (1630 tests) both
  passed synchronously before that. `packages/db`'s `rotations-rls-isolation.test.ts` failed once
  when run concurrently against the shared test DB while the full `apps/api` background suite was
  also writing to it (row-count assertions off by hundreds of pre-existing rows) — consistent with
  this project's documented shared-DB-state pollution risk for concurrent test runs, re-verified
  in isolation before trusting.
- Chrome UI verification required bringing up the full docker stack (`make docker-up`) after
  `make fix-ports` bumped `DB_HOST_PORT`/`WEB_HOST_PORT` (5432/5173 were busy) and generating a
  `VAULT_BOOTSTRAP_TOKEN` (none was set in `.env`). Discovered `fix-ports` left
  `CORS_ALLOWED_ORIGINS` pointed at the stale `5173` web port, causing every session to be silently
  revoked on the next request (`docker compose restart api` after correcting it in `.env` fixed
  this — worth noting for future worktree Chrome-verification setups since this isn't called out
  in Story 13.4's own setup notes). Live-verified: (a) a same-value rotation on a field-scoped
  request shows "The new value for `password` is identical to its current value. Rotate anyway?"
  with Confirm/Cancel; Confirm resubmits with `confirmSameValue: true` and stages the rotation
  successfully; (b) creating a dependency scoped to `password` on a 2-field credential shows the
  "Scope to field" dropdown, and the created dependency shows a "Scoped to: password" badge and
  appears on that field's rotation checklist; (c) a two-field rotation (`username`+`password`)
  with distinct per-field values produces a staged snapshot
  `[{"key":"username","value":"svc-2",...},{"key":"password","value":"new-pw",...}]` via the
  staged-value reveal. Docker stack torn down (`docker compose down`) after verification.

### Completion Notes List

- AC-1/AC-2/AC-4: same-value rotation now requires `confirmSameValue: true` (409
  `same_value_confirmation_required` otherwise); confirmed rotations get `sameValueConfirmed: true`
  in the `ROTATION_INITIATED` audit payload (omitted otherwise); existing lock/conflict path
  unchanged (AC-4 needed no new production code, one integration test added).
- AC-3: rotate form intercepts the 409 and shows an inline Confirm/Cancel prompt; Confirm resubmits
  the exact prior body plus `confirmSameValue: true`; Cancel preserves all entered form state.
- AC-5/AC-6: dependency creation accepts optional `fieldKey`, validated against the credential's
  current declared field keys (400 `unknown_field_key` otherwise); "Add dependency" form shows a
  "Scope to field" dropdown for multi-field credentials; dependency list shows a "Scoped to: X"
  badge; `serializeDependency()` always includes `fieldKey`.
- AC-7/AC-8: rotation accepts an optional per-field `fieldValues` map, validated for exact key-set
  equality against `targetFields` (400 `field_values_target_mismatch` with `missing`/`extra`
  otherwise); same-value detection extended to compare per-field when `fieldValues` is present;
  audit payload never contains `fieldValues`. Rotate form renders one labeled input per field once
  2+ fields are checked, preserving typed values across selection changes via a field-key-keyed
  state map (not index-keyed).
- Pre-mortem backward-incompat item: updated the one existing test
  (`routes.test.ts`'s same-value baseline) to pass `confirmSameValue: true`; grepped the whole repo
  for other same-value rotation patterns in fixtures/seed scripts — none found.
- Reused existing helpers throughout per Dev Notes: `computeSameValueAsPrevious()`,
  `constantTimeEqual()`, `buildFieldScopedSnapshot()`, `normalizeFieldKey()`,
  `fieldMetaForResponse()`, `selectCurrentVersionMeta()`, the `unknown_field_key` code,
  `dependencyChecklistFilter()`. No new migration — both touched columns already existed.
- Extracted `resolveInitiateRotationPreflight()` (service.ts), `resolveDependencyFieldKey()`
  (dependencies-service.ts), and `buildRotationInitiatedAuditPayload()`/two response-senders
  (routes.ts) to keep functions under this repo's cyclomatic-complexity lint ceiling after adding
  the new validation branches.
- Full regression: `pnpm turbo lint typecheck` clean across `apps/api`, `apps/web`,
  `packages/shared`. Scoped test suites (rotation + credentials modules, 351 tests; full web
  suite, 1630 tests; full shared suite, 165 tests) all green. `packages/db` re-verified in
  isolation after ruling out concurrent-test-run DB pollution (see Debug Log).

### File List

- `apps/api/src/modules/rotation/schema.ts`
- `apps/api/src/modules/rotation/service.ts`
- `apps/api/src/modules/rotation/routes.ts`
- `apps/api/src/modules/rotation/rotation-same-value-confirmation.test.ts` (new)
- `apps/api/src/modules/rotation/rotation-target-fields.test.ts`
- `apps/api/src/modules/rotation/routes.test.ts`
- `apps/api/src/modules/credentials/schema.ts`
- `apps/api/src/modules/credentials/dependencies-service.ts`
- `apps/api/src/modules/credentials/routes.ts`
- `apps/api/src/modules/credentials/credential-dependencies.test.ts`
- `apps/api/src/modules/credentials/serialize-dependency.test.ts`
- `packages/shared/src/schemas/credential-dependencies.ts`
- `packages/shared/src/constants/operational-event-types.ts`
- `packages/shared/openapi.json` (regenerated by `generate-spec.ts`, reflects the new schema fields/response shapes)
- `apps/web/src/lib/api/rotations.ts`
- `apps/web/src/lib/api/credentials.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/rotate-page.svelte.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts`
