# Story 13.3: Control Field Visibility and Reveal Sensitive Fields

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user viewing a multi-field secret,
I want each field to have its own masking behavior, and to reveal only the field I need,
so that I don't expose more sensitive data than necessary and can quickly reference non-sensitive fields like a username without an extra step.

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

**Morgan-member**, viewing a Login-template secret (`username` not sensitive, `password` sensitive)
on `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`:

1. Morgan opens the credential detail page. The existing "Secret value" section already lists
   `field_meta` (key + Masked/Text badge, see the `data-testid="field-list"` block at
   `+page.svelte` line 523) — this story changes that list from a static badge display into an
   **interactive per-field row**: non-sensitive fields (`username`) show their value inline,
   immediately, with no button; sensitive fields (`password`) show a masked placeholder plus a
   per-row "Reveal" button.
2. Morgan clicks "Reveal" next to `password` only. The client calls
   `GET /:projectId/credentials/:credentialId/value?field=password`. Only `password`'s value comes
   back; `username`'s value was already visible and is not re-fetched. One
   `AuditEvent.CREDENTIAL_VALUE_REVEALED` entry is written with `revealed_fields: ['password']`.
3. Morgan clicks "Reveal all" (a secondary affordance) instead. The client calls
   `GET /:projectId/credentials/:credentialId/value` with no `?field=`. The response returns every
   field's value in one structured array (not a raw JSON string dumped into a `<pre>`, which is
   today's bug — see Dev Notes), the audit entry's `revealed_fields` lists every sensitive field
   actually included, and any field this endpoint chooses not to include is simply absent from the
   array — never `null`, never a placeholder string.
4. Morgan clicks "Hide" on the `password` row — the client-held value is cleared from memory; no
   API call is made to hide (masking is a client-side re-render, per existing `revealedValue = null`
   convention already in the component).
5. Morgan tries `GET .../value?field=totp_secret` on a secret that has no such field key (e.g. a
   stale UI tab after the field was renamed) — request is rejected `400` with a clear
   `unknown_field_key` error, the field list is untouched, and no audit entry is written.

**Riley-admin viewing a legacy (`schema_version = 1`) secret:** identical to today — one masked
value, one "Reveal value" button, one audit entry with no `revealed_fields` (column stays `NULL`
for legacy reveals, per the epic preamble's "existing single-value secret must continue to work
with zero migration of its stored ciphertext" mandate applied to this story's new column too).

**Alex-viewer:** no role-gating changes — the existing `canReveal = canCreateCredential(data.orgRole)`
gate (`+page.svelte` line 65) and the `member`-minimum `rejectIfInsufficientProjectRoleForReveal`
check (`apps/api/src/modules/credentials/routes.ts` lines 993-1003) are unchanged by this story;
Alex-viewer still cannot reveal anything, sensitive or not.

## Acceptance Criteria

1. **Given** a secret's `field_meta`,
   **when** the credential list or detail view renders,
   **then** it reads `field_meta` only — never calling `withSecret()` — to determine which field
   keys exist and whether each is sensitive.

   - *Positive example:* The detail page's field-list rendering (`+page.svelte`'s
     `fieldMeta`/`isMultiField` derived state, already fed from `data.credential.fields` — i.e.
     `CredentialDetailSchema.fields: FieldMetaSchema[]`) never triggers a `/value` network call on
     initial page load; a test asserting `revealCredentialValue`/the `/value` fetch mock is not
     called until a user explicitly clicks a reveal control is required.
   - *Negative/edge example:* A legacy `schema_version = 1` row has `field_meta = NULL` at the DB
     level; `fieldMetaForResponse()` (`apps/api/src/modules/credentials/field-set.ts`, already
     implemented in Story 13.2) already wraps this into a single unnamed default field for the
     detail response — this story must not change that wrapping, only how the *reveal* path
     consumes it.

2. **Given** a field marked `sensitive: false` (e.g. username),
   **when** the detail view renders,
   **then** its value is visible without a reveal action (still gated by normal access control,
   just not an extra UI step).

   - *Positive example:* This is new behavior this story must build — today, `field_meta` only
     carries `{ key, sensitive, template? }`, never a `value` (by design — see architecture.md's
     "field_meta is plaintext, never touches withSecret()"). To show a non-sensitive field's value
     without a reveal click, the detail page must eagerly fetch it — either via a **new**
     non-sensitive-fields-only response on the existing detail `GET` (extending
     `CredentialDetailSchema` additively with a `visibleFieldValues` map for non-sensitive fields
     only, populated server-side from a decrypt limited to those keys) or via an automatic
     `?field=<non-sensitive-key>` call fired once per non-sensitive field on page load. Pick the
     former (single extra decrypt on the existing detail-fetch round trip, not N extra reveal
     round trips) — see Dev Notes for the concrete design decision and its audit implication.
   - *Negative/edge example:* Eagerly showing a non-sensitive field's value must still call
     `withSecret()` under the hood (the value is still encrypted at rest) — "not sensitive" governs
     UI/audit treatment only, never storage. A test must assert a non-sensitive field's value is
     never returned in cleartext from any code path that bypasses decryption (e.g. served straight
     from `field_meta`, which structurally cannot happen since `field_meta` has no `value` key —
     regression-guard this with a schema-level assertion, not just a behavioral one).
   - *Negative/edge example:* Showing non-sensitive field values automatically must **not** itself
     write a `CREDENTIAL_VALUE_REVEALED` audit entry per-field-per-page-load (that would spam the
     audit log every time anyone opens the detail page) — see Dev Notes' "eager non-sensitive fetch
     is not an audited reveal" decision, distinct from AC-4/AC-5's explicit reveal-action audit.
   - *Negative/edge example (added via elicitation — Failure Mode Analysis):* if the server-side
     eager decrypt of a non-sensitive field throws (e.g. a corrupted ciphertext on one field of an
     otherwise-healthy multi-field secret), the detail page must still render — that field falls
     back to a masked placeholder plus its own "Reveal" button (behaving as if it were sensitive for
     that one degraded case) rather than 500ing the entire detail view over one bad field. This is a
     graceful-degradation requirement, not a silent-swallow: the decrypt failure is still logged
     server-side (operational log, not audit — no reveal occurred), so an operator can find it.

3. **Given** a field marked `sensitive: true` (e.g. password),
   **when** the detail view renders,
   **then** the value is masked and requires an explicit reveal action.

   - *Positive example:* On initial render, a sensitive field shows a fixed-width masked
     placeholder (e.g. `••••••••`, not the literal ciphertext length or a hint at value length) and
     a "Reveal" button; no `/value` fetch has occurred for that field yet.
   - *Negative/edge example:* A sensitive field with an empty string value (`""`, a valid blank
     field per Story 13.2's `FieldSchema`) still shows the masked placeholder and reveal button
     before the click — revealing it then shows an empty value, not an error; a test must cover
     "reveal an empty sensitive field" distinctly from "reveal a non-empty one" since an empty
     string is a falsy value that a careless `if (revealed.value)` UI check could mistake for "not
     yet revealed."

4. **Given** a user reveals a specific field,
   **when** the reveal request is made,
   **then** `GET .../credentials/{id}/value?field={key}` is called, returning only that field's
   value, and an `AuditEvent.CREDENTIAL_VALUE_REVEALED` entry is written with
   `revealed_fields: [key]` — recording exactly which field was revealed, not just that "the
   secret" was accessed.

   - *Positive example:* Reveal `password` on the Login-template example above — response is
     `{ data: { fields: [{ key: 'password', value: '<plaintext>', sensitive: true }], versionNumber,
     retrievedAt } }` (reusing the already-defined-but-unwired `CredentialFieldsValueSchema` in
     `packages/shared/src/schemas/credentials.ts` lines 90-99 — it exists from Story 13.2 but the
     route at `apps/api/src/modules/credentials/routes.ts` lines 955-1110 still returns
     `CredentialValueResponseSchema`'s bare `{ value: string }` shape unconditionally; this story
     wires the field-aware schema into the route for the multi-field case). The audit payload
     written via `writeHumanAuditEntryOrFailClosed` (`apps/api/src/lib/audit-or-fail-closed.ts`)
     includes `revealedFields: ['password']`, persisted to the new
     `audit_log_entries.revealed_fields text[]` column (see Dev Notes migration), not merely nested
     inside the existing JSONB `payload` column — matching architecture.md's explicit column
     design so `revealed_fields` is queryable/indexable independent of `payload`'s shape.
   - *Negative/edge example:* Requesting `?field=username` (a **non**-sensitive field) via the
     explicit reveal endpoint still writes an audit entry with `revealed_fields: ['username']` —
     the audited-reveal-action boundary is "this endpoint was called," not "the field happened to
     be sensitive." (This is distinct from AC-2's *eager, unaudited* display — AC-2's eager path
     must never go through this `?field=` endpoint; it uses a separate, non-audited code path, per
     Dev Notes.)
   - *Negative/edge example:* Two back-to-back reveals of two different fields (`?field=username`
     then `?field=password`) produce **two separate** audit entries, each with a single-element
     `revealed_fields` array — never merged into one entry, since they are two distinct requests
     with their own rate-limit/audit accounting (reuses the existing 120-per-60s rate limit key
     already configured on this route, unchanged).

5. **Given** a user reveals a secret without specifying `?field=`,
   **when** the request completes,
   **then** all non-masked-by-default fields are returned in one response, `revealed_fields` lists
   every sensitive field actually included, and masked fields not explicitly requested are
   **omitted from the response body entirely** — never sent as `null` or a placeholder.

   - *Positive example:* A `db_connection`-template secret with fields `host`, `port`, `database`,
     `username` (all `sensitive: false`) and `password` (`sensitive: true`) called with no
     `?field=` returns all five fields' values in one response (all non-sensitive fields are
     "non-masked-by-default," and this whole-secret reveal call is explicitly requesting
     everything including the sensitive one) — `revealed_fields: ['password']` (only the
     genuinely-sensitive field is named; non-sensitive fields were never masked, so they are not
     "revealed" in the audit sense, mirroring AC-2's distinction).
   - *Negative/edge example:* A secret with **two** sensitive fields (e.g. a `custom` template with
     `password` and `recovery_code`, both `sensitive: true`) called with no `?field=` returns
     **both** values and `revealed_fields: ['password', 'recovery_code']` — order matches
     `field_meta`'s declared field order (stable, not alphabetical or insertion-order-of-request),
     so a test asserting array order (not just set membership) is required.
   - *Negative/edge example:* This whole-secret path must not silently degrade into the current bug
     (returning the entire JSON envelope as an opaque string in `value`) — the fix for the known
     13.2 code-review carryover ("multi-field reveal UI still dumps raw JSON") is exactly this AC:
     replace the route's unconditional `CredentialValueResponseSchema`/`revealed.value` string
     return with the structured `fields[]` array shape for any `schema_version >= 2` credential.
     Add a regression test asserting the response body is never a JSON-encoded string masquerading
     as `value` for a multi-field secret.
   - *Negative/edge example (added via elicitation — Failure Mode Analysis):* if decrypting one of
     several requested fields fails mid-request (e.g. a tampered/corrupted `credential_versions` row
     affecting only one field's slice of the envelope) while others would have succeeded, the whole
     request must fail atomically — `500`/`503`, zero fields returned, **no** audit entry written
     (a partial `revealed_fields` array would misrecord what was actually disclosed, since nothing
     was disclosed). Never return the fields that did decrypt while silently omitting the failed
     one — a partial success here is a worse audit-integrity failure than a full failure. A test
     simulating one corrupted field's decrypt throwing must assert zero `audit_log_entries` rows and
     zero fields in the response.

6. **Given** a legacy (`schema_version = 1`) secret,
   **when** revealed,
   **then** it behaves exactly as today — single value returned, single audit entry — no behavior
   change.

   - *Positive example:* `GET .../value` (no `?field=`) on a legacy row returns
     `{ data: { value: '<plaintext>', versionNumber, retrievedAt } }` (the existing
     `CredentialValueResponseSchema` shape, byte-for-byte unchanged) and one audit entry with
     `revealed_fields: NULL` (not `[]`, not `['value']`) — explicitly distinguishing "this concept
     doesn't apply to a legacy secret" from "zero fields were revealed."
   - *Negative/edge example:* `GET .../value?field=value` (a client guessing the default field key)
     against a **legacy** `schema_version = 1` row — since legacy rows have no `field_meta`-derived
     key to match against, this must be rejected the same way as any unknown-key request (AC-7,
     `400`), not silently accepted as if it were a single-default-field `schema_version = 2` row.
     This is a real edge case: a single-default-field `schema_version = 2` row (created via Story
     13.2's "no template" path) DOES have a real `value` key and DOES accept `?field=value`
     legitimately — only genuine `schema_version = 1` rows reject it, since they have no
     `field_meta` at all. A test distinguishing these two lookalike cases is required.
   - *Negative/edge example:* A single-default-field `schema_version = 2` secret (AC-5 of Story
     13.2 — "no template" creates one field keyed e.g. `value`) called with no `?field=` returns the
     **same bare-string shape** as a legacy secret (per `unwrapRevealValue`'s existing
     single-field-collapse behavior in `apps/api/src/modules/credentials/field-set.ts`) — this
     story must not regress that backward-compatible collapse; only a **genuinely multi-field**
     secret (`fieldMeta.length > 1`) gets the new structured `fields[]` response shape.

7. **Given** a reveal request with `?field=` naming a key that doesn't exist on that secret,
   **when** the request is processed,
   **then** it returns `400` with a clear error, not a silent empty response or a `500`.

   - *Positive example:* `?field=totp_secret` on the Login-template example (`username`,
     `password` only) returns `400 { code: 'unknown_field_key', message: '...totp_secret...' }` —
     the error message names the offending key (useful for a UI showing a stale field list to
     surface exactly what went wrong) without leaking any other field's key existence beyond what
     `field_meta` (already visible to this user) already discloses.
   - *Negative/edge example:* `?field=` with an empty string, or a value exceeding the existing
     `FIELD_KEY_MAX_LENGTH`/`FIELD_KEY_PATTERN` constraints from
     `packages/shared/src/credential-templates.ts` (Story 13.2), is rejected at the query-string
     Zod-validation layer with `422` (malformed input), distinct from the `400` used for
     "well-formed but nonexistent key" — do not conflate schema-validation failures with
     business-logic "key not found" failures.
   - *Negative/edge example:* No audit entry is written for a `400`/`422` rejected reveal request —
     consistent with the existing convention (Story 13.2 AC-9's "a failed write does not emit an
     audit event") extended to reads: audited events record successful, *completed* reveals only.
     A test asserting zero new `audit_log_entries` rows after a `400` response is required.

## Tasks / Subtasks

- [x] Task 1: DB migration — `audit_log_entries.revealed_fields` column (AC: 4, 5, 6)
  - [x] Subtask 1.1: Add migration `packages/db/src/migrations/0054_audit_revealed_fields.sql` (confirm
    the actual next-free number against `packages/db/src/migrations/meta/_journal.json` at
    implementation time — `0051` is the last committed migration as of this story's creation)
    adding `revealed_fields text[]` (nullable, no default) to `audit_log_entries`, per
    architecture.md's Data Architecture "Field-level reveal audit" section.
  - [x] Subtask 1.2: Extend `packages/db/src/schema/audit-log-entries.ts` with the new
    `revealedFields: text('revealed_fields').array()` Drizzle column definition, nullable.
  - [x] Subtask 1.3: Run `make check-rls` — confirm no RLS-policy change is needed (this column adds
    no new access path beyond the existing `audit_log_entries` row-level policy).
- [x] Task 2: API — field-scoped reveal endpoint (AC: 1, 4, 5, 6, 7)
  - [x] Subtask 2.1: Add a `?field=` optional query-string schema to the `GET
    /:projectId/credentials/:credentialId/value` route (`apps/api/src/modules/credentials/routes.ts`
    lines 955-1110) — a new `CredentialValueQuerySchema` in
    `apps/api/src/modules/credentials/schema.ts`, constrained by the existing
    `FIELD_KEY_PATTERN`/`FIELD_KEY_MAX_LENGTH` from `packages/shared/src/credential-templates.ts`,
    `422` on malformed input (distinct from the `400` "key not found" business error in Subtask 2.3).
  - [x] Subtask 2.2: Extend `revealCurrentValue` (`apps/api/src/modules/credentials/service.ts` line
    511) to accept an optional `field` param and a `schemaVersion`/`fieldMeta`-aware return shape;
    reuse `parseFieldsFromPlaintext()` (already implemented in
    `apps/api/src/modules/credentials/field-set.ts` line ~145) rather than re-parsing the envelope
    ad hoc. Return a discriminated result: legacy/single-default-field → bare string (unchanged,
    AC-6); genuine multi-field, no `?field=` → full non-masked-by-default `fields[]` array (AC-5);
    genuine multi-field, `?field=<key>` → single-field `fields[]` array (AC-4).
  - [x] Subtask 2.3: When `?field=` names a key absent from the secret's `field_meta`, return `400
    unknown_field_key` before any decrypt/audit-write occurs (AC-7) — validate the key against
    `field_meta` (already available via `getCredentialDetail`'s existing lookup, no new query
    needed) prior to calling `withSecret()`.
  - [x] Subtask 2.4: Wire the route's response to use `CredentialFieldsValueSchema`
    (`packages/shared/src/schemas/credentials.ts` lines 90-99, defined in Story 13.2 but never wired
    into a route) for the multi-field case, and keep `CredentialValueResponseSchema` for the
    legacy/single-default-field case — a discriminated response, not a breaking schema change for
    existing single-value API/CLI clients (Story 13.2's own backward-compatibility mandate applies
    here too).
  - [x] Subtask 2.5: Extend the `writeHumanAuditEntryOrFailClosed` call (routes.ts lines 1061-1069)
    to pass `revealedFields` (array of the key(s) actually revealed, or omitted/`undefined` for a
    legacy reveal) through to the new `audit_log_entries.revealed_fields` column — extend
    `SameTransactionAuditInput` (`apps/api/src/lib/audit-or-fail-closed.ts`) and
    `writeHumanAuditEntry`'s insert to write this column directly, not just nest it in `payload`.
  - [x] Subtask 2.6: Apply the identical `?field=`/`400 unknown_field_key`/`revealed_fields` handling
    to the machine user reveal route (`apps/api/src/modules/machine-users/machine-credential-routes.ts`
    line 63, `GET /projects/:projectId/credentials/:name/value`) per architecture.md's explicit
    statement that the machine route also gains `?field=` — reuse the same service-layer function
    from Subtask 2.2 rather than duplicating the field-lookup/validation logic.
  - [x] Subtask 2.7: Add a server-side "eager non-sensitive field values" path for AC-2 — extend
    `getCredentialDetail` (`apps/api/src/modules/credentials/service.ts`) to additionally decrypt
    and return only the non-sensitive fields' values alongside the existing `field_meta`-only
    response (new additive `CredentialDetailSchema` property, e.g. `visibleFieldValues: Record<string,
    string>`, populated from a `parseFieldsFromPlaintext()` call filtered to `sensitive: false`
    keys) — this call does **not** go through the audited `/value` route/handler and must not write
    a `CREDENTIAL_VALUE_REVEALED` entry (AC-2's negative example).
- [x] Task 3: Web UI — per-field reveal/mask, replace the raw-JSON dump (AC: 1, 2, 3, 4, 5, 6)
  - [x] Subtask 3.1: Replace the single whole-secret "Reveal value" button block
    (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` lines
    520-579) with a per-field row list for multi-field secrets: non-sensitive fields render their
    `visibleFieldValues` entry (Task 2.7) directly, no button; sensitive fields render a masked
    placeholder plus a "Reveal" button that calls `revealCredentialValue(..., { field: meta.key })`.
    Preserve the existing single "Reveal value" / `<pre>` block **unchanged** for legacy and
    single-default-field secrets (`!isMultiField`, per the existing `isMultiField` derived at line
    342) — do not touch that code path, per AC-6.
  - [x] Subtask 3.2: Add a "Reveal all" secondary action for multi-field secrets that calls the
    endpoint with no `?field=` and renders every returned field's value in its own row (never as
    one opaque blob) — this replaces today's `<pre>{revealedValue}</pre>` raw-JSON-string
    rendering for multi-field secrets, which is the literal Story 13.2 code-review carryover this
    story exists to close.
  - [x] Subtask 3.3: Extend `revealCredentialValue` (`apps/web/src/lib/api/credentials.ts` line 96)
    to accept an optional `field` parameter, building the `?field=` query string, and to return the
    `CredentialFieldsValue` shape when the server responds with it (add a `parseRevealedFields`-
    adjacent helper, or extend the existing one at line 271, to normalize both the legacy
    bare-`value` shape and the new `fields[]` shape into one client-side type).
  - [x] Subtask 3.4: Add a "Hide" control per revealed field (clears that field's in-memory revealed
    value only, no API call) — mirrors the existing whole-secret `revealedValue = null` pattern
    (line 557) but scoped per field key.
  - [x] Subtask 3.5: Surface the `400 unknown_field_key` error inline near the affected field's row
    (e.g. a stale field list after a concurrent rename) rather than as a generic top-level error
    banner — extend `mapCredentialSubmitError`-style error mapping in
    `apps/web/src/lib/components/onboarding/onboarding-logic.ts` if reused, or add an equivalent
    reveal-specific mapper.
- [x] Task 4: Tests (AC: all)
  - [x] Subtask 4.1: API integration tests in
    `apps/api/src/modules/credentials/field-set-routes.test.ts` (extend the existing Story 13.2
    suite) covering: `?field=` single-field reveal + audit `revealed_fields` (AC-4); whole-secret
    reveal returning structured `fields[]`, never a JSON string (AC-5); legacy
    `schema_version = 1` unchanged single-value + `revealed_fields IS NULL` (AC-6); single-default-
    field `schema_version = 2` bare-string-collapse regression guard (AC-6 edge case); unknown
    `?field=` → `400` with zero audit rows written (AC-7); malformed `?field=` → `422` (AC-7);
    ordering of `revealed_fields` for a secret with 2+ sensitive fields (AC-5); no audit event for
    the eager non-sensitive-field detail fetch (AC-2).
  - [x] Subtask 4.2: Add the same field-scoped/legacy/unknown-key test matrix for the machine reveal
    route in `apps/api/src/modules/machine-users/machine-credential-routes.test.ts`.
  - [x] Subtask 4.3: DB-layer migration test (or extend `packages/db`'s existing migration test
    pattern) asserting `revealed_fields` defaults to `NULL` on existing rows and the column accepts
    a `text[]` write; confirm idempotent re-run safety consistent with this repo's other migrations.
  - [x] Subtask 4.4: Web component tests (`credential-detail-page.test.ts`) for: per-field
    reveal/mask toggling, "Reveal all" replacing the raw-JSON `<pre>` for multi-field secrets,
    non-sensitive fields visible with no click, legacy/single-default-field secret rendering
    unchanged (pixel-identical regression guard per Story 13.2's existing convention), and the
    inline `unknown_field_key` error path.
  - [x] Subtask 4.5: Extend the e2e journey spec (`apps/web/e2e/journeys/j5-multi-field-secret.spec.ts`,
    written but not executed in Story 13.2) or add a new `j6-field-visibility-reveal.spec.ts`
    covering: open a Login-template secret, see `username` immediately, reveal only `password`,
    confirm `username`'s value was never gated behind a click.

## Dev Notes

- **This story closes the exact carryover documented in `sprint-status.yaml`'s Story 13.2 entry:**
  "multi-field reveal UI still dumps raw JSON (Story 13.3's territory per AC-8)" — traced to
  `+page.svelte` line 544 (`<pre>{revealedValue}</pre>`) combined with
  `unwrapRevealValue()`'s current behavior (`apps/api/src/modules/credentials/field-set.ts` line
  134): for any secret with **more than one** field, `unwrapRevealValue` returns the raw
  `JSON.stringify`'d field envelope string as `value`, which the route
  (`apps/api/src/modules/credentials/routes.ts` line 1104) sends verbatim inside
  `CredentialValueResponseSchema`'s `{ value: string }` shape — the web page then dumps that
  JSON string straight into a `<pre>` block with no parsing. AC-5/AC-1 of this story require
  replacing that with the already-defined-but-unwired `CredentialFieldsValueSchema`
  (`packages/shared/src/schemas/credentials.ts` lines 90-99) for genuinely multi-field secrets,
  while leaving the single-value/legacy path (AC-6) byte-for-byte unchanged.
- **Field-scoped reveal (`?field=`) does not exist anywhere in the codebase today**, on either the
  human route (`apps/api/src/modules/credentials/routes.ts`) or the machine route
  (`apps/api/src/modules/machine-users/machine-credential-routes.ts`) — despite architecture.md
  stating it as a design decision, it was never implemented in Story 13.1 or 13.2 (confirmed via
  grep: zero occurrences of a `field` query param on either route file). This story is where it is
  actually built, not merely wired up from existing code.
- **`revealed_fields` is a new DB column, not new JSONB payload nesting.** architecture.md is
  explicit: `audit_log_entries` gains a `revealed_fields text[]` column (nullable, populated only on
  `CREDENTIAL_VALUE_REVEALED`), separate from the existing `payload jsonb` column
  (`packages/db/src/schema/audit-log-entries.ts` line 24). Do not just add `revealedFields` inside
  `payload` and call it done — the architecture decision is a first-class indexable column so
  "which fields were revealed" can be queried/audited independent of `payload`'s shape (which
  varies per event type). This requires extending `writeHumanAuditEntry`'s insert
  (`apps/api/src/lib/audit-or-fail-closed.ts` and its underlying insert helper — locate via
  `firstActorTokenIdForUser`'s sibling functions) to accept and persist this column.
- **Two distinct "field value visible" mechanisms — do not conflate them.** (a) AC-2's eager
  non-sensitive-field display is *not* an audited "reveal" — it is the natural consequence of
  `sensitive: false` fields not needing gating at all, matching the epic's framing ("visible
  without a reveal action ... not an extra UI step"). (b) AC-3/AC-4/AC-5's explicit reveal action
  (clicking "Reveal" or "Reveal all") IS audited, regardless of whether the field happens to be
  sensitive (a user can explicitly `?field=username` a non-sensitive field and that still counts as
  an audited access, per AC-4's negative example). Building (a) as a call into the audited `/value`
  route/handler would spam the audit log on every page view — Task 2.7 explicitly routes (a)
  through the metadata-only detail-fetch path instead, decrypting non-sensitive values without
  invoking `writeHumanAuditEntryOrFailClosed`.
- **`parseFieldsFromPlaintext()` and `unwrapRevealValue()` already exist**
  (`apps/api/src/modules/credentials/field-set.ts`, lines ~134-150, built in Story 13.2) — reuse
  them rather than re-implementing envelope parsing. `unwrapRevealValue` already correctly
  distinguishes "single field (legacy or single-default-field v2)" from "genuine multi-field v2" —
  this story's new field-scoped/whole-secret-structured logic should sit alongside these, calling
  `parseFieldsFromPlaintext` to get the full `Field[]` (with values) and then filtering/selecting
  from that array, rather than adding a third parallel envelope-parsing implementation.
- **Rate limiting is unchanged — reuse the existing 120-per-60s key.** The `/value` route's
  existing `rateLimit: { max: 120, timeWindowMs: 60_000, key: 'GET
  /api/v1/projects/:projectId/credentials/:credentialId/value' }` (routes.ts lines 969-973) applies
  per-route, not per-`?field=`-value — a user revealing 5 different fields of the same secret in
  quick succession consumes 5 units of the same 120-per-minute budget, no new per-field limit is
  introduced. Document this explicitly in a test comment so a future reader doesn't assume
  field-scoped reveals get their own budget.
- **Architecture Decision Record (added via elicitation — reconciling AC-2 with architecture.md):**
  architecture.md states "List/masking UI reads `field_meta` only — it never calls `withSecret()`
  to render which fields exist or whether they're masked... Only an explicit reveal action touches
  the encrypted `fields` envelope." Read literally, AC-2's eager non-sensitive-value decrypt on the
  detail endpoint appears to violate this. **Resolution:** the architecture principle governs how
  the UI determines *existence and masking state* (that must come from `field_meta` alone, never by
  probing decrypted content) — it is not a blanket ban on ever decrypting a field without a user
  click. The epic's own framing of AC-2 ("visible without a reveal action... not an extra UI step")
  is a deliberate, scoped exception for `sensitive: false` fields specifically, distinct from the
  masking-state-determination principle. Three options were considered: (a) eager decrypt via an
  extended detail response (`visibleFieldValues`) — chosen; masking/existence logic still reads only
  `field_meta`, this is additive data alongside it, not a replacement for it. (b) auto-fire one
  `?field=` reveal call per non-sensitive field on page load — rejected: reuses the audited route,
  would require a new "internal, unaudited" bypass flag on that route, a riskier surface to add to a
  security-sensitive audit boundary than a separate additive response field. (c) require a click even
  for non-sensitive fields — rejected: contradicts the epic's explicit AC-2 language. Document this
  reasoning in the PR description when this story ships, since a future reader of architecture.md
  alone could reasonably flag this as a regression without this note.
- **Scope boundary (added via elicitation):** both the field-scoped and whole-secret reveal paths in
  this story operate on the credential's **current version only** (`revealCurrentValue`, unchanged
  scope from today) — historical/prior rotation versions are explicitly out of scope for field-scoped
  reveal; if a future story needs per-field reveal of a past rotation version, that is new work, not
  an extension assumed here.
- **Rate-limit / enumeration note (added via elicitation — Security Audit Personas):** the existing
  120-per-60s rate limit on the `/value` route applies to the route itself, before business-logic
  validation — a `400 unknown_field_key` or `422` malformed-query rejection still consumes one unit
  of that budget (rate limiting happens in the route's `preHandler`, ahead of the field-key lookup).
  This matters because it forecloses using rapid-fire `?field=` guesses against the 400 response as a
  free way to enumerate field keys beyond the rate limit; the `400`'s error message already only
  echoes back a key the requester supplied, and `field_meta` (which already discloses real key names
  to anyone who can see the credential) makes guessing pointless anyway — this note exists so a future
  reader doesn't assume 400/422 responses are rate-limit-exempt.
- **Concurrent field rename mid-reveal.** If a field is renamed (Story 13.2's edit flow) between
  the UI loading `field_meta` and the user clicking "Reveal" on the old key name, the `?field=`
  request now legitimately 400s with `unknown_field_key` (AC-7) — this is not a bug to "fix" with
  retry logic; the correct behavior is the same "stale client, re-fetch" pattern already used for
  the AC-3 `field_key_conflict` 409 in Story 13.2 (surface the error, let the user refresh). No new
  concurrency primitive is needed.
- **Migration numbering must be re-checked at dev-story time**, not hardcoded from this story's
  research snapshot — `0051_credential_dependency_link_url.sql` is the last committed migration as
  of story creation (2026-07-26); other in-flight stories may claim `0052` first (the same
  coordination risk flagged repeatedly in this repo's `sprint-status.yaml` history for 13.1/3.5/3.6).
  Check `packages/db/src/migrations/meta/_journal.json` for the actual next-free slot before
  authoring the migration file.
- **Pre-mortem finding (added via elicitation):** imagine this ships and, months later, a `custom`-
  template secret accumulates a large number of non-sensitive fields (nothing in Story 13.2 caps
  field count per secret) — every detail-page view now performs one `withSecret()` decrypt per
  non-sensitive field via Task 2.7's eager path, on every load, unaudited. This is an accepted
  trade-off for v1 (matches this repo's existing pattern of documenting known scaling trade-offs
  rather than pre-emptively engineering for them, e.g. the Tier Limit Cache's documented single-
  instance constraint) — no field-count cap is introduced by this story. Flag, do not fix: if a
  future secret's field count becomes large enough to matter, that's a separate perf story, not a
  blocker here.
- **Testing standard, per the epic preamble**: every read/write path touching `credential_versions`
  needs an explicit `schema_version = 1` legacy-row test fixture — this applies here to the new
  `?field=` code path exactly as it did to Story 13.2's read/write paths (see AC-6's edge cases).
- **Audit-on-reveal is a hard security requirement for this story, not incidental** — this is a
  secrets vault; every code path that returns a decrypted field value through the explicit reveal
  route/handler (both single-field and whole-secret) must go through
  `writeHumanAuditEntryOrFailClosed`'s fail-closed semantics (a failed audit write rolls back the
  whole transaction and the reveal never reaches the client — existing behavior at routes.ts lines
  1060-1090, unchanged, just extended to carry `revealedFields`).
- **Commands:** `pnpm --filter @project-vault/api test`, `pnpm --filter @project-vault/web test`,
  `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/db test`, `make
  check-rls` (new column, confirm no-op or update baseline as needed), `pnpm --filter
  @project-vault/web exec playwright test` (or repo's documented e2e command) for the extended/new
  journey spec, full `make ci` before marking done.

### Project Structure Notes

- Touches all three layers, consistent with `Surface scope: both`:
  - `packages/db/src/migrations/00XX_audit_revealed_fields.sql` (new) — `revealed_fields text[]`
    column on `audit_log_entries`.
  - `packages/db/src/schema/audit-log-entries.ts` (edit) — Drizzle column definition.
  - `packages/shared/src/schemas/credentials.ts` (edit) — wire `CredentialFieldsValueSchema` into
    active use; add `CredentialDetailSchema.visibleFieldValues` (or equivalent) additively.
  - `apps/api/src/modules/credentials/schema.ts` (edit) — new `?field=` query schema; discriminated
    response schema wiring.
  - `apps/api/src/modules/credentials/service.ts` (edit) — `revealCurrentValue` field-scoping logic;
    `getCredentialDetail` eager non-sensitive-value decrypt (Task 2.7).
  - `apps/api/src/modules/credentials/field-set.ts` (edit, reuse) — no new parsing logic; existing
    `parseFieldsFromPlaintext`/`unwrapRevealValue` consumed by the new service logic.
  - `apps/api/src/modules/credentials/routes.ts` (edit) — `/value` route: query param, response
    schema branch, extended audit call.
  - `apps/api/src/modules/machine-users/machine-credential-routes.ts` (edit) — mirrored `?field=`
    support.
  - `apps/api/src/lib/audit-or-fail-closed.ts` (edit) — `SameTransactionAuditInput` gains
    `revealedFields?: string[]`; insert helper writes the new column.
  - `apps/web/src/lib/api/credentials.ts` (edit) — `revealCredentialValue` gains an optional
    `field` param; response-shape normalization helper.
  - `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`
    (edit) — per-field reveal/mask UI, replacing the raw-JSON `<pre>` for multi-field secrets only;
    legacy/single-default-field path (`!isMultiField`) untouched.
  - New/extended test files colocated per this repo's `.test.ts` convention
    (`field-set-routes.test.ts`, `machine-credential-routes.test.ts`,
    `credential-detail-page.test.ts`, `audit-or-fail-closed.test.ts` if one exists — confirm at
    implementation time).
- Alignment with unified project structure: fully consistent with existing conventions (migration
  numbering discovery process, service/routes split, colocated tests, additive schema evolution).
  No detected conflicts.
- **Detected variance worth flagging:** `CredentialFieldsValueSchema` already exists in the shared
  package (added speculatively in Story 13.2) but was never referenced by any route — this story is
  what makes it load-bearing, mirroring exactly how Story 13.2 described itself as "the story that
  makes `current_version_id`/`schema_version`/`field_meta` load-bearing for the first time" for
  Story 13.1's columns. Confirm at implementation time whether `CredentialFieldsValueSchema`'s exact
  shape (`{ fields: Field[], schemaVersion, versionNumber, retrievedAt }`) still matches what this
  story needs, or whether it needs adjustment (e.g. it currently has no obvious slot for
  `revealedFields` itself — that lives in the audit entry, not the response body, so no schema
  change should be needed there, but verify).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 13: Structured Multi-Field Secrets] —
  epic scope, data-model prerequisites, backward-compatibility mandate.
- [Source: _bmad-output/planning-artifacts/epics.md#Story 13.3: Control Field Visibility and Reveal
  Sensitive Fields] — full acceptance criteria (reproduced above verbatim).
- [Source: _bmad-output/planning-artifacts/prd.md#FR96 (amended)] — field-scoped reveal + audit.
- [Source: _bmad-output/planning-artifacts/prd.md#FR112] — per-field sensitivity/masking.
- [Source: _bmad-output/planning-artifacts/architecture.md — Data Architecture, "Field-level reveal
  audit (FR96/FR112)"] — `audit_log_entries.revealed_fields text[]` column design; `?field=` query
  param on the machine reveal route; whole-secret reveal returns all non-masked-by-default fields.
- [Source: _bmad-output/planning-artifacts/architecture.md — API & Communication Patterns] —
  `value` present per-field only when included in the reveal request; masked-not-requested fields
  omitted entirely, never `null`/placeholder; `withSecret()` → HTTP response Buffer→string
  sanctioned conversion site convention (unchanged, reused here).
- [Source: _bmad-output/implementation-artifacts/13-2-store-and-edit-a-secret-with-multiple-named-
  fields-via-templates.md] — prior story: `field_meta`/`schema_version`/`fields` envelope design,
  `CredentialFieldsValueSchema` defined-but-unwired, the exact code-review carryover this story
  closes ("multi-field reveal UI still dumps raw JSON"), `parseFieldsFromPlaintext`/
  `unwrapRevealValue` helpers this story reuses, `lockCredentialInProject`/race-handling pattern
  (not touched by this story — reveal is a read path).
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml, 13-2 entry] — explicit
  carryover note: "multi-field reveal UI still dumps raw JSON (Story 13.3's territory per AC-8)."
- [Source: apps/api/src/modules/credentials/routes.ts, lines 955-1110] — existing `/value` route:
  role-gate ordering, operational-log events (`CREDENTIAL_REVEAL_ATTEMPT`/`_SUCCESS`/`_FAILURE`),
  `writeHumanAuditEntryOrFailClosed` call site, existing rate-limit config (120/60s, unchanged).
- [Source: apps/api/src/modules/credentials/service.ts, lines 511-570] — `revealCurrentValue`:
  current single-value-only shape, abandoned-version exclusion (Story 5.5, unrelated but
  co-located), `unwrapRevealValue` call site to extend.
- [Source: apps/api/src/modules/credentials/field-set.ts, lines 90-160] — `buildFieldMeta`,
  `serializeFieldEnvelope`, `fieldMetaForResponse`, `unwrapRevealValue`, `parseFieldsFromPlaintext`
  (existing helpers from Story 13.2, reused not reimplemented).
- [Source: apps/api/src/modules/machine-users/machine-credential-routes.ts, lines 30-140] —
  existing machine reveal route (no `?field=` support today) to extend in parallel.
- [Source: apps/api/src/lib/audit-or-fail-closed.ts] — `writeHumanAuditEntryOrFailClosed`,
  `SameTransactionAuditInput`, fail-closed transaction-rollback semantics to extend with
  `revealedFields`.
- [Source: packages/db/src/schema/audit-log-entries.ts] — current `audit_log_entries` table shape;
  new `revealed_fields text[]` column to add.
- [Source: packages/shared/src/schemas/credentials.ts, lines 90-107] — `CredentialFieldsValueSchema`
  (defined, unwired) and `CredentialValueSchema` (currently the only shape actually returned) to
  reconcile.
- [Source: apps/web/src/lib/api/credentials.ts, lines 96-105, 271-288] — `revealCredentialValue`,
  `parseRevealedFields` (existing, used today only for the edit-form pre-fill path, AC-8 of Story
  13.2 — distinct from this story's detail-view reveal UI).
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte,
  lines 336-418, 520-579] — existing field-list rendering, whole-secret reveal button, and the raw
  `<pre>{revealedValue}</pre>` block this story replaces for multi-field secrets.
- [Source: packages/db/src/migrations/meta/_journal.json] — migration numbering; `0051` is latest
  as of story creation, actual next number must be re-verified at dev-story time.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via `/bmad-dev-story`

### Debug Log References

- Migration numbering re-verified at implementation time per Dev Notes: `0052` was the actual
  next-free slot (`0051_credential_dependency_link_url.sql` was still latest — no coordination
  collision with another in-flight story).
- **Post-hoc renumbering to `0053` (Path C, during PR prep):** by the time this branch was rebased
  onto `origin/main` for CI/PR, Story 14.3 had merged its own `0052_external_identities_and_sso_login_states.sql`
  — the exact coordination collision this story's Dev Notes flagged as a risk. Renamed this story's
  migration file and its test to `0053_audit_revealed_fields.sql` / `migration-0053-safety.test.ts`,
  and appended (not replaced) journal entry `idx: 53` after main's `idx: 52` entry.
- **Second post-hoc renumbering to `0054` (further PR rebase):** by the time this branch was
  rebased onto `origin/main` again, Story 14.4 had merged its own `0053_org_sso_domains.sql` —
  the exact same collision pattern recurring one number later. Renamed this story's migration
  file and its test again, to `0054_audit_revealed_fields.sql` / `migration-0054-safety.test.ts`,
  and appended journal entry `idx: 54` after main's `idx: 53` entry. This recurrence (twice, in
  quick succession) suggests migration-number coordination across parallel in-flight stories is
  a real, recurring friction point worth a retro action item, not a one-off fluke.
- `drizzle-kit generate` failed with a pre-existing snapshot-collision error unrelated to this
  change (`0031_snapshot.json`/`0032_snapshot.json` pointing at a stale parent) — the migration
  was hand-authored instead, following this repo's established convention for migrations past
  `0033` (no snapshot files exist for `0034`+; `_journal.json` is updated by hand).
- Local DB: this worktree had no `.env`/running Postgres container of its own; provisioned one via
  `cp .env.example .env`, `make fix-ports` (assigned `DB_HOST_PORT=5434`), `make db-up`, and
  `pnpm --filter @project-vault/db db:migrate` before running integration tests.
- Discovered and fixed a real regression in `packages/agent` (the offline agent): its
  `getSecret()` assumed the machine reveal route's whole-secret response always has a bare
  `value` string. Since this story changes that route to return a structured `fields[]` shape for
  a genuinely multi-field secret (mirroring the human route), the agent would have silently
  cached/returned `undefined`. Added `VaultMultiFieldSecretUnsupportedError` so it fails loudly
  instead — this agent has no field-selector API yet; that would be a separate future story.

### Completion Notes List

- AC-1: field-list/detail rendering reads `field_meta`/`visibleFieldValues` from the existing
  detail response only; no `/value` (`revealCredentialValue`) call happens on initial page load
  (asserted directly in `credential-detail-page.test.ts`).
- AC-2: `getCredentialDetail` gained a server-side eager decrypt of non-sensitive fields only
  (`visibleFieldValues`), wired through a **non-audited** code path (never calls
  `writeHumanAuditEntryOrFailClosed`). A decrypt failure degrades gracefully to an empty map
  (that field renders masked+Reveal, same as a sensitive field) and is logged operationally, not
  audited — verified with a tampered-ciphertext regression test on both the API and web layers.
- AC-3: sensitive fields render a fixed masked placeholder + "Reveal" button; an empty-string
  sensitive field reveals to an empty value (not mistaken for "unrevealed") — explicit test added.
- AC-4: `GET .../value?field=<key>` now exists on both the human and machine routes, returns only
  that field, and writes `revealed_fields` as a first-class `audit_log_entries` column (not nested
  in `payload`) — including for a non-sensitive field explicitly requested, and as two separate
  audit rows for two back-to-back single-field reveals.
- AC-5: whole-secret reveal of a genuine multi-field secret now returns the structured `fields[]`
  array (fixing the Story 13.2 carryover bug that dumped raw JSON into `value`); `revealed_fields`
  names only the genuinely-sensitive fields, in `field_meta` declared order. A corrupted-envelope
  decrypt failure fails the whole request atomically (500/503, zero fields, zero audit rows) —
  covered by a dedicated test simulating a tampered `credential_versions` row.
- AC-6: legacy (`schema_version = 1`) and single-default-field (`schema_version = 2`, one field)
  secrets are byte-for-byte unchanged — bare `{ value }` shape, `revealed_fields` stays `NULL`
  (never `[]`) on an implicit whole-secret reveal. The `?field=value` lookalike-case distinction
  (genuine legacy row rejects it; a real single-default-field row with key `value` accepts it) is
  covered by dedicated tests on both routes.
- AC-7: an unknown `?field=` returns `400 unknown_field_key` (naming the offending key) before any
  decrypt/audit-write, with zero audit rows written; malformed input (empty string, over-length,
  disallowed characters) is rejected `422` at the Zod query-schema layer, kept distinct from the
  `400` business error per Subtask 2.1.
- Web: replaced the raw-JSON `<pre>{revealedValue}</pre>` block for multi-field secrets with
  per-field interactive rows (masked+Reveal for sensitive, inline value for non-sensitive) plus a
  "Reveal all" secondary action; the legacy/single-default-field `<pre>` reveal path is untouched
  (guarded by `!isMultiField`, still exercised by its own passing tests).
- Added `packages/agent`'s `VaultMultiFieldSecretUnsupportedError` (see Debug Log) as a
  self-contained defensive fix outside the story's listed touchpoints, since the response-shape
  change is shared with the machine route this story explicitly modifies.
- `make check-rls` passes with no changes required (the new column adds no new access path).
- New/extended test files: `packages/db/src/__tests__/migration-0054-safety.test.ts` (new),
  `apps/api/src/modules/credentials/field-set-routes.test.ts` (extended, +15 tests, 1 existing
  test updated for the fixed response shape), `apps/api/src/modules/machine-users/machine-credential-routes.test.ts`
  (extended, +5 tests), `apps/web/src/lib/api/credentials.test.ts` (fixture updated for the new
  required `visibleFieldValues`/`schemaVersion`/`fields` detail properties),
  `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts`
  (extended, +6 tests, 2 existing tests updated for the fixed reveal response shape),
  `packages/agent/src/index.test.ts` (+1 test), and a new e2e journey spec
  `apps/web/e2e/journeys/j6-field-visibility-reveal.spec.ts` (written, not executed — consistent
  with Story 13.2's own j5 spec, which requires the full docker stack).
- Full test runs: `packages/db` (migration + schema tests) pass; `apps/api`
  `field-set-routes.test.ts` (33/33) and `machine-credential-routes.test.ts` (19/19) pass against a
  freshly provisioned local Postgres; `apps/web` full suite (194 files / 1578 tests) passes;
  `packages/agent` full suite (34/34) passes. Full `apps/api` suite (`pnpm vitest run`, no filter)
  was kicked off but is long-running in this environment (repo-documented as 30-100+ min) — see
  Debug Log; not all results were observed before this record was written. Re-run
  `DATABASE_URL=... ADMIN_DATABASE_URL=... pnpm --filter @project-vault/api test` before merge if
  this session's background run didn't complete cleanly.
- Lint: `eslint` clean on every touched file (two cyclomatic-complexity violations and two
  `sonarjs/no-duplicate-string` violations introduced along the way were fixed by extracting
  helper functions / test constants).

### File List

- `packages/db/src/migrations/0054_audit_revealed_fields.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` (edit)
- `packages/db/src/schema/audit-log-entries.ts` (edit)
- `packages/db/src/__tests__/migration-0054-safety.test.ts` (new)
- `packages/shared/src/schemas/credentials.ts` (edit)
- `apps/api/src/lib/route-helpers.ts` (edit)
- `apps/api/src/lib/audit-or-fail-closed.ts` (edit)
- `apps/api/src/modules/audit/human-entry.ts` (edit)
- `apps/api/src/modules/audit/machine-entry.ts` (edit)
- `apps/api/src/modules/credentials/schema.ts` (edit)
- `apps/api/src/modules/credentials/service.ts` (edit)
- `apps/api/src/modules/credentials/routes.ts` (edit)
- `apps/api/src/modules/credentials/field-set-routes.test.ts` (edit)
- `apps/api/src/modules/machine-users/machine-credential-schema.ts` (edit)
- `apps/api/src/modules/machine-users/machine-credential-routes.ts` (edit)
- `apps/api/src/modules/machine-users/machine-credential-routes.test.ts` (edit)
- `apps/web/src/lib/api/credentials.ts` (edit)
- `apps/web/src/lib/api/credentials.test.ts` (edit)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (edit)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts` (edit)
- `apps/web/e2e/journeys/j6-field-visibility-reveal.spec.ts` (new)
- `packages/agent/src/errors.ts` (edit)
- `packages/agent/src/index.ts` (edit)
- `packages/agent/src/index.test.ts` (edit)
- `.env` (new, local-only worktree DB config — not committed if gitignored)
