# Story 2.3: Credential Search, Filter & Tag Management

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-27 - comprehensive developer guide for the first credential collection (list/search/filter) endpoint, credential + project tag management, the canonical FR97 pagination implementation for the credential list, and the RS-E2a CI lint rule (scripts/check-search-index.ts) that makes indexing credential values structurally impossible. -->

## Story

As a developer working across many credentials,
I want to search and filter credentials by name, tag, status, and expiry, and manage tags on both credentials and projects,
so that I can quickly locate what I need without scrolling through a full list.

*Covers: FR14, FR95, FR97.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.3-Credential-Search-Filter--Tag-Management`]

> **The single most important invariant in this story (read first):** credential values are NEVER searched, indexed, returned, or logged. The `credentials` table has **no `value`/`encrypted_value` column** (it lives only in `credential_versions`, introduced clean in Story 2.2 per RS-E2a). This story adds two enforcing guards: (1) the negative test — searching for a known stored plaintext returns **zero** results (AC-E2a blocker); (2) the CI lint rule `scripts/check-search-index.ts` that fails the build if any migration or Drizzle index definition ever puts a value-bearing column into a full-text or trigram index. Any implementation that indexes, filters on, or returns credential material **fails security review and CI.**

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.2 (`credentials` + `credential_versions` tables, the credentials migration, the `credential.*` audit vocabulary) is merged and passing CI | This story is read/list/tag-management **on top of** 2.2's schema. It adds NO new credential columns except indexes and reuses the `credentials.tags` JSONB column 2.2 already created. Run `pnpm --filter @project-vault/db migrate` first. |
| Story 2.1 (`projects` table + projects module + `modules/projects/routes.ts`) is merged | The project-level tag endpoint (`PUT /api/v1/projects/:projectId/tags`) adds a route to the **existing** projects module and a `tags` column to the **existing** `projects` table. |
| Story 1.11 `SecureRoute` framework + `route-audit.test.ts` CI gate are merged | All new routes must be registered with `secureRoute()` and classified in `ROUTE_ACTION_CLASSIFICATIONS`. |
| Story 1.5 vault init/unseal is merged | The credential list/tag routes are NOT on the `vault-guard` allowlist, so they return `503 { status: "sealed" }` while sealed — even though they touch only metadata. Tests must assert this fail-closed behavior. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ On today's branch the highest migration is **`0012_refresh_tokens_org_id.sql`**. Story 2.1 lands `0013_projects.sql`, Story 2.2 lands `0014_credentials.sql`, so **this story's migration is `0015_credential_search_and_project_tags.sql`**. Before generating, re-read `packages/db/src/migrations/` and `meta/_journal.json` and use the **next free number after whatever 2.1 and 2.2 actually committed**. Every `0015_*` reference in this doc is an illustrative placeholder. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.3 |
|---|---|
| 2.1 | Created `projects` + the `modules/projects/` module + `GET /api/v1/projects` (deliberately **unpaginated** — ADR-2.1-06, an explicit recorded FR97 exception, **not** a precedent). 2.3's `tags` column is added to the `projects` table and the project-tags route is added to 2.1's projects module. |
| 2.2 | Created `credentials` (with the `tags jsonb not null default '[]'` column **already present**) and `credential_versions` (value material). 2.2 deliberately shipped **no** list/search endpoint — that is this story. The RS-E2a "never index a value column" invariant was introduced at the schema level in 2.2; **this story enforces it in CI**. |
| 2.4 | Adds `expiresAt`/`rotationSchedule` mutation (PATCH) and dependent systems. 2.3 only **reads** `expiresAt` for the `status`/`expiresWithin` filters; it does not mutate expiry. Story 2.4's `hasDependencies` flag is NOT part of 2.3's list response. |
| 2.7 | Cross-project **global** search. 2.7 reuses this story's never-index-values invariant + the `check-search-index.ts` lint rule and adds `pg_trgm` trigram indexes on `name`/`description`/`tags` (never on value columns). 2.3 itself uses **`ILIKE` substring matching** (no trigram index required at this scale) — do not add trigram indexes here; that is 2.7's scope. |
| 4.1 | Per-project RBAC. In 2.3, as in 2.1/2.2, access is org-scoped: list/search require `viewer`; tag mutation requires `member`. |
| 8.x | Tag-change audit events (`credential.tags_updated`, `project.tags_updated`) are written to `audit_log_entries` from day one (PJ5) and become queryable when Epic 8's audit UI lands. |

---

## Architecture Conflict Resolution (Read Before Coding)

The architecture document predates the epic refinement. Where they differ, the **epic + Story 2.1/2.2 conventions are authoritative**. Resolve every conflict as follows:

| Architecture / epic wording | Canonical implementation for 2.3 | Rationale |
|---|---|---|
| Architecture cursor pagination envelope `{ data, meta: { nextCursor, hasMore } }` | Use the epic's **offset** envelope: `{ items, total, page, limit, hasNext }`. Reuse the existing `apps/api/src/lib/pagination.ts` helper (`parsePagination`, `buildPaginationMeta`, `paginationOffset`) which already produces exactly this shape (`page`/`limit`/`total`/`hasNext`). | The epic ACs and the existing `SecurityAlertsQuerySchema` precedent (`page`/`limit`/`hasNext`) fix the offset shape. The `pagination.ts` lib already exists and is tested — do NOT invent cursor pagination or a second pagination helper. |
| Architecture full-text search / `tsvector` columns on secret content | 2.3 uses **`ILIKE` substring matching on `name`/`description` only**. No `tsvector`, no GIN, no trigram index in this story. | The epic specifies "case-insensitive substring match on `name` and `description` only". Trigram indexes (on non-value columns) are Story 2.7's scope. A `value`/`encrypted_value` column must NEVER enter any index — enforced by `check-search-index.ts`. |
| Architecture may model tags as a separate `tags`/`credential_tags` join table | Tags are a **JSONB string array** on `credentials.tags` (already created in Story 2.2) and a new `projects.tags` JSONB column. | Story 2.2 already committed `credentials.tags jsonb`. A relational tag table would contradict the shipped 2.2 schema and the epic's "free-text strings" model. AND-filtering uses the JSONB containment operator `@>`. |
| Fine-grained `read:secret_metadata` permission (NFR-SEC9) | Mapped to org roles in v1 (same as Story 2.2 ADR-2.2-03): list/search require `viewer`; tag mutation requires `member`. | No fine-grained permission framework exists yet. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| List + search + filter | `GET /api/v1/projects/:projectId/credentials?q=&tags=&status=&expiresWithin=&page=&limit=` returns `{ items, total, page, limit, hasNext }`, filtered by ALL provided params simultaneously (AND across params). Metadata only — never any value. |
| Substring search (`q`) | Case-insensitive substring match on `name` and `description` ONLY. Never on `value`/`encrypted_value` (no such column exists on `credentials`). |
| Status filter | `active` (no expiry OR expiry in future), `expiring` (expires within `expiresWithin` days, default 30), `expired` (past expiry). |
| Tag filter | `tags` is a comma-separated list; AND logic — a credential must carry ALL provided tags (JSONB `@>` containment). |
| Pagination (canonical FR97) | `page` (default 1), `limit` (default 20, max 100). This is THE reference FR97 implementation; reuse `lib/pagination.ts`. |
| Credential tag mgmt | `PUT .../credentials/:id/tags` replaces the tag array; `PATCH .../credentials/:id/tags` appends (dedup, set-union). Tags: free-text, ≤50 chars each, ≤20 per credential. |
| Project tag mgmt | `PUT /api/v1/projects/:projectId/tags` replaces the project tag array (same constraints). Adds a `tags` JSONB column to `projects`. |
| RS-E2a CI lint rule | `scripts/check-search-index.ts` fails the build if ANY migration or Drizzle index puts `value`/`encrypted_value` (or any value-bearing column) into a full-text/trigram index. Wired into `package.json` + a test. |
| Negative security test | Searching for a known stored credential plaintext returns ZERO results (AC-E2a blocker). Required passing test. |
| Route audit | All new routes registered in `ROUTE_ACTION_CLASSIFICATIONS`; list/search is `read` (audit-omitted, metadata only); tag mutations carry audit events. `route-audit.test.ts` passes. |
| Security | RLS org-scoped; cross-org/cross-project access returns 404 (no enumeration); sealed vault returns 503; tag mutation is fail-closed on audit. |
| Tests | List/empty/pagination/each filter/combined filters; AND tag logic; status boundaries; tag replace/append/dedup/bounds; project tags; negative plaintext test; CI lint rule test; cross-org isolation; sealed-vault 503. |

---

### AC-1: Database Schema — Add `tags` to `projects` (credentials already has `tags`)

**Given** Story 2.2 already created `credentials.tags jsonb not null default '[]'::jsonb` typed `$type<string[]>()`, and the `projects` table (Story 2.1) has NO tags column,
**When** Story 2.3 adds project-level tagging,
**Then** modify `packages/db/src/schema/projects.ts` to add the `tags` column (mirroring the credentials shape exactly):

```typescript
// in the projects pgTable column block, alongside description:
tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
```

Add the imports if missing: `jsonb` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm`.

**And** do NOT add any new column to `credentials` — its `tags` column already exists from Story 2.2. This story only **reads/writes** that column; it adds no migration change to `credentials` other than (optionally) the index in AC-1b.

**And** the `projects.tags` column is org-scoped by the existing `projects` RLS policy — no new RLS policy is required (the table already has `org_id` + its `ALL` policy from Story 2.1). Confirm `pnpm --filter @project-vault/db check-rls` still reports no gap after the migration.

---

### AC-1b: Migration (next free number, e.g. `0015_credential_search_and_project_tags.sql`)

> **Migration number is dynamic (R1).** Re-read `meta/_journal.json` immediately before `drizzle-kit generate`. On today's branch: tip `0012` → 2.1 `0013_projects` → 2.2 `0014_credentials` → this story `0015_credential_search_and_project_tags.sql`. Substitute the real number.

**Given** the RLS coverage gate and the migration conventions established in Stories 1.4/2.1/2.2,
**When** Story 2.3 creates the migration,
**Then** `pnpm --filter @project-vault/db generate` should emit:

1. `ALTER TABLE projects ADD COLUMN tags jsonb DEFAULT '[]'::jsonb NOT NULL;` (Drizzle generates this from the schema change in AC-1).
2. (Optional, performance only) a B-tree index supporting the credential list's default ordering and filters — `CREATE INDEX idx_credentials_project_expires ON credentials (project_id, expires_at);` to back the `status`/`expiresWithin` filter and the project-scoped scan. This is allowed because `expires_at` is **metadata, not value material**.

**And** the migration MUST NOT add any index, generated column, or `tsvector` referencing `value` or `encrypted_value` — there is no such column on `credentials`, and `check-search-index.ts` (AC-2) will fail CI if one is ever introduced.

**And** after generating, run `pnpm --filter @project-vault/db check-rls` (no gap) and `pnpm --filter @project-vault/db migrate` (applies cleanly). The repo uses **forward-only** migrations (no down files) — if reverted, do it via a new forward migration, never a hand-authored down (consistent with Story 2.1/2.2).

---

### AC-2: RS-E2a CI Lint Rule — `scripts/check-search-index.ts`

**Given** RS-E2a mandates that credential value columns (`value`, `encrypted_value`, or any column holding credential material) are NEVER added to a full-text or trigram index, and the epic requires this be **enforced in CI from this story onward**,
**When** Story 2.3 lands,
**Then** create `scripts/check-search-index.ts` — a static analysis script (no DB connection required; it scans source files) that:

1. Reads every migration SQL file in `packages/db/src/migrations/*.sql` and every Drizzle schema file in `packages/db/src/schema/*.ts`.
2. Flags as a violation any **index-creating construct** that references a forbidden value column. Forbidden column names (case-insensitive): `value`, `encrypted_value`, `encryptedValue`. Index-creating constructs to detect:
   - SQL: `CREATE INDEX ... ON ... (... value ...)`, `CREATE INDEX ... USING gin (...)`, `USING gist`, `to_tsvector(... value ...)`, `gin_trgm_ops`/`gist_trgm_ops` applied to a forbidden column.
   - Drizzle: `index('...').on(... value ...)`, `uniqueIndex(...).on(... value ...)`, or `.on(t.encryptedValue ...)`.
3. **Runtime-DDL coverage (closes the scanner's blind spot):** also scan application/worker source (`apps/**/src/**/*.ts`, `packages/**/src/**/*.ts`, EXCLUDING `packages/db/src/migrations` and test files) for any `CREATE INDEX` string or `db.execute(... CREATE INDEX ...)` — flag ANY runtime `CREATE INDEX` as a violation regardless of column, because all index/schema changes MUST go through migrations. A value-column index created at runtime would otherwise bypass a migrations-only scan entirely. ("No runtime DDL" is the enforced invariant; see AC-8.)
4. Exits non-zero with a clear message listing each offending file + line when a violation is found; prints an OK line and exits 0 otherwise.

**Model it on `scripts/check-rls-coverage.ts`** (same `process.stderr.write` + `process.exitCode = 1` style) but as a **file scanner**, not a DB query. Suggested skeleton:

```typescript
#!/usr/bin/env tsx
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = ['value', 'encrypted_value', 'encryptedvalue']
const INDEX_HINTS = ['create index', 'using gin', 'using gist', 'to_tsvector', 'gin_trgm_ops', 'gist_trgm_ops', '.on(']

type Violation = { file: string; line: number; text: string }

function scanSql(file: string, content: string, out: Violation[]): void {
  // Join statements; detect CREATE INDEX ... that references a forbidden column.
  // A simple, robust heuristic: split on ';', for each statement that contains an
  // index hint AND a forbidden column token (word-boundary), record it.
}

function scanDrizzle(file: string, content: string, out: Violation[]): void {
  // Detect index(...).on(...) / uniqueIndex(...).on(...) chains whose .on(...) args
  // reference a forbidden column (t.value, t.encryptedValue, 'value', 'encrypted_value').
}

// ... walk migrations + schema dirs, run both scanners, report, set exitCode.
```

**And** wire it into the root `package.json` scripts so CI runs it:

```json
"check-search-index": "tsx scripts/check-search-index.ts"
```

(Place it next to the existing `"check-rls": "tsx scripts/check-rls-coverage.ts"` entry. CI invokes it the same way `check-rls` is invoked.)

**And** add `scripts/check-search-index.test.ts` (vitest) with at least:
- a **positive control** that the scanner flags a synthetic fixture string containing `CREATE INDEX bad ON credential_versions (encrypted_value)` and `index('x').on(t.encryptedValue)`.
- a **runtime-DDL positive control** that the scanner flags a synthetic `db.execute(sql\`CREATE INDEX ... \`)` string located outside `migrations/` (proves the blind-spot is closed).
- a **negative control** that the scanner does NOT flag the legitimate `idx_credentials_project_expires` index or any `name`/`description`/`tags` index.
- a guard that the **current real migration + schema + app/worker source pass** (the live tree must be clean).

> **Why a static scanner, not a DB check:** the RLS check queries a live DB because RLS state lives in `pg_policies`. Index-on-value is a **source-level** mistake — catching it by scanning migrations/schema means a bad PR fails CI before it ever reaches a database. The scanner is intentionally conservative: a false positive (blocking a legitimately-named non-value column that happens to contain the substring `value`, e.g. a hypothetical `key_value_label`) is acceptable and fixed by renaming or an explicit allow-list comment; a false negative (letting a value column into an index) is a security failure. Prefer over-blocking.

---

### AC-3: `GET /api/v1/projects/:projectId/credentials` — List, Search & Filter

**Given** a project exists in the caller's org and the caller has at least `viewer` role,
**When** they call the list endpoint with any combination of `q`, `tags`, `status`, `expiresWithin`, `page`, `limit`,
**Then** return a paginated, fully-filtered page of credential **metadata** — never any value.

**Request (all filters combined):**
```http
GET /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials?q=stripe&tags=payments,prod&status=expiring&expiresWithin=45&page=1&limit=20
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000100",
        "projectId": "00000000-0000-4000-8000-000000000010",
        "name": "Stripe Secret Key",
        "description": "Production Stripe API secret",
        "tags": ["payments", "prod", "third-party"],
        "status": "expiring",
        "expiresAt": "2026-07-20T23:59:59.000Z",
        "rotationSchedule": "0 0 1 * *",
        "currentVersionNumber": 2,
        "createdAt": "2026-06-27T20:00:00.000Z",
        "updatedAt": "2026-06-27T21:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20,
    "hasNext": false
  }
}
```

**And** the response item contains ONLY metadata. The SELECT must enumerate columns explicitly — never `select()` the whole row in a way that could pull a value column (there is none on `credentials`, but the explicit projection is the durable guard). Specifically, NEVER join `credential_versions` to expose `encrypted_value`. `currentVersionNumber` is derived as `MAX(version_number) WHERE purged_at IS NULL` per credential (ADR-2.2-05) via a correlated subquery or a grouped join on `credential_versions` selecting ONLY `version_number` (never the value).

**And** all provided filters combine with **AND** semantics (every param narrows the result set). An empty/absent param does not filter on that dimension.

**`q` — substring search:**
- Case-insensitive substring match on `name` OR `description` only:
  ```typescript
  // q is sanitized for LIKE wildcards to avoid the caller injecting % or _ as wildcards.
  const term = q.replace(/[\\%_]/g, (m) => `\\${m}`)            // escape \, %, _
  const like = `%${term}%`
  where(or(ilike(credentials.name, like), ilike(credentials.description, like)))
  ```
- `q` NEVER touches `value`/`encrypted_value` (no such column on `credentials`). The negative test (AC-9) asserts a known plaintext value yields zero matches.
- A blank `q` (`?q=`) is treated as "no search term" (do not filter). Trim `q`; an all-whitespace `q` is also "no term".

**`status` — lifecycle filter** (`active` | `expiring` | `expired`):
| Value | SQL predicate (server `now()`) | Meaning |
|---|---|---|
| `active` | `expires_at IS NULL OR expires_at > now()` | No expiry, or expiry strictly in the future (superset of `expiring`). |
| `expiring` | `expires_at > now() AND expires_at <= now() + make_interval(days => :expiresWithin)` | Expires within the window (default 30 days). |
| `expired` | `expires_at IS NOT NULL AND expires_at <= now()` | Expiry at or before now. |

- `expiresWithin` (positive integer days, default 30, max 3650) ONLY affects the `expiring` predicate. It is ignored for `active`/`expired` (document this; do not error if supplied with another status).
- **Build the interval parameterized — NEVER by string concatenation.** Use `sql\`now() + make_interval(days => ${expiresWithin})\`` so `expiresWithin` is a bound parameter. Do NOT use `sql.raw` or concatenate `expiresWithin` into an interval literal like `(expiresWithin || ' days')::interval` — even though Zod bounds the value, the string-concat idiom is an injection surface and must not appear (see Anti-Patterns).
- **Overlap is intentional:** `active` is a superset that includes `expiring` credentials. Selecting `status=active` returns everything not yet expired; `status=expiring` returns the subset inside the window. Do not try to make them mutually exclusive — the epic defines them this way and the UI treats them as distinct lenses.
- Boundary: a credential whose `expires_at` exactly equals `now()` is `expired` (use `<=` for expired, `>` for active/expiring lower bound) — assert this boundary in tests with a fixed clock or a value a few seconds in the past/future.

**`tags` — AND-containment filter:**
- `tags=payments,prod` → split on comma, trim each, drop empties → `["payments","prod"]`.
- A credential matches only if it carries **all** provided tags. Use JSONB containment:
  ```typescript
  // tags column is jsonb string array; @> tests "left contains right".
  where(sql`${credentials.tags} @> ${JSON.stringify(tagList)}::jsonb`)
  ```
- Empty tag list (`?tags=` or `?tags=,,`) does not filter.
- Tag matching is **exact, case-sensitive** string match (a tag `Prod` does not match `prod`). Document this; case-insensitive tag search is out of scope.

**`status` field in each item** is the server-derived lifecycle bucket for that credential (`active`/`expiring`/`expired`) computed from `expires_at` and the default 30-day window — useful for the UI badge. Note this is computed with the **default** 30-day window for the badge, independent of the request's `expiresWithin` (so the badge is stable across queries). Document this distinction.

**Pagination (canonical FR97 — reuse `lib/pagination.ts`):**
```typescript
import { parsePagination, buildPaginationMeta, paginationOffset } from '../../lib/pagination.js'

const { page, limit } = parsePagination(query.page, query.limit) // defaults page 1, limit 20, max 100
const offset = paginationOffset({ page, limit })
// ... run a COUNT(*) (same WHERE, no limit/offset) for total, and the page query with .limit(limit).offset(offset)
const meta = buildPaginationMeta({ page, limit }, total)          // { page, limit, total, hasNext }
return { data: { items, ...meta } }
```
- `limit` is clamped to max 100 by `parsePagination`. `page < 1` or non-numeric falls back to defaults.
- **Deep-OFFSET guard (DoS):** the computed offset (`(page-1) * limit`) is capped at **10,000**. A request whose offset would exceed the cap returns `422 { code: "page_out_of_range", message: "Page is too deep; narrow your filters" }` rather than executing an unbounded scan-and-discard. (Keyset/cursor pagination is the future escape hatch if a single project legitimately exceeds this depth — out of scope here.)
- `total` is the count of ALL rows matching the filters (not just the page).
- Order results by `created_at DESC, id DESC` (stable tiebreak so pagination is deterministic across pages).

**Project existence / scoping:**
- If `:projectId` is not a UUID → `422 { code: "validation_error" }`.
- If the project does not exist in the caller's org (RLS returns it out of scope, or it truly does not exist) → `404 { code: "project_not_found", message: "Project not found" }`. Both "wrong org" and "missing" return 404 (no enumeration, per Story 2.1/2.2 precedent). Verify the project exists before running the list query, OR run the list query (which is project-scoped) and a project existence check; an empty list for a real owned project is `200 { items: [] }`, but a non-existent/foreign project is `404`.

**Security config:**
```typescript
security: {
  minimumRole: 'viewer',
  writeAuditEvent: false,   // metadata read, no value exposure — classified 'read' in route-exemptions
  rateLimit: { max: 120, timeWindowMs: 60_000, key: 'GET /api/v1/projects/:projectId/credentials' },
}
```

**Empty result for a real project:**
```json
{ "data": { "items": [], "total": 0, "page": 1, "limit": 20, "hasNext": false } }
```

---

### AC-4: Credential Tag Management — `PUT` (replace) & `PATCH` (append)

**Given** a credential exists in the caller's org+project and the caller has at least `member` role,
**When** they manage tags,
**Then** support two distinct operations on `credentials.tags`:

**`PUT /api/v1/projects/:projectId/credentials/:credentialId/tags` — REPLACE the entire tag array:**

Request:
```http
PUT /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/tags
Content-Type: application/json

{ "tags": ["payments", "prod"] }
```
Response (`200 OK`):
```json
{ "data": { "id": "00000000-0000-4000-8000-000000000100", "tags": ["payments", "prod"] } }
```
- The new array fully replaces the old one (sending `{ "tags": [] }` clears all tags).

**`PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags` — APPEND (set-union):**

Request:
```http
PATCH /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/tags
Content-Type: application/json

{ "tags": ["third-party", "payments"] }
```
Response (`200 OK`) — existing `["payments","prod"]` unioned with `["third-party","payments"]`:
```json
{ "data": { "id": "00000000-0000-4000-8000-000000000100", "tags": ["payments", "prod", "third-party"] } }
```
- Append performs a **set union with de-duplication** preserving existing order then appending new unique tags in request order. Re-adding an existing tag is a no-op (no duplicate, no error).
- Compute the union in the app layer after reading the current row **under a row lock** (read-modify-write within the SecureRoute `tx`, RLS-scoped). The `FOR UPDATE` lock prevents a lost update when two appends race (ADR-2.3-05):
  ```typescript
  // FOR UPDATE serializes concurrent tag mutations on this credential (ADR-2.3-05).
  const [row] = await tx.select({ tags: credentials.tags })
    .from(credentials)
    .where(and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId)))
    .for('update')
    .limit(1)
  if (!row) return reply.status(404).send({ code: 'credential_not_found', message: 'Credential not found' })
  const merged = [...row.tags, ...body.tags.filter((t) => !row.tags.includes(t))]
  ```
- Apply the same `FOR UPDATE` lock to the `PUT` replace path's existence check too, so credential tag mutations are uniformly serialized (cheap; tag edits are rare).

**Shared rules for BOTH operations:**
- **Bounds enforced AFTER the operation:** each tag ≤50 chars, and the RESULTING array ≤20 tags. For `PATCH`, the union must not exceed 20 — if it would, return `422 { code: "too_many_tags", message: "A credential may have at most 20 tags" }` (do not silently truncate).
- Tags are free-text but trimmed; reject empty/whitespace-only tags with `422`. Tags are stored verbatim (case preserved).
- Reject duplicate tags **within a single PUT request** body? No — silently de-dupe the incoming array for PUT too (a PUT of `["a","a"]` stores `["a"]`). Document this.
- The update uses `.returning({ id, tags })`; a 0-row result (cross-org/missing) → `404` (never a fabricated 200).
- `updatedAt` is bumped by the existing `set_updated_at` trigger on `credentials` (PUT/PATCH are UPDATEs).

**Security config (both routes):**
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PUT|PATCH .../credentials/:credentialId/tags' },
  writeAuditEvent: { eventType: 'credential.tags_updated', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```
- Audit payload records the operation mode and the **tag delta** for forensic reconstruction: `{ mode: 'replace' | 'append', added: string[], removed: string[], resultCount }`. Tags are **non-secret metadata**, so recording their values in the audit payload is intentional and compliance-valuable (contrast: a credential **value** must NEVER appear in any audit payload). Compute the delta against the locked current row: for `PUT`, `removed = old − new`, `added = new − old`; for `PATCH`, `removed = []`, `added =` the newly-unioned tags. Both PUT and PATCH map to the same `credential.tags_updated` event; `mode` distinguishes them.
- **Actor recorded as a token reference (PJ6):** the SecureRoute default audit writer records the actor as `actorTokenId` via `firstActorTokenIdForUser(tx, auth.userId)` — a `user_identity_token` reference, not a raw user identity — consistent with Story 2.2's reveal audit. Assert this in the audit test.

---

### AC-5: Project Tag Management — `PUT /api/v1/projects/:projectId/tags`

**Given** the caller has at least `member` role on the org,
**When** they replace a project's tags,
**Then** mirror the credential PUT semantics against `projects.tags`:

Request:
```http
PUT /api/v1/projects/00000000-0000-4000-8000-000000000010/tags
Content-Type: application/json

{ "tags": ["team-payments", "tier-0"] }
```
Response (`200 OK`):
```json
{ "data": { "id": "00000000-0000-4000-8000-000000000010", "tags": ["team-payments", "tier-0"] } }
```

- REPLACE semantics (same as credential PUT): full array replacement, `[]` clears, de-dupe incoming, each tag ≤50 chars, ≤20 tags, no empty/whitespace tags → `422`.
- This route lives in the **projects module** (`apps/api/src/modules/projects/routes.ts`, created by Story 2.1) since it operates on the `projects` table — NOT in the credentials module. Add it there.
- 0-row `.returning()` (cross-org/missing project) → `404 { code: "project_not_found" }`.
- The epic specifies only `PUT` for project tags (no append). Do not add a project-tags PATCH in this story.

**Security config:**
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PUT /api/v1/projects/:projectId/tags' },
  writeAuditEvent: { eventType: 'project.tags_updated', resourceType: 'project', resourceIdFromParams: 'projectId' },
}
```
- Audit payload mirrors AC-4: `{ mode: 'replace', added: string[], removed: string[], resultCount }` (project tags are non-secret metadata). Actor recorded as `actorTokenId` (PJ6), same as the credential tag routes.

---

### AC-6: Shared & API Zod Schemas

**Given** response shapes the web app will consume live in `@project-vault/shared` (Story 2.1/2.2 precedent), and request schemas live in the API module,
**When** Story 2.3 adds schemas,
**Then**:

**`packages/shared/src/schemas/credentials.ts` (EXTEND — Story 2.2 created this file):** add the list/summary response schemas. Do NOT modify the existing `CredentialDetailSchema` / `CredentialValueSchema` / `CredentialVersionSummarySchema`.

```typescript
import { z } from 'zod/v4'

export const CredentialStatusSchema = z.enum(['active', 'expiring', 'expired'])

export const CredentialSummarySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  status: CredentialStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  rotationSchedule: z.string().nullable(),
  currentVersionNumber: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).meta({ id: 'CredentialSummary' })

export type CredentialStatus = z.infer<typeof CredentialStatusSchema>
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>
```
(The file is already exported from `packages/shared/src/index.ts` by Story 2.2 — no index change needed beyond confirming the new exports are picked up.)

**`apps/api/src/modules/credentials/schema.ts` (EXTEND — Story 2.2 created this file):** add the list query schema, the tag-mutation body schema, and response envelopes.

```typescript
import { z } from 'zod/v4'
import { CredentialSummarySchema } from '@project-vault/shared'

// Query params arrive as strings — coerce numerics; everything optional.
export const ListCredentialsQuerySchema = z.object({
  q: z.string().trim().max(256).optional(),
  tags: z.string().max(1024).optional(),            // comma-separated; parsed in handler
  status: z.enum(['active', 'expiring', 'expired']).optional(),
  expiresWithin: z.coerce.number().int().min(1).max(3650).default(30),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict().meta({ id: 'ListCredentialsQuery' })
// Deep-OFFSET guard (AC-3 / AC-8): reject offsets beyond MAX_OFFSET in the handler.
export const MAX_CREDENTIAL_LIST_OFFSET = 10_000

// Tag bodies: free-text strings, each <= 50 chars; array bound (<= 20) enforced in handler
// AFTER replace/append so PATCH unions are validated against the resulting array (AC-4).
export const TagArrayBodySchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
}).strict().meta({ id: 'TagArrayBody' })

export const ListCredentialsResponseSchema = z.object({
  data: z.object({
    items: z.array(CredentialSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    hasNext: z.boolean(),
  }),
}).meta({ id: 'ListCredentialsResponse' })

export const TagUpdateResponseSchema = z.object({
  data: z.object({ id: z.uuid(), tags: z.array(z.string()) }),
}).meta({ id: 'TagUpdateResponse' })
```

**And** notes:
- `ListCredentialsQuerySchema` uses `z.coerce` for numerics because query params are strings (mirrors the existing `SecurityAlertsQuerySchema` precedent in `modules/org/schema.ts`). `.strict()` rejects unknown query keys with `422`.
- `TagArrayBodySchema.max(20)` bounds a single PUT; the PATCH **union** bound (>20 after merge) is enforced in the handler with `422 too_many_tags` (the Zod `.max(20)` on the body only bounds the incoming array, not the post-merge result — see AC-4).
- The project-tags route (AC-5) reuses `TagArrayBodySchema` (imported into `modules/projects/schema.ts`) and a `{ id, tags }` response envelope. Do not duplicate the body schema; import it or define a shared one.
- Wire every response schema to the route's `schema.response` so `@fastify/type-provider-zod` serializes correctly. Convert Drizzle `Date` → ISO string before sending (Story 2.1/2.2 timestamp note).

---

### AC-7: Route Registration & Audit Classification

**Given** the route-audit CI gate (`route-audit.test.ts`) reads `ROUTE_FILES` and `ROUTE_ACTION_CLASSIFICATIONS`,
**When** Story 2.3 adds the new routes,
**Then**:

1. **Credentials module** (`apps/api/src/modules/credentials/routes.ts`, created by Story 2.2 — already in `ROUTE_FILES`): add the list route and the two credential-tag routes. No `ROUTE_FILES` change needed for credentials (2.2 added it); confirm it is present.
2. **Projects module** (`apps/api/src/modules/projects/routes.ts`, created by Story 2.1 — already in `ROUTE_FILES`): add the project-tags PUT route.
3. Add all new routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:
```typescript
'GET /api/v1/projects/:projectId/credentials': {
  action: 'read',
  auditOmissionReason: 'Credential list/search returns metadata only; never any credential value (RS-E2a).',
  reviewer: 'api-security-reviewer',
},
'PUT /api/v1/projects/:projectId/credentials/:credentialId/tags': {
  action: 'mutation', auditEvent: 'credential.tags_updated',
},
'PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags': {
  action: 'mutation', auditEvent: 'credential.tags_updated',
},
'PUT /api/v1/projects/:projectId/tags': {
  action: 'mutation', auditEvent: 'project.tags_updated',
},
```
4. Add the new audit event names to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`: `'credential.tags_updated'` and `'project.tags_updated'`. (Story 2.2 already added the core `credential.*` names and removed the stale `secret.*` members; if `secret.*` somehow still lingers, this story is also a fine place to delete them. Keep the strings byte-identical across classifications, `writeAuditEvent`, payloads, and this union.) Run `pnpm --filter @project-vault/shared test` and `pnpm typecheck` after.
5. The route URLs follow the Story 2.2 convention: the `:projectId` param is declared in each route's `url` (e.g. `url: '/:projectId/credentials'`), NOT in the plugin prefix (Fastify does not reliably populate `req.params` from a plugin-prefix param). Mirror exactly what 2.2's credentials module and 2.1's projects module did.
6. After updating, run `route-audit.test.ts` in isolation and confirm all four new routes appear and are classified (a `read` with `auditOmissionReason`, three `mutation`s with `auditEvent`). Confirm the gate accepts a `read` GET with an omission reason (the precedent is `GET /api/v1/auth/sessions`).

---

### AC-8: Security Hardening (Search-Specific Invariants)

**Given** Project Vault is a secrets manager and this is the first collection/search surface for credentials,
**When** Story 2.3 routes and the lint rule are implemented,
**Then** satisfy every invariant below:

| Threat | Required mitigation |
|---|---|
| Credential value indexed (RS-E2a) | No migration/Drizzle index references `value`/`encrypted_value`. `scripts/check-search-index.ts` (AC-2) fails CI if one is ever added. The `credentials` table has no value column at all. |
| Credential value leaks into a list/search response | The list SELECT enumerates only metadata columns and NEVER joins `credential_versions` for `encrypted_value`. The AC-9 negative test searches a known stored plaintext and asserts zero results AND scans every list/tag response body for the sentinel, asserting absence. |
| `q` injection / LIKE wildcard abuse | `q` is parameterized via Drizzle (`ilike(col, value)`), never string-interpolated into SQL. LIKE metacharacters (`%`, `_`, `\`) in `q` are escaped so a caller cannot turn a search into a full-table wildcard or probe. |
| Tag-based enumeration of value material | Tags are user-supplied metadata; AND-containment on the JSONB array reveals only which credentials carry which tags — never any value. Acceptable. |
| Cross-org / cross-project access | RLS scopes the `tx` by org; handlers additionally constrain `projectId`/`credentialId`. Both "wrong org" and "missing" return `404` (no enumeration). |
| Mass assignment | All bodies/queries are `.strict()`; Drizzle updates use Zod-parsed output, never raw `req.body`/`req.query`. `orgId`/`projectId` never accepted from the body. |
| Tag mutation without audit | PUT/PATCH tag routes are fail-closed on audit via SecureRoute same-tx `writeAuditEvent` — if the audit write fails, the tag update rolls back and the client gets `503 audit_write_failed`. |
| Vault sealed | The list and tag routes are NOT on the `vault-guard` allowlist; `plugins/vault-guard.ts` returns `503 { status: "sealed" }` while sealed. Assert in tests for at least the list route and one tag route. |
| Unbounded result payload | `limit` clamped to max 100 by `parsePagination`; `total` computed via COUNT. No "return everything" path (this is the canonical FR97 endpoint — unlike the deliberately-unpaginated project list, ADR-2.1-06). |
| ReDoS via `q` regex escaping | The LIKE-escape uses a simple character-class replace (`/[\\%_]/g`), not a backtracking regex — constant-time per character. Do not build a complex regex from user input. |
| `expiresWithin` interval injection | The `expiring` window is built with `make_interval(days => ${expiresWithin})` as a **bound parameter** — never `sql.raw` or string concatenation into an interval literal (AC-3, Anti-Patterns). Zod also bounds it to 1–3650. |
| Deep-OFFSET DoS | The computed offset is capped at `MAX_CREDENTIAL_LIST_OFFSET` (10,000); a deeper request returns `422 page_out_of_range` instead of an unbounded scan-and-discard (AC-3). The 120/min rate limit is a secondary bound. |
| Runtime DDL bypassing the lint rule | `check-search-index.ts` flags ANY `CREATE INDEX` outside `migrations/` (AC-2). All schema/index changes go through migrations — no runtime `db.execute('CREATE INDEX …')`. This closes the migrations-only scanner blind spot. |
| Error-channel value / DB leak | A forced query/cast error on these routes returns a **generic sanitized 500** (handled by the global error handler) — never the raw DB error text, the SQL, or any input/value. A test forces a query error and asserts the response contains no value, no SQL, and no internal detail. |

**Accepted residual risks (documented, not blocking):**
- **Tag matching is case-sensitive and exact (no normalization):** `Prod` != `prod`. Case-insensitive/normalized tags are deferred; document so it is not mistaken for a bug.
- **`status` badge uses the default 30-day window, not the request `expiresWithin`:** the per-item `status` field is computed with the fixed 30-day window so the badge is stable regardless of the query filter; the `expiring` *filter* honors `expiresWithin`. This split is intentional (AC-3).
- **`check-search-index.ts` is a heuristic scanner:** it may over-block a non-value column whose name contains the substring `value`. Over-blocking is the safe failure direction (AC-2).
- **Tags are free-text and may contain user-entered PII:** tag values are user-controlled and recorded (including in the tag-change audit payload, which is acceptable since tags are non-secret metadata). No PII scrubbing/erasure for tags exists in 2.3 — PII handling/erasure for tags is **Epic 8 scope** (audit PII management / data-subject erasure), not this story. Documented residual.

---

### AC-9: Integration & Unit Tests

> Follow repo TDD red-green (`AGENTS.md`): write failing tests first, confirm the failure reason, implement the smallest change, then re-run focused + broader checks. All DB/integration tests run with RLS active (`withTestOrg()`/`withOrg()`); never assert state from a bare `getDb()` query without org context (it silently returns zero rows and false-passes).

**API integration tests — `apps/api/src/modules/credentials/credentials-search.test.ts`** (reuse `registerAndLoginViaApi` + `cookieHeader` from `apps/api/src/__tests__/helpers/auth-test-helpers.ts`; vault unsealed in harness; seed credentials via the Story 2.2 create endpoint or direct inserts within the org context):

```
GET .../credentials (list/search/filter)
  - 200 empty list for a real project with no credentials ({ items: [], total: 0, page: 1, limit: 20, hasNext: false })
  - 200 returns metadata only; NO value/encryptedValue field on any item
  - 200 q substring match on name (case-insensitive); matches description too
  - 200 q does NOT match on value: NEGATIVE TEST — create a credential with a known sentinel
        value, search q=<sentinel>, assert total === 0 and the sentinel appears in NO response body
        (AC-E2a blocker — required passing test)
  - 200 q with LIKE metachars (%, _, \) is escaped and matched literally (no wildcard blowup)
  - 200 status=active returns non-expired (null expiry + future expiry)
  - 200 status=expired returns only past-expiry credentials
  - 200 status=expiring honors expiresWithin (default 30; custom 45 includes a 40-day-out cred,
        excludes a 60-day-out cred)
  - 200 status boundary: a credential expiring exactly now is 'expired', not 'active'/'expiring'
  - 200 tags AND logic: tags=a,b returns only credentials carrying BOTH a and b (not just one)
  - 200 combined filters (q + tags + status + expiresWithin) AND together
  - 200 pagination: limit clamps to 100; page 2 returns the next slice; hasNext correct; total is full count
  - 422 unknown query key (.strict)
  - 422 projectId not a UUID
  - 422 page_out_of_range when the computed offset exceeds MAX_CREDENTIAL_LIST_OFFSET (deep-OFFSET DoS guard)
  - 404 project in another org (not 403); 404 non-existent project
  - 401 unauthenticated; 503 when vault sealed
  - sanitized 500: a forced query/cast error returns a generic 500 with NO SQL, input, or value in the body

PUT .../credentials/:id/tags (replace)
  - 200 replaces tag array fully; { tags: [] } clears
  - 200 de-dupes incoming array (["a","a"] -> ["a"])
  - 422 a tag > 50 chars; 422 > 20 tags; 422 empty/whitespace tag
  - 404 credential missing / wrong project / wrong org
  - 403 viewer; 401 unauthenticated; 503 sealed
  - audit: writes credential.tags_updated with payload { mode: 'replace', added, removed, resultCount },
    actor recorded as actorTokenId (PJ6, user_identity_token reference), and NO credential value anywhere
  - AUDIT-FAILURE ROLLBACK: forced audit-write failure rolls back the tag update, returns 503,
    tags unchanged in DB

PATCH .../credentials/:id/tags (append)
  - 200 unions with existing tags, de-dupes, preserves existing order then appends new
  - 200 re-adding an existing tag is a no-op (no duplicate, 200)
  - 422 too_many_tags when the union would exceed 20
  - 404/403/401/503 as above
  - audit: payload { mode: 'append', added, removed: [], resultCount }; actor as actorTokenId (PJ6)
  - CONCURRENT APPEND (no lost update, ADR-2.3-05): two near-simultaneous PATCH appends of
    different tags to the same credential both survive — the final array contains BOTH added
    tags (the FOR UPDATE lock serializes the read-modify-write; neither write clobbers the other)
```

**Project tags test — `apps/api/src/modules/projects/project-tags.test.ts`:**
```
PUT /api/v1/projects/:projectId/tags
  - 200 replaces project tags; [] clears; de-dupes
  - 422 tag > 50 / > 20 tags / empty tag
  - 404 project in another org; 404 missing project
  - 403 viewer; 503 sealed
  - audit: project.tags_updated
```

**DB-layer test — `packages/db/src/__tests__/project-tags-schema.test.ts`** (or extend the Story 2.1 projects RLS test): assert the `projects.tags` column exists, defaults to `[]`, and is org-isolated by RLS (same `withOrg` pattern).

**CI lint rule test — `scripts/check-search-index.test.ts`** (AC-2): positive control flags a synthetic `encrypted_value` index; negative control passes the `name`/`description`/`tags`/`expires_at` indexes; the live migration+schema tree is clean.

**Security regression (value never leaks):** one test seeds a credential with a known sentinel value, then calls the list endpoint (with and without `q=<sentinel>`) and both tag endpoints, asserting the sentinel string appears in NONE of the response bodies and that `q=<sentinel>` yields `total === 0`.

---

### AC-10: Explicit Out of Scope

Do NOT implement in Story 2.3:

- **Trigram / `pg_trgm` / GIN / `tsvector` indexes** — Story 2.7 (global search) adds trigram indexes on `name`/`description`/`tags`. 2.3 uses `ILIKE` substring matching with no special index (an optional B-tree on `(project_id, expires_at)` is allowed for the status filter).
- **Cross-project / global search** (`GET /api/v1/search`) — Story 2.7. 2.3 is project-scoped only.
- **Credential value retrieval, reveal, version history, create, add-version, retention** — Story 2.2 (already shipped).
- **`expiresAt` / `rotationSchedule` mutation, dependent systems, the `hasDependencies` flag, the access list** — Story 2.4. 2.3 only READS `expiresAt` for filtering.
- **Bulk import** (Story 2.5), **onboarding wizard** (Story 2.6).
- **Wiring real credential counts into the Story 2.1 project dashboard** — out of scope here (a small follow-up; if done opportunistically, keep all 2.1 dashboard tests green).
- **Project-tags PATCH (append)** — the epic specifies only PUT for project tags. Do not add a project-tags append route.
- **Case-insensitive / normalized tag matching** — tags are exact case-sensitive strings in v1 (AC-8 residual).
- **Per-project RBAC** — access is org-scoped (viewer to read, member to mutate tags); Story 4.1 owns per-project roles.
- **Frontend / web UI for search and tags** — this story is backend only. The web search/tag UI arrives with later Epic 2 work (and the global search box in 2.7).
- **Sorting controls / arbitrary `orderBy` query params** — the list is fixed-ordered `created_at DESC, id DESC`. Configurable sort is a future enhancement.

---

## Tasks / Subtasks

- [ ] **Task 1: Project tags schema + migration** (AC: 1, 1b)
  - [ ] Add `tags` JSONB column to `packages/db/src/schema/projects.ts` (mirror credentials shape: `notNull().default('[]').$type<string[]>()`).
  - [ ] Run `pnpm --filter @project-vault/db generate`; confirm the next free migration number against `meta/_journal.json` (e.g. `0015_credential_search_and_project_tags.sql`).
  - [ ] Add the optional `idx_credentials_project_expires` B-tree index to the migration; confirm NO value-column index.
  - [ ] Run `pnpm --filter @project-vault/db check-rls` (no gap) and `migrate` (applies cleanly).
- [ ] **Task 2: RS-E2a CI lint rule** (AC: 2) — write `scripts/check-search-index.test.ts` first (positive + negative controls), then implement `scripts/check-search-index.ts`; add `"check-search-index"` to root `package.json`; confirm it passes on the live tree and fails on the synthetic fixture.
- [ ] **Task 3: Shared + API schemas** (AC: 6)
  - [ ] Extend `packages/shared/src/schemas/credentials.ts` with `CredentialStatusSchema` + `CredentialSummarySchema`.
  - [ ] Extend `apps/api/src/modules/credentials/schema.ts` with `ListCredentialsQuerySchema`, `TagArrayBodySchema`, and response envelopes.
  - [ ] Reuse `TagArrayBodySchema` in `apps/api/src/modules/projects/schema.ts` for the project-tags route.
  - [ ] Unit-test query coercion, `.strict()` rejection, and tag bounds.
- [ ] **Task 4: GET list/search/filter** (AC: 3, 7, 8) — failing test first; implement project existence 404, `q` ILIKE (escaped), `status`/`expiresWithin` predicates, `tags` AND-containment, `currentVersionNumber` subquery (no value join), pagination via `lib/pagination.ts`, fixed ordering. Add the route classification.
- [ ] **Task 5: Credential tag PUT + PATCH** (AC: 4, 7, 8) — failing test first; replace vs union-append + dedup; post-op bounds (`too_many_tags` for >20 union); `.returning()` 0-row → 404; audit `credential.tags_updated` with `{ mode, tagCount }`.
- [ ] **Task 6: Project tag PUT** (AC: 5, 7, 8) — failing test first; in the projects module; replace semantics; 0-row → 404; audit `project.tags_updated`.
- [ ] **Task 7: Audit-event constants + route registration** (AC: 7) — add `credential.tags_updated` + `project.tags_updated` to `AuditEventType`; confirm all four routes in `ROUTE_ACTION_CLASSIFICATIONS`; run `route-audit.test.ts` in isolation.
- [ ] **Task 8: Negative + regression security tests** (AC: 8, 9) — the AC-E2a negative plaintext test (search returns zero results) and the value-never-leaks scan across list + tag responses; tag-mutation audit-failure rollback.
- [ ] **Task 9: Final verification** (AC: all)
  - [ ] `pnpm --filter @project-vault/db test` + `check-rls`.
  - [ ] `pnpm --filter @project-vault/api test` (integration + route-audit).
  - [ ] `pnpm --filter @project-vault/shared test`.
  - [ ] `pnpm check-search-index` (RS-E2a guard passes on the live tree).
  - [ ] `pnpm typecheck` and `pnpm lint` at repo root.

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Credentials module | `apps/api/src/modules/credentials/` (created by 2.2). Add the list route + two tag routes to `routes.ts`; add query/body schemas to `schema.ts`; extract a `search-service.ts`/`tags-service.ts` if a handler exceeds ~60 lines. Service functions MUST accept `tx: Tx` and use it exclusively — never `getDb()` inside a handler-invoked helper. |
| Projects module | `apps/api/src/modules/projects/` (created by 2.1). Add the project-tags PUT route here (it operates on `projects`). |
| DB schema change | `packages/db/src/schema/projects.ts` — add `tags`. No change to `credentials.ts` (tags already exist). |
| Migration | `packages/db/src/migrations/<next>_credential_search_and_project_tags.sql` — verify number against `meta/_journal.json`; never hardcode. |
| CI lint rule | `scripts/check-search-index.ts` (+ `.test.ts`); wire into root `package.json`. |
| Shared schema | `packages/shared/src/schemas/credentials.ts` (extend). |

### Key Code Patterns to Follow

- **Pagination:** reuse `apps/api/src/lib/pagination.ts` (`parsePagination`, `buildPaginationMeta`, `paginationOffset`) — already produces `{ page, limit, total, hasNext }`. Do not write a second pagination helper.
- **Query parsing:** mirror `SecurityAlertsQuerySchema` in `apps/api/src/modules/org/schema.ts` (`z.coerce.number()` for `page`/`limit`, `.default(...)`, `.safeParse(req.query)` → `validationError(parsed.error, 'query')`).
- **SecureRoute:** copy the shape from `modules/org/routes.ts` and Story 2.2's credentials routes. Handler returns data; SecureRoute sends it and writes audit after, in the same tx. Audited handlers must NOT call `reply.send()` for the success path (the send-guard throws) — `return { data: ... }`.
- **JSONB containment for AND tags:** `sql\`${credentials.tags} @> ${JSON.stringify(tagList)}::jsonb\``.
- **ILIKE (escaped):** `ilike(credentials.name, like)` from `drizzle-orm`; escape `\`, `%`, `_` in the term before wrapping in `%...%`.
- **`currentVersionNumber`:** subquery `MAX(version_number) WHERE purged_at IS NULL` against `credential_versions`, selecting ONLY `version_number` — never `encrypted_value` (ADR-2.2-05).
- **Cross-org/missing → 404:** `.returning()` 0-row check on updates; explicit project existence check on the list; never 403 for cross-org (enumeration prevention).
- **Validation:** `validationError(parsed.error, 'query' | 'body' | 'params')` from `lib/route-helpers.ts`.

### Tech Stack (Repo Pinned)

| Tech | Version | Notes |
|---|---|---|
| Drizzle ORM | `0.45.x` | `ilike`, `and`, `or`, `eq`, `isNull`, `desc`, `sql`; JSONB `@>` via `sql` template. |
| zod | `zod/v4` | `import { z } from 'zod/v4'`; `.coerce` for query numerics; `.strict()` on query/body; `.meta({ id })` on exported schemas. |
| Fastify | `5.x` | `secureRoute()`; `@fastify/type-provider-zod` serializer (convert Date → ISO string). |
| PostgreSQL | 16+ | JSONB `@>` containment; `ILIKE`; `interval` arithmetic for `expiresWithin`. |
| tsx | `^4.22.x` | Runs `scripts/check-search-index.ts` (like `check-rls-coverage.ts`). |

### Architecture Compliance

- No bare `getDb()` in a SecureRoute handler — use the provided `tx`.
- `org_id`/`project_id` always from `auth`/URL, never the request body/query.
- RLS policies are unchanged (the `projects` policy already covers the new `tags` column).
- `encrypted_value`/`value` never indexed, never selected into a list/tag response, never logged — now enforced by `check-search-index.ts`.
- Forward-only migrations — revert via a new forward migration, never a hand-authored down.

### Anti-Patterns (Do Not)

- Do not add any `value`/`encrypted_value` column or index to `credentials` — values live only in `credential_versions` (2.2).
- Do not join `credential_versions` into the list query for anything but `MAX(version_number)` (and never select the value).
- Do not interpolate `q` into raw SQL — use Drizzle `ilike` with escaped LIKE metacharacters.
- Do not build the `expiresWithin` window by string concatenation or `sql.raw` — use `make_interval(days => ${expiresWithin})` as a bound parameter.
- Do not create indexes (or any DDL) at runtime via `db.execute('CREATE INDEX …')` — all schema/index changes go through migrations (enforced by `check-search-index.ts`).
- Do not leave `page`/offset unbounded — cap the offset (10,000) and return `422 page_out_of_range`.
- Do not let DB/query errors surface to the client — return a generic sanitized 500 with no SQL, input, or value.
- Do not invent cursor pagination or a second pagination helper — reuse `lib/pagination.ts`.
- Do not make `status=active` and `status=expiring` mutually exclusive — `active` is the non-expired superset by design.
- Do not silently truncate a tag union over 20 — return `422 too_many_tags`.
- Do not add a project-tags PATCH (epic specifies PUT only).
- Do not return 403 for cross-org access — return 404.
- Do not skip `writeAuditEvent` on the tag mutations.

---

## Previous Story Intelligence (Story 2.2)

- **`credentials.tags` already exists** as `jsonb not null default '[]'::jsonb` typed `$type<string[]>()` — 2.3 reads/writes it; do not recreate it.
- **No list/search endpoint exists** — 2.2 deliberately deferred it to 2.3. 2.2 shipped only create, value-reveal, add-version, version-history.
- **RS-E2a schema invariant** was introduced in 2.2 (no value column on `credentials`); 2.3 is where it becomes a CI-enforced lint rule.
- **`credential.*` audit vocabulary** was added to `AuditEventType` and the stale `secret.*` members removed in 2.2 (ADR-2.2-01). 2.3 only adds the two `*.tags_updated` names.
- **Current version = `MAX(version_number) WHERE purged_at IS NULL`** (ADR-2.2-05) — reuse for `currentVersionNumber`; always include the `purged_at IS NULL` filter.
- **Cross-org returns 404 not 403; `.strict()` mutation schemas; timestamp serialization (Date → ISO)** — all carry forward unchanged.
- **`secureRoute()` audits AFTER the handler in the same tx** — fail-closed; a failed audit rolls the mutation back to `503`.
- **Auth test harness:** `registerAndLoginViaApi` + `cookieHeader` in `apps/api/src/__tests__/helpers/auth-test-helpers.ts`; vault must be unsealed in the harness.

## Previous Story Intelligence (Story 2.1)

- **`projects` table exists** but has NO `tags` column — 2.3 adds it. The projects module (`modules/projects/routes.ts`) exists and is already in `ROUTE_FILES`.
- **ADR-2.1-06:** `GET /api/v1/projects` is intentionally unpaginated (recorded FR97 exception). This is NOT a precedent — the credential list in 2.3 IS the canonical paginated FR97 implementation.
- **`pagination.ts` lib exists** and the `SecurityAlertsQuerySchema` already demonstrates the `page`/`limit`/`hasNext` offset pattern.

---

## Git Intelligence Summary

Recent branch state (`feature/epic-1-retro`; Epic 1 is `done`, Epic 2 is `in-progress`):
- Stories 2.0, 2.1, 2.2 are `ready-for-dev` on the board. 2.1 (`projects` schema/module) and 2.2 (`credentials`/`credential_versions` schema/module, `credentials.tags`) are the direct prerequisites for 2.3 — coordinate so their migrations (`0013_projects`, `0014_credentials`) are journaled before this story's `0015_*` migration.
- The SecureRoute + RLS + route-audit foundations (Story 1.11) are merged and hardened.

Pattern observations (verified in the live tree):
- Route modules export `async function xRoutes(fastify: FastifyApp): Promise<void>`.
- Query schemas use `z.coerce.number()` for pagination params (`modules/org/schema.ts`).
- The `pagination.ts` helper already returns `{ page, limit, total, hasNext }` — exactly the epic's envelope.
- CI guard scripts live in `scripts/*.ts`, are wired as root `package.json` scripts, and use `process.exitCode = 1` + `process.stderr.write` (model `check-search-index.ts` on `check-rls-coverage.ts`).
- `ROUTE_ACTION_CLASSIFICATIONS` keys are `METHOD /url` strings; a `read` may carry `auditOmissionReason` (e.g. `GET /api/v1/auth/sessions`).

---

## Pre-mortem Failure Modes

| Failure mode | Why it happens | Prevention |
|---|---|---|
| Credential value leaks in the list response | Developer joins `credential_versions` or selects `*` | AC-3/AC-8: enumerate metadata columns only; never join for the value; AC-9 negative + sentinel-scan tests. |
| A value column gets indexed later (regression) | A future migration/PR adds `to_tsvector(value)` or a trigram index | `scripts/check-search-index.ts` fails CI (AC-2); positive-control test proves it catches the pattern. |
| `q` becomes a SQL injection / wildcard probe | Term interpolated into raw SQL, or LIKE metachars unescaped | AC-3/AC-8: Drizzle `ilike` parameterization + escape `\ % _`. |
| `active`/`expiring` treated as mutually exclusive | Developer ANDs `expires_at > now()` with `<= window` for `active` | AC-3 table: `active` = `expires_at IS NULL OR > now()` (superset); `expiring` = within window. Boundary test included. |
| Pagination drift / duplicate rows across pages | Non-deterministic ordering | AC-3: order by `created_at DESC, id DESC` (stable tiebreak); `total` from COUNT with the same WHERE. |
| `limit` unbounded (huge payload) | `limit` not clamped | Use `parsePagination` (clamps to 100) — do not parse `limit` ad hoc. |
| Tag union silently exceeds 20 | PATCH appends without post-merge bound check | AC-4: enforce ≤20 AFTER union; `422 too_many_tags`. Zod `.max(20)` only bounds the incoming array. |
| Lost tag under concurrent append | Two PATCH appends read the same base array; the second write clobbers the first | AC-4 + ADR-2.3-05: `SELECT … FOR UPDATE` on the parent credential serializes the read-modify-write; concurrent-append test asserts both tags survive. |
| `projects.tags` migration missing / RLS gap | Column added to schema but not migrated, or check-rls not run | Task 1: generate migration, run `check-rls` (projects policy already covers `tags`) + `migrate`. |
| route-audit fails | New routes missing from `ROUTE_ACTION_CLASSIFICATIONS`, or `read` GET with omission reason rejected | AC-7 lists all four + the `read`+`auditOmissionReason` precedent; run route-audit in isolation. |
| Tag mutation commits without audit | Audit write outside tx or swallowed | SecureRoute same-tx `writeAuditEvent`; AC-9 audit-failure-rollback test. |
| `check-search-index.ts` false-negative | Scanner misses a value-on-index pattern (e.g. multi-line SQL) | AC-2: normalize/join statements before matching; positive-control test asserts detection; prefer over-blocking. |
| Cross-org list returns another org's credentials | Missing RLS context or post-filtering | RLS-scoped `tx`; cross-org test asserts 404 for foreign project and isolation in the list. |
| `expiresWithin` interval injection | Dev builds the window with `sql.raw`/string concat | AC-3 + Anti-Patterns: parameterized `make_interval(days => ${n})`; Zod bounds 1–3650. |
| Deep-OFFSET scan DoS | `page` unbounded → huge OFFSET scan-and-discard | AC-3/AC-8: offset capped at 10,000 → `422 page_out_of_range`; test included. |
| Value-column index added at runtime | `db.execute('CREATE INDEX … (encrypted_value)')` bypasses a migrations-only scan | AC-2: scanner flags ANY `CREATE INDEX` outside `migrations/`; runtime-DDL positive-control test. |
| DB/query error leaks SQL or value | Unhandled error echoes input/DB text | AC-8: generic sanitized 500; test forces a query error and asserts no SQL/input/value in the body. |
| Sealed vault returns 500 not 503 on list | Handler reached while sealed | vault-guard returns 503 first; AC-9 sealed test for list + a tag route. |

---

## ADRs

### ADR-2.3-01: Substring `ILIKE` search in 2.3; trigram indexes deferred to Story 2.7
| | |
|---|---|
| **Context** | The epic requires case-insensitive substring search on `name`/`description`. PostgreSQL `ILIKE '%term%'` cannot use a B-tree index, but `pg_trgm` trigram indexes can. Story 2.7 adds trigram indexes for global search. |
| **Decision** | 2.3 uses `ILIKE` substring matching with no trigram index. Trigram indexes (on `name`/`description`/`tags` only) land in 2.7. |
| **Rationale** | At per-project scale, a sequential ILIKE scan is acceptable, and avoiding a `pg_trgm` extension dependency in 2.3 keeps the migration minimal. 2.7 introduces the extension + trigram indexes once cross-project search makes it worthwhile. Crucially, splitting it avoids prematurely creating indexes that a careless follow-up could extend onto a value column. |
| **Consequences** | Large per-project credential sets scan sequentially until 2.7's trigram indexes land. The `{ items, total, page, limit, hasNext }` shape is unchanged when indexes are added — non-breaking. |

### ADR-2.3-02: Tags are a JSONB string array with AND-containment, not a join table
| | |
|---|---|
| **Context** | Story 2.2 already shipped `credentials.tags jsonb`. The epic models tags as free-text strings with AND-filter semantics. |
| **Decision** | Tags stay a JSONB string array on `credentials.tags` and a new `projects.tags`; AND-filtering uses the JSONB `@>` containment operator. |
| **Rationale** | A relational `tags`/`credential_tags` table would contradict the shipped 2.2 schema, add joins, and complicate the no-value-leak guarantee. JSONB containment expresses "has all of these tags" directly and is index-able later (GIN on the tags column) without value exposure. |
| **Consequences** | Tag queries are containment scans (acceptable at scale); a future GIN index on `tags` (NOT on value) can optimize if needed. Tag matching is exact/case-sensitive. |

### ADR-2.3-03: RS-E2a enforced by a source-scanning CI lint rule, not only a code review convention
| | |
|---|---|
| **Context** | RS-E2a forbids indexing credential value columns. A convention alone is fragile across many future migrations (2.7, Epic 8, etc.). |
| **Decision** | Add `scripts/check-search-index.ts`, a static scanner over migrations + Drizzle schema that fails CI if a value column enters any index/full-text/trigram construct. Wire it as a root `package.json` script with a test. |
| **Rationale** | The mistake is source-level; catching it before a DB ever sees it is strictly better than a runtime/DB check. A conservative scanner (over-blocks substring `value`) fails safe. |
| **Consequences** | A non-value column whose name contains `value` may be over-blocked (fix by rename or explicit allow-list comment). The rule is reused/extended by Story 2.7. |

### ADR-2.3-04: Credential list is the canonical FR97 pagination; the project list (ADR-2.1-06) is the documented exception
| | |
|---|---|
| **Context** | FR97 mandates `page`/`limit` pagination on list endpoints. Story 2.1 shipped `GET /api/v1/projects` unpaginated as a recorded exception (ADR-2.1-06). |
| **Decision** | `GET /api/v1/projects/:projectId/credentials` is fully paginated (`page` default 1, `limit` default 20 max 100) using `lib/pagination.ts`, and is the reference implementation other list endpoints follow. |
| **Rationale** | Credential collections can grow large (unlike the bounded project list), so pagination is mandatory here. Reusing the existing helper guarantees a consistent envelope. |
| **Consequences** | Future list endpoints copy this shape; the project list remains the single bounded exception with its own revisit trigger. |

### ADR-2.3-05: Concurrent tag mutation uses a row lock (`SELECT … FOR UPDATE`), not optimistic read-modify-write
| | |
|---|---|
| **Context** | AC-4's `PATCH` append reads `credentials.tags`, computes a set-union in app code, then writes it back inside the SecureRoute `tx` (READ COMMITTED). Two concurrent `PATCH …/tags` for the same credential can both read the same base array and the second write silently clobbers the first — a lost update that makes a just-added tag disappear. |
| **Options** | (a) Optimistic / last-writer-wins — no locking. (b) `SELECT … FOR UPDATE` on the parent credential before the read-modify-write (mirrors Story 2.2 ADR-2.2-06's version-number serialization). (c) DB-native atomic JSONB merge in a single `UPDATE`. |
| **Decision** | **(b)** — `FOR UPDATE` on the credential row before computing the union for `PATCH` append; apply the same lock to `PUT` for uniformity. |
| **Rationale** | Append correctness ("a tag I added is never silently lost to a concurrent append") matters for metadata management, and the exact pattern already exists in the codebase (ADR-2.2-06). A pure-SQL JSONB merge avoids the round-trip but is harder to bound (the ≤20 post-union check) and to audit than explicit app logic. The lock is brief and tag mutations are rare, so contention is negligible. |
| **Consequences** | Each tag mutation briefly locks the parent credential row. A concurrent-append test (AC-9) asserts both racing appends survive. Without this, the AC-4 union is racy under concurrency. |

### ADR-2.3-06: `status` is derived on read (fixed 30-day badge window), never a denormalized column
| | |
|---|---|
| **Context** | The list item carries a `status` (`active`/`expiring`/`expired`) and the `status` filter selects on it. This could be stored or computed from `expires_at` at query time. |
| **Options** | (a) Compute on read from `expires_at` + a fixed 30-day window. (b) Denormalize a `status` column kept current by a job. |
| **Decision** | **(a)** — derive on read; no stored `status` column. The per-item badge uses a fixed 30-day window; the `expiring` filter honors the request's `expiresWithin`. |
| **Rationale** | A stored status drifts the instant wall-clock crosses `expires_at` unless a job constantly rewrites rows — pure overhead and a second source of truth (same reasoning as ADR-2.2-05's computed current-version). `expires_at` + `now()` is always exact and is index-assisted by `idx_credentials_project_expires`. |
| **Consequences** | Every list query evaluates the status expression (cheap, indexed). The badge window (30d) is intentionally decoupled from the filter window so the badge is stable across queries; the boundary is tested. |

### ADR-2.3-07: Pagination total via a separate `COUNT(*)`, not `count(*) OVER()`
| | |
|---|---|
| **Context** | `buildPaginationMeta` needs `total` (full match count) alongside the page slice. Two idioms exist: a second `COUNT(*)` with the same WHERE, or a window `count(*) OVER()` column on the page query. |
| **Options** | (a) Two queries: one `COUNT(*)`, one page `SELECT … LIMIT/OFFSET`. (b) One query with `count(*) OVER()` on each row. |
| **Decision** | **(a)** — two explicit queries sharing one composed WHERE clause. |
| **Rationale** | Two simple queries are clearer, keep the page projection clean (no count smearing onto every row — reinforcing the metadata-only guarantee), and are trivially correct with Drizzle. `count(*) OVER()` saves a round-trip but couples the count to the windowed result. At per-project scale the extra COUNT is negligible. Build the WHERE once and reuse it for both queries to avoid filter drift. |
| **Consequences** | One extra round-trip per list call. Switching to `count(*) OVER()` later is localized behind the same `{ items, total, … }` envelope. The shared-WHERE requirement is an explicit anti-drift guard. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.3-Credential-Search-Filter--Tag-Management`
- Epic 2 constraints (RS-E2a value-column protection, AC-E2a search blocker, FR97 pagination): `_bmad-output/planning-artifacts/epics.md#Epic-2`
- FR14, FR95, FR97: `_bmad-output/planning-artifacts/prd.md`
- Previous story (credentials/credential_versions schema, tags column, audit vocab, ADR-2.2-05 current-version): `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md`
- Previous story (projects schema/module, ADR-2.1-06 pagination exception): `_bmad-output/implementation-artifacts/2-1-project-creation-and-cross-project-dashboard.md`
- Pagination helper (reuse): `apps/api/src/lib/pagination.ts`
- Query schema + `z.coerce` precedent: `apps/api/src/modules/org/schema.ts` (`SecurityAlertsQuerySchema`)
- SecureRoute + audit writer: `apps/api/src/lib/secure-route.ts`
- Route audit classification + `ROUTE_FILES`: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- Audit event union: `packages/shared/src/constants/audit-events.ts`
- Actor-as-token (PJ6) + audit HMAC writer: `apps/api/src/modules/audit/{actor-token,write-entry,key-version}.ts`; PJ5/PJ6 constraints: `_bmad-output/planning-artifacts/epics.md#Epic-2`
- RLS coverage check (model for the lint rule): `scripts/check-rls-coverage.ts`, `packages/db/src/check-rls-coverage.ts`
- Schema conventions (`orgScoped`, JSONB `$type`): `packages/db/src/schema/helpers.ts`, `packages/db/src/schema/credentials.ts` (2.2), `projects.ts` (2.1)
- `validationError()` helper: `apps/api/src/lib/route-helpers.ts`
- Auth test helpers: `apps/api/src/__tests__/helpers/auth-test-helpers.ts`
- Repo TDD rule: `AGENTS.md`
- Key decisions to read first: **ADR-2.3-01** (ILIKE now, trigram in 2.7), **ADR-2.3-03** (CI lint rule enforces RS-E2a), and Story 2.2 **ADR-2.2-05** (current version = MAX non-purged).

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List
