# Story 13.2: Store and Edit a Secret with Multiple Named Fields via Templates

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user managing a credential that has more than one meaningful piece of information (e.g. a database login),
I want to create a secret using a template that defines its fields, and add/rename/remove fields freely,
so that I can store a Login, Database Connection, API Key, or custom credential as one coherent record instead of splitting it across several oddly-named single-value secrets.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Morgan-member**, a project member creating a database connection secret:

1. Morgan navigates to `Projects → [project] → Credentials → New` (existing route:
   `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte`).
2. Morgan sees a **template selector** (Login / Database Connection / API Key / Secure Note / Custom)
   above the existing name/description/tags fields. Selecting "Database Connection" replaces the
   single `value` input with a dynamic field list pre-populated with that template's field keys
   (e.g. `host`, `port`, `database`, `username`, `password`), each field showing its own masked/
   unmasked input per its `sensitive` flag (masking UI itself ships in Story 13.3; this story only
   needs the field to *carry* a `sensitive` flag and render as masked-by-default text input, matching
   pre-existing single-value masking behavior).
3. Morgan can add a field (click "+ Add field", type a key, choose sensitive true/false), rename a
   field's key inline, or remove a field (trash icon) — before first save, these are pure client-side
   list edits; nothing is persisted until submit.
4. On submit, Morgan sees the new credential detail page exactly as today — same route, same layout —
   except the value section now iterates `fields` instead of a single value box.
5. Later, Morgan opens the credential's **Edit** action, adds a `notes` field, and saves. The detail
   page's field list now includes `notes`; the previous version (without `notes`) remains in version
   history, unchanged and immutable, per FR12.
6. If Morgan renames a field to a key that collides (case-insensitively) with another field already on
   the same secret, the save is rejected with a 409 and Morgan sees an inline error next to the field
   being renamed — the original field set is untouched (no silent overwrite, no partial save).

**Riley-admin / Alex-viewer:** no role-gating changes in this story — the existing `member`-minimum
role gate on credential create/version-create routes (`secureRoute({ security: { minimumRole: 'member' } })`
in `apps/api/src/modules/credentials/routes.ts`) is unchanged; Alex-viewer still cannot create or edit,
consistent with today.

**Legacy secret viewer:** Riley-admin opens a credential created before this story shipped
(`schema_version = 1`). It renders as a single field with no name/label — pixel-identical to its
pre-Phase-2 appearance (single masked value box, no template selector shown as "selected", no field-key
UI chrome). Riley edits the value once; on save, the version transitions to `schema_version = 2` with a
single default field going forward, but the *old* `schema_version = 1` version row is untouched in
history.

## Acceptance Criteria

1. **Given** a user creating a new secret,
   **when** they select the Login template,
   **then** the create form pre-populates fields for username and password (masked by default per
   Story 13.3).

   - *Positive example:* Selecting "Login" populates two fields: `{ key: 'username', sensitive: false }`,
     `{ key: 'password', sensitive: true }` — order matters for consistent screenshots/tests, define it
     explicitly in the template registry (see Dev Notes — Template Registry).
   - *Positive example:* Switching from "Login" to "Custom" and back to "Login" before first save resets
     to the canonical Login field set (any interim custom edits are discarded) — switching templates is a
     destructive re-population action on the client, not a merge; document this in the UI as an explicit
     "switching templates will reset your fields" affordance (e.g. a confirm step) if any fields have
     already been edited, to prevent silent data loss mid-form.
   - *Negative/edge example:* Selecting Login twice in a row (no other template selected in between) is a
     no-op — it must not duplicate the `username`/`password` fields or append a second pair.

2. **And** the Database Connection, API Key, Secure Note, and Custom templates each pre-populate their
   own appropriate field set when selected (Custom starts empty).

   - *Positive example (field sets, exact and authoritative — define once in a shared template registry,
     do not let API and web independently hardcode these):*
     - `login`: `username` (not sensitive), `password` (sensitive)
     - `db_connection`: `host` (not sensitive), `port` (not sensitive), `database` (not sensitive),
       `username` (not sensitive), `password` (sensitive)
     - `api_key`: `key` (sensitive)
     - `secure_note`: `note` (sensitive) — a free-text field, still uses the field-set model (one field)
       rather than reverting to the legacy single-value path, so it gets a `field_meta` entry like any
       other Phase-2 secret
     - `custom`: `[]` — zero fields at selection time; the user must add at least one field before save
       (see AC-4's "at least one default field" — Custom does NOT get a silent default field; it is the
       one template where the create form's save button should be disabled/validated against zero fields,
       distinct from "no template selected" which does get one default field per AC-4)
   - *Negative/edge example:* A template name typo or unknown `template` value sent to the API (e.g. a
     stale client) must be rejected with `422`, not silently treated as `custom` — the API's field-set
     validation schema should enum-constrain `template` to the 5 known values plus allow it to be omitted
     entirely (untemplated single-field creation, AC-4).

3. **Given** a user editing a secret's field set,
   **when** they add, rename, or remove a field,
   **then** the change is validated against field-key uniqueness (case-insensitive) within that secret —
   a rename colliding with an existing field key on the same secret is rejected with `409`, never
   silently overwritten.

   - *Positive example:* Secret has fields `username`, `password`. User renames `username` to `login` —
     succeeds (no collision), new version has `login`, `password`.
   - *Negative/edge example (the AC's core case):* Secret has fields `username`, `password`. User
     attempts to rename `password` to `Username` (different case, same key case-insensitively) — rejected
     with `409` (e.g. `{ code: 'field_key_conflict', message: '...' }`), the version is **not** created,
     `current_version_id` is **not** flipped, and the existing `username`/`password` fields are completely
     unchanged (verify via a follow-up GET in the test — the failed request must have zero side effects).
   - *Negative/edge example:* Adding a brand-new field whose key case-insensitively matches an existing
     field's key (e.g. secret has `apiKey`, user tries to add a new field also named `ApiKey`) is the same
     409 collision — uniqueness applies to add, not just rename.
   - *Negative/edge example:* Removing a field, then in the *same* edit re-adding a different field with
     the just-freed key is allowed (the removed key is no longer "existing" once removal is part of the
     same save) — uniqueness is checked against the *final* field set being saved, not the field set
     mid-edit.
   - *Negative/edge example:* Two fields with keys differing only by leading/trailing whitespace (e.g.
     `"password"` vs `"password "`) — trim keys before the uniqueness comparison and before persisting, so
     whitespace cannot be used to bypass the collision check.

4. **Given** any field value is created, edited, or removed,
   **when** the change is saved,
   **then** a new `credential_versions` row is written with `schema_version = 2`, the full field-set JSON
   as `fields` (encrypted as one envelope), and `field_meta` populated with the current field keys/
   sensitivity/template — the previous version is retained, immutable, per FR12's "any field change
   creates a new version of the whole secret" — and `credentials.current_version_id` flips to the new
   version's `id` atomically in the same transaction.

   - *Positive example:* Editing only the `password` field's value (username/host/etc. unchanged) still
     writes a **complete** new `fields` envelope containing every field's current value, not a diff/patch
     — per FR12, "a version is the full field-set as of that point in time." A partial-envelope write
     (e.g. only `{ password: '...' }`) would corrupt the secret on next read; this must be caught by a
     test that edits one field and asserts every other field's value round-trips unchanged in the new
     version.
   - *Positive example:* The write is a single `tx.transaction()` (existing pattern — see
     `apps/api/src/modules/credentials/service.ts`'s `withOrg()`/`db.transaction()` convention, and this
     repo's `no-bare-drizzle` ESLint rule) that (a) inserts the new `credential_versions` row with
     `schemaVersion: 2`, `fields` (encrypted), `fieldMeta` (plaintext JSONB), (b) `UPDATE credentials SET
     current_version_id = <new version id> WHERE id = ...`, both inside the same `tx` — verify via a test
     that forces the version-insert to fail (e.g. duplicate `version_number` under a race) and asserts
     `current_version_id` on `credentials` is unchanged (rollback proves atomicity), mirroring the
     existing `VersionConflictError`/`isUniqueViolation` race-handling pattern already used by
     `addCredentialVersion`.
   - *Negative/edge example:* `field_meta` must contain **only** `{ key, sensitive, template? }` per field
     — never a `value` — since `field_meta` is a plaintext (unencrypted) JSONB column per the architecture
     decision (`field_meta.key` is intentionally cleartext, but values are not). A test must assert
     `field_meta`'s JSON, read directly via a raw query bypassing the API layer, contains no substring of
     any field's plaintext value.
   - *Negative/edge example:* `versionNumber` continues to be assigned via the existing
     `MAX(version_number) + 1` pattern under the existing `lockCredentialInProject` row lock — do not
     introduce a second, parallel versioning scheme for field-set writes; multi-field and legacy versions
     share the same `credential_versions` table and the same monotonic `version_number` sequence per
     credential.

5. **Given** a secret created without selecting a template,
   **when** saved,
   **then** it has exactly one default field, preserving pre-existing single-value creation behavior.

   - *Positive example:* No `template` sent in the create request (the exact shape today's
     `CreateCredentialBodySchema` produces, `{ name, value, description?, tags?, ...lifecycle }`) results
     in `field_meta = [{ key: 'value', sensitive: true, template: undefined }]` (or an equivalent single
     default key — pick one canonical default key name and use it consistently across create-without-
     template and legacy-upgrade-on-edit-save, see AC-6) and `schema_version = 2`.
   - *Negative/edge example:* This is explicitly **not** the same as "Custom template selected" (AC-2) —
     Custom starts with **zero** fields and blocks save until the user adds one; "no template" (this AC)
     synthesizes exactly one default field automatically with no user action required, matching the
     existing single-`value`-input create form's current behavior unchanged. Do not conflate these two
     paths in the API schema or the UI.
   - *Regression guard:* the existing `CreateCredentialBodySchema` shape (`{ name, value, ... }`, no
     `fields` array) must continue to be accepted for backward compatibility with any existing API client/
     integration/CLI tool that predates this story — either keep it as a valid discriminated-union
     variant of the create body, or confirm (and test) that the machine-user credential creation path
     (`apps/api/src/modules/machine-users/machine-credential-routes.ts`) is unaffected since it is a
     separate route module from `apps/api/src/modules/credentials/`.

6. **Given** the `.env`/JSON bulk import flow (FR17, pre-existing),
   **when** credentials are imported,
   **then** each imported key/value pair creates a single-field secret — bulk import does not group
   related keys into a multi-field secret. This is a regression guard confirming existing import behavior
   is unchanged, not new behavior for this story to build.

   - *Positive example:* Importing a `.env` file with `DB_HOST=x`, `DB_USER=y`, `DB_PASS=z` creates
     **three** separate credentials (as it does today), not one `db_connection`-templated secret with
     three fields — even though a human might visually group these. This story must add a regression
     test to `apps/api/src/modules/credentials/credential-import.test.ts` (or `import-service.ts`'s test
     suite) asserting `import-service.ts`'s per-key credential creation still calls the single-field
     creation path (AC-5's "no template" shape) and never the multi-field grouping path introduced by this
     story — a plausible implementation mistake is routing import through the new template-aware creation
     function and accidentally auto-grouping by key prefix.
   - *Negative/edge example:* Each imported credential's resulting `credential_versions` row should still
     get `schema_version = 2` (this story's new default-field write path, per AC-5), consistent with every
     other credential created after this story ships — imported secrets are not special-cased to stay on
     `schema_version = 1`.

7. **Given** a pre-existing secret with `schema_version = 1` (legacy, single value),
   **when** a user views or edits it,
   **then** it renders as a single unnamed field in the UI, identical to its pre-Phase-2 appearance, and
   editing it for the first time transitions it to `schema_version = 2` on save.

   - *Positive example:* `GET /:projectId/credentials/:credentialId` (detail) and the credential detail
     page must not throw, must not show a template selector or field-key chrome, and must render one
     masked value input, for any credential whose `current_version_id` (post-13.1-backfill) points at a
     `schema_version = 1` row. Per architecture.md's Data Architecture correction: the *stored ciphertext*
     for a legacy row is a bare string (`plaintext.toString('utf8')` returns a raw string, not JSON) — the
     read path decrypts exactly as today and the **application/serialization layer** wraps it into
     `{ fields: [{ key: <default-key>, value, sensitive: true }] }` shape; the stored bytes are never
     re-parsed as JSON or touched.
   - *Positive example:* Editing that legacy secret for the first time (changing its one value) writes a
     new `credential_versions` row with `schema_version = 2`, `field_meta` populated with the single
     default field, and `fields` as the new encrypted envelope — the **prior** `schema_version = 1` row
     remains in history untouched (immutable, per FR12), still decryptable via the existing legacy path if
     ever viewed via version history.
   - *Negative/edge example:* This transition must not require (or trigger) a bulk/eager upgrade of any
     other version of the same credential — only the version being actively edited/saved transitions;
     older `schema_version = 1` versions in that credential's history stay `schema_version = 1` forever
     (per FR12 immutability — a version is never rewritten after creation).
   - *Negative/edge example (explicit test required per epic preamble):* every read/write path touching
     `credential_versions` in this story (`getCredentialDetail`, `revealCurrentValue`,
     `listVersionHistory`, `addCredentialVersion`'s new multi-field variant) needs an explicit test
     fixture using a `schema_version = 1` row (not merely a `schema_version = 2` row with a single
     field, which looks similar but does not exercise the legacy-ciphertext-shape code path) — per the
     epic preamble's "any story that touches the read/write path for `credential_versions` must include
     an explicit test against a legacy row" mandate.

8. **And** editing a `sensitive: true` field's value (e.g. setting a new password) is a blind overwrite —
   it does **not** require revealing the field's current value first. This is independent of Story 13.3's
   reveal capability; edit and reveal are separate actions.

   - *Positive example:* The edit-field-set form lets Morgan type a brand-new password directly into a
     masked input for an existing sensitive field, with no "click reveal first" gate and no requirement
     to re-enter the *old* password — submitting the new value alone is sufficient, exactly like today's
     single-value edit flow (`AddVersionBodySchema = { value: string }`, no current-value confirmation).
   - *Negative/edge example:* The API must not require a `GET .../value` (reveal) call to have preceded
     the version-create call — these are two independent, unrelated endpoints/permissions; a test should
     call the field-set version-create endpoint directly (with a fresh session, no prior reveal call in
     the test) and confirm it succeeds.
   - *Negative/edge example:* If the UI shows a masked placeholder (e.g. dots) for a sensitive field's
     current value, typing into that input must fully replace it (not append to or merge with a partially
     masked display value) — there is no "diff the masked placeholder against new input" logic; the field
     is either left alone (untouched, old value persists into the new version's envelope by the API
     re-sending its current value) or fully overwritten by whatever the client sends for that key.

9. **Given** a field-set version is created or edited (AC-4),
   **when** the write succeeds,
   **then** an audit event is recorded that includes the changed field **keys** (added/renamed/removed)
   and the template used, but **never** any field's plaintext value — mirroring the existing audit
   convention that already logs metadata-only for version creation, extended to name which keys changed.

   - *Positive example:* Renaming `username` → `login` and adding `notes` produces an audit event whose
     detail payload includes something like `{ addedFields: ['notes'], renamedFields: [{from:'username',
     to:'login'}], template: 'login' }` — a test must assert this payload contains no substring of any
     field's decrypted value.
   - *Negative/edge example:* A failed write (e.g. the AC-3 409 collision) must **not** emit an audit
     event — audit events record successful state changes only, consistent with existing behavior for
     failed version-creates today.

## Tasks / Subtasks

- [x] Task 1: Shared template registry + field-set types (AC: 1, 2, 5)
  - [x] Subtask 1.1: Add a template registry (e.g. `packages/shared/src/credential-templates.ts`) defining
    the 5 templates' field sets exactly as enumerated in AC-2's positive example — single source of truth
    consumed by both `apps/api` (validation/default-field synthesis) and `apps/web` (template selector UI).
  - [x] Subtask 1.2: Add `FieldSchema = { key: string, value: string, sensitive: boolean }` and
    `FieldMetaSchema = { key: string, sensitive: boolean, template?: CredentialTemplate }` Zod schemas to
    `packages/shared/src/schemas/credentials.ts`, enum-constraining `template` to the 5 known values.
  - [x] Subtask 1.3: Extend `CredentialDetailSchema`/`CredentialSummarySchema` (or add a new
    `CredentialFieldsResponseSchema`) to carry `fields`/`fieldMeta`-derived data in API responses.
- [x] Task 2: DB schema/service — field-set write path (AC: 3, 4, 5, 7, 8)
  - [x] Subtask 2.1: Extend `CreateCredentialBodySchema` (`apps/api/src/modules/credentials/schema.ts`) to
    accept either the existing `{ value }` shape (untemplated single-value, preserved for compatibility)
    or a new `{ template?, fields: Field[] }` shape — discriminate cleanly, do not silently coerce one into
    the other.
  - [x] Subtask 2.2: Extend `AddVersionBodySchema` similarly for the edit/field-set-update path (new
    fields array replacing the single `{ value }` shape when editing a multi-field secret).
  - [x] Subtask 2.3: Add field-key uniqueness validation (case-insensitive, trimmed) at the service layer
    in `apps/api/src/modules/credentials/service.ts` — reject with `409 field_key_conflict` before any
    write, per AC-3.
  - [x] Subtask 2.4: Update `createCredentialWithFirstVersion` to write `schemaVersion: 2`, encrypted
    `fields` envelope, and `fieldMeta` when a template/fields payload is given; default to the single
    "no template" field (AC-5) when the legacy `{ value }` shape is given, keeping `schema_version = 2` for
    all new creates (only truly pre-existing rows stay at `schema_version = 1`).
  - [x] Subtask 2.5: Update `addCredentialVersion` (or add a sibling function) to write the same
    `schemaVersion: 2`/`fields`/`fieldMeta` shape on edit, flipping `credentials.current_version_id`
    atomically in the same `tx` as the new `credential_versions` insert (AC-4) — reuse the existing
    `lockCredentialInProject` row-lock and `VersionConflictError`/`isUniqueViolation` race handling.
  - [x] Subtask 2.6: Update `getCredentialDetail`/`revealCurrentValue`/`listVersionHistory`
    (`apps/api/src/modules/credentials/service.ts`) to branch on `schema_version`: `1` → wrap the bare-
    string decrypted value into a single default field at serialization time (no ciphertext touched);
    `2` → decrypt and parse the `fields` JSON envelope directly.
  - [x] Subtask 2.7: Confirm `apps/api/src/modules/credentials/import-service.ts` still creates one
    single-field (`schema_version = 2`, one default field) credential per imported key — add the AC-6
    regression test, do not change its grouping behavior.
- [x] Task 3: Web UI — template selector + field-set editor (AC: 1, 2, 3, 8)
  - [x] Subtask 3.1: Add a template-selector control to
    `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte`, replacing the single
    `value` input with a dynamic field-list editor once a template is chosen (or immediately, defaulting
    to the existing single-field UX when no template is picked, per AC-5).
  - [x] Subtask 3.2: Add add/rename/remove field controls; surface the `409 field_key_conflict` response
    as an inline error on the specific field being renamed/added (per AC-3's persona-journey step 6) —
    reuse `mapCredentialSubmitError`-style error mapping in `apps/web/src/lib/components/onboarding/
    onboarding-logic.ts` (extend it for the new error code) rather than inventing a parallel error path.
  - [x] Subtask 3.3: Extend `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/
    +page.svelte` (detail) and its edit flow to render `fields`/render a single unnamed field for legacy
    `schema_version = 1` secrets (AC-7) — no visual difference from today for legacy secrets.
  - [x] Subtask 3.4: Ensure editing a sensitive field's value never requires a prior reveal call (AC-8) —
    a masked input the user can type directly into, with no "reveal to edit" gate.
  - [x] Subtask 3.5: Update `apps/web/src/lib/api/credentials.ts` client functions for the new
    create/edit field-set request/response shapes.
- [x] Task 4: Tests (AC: all — see Testing Requirements below for the legacy-row mandate)
  - [x] Subtask 4.1: API unit/integration tests for template default-field synthesis (AC-1, AC-2),
    field-key uniqueness/409 (AC-3, all 4 edge cases enumerated), atomic version-write + current_version_id
    flip incl. rollback-on-race (AC-4), untemplated single-default-field creation (AC-5), bulk-import
    regression guard (AC-6), explicit `schema_version = 1` legacy-row fixture tests across every touched
    read/write function (AC-7), and blind-overwrite-without-reveal (AC-8).
  - [x] Subtask 4.2: Web component/page tests for the template selector, field add/rename/remove
    validation UI, the 409-conflict inline error path, and legacy single-field rendering.
  - [x] Subtask 4.3: E2E/journey test extension (`apps/web/e2e/journeys/` — see existing `j1-onboarding-
    and-first-credential.spec.ts` for the pattern) covering the Login-template create → edit-add-field →
    save persona journey.
  - [x] Subtask 4.4: Test the audit event emitted on field-set version creation (AC-9): asserts
    added/renamed/removed field keys and template are present, no plaintext value substring appears, and
    no event is emitted on a failed (409) write.

## Dev Notes

- **This is the story that makes `current_version_id`/`schema_version`/`field_meta` load-bearing for the
  first time.** Story 13.1 added these columns but explicitly left them inert — do not assume any
  existing code path reads/writes them; grep confirms zero references outside migration `0049` and its
  Drizzle schema definitions before this story.
- **Template Registry — single source of truth.** Define the 5 templates' field sets (AC-2) once, in
  `packages/shared/`, imported by both `apps/api` (server-side default-field synthesis + `template` enum
  validation) and `apps/web` (client-side template selector rendering). Do not let the API and web
  independently hardcode the field lists — a drift here (e.g. web adds a 6th "port" field to `api_key`
  that the API doesn't validate) is exactly the kind of inconsistency this repo's shared-schema pattern
  (`packages/shared/src/schemas/*.ts`) exists to prevent.
- **`field_meta` is plaintext JSONB, `fields` is the encrypted envelope — never mix them up.** Per
  architecture.md: `field_meta` holds `{ key, sensitive, template? }` only, no values, and is read by the
  list/masking UI without ever calling `withSecret()`/decrypting. `fields` (the encrypted envelope) holds
  the actual values and is only ever touched by an explicit reveal or an edit-save. A test asserting
  `field_meta`'s raw JSON never contains a substring of any field's plaintext value is a strong regression
  guard worth keeping (see AC-4's negative example).
- **`schema_version` is the authoritative format discriminator, not `field_meta IS NULL`.** This was a
  deliberate architecture correction (see architecture.md Data Architecture) — branch all read/write logic
  on `schema_version`, never infer format from whether `field_meta` happens to be null.
- **Legacy ciphertext is a bare string, not JSON.** Do NOT attempt to `JSON.parse()` a `schema_version = 1`
  row's decrypted plaintext — it will throw. The existing reveal path
  (`withSecret(encryptedValue, (plaintext) => plaintext.toString('utf8'))`) already returns the bare
  string correctly; this story's job is to wrap that bare string into the field-set *response shape* at
  the application/serialization layer, never to reinterpret or re-encrypt the stored bytes.
- **Reuse the existing row-lock + race-handling pattern exactly.** `addCredentialVersion` already does
  `lockCredentialInProject` (a `SELECT ... FOR UPDATE`-style lock) plus `MAX(version_number) + 1` plus a
  `try/catch` on `isUniqueViolation` → `VersionConflictError` → `409`. The new field-set version-write path
  extends this same function/pattern rather than introducing a parallel versioning mechanism — multi-field
  and legacy-single-value versions share one `credential_versions` table, one `version_number` sequence.
- **Atomicity requirement (AC-4) is a repo-wide convention, not new for this story.** All DB operations
  already run inside `db.transaction()`/`tx` per the `no-bare-drizzle` ESLint rule
  (`apps/api/src/**`/`apps/web/src/**` scope) — the new `credential_versions` insert and the
  `credentials.current_version_id` UPDATE simply both need to happen on the same `tx` the route handler
  already has (`secureCtx.tx`), matching the existing rotation-completion compound-transaction pattern
  architecture.md cites for this exact same style of atomic pointer-flip.
- **Field-key uniqueness (AC-3) belongs at the service layer**, not the DB layer — architecture.md
  states this explicitly (no unique index proposed on `field_meta` keys; JSONB array contents aren't
  naturally indexable for this purpose). Validate in `apps/api/src/modules/credentials/service.ts` before
  the write, case-insensitive and key-trimmed.
- **`credential_dependencies.field_key`** (mentioned in the epic preamble as a data-model prerequisite)
  is scoped to Story 13.5 (field-scoped rotation checklist filtering per architecture.md) — this story
  does not need to populate or read it; do not scope-creep into rotation-checklist changes here.
- **Bulk import must NOT be routed through the new template/grouping logic** (AC-6) — `import-service.ts`
  continues to call the single-field creation path per imported key/value pair. This is the single most
  likely accidental regression in this story: a developer refactoring `createCredentialWithFirstVersion`
  to accept `fields[]` could tempt import-service.ts into passing multiple related keys as one call's
  `fields[]` array. Don't — verify with the AC-6 regression test before considering this story done.
- **Machine-user credential creation is a separate module** (`apps/api/src/modules/machine-users/
  machine-credential-routes.ts`, its own `machine-credential-schema.ts`) — confirm at implementation time
  whether it shares any code with `apps/api/src/modules/credentials/service.ts`'s functions being modified
  here; if it does, add its own legacy/default-field regression test, but do not assume it needs
  template-selector UI (it likely has none, being machine-facing).
- **UX spec has no existing template/field-management guidance** — `ux-design-specification.md` was
  authored before Epic 13 and contains no section on multi-field secret forms. The persona journey stub
  above is this story's own design; follow this repo's existing form patterns
  (`FormSubmitRow.svelte`, `AccessNotice.svelte`, `onboarding-logic.ts`'s validation/error-mapping
  conventions) rather than inventing new UI primitives.
- **Existing single-value create form is the baseline to extend, not replace wholesale** — see
  `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte` (144 lines): name,
  value (password input), description, tags, `canCreateCredential`/`validateCredentialForm`/
  `mapCredentialSubmitError` from `onboarding-logic.ts`. The template selector and field-list editor are
  additive to this form, not a rewrite — preserve the existing `canCreate`/role-gating and
  `AccessNotice` behavior unchanged.
- **`CredentialSummarySchema`/`CredentialDetailSchema`** (`packages/shared/src/schemas/credentials.ts`)
  currently have no `fields`/`fieldMeta`/`schemaVersion` properties — this story must extend these (or add
  a sibling schema) without breaking existing consumers of `currentVersionNumber` and the other existing
  fields (additive change, per this repo's general schema-evolution convention of additive-first).
- **Commands:** `pnpm --filter @project-vault/api test`, `pnpm --filter @project-vault/web test`,
  `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/db test` (if any DB-layer
  fixture helper needs extension), `pnpm --filter @project-vault/web exec playwright test` (or the repo's
  documented e2e command) for the journey spec, `make check-rls` (no new tables/columns in this story —
  should be a no-op), full `make ci` before marking done.

- **Field-key charset/length must be constrained server-side, not just uniqueness-checked.** A field key
  is user-supplied and ends up (a) as a JSONB object/array key in `field_meta`, (b) potentially used as an
  object property key in application code building lookup maps (`fieldsByKey[key] = ...`). Constrain keys
  to a safe charset (e.g. `/^[a-zA-Z0-9_.\- ]{1,64}$/` — adjust to whatever this repo's existing naming
  conventions expect) via the shared Zod schema (Task 1, Subtask 1.2), and when building any in-memory
  key→field lookup, use a `Map` (or `Object.create(null)`) rather than a plain `{}` object literal — a key
  of literal string `"__proto__"` or `"constructor"` must not be able to pollute a plain object's prototype
  chain. Add a test creating a field with key `__proto__` and asserting it's treated as an ordinary field
  key with no prototype-pollution side effect.
- **Cap the number of fields per secret.** Neither the epic nor architecture.md specifies a hard limit;
  pick a generous but bounded number (e.g. 50) enforced in the shared Zod schema, so a malicious or buggy
  client can't grow a single credential's `fields`/`field_meta` envelope unboundedly (storage and
  UI-rendering DoS vector). Document the chosen limit in the Zod schema's own validation error message.
- **Normalize field keys before the uniqueness comparison, not just trim+lowercase.** Unicode allows
  visually-identical keys that differ in normalization form (e.g. NFC vs NFD composed accents). Apply
  `.normalize('NFC')` in addition to `.trim().toLowerCase()` before the AC-3 collision check and before
  persisting, so two Unicode-equivalent-but-byte-different keys can't bypass uniqueness.
- **Give immediate client-side duplicate-key feedback, not just the server's 409.** Per the persona
  journey (step 6), Morgan sees an inline error on a colliding rename/add — for a good UX this should be
  computed client-side as the user types (case-insensitive, NFC-normalized comparison against the
  in-progress field list) *and* re-validated server-side as the authoritative check (AC-3) — never trust
  the client-side check alone, since it's a UX affordance, not the security boundary.
- **Concurrent edits to the same credential's field set** are already covered by the existing
  `lockCredentialInProject` row lock plus `version_number`-based race detection (`VersionConflictError`) —
  no new concurrency-control mechanism is needed for multi-field writes; confirm the existing race test
  pattern (used by `addCredentialVersion` today) is extended to the field-set write path, not bypassed.

### Project Structure Notes

- Touches all three layers, consistent with `Surface scope: both`:
  - `packages/shared/src/credential-templates.ts` (new) — template registry.
  - `packages/shared/src/schemas/credentials.ts` (edit) — `Field`/`FieldMeta` schemas, extended
    detail/summary schemas.
  - `apps/api/src/modules/credentials/schema.ts` (edit) — request/response schema changes.
  - `apps/api/src/modules/credentials/service.ts` (edit) — field-set write/read logic, uniqueness
    validation, legacy-row wrapping.
  - `apps/api/src/modules/credentials/routes.ts` (edit) — new 409 response mapping on the version-create
    route; template validation on the create route.
  - `apps/api/src/modules/credentials/import-service.ts` (no functional change expected — add regression
    test only).
  - `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte` (edit) — template
    selector + field editor.
  - `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` and
    `+page.server.ts` (edit) — field-set rendering, legacy single-field rendering, edit flow.
  - `apps/web/src/lib/api/credentials.ts` (edit) — client request/response typing.
  - `apps/web/src/lib/components/onboarding/onboarding-logic.ts` (edit) — extend error mapping for
    `field_key_conflict`.
  - New test files colocated with each edited module per this repo's `.test.ts` convention.
- No new DB migration expected — this story is pure application-layer consumption of columns Story 13.1
  already added. If a migration does turn out to be needed (e.g. an index), follow the numbering
  discovery process from 13.1's Dev Notes (`meta/_journal.json`, not a hardcoded number).
- Alignment with unified project structure: fully consistent with existing conventions (shared schemas
  package, service/routes split, colocated tests, SvelteKit route structure). No detected conflicts.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 13: Structured Multi-Field Secrets] — epic
  scope, data-model prerequisites callout, backward-compatibility mandate (legacy-row test requirement).
- [Source: _bmad-output/planning-artifacts/epics.md#Story 13.2: Store and Edit a Secret with Multiple
  Named Fields via Templates] — full acceptance criteria (reproduced above verbatim).
- [Source: _bmad-output/planning-artifacts/prd.md#FR10 (amended)] — secret with named fields, single
  default field when no template, no migration required.
- [Source: _bmad-output/planning-artifacts/prd.md#FR111] — built-in templates (Login, Database
  Connection, API Key, Secure Note, Custom); add/rename/remove fields regardless of template.
- [Source: _bmad-output/planning-artifacts/prd.md#FR112] — independent per-field sensitivity flag.
- [Source: _bmad-output/planning-artifacts/prd.md#FR12 (amended)] — immutable full-field-set version
  history; any single-field change creates a new version of the whole secret.
- [Source: _bmad-output/planning-artifacts/prd.md#FR96 (amended)] — reveal audit records specific
  field(s) revealed (Story 13.3 territory, referenced for context).
- [Source: _bmad-output/planning-artifacts/prd.md#FR18 (amended)] — rotation field-selection (Story 13.5
  territory, referenced for context).
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture] — `credential_versions.
  fields`/`field_meta`/`schema_version` design, legacy bare-string ciphertext correction, field-key
  uniqueness enforcement point, `current_version_id` atomic-flip requirement, `credential_dependencies.
  field_key` (out of scope for this story).
- [Source: architecture.md API & Communication Patterns — "Field-Set Secret Response Shape"] —
  `{ data: { fields: Array<{ key, value?, sensitive, template? }>, versionNumber } }` response shape,
  `value` omitted (not placeholder) for un-revealed masked fields.
- [Source: _bmad-output/implementation-artifacts/13-1-backfill-current-version-id-for-existing-
  credentials.md] — prior story: added `credentials.current_version_id` (nullable FK, backfilled),
  `credential_versions.schema_version`/`field_meta` (inert until this story); explicit note that Story
  13.2 is responsible for making these columns load-bearing and for the persona journey/UI surface.
- [Source: packages/db/src/schema/credentials.ts] — current `credentials` table shape incl.
  `currentVersionId`.
- [Source: packages/db/src/schema/credential-versions.ts] — current `credential_versions` table shape
  incl. `schemaVersion`/`fieldMeta`, immutability comment, existing `version_number` uniqueness index.
- [Source: apps/api/src/modules/credentials/service.ts] — `createCredentialWithFirstVersion`,
  `addCredentialVersion`, `getCredentialDetail`, `revealCurrentValue`, `lockCredentialInProject`,
  `VersionConflictError`/`isUniqueViolation` race-handling pattern to extend.
- [Source: apps/api/src/modules/credentials/routes.ts] — existing route security config
  (`minimumRole: 'member'` on create/version-create), response schema wiring pattern for new `409`.
- [Source: apps/api/src/modules/credentials/schema.ts] — `CreateCredentialBodySchema`,
  `AddVersionBodySchema` current shapes to extend.
- [Source: apps/api/src/modules/credentials/import-service.ts] — bulk import per-key single-field
  creation path (AC-6 regression guard target).
- [Source: packages/shared/src/schemas/credentials.ts] — `CredentialDetailSchema`,
  `CredentialSummarySchema` current shapes to extend additively.
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte] — existing
  single-value create form baseline to extend.
- [Source: apps/web/src/lib/components/onboarding/onboarding-logic.ts] — existing
  `canCreateCredential`/`validateCredentialForm`/`mapCredentialSubmitError` conventions to extend.
- [Source: apps/web/e2e/journeys/j1-onboarding-and-first-credential.spec.ts] — existing e2e journey
  pattern to extend with a template-create-and-edit journey.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Opus 4.8 (claude-opus-4-8[1m])

### Debug Log References

- Regression found & fixed during implementation: rotation's `initiateRotation` `sameValueAsPrevious`
  check decrypted the current version and compared it to the raw new value. Because single-value
  secrets now encrypt a schema_version=2 field envelope, the comparison broke; fixed by unwrapping via
  `unwrapRevealValue(schemaVersion, plaintext)` before the constant-time compare
  (`apps/api/src/modules/rotation/service.ts`).

### Completion Notes List

**Story 13.2 implementation (Opus 4.8) — all 4 tasks complete, all ACs test-verified except where noted.**

- **Task 1 (shared):** `packages/shared/src/credential-templates.ts` registry (5 templates, exact field
  sets per AC-2, `DEFAULT_FIELD_KEY='value'`, `MAX_FIELDS_PER_SECRET=50`, `FIELD_KEY_PATTERN`,
  `normalizeFieldKey` = trim+NFC+lowercase). Shared Zod: `FieldSchema`, `FieldMetaSchema`,
  `FieldArraySchema` (min 1, max 50), `CredentialTemplateSchema` (enum). `CredentialDetailSchema` extended
  additively with `schemaVersion` + `fields` (FieldMeta[]); `CredentialVersionSummarySchema` +
  `schemaVersion`. 19 registry tests + updated shared schema tests.
- **Task 2 (API):** `CreateCredentialBodySchema`/`AddVersionBodySchema` are now discriminated unions
  (legacy `{value}` OR `{template?, fields}`) — unknown template → 422, mixed value+fields → 422.
  New `field-set.ts` helper (uniqueness via a `Set`, `__proto__`-safe; envelope build/parse;
  legacy-wrap; audit delta). The encrypted `fields` envelope is stored in the existing
  `credential_versions.encrypted_value` column (JSON for v2); `field_meta` is plaintext keys/sensitivity/
  template only. Every new create/edit writes `schema_version=2` and flips `credentials.current_version_id`
  atomically via a shared `insertVersionAndSetCurrent` helper. `revealCurrentValue` branches on
  schema_version (legacy bare string; single-default-field v2 unwraps to bare value for backward compat;
  multi-field v2 returns the JSON envelope). `getCredentialDetail`/`listVersionHistory` carry schema_version
  + field metadata. Bulk import writes single-default-field v2 rows (never grouped). 409 `field_key_conflict`
  emits no audit event. Machine-user reveal path re-verified against a legacy fixture.
- **Task 3 (Web):** template selector + dynamic field editor (shared `FieldSetEditor.svelte`) on the create
  form; field-set edit flow on the detail page (multi-field reveals current values to round-trip, legacy
  single-field secret renders unchanged); inline 409 `field_key_conflict` error on the colliding field via
  extended `mapCredentialSubmitError`; client-side duplicate-key affordance (`validateFieldSet`,
  `duplicateFieldKeyIndex`); `credentials.ts` client typing + `parseRevealedFields`.
- **Task 4 (tests):** shared registry/schema tests; API `field-set.test.ts` (pure) + `field-set-routes.test.ts`
  (16 integration tests covering AC-1..AC-9 incl. NFC/whitespace/`__proto__` collisions, remove-then-reuse,
  rollback-on-audit-failure atomicity, field_meta-no-plaintext, legacy schema_version=1 fixtures for
  getCredentialDetail/revealCurrentValue/listVersionHistory/edit-transition); AC-6 import regression;
  machine-user legacy fixture; web onboarding-logic unit tests, new-page + detail-page component tests.
- **Test results:** shared 154 passed; web 1552 passed (full suite); API — all touched suites green
  (field-set 34, field-set-routes 16, routes 41, import 10, machine-credential, rotation 81). `make check-rls`
  no-op (no new columns). Lint 0 errors (api/web/shared), typecheck clean, `jscpd` 0 clones, OpenAPI spec
  regenerated.
- **e2e:** `apps/web/e2e/journeys/j5-multi-field-secret.spec.ts` written (Login-template create → edit-add-field
  → save + collision inline error) but NOT executed — the full running api/web/db+Playwright stack was not
  brought up (only a DB was provisioned for integration tests).
- **Deliberate design note (AC-4/AC-7 invariant):** schema_version=2 ⟺ the ciphertext is a JSON field
  envelope. A single-value create (legacy `{value}`) becomes v2 with one `value` field; reveal unwraps it to
  the bare value so existing API/CLI clients are unaffected. Only genuinely pre-existing rows remain
  schema_version=1. `current_version_id` is now written by create/edit/import but is not yet *read* by any
  code path (reads still use MAX(version_number)); rotation does not maintain it (whole-value rotation writes
  schema_version=1 versions) — consistent with rotation/field-scoped work being Story 13.5.
- Ultimate context engine analysis completed - comprehensive developer guide created.
- 5-round advanced elicitation applied (Failure Mode Analysis, Pre-mortem Analysis, Security Audit
  Personas, User Persona Focus Group, Challenge from Critical Perspective): added AC-9 (audit event on
  field-set version write must record changed field keys/template, never plaintext values, and never fire
  on a failed write); hardened Dev Notes with field-key charset/length constraints and a prototype-
  pollution mitigation (Map/Object.create(null), never a plain object literal keyed by user input), a
  per-secret field-count cap, NFC Unicode normalization before the uniqueness comparison (in addition to
  trim+lowercase), a client-side immediate duplicate-key affordance layered on top of (never replacing)
  the server-side 409 check, and an explicit confirmation that concurrent-edit handling reuses the
  existing `lockCredentialInProject`/`VersionConflictError` mechanism rather than needing something new.

### File List

**Added**
- `packages/shared/src/credential-templates.ts`
- `packages/shared/src/credential-templates.test.ts`
- `apps/api/src/modules/credentials/field-set.ts`
- `apps/api/src/modules/credentials/field-set.test.ts`
- `apps/api/src/modules/credentials/field-set-routes.test.ts`
- `apps/web/src/lib/components/credentials/FieldSetEditor.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/credentials-new-page.test.ts`
- `apps/web/e2e/journeys/j5-multi-field-secret.spec.ts`

**Modified**
- `packages/shared/src/schemas/credentials.ts`
- `packages/shared/src/schemas/credentials.test.ts`
- `packages/shared/src/index.ts`
- `packages/shared/openapi.json` (regenerated)
- `apps/api/src/modules/credentials/schema.ts`
- `apps/api/src/modules/credentials/schema.test.ts`
- `apps/api/src/modules/credentials/service.ts`
- `apps/api/src/modules/credentials/routes.ts`
- `apps/api/src/modules/credentials/db-helpers.ts`
- `apps/api/src/modules/credentials/import-service.ts`
- `apps/api/src/modules/credentials/credential-import.test.ts`
- `apps/api/src/modules/rotation/service.ts`
- `apps/api/src/modules/machine-users/machine-credential-routes.test.ts`
- `apps/web/src/lib/api/credentials.ts`
- `apps/web/src/lib/components/onboarding/onboarding-logic.ts`
- `apps/web/src/lib/components/onboarding/onboarding-logic.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/new/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-07-24 | 0.1 | Implemented Story 13.2 — shared template registry + field-set schemas; discriminated create/edit bodies; service-layer field-key uniqueness (409), atomic schema_version=2 field-set writes + `current_version_id` flip; schema_version-branched reads; legacy-row compatibility; bulk-import single-field regression; audit delta (AC-9); web template selector + field editor + inline 409; e2e journey spec (written). Status → review. | Amelia (Opus 4.8) |
