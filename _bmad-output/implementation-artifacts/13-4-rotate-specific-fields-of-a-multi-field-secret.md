# Story 13.4: Rotate Specific Fields of a Multi-Field Secret

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who needs to rotate just the password of a multi-field secret without touching its username,
I want to select which field(s) a rotation targets,
so that I don't have to treat an unrelated field as changed when only one credential component actually rotated.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — this amends the rotation-initiation API (`apps/api/src/modules/rotation/service.ts`/`routes.ts`/`schema.ts`, `packages/db/src/schema/rotations.ts` + `credential-dependencies.ts`) and the existing rotation-initiation web UI (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte` + `+page.server.ts`). An API-only version would visibly regress the shipped `/rotate` page (it would keep offering only whole-secret rotation with no way to reach the new field-scoped capability). |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI changes are in-scope in this same story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (org admin, rotation initiator), rotating one field of a multi-field secret:** opens a Login-template credential's detail page (`username` non-sensitive, `password` sensitive) → clicks "Rotate" → lands on `/rotate` → because `field_meta` on this credential has more than one field, the form now shows a **field selector** above the value input: a checkbox per field key (`username`, `password`), defaulting to none selected, plus a "Rotate whole secret" fallback option that behaves exactly like today's form (single free-text value, no field targeting) → Riley checks only `password`, enters the new password value → clicks "Start rotation" → `POST .../rotations` is called with `targetFields: ["password"]` → the new staged version is created with `username` carried over unchanged and only `password` updated → the checklist Riley sees on the rotation detail page (`rotations/[rotationId]/+page.svelte`, unchanged by Story 5.6's card layout) includes only dependencies scoped to `password` or to the whole credential (`field_key IS NULL`) — a dependency scoped only to `username` does not appear → Riley clicks "Promote" (per Story 5.6's existing flow, unmodified by this story) → the staged `credential_versions` row (with `username` carried over, `password` updated) becomes current → Riley clicks "Retire" later, exactly as any other rotation.

**Morgan-member (dependent-system owner, checklist confirmer):** sees the same checklist UI as always; the only visible change is that a field-scoped rotation's checklist may legitimately contain fewer items than the credential's total dependency count — no new interaction pattern.

**Alex-viewer (read-only):** sees the field selector rendered read-only/absent (matches the existing `canManageRotations` gate — viewers never reach the `/rotate` form at all, unchanged from today).

**Legacy single-value secret (`schema_version = 1`) or a multi-field secret rotated as a whole:** the field selector either does not render (single-field credential — `field_meta.length <= 1`) or the user picks "Rotate whole secret" — in both cases `targetFields` is omitted/`null` and the request/response behavior is byte-identical to today's whole-secret rotation.

## Acceptance Criteria

> **Correction notice:** epics.md's literal Story 13.4 AC text (`_bmad-output/planning-artifacts/epics.md` lines ~2592-2627) describes rotation completing via the OLD "checklist confirmed → single completion transaction" model (`completeRotation()`, `rotations.status IN ('in_progress','completed',...)`). That model was superseded by Story 5.6 (`5-6-staged-primary-secondary-rotation-state-machine`, done 2026-07-26), which inverted rotation completion into a `staged → promoted → retired` state machine (`promoteRotation()`/`retireRotation()`/`getStagedValue()`). Per `sprint-status.yaml`'s 2026-07-24 `bmad-correct-course` entry and reconfirmed in 5-6's own AC-8.6, this story was explicitly flagged to be rewritten against the new model, "reusing the same field_key filtering logic against the new model." The ACs below target the real, shipped 5-6 state machine. Every AC that epics.md wrote around "the completion transaction" is rewritten below to fire at **promote** time (see Dev Notes → "Promote vs. retire: where the field-set snapshot lands" for why). Substantive requirements epics.md got right (rejecting unknown field keys, `field_key`-based checklist filtering, reuse of the existing conflict/lock mechanism, legacy-secret behavior parity) are preserved, re-expressed against the new model.

### AC-1: Rotation initiation lets a user target specific field(s) or the whole secret

**Given** a multi-field secret (`schema_version = 2`, `field_meta` has 2+ entries) and a user with rotation-initiation permission,
**When** they reach the rotation initiation screen (`/rotate`),
**Then** they can select one or more specific field keys to rotate, or choose to rotate the whole secret (today's existing behavior, unchanged).

**Example (happy path):** Credential "Prod DB" has fields `username` (non-sensitive) and `password` (sensitive). Riley selects only `password`, enters a new value, submits. `POST .../rotations` body is `{ newValue: "<new password>", targetFields: ["password"] }`.

**Example (legacy/single-field, no selector):** Credential "API token" is legacy (`schema_version = 1`). The `/rotate` form renders exactly as it does today — free-text value, no field checkboxes — because `field_meta.length <= 1` (legacy secrets report a single synthetic `value` field per `fieldMetaForResponse()`, `apps/api/src/modules/credentials/field-set.ts:120`). `targetFields` is omitted from the request body entirely.

---

### AC-2: `rotations.target_fields` records the targeted field keys; whole-secret rotation leaves it `NULL`

**Given** a rotation request,
**When** `initiateRotation()` (`apps/api/src/modules/rotation/service.ts:103`) processes it,
**Then** the new `rotations.target_fields text[]` column (nullable, added by this story's migration — **does not exist in the shipped schema today**, confirmed by direct read of `packages/db/src/schema/rotations.ts`) is set to the array of targeted field keys (normalized via the existing `normalizeFieldKey()`, `packages/shared/src/credential-templates.ts:82`, for the same trim/lowercase/NFC-normalize treatment 13.2/13.3 already apply to field keys) when the request names specific fields, and left `NULL` for a whole-secret rotation.

**Example:** Request body `{ newValue: "...", targetFields: ["Password "] }` (untrimmed, mixed case) → `rotations.target_fields = ["password"]` (normalized), matching the exact key stored in `field_meta`.

**Example (legacy):** A rotation on a `schema_version = 1` credential (no `targetFields` in the body, or a body that omits the field entirely) → `rotations.target_fields = NULL` — byte-identical to today's single row shape plus one new always-`NULL` column.

---

### AC-3: A target field key that no longer exists on the credential is rejected, not silently dropped or misapplied

**Given** a rotation request naming a field key that doesn't currently exist on the credential's `field_meta` (e.g. renamed or removed via a 13.2 field-set edit since the rotation form was loaded),
**When** `initiateRotation()` validates `targetFields` against the credential's current `field_meta` (loaded inside the same locked transaction that already loads the previous version, so the check is against the most current schema, not a stale client-side snapshot),
**Then** the request is rejected before any write with `400 { code: "unknown_field_key", field: "<missing key>" }` — reusing the same error code the existing `GET .../value?field=` reveal route already uses for an analogous "named key doesn't exist" case (`apps/api/src/modules/credentials/routes.ts:232`), for consistency rather than inventing a second error vocabulary for the same failure shape.

**Example (happy path miss):** Riley's browser tab has been open since before `password` was renamed to `db_password` by another user. Riley submits `targetFields: ["password"]`. Server-side validation against the live `field_meta` finds no `password` key → `400 { code: "unknown_field_key", field: "password" }`. No `credential_versions` row, no `rotations` row, no checklist rows are created — zero side effects on rejection.

**Example (partial validity is still a full rejection):** `targetFields: ["username", "totp_secret"]` where `username` exists but `totp_secret` does not → still `400 { code: "unknown_field_key", field: "totp_secret" }` — an all-or-nothing validation, not a partial-apply of the valid subset (matches this codebase's existing "atomic accept or atomic reject" convention for multi-item validation, e.g. field-set edit's collision handling).

---

### AC-4: The rotation checklist is filtered by `field_key` against `target_fields`

**Given** `credential_dependencies` rows for the credential being rotated — some scoped to a specific field via a new `field_key text` column (nullable; **does not exist today**, confirmed by direct read of `packages/db/src/schema/credential-dependencies.ts` — epics.md's Epic 13 preamble at line 2483 claims this column is an already-satisfied "data model prerequisite" of the epic, but it was not added by Stories 13.1/13.2/13.3; this story adds it, correcting that stale claim, see Dev Notes), some with `field_key IS NULL` (whole-credential, the default for every dependency created before this story and for any new dependency where the user doesn't pick a field),
**When** `initiateRotation()` builds the checklist snapshot (the existing `dependencyRows` query + `rotationChecklistItems` batch insert, `apps/api/src/modules/rotation/service.ts:200-238`),
**Then** the dependency query is filtered to `field_key IS NULL OR field_key = ANY(target_fields)` when `target_fields IS NOT NULL`, and unfiltered (today's existing `WHERE credential_id = ... AND archived_at IS NULL` behavior, unchanged) when `target_fields IS NULL` (whole-secret rotation, including every legacy rotation).

**Example (happy path):** Credential "Prod DB" has three active dependencies: "CI Pipeline" (`field_key = NULL`), "Backup Script" (`field_key = 'password'`), "Read Replica Config" (`field_key = 'username'`). Riley rotates targeting `["password"]`. The checklist snapshot includes "CI Pipeline" (whole-credential, always included) and "Backup Script" (`password` is targeted) — "Read Replica Config" is excluded (scoped to `username`, not targeted).

**Example (whole-secret rotation, no filtering):** Same credential, Riley instead rotates the whole secret (`targetFields` omitted). All three dependencies appear on the checklist — identical to today's behavior, zero regression.

---

### AC-5: Promotion writes a full field-set snapshot with only targeted fields changed; `current_version_id`-equivalent selection flips atomically at promote

**Given** Story 5.6's shipped model, where a rotation's new `credential_versions` row is created with `promoted_at = NULL` at initiation (staged, not yet current) and only becomes "current" when `promoteRotation()` (`apps/api/src/modules/rotation/service.ts:1220`) sets `promoted_at = NOW()` inside its own CAS-protected transaction — and given FR12's existing requirement (unchanged by this story) that every `credential_versions` row is a full field-set snapshot, never a sparse diff,
**When** a field-scoped rotation's staged version is created at initiation time,
**Then** the new `credential_versions` row already contains the complete field set at creation: the targeted field(s) hold the new value(s), every non-targeted field carries over its plaintext value from the previous (still-current) version's field set, unchanged — this happens once, at initiation (matching how the new version is built today for a whole-secret rotation, just with a subset of fields substituted rather than all of them). Promotion itself does not rewrite or touch field contents — consistent with Story 5.6 AC-1, which established that `promoteRotation()` only flips `credential_versions.promoted_at` and never mutates version content. "Current" visibility (which version's field values a `GET .../value` call returns) flips atomically at promote, in the same transaction as `rotations.status: staged → promoted`, exactly as Story 5.6 AC-1/AC-5 already require for every rotation regardless of `target_fields` — no field-scoped special case in the flip mechanism itself.

**Example (happy path):** Credential "Prod DB" v1: `{username: "svc-1", password: "old-pw"}`. Riley rotates targeting `["password"]` with new value `"new-pw"`. Staged v2 is created immediately (at initiation) as `{username: "svc-1", password: "new-pw"}` — the full set, `username` carried over unchanged, `promoted_at: NULL`. `GET .../value` still returns v1 (per Story 5.6 AC-1's inversion — the staged value is not yet "current"). Riley promotes → v2's `promoted_at` is set, `GET .../value` now returns v2's full field set, `{username: "svc-1", password: "new-pw"}`.

**Example (edge — field-scoped rotation abandoned before promote):** Same setup, but Riley abandons the staged rotation instead of promoting (Story 5.6 AC-2.5, `staged` is abandonable). v1 remains current throughout; v2 is never promoted, and later becomes eligible for retention pruning like any other abandoned staged version — no field-level special case, this is the exact existing abandon behavior Story 5.6 already ships.

---

### AC-6: This rotation reuses the existing credential-level advisory lock and active-rotation conflict response, regardless of field overlap

**Given** the existing `ACTIVE_ROTATION_STATUSES`-gated conflict check (`apps/api/src/modules/rotation/service.ts:56`, `findInProgressRotationId()`) and the partial unique index `idx_rotations_one_active_per_credential` (Story 5.6 AC-2.6, now covering `staged`/`promoted`/`stale_recovery`/legacy `in_progress`),
**When** a second rotation attempt (whole-secret or another field subset, including a *disjoint* field subset — e.g. a second rotation on `username` while `password` is mid-rotation) is made on the same credential while one rotation is `staged` or `promoted`-but-unretired,
**Then** it receives the existing `409 { code: "rotation_in_progress", rotationId: "<id>" }` response — never silent interleaving, and never a partial allow because the field sets happen not to overlap. Field-scoped rotation does not introduce a finer-grained, per-field lock; the credential-level lock remains the sole concurrency boundary, exactly as it is for whole-secret rotations today.

**Example (disjoint fields still conflict):** Rotation R1 targets `["password"]`, status `staged`. A second request targeting only `["username"]` → `409 rotation_in_progress`, `rotationId: "R1"` — even though the two target sets don't overlap, because there is still no defined "old" full-field-set version for a second concurrent rotation to build against once R1's staged version already carries a mutated `password` that a second rotation initiated against the *pre-R1* previous version would not see (the same reasoning Story 5.6 AC-2.6 already applies to whole-secret double-rotation, extended here to explain why it must also apply to disjoint field subsets rather than being loosened).

**Example (promoted-but-unretired blocks too, per Story 5.6):** Rotation R1 targets `["password"]`, promoted but not yet retired. A second rotation attempt (any field set) → `409 rotation_in_progress` — identical to Story 5.6 AC-2.6's Example 2c, unaffected by `target_fields`.

---

### AC-7: Legacy single-value secret rotation is unchanged

**Given** a legacy (`schema_version = 1`) secret, or any rotation request that omits `targetFields`,
**When** rotated,
**Then** rotation behaves exactly as it does today — `rotations.target_fields` remains `NULL`, the checklist is unfiltered by field, the staged/promote/retire mechanics are Story 5.6's existing behavior with zero field-aware special-casing, and the API request/response shapes are byte-identical to pre-this-story behavior aside from the new, always-omittable `targetFields` field in the request schema and the new, always-`null`-here `targetFields` field in the response schema.

**Example:** A `schema_version = 1` credential's rotation request `{ newValue: "new-secret" }` (no `targetFields` key at all — the field is optional, not required-and-nullable, so existing API clients/scripts that predate this story keep working with zero changes) → identical `rotations`/`credential_versions` rows to today, `target_fields: NULL`.

---

### AC-8: A decrypt failure on a carried-over (non-targeted) field aborts initiation atomically — never a partial or corrupted snapshot

**Given** the previous version's field set includes a field whose envelope fails to decrypt (corrupted ciphertext, KMS unavailability, or any other decrypt-path error already handled elsewhere in this codebase per Story 1.14's KMS error taxonomy),
**When** `initiateRotation()` builds the new staged version's full field-set snapshot by carrying over non-targeted fields,
**Then** the decrypt failure aborts the entire initiation before any row is written (no `rotations` row, no `credential_versions` row, no checklist rows) — the same "all-or-nothing" atomicity AC-3 already establishes for validation failures, extended here to a downstream decrypt failure — surfaced as a `5xx` with the existing KMS/decrypt error taxonomy's response shape, never a version written with the failed field silently dropped or replaced with a placeholder.

**Example:** Credential "Legacy DB" has fields `username` (healthy) and `connection_string` (corrupted envelope, pre-existing damage unrelated to this story). Riley rotates targeting only `["username"]`. Building the snapshot requires reading `connection_string`'s current value to carry it over unchanged — that read fails. Initiation aborts entirely; `username` is NOT rotated either, even though it validated successfully — a half-applied rotation (new `username`, no `connection_string`) would violate FR12's full-snapshot invariant worse than rejecting outright.

---

### AC-9: Rotation-initiation audit event records which field keys were targeted, never field values

**Given** the existing audit-write path for rotation initiation (extended, not replaced, by this story),
**When** a field-scoped rotation is initiated,
**Then** the audit entry includes `target_fields` (the normalized key array, or absent/null for whole-secret) alongside the fields it already records today — following the same "record which fields, never their values" convention Story 13.3 AC established for `revealed_fields` on the reveal audit event, so the audit trail answers "which field was rotated" without ever persisting old/new secret values in the log.

**Example:** Riley rotates `password` on "Prod DB". The audit entry includes `{ action: "rotation_initiated", credentialId: "...", targetFields: ["password"] }` — never the old or new password value, matching the existing convention for every other credential-mutation audit event in this codebase.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema & migration** (AC: #2, #4)
  - [ ] Add `rotations.target_fields text[]` (nullable) to `packages/db/src/schema/rotations.ts`
  - [ ] Add `credential_dependencies.field_key text` (nullable) to `packages/db/src/schema/credential-dependencies.ts`
  - [ ] Confirm the next free migration number against `packages/db/src/migrations/meta/_journal.json` **immediately before writing** — as of this story's drafting, the last registered migration is `0054_audit_revealed_fields`, so the next free number is `0055`, but this must be re-verified at implementation time per this project's recurring migration-numbering-race risk (flagged the same way in 13.1/13.2/5.6)
  - [ ] Write migration `00XX_rotation_target_fields_and_dependency_field_key.sql` — purely additive (two nullable columns, no backfill needed: existing rows correctly default to `NULL` = "applies to whole credential / whole secret", which is the correct semantic for every pre-existing row)
  - [ ] Run `make check-rls` — both tables are already org-scoped, new columns should be a clean pass, confirm rather than assume
  - [ ] Add a migration safety/compatibility test following `packages/db/src/__tests__/migration-00XX-*.test.ts` conventions (13.1's `migration-0049-current-version-id-backfill.test.ts` / 5.6's `migration-0050-*.test.ts` as the templates) — this migration is low-risk (purely additive, nullable, no backfill) but still needs a basic apply/idempotency test per this project's standard

- [ ] **Task 2: Field-key validation and `target_fields` write on initiation** (AC: #1, #2, #3, #7)
  - [ ] Extend `InitiateRotationBodySchema` (`apps/api/src/modules/rotation/schema.ts`) with optional `targetFields: z.array(z.string()).min(1).optional()`
  - [ ] In `initiateRotation()` (`apps/api/src/modules/rotation/service.ts:103`), when `targetFields` is present: normalize each key via `normalizeFieldKey()`, load the credential's current `field_meta` inside the existing locked transaction (alongside the existing `previousVersion` load), and validate every normalized key exists — reject with `400 unknown_field_key` before any write on the first miss
  - [ ] Write `rotations.target_fields` on insert (normalized array, or `NULL` if absent)
  - [ ] Write a failing test first (TDD red-green) for each of AC-2's/AC-3's example cases before implementing

- [ ] **Task 3: Field-set snapshot construction for a field-scoped rotation** (AC: #5, #8, #9)
  - [ ] In `initiateRotation()`'s new-version-insert step, when `target_fields` is set: build the new version's field set by starting from the previous version's decrypted field set (reuse existing decrypt/field-set-read helpers from `apps/api/src/modules/credentials/field-set.ts` / `service.ts` — do not duplicate decryption logic) and substituting only the targeted field(s) with the new value(s); when `target_fields` is `NULL`, preserve today's existing whole-value-replacement behavior unchanged
  - [ ] Ensure a decrypt failure on any carried-over field propagates as an abort of the whole initiation transaction — no partial writes (AC-8); write the failing test first with a deliberately corrupted non-targeted field's envelope
  - [ ] Extend the existing rotation-initiation audit write to include `target_fields` (keys only) on the audit entry (AC-9)
  - [ ] Confirm (write a test proving) `promoteRotation()`/`retireRotation()` require zero changes — they operate on `credential_versions.promoted_at`/`rotationLockedAt` only, never field contents, per Story 5.6 AC-1's existing design
  - [ ] Write a test proving "select all N fields" and "rotate whole secret" produce different `target_fields` wire values (materialized list vs. `NULL`) per the Dev Notes ADR on why these must not be collapsed

- [ ] **Task 4: Checklist filtering by `field_key`** (AC: #4)
  - [ ] Extend the `dependencyRows` query in `initiateRotation()` (`apps/api/src/modules/rotation/service.ts:200-209`) to add `AND (field_key IS NULL OR field_key = ANY(target_fields))` when `target_fields IS NOT NULL`
  - [ ] Decide and implement whether `credential_dependencies` creation (`addCredentialDependency`, `apps/api/src/modules/credentials/routes.ts`) gains an optional `fieldKey` input, or whether this story only adds the column with all new/existing dependencies defaulting to `NULL` until a follow-up story exposes field-scoping in the dependency-management UI — **recommended default: add the column and the filter now (this story), defer the dependency-creation UI/API surface for picking a `field_key` to a follow-up** (there is no in-scope UI story for it here and epics.md doesn't specify one either), and document this explicitly as a judgment call in Dev Notes rather than silently expanding scope
  - [ ] Write a failing test first reproducing AC-4's happy-path and whole-secret examples

- [ ] **Task 5: Active-rotation conflict reuse** (AC: #6)
  - [ ] Confirm (via a targeted integration test, not just inspection) that the existing `ACTIVE_ROTATION_STATUSES`/`findInProgressRotationId()`/unique-index conflict path already produces the correct `409 rotation_in_progress` for disjoint-field-set concurrent attempts with zero code changes — this AC is expected to require test coverage only, not new production code, since the credential-level (not field-level) lock already covers this case
  - [ ] Write the disjoint-field-set and promoted-unretired-blocks-again test cases explicitly (AC-6 examples)

- [ ] **Task 6: Web UI — field selector on the rotation-initiation form** (AC: #1, #7)
  - [ ] Extend `.../[credentialId]/rotate/+page.server.ts`'s loader to also fetch the credential detail (`getCredential()`, `apps/web/src/lib/api/credentials.ts:90`) for `field_meta`, alongside the existing dependency/rotation-history fetches
  - [ ] Extend `.../[credentialId]/rotate/+page.svelte`: when `field_meta.length > 1`, render a checkbox list (field key labels) above the value textarea plus a "Rotate whole secret" radio/toggle that reverts to today's single-textarea behavior; when `field_meta.length <= 1` (legacy or single-field), render exactly today's form, unchanged
  - [ ] Wire the selected field keys into `initiateRotation()`'s (`apps/web/src/lib/api/rotations.ts`) request body as `targetFields`
  - [ ] Surface the new `400 unknown_field_key` error shape with a clear inline message (reuse `mapRotationMutationError` / the existing `errorMessage` handling pattern already in `+page.svelte`)
  - [ ] Add an active-rotation banner to the `/rotate` form (fetched via the existing rotation-status loader data) that disables the field selector and submit button *before* the user can even attempt a submit that would 409 — pre-empting AC-6's conflict rather than only surfacing it after a failed POST; reuses the existing "rotation in progress" messaging pattern already shown elsewhere in the credential detail UI (Story 5.6 Task 6), not a new component
  - [ ] Verify in Chrome against the running app (per this project's UI-verification convention): create a multi-field credential, rotate one field, confirm the checklist and staged/promote flow behave per AC-4/AC-5; also verify the active-rotation banner appears and blocks a second attempt in the UI (not just at the API layer)

- [ ] **Task 7: Documentation reconciliation**
  - [ ] Amend `_bmad-output/planning-artifacts/epics.md`'s Story 13.4 section to match this story's corrected ACs (the literal old-model text is stale after Story 5.6 shipped) — follow Story 5.6 Task 8's precedent of updating epics.md as part of the story that supersedes it
  - [ ] Amend `_bmad-output/planning-artifacts/epics.md` line 2483's "data model prerequisites" callout to stop claiming `credential_dependencies.field_key` was already added by an earlier story — it is added by this one

## Dev Notes

- This story depends on Story 5.6 (`5-6-staged-primary-secondary-rotation-state-machine`, **done**) being shipped — confirmed via `sprint-status.yaml`. All promote/retire/staged-value mechanics, the `ACTIVE_ROTATION_STATUSES` constant, and the `409 rotation_in_progress` conflict shape already exist and are reused, not rebuilt, by this story.
- **Promote vs. retire: where the field-set snapshot lands (judgment call).** The field-set substitution (targeted fields updated, non-targeted fields carried over) happens **at initiation time**, when the new `credential_versions` row is first created — not at promote, and not at retire. This mirrors exactly how whole-secret rotation already builds its new version's content today (at initiation; promote/retire never touch field values, only `promoted_at`/`rotationLockedAt`/purge state, per Story 5.6 AC-1/AC-5). The alternative — deferring field substitution until promote — was considered and rejected: it would require `promoteRotation()` to re-decrypt and rebuild field content inside its own CAS-protected transaction, a real, unnecessary widening of a function Story 5.6 deliberately kept narrow (status-transition + `promoted_at` flip only), and would break Story 5.6 AC-8.1's staged-value reveal (`GET .../staged-value` must return the *actual* staged content, including carried-over fields, before promotion — if substitution were deferred to promote, a staged-value reveal before promotion would show a sparse/incomplete field set, violating FR12's "always a full snapshot" invariant during the entire staged window). This decision follows directly from Story 5.6 AC-8.6, which states field-scoped rotation "reuse[s] this exact state machine... with zero field-aware special-casing required" in promote/retire — the only way that's literally true is if field substitution is fully resolved before the staged row exists.
- **`rotations.target_fields` and `credential_dependencies.field_key` do not exist in the shipped schema today.** Verified by direct read of `packages/db/src/schema/rotations.ts` and `packages/db/src/schema/credential-dependencies.ts` on 2026-07-26. epics.md line 2483 lists `credential_dependencies.field_key` as an already-satisfied "epic-level data model prerequisite," and Story 5.6 AC-8.6 describes `rotations.target_fields` as pre-existing ("architecture.md line 335 / Epic 13"). Both claims are stale/aspirational, not actual — Stories 13.1, 13.2, and 13.3 did not add either column (confirmed by grep across all three story files' File Lists and the current schema). This story is the one that actually adds both, correcting the record.
- **`normalizeFieldKey()` reuse.** Field-key normalization (trim, lowercase, NFC-normalize) must use the existing `packages/shared/src/credential-templates.ts:82` helper — the same one 13.2/13.3 use for field-set edits and reveal-by-key — so `targetFields` entries compare correctly against `field_meta` keys regardless of how they were typed. Do not write a second normalization routine.
- **Error code reuse.** `400 unknown_field_key` reuses the exact code the existing `GET .../value?field=` route already returns for an unrecognized field key (`apps/api/src/modules/credentials/routes.ts:232`, added by Story 13.3). Keeping one error vocabulary for "you named a field key that doesn't exist" across reveal and rotation initiation avoids two client-side error-handling branches for the same underlying failure.
- **A stale, unrelated code comment exists at `apps/api/src/modules/rotation/service.ts:174`**, left over from Story 13.2's implementation, reading "field-scoped rotation is Story 13.5." This is a documentation drift, not a renumbering signal — `sprint-status.yaml`'s tracked backlog entry, the `bmad-correct-course` sprint-change-proposal, and Story 5.6's own AC-8.6 all consistently refer to this work as **Story 13-4** (13.5 does not exist as a registered backlog story). Flagging here so a fresh reader isn't misled by that one stale inline comment; not itself an AC of this story to fix, but worth a one-line comment correction while touching this file in Task 2/3.
- **Dependency-creation UI/API for picking `field_key` is explicitly out of scope for this story** (Task 4's judgment call) — this story adds the column and the checklist-filtering read path, but does not add a way for a user to *set* `field_key` when creating a `credential_dependencies` row via the UI. Every dependency created before and during this story defaults to `field_key = NULL` (whole-credential), which is a safe, conservative default (it means every dependency shows up on every rotation's checklist until someone scopes it down in a follow-up story) — never a silently-narrowed checklist. If Nestor wants dependency-creation field-scoping in this same story, that's a scope addition to flag before implementation, not something to infer.
- **Test file locations to extend**, following the co-located `*.test.ts` convention already used across `apps/api/src/modules/rotation/*.test.ts` and `apps/web/src/lib/components/rotations/*.test.ts`:
  - `apps/api/src/modules/rotation/rotation-promote-retire.test.ts` or a new sibling (e.g. `rotation-target-fields.test.ts`) for AC-2/AC-3/AC-5/AC-6 — use the `withTestOrg`/`withOrg` integration-test helpers already used throughout this module (see Story 5.6's `rotation-promote-retire.test.ts` for the established pattern of testing promote/retire against a freshly-staged rotation).
  - `packages/db/src/__tests__/migration-00XX-*.test.ts` (Task 1) — follow `migration-0050-staged-rotation-backfill.test.ts`'s pattern of reproducing the migration's SQL inline against `withTestOrg`, per this repo's established convention of never running the raw `.sql` file directly in tests.
  - `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/rotate-page.server.test.ts` (already exists — extend for the new `field_meta` loader fetch) and a new/extended `+page.svelte` component test for the field selector.
  - Every test touching `credential_versions`/field content must include an explicit legacy (`schema_version = 1`) case per the Epic 13 preamble's "backward compatibility is mandatory, not best-effort" mandate (`_bmad-output/planning-artifacts/epics.md` line 2484).
- **TDD**: write each failing test first (red), then implement (green), per this project's established convention (see 5.6's Task list, every subtask marked as test-first).
- **ADR — no deploy-ordering AC needed (unlike 13.1/5.6).** Both new columns are nullable and purely additive with no backfill and no inversion of existing selection logic (unlike 5.6's `promoted_at` inversion or 13.1's `current_version_id` backfill). Every pre-5.6-deployed row and every row created before this story simply reads as `NULL` = "whole credential / whole secret," which is already the correct semantic — there is no window where an old app version misreads a new column's meaning. This story therefore does not need a 13.1-style "migration must complete before the app version that assumes X deploys" AC. Recorded explicitly so a reviewer doesn't ask why one is missing.
- **Decision — selecting every field key explicitly is NOT collapsed into `target_fields = NULL`.** A user who checks every checkbox (equivalent in effect to "rotate whole secret" today) still produces `target_fields = ["username", "password", ...]`, not `NULL` — these are deliberately different wire values even though their immediate effect (every field updated, every dependency on the checklist) is the same today. Collapsing them would be a plausible-looking optimization that breaks the moment a new field is added to the credential between rotation-form-load and submit: a `NULL` "all fields" would correctly pick up the new field automatically (today's actual whole-secret behavior), but a materialized `["a","b"]` list frozen at form-load time deliberately would NOT include a field added afterward — which is the *correct*, narrower semantic for an explicit field-list selection (the user picked specific fields, not "everything"), but only if the two cases are kept genuinely distinct in code and tested separately. Write an explicit test proving "select all N fields" (`target_fields = [...]`, all fields listed) and "rotate whole secret" (`target_fields = NULL`) are different wire values with potentially different behavior if a field is added mid-flight, so a future refactor doesn't accidentally merge them.

### Project Structure Notes

- All new service logic lands in the existing `apps/api/src/modules/rotation/service.ts` (amending `initiateRotation()`) — no new module directory, consistent with Story 5.6's precedent of keeping rotation logic in this one file.
- New schema columns land in the existing `packages/db/src/schema/rotations.ts` and `packages/db/src/schema/credential-dependencies.ts` files — no new schema files.
- Web UI changes extend the existing `.../rotate/+page.svelte` + `+page.server.ts` pair — no new route directory needed (the field selector is additive UI within the existing rotation-initiation page, not a separate screen).
- No detected conflicts with the unified project structure — purely additive/amendatory within existing module boundaries, matching the same shape Story 5.6 used for its own amendments.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 13.4] lines 2592-2627 — original (now superseded-in-part) AC text; epic preamble line 2483's stale "prerequisites already satisfied" claim
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml] — 2026-07-24 `bmad-correct-course` entry flagging 13-4 for rewrite against 5-6's model; 13-4's backlog entry at the Epic 13 section; 5-6's `done` entry confirming the dependency is satisfied
- [Source: _bmad-output/implementation-artifacts/5-6-staged-primary-secondary-rotation-state-machine.md] — AC-1 (promoted_at-gated current-version selection), AC-2 (status enum, `staged`/`promoted`/`retired`), AC-5 (atomicity), AC-6 (advisory checklist), AC-8.6 (explicit multi-field/`target_fields` compatibility confirmation, cited above)
- [Source: apps/api/src/modules/rotation/service.ts] — `initiateRotation()` (line 103, full body read), `ACTIVE_ROTATION_STATUSES` (line 56), `findInProgressRotationId()` (line 79), `promoteRotation()`/`retireRotation()`/`getStagedValue()` (lines 1220/1285/1341) confirmed unchanged by this story
- [Source: packages/db/src/schema/rotations.ts] — current schema, verified 2026-07-26, no `target_fields` column
- [Source: packages/db/src/schema/credential-dependencies.ts] — current schema, verified 2026-07-26, no `field_key` column
- [Source: apps/api/src/modules/credentials/field-set.ts] — `buildFieldMeta()`, `fieldMetaForResponse()`, `FieldMeta` shape, `DEFAULT_FIELD_KEY`
- [Source: packages/shared/src/credential-templates.ts] — `normalizeFieldKey()` (line 82), `DEFAULT_FIELD_KEY` (line 64)
- [Source: apps/api/src/modules/credentials/routes.ts] — `unknown_field_key` error code precedent (line 232), added by Story 13.3
- [Source: _bmad-output/implementation-artifacts/13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates.md] — field-key normalization/uniqueness conventions, `schema_version = 2` field-set write path
- [Source: _bmad-output/implementation-artifacts/13-3-control-field-visibility-and-reveal-sensitive-fields.md] — `field_meta`-driven UI conventions, per-field reveal persona journey pattern reused for this story's field-selector persona journey
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte] and `+page.server.ts` — existing rotation-initiation form/loader, extended by this story
- [Source: apps/api/src/modules/projects/archive-guards.ts] — `BLOCKING_ROTATION_STATUSES`, confirmed unaffected by this story (archival guard operates on rotation status, not `target_fields`)
- [Source: packages/db/src/migrations/meta/_journal.json] — confirms next migration number `0055` as of 2026-07-26 (re-verify at implementation time, per this project's recurring migration-numbering-race risk, flagged identically in 13.1/13.2/5.6)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
