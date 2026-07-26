# Story 2.10: Dependent System Location Links & Persistent Update Checkbox

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-26 — comprehensive developer guide for the credential_dependencies.link_url column and the persistent per-dependency "updated" checkbox that surfaces Story 5.6's rotation_checklist_items confirmation state outside the rotation modal. This story is a Product Surface Contract "both" story amending already-shipped Epic 2 (Story 2.4) and already-shipped Epic 5 (Story 5.6, once merged) code. -->

## ⚠️ BLOCKING PREREQUISITE — READ BEFORE STARTING WORK (UNBLOCKED 2026-07-26)

**Update 2026-07-26: PR #220 merged to `main` as commit `a6659c2`.** The prerequisite below is now satisfied — implementation may proceed. Re-verify against current `main` before branching anyway, per this section's own "do not trust this note blindly" instruction, since time may have passed since this update.


**This story cannot be implemented against the current `main` branch.** As of story creation (2026-07-26), `main` does NOT contain Story 5.6's code:

- No `staged` / `promoted` / `retired` values in `rotations.status` (still `in_progress`/`completed`/`abandoned`/`stale_recovery`/`break_glass_complete`).
- No `credential_versions.promoted_at` column.
- No `POST .../rotations/:rotationId/promote` / `retire` routes.
- `main`'s current-version selection is still the pre-5.6 model (highest `versionNumber` wins unconditionally — see Story 5.6 Dev Notes "Critical correction to the sprint-change-proposal's premise").

Story 5.6's code is **complete, tested, `make ci` green, and open as PR #220** (https://github.com/nestormata/project-vault/pull/220) but **not yet merged**. It lives today in the file at `_bmad-output/implementation-artifacts/5-6-staged-primary-secondary-rotation-state-machine.md` (Status: `done` in that story's own file/branch, but that branch has not landed on `main`).

**Required sequencing:**

1. **Do not branch a worktree for this story until PR #220 has merged to `main`.** A worktree for 2-10 branches off `origin/main` (see `EnterWorktree` convention used across this project) — branching before the merge produces a worktree with the OLD rotation model, and every AC below (which depends on `rotations.status = 'staged'` and the promote/retire routes existing) will be unimplementable or will silently regress to targeting the wrong model.
2. **Before starting implementation, re-verify** (do not trust this note blindly — it will go stale):
   - `git log origin/main -- packages/db/src/schema/rotations.ts` shows the `staged`/`promoted`/`retired` CHECK constraint widening.
   - `packages/db/src/migrations/meta/_journal.json` on `main` has a migration tagged `..._staged_rotation_state_machine` (expected `0050`, but **re-read the journal at implementation time** — do not hardcode; if another story's migration lands on `main` first, 5.6's number shifts and so does this story's own migration number, currently planned as the next free number after 5.6's, e.g. `0051_credential_dependency_link_url.sql` — illustrative only).
   - `apps/api/src/modules/rotation/service.ts` exports `promoteRotation`/`retireRotation`.
3. If PR #220 is still open when this story is picked up, **stop and escalate to Nestor** rather than either (a) implementing against the pre-5.6 model with a plan to "fix it later," or (b) implementing against 5.6's worktree branch directly (that branch is not `main` and will itself be rebased/merged, not built upon by unrelated stories).

**What this story specifically needs from Story 5.6** (so a reviewer can verify prerequisite-readiness precisely, not just "5.6 merged"):

| Story 5.6 element this story consumes | Where |
|---|---|
| `rotations.status` includes `'staged'` | `packages/db/src/schema/rotations.ts` |
| A credential has **at most one** active rotation at a time, and "active" includes `staged`/`promoted`/`stale_recovery` (the widened partial unique index `idx_rotations_one_active_per_credential`) | `packages/db/src/schema/rotations.ts` (AC-2.6 of 5.6) — this story's AC-3 "which rotation is `staged` on this credential" query relies on there being at most one such row |
| `rotation_checklist_items` rows exist per non-archived `credential_dependencies` row for the **currently `staged`** rotation (unchanged from Story 5.1 — Story 5.6 does not change checklist generation, only what "the current rotation" means) | `apps/api/src/modules/rotation/service.ts` — `initiateRotation()` |
| `POST .../rotations/:rotationId/checklist/:itemId/confirm` — the EXACT existing confirm action this story's persistent checkbox re-invokes (unchanged endpoint, unchanged request/response shape, unchanged audit event `AuditEvent.ROTATION_CHECKLIST_ITEM_CONFIRMED`) | `apps/api/src/modules/rotation/routes.ts` lines ~801-887 (pre-5.6 line numbers; re-locate at implementation time — 5.6 does not touch this route's logic, only what `rotations.status` values exist elsewhere) |
| `promoteRotation()` resets/generates a fresh, unconfirmed checklist per dependency on each new `staged` rotation — the mechanism this story's AC-5 "checkbox resets on new rotation" behavior depends on already existing, unmodified | Story 5.6 AC-2.2 / `initiateRotation()` (unchanged by 5.6 — new rotations, staged or not, have always generated a fresh checklist since Story 5.1) |

This story adds **zero** new confirmation state and **zero** new columns to `rotations`/`rotation_checklist_items`/`credential_versions` — it is purely (a) one new nullable column on `credential_dependencies`, and (b) a new **read** query + a new UI surface that calls the *existing* confirm/fail/retry checklist routes from a new location (the dependency list) instead of only from the rotation detail page.

---

## Story

As a user recording a dependent system,
I want to attach an optional URL to it and see (and check off) whether it has been updated to the currently `staged` rotation's new value directly from the credential's dependency list — not only inside the rotation detail page,
so that I always know which locations still need updating while I work through rotating a credential across every place it's configured, and I can jump straight to the location that needs the change.

*Covers: FR19/FR104 amendment (dependent-system link), FR20 (existing "mark checklist item confirmed" behavior, new surface only — no new FR).* [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md` §4.2, item "Epic 2 (done) — add follow-up story: Story 2.10"]

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — API gains `link_url` on the dependency create/update/list responses (AC-1–AC-4); web gains the link display + the persistent checkbox on the credential detail page's dependency list (AC-6). An API-only version of this story would leave the checkbox invisible outside the rotation modal, defeating the story's entire purpose (the sprint-change-proposal explicitly frames this as a *visibility* change, not a data change). |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI is in-scope in this same story (Task 4) |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Morgan-member (dependent-system owner, mid-rotation):** opens a credential's detail page while a rotation is `staged` on it → the dependency list (already showing system name/type/notes from Story 2.4) now shows, per active (non-archived) dependency: (a) its optional link as a clickable URL if set, and (b) an "Updated" checkbox reflecting that dependency's `rotation_checklist_items.status` for the currently-`staged` rotation. Morgan clicks the link to jump straight to the system, updates the credential there, comes back, and checks the box — this calls the same `POST .../checklist/:itemId/confirm` action the rotation detail page's checklist already uses (AC-6.2). Morgan never has to open the rotation modal at all to track their own progress. If no rotation is currently `staged` on the credential, every checkbox renders unchecked and disabled/greyed with a tooltip explaining why (AC-6.4) — there is nothing to confirm against.

**Riley-admin (rotation initiator):** sees the same dependency list with checkboxes while working the rotation from the credential detail page (not just the rotation detail page) — gives a second, more prominent surface for "how many of N dependent systems are done" without navigating away from the credential.

**Alex-viewer (read-only):** sees the links and the checkbox states (read-only — checking the box requires `member`+, same role gate the existing checklist confirm route already enforces; AC-6.5) but cannot toggle them, matching the existing checklist-confirm role gate (`minimumRole: 'member'`) applied by Story 5.1/5.2.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 5.6 merged to `main` via PR #220** | See blocking section above. Every AC-5/AC-6 below reads `rotations.status = 'staged'` and the checklist confirm route's item-status semantics as amended by 5.6 (checklist becomes advisory, but the item-level `confirmed`/`pending`/`failed` states and the confirm/fail/retry routes themselves are UNCHANGED by 5.6 — only what "the current rotation" means changes). |
| Story 2.4 (`credential_dependencies` table, `POST`/`GET`/`DELETE` dependency routes) merged and `done` | This story adds a column and a query to the **existing** table/routes; it does not recreate them. `packages/db/src/schema/credential-dependencies.ts` is amended, not replaced. |
| Story 5.1 (`rotation_checklist_items` table, checklist generation, confirm/fail/retry routes) merged and `done` | This story's persistent checkbox reads/writes this existing table via its existing routes — no new table, no new route logic for the confirm action itself. |
| Story 5.2 (checklist confirmation UI patterns on the rotation detail page) merged and `done` | The web component patterns (confirm button states, optimistic update, audit-backed mutation) are reused, not reinvented, on the new dependency-list surface. |
| Migration numbering **(re-verify against `meta/_journal.json`, do NOT hardcode)** | On `main` as of 2026-07-25 (pre-5.6-merge), the highest migration is `0049_credentials_current_version_id_backfill.sql`. Story 5.6 is expected to land as `0050_staged_rotation_state_machine.sql`. **This story's migration is therefore the next free number after 5.6's — illustratively `0051_credential_dependency_link_url.sql`, but re-read `packages/db/src/migrations/meta/_journal.json` immediately before generating and use whatever is actually free.** |

---

## Epic Cross-Story Context

| Story | Relationship to 2.10 |
|---|---|
| 2.4 | Created `credential_dependencies` (`systemName`, `systemType`, `notes`, soft-archive via `archivedAt`), the `POST`/`GET`/`DELETE` dependency routes, and the `hasDependencies` coverage flag. This story is a pure additive amendment: one new nullable `link_url` column, surfaced in the same create/list/response shapes. Do not touch `systemName`/`systemType`/`notes`/archive semantics — those are frozen by 2.4 and consumed unchanged by Epic 5. |
| 5.1 | Created `rotation_checklist_items` (`id`, `rotationId`, `dependencyId`, `systemName` snapshot, `status: 'pending'|'confirmed'|'failed'`, `confirmedBy`, `confirmedAt`) and the confirm/fail/retry routes this story's checkbox re-invokes verbatim. `dependencyId` is the FK this story's new query joins on to find "the checklist item for dependency D on the currently-staged rotation." |
| 5.2 | Web checklist UI patterns (confirm/fail/retry buttons, per-item state, banner copy) on the rotation detail page — reused, not duplicated, for the new dependency-list surface. |
| 5.6 (PR #220, not yet merged) | **Hard prerequisite — see blocking section.** Introduces `staged`/`promoted`/`retired` rotation statuses; this story's "find the currently-staged rotation for this credential" query (AC-5) is meaningless against the pre-5.6 model (which has no `staged` status — only `in_progress`). Also: 5.6 confirms (AC-8.6) that `target_fields`-scoped (multi-field, Story 13.x) rotations use the identical checklist/dependency model with zero field-aware special-casing — this story inherits that same "just works" property for multi-field credentials without extra code. |
| 4.1 | Per-project RBAC (not yet landed at v1 scope) — the checkbox's `member`+ write gate is org-role-derived today, same as every other Epic 2/5 mutation; no change needed here, documented for consistency. |
| 13.4 (blocked on 5.6, backlog) | Rewrites field-scoped rotation completion against 5.6's state machine. Not a dependency of this story (this story's checkbox works identically for field-scoped and whole-secret rotations per the 5.6 AC-8.6 confirmation above), but implemented in the same epoch — if 13.4 lands first, re-confirm this story's checklist query still returns exactly one row per dependency per rotation regardless of `target_fields`. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Prior wording / assumption | Canonical implementation for 2.10 | Rationale |
|---|---|---|
| Sprint-change-proposal implies "the updated checkbox is NOT new state" | Confirmed true and unchanged by this story — reuse `rotation_checklist_items.status`/`confirmedBy`/`confirmedAt` exactly as Story 5.1/5.2 shipped them. This story adds **zero** new confirmation-state columns. | Explicit sprint-change-proposal instruction (§4.2): "no new confirmation state." |
| Sprint-change-proposal's Story 2.10 stub says the checkbox reflects "whichever rotation is currently `staged`" | This phrase only makes sense post-5.6 (pre-5.6, there is no `staged` status, only `in_progress`, and "current" rotation there is unambiguous — see 5.6 Dev Notes "Critical correction"). This story's AC-5 query is written against the **post-5.6** model exclusively — do not add a pre-5.6 compatibility branch; this story cannot ship before 5.6 anyway (see blocking section). | 5.6 is a hard merge-order prerequisite, not a parallel-track concern. |
| `credential_dependencies` has no `project_id` column (Story 2.4 AC-5 invariant) | Unchanged. Every route this story touches still verifies the parent credential belongs to `:projectId` before reading/writing a dependency row — this story does not weaken that invariant by adding a new field. | Story 2.4's documented "Project-scope invariant for ALL dependency sub-routes." |
| Sprint-change-proposal's UX section (§4.4) describes "each location row gains its optional link (clickable) and an 'updated' checkbox" | Implemented literally — see AC-6. | Direct UX spec text, ux-design-specification.md not yet amended with this text (documented below as a Dev Notes doc-reconciliation item, same pattern as 5.6's Task 8). |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | `credential_dependencies` gains nullable `link_url text`. |
| Add/edit dependency | `POST …/dependencies` and a new `PATCH …/dependencies/:dependencyId` accept optional `linkUrl`, validated as a URL when present. |
| List dependencies | `GET …/dependencies` response items include `linkUrl` (nullable) — additive, existing fields unchanged. |
| Checklist-status join | `GET …/dependencies` (or a new `?includeChecklistStatus=true` variant / new endpoint — decide at implementation time per AC-5) also returns, per dependency, the confirmation status of the currently-`staged` rotation's checklist item for that dependency, if any. |
| Toggle checkbox | Checking the box calls the EXISTING `POST …/rotations/:rotationId/checklist/:itemId/confirm` route unchanged — no new mutation route for confirmation itself. |
| Web UI | Dependency list on the credential detail page shows the link (clickable, `rel="noopener noreferrer" target="_blank"`) and the checkbox; checkbox reflects live state; disabled/greyed with no staged rotation. |
| Security | RLS unchanged (no new table); cross-org/cross-project → 404; sealed vault → 503; `.strict()` bodies; `linkUrl` is non-secret metadata (never a credential value) — same audit-payload-inclusion rule as `systemName`/`notes`. |
| Tests | Add/list/edit `linkUrl` incl. validation; checklist-status join happy path + no-staged-rotation path + multiple dependencies + archived dependency exclusion; checkbox toggle end-to-end (reuses 5.1/5.2's existing confirm-route tests as the contract, adds dependency-list-surface web tests); cross-org isolation; sealed 503; RLS; concurrent confirm (already covered by 5.1/5.2 — this story does not need new concurrency tests for the confirm action itself, only for its own new read query). |

---

### AC-1: Database Schema — `credential_dependencies.link_url` (NEW COLUMN)

**Given** the existing `credential_dependencies` table (`packages/db/src/schema/credential-dependencies.ts`, Story 2.4),

**When** Story 2.10 ships,

**Then** add a nullable `link_url text` column:

```typescript
// packages/db/src/schema/credential-dependencies.ts — additive change
linkUrl: text('link_url'),
```

**And** add a CHECK constraint bounding length (mirrors the existing `notes` length-check pattern):

```typescript
linkUrlLenCheck: check(
  'credential_dependencies_link_url_len_check',
  sql`${t.linkUrl} IS NULL OR char_length(${t.linkUrl}) <= 2048`
),
```

**And** URL *shape* validation (is it actually a well-formed `http`/`https` URL) happens at the **Zod schema layer** (AC-3), not the DB CHECK — the DB constraint is a defense-in-depth length bound only, matching the existing precedent (`system_name`/`notes` length checks are DB-level; the richer `systemType` enum validity is DB-level via a small fixed set, but free-text shape validation like "is this a URL" has no existing DB-level precedent in this table and is not the right layer for it — Postgres has no built-in URL type).

**Example 1a (happy path):** A dependency for "billing-worker (prod)" gets `linkUrl: "https://github.com/org/billing-worker/blob/main/.github/workflows/deploy.yml"`.

**Example 1b (edge case — omitted):** A dependency created without `linkUrl` stores `NULL` — fully backward compatible with every dependency created before this story ships (existing rows get `NULL`, no backfill needed, no default value).

**Example 1c (edge case — length boundary):** A `linkUrl` of exactly 2048 chars is accepted; 2049 chars is rejected at the Zod layer (AC-3) with `422 validation_error` before it ever reaches the DB CHECK (the DB CHECK is a backstop, not the primary UX-facing validation path — same pattern as `notes`).

---

### AC-2: Migration — Schema Change (next free number after Story 5.6's, e.g. `0051_credential_dependency_link_url.sql`)

**Given** this table already has RLS enabled and an `updated_at` trigger from its Story 2.4 migration,

**When** Story 2.10 adds the column,

**Then** the migration is a simple additive `ALTER TABLE`:

```sql
ALTER TABLE credential_dependencies ADD COLUMN link_url text;
--> statement-breakpoint
ALTER TABLE credential_dependencies ADD CONSTRAINT credential_dependencies_link_url_len_check
  CHECK (link_url IS NULL OR char_length(link_url) <= 2048);
```

**And** no RLS change is needed (the existing `credential_dependencies_isolation` policy already covers all columns on the table — adding a column does not require a new policy). Run `pnpm --filter @project-vault/db check-rls` anyway to confirm (Story 2.4/5.6 convention: never assume, always run).

**And** this is a non-destructive, purely additive migration (no data loss, no `KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS` entry needed — contrast with Story 5.6's 0050, which needed one for its status-enum/index changes; this story's migration does not touch existing enum values, indexes, or NOT NULL constraints).

**And** confirm `drizzle-kit generate` actually emits the CHECK constraint (grep the generated SQL — same gotcha flagged by Story 2.2/2.4: drizzle-kit does not always emit `check()`).

---

### AC-3: `POST …/dependencies` and new `PATCH …/dependencies/:dependencyId` — Set `linkUrl` at Create or Edit

**Given** a credential exists in the caller's org+project and the caller has at least `member` role,

**When** they record or edit a dependent system's link,

**Then**:

1. `POST …/credentials/:credentialId/dependencies` (existing route, Story 2.4) accepts an additional optional `linkUrl` field in its `.strict()` body.
2. A new `PATCH …/credentials/:credentialId/dependencies/:dependencyId` route is added — Story 2.4 shipped no dependency-edit route (only add/archive), and `linkUrl` is the first field on this table that plausibly needs editing after creation (a location's URL can change without the dependency itself needing to be archived-and-recreated). Body: `{ linkUrl?: string | null }` — same three-state absent/value/null semantics as Story 2.4's credential-lifecycle PATCH (AC-6 there): absent → unchanged, value → set, `null` → clear.
3. `linkUrl` validation (both routes): optional; when present and non-null, must be a syntactically valid absolute URL with scheme `http` or `https` (reject `javascript:`, `data:`, `file:`, relative URLs, and bare strings — use `z.string().url()` plus an explicit protocol allowlist refinement, since `z.string().url()` alone accepts any scheme including `javascript:`). Max 2048 chars (AC-1). Invalid → `422 { code: "invalid_link_url", message: "linkUrl must be an http(s) URL" }`.

**Request (create with link):**
```http
POST /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/dependencies
Content-Type: application/json

{
  "systemName": "billing-worker (prod)",
  "systemType": "ci_pipeline",
  "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret.",
  "linkUrl": "https://github.com/org/billing-worker/settings/secrets/actions"
}
```

**Successful response (`201 Created`) — additive field:**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000500",
    "credentialId": "00000000-0000-4000-8000-000000000100",
    "systemName": "billing-worker (prod)",
    "systemType": "ci_pipeline",
    "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret.",
    "linkUrl": "https://github.com/org/billing-worker/settings/secrets/actions",
    "createdBy": "00000000-0000-4000-8000-000000000001",
    "archivedAt": null,
    "createdAt": "2026-07-26T16:00:00.000Z",
    "updatedAt": "2026-07-26T16:00:00.000Z"
  }
}
```

**Request (edit — set link on an existing dependency that had none):**
```http
PATCH /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/dependencies/00000000-0000-4000-8000-000000000500
Content-Type: application/json

{ "linkUrl": "https://console.aws.amazon.com/systems-manager/parameters/%2Fprod%2Fbilling%2Fapi-key" }
```

**Request (edit — clear link):**
```http
PATCH .../dependencies/00000000-0000-4000-8000-000000000500
Content-Type: application/json

{ "linkUrl": null }
```

**Successful response (`200 OK`) — PATCH, metadata only:**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000500",
    "linkUrl": "https://console.aws.amazon.com/systems-manager/parameters/%2Fprod%2Fbilling%2Fapi-key",
    "updatedAt": "2026-07-26T17:00:00.000Z"
  }
}
```

**And** a body with `linkUrl` absent (PATCH with no keys, or an empty `{}`) → `422 { code: "no_fields_to_update" }` (mirrors Story 2.4 AC-6's credential-lifecycle PATCH precedent — do not issue a no-op UPDATE). This route intentionally only supports `linkUrl` in v1 (editing `systemName`/`systemType`/`notes` is out of scope — document this; a future story can widen the PATCH if needed, do not silently add it here).

**Example 3a (happy path — invalid scheme rejected):** `{ "linkUrl": "javascript:alert(1)" }` → `422 { code: "invalid_link_url" }`. This is a defense-in-depth XSS-adjacent guard: even though the web UI must independently avoid rendering an unsafe `href` (AC-6), the API should never persist a non-http(s) scheme in the first place.

**Example 3b (edge case — internal/private-network URL is allowed):** `{ "linkUrl": "https://vault.internal.corp:8443/secrets/billing" }` (a private DNS name, not a public host) → accepted. This story does **not** implement SSRF-style host-allowlisting — `linkUrl` is never fetched server-side (it is display-only, rendered as a clickable `<a>` in the browser, AC-6), so there is no server-side request forgery surface to guard against. Document this explicitly so a future reviewer does not mistake "no SSRF guard" for an oversight.

**And** URL validation MUST use runtime parsing (`new URL(trimmedValue)` wrapped in try/catch, reading `.protocol`), never a regex or naive `.startsWith('http')` check — a regex/prefix check is bypassable by leading whitespace/control characters or protocol-relative tricks (`new URL()` throwing is the authoritative "is this a well-formed absolute URL" signal; the protocol allowlist check runs on the **parsed** `.protocol` value, `'http:'`/`'https:'`, not on the raw string). Trim the input before validating and before storing (a value that is only whitespace after trimming is treated as `null`/absent, not stored as an empty string).

**And** the parent credential must exist within the caller's org+project (same 404 pattern as every other dependency route — Story 2.4 precedent, `credential_not_found` for POST, `dependency_not_found` for PATCH on a missing/foreign dependency).

**Pre-mortem finding — do not silently store user-pasted secrets in `linkUrl`:** a plausible incident three months post-ship: a user, in a hurry, pastes a URL that itself embeds a credential (`https://user:s3cr3t@internal-db:5432/`, or a signed URL with an embedded access token/query-string secret) into the "location link" field, believing it is equivalent to `notes`. Because `linkUrl` is explicitly non-secret metadata (readable by every `viewer`+ user on the credential, included in the `credential.dependency_updated`/`credential.dependency_added` audit payload verbatim, and rendered as a clickable link in the UI), this would leak the embedded secret to a broader audience than intended and write it into the audit log in plaintext — a real, if user-caused, data-exposure incident that this story's schema/API cannot detect (a syntactically valid `https://` URL with embedded credentials is indistinguishable from a legitimate one). **Applied mitigation:** add explicit inline help text on the web add/edit form (AC-6, Task 5): *"This link is visible to everyone with view access to this credential and is stored in plaintext audit logs — do not include passwords, tokens, or signed URLs here."* This is a UX/documentation mitigation, not a technical block (no reliable way to detect "this URL contains a secret" server-side without false positives) — flagged explicitly as the accepted mitigation rather than left undocumented.

**Pre-mortem finding — do not let a future story turn `linkUrl` into an SSRF vector:** this story's Example 3b explicitly documents that `linkUrl` is never fetched server-side. Flagged here as a forward-looking guardrail: if a future story adds link-preview thumbnails, favicon fetching, or URL-reachability checks against `linkUrl`, that story MUST run its own SSRF threat-model pass (private-IP/localhost/link-local address blocking, redirect-following limits, timeout/size caps) — this story's "no SSRF guard" design decision is valid only as long as the field stays display-only. Note added to Dev Notes ADR section (see Round 5) so this isn't rediscovered as a surprise later.

**Example 3c (failure mode — PATCH on an already-archived dependency):** A dependency was archived last week (Story 2.4 `DELETE`). `PATCH …/dependencies/:archivedId { "linkUrl": "..." }` → `404 { code: "dependency_not_found" }`, the SAME code Story 2.4's archive route already uses for "not found," even though the row technically exists (archived, not deleted). Archived rows are frozen historical records (Story 2.4 AC-5: "there is no 'unarchive' endpoint... archiving preserves the row for rotation-history integrity") — silently allowing a `linkUrl` edit on an archived row would mutate a record that downstream rotation-history views assume is immutable once archived. The mutation `WHERE` clause must include `AND archived_at IS NULL` (mirroring the archive route's own `isNull(archivedAt)` idempotency-guard pattern in reverse), and a 0-row UPDATE result must be resolved with a follow-up existence check exactly like Story 2.4 AC-5's own "distinguish already-archived from truly-absent" logic — if the row exists but is archived, still return `404 dependency_not_found` (not a distinct error code; editing an archived dependency's link and "the dependency doesn't exist" are both simply "not editable," and no caller-visible distinction is needed). Add this as a required test case — it is not covered by AC-3's existing examples and is a genuine gap the initial draft left undefined.

**Security config (PATCH, new route):**
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PATCH …/credentials/:credentialId/dependencies/:dependencyId' },
  writeAuditEvent: { eventType: 'credential.dependency_updated', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```
- New audit event constant `credential.dependency_updated` (`packages/shared/src/constants/audit-events.ts`, alongside the existing `credential.dependency_added`/`credential.dependency_archived`). Payload: `{ dependencyId, linkUrl, previousLinkUrl }` (the new value, or `null` if cleared, PLUS the pre-change value, or `null` if it was previously unset) — non-secret metadata, same classification rule as `dependency_added`'s payload. **Security Audit Persona finding (Auditor):** unlike `dependency_added` (which has no "previous" state to record), an edit/clear action on an existing field is exactly the kind of event a forensic investigator needs a before/after diff for — e.g. reconstructing "was this dependency ever pointed at a different, possibly-malicious URL before someone changed it back" during an incident review. Recording only the new value (as Story 2.4's lifecycle PATCH audit payload does for `expiresAt`/`rotationSchedule`) is the existing precedent but is insufficient here specifically because a link's *history* (not just its current value) is the security-relevant fact for a URL field in a way it typically isn't for a date/cron field — read the row's current `linkUrl` inside the same transaction before applying the UPDATE and include it as `previousLinkUrl`.

---

### AC-4: `GET …/dependencies` — `linkUrl` in List Response (Additive)

**Given** the existing list route (Story 2.4 AC-4),

**When** Story 2.10 ships,

**Then** every item in `GET …/credentials/:credentialId/dependencies` includes `linkUrl: string | null` — purely additive, all Story 2.4 fields/filters/ordering/pagination-exemption unchanged.

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000500",
        "credentialId": "00000000-0000-4000-8000-000000000100",
        "systemName": "billing-worker (prod)",
        "systemType": "ci_pipeline",
        "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret.",
        "linkUrl": "https://github.com/org/billing-worker/settings/secrets/actions",
        "createdBy": "00000000-0000-4000-8000-000000000001",
        "archivedAt": null,
        "createdAt": "2026-07-26T16:00:00.000Z",
        "updatedAt": "2026-07-26T16:00:00.000Z"
      }
    ],
    "hasDependencies": true,
    "hasStagedRotation": false
  }
}
```

**And** `hasStagedRotation` reflects whether the credential currently has a rotation with `status = 'staged'` — computed once per request (the same lookup AC-5's checklist-status join already performs; AC-4 and AC-5 share one query, this is not two separate DB round-trips), independent of whether any individual dependency has a matching checklist item. See AC-5's "Challenge from Critical Perspective" note for why this field exists as an explicit server-computed value rather than a client-side inference.

**And** extend `CredentialDependencySchema` (or its Story 2.4 equivalent) in `packages/shared/src/schemas/credentials.ts` with `linkUrl: z.string().url().nullable()` — additive. Update the Story 2.4 list-shape assertion tests to include the new field (they must remain green).

---

### AC-5: Checklist-Status Join — Per-Dependency Confirmation State for the Currently-`staged` Rotation

**Given** Story 5.6 (merged prerequisite) makes `staged` the status of an in-progress-but-not-yet-promoted rotation, and Story 5.1's `rotation_checklist_items` table has one row per non-archived dependency per rotation (`dependencyId` FK, `status: 'pending'|'confirmed'|'failed'`),

**When** Story 2.10 ships,

**Then** `GET …/credentials/:credentialId/dependencies` (AC-4's route, extended — no new endpoint needed, this is the same list call) additionally returns, per item, the confirmation status against **the credential's currently-`staged` rotation, if one exists**:

```typescript
// Extended list-item shape (additive):
{
  // ...all AC-4 fields...
  checklistStatus: {
    rotationId: string
    itemId: string
    status: 'pending' | 'confirmed' | 'failed'
    confirmedBy: string | null
    confirmedAt: string | null   // ISO datetime, null if not confirmed
  } | null   // null when: no staged rotation on this credential, OR this dependency has no checklist item (e.g. dependency was added AFTER the current rotation was staged — see Example 5c)
}
// Top-level, sibling to `hasDependencies` (AC-4):
{
  data: {
    items: [...],
    hasDependencies: boolean,
    hasStagedRotation: boolean   // NEW — see "Challenge from Critical Perspective" note below
  }
}
```

**Challenge from Critical Perspective finding — resolved, not left open:** the initial draft of this AC proposed inferring "no staged rotation at all" vs. "dependency added after staging began" purely on the client, by comparing whether *any* other dependency in the same response had a non-null `checklistStatus`. That heuristic is fragile and silently wrong in a real, non-exotic case: a credential with a `staged` rotation where **every** active dependency was added after staging began (e.g. the rotation was staged before any dependency existed, or all pre-existing dependencies were archived and re-added) — in that case every `checklistStatus` is `null` and the client-side heuristic incorrectly concludes "no staged rotation," showing the wrong disabled-tooltip copy ("No rotation in progress" instead of "Added after this rotation started"). **Fix applied:** the server computes and returns an explicit top-level `hasStagedRotation: boolean` (AC-4's response shape, sibling to `hasDependencies`) — the web UI (AC-6) uses this authoritative flag directly instead of inferring it, eliminating the ambiguity entirely. This resolves what was previously flagged as Open Question #2 in Dev Notes — it is no longer open.

**Query approach:**
```typescript
// 1. Find the credential's currently-staged rotation (at most one, per the widened
//    idx_rotations_one_active_per_credential unique index — Story 5.6 AC-2.6).
const [stagedRotation] = await tx
  .select({ id: rotations.id })
  .from(rotations)
  .where(and(eq(rotations.credentialId, params.credentialId), eq(rotations.status, 'staged')))
  .limit(1)

// 2. If found, left-join checklist items for this rotation onto the dependency list;
//    if not found, checklistStatus is null for every item (no extra query needed).
```

**Example 5a (happy path — rotation staged, mixed confirmation states):** Credential C has 3 active dependencies (Alpha, Beta, Gamma) and one `staged` rotation R with 3 checklist items: Alpha `confirmed`, Beta `pending`, Gamma `failed`. `GET …/dependencies` returns all 3 dependencies, each with its matching `checklistStatus` populated from R's items.

**Example 5b (edge case — no staged rotation):** Credential C has never been rotated, or its last rotation was `promoted`+`retired` with nothing currently `staged`. `GET …/dependencies` returns all active dependencies with `checklistStatus: null` on every item. The web UI (AC-6.4) renders every checkbox disabled/greyed in this case — never a stale/leftover checked state from a previous, now-non-staged rotation.

**Example 5c (edge case — dependency added mid-rotation, after the rotation was already staged):** Rotation R is staged on credential C (checklist generated at initiation, Story 5.1, for the 2 dependencies that existed then). A new dependency Delta is added to C *while R is still staged* (Story 2.4 does not coordinate dependency-add with in-flight rotations — this is explicitly documented as intentional in Story 2.4 AC-5's "not coordinated" note). Delta has no `rotation_checklist_items` row for R (the checklist was snapshotted at initiation, not live-generated). `GET …/dependencies` returns Delta with `checklistStatus: null` — the web UI shows Delta's checkbox disabled/greyed with a distinct tooltip from the "no staged rotation at all" case (AC-6.4): "Added after this rotation started — not tracked by the current checklist." Do NOT retroactively insert a checklist item for Delta (that is Story 5.1's snapshot-at-initiation contract, unchanged and out of scope here) and do NOT silently show Delta as if it had a `pending` state (that would misrepresent "no item exists" as "item exists and is unconfirmed," which is a meaningfully different fact for an operator deciding whether to follow up on Delta).

**Example 5d (edge case — archived dependency):** `GET …/dependencies` (default, no `includeArchived`) excludes archived dependencies exactly as Story 2.4 always has — this story does not change that filter, so an archived dependency's `checklistStatus` is simply absent from the default response (not present with a null value — the whole item is absent, unchanged Story 2.4 behavior). With `?includeArchived=true`, an archived dependency that DOES have a historical checklist item from a past (now-terminal) rotation shows `checklistStatus: null` (only the *currently-staged* rotation's items are joined — historical items from `promoted`/`retired`/`abandoned` rotations are never surfaced via this field; that is what rotation history views are for, out of scope here).

**Example 5e (edge case — rotation status just transitioned from `staged` to `promoted` mid-poll, race with AC-6's frontend refresh):** The web UI is a naive fetch-based client (no live SSE subscription for this specific field, though the codebase has SSE infrastructure elsewhere for other rotation events — decide at implementation time whether to wire this list into the existing SSE channel or leave it fetch-on-mount/fetch-on-focus for v1; document the choice). If the user promotes a rotation via the rotation detail page in one tab while this dependency list is open (stale) in another, the stale tab's checkboxes may show confirmation state for a rotation that is no longer `staged`. This is an accepted, bounded staleness window (same class of staleness every non-SSE list view in this codebase already has, e.g. the credential list's `hasDependencies` flag) — not a correctness bug, since the next fetch (page reload, navigation back, or an explicit refresh action) self-corrects. Do not build new real-time infrastructure for this story; note it as a documented limitation.

**And** `checklistStatus` is **never** included when the caller lacks at least `viewer` role on the dependency list itself (same gate as AC-4 — no new permission surface, this is additive data on an existing read).

**Example 5f (failure mode — dependency archived between list-fetch and checkbox-click):** The web UI fetches the dependency list (Beta has `checklistStatus: { itemId: X, status: 'pending' }`), then — before Morgan clicks the checkbox — a different admin archives Beta (Story 2.4 `DELETE`, unrelated to this story). Morgan clicks the (now-stale) checkbox anyway; the confirm call (`POST .../checklist/:itemId/confirm`) is unaffected by the dependency's archive state (`rotation_checklist_items` rows are immutable snapshots per Story 2.4 AC-5's "no corruption, no dangling FK either way" guarantee — the checklist item still exists and is still confirmable even though its source dependency is now archived). The confirm succeeds `200`. This is intentional and requires no fix: archiving a dependency mid-rotation does not retroactively invalidate work already tracked against it (Story 2.4 explicitly documents archive as "not coordinated" with in-flight rotations). Document this as expected behavior, not a bug, and add a test confirming a checklist item for an archived dependency remains confirmable.

---

### AC-6: Web UI — Link Display + Persistent Checkbox on the Credential Detail Page's Dependency List

**Given** the existing dependency list rendering in `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (Story 2.4/2.9 — currently renders `systemName (systemType)` + an Archive button per row, no link, no checklist state),

**When** Story 2.10 ships,

**Then** each dependency row gains:

1. **Link display:** if `linkUrl` is set, render it as a clickable `<a href={dependency.linkUrl} target="_blank" rel="noopener noreferrer">` next to the system name — truncated/ellipsized if long, with the full URL in a `title` attribute. If `linkUrl` is null, render nothing extra (no empty placeholder text — this is not a coverage-gap flag like `hasDependencies`, an unset link is simply unset). **Security Audit Persona finding (Hacker/Defender):** a member with `member`+ role could set a dependency's link to a phishing/lookalike domain, which every `viewer`+ user on the credential would then see rendered as a trusted-looking clickable link inside the app. `rel="noopener noreferrer"` mitigates window.opener/referrer-leak tricks but does nothing about the destination content itself — this is an accepted residual risk inherent to any user-generated-link feature (same trust boundary already accepted for `notes`' free text, which could equally contain a phishing URL as plain text today) and is not remediated further in this story; do not add URL-reputation checking or an allowlist, which is out of scope and would be its own dedicated security feature. Documented here so it is a known, accepted trade-off rather than a silently-missed finding.
2. **Checkbox:** an "Updated" checkbox reflecting `dependency.checklistStatus?.status === 'confirmed'`. Checking it (when unchecked and `checklistStatus` is non-null with `status !== 'confirmed'`) calls the EXISTING `POST …/rotations/:rotationId/checklist/:itemId/confirm` route (`apps/web/src/lib/api/rotations.ts`'s existing `confirmChecklistItem` function — reuse it verbatim, do not write a new API client function for this story's confirm action; only the *caller* is new, not the callee) using `checklistStatus.rotationId`/`checklistStatus.itemId` from AC-5's response. On success, optimistically update the row's local `checklistStatus.status` to `'confirmed'` (mirroring the existing optimistic-update pattern already used by `onArchiveDependency`/`onAddDependency` in this same file).
3. **Un-checking is NOT supported from this surface** — the checkbox only transitions `pending`/`failed` → `confirmed` (calling `confirm`), matching what the rotation detail page's checklist UI already exposes as a one-way action per Story 5.2 (there is no `unconfirm` route in the API — only `confirm`/`fail`/`retry`). If `checklistStatus.status === 'failed'`, render the checkbox as checked-but-styled-differently (e.g. a warning variant) with a link/button to the rotation detail page to use `fail`/`retry` — do not attempt to expose `fail`/`retry` as inline actions on the dependency list in this story (scope boundary: this story's checkbox is confirm-only; the fuller failed/retry workflow stays on the rotation detail page, Story 5.2's existing surface).
4. **Disabled/greyed states** (driven by the authoritative `hasStagedRotation` top-level flag from AC-4/AC-5, never inferred client-side):
   - `hasStagedRotation === false` → checkbox disabled, greyed, tooltip: "No rotation in progress — nothing to confirm yet." (`checklistStatus` is `null` for every item in this case, consistent with the flag.)
   - `hasStagedRotation === true` but this item's `checklistStatus === null` (Example 5c — dependency added after the current staged rotation began) → checkbox disabled, greyed, tooltip: "Added after this rotation started — not tracked by the current checklist."
5. **Role gate:** checkbox is read-only (rendered but `disabled`, no onclick handler wired) for `viewer`-role callers — reuse whatever role-check pattern the existing `onArchiveDependency`/`onAddDependency` handlers already use in this file (they are `member`+ gated; mirror exactly, do not invent a new client-side role check).
6. **Accessibility:** checkbox has an associated `<label>` (`for`/`id` pair, matching this file's existing form-control convention e.g. `dependency-system-name`'s `<label for="dependency-system-name">`) and the disabled state is communicated via `aria-disabled` + the tooltip text, not color alone.

**Example 6a (happy path):** Rotation staged, 3 dependencies, Beta's checkbox unchecked. Morgan clicks it → `POST .../checklist/<itemId>/confirm` fires → `200` → checkbox flips to checked, `confirmedBy`/`confirmedAt` populate in the local state (not necessarily rendered inline, but available if a "confirmed by X on Y" affordance is added — optional polish, not a required AC).

**Example 6b (edge case — already confirmed, double-click / concurrent confirm from the rotation detail page):** Beta's checklist item is confirmed by a different admin from the rotation detail page in another tab. Morgan's dependency-list tab (stale) still shows it unchecked and clicks it → `POST .../confirm` returns the EXISTING `409 { code: "already_confirmed", confirmedBy, confirmedAt }` shape (Story 5.1/5.2, unchanged by this story) → the UI must handle this gracefully: treat a `409 already_confirmed` response as a *success* from the user's perspective (the box ends up checked either way — sync local state from the 409's `confirmedBy`/`confirmedAt` payload) rather than surfacing an error toast for what is, from Morgan's point of view, not really a failure. This is the same reconciliation pattern the rotation detail page's own checklist UI must already handle (Story 5.2) — reuse it, do not invent a new one.

**Example 6c (edge case — sealed vault):** Vault sealed mid-session → `GET …/dependencies` (AC-5's extended response) returns `503 { status: "sealed" }` exactly as every other credential-scoped metadata route does today (Story 1.5 convention, unchanged) — the dependency list (including checkboxes) is unavailable, not silently showing stale/empty state; the existing page-level sealed-vault handling (if any exists for this page — confirm at implementation time) covers this.

---

## Product Surface Contract — Test Scenarios (AGENTS.md coverage checklist)

- **RLS/tenant isolation:** `linkUrl` lives on an already-org-scoped, RLS-protected table (no new table, no new RLS gap) — add a positive write-isolation test (cross-org `PATCH linkUrl` on a foreign dependency → `404`, not visible via RLS) mirroring Story 2.4 AC-12's precedent test structure.
- **Audit behavior:** new `credential.dependency_updated` event (AC-3) — test payload shape (`{ dependencyId, linkUrl }`), test audit-write-failure rollback (mirrors Story 2.4's `dependency_added` failure-rollback test — same pattern, new event name).
- **Auth/session lifecycle:** PATCH route uses the existing `member`+ gate (Story 2.4 precedent, unchanged); checklist-status join (AC-5) uses the existing `viewer`+ gate on the list route (unchanged); confirm action reuses the existing `member`+ gate on the confirm route (Story 5.1/5.2, unchanged) — no new auth surface anywhere in this story, only new data flowing through existing gates. Test that a `viewer` role gets `403` attempting the new PATCH route.
- **Concurrent access:** covered by Example 6b (stale-tab double-confirm reconciliation) — this is a UI-level concurrency concern; the underlying route-level concurrency (two simultaneous confirms) is already covered by Story 5.1/5.2's existing tests and is unchanged by this story, so no new backend concurrency test is required, only the frontend reconciliation behavior.
- **Rate limits:** new PATCH route gets the same `60/min` tier as the existing POST dependency route (AC-3) — mirror, don't invent.
- **Migration compatibility:** AC-2's migration is purely additive (nullable column + CHECK) — add the standard "migration is idempotent / safe on empty and populated tables" smoke test, no backfill-correctness test needed (no data migration happens, unlike Story 5.6's 0050).
- **Operational logging:** the new PATCH route uses the existing `SecureRoute` default audit writer + the existing `operationalLog` helpers if the route needs any additional structured logging beyond the audit event — mirror the POST dependency route's logging footprint exactly (it currently has none beyond the audit write, per Story 2.4 AC-3 — do not add logging the sibling route doesn't have, for consistency).

---

## Tasks / Subtasks

- [ ] **Task 0 (BLOCKING): Confirm Story 5.6 has merged to `main`** (see prerequisite section) before creating a worktree or writing any code for this story.
- [ ] **Task 1: Schema & migration (AC-1, AC-2)**
  - [ ] Add `credential_dependencies.link_url text` (nullable) + length CHECK
  - [ ] Re-verify next free migration number against `meta/_journal.json` (post-5.6-merge state)
  - [ ] Write migration, confirm CHECK constraint is actually emitted by `drizzle-kit generate`
  - [ ] `pnpm --filter @project-vault/db check-rls` (expect clean pass, no new gap)
- [ ] **Task 2: `linkUrl` on create/list (AC-3 partial, AC-4)**
  - [ ] Extend `POST …/dependencies` body schema + handler with optional `linkUrl` (URL + protocol-allowlist validation)
  - [ ] Extend `CredentialDependencySchema` (`packages/shared/src/schemas/credentials.ts`) with `linkUrl`
  - [ ] Update Story 2.4's existing list/create tests to assert the new field is present and additive (no regression)
- [ ] **Task 3: New `PATCH …/dependencies/:dependencyId` route (AC-3)**
  - [ ] Three-state absent/value/null body handling (mirror Story 2.4's credential-lifecycle PATCH pattern)
  - [ ] New audit event `credential.dependency_updated` (`packages/shared/src/constants/audit-events.ts`)
  - [ ] Route classification in `ROUTE_ACTION_CLASSIFICATIONS` / `route-exemptions.ts` (route-audit.test.ts gate)
  - [ ] Tests: set/clear/no-op-rejected, invalid URL/scheme, cross-org/cross-project 404, sealed 503, audit payload + failure rollback, PATCH-on-archived-dependency → 404 (Example 3c)
- [ ] **Task 4: Checklist-status join (AC-5)**
  - [ ] Extend the list-dependencies query with the staged-rotation lookup + left-join onto `rotation_checklist_items`
  - [ ] Extend `ListCredentialDependenciesResponse`/shared schema with per-item `checklistStatus` AND top-level `hasStagedRotation`
  - [ ] Tests: happy path (mixed states), no-staged-rotation, dependency-added-after-staging, archived-dependency exclusion, confirm-succeeds-after-source-dependency-archived (all 6 examples in AC-5)
- [ ] **Task 5: Web UI (AC-6)**
  - [ ] Link display on each dependency row (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`)
  - [ ] Checkbox wired to the existing `confirmChecklistItem` API client function (`apps/web/src/lib/api/rotations.ts`) — no new client function for the confirm action
  - [ ] Optimistic update + `409 already_confirmed` reconciliation (Example 6b)
  - [ ] Disabled/greyed states + tooltips (no-staged-rotation vs. added-after-staging)
  - [ ] Role-gated (read-only for `viewer`)
  - [ ] Add `linkUrl` field to the add-dependency form (currently has systemName/systemType/notes inputs — extend with a `linkUrl` input, same `.strict()`-matching client-side validation)
  - [ ] Add inline help text to the `linkUrl` input (add + edit forms) warning against embedding credentials/tokens in the link (Pre-mortem finding, see Dev Notes)
- [ ] **Task 6: Documentation reconciliation**
  - [ ] `prd.md` FR19/FR104 — minor amendment noting the optional link field (per sprint-change-proposal §2.2)
  - [ ] `ux-design-specification.md` — add the dependency-list link+checkbox section from sprint-change-proposal §4.4 (not yet applied to that document per sprint-status.yaml's 2026-07-24 note)
  - [ ] `epics.md` — Epic 2 gains the Story 2.10 entry (sprint-change-proposal §4.2 has the stub; reconcile against this story file's corrected/expanded ACs, same pattern Story 5.6 used for its own epics.md entry)

---

## Dev Notes

### Why this story has no state-machine risk (contrast with 5.6)

Story 5.6 was the highest-risk story in this domain (inverted current-version selection, migration of in-flight rotations, new atomic transactions). This story is deliberately much lower risk: it adds one nullable column and one new read-query join, reusing every existing mutation route (`confirm`) unchanged. The primary risk here is **sequencing** (starting before 5.6 merges) and **staleness/UX edge cases** (Examples 5c, 5e, 6b) — not data-model or concurrency risk. Do not over-engineer this story with new locking/transaction machinery; none is needed.

### Architecture Decision Records (this story)

Following the ADR-numbering convention established by Stories 2.1–2.4 and 5.1–5.6 (this story is `2.10`, so ADRs are prefixed `ADR-2.10-`):

- **ADR-2.10-01 (reuse the existing checklist-confirm route unchanged; no new confirmation endpoint):** Considered and rejected building a dedicated `POST …/dependencies/:dependencyId/confirm-update` route scoped to the credentials module (which would have been a more "natural" module boundary for a dependency-list-triggered action). Rejected because it would duplicate `rotation_checklist_items`' status-transition logic, lock/CAS handling, and audit-event vocabulary (`ROTATION_CHECKLIST_ITEM_CONFIRMED`) across two routes for the same underlying state — a direct violation of the sprint-change-proposal's explicit "no new confirmation state" instruction, extended here to also mean "no new confirmation *route*." The web client calls the existing rotation-module route directly from the new dependency-list surface instead (AC-6.2).
- **ADR-2.10-02 (explicit server-computed `hasStagedRotation` flag over client-side inference):** See AC-5's "Challenge from Critical Perspective" note (Round 4) — the initial design inferred this from response-item presence/absence; replaced with an explicit boolean because the inference was demonstrably wrong for the "every active dependency added after staging" edge case. General principle recorded for future stories in this domain: prefer an explicit server-computed boolean over a client-side inference whenever the inference's correctness depends on the *emptiness* of a collection (an empty or all-null collection is exactly where presence/absence heuristics break down silently).
- **ADR-2.10-03 (runtime `new URL()` parsing over regex for `linkUrl` validation):** See AC-3's "Pre-mortem finding" (Round 2) — a regex/prefix-based scheme check is bypassable by leading whitespace or non-standard encoding; `new URL()` (throwing on malformed input, then checking the parsed `.protocol`) is the correct primitive and is already available in both the Node.js API runtime and the browser client, so no new dependency is needed.
- **ADR-2.10-04 (`PATCH …/dependencies/:dependencyId` is narrowly scoped to `linkUrl` only, not a general dependency-edit route):** A deliberate, minimal scope decision (AC-3.2/3.4) — `systemName`/`systemType`/`notes` remain immutable-after-create (archive-and-recreate is still the only path to change them), consistent with Story 2.4's original design where only `archivedAt`/`archivedBy` were ever mutable post-create. If a future story needs full dependency editing, it should widen this same route (not add a second one) — see Dev Notes Open Question #1, which already flagged this and is reinforced here as a formal ADR so the constraint is discoverable without reading the Open Questions prose.
- **ADR-2.10-05 (`linkUrl` is never fetched server-side; explicitly out of scope for SSRF hardening):** See AC-3 Example 3b and the Round 2 pre-mortem "SSRF vector" note — recorded formally here so a future story that adds server-side URL fetching (previews, favicons, reachability checks) is forced to re-evaluate this decision rather than silently assuming the existing lack of SSRF guards means none is needed for the new use case.

### Open Questions / judgment calls for Nestor to confirm

1. **New `PATCH …/dependencies/:dependencyId` route vs. folding `linkUrl` edit into a hypothetical future "edit dependency" route.** This story adds a narrowly-scoped PATCH that only accepts `linkUrl` (AC-3.2/3.4 note "editing systemName/systemType/notes is out of scope"). If a future story wants full dependency editing, it should widen this same route rather than adding a second one — flagged here so that story doesn't accidentally create route-shape drift.
2. ~~AC-5's "added after staging" detection heuristic~~ **RESOLVED during advanced elicitation (Round 4, Challenge from Critical Perspective):** the client-side inference approach was replaced with an explicit server-computed `hasStagedRotation: boolean` top-level flag (AC-4/AC-5) — no longer an open question, no implementation-time judgment call needed here.
3. (Still open) **SSE live-update for the checklist-status field (Example 5e).** This story deliberately defers wiring the dependency list into the existing SSE rotation-event channel (if any) to avoid scope creep, accepting a bounded-staleness window instead. If Nestor considers this a hard requirement rather than an acceptable v1 gap, that should be said explicitly — it would add non-trivial scope (subscribing this page to rotation-status SSE events, which today only the rotation detail page consumes).

### Project Structure Notes

- No new module directory — `credential-dependencies.ts` (schema), `apps/api/src/modules/credentials/` (routes/service), and the existing credential detail page (`apps/web/.../[credentialId]/+page.svelte`) are all amended in place, matching every prior Epic 2/5 story's "additive within existing module boundaries" convention.
- The checklist-status join (AC-5) reads `rotations`/`rotation_checklist_items` from the `credentials` module's list-dependencies query — a cross-module read (credentials module reading rotation-module tables). This mirrors an existing precedent: Story 2.3's `status`/`expiresWithin` filters and Story 2.4's `hasDependencies` `EXISTS` subquery already read/compute derived state inline in the credentials list query; this story extends that same pattern to rotation state. Do not introduce a new cross-module service-call abstraction for this — a direct Drizzle query against the already-imported `rotations`/`rotationChecklistItems` schema exports is consistent with how this codebase already does read-side cross-module joins (contrast with mutations, which always go through the owning module's service function — AC-3's PATCH stays entirely within the credentials module since it only touches `credential_dependencies`, and the checkbox's confirm action stays entirely within the rotation module's existing route/service, called directly by the web client, not proxied through the credentials module).

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md] §2.2 (Epic Impact — Epic 2), §4.2 (Story 2.10 stub), §4.4 (UX section) — original requirement text
- [Source: _bmad-output/implementation-artifacts/5-6-staged-primary-secondary-rotation-state-machine.md] — hard prerequisite; read in full before starting (Dev Notes "Critical correction," AC-1/AC-2/AC-6/AC-8 for the `staged` status and checklist-remains-workable-between-promote-and-retire semantics this story's join query relies on
- [Source: _bmad-output/implementation-artifacts/2-4-dependent-system-recording-and-expiry-rotation-schedules.md] — `credential_dependencies` schema/routes this story amends (AC-1 through AC-5 there)
- [Source: _bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md] — `rotation_checklist_items` schema, checklist generation-at-initiation contract (Example 5c depends on this)
- [Source: _bmad-output/implementation-artifacts/5-2-rotation-checklist-confirmation-and-completion.md] — confirm/fail/retry routes and their existing web UI patterns, reused verbatim by AC-6
- [Source: _bmad-output/planning-artifacts/prd.md#FR19] [#FR20] [#FR104] — current pre-amendment text
- [Source: packages/db/src/schema/credential-dependencies.ts] — current schema, verified 2026-07-26 (pre-this-story)
- [Source: apps/api/src/modules/rotation/routes.ts] lines ~801-887 — existing confirm-checklist-item route, reused unchanged
- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte] — existing dependency-list rendering (lines ~99-153 handlers, ~610-680 markup), amended by AC-6
- [Source: apps/web/src/lib/api/credentials.ts] — existing `listCredentialDependencies`/`addCredentialDependency`/`archiveCredentialDependency` client functions, extended (not replaced) by this story
- [Source: apps/web/src/lib/api/rotations.ts] — existing `confirmChecklistItem` client function, reused unchanged by AC-6
- [Source: packages/db/src/migrations/meta/_journal.json] — confirms next migration number 0050 as of 2026-07-25 for Story 5.6 (this story's own number is 5.6's + 1 — re-verify at implementation time, post-merge)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (bmad-create-story)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created, explicitly written to NOT be implementable until Story 5.6 (PR #220) merges to `main`, per direct instruction. Story is intentionally low-risk relative to 5.6: one nullable column, one new narrowly-scoped PATCH route, one read-query join reusing an entirely unmodified mutation route (checklist confirm) from a new UI surface.
- 5-round advanced elicitation applied and integrated directly into the ACs/Dev Notes (Failure Mode Analysis, Pre-mortem Analysis, Security Audit Personas, Challenge from Critical Perspective, Architecture Decision Records) — see Change Log below for a per-round summary.

### File List

(To be populated by `dev-story` at implementation time — not created by this story-creation pass.)

## Change Log

- 2026-07-26: Story created via `bmad-create-story`, written against Story 5.6's story file (pre-merge, PR #220 open) rather than against `main`'s current (pre-5.6) rotation model, per explicit instruction — every AC that depends on `staged` rotation status or the promote/retire state machine is written for the POST-5.6-merge world, with a blocking prerequisite section at the top of this file making that non-negotiable for whoever picks this story up next.
- 2026-07-26: 5-round advanced elicitation applied and integrated directly into the ACs/Dev Notes:
  - **Round 1 (Failure Mode Analysis):** found and fixed two undefined behaviors — PATCH on an already-archived dependency (now explicit `404`, Example 3c) and a checklist item remaining confirmable after its source dependency is archived mid-rotation (documented as intentional, Example 5f).
  - **Round 2 (Pre-mortem Analysis):** found and fixed a URL-validation bypass risk (regex/prefix checks are bypassable — mandated runtime `new URL()` parsing instead) and a data-exposure risk (users pasting credential-bearing URLs into the non-secret `linkUrl` field — mitigated with mandatory UI help text, no reliable server-side technical fix exists); flagged a forward-looking SSRF guardrail for any future story that fetches `linkUrl` server-side.
  - **Round 3 (Security Audit Personas — Hacker/Defender/Auditor):** added `previousLinkUrl` to the `credential.dependency_updated` audit payload for forensic before/after reconstruction (a URL field's history matters more than a date/cron field's, unlike the existing Story 2.4 PATCH audit precedent which only records new values); documented the accepted, unremediated phishing-link display risk as a deliberate trade-off, not an oversight.
  - **Round 4 (Challenge from Critical Perspective):** found the draft's client-side "added after staging" inference heuristic silently breaks when every active dependency was added after the rotation was staged (all-null response is ambiguous) — replaced with an explicit server-computed `hasStagedRotation` top-level flag; this resolves what was Open Question #2 in the original draft.
  - **Round 5 (Architecture Decision Records):** recorded 5 formal ADRs (ADR-2.10-01 through 05) documenting the reuse-existing-confirm-route decision, the explicit-flag-over-inference decision (Round 4), the URL-parsing-primitive decision (Round 2), the narrowly-scoped-PATCH-route decision, and the never-fetch-server-side decision — giving a future amending story the same breadcrumb trail Story 5.6 established for its own ADRs.
  - Net effect: 2 genuine security/correctness gaps fixed (URL-validation bypass, silent heuristic failure), 1 audit-completeness gap fixed (previousLinkUrl), 2 undefined-behavior edge cases resolved (archived-dependency PATCH, archived-dependency-with-live-checklist-item), 1 data-exposure risk mitigated via UX copy, 5 ADRs recorded. No item was descoped; all findings were integrated as amendments to the ACs/Tasks/Dev Notes above, not left as unintegrated prose.
