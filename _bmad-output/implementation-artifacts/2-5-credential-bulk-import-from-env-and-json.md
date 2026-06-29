# Story 2.5: Credential Bulk Import from .env & JSON

Status: done

<!-- Ultimate context engine analysis completed 2026-06-28 - comprehensive developer guide for the two-step bulk import flow (parse/preview → confirm), the pending_imports table with 15-minute TTL, the .env and JSON file parsers, three conflict-resolution actions (new_version, skip, create_new), encrypted value staging, and the import:cleanup-expired pg-boss job. This story intentionally reuses the same encrypt() → credential_versions insert path that Story 2.2 established, and must never touch existing credential metadata (dependencies, rotationSchedule, notes, tags). Advanced elicitation pass (2026-06-28) applied 5 methods (Pre-mortem, Security Audit Personas, Self-Consistency Validation, Devil's Advocate, Failure Mode Analysis) — findings accepted: getPrimaryKey() called once before encryption loop; SELECT FOR UPDATE on confirm to prevent concurrent double-execution; suffix includes loop index to prevent same-ms collision; resolveAction() remaps new_version for non-conflicting items regardless of override vs default; duplicate-key deduplication added to env parser with last-occurrence-wins semantics; admin pool BYPASSRLS requirement clarified; cleanup job logs deleted importIds for audit correlation; non-conflicting race condition documented as residual risk. -->

## Story

As a developer migrating secrets from an existing setup,
I want to import credentials in bulk from `.env` files or JSON exports with explicit per-conflict resolution,
so that I can migrate my existing secrets without accidentally overwriting version history or rotation schedules.

*Covers: FR17.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.5-Credential-Bulk-Import-from-env--JSON`]

> **The critical invariant of this story (read first):**
> Every imported value goes through the **exact same `encrypt()` → `credential_versions` insert path** that Story 2.2 established for manual creates and add-version. There is NO bypass of the vault encryption, the audit invariants, or the `credential_versions` schema. Parsed values are encrypted at parse time and stored as ciphertext in `pending_imports`; on confirm they are transferred to `credential_versions.encrypted_value` without ever being decrypted — the plaintext never leaves the encryption boundary after the initial parse. The import flow is a delivery vehicle for the existing credential-version machinery, not a shortcut around it.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.2 (`credentials` + `credential_versions` tables, their migration, `packages/crypto` encrypt/withSecret, the `credential.created` + `credential.version_created` audit event vocabulary, `apps/api/src/modules/credentials/` module) merged and passing CI | This story adds routes to the **existing** credentials module, reuses the encrypt-and-insert path for both `create_new` and `new_version` actions, and imports the `credentials`/`credential_versions` Drizzle tables from `@project-vault/db/schema`. `pnpm --filter @project-vault/db migrate` must have run Story 2.2's migration first. |
| Story 2.3 (`CredentialSummarySchema` + credential list endpoint) merged | The list query is used to detect naming conflicts (credentials with the same `name` in the same project) during the preview step. No list-endpoint fields are changed by this story. |
| Story 2.4 (`credential_dependencies`, lifecycle PATCH, shared `validateRotationCron`) merged | The conflict-detection query must never touch `dependencies`, `rotationSchedule`, `expiresAt`, or `notes` — Story 2.4 owns those columns. Their existence in the schema must be visible for conflict detection but never mutated by import. |
| Story 1.11 `SecureRoute` framework + `route-audit.test.ts` CI gate merged | Both new routes (`POST …/import`, `POST …/import/confirm`) register via `secureRoute()` and must be classified in `ROUTE_ACTION_CLASSIFICATIONS`. |
| Story 1.5 vault init/unseal + `packages/crypto` merged | Parsed import values are immediately encrypted with `encrypt(plaintext, getPrimaryKey())` before any persistence. The vault must be unsealed; both routes are NOT on the `vault-guard` allowlist and return `503 { status: "sealed" }` while sealed. |
| Story 1.4 audit log foundation merged | `credential.bulk_import_initiated` and `credential.bulk_import_confirmed` audit events are written to `audit_log_entries` via SecureRoute. Per-credential `credential.created` / `credential.version_created` events are written for each created/versioned credential during confirm. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ As of today's branch, the highest migration is **`0013_projects.sql`** (Story 2.1). The Epic 2 chain lands: `0013_projects` (2.1) → `0014_credentials` (2.2) → `0015_credential_search_and_project_tags` (2.3) → `0016_credential_dependencies` (2.4) → **this story `0017_pending_imports.sql`**. Before generating, re-read `packages/db/src/migrations/` + `meta/_journal.json` and use the **next free number after whatever Stories 2.1–2.4 actually committed**. Every `0017_*` reference in this document is an illustrative placeholder. |
| `@fastify/multipart` added to `apps/api` | `POST …/import` accepts `multipart/form-data` with a file field. This package is NOT currently in `apps/api/package.json` and must be added (`pnpm --filter @project-vault/api add @fastify/multipart`). Register it in `apps/api/src/app.ts` before the route plugins. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.5 |
|---|---|
| 2.1 | Established `projects` table, `orgScoped()`, cross-org-returns-404, `.strict()` bodies, timestamp serialization, the admin/owner role pattern. 2.5 follows all conventions. |
| 2.2 | **Primary upstream.** Provides `credentials` + `credential_versions` tables, `packages/crypto` `encrypt()` / `withSecret()`, the `retentionCount` field (import respects the credential's existing value; new credentials created by import use the default of 3), the `rotation_locked_at` seam, and the `credential.created` / `credential.version_created` audit vocabulary. 2.5 reuses the same encrypt-and-version-insert logic — it does not re-implement it. |
| 2.3 | Provides the `credentials` list endpoint + `CredentialSummarySchema`. 2.5 uses a query against `credentials WHERE name = :importName AND project_id = :projectId` during conflict detection; the list endpoint itself is unchanged. |
| 2.4 | Provides the `credential_dependencies` table, `expiresAt`/`rotationSchedule` PATCH, and the `hasDependencies` flag. **Import NEVER modifies dependency records, `rotationSchedule`, `expiresAt`, `notes`, or `tags` on existing credentials** — only the credential *value* advances (via a new `credential_versions` row). 2.4 must be merged so `credentials.expires_at` / `credentials.rotation_schedule` columns exist when 2.5 reads the credential row for conflict detection. |
| 2.6 | Onboarding Wizard. Step 3 ("What's next?") links to the import flow built in this story. The import API built here is the target of that link. No data dependency in the other direction. |
| 5.x | Epic 5 rotation workflows read `credential_dependencies` and `rotation_schedule`. Import never creates dependency records or sets `rotation_schedule`, so Epic 5 is unaffected by import. |
| 8.x | The `credential.bulk_import_initiated` and `credential.bulk_import_confirmed` audit events, plus per-credential `credential.created` / `credential.version_created` events, are queryable once Epic 8's audit UI lands. They MUST be written to `audit_log_entries` from day one (PJ5). |

---

## Architecture Conflict Resolution (Read Before Coding)

The architecture document predates this story. Where they differ, the **epic + Story 2.2/2.3/2.4 conventions are authoritative**.

| Architecture / prior wording | Canonical implementation for 2.5 | Rationale |
|---|---|---|
| Architecture does not mention a bulk import flow | Two-step: parse/preview → confirm, with a `pending_imports` staging table and 15-minute TTL (epic spec). | The two-step flow prevents accidental overwrites and makes conflicts visible before any mutation occurs — aligns with the UX design principle "nothing committed until the user confirms". |
| Architecture does not mention `@fastify/multipart` | Add `@fastify/multipart` to `apps/api`. Register before route plugins in `app.ts`. Use `request.file()` to obtain the uploaded file stream with a 1 MB file-size limit. | The file upload for this endpoint requires multipart form handling; no alternative is available in the existing stack. |
| Architecture describes `withSecret()` for decrypt | Import values are encrypted with `encrypt()` at parse time and stored as ciphertext. On confirm, the ciphertext is inserted directly into `credential_versions.encrypted_value` — **no decrypt occurs in the import path**. | Plaintext values must not survive beyond the initial parse/encrypt. Transferring ciphertext directly avoids a decrypt-in-confirm round-trip and eliminates a window where plaintext would exist in memory during the confirm step. |
| Fine-grained permissions (NFR-SEC9) | Mapped to org roles, requiring `admin` or `owner` for both import routes (same as Story 2.2's reveal endpoint and Story 2.4's access list). | The import flow creates credentials and versions in bulk — it carries the highest blast radius of any credential mutation and must be gated at the same level as admin-only operations. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | New `pending_imports` table, org-scoped with RLS, in the next migration (e.g. `0017_pending_imports.sql`). Stores encrypted item array, file type, expiry timestamp. No `updated_at` (immutable after insert). |
| .env parser | Shared `packages/shared/src/utils/env-parser.ts` handles `KEY=value`, `KEY="quoted"`, `KEY='single'`, `export KEY=value`; `#` comments and blank lines skipped; lines without `=` produce a `{ line, reason: 'no_equals_sign', raw }` warning; inline `#` comments stripped. Returns `{ entries: ParsedEnvEntry[], warnings: ParseWarning[] }`. |
| JSON parser | Shared `packages/shared/src/utils/json-import-parser.ts` validates flat `{ "K": "V" }` object. Nested objects/arrays per key → `422`. Non-string values coerced to string (numbers, booleans). Returns same `{ entries, warnings }` shape. |
| Parse/preview | `POST …/credentials/import` (multipart `file` field, `admin`+) reads the file (≤1 MB, ≤500 entries), parses it, detects conflicts, encrypts values, stores in `pending_imports` (15-min TTL), returns `{ importId, expiresAt, parsed: [{ name, value: "[REDACTED]", conflictsWith?, suggestedAction }], warnings, itemCount }`. No credentials are created yet. |
| Confirm | `POST …/credentials/import/confirm` (JSON body `{ importId, defaultAction, overrides? }`, `admin`+) resolves each item's action, applies it in a single transaction, returns `{ imported, newVersions, skipped, results: [{ name, action, credentialId }] }`. `410` if import expired. |
| `new_version` action | Inserts a new `credential_versions` row on the existing credential (monotonic `versionNumber`, stored ciphertext transferred directly, `rotation_locked_at: null`). Does NOT touch `dependencies`, `rotationSchedule`, `expiresAt`, `notes`, or `tags`. Writes `credential.version_created` audit row per credential. |
| `skip` action | No-op for that item; counts toward `skipped`. No DB write. |
| `create_new` action | Creates a new `credentials` row + version 1 `credential_versions` row. If `conflictsWith` is non-null (name collision), appends `_imported_<unix_ms>_<n>` suffix (timestamp + loop index) to the name. If `conflictsWith` is null, uses the original name. Writes `credential.created` audit row per new credential. |
| Non-conflicting items | Items where `conflictsWith` is null: if the effective action is `new_version` or `create_new` → create a new credential with the original name. If the effective action is `skip` → skip. No suffix is ever added to non-conflicting items regardless of `defaultAction`. |
| Import TTL | `pending_imports` rows expire 15 minutes after creation. A pg-boss `import:cleanup-expired` job runs every 5 minutes and hard-deletes expired rows using the admin DB pool (bypasses RLS). Added to `DIRECT_DB_ACCESS_CLASSIFICATIONS`. |
| File size / count limits | File ≤ 1 MB (enforced by `@fastify/multipart` `limits.fileSize`); items ≤ 500 (post-parse count check) → `422 { code: "import_too_large", limit: 500 }`. |
| Route audit | Both routes registered in `ROUTE_ACTION_CLASSIFICATIONS` as `mutation` with named audit events. Per-credential audit rows written inside the confirm transaction. `route-audit.test.ts` passes. |
| Security | Values encrypted immediately at parse (never stored plaintext); ciphertext transferred on confirm without decrypt; `[REDACTED]` in preview response. Cross-org/cross-project → 404. Sealed vault → 503. Confirm on expired import → 410. `admin`/`owner` only; `member`/`viewer` → 403. `.strict()` bodies. |
| Tests | .env parser unit tests; JSON parser unit tests; POST /import: parse .env, parse JSON, conflict detection, file too large, too many entries, unsupported type, sealed 503, 403 viewer; POST /import/confirm: new_version (metadata preserved), skip, create_new (with/without suffix), mixed defaultAction + overrides, expiry 410, sealed 503, 403 viewer, audit rows, value-never-returned regression. |

---

### AC-1: Database Schema — `pending_imports` Table (NEW)

**Given** the Drizzle schema conventions in `packages/db/src/schema/` (established by Stories 1.4/2.1/2.2),
**When** Story 2.5 adds the import staging table,
**Then** create `packages/db/src/schema/pending-imports.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, timestamp, integer, jsonb, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

// Temporary staging table for two-step bulk import.
// Rows are inserted on parse/preview and hard-deleted by the cleanup job after expiresAt.
// The `items` JSONB array stores encrypted ciphertext — plaintext is NEVER stored here.
// No updated_at: this table is insert-only (no mutations after creation).
export const pendingImports = pgTable(
  'pending_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    fileType: text('file_type').notNull(),
    itemCount: integer('item_count').notNull(),
    // JSONB array of PendingImportItem objects (see type below).
    // Each item stores encrypted ciphertext — never plaintext.
    items: jsonb('items').notNull().$type<PendingImportItemRecord[]>(),
    // Parsed warnings from the file (e.g. lines without '=').
    warnings: jsonb('warnings').notNull().default(sql`'[]'::jsonb`).$type<ParseWarning[]>(),
    // Row expires 15 minutes after creation; cleanup job hard-deletes expired rows.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileTypeCheck: check(
      'pending_imports_file_type_check',
      sql`${t.fileType} IN ('env', 'json')`
    ),
    itemCountCheck: check(
      'pending_imports_item_count_check',
      sql`${t.itemCount} BETWEEN 0 AND 500`
    ),
  })
)

// TypeScript-side types (not exported from schema — used only for $type annotation).
type PendingImportItemRecord = {
  name: string              // trimmed credential name as parsed from the file
  encryptedValue: {
    version: number         // crypto key version from packages/crypto
    iv: string              // base64url-encoded IV
    ciphertext: string      // base64url-encoded AES-256-GCM ciphertext
    tag: string             // base64url-encoded auth tag
  }
  conflictsWith: string | null   // existing credentialId if name collision, else null
  suggestedAction: 'new_version' | 'skip' | 'create_new'
}

type ParseWarning = {
  line: number              // 1-based line number in the source file
  reason: 'no_equals_sign' | 'empty_value' | 'invalid_key' | 'duplicate_key'
  raw: string               // original line content (no value — safe to log)
}
```

**And** export it from `packages/db/src/schema/index.ts`:
```typescript
export * from './pending-imports.js'
```

**And** the `items` JSONB column stores ONLY encrypted ciphertext — the `encryptedValue` field is the direct output of `encrypt(plaintext, getPrimaryKey())` from `packages/crypto`. Plaintext is zeroed after encryption and never persisted. A regression test verifies that no raw credential value appears in any `pending_imports` row (same sentinel-scan pattern as Story 2.4 AC-11).

**And** there is NO `updated_at` column and NO `set_updated_at` trigger on this table — `pending_imports` rows are insert-only and never mutated after creation (the cleanup job deletes, never updates). Do NOT add the updated_at trigger to the migration.

**And** `orgScoped({ onDelete: 'cascade' })` denormalizes `org_id` so the uniform RLS policy applies (same rationale as Stories 2.1/2.2/2.4 — every table with org-scoped data carries an `org_id` column).

**And** `item_count` is a convenience column storing the parsed entry count (used for the `import_too_large` check at parse time). The `items` JSONB array length MUST match `item_count`.

**And** there is NO index on `expiresAt` beyond what RLS provides — the cleanup job deletes all expired rows with a single unscoped DELETE and runs infrequently enough that a sequential scan is acceptable. Do NOT add an index to `expiresAt` (the table stays small; expired rows are purged every 5 minutes).

---

### AC-2: Migration (next free number, e.g. `0017_pending_imports.sql`) — Schema, RLS Policy

> **Migration number is dynamic (R1).** Re-read `meta/_journal.json` immediately before `drizzle-kit generate`. The illustrative chain: `0013_projects` (2.1) → `0014_credentials` (2.2) → `0015_credential_search_and_project_tags` (2.3) → `0016_credential_dependencies` (2.4) → **this story `0017_pending_imports.sql`**. Substitute the real number.

**Given** the RLS coverage check (`packages/db/src/check-rls-coverage.ts`) fails CI if any `org_id` table lacks an `ALL` policy,
**When** Story 2.5 creates the migration,
**Then** create `packages/db/src/migrations/<next>_pending_imports.sql` that:

1. Creates the `pending_imports` table (emitted by `drizzle-kit generate`).
2. Enables RLS and adds the isolation policy in the **same migration file**.
3. Does **NOT** add a `set_updated_at` trigger — this table has no `updated_at` column.

Required policy block (must appear in the migration, immediately after the CREATE TABLE):
```sql
ALTER TABLE pending_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pending_imports_isolation
  ON pending_imports
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

**And** confirm `drizzle-kit generate` emitted both `CHECK` constraints (`pending_imports_file_type_check`, `pending_imports_item_count_check`); drizzle-kit does not always emit `check()` — grep the generated SQL and hand-add any missing constraint (same gotcha as Stories 2.2/2.4).

**And** after adding the migration: run `pnpm --filter @project-vault/db check-rls` (no gap — do NOT add `pending_imports` to `EXCLUDED_TABLES`), then `pnpm --filter @project-vault/db migrate` locally.

**And** the repo is **forward-only** (no down files). Revert via a new forward migration, never a hand-authored down.

---

### AC-3: Shared .env File Parser — `packages/shared/src/utils/env-parser.ts` (NEW)

**Given** `.env` files follow several common dialects,
**When** the import endpoint receives a `.env` file,
**Then** parse it with a custom parser (do NOT use the `dotenv` npm package — the custom parser keeps the dependency count low and implements exactly the rules the epic specifies):

**File:** `packages/shared/src/utils/env-parser.ts`

```typescript
export type ParsedEnvEntry = {
  name: string    // trimmed key (validated identifier)
  value: string   // decoded value (quotes stripped, inline comment stripped)
}

export type ParseWarning = {
  line: number
  reason: 'no_equals_sign' | 'empty_value' | 'invalid_key' | 'duplicate_key'
  raw: string
}

export type EnvParseResult = {
  entries: ParsedEnvEntry[]
  warnings: ParseWarning[]
}

/**
 * Parse a .env file string into entries and warnings.
 *
 * Supported formats (per AC-3):
 *   KEY=value
 *   KEY="double quoted value"   → quotes stripped
 *   KEY='single quoted value'   → quotes stripped
 *   export KEY=value            → 'export ' prefix stripped
 *   # full-line comment          → skipped
 *   blank line                   → skipped
 *   KEY=                        → empty value warning (still included with empty string)
 *   KEY=value # inline comment  → inline comment stripped (text after unquoted ' #')
 *   MISSING_EQUALS              → no_equals_sign warning; entry NOT included
 *
 * Key validation: must match /^[A-Za-z_][A-Za-z0-9_]*$/ after stripping 'export '.
 * Invalid key → invalid_key warning; entry NOT included.
 */
export function parseEnvFile(content: string): EnvParseResult {
  // Use a Map to deduplicate by key (last occurrence wins), preserving line-order for warnings.
  const entryMap = new Map<string, ParsedEnvEntry>()
  const warnings: ParseWarning[] = []

  // Handle both Unix (\n) and Windows (\r\n) line endings.
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const raw = lines[i]
    const trimmed = raw.trim()

    // Skip blank lines and full-line comments.
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // Strip 'export ' prefix (case-sensitive per spec).
    const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed

    // Must contain '='.
    const eqIdx = stripped.indexOf('=')
    if (eqIdx === -1) {
      warnings.push({ line: lineNum, reason: 'no_equals_sign', raw })
      continue
    }

    const name = stripped.slice(0, eqIdx).trim()
    const rawValue = stripped.slice(eqIdx + 1)

    // Validate key.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      warnings.push({ line: lineNum, reason: 'invalid_key', raw })
      continue
    }

    // Decode value.
    let value: string
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      // Quoted value — strip surrounding quotes; no inline comment inside quotes.
      value = rawValue.slice(1, -1)
    } else {
      // Unquoted value — strip inline comment (first ' #' with a preceding space).
      const commentIdx = rawValue.indexOf(' #')
      value = (commentIdx === -1 ? rawValue : rawValue.slice(0, commentIdx)).trim()
    }

    if (value === '') {
      warnings.push({ line: lineNum, reason: 'empty_value', raw })
      // Still include the entry with empty value — an empty secret is valid
      // (e.g. a disabled feature flag). The warning surfaces it for review.
    }

    // Duplicate-key deduplication: last occurrence wins.
    // If we've already seen this key, emit a duplicate_key warning on the previous line.
    if (entryMap.has(name)) {
      warnings.push({ line: lineNum, reason: 'duplicate_key', raw })
    }

    entryMap.set(name, { name, value })
  }

  return { entries: Array.from(entryMap.values()), warnings }
}
```

**And** edge-case behaviors (each covered by a unit test in `env-parser.test.ts`):

| Input | Expected behavior |
|---|---|
| `KEY=value` | `{ name: 'KEY', value: 'value' }` |
| `KEY="quoted value"` | `{ name: 'KEY', value: 'quoted value' }` |
| `KEY='single quoted'` | `{ name: 'KEY', value: 'single quoted' }` |
| `export KEY=value` | `{ name: 'KEY', value: 'value' }` |
| `# comment line` | Skipped; no entry, no warning |
| Blank line | Skipped; no entry, no warning |
| `MISSING_EQUALS` | Warning `no_equals_sign`; NOT included in entries |
| `KEY=` | Warning `empty_value`; included with `value: ''` |
| `KEY=value # inline comment` | Entry with `value: 'value'` (comment stripped) |
| `KEY="value with = inside"` | Entry with `value: 'value with = inside'` (quoted, contains `=`) |
| `KEY=a=b=c` (unquoted, multiple `=`) | Entry with `value: 'a=b=c'` (everything after first `=`, unquoted) |
| `1INVALID=value` | Warning `invalid_key`; NOT included |
| `KEY=value\r` (Windows CRLF) | Entry with `value: 'value'` (`\r` must be stripped at split time — use `content.split(/\r?\n/)` to handle CRLF) |
| `export  KEY=value` (double space after export) | Entry with `{ name: 'KEY', value: 'value' }` (`.trim()` after stripping 'export ') |
| Duplicate keys (`KEY=old` then `KEY=new` on later line) | **Last occurrence wins:** the entry for `KEY` uses the value from the last line that defines it; a `duplicate_key` informational warning is emitted for every overwritten occurrence. This prevents silent data loss when the same key appears twice in a file. |

**And** export from `packages/shared/src/index.ts`:
```typescript
export * from './utils/env-parser.js'
```

---

### AC-4: Shared JSON Import Parser — `packages/shared/src/utils/json-import-parser.ts` (NEW)

**Given** JSON imports must be flat `{ "KEY": "value" }` objects,
**When** the import endpoint receives a `.json` file,
**Then** validate and parse with:

**File:** `packages/shared/src/utils/json-import-parser.ts`

```typescript
export type JsonParseResult = {
  entries: ParsedEnvEntry[]   // same type as env-parser for consistency
  warnings: ParseWarning[]    // only 'empty_value' is possible here
}

/**
 * Parse a JSON import file.
 *
 * Valid format: { "KEY": "value", "OTHER": 123 }
 *   - Must be a top-level object (not array).
 *   - Keys must be non-empty strings.
 *   - Values must be strings, numbers, or booleans (coerced to string).
 *   - Nested objects or arrays as values → throws ImportValidationError (→ API returns 422).
 *   - null values → treated as empty string with empty_value warning.
 */
export class ImportValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ImportValidationError'
  }
}

export function parseJsonImportFile(content: string): JsonParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ImportValidationError('File is not valid JSON', 'invalid_json')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ImportValidationError(
      'JSON import must be a flat top-level object (e.g. { "KEY": "value" })',
      'invalid_json_structure'
    )
  }

  const entries: ParsedEnvEntry[] = []
  const warnings: ParseWarning[] = []
  const obj = parsed as Record<string, unknown>

  for (const [key, val] of Object.entries(obj)) {
    if (key === '') continue  // skip empty-string keys silently

    if (typeof val === 'object' && val !== null) {
      throw new ImportValidationError(
        `Key "${key}" has a nested object/array value — only flat string values are supported`,
        'nested_value'
      )
    }

    if (val === null) {
      warnings.push({ line: 0, reason: 'empty_value', raw: key })
      entries.push({ name: key, value: '' })
      continue
    }

    const value = String(val)   // coerce number/boolean to string
    if (value === '') {
      warnings.push({ line: 0, reason: 'empty_value', raw: key })
    }
    entries.push({ name: key, value })
  }

  return { entries, warnings }
}
```

**And** edge-case behaviors (covered by unit tests):

| Input | Expected behavior |
|---|---|
| `{ "KEY": "value" }` | `[{ name: 'KEY', value: 'value' }]` |
| `{ "PORT": 3000 }` | `[{ name: 'PORT', value: '3000' }]` (number coerced) |
| `{ "DEBUG": true }` | `[{ name: 'DEBUG', value: 'true' }]` (boolean coerced) |
| `{ "KEY": null }` | `[{ name: 'KEY', value: '' }]` + `empty_value` warning |
| `{ "KEY": { "nested": true } }` | Throws `ImportValidationError('nested_value')` → API returns `422 { code: "nested_value" }` |
| `[{ "KEY": "value" }]` (array at root) | Throws `ImportValidationError('invalid_json_structure')` |
| `"just a string"` (non-object root) | Throws `ImportValidationError('invalid_json_structure')` |
| `{not valid json` | Throws `ImportValidationError('invalid_json')` |
| `{}` (empty object) | Empty entries; no error; `itemCount: 0` |

**And** the `line` field in `ParseWarning` is `0` for JSON warnings (JSON objects are unordered and line numbers are meaningless — the `raw` field contains the key name for identification).

**And** export from `packages/shared/src/index.ts`:
```typescript
export * from './utils/json-import-parser.js'
```

---

### AC-5: `POST /api/v1/projects/:projectId/credentials/import` — Parse & Preview

**Given** a project exists, the caller has `admin` or `owner` role, and the vault is unsealed,
**When** they upload a `.env` or `.json` file via multipart/form-data,
**Then** parse the file, detect conflicts, encrypt the values, store a staging record, and return the import preview — **without creating any credentials**.

**Request (multipart/form-data):**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/import
Content-Type: multipart/form-data; boundary=--boundary--
Cookie: access-token=<jwt>

--boundary--
Content-Disposition: form-data; name="file"; filename="production.env"
Content-Type: text/plain

STRIPE_SECRET_KEY=sk_live_abcdef
DATABASE_URL=postgres://user:pass@host/db
API_KEY=secret123
--boundary----
```

**Successful response (`201 Created`):**
```json
{
  "data": {
    "importId": "00000000-0000-4000-8000-000000000200",
    "expiresAt": "2026-06-28T17:15:00.000Z",
    "itemCount": 3,
    "parsed": [
      {
        "name": "STRIPE_SECRET_KEY",
        "value": "[REDACTED]",
        "conflictsWith": "00000000-0000-4000-8000-000000000100",
        "conflictName": "STRIPE_SECRET_KEY",
        "suggestedAction": "new_version"
      },
      {
        "name": "DATABASE_URL",
        "value": "[REDACTED]",
        "conflictsWith": null,
        "conflictName": null,
        "suggestedAction": "create_new"
      },
      {
        "name": "API_KEY",
        "value": "[REDACTED]",
        "conflictsWith": null,
        "conflictName": null,
        "suggestedAction": "create_new"
      }
    ],
    "warnings": []
  }
}
```

**And** file type detection (determined by the uploaded filename extension, case-insensitive):
- Filename ends with `.env` → parse as `.env` format
- Filename ends with `.json` → parse as JSON format
- Any other extension (or no extension) → `422 { code: "unsupported_file_type", message: "Only .env and .json files are supported", supportedExtensions: [".env", ".json"] }`

**And** file size limit: **1 MB maximum**, enforced at the `@fastify/multipart` plugin level via `limits: { fileSize: 1_048_576 }` (1 MiB). A file exceeding this limit causes the stream to emit an error which the handler catches and returns `422 { code: "file_too_large", message: "Import file must be 1 MB or smaller", limitBytes: 1048576 }`.

**And** entry count limit: **500 credentials per file** maximum. After parsing, if `entries.length > 500`, return `422 { code: "import_too_large", message: "Import file contains too many credentials", limit: 500, found: <actual_count> }`. This is checked AFTER parsing, not on file size, so a dense JSON with 501 entries fails even if the file is under 1 MB.

**And** the conflict detection query (per entry, batched as a single IN query):
```typescript
// Batch check: find all credentials in this project whose names match any parsed entry name.
// Run as a single query to avoid N+1.
const entryNames = entries.map(e => e.name)
const conflicting = await tx
  .select({ id: credentials.id, name: credentials.name })
  .from(credentials)
  .where(and(
    eq(credentials.projectId, params.projectId),
    inArray(credentials.name, entryNames),
  ))
// Build a name→id lookup map.
const conflictMap = new Map(conflicting.map(c => [c.name, c.id]))
```

- An entry whose name matches an existing credential → `conflictsWith: existingCredentialId`, `conflictName: existingCredentialName`, `suggestedAction: "new_version"`.
- An entry with no name collision → `conflictsWith: null`, `conflictName: null`, `suggestedAction: "create_new"`.

**And** the suggested action for conflicting items is ALWAYS `"new_version"` (the safest default — preserve existing value history). The user may override this in the confirm step. There is no case where the suggested action is `"skip"` (the system should not imply the user should skip importing their own data).

**And** value encryption (immediately after parsing, before any other persistence):
```typescript
import { encrypt, getPrimaryKey } from '@project-vault/crypto'

// CRITICAL: Call getPrimaryKey() ONCE before the loop. Calling it per-item risks the vault
// sealing between iterations — item N encrypts fine, item N+1 throws a 503 — leaving a
// half-encrypted list that must never be partially persisted. A single getPrimaryKey() call
// before the loop guarantees either all items encrypt or none do (the single call throws and
// the vault-guard's 503 is returned before any DB write).
const keyMaterial = getPrimaryKey()  // throws if vault is sealed — handled by vault-guard

for (const entry of entries) {
  const encryptedValue = await encrypt(Buffer.from(entry.value, 'utf-8'), keyMaterial)
  // encryptedValue shape: { version: number, iv: string, ciphertext: string, tag: string }
  // entry.value is zeroed from memory at this point (use crypto-safe zeroing if available)
  items.push({
    name: entry.name,
    encryptedValue,
    conflictsWith: conflictMap.get(entry.name) ?? null,
    suggestedAction: conflictMap.has(entry.name) ? 'new_version' : 'create_new',
  })
}
```

**And** the `pending_imports` row is inserted with `expiresAt = new Date(Date.now() + 15 * 60 * 1000)` (15 minutes from now):
```typescript
const [importRecord] = await tx
  .insert(pendingImports)
  .values({
    orgId: auth.orgId,
    projectId: params.projectId,
    createdBy: auth.userId,
    fileType: detectedType,   // 'env' | 'json'
    itemCount: items.length,
    items,
    warnings: parseResult.warnings,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  })
  .returning({ id: pendingImports.id, expiresAt: pendingImports.expiresAt })
```

**And** the parse/preview step writes a `credential.bulk_import_initiated` audit event:
```typescript
// In the SecureRoute security config:
writeAuditEvent: {
  eventType: 'credential.bulk_import_initiated',
  resourceType: 'project',
  resourceIdFromParams: 'projectId',
}
// Stash import metadata for the audit payload (custom audit writer pattern from 2.1/2.2):
;(req as unknown as { auditResource?: { importId: string; itemCount: number; fileType: string } }).auditResource =
  { importId: importRecord.id, itemCount: items.length, fileType: detectedType }
```
- Audit payload: `{ importId, itemCount, fileType }`. **Never** any parsed credential name or value — the audit row proves an import was initiated but cannot be used to reconstruct the file.

**Security config:**
```typescript
security: {
  allowedRoles: ['owner', 'admin'],
  rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST …/credentials/import' },
  writeAuditEvent: { eventType: 'credential.bulk_import_initiated', resourceType: 'project', resourceIdFromParams: 'projectId' },
}
```

**And** the project must exist in the caller's org (else `404 { code: "project_not_found" }`). This is enforced by the RLS-scoped existence check on `credentials` during conflict detection — if `projectId` does not belong to the org, RLS returns zero rows (no enumeration). Additionally, explicitly check the project exists before parsing to avoid wasting parse time:
```typescript
const [project] = await tx
  .select({ id: projects.id })
  .from(projects)
  .where(eq(projects.id, params.projectId))
  .limit(1)
if (!project) return reply.status(404).send({ code: 'project_not_found', message: 'Project not found' })
```

**And** the multipart `file` field MUST be the only field; unknown form fields produce `422 { code: "unknown_field" }`. The `filename` attribute in the Content-Disposition header is used for type detection; if the filename is absent, return `422 { code: "missing_filename", message: "File must have a filename to determine its type" }`.

**And** the response value for each item is ALWAYS the literal string `"[REDACTED]"` — never the actual value, never the ciphertext, never any hint of the value length.

---

### AC-6: `POST /api/v1/projects/:projectId/credentials/import/confirm` — Apply Import

**Given** a valid (non-expired) `importId` exists and the caller has `admin` or `owner` role,
**When** they confirm the import with a `defaultAction` and optional per-name overrides,
**Then** resolve each item's action and apply it in a **single database transaction**, returning the outcome.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/import/confirm
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "importId": "00000000-0000-4000-8000-000000000200",
  "defaultAction": "new_version",
  "overrides": {
    "DATABASE_URL": "create_new",
    "OLD_UNUSED_KEY": "skip"
  }
}
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "imported": 2,
    "newVersions": 1,
    "skipped": 0,
    "results": [
      {
        "name": "STRIPE_SECRET_KEY",
        "action": "new_version",
        "credentialId": "00000000-0000-4000-8000-000000000100"
      },
      {
        "name": "DATABASE_URL",
        "action": "create_new",
        "credentialId": "00000000-0000-4000-8000-000000000300"
      },
      {
        "name": "API_KEY",
        "action": "create_new",
        "credentialId": "00000000-0000-4000-8000-000000000301"
      }
    ]
  }
}
```
(`imported` = created + newVersions; `skipped` = items with `action: 'skip'`)

**And** the import record must be loaded and locked first:
```typescript
// Verify importId exists, belongs to the caller's org+project, and is not expired.
// CRITICAL: Use FOR UPDATE to prevent two concurrent confirm requests from both loading
// the same pending_imports row and executing the full batch twice. Without this lock,
// a retry or duplicate tab submission creates 2× the intended credentials. The FOR UPDATE
// causes the second concurrent transaction to block until the first commits (and deletes
// the row), after which the second transaction finds zero rows and returns 404.
const [importRecord] = await tx
  .select()
  .from(pendingImports)
  .where(and(
    eq(pendingImports.id, body.importId),
    eq(pendingImports.projectId, params.projectId),
  ))
  .limit(1)
  .for('update')  // Drizzle: .for('update') appends FOR UPDATE; check drizzle-orm docs for exact API

if (!importRecord) {
  return reply.status(404).send({ code: 'import_not_found', message: 'Import not found' })
}

if (importRecord.expiresAt < new Date()) {
  return reply.status(410).send({
    code: 'import_expired',
    message: 'Import preview has expired. Please upload the file again.',
    expiredAt: importRecord.expiresAt.toISOString(),  // tells the client exactly when it expired
  })
}
```
- `importId` not found OR does not belong to the caller's org (RLS) / project → `404 { code: "import_not_found" }`.
- `importId` found but expired → **`410 Gone`** `{ code: "import_expired", expiredAt: "<ISO>" }`.
- The RLS policy scopes the query by org automatically; the `projectId` WHERE clause adds project scope.
- The `FOR UPDATE` row lock prevents concurrent confirm executions on the same import.

**And** action resolution per item (applied in order of the `items` array):

```typescript
function resolveAction(
  item: PendingImportItemRecord,
  defaultAction: ImportAction,
  overrides: Record<string, ImportAction> | undefined,
): ImportAction {
  // Per-name override takes precedence over defaultAction.
  const action = overrides?.[item.name] ?? defaultAction

  // CRITICAL: For non-conflicting items (conflictsWith === null), 'new_version' is always
  // remapped to 'create_new' — regardless of whether the action came from defaultAction or
  // an explicit override. There is no existing credential to version; the AC-7 confirm code
  // would crash on `item.conflictsWith!` if this remap were skipped for overrides.
  // 'skip' is honored as-is for non-conflicting items (explicitly omits the item).
  // 'create_new' is honored as-is.
  if (item.conflictsWith === null && action === 'new_version') return 'create_new'

  return action
}
```

**And** the confirm step applies ALL resolutions inside a **single database transaction**. If any individual insert/update fails with a database error (e.g. constraint violation, deadlock), the entire transaction rolls back and the caller receives `500 { code: "import_failed", message: "Import transaction failed. Your credentials were not modified." }`. The `pending_imports` row is NOT deleted on failure — the caller can retry.

**And** after successful commit, the `pending_imports` row is **hard-deleted** in a follow-up statement (outside the main tx to avoid holding the tx open longer than needed):
```typescript
// After the main tx commits successfully:
await db.delete(pendingImports).where(eq(pendingImports.id, body.importId))
```
(Use `db` without org context here — the row is already verified; the delete is by primary key.)

**And** the confirm step writes a single `credential.bulk_import_confirmed` audit event for the batch operation:
```typescript
;(req as unknown as { auditResource?: { importId: string; imported: number; newVersions: number; skipped: number } }).auditResource =
  { importId: body.importId, imported: importedCount, newVersions: newVersionCount, skipped: skippedCount }
```
- Audit payload: `{ importId, imported, newVersions, skipped }`. No credential names or values.

**And** per-credential audit events are written INSIDE the main transaction for each `create_new` and `new_version` action (same SecureRoute-pattern per-row audit as Story 2.2):
- `create_new` → `credential.created` with `resourceId = newCredentialId`
- `new_version` → `credential.version_created` with `resourceId = existingCredentialId`
- These per-credential events are in addition to the batch `credential.bulk_import_confirmed` event, ensuring the audit trail is complete per-credential regardless of Epic 8's query capabilities.

**Security config:**
```typescript
security: {
  allowedRoles: ['owner', 'admin'],
  rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST …/credentials/import/confirm' },
  writeAuditEvent: { eventType: 'credential.bulk_import_confirmed', resourceType: 'project', resourceIdFromParams: 'projectId' },
}
```

---

### AC-7: Conflict Resolution Action Semantics (Detailed Implementation Guide)

> This AC describes exactly HOW each action is implemented inside the confirm transaction. Read this alongside AC-6 before writing a single line of the confirm handler.

#### Action: `create_new` (for conflicting and non-conflicting items)

**For a non-conflicting item** (`item.conflictsWith === null`, resolved action = `create_new` or was `new_version` and remapped):
```typescript
// Determine name: no suffix for non-conflicting items.
const credentialName = item.name

// Insert credentials row (metadata only — default retentionCount, no tags, no expiry, no rotation).
const [newCred] = await tx
  .insert(credentials)
  .values({
    orgId: auth.orgId,
    projectId: params.projectId,
    name: credentialName,
    description: null,
    tags: [],
    expiresAt: null,
    rotationSchedule: null,
    retentionCount: 3,  // default; import never sets retention/expiry/schedule
    createdBy: auth.userId,
  })
  .returning({ id: credentials.id })

// Insert credential_versions row (version 1; ciphertext transferred directly — no decrypt).
await tx.insert(credentialVersions).values({
  orgId: auth.orgId,
  credentialId: newCred.id,
  versionNumber: 1,
  encryptedValue: JSON.stringify(item.encryptedValue),  // stored JSON of { version, iv, ciphertext, tag }
  createdBy: auth.userId,
  rotationLockedAt: null,
  purgedAt: null,
})

results.push({ name: item.name, action: 'create_new', credentialId: newCred.id })
importedCount++
```

**For a conflicting item** (`item.conflictsWith !== null`, resolved action = `create_new`):
```typescript
// Add suffix to avoid name collision.
// CRITICAL: Use `Date.now()` + a loop index counter to guarantee uniqueness within this
// single confirm call. Multiple conflicting items processed in rapid succession inside one
// transaction can all resolve Date.now() to the same millisecond. The counter disambiguates
// them, preventing a unique constraint violation that would roll back the entire batch.
const suffix = `_imported_${Date.now()}_${itemIndex}`  // itemIndex = loop counter (0-based)
const credentialName = `${item.name}${suffix}`
// ... same insert pattern as above with credentialName ...
```

**Critical: imports NEVER set `expiresAt`, `rotationSchedule`, `tags`, `description`, or `notes` on newly created credentials.** The user can set those fields after import using the existing endpoints (Story 2.2/2.3/2.4). The intent is to create a clean credential with only the value; all lifecycle and metadata is user-managed.

#### Action: `new_version` (conflicting items only)

```typescript
// item.conflictsWith is the existing credentialId.
const existingCredentialId = item.conflictsWith!

// Verify the existing credential still exists in this org+project
// (it could have been deleted between preview and confirm).
const [existingCred] = await tx
  .select({ id: credentials.id, retentionCount: credentials.retentionCount })
  .from(credentials)
  .where(and(
    eq(credentials.id, existingCredentialId),
    eq(credentials.projectId, params.projectId),
  ))
  .limit(1)

if (!existingCred) {
  // Credential was deleted between preview and confirm.
  // Treat as a non-conflicting create_new (safest fallback — don't fail the whole batch).
  // ... fall through to create_new logic with original name ...
}

// Get next versionNumber (monotonic; same pattern as Story 2.2 add-version).
const [{ maxVersion }] = await tx
  .select({ maxVersion: sql<number>`COALESCE(MAX(version_number), 0)` })
  .from(credentialVersions)
  .where(eq(credentialVersions.credentialId, existingCredentialId))

await tx.insert(credentialVersions).values({
  orgId: auth.orgId,
  credentialId: existingCredentialId,
  versionNumber: Number(maxVersion) + 1,
  encryptedValue: JSON.stringify(item.encryptedValue),  // ciphertext direct transfer
  createdBy: auth.userId,
  rotationLockedAt: null,
  purgedAt: null,
})

// CRITICAL: Do NOT touch credentials.expiresAt, credentials.rotationSchedule,
// credentials.description, credentials.tags, or credential_dependencies.
// ONLY the new credential_versions row is created. The credentials row itself
// is NOT updated (no updatedAt bump here — the add-version path in 2.2 does not
// update the credentials row either; updatedAt is bumped by the trigger on credentials
// UPDATE, but we do not UPDATE credentials here).
// CHECK: does the retentionCount apply immediately? Retention is enforced by the
// pg-boss retention job (Story 2.2), not inline on add-version. New version created;
// retention job will purge excess later. Do NOT inline-run retention here.

results.push({ name: item.name, action: 'new_version', credentialId: existingCredentialId })
newVersionCount++
```

**IMPORTANT cross-story compliance:**
- The `credentials.description`, `credentials.tags`, `credentials.expiresAt`, `credentials.rotationSchedule` columns are **not touched** — this story's import only adds a new value version (same as if the user had called `POST /credentials/:id/versions` manually).
- The `credential_dependencies` table is **not touched** — dependency records (Story 2.4) are not modified or created by import.
- If the existing credential has `rotation_locked_at` set on its current version (Epic 5 rotation in progress), that does NOT block adding a new import version — `rotation_locked_at` applies to individual version rows, not the whole credential. The new version inserted here has `rotation_locked_at: null`.

#### Action: `skip`

```typescript
// Absolutely nothing happens for this item.
results.push({ name: item.name, action: 'skip', credentialId: null })
skippedCount++
```

---

### AC-8: `import:cleanup-expired` pg-boss Cleanup Job

**Given** `pending_imports` rows accumulate and expire after 15 minutes,
**When** the pg-boss worker runs,
**Then** delete all expired rows on a fixed schedule every 5 minutes.

**Worker file:** `apps/api/src/workers/import-cleanup.ts`

```typescript
import type { PgBoss } from 'pg-boss'
import { getAdminDb } from '../lib/db.js'  // direct admin pool (no RLS context)
import { pendingImports } from '@project-vault/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger.js'

export const IMPORT_CLEANUP_JOB = 'import:cleanup-expired'
export const IMPORT_CLEANUP_CRON = '*/5 * * * *'  // every 5 minutes

export async function registerImportCleanupWorker(boss: PgBoss): Promise<void> {
  await boss.schedule(IMPORT_CLEANUP_JOB, IMPORT_CLEANUP_CRON, {})
  boss.work(IMPORT_CLEANUP_JOB, async () => {
    const db = getAdminDb()  // bypasses RLS — intentional for cross-org cleanup
    const result = await db
      .delete(pendingImports)
      .where(lt(pendingImports.expiresAt, new Date()))
      .returning({ id: pendingImports.id })

    // Log deleted importIds so operators can correlate bulk_import_initiated audit events
    // that never had a corresponding bulk_import_confirmed event (abandoned imports).
    logger.info(
      { deletedCount: result.length, deletedIds: result.map(r => r.id) },
      'import:cleanup-expired completed',
    )
  })
}
```

**And** the cleanup job uses the **admin DB pool** (bypasses RLS) because expired `pending_imports` rows from ALL orgs must be purged — not just the current RLS context org. The admin pool must connect as a PostgreSQL role that has the `BYPASSRLS` attribute (or is a superuser), otherwise the RLS policy `USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)` will resolve to `FALSE` for a session with no `app.current_org_id` GUC, returning zero rows and silently leaving expired rows to accumulate. Confirm the admin pool role has `BYPASSRLS` (check the existing retention worker in Story 2.2 — it uses the same pool for the same reason). Add to `DIRECT_DB_ACCESS_CLASSIFICATIONS`:

```typescript
'import:cleanup-expired': {
  reason: 'Cross-org cleanup of expired pending_imports rows; no credential values are read — only metadata rows are deleted.',
  reviewer: 'api-security-reviewer',
},
```

**And** register the worker in `apps/api/src/workers/index.ts` (or wherever other workers are registered):
```typescript
import { registerImportCleanupWorker } from './import-cleanup.js'
// ...in the register-all-workers function:
await registerImportCleanupWorker(boss)
```

**And** the cleanup job MUST:
- Only delete rows where `expires_at < NOW()` — never delete active rows.
- Use `returning()` to log the count of deleted rows (operational observability).
- Be idempotent — running twice in the same window is safe (second run finds no expired rows).
- NOT log any `items` JSONB content — only the deleted row count and (optionally) the deleted IDs.
- NOT fail the API startup if the worker registration fails — log an error and continue (same resilience pattern as Story 2.2's retention worker).

**And** add a unit test that verifies: (a) expired rows are deleted, (b) non-expired rows are preserved, (c) the job is safe to run multiple times.

---

### AC-9: Shared & API Zod Schemas

**Given** response shapes the web app consumes live in `@project-vault/shared` and request schemas live in the API module,
**When** Story 2.5 adds schemas,
**Then**:

**`packages/shared/src/schemas/imports.ts` (NEW — web-consumed shapes):**
```typescript
import { z } from 'zod/v4'

export const ImportActionSchema = z.enum(['new_version', 'skip', 'create_new'])

export const ParsedImportItemSchema = z.object({
  name: z.string(),
  value: z.literal('[REDACTED]'),
  conflictsWith: z.uuid().nullable(),
  conflictName: z.string().nullable(),
  suggestedAction: ImportActionSchema,
}).meta({ id: 'ParsedImportItem' })

export const ParseWarningSchema = z.object({
  line: z.number().int(),
  reason: z.enum(['no_equals_sign', 'empty_value', 'invalid_key', 'duplicate_key']),
  raw: z.string(),
}).meta({ id: 'ParseWarning' })

export const ImportPreviewResponseSchema = z.object({
  data: z.object({
    importId: z.uuid(),
    expiresAt: z.iso.datetime(),
    itemCount: z.number().int(),
    parsed: z.array(ParsedImportItemSchema),
    warnings: z.array(ParseWarningSchema),
  }),
}).meta({ id: 'ImportPreviewResponse' })

export const ImportResultItemSchema = z.object({
  name: z.string(),
  action: ImportActionSchema,
  credentialId: z.uuid().nullable(),
}).meta({ id: 'ImportResultItem' })

export const ImportConfirmResponseSchema = z.object({
  data: z.object({
    imported: z.number().int(),
    newVersions: z.number().int(),
    skipped: z.number().int(),
    results: z.array(ImportResultItemSchema),
  }),
}).meta({ id: 'ImportConfirmResponse' })

export type ImportAction = z.infer<typeof ImportActionSchema>
export type ParsedImportItem = z.infer<typeof ParsedImportItemSchema>
export type ImportResultItem = z.infer<typeof ImportResultItemSchema>
```
Add `export * from './schemas/imports.js'` to `packages/shared/src/index.ts`.

**`apps/api/src/modules/credentials/schema.ts` (EXTEND — Story 2.2/2.3/2.4 created this):**
```typescript
import { z } from 'zod/v4'
import { ImportActionSchema } from '@project-vault/shared'

// ─── Import route params ───────────────────────────────────────────────────
export const ImportParamsSchema = z.object({
  projectId: z.uuid(),
}).meta({ id: 'ImportParams' })

export const ImportConfirmParamsSchema = z.object({
  projectId: z.uuid(),
}).meta({ id: 'ImportConfirmParams' })

// ─── Import confirm body ───────────────────────────────────────────────────
export const ImportConfirmBodySchema = z.object({
  importId: z.uuid(),
  defaultAction: ImportActionSchema,
  overrides: z.record(z.string(), ImportActionSchema).optional(),
}).strict().meta({ id: 'ImportConfirmBody' })
```

**Schema notes:**
- The `POST /import` route does NOT use a Zod body schema — it is `multipart/form-data`. The file stream is accessed via `@fastify/multipart`'s `request.file()`. Do NOT attempt to define a `body` schema for this route in the Fastify route definition; instead, set `schema: { params: ImportParamsSchema, response: { 201: ImportPreviewResponseSchema, ... } }` without a `body` key.
- The `overrides` map is `Record<string, ImportAction>` — any import item name can be overridden. Names in `overrides` that do not match any parsed item are silently ignored (not an error — the client may send a pre-built set of overrides that includes stale names).
- Wire every response schema to the route's `schema.response`; convert Drizzle `Date` → ISO string before sending (timestamp serialization convention from Stories 2.1–2.4).

---

### AC-10: Route Registration, Audit Classification & Audit Event Constants

**Given** the route-audit CI gate (`route-audit.test.ts`) reads `ROUTE_FILES` + `ROUTE_ACTION_CLASSIFICATIONS`,
**When** Story 2.5 adds the new routes,
**Then**:

1. **Credentials module** (`apps/api/src/modules/credentials/routes.ts`, already in `ROUTE_FILES`): add the two new import routes. No `ROUTE_FILES` change needed.

2. URL pattern: both routes declare `:projectId` in their `url` (NOT in the plugin prefix) — same convention as 2.2/2.3/2.4:
   - `POST url: '/:projectId/credentials/import'`
   - `POST url: '/:projectId/credentials/import/confirm'`

3. Add both routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:
```typescript
'POST /api/v1/projects/:projectId/credentials/import': {
  action: 'mutation', auditEvent: 'credential.bulk_import_initiated',
},
'POST /api/v1/projects/:projectId/credentials/import/confirm': {
  action: 'mutation', auditEvent: 'credential.bulk_import_confirmed',
},
```

4. Add the two new audit event names to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`:
   - `'credential.bulk_import_initiated'`
   - `'credential.bulk_import_confirmed'`
   
   Keep the per-credential audit event names `'credential.created'` and `'credential.version_created'` that Story 2.2 already added — do NOT add duplicates.

5. After updating, run `route-audit.test.ts` in isolation and confirm both routes are classified. Run `pnpm typecheck` to confirm `AuditEventType` is exhaustive.

---

### AC-11: Security Hardening (Story-Specific Invariants)

**Given** the import flow handles credential values in bulk,
**When** Story 2.5 routes are implemented,
**Then** satisfy every invariant below:

| Threat | Required mitigation |
|---|---|
| Plaintext value exposure | Values are encrypted with `encrypt(plaintext, getPrimaryKey())` immediately after parsing. The plaintext buffer is zeroed after encryption. The `pending_imports.items` JSONB stores ONLY ciphertext. The preview response shows `"[REDACTED]"` for all values — never plaintext, never ciphertext, never a length hint. A sentinel-scan regression test verifies this (AC-12). |
| Ciphertext exposure in preview | The `parsed` array in the preview response contains `value: "[REDACTED]"` — the ciphertext itself is never returned. The `items` JSONB column is internal to `pending_imports` and never returned via any API. |
| Cross-org import | RLS scopes every `tx` by org; the `importId` lookup additionally verifies `projectId` matches the URL. Both "wrong org" and "missing importId" return `404 import_not_found` (no enumeration). |
| Cross-project import | The `pending_imports` row carries `project_id`; the confirm step verifies the importId belongs to `params.projectId`. A caller cannot confirm a different project's import even within the same org. |
| Mass assignment | All bodies `.strict()`; the multipart route only reads the `file` field and rejects unknown fields. `orgId`, `createdBy`, `expiresAt`, and `items` are NEVER accepted from the request. |
| Import replay after expiry | The confirm step checks `expiresAt < NOW()` before applying any action → `410 import_expired`. After successful confirm, the `pending_imports` row is hard-deleted, making replay impossible. |
| File upload DoS | `@fastify/multipart` `limits.fileSize: 1_048_576` (1 MiB) rejects oversized files before parsing. Rate limit: `max: 20` per minute per IP on both import routes. |
| Oversized batch flooding credentials | 500-entry cap enforced post-parse before encryption or DB writes. Returns `422 import_too_large`. |
| Credential metadata corruption | `new_version` inserts only into `credential_versions` — the `credentials` row is NOT updated. `create_new` inserts into both tables with minimal metadata only. Neither action touches `credential_dependencies`, `rotationSchedule`, `expiresAt`, `tags`, or `description` on existing credentials. A regression test verifies this (AC-12). |
| Concurrent confirm double-execution | Two concurrent `POST /import/confirm` requests for the same `importId` (duplicate tab, retry) could both load the non-expired row and both apply the full batch → 2× credentials created. Mitigation: `SELECT ... FOR UPDATE` on the `pending_imports` row inside the confirm transaction (AC-6). The second concurrent transaction blocks until the first commits and deletes the row, then finds zero rows and returns `404`. |
| Audit bypass | Both import routes fail-closed on audit via SecureRoute same-tx `writeAuditEvent`. Per-credential audit events are also written inside the confirm transaction. Audit-write failure rolls back the confirm transaction entirely → `503 audit_write_failed`. |
| Vault sealed | Both routes are NOT on the `vault-guard` allowlist → `503 { status: "sealed" }` while sealed. The `encrypt()` call also throws if sealed. Tests assert both routes return 503 while sealed. |
| Orphaned import rows | Rows expire after 15 minutes regardless of whether confirm is called. The cleanup job purges them. There is no "cancel import" endpoint — expiry is the cancellation mechanism. |
| Importing a credential whose name contains SQL-injectable characters | All DB writes use Drizzle's parameterized queries — no raw SQL interpolation. The `name` field is stored verbatim. A unit test with `' OR 1=1; --` as an entry name verifies it is stored without harm. |
| Import of a file containing a value that is the same as an existing credential's current value | No dedup check is performed — import creates a new version even if the value is unchanged (same behavior as manual add-version). This is intentional: the audit trail must show the import occurred. |
| Credential count explosion via create_new | A 500-entry import with `create_new` creates up to 500 new credentials. This is bounded by the 500-entry limit and the `admin/owner` role gate. No per-org credential count cap exists in v1 (Epic 9 territory). |

**Accepted residual risks (documented, not blocking):**
- **Non-conflicting item becomes conflicting between preview and confirm:** Between the preview step and the confirm step, another user in the same org may create a credential with the same name as a non-conflicting import item. On confirm, that item is processed as `create_new` (original name, no suffix) and creates a second credential with the same name in the same project. Unlike conflicting items (which are detected at preview and get a suffix on `create_new`), this race creates a true name duplicate with no suffix. This is intentional — the import was initiated when no conflict existed; the conflict arose during the user's review window. A future enhancement could re-validate conflicts at confirm time. Documented, not blocking.
- **Duplicate names via `create_new` with suffix:** if a credential named `KEY_imported_<ts>_<idx>` already exists (from a previous import), the suffix might still collide. The probability is negligible; a unique constraint violation would cause the whole transaction to roll back with a `500 import_failed` error. The user can retry.
- **Empty-value credentials:** the parser includes entries with empty values (with a warning). An empty-value credential is valid (same as manually creating a credential with an empty value). If this is undesirable, the user should skip those items.
- **`overrides` for names not in the import:** silently ignored. The client can send a pre-built overrides map with names that have since been removed from the file — no error.

---

### AC-11A: Operational Metrics & Logging

**Given** Story 1.10 established the structured operational logger conventions,
**When** Story 2.5 routes run,
**Then** emit these structured operational signals. **NEVER log credential values or ciphertext** — no value material leaves the encryption boundary via logs.

| Signal | Where | What to emit |
|---|---|---|
| `credential.import.parse_completed` | POST /import, after parsing (before encrypt) | `{ orgId, projectId, fileType, itemCount, warningCount, conflictCount }` |
| `credential.import.encrypted` | POST /import, after all values encrypted | `{ orgId, projectId, importId, itemCount }` — proves encryption happened |
| `credential.import.confirmed` | POST /import/confirm, after commit | `{ orgId, projectId, importId, imported, newVersions, skipped }` |
| `credential.import.expired_on_confirm` | POST /import/confirm, on 410 | `{ orgId, projectId, importId }` — lets operators see how often users let imports expire |
| `credential.import.cleanup_run` | import:cleanup-expired job | `{ deletedCount }` |
| `credential.import.audit_write_failed` | Either import route, on audit failure | `{ orgId, projectId, eventType, projectId }` — fail-closed signal |

**And** the parse log (`credential.import.parse_completed`) MUST NOT include any entry names or values — only counts. If entry names could reveal sensitive information (e.g. `AWS_SECRET_ACCESS_KEY`), they should not appear in operational logs.

---

### AC-12: Integration & Unit Tests

> Follow repo TDD red-green (`AGENTS.md`): write failing tests first, confirm the failure reason, implement the smallest change, then re-run. All DB/integration tests run with RLS active (`withTestOrg()`/`withOrg()`); never assert state from a bare `getDb()` query without org context. Reuse `registerAndLoginViaApi` + `cookieHeader` from `apps/api/src/__tests__/helpers/auth-test-helpers.ts`.

**Shared unit tests — `packages/shared/src/utils/env-parser.test.ts`:**
```
- KEY=value → { name: 'KEY', value: 'value' }
- KEY="quoted value" → quotes stripped
- KEY='single quoted' → quotes stripped
- export KEY=value → 'export ' stripped
- # comment line → skipped (no entry, no warning)
- blank line → skipped silently
- MISSING_EQUALS → no_equals_sign warning; NOT in entries
- KEY= → empty_value warning; included with value: ''
- KEY=value # inline comment → value is 'value' (comment stripped)
- KEY=a=b=c → value is 'a=b=c' (everything after first '=')
- 1INVALID=value → invalid_key warning; NOT in entries
- Windows CRLF line endings → handled correctly (value 'value' not 'value\r')
- export  KEY=value (double space) → name: 'KEY', value: 'value'
- KEY="contains # hash" → value: 'contains # hash' (inside quotes, no comment strip)
- KEY=value contains # hash (unquoted) → value: 'value contains' (inline comment stripped at ' #')
- Large file with 501 entries → all 501 returned (count limit is enforced at the API layer, not the parser)
```

**Shared unit tests — `packages/shared/src/utils/json-import-parser.test.ts`:**
```
- { "KEY": "value" } → { name: 'KEY', value: 'value' }
- { "PORT": 3000 } → value: '3000' (number coerced)
- { "DEBUG": true } → value: 'true' (boolean coerced)
- { "KEY": null } → value: '' + empty_value warning
- { "KEY": { "nested": true } } → throws ImportValidationError('nested_value')
- [{ "K": "v" }] → throws ImportValidationError('invalid_json_structure') (array at root)
- "just a string" → throws ImportValidationError('invalid_json_structure')
- {not valid json → throws ImportValidationError('invalid_json')
- {} → empty entries, no error
- { "K1": "v1", "K2": "v2", "K3": "v3" } → 3 entries in order
```

**DB-layer RLS test — `packages/db/src/__tests__/pending-imports-rls-isolation.test.ts`:**
```
- pending_imports rows are org-isolated (withOrg(orgA) cannot see orgB rows; bare getDb() returns zero)
- WRITE-isolation: within withOrg(orgA), an INSERT with org_id = orgB is rejected by RLS
- file_type CHECK rejects an out-of-set value (e.g. 'csv')
- item_count CHECK rejects values > 500 or < 0
- expiresAt < createdAt inserts are not rejected by DB (application layer enforces > now)
```

**API integration tests — `apps/api/src/modules/credentials/credential-import.test.ts`:**

```
POST …/credentials/import
─────────────────────────────────────────────────────────────────────────
.env file upload
  - 201 returns importId, expiresAt, parsed array with [REDACTED] values, warnings
  - 201 detects conflict correctly: item whose name matches existing credential gets
    conflictsWith = existingCredentialId, suggestedAction = 'new_version'
  - 201 non-conflicting item gets conflictsWith = null, suggestedAction = 'create_new'
  - 201 empty .env file (only blank lines and comments) → itemCount: 0, parsed: []
  - 201 warning item (line without '=') appears in warnings array with correct line number
  - 201 export KEY=value format → name: 'KEY' in parsed

JSON file upload
  - 201 flat JSON object → correct parsed items
  - 201 number value '3000' appears as '[REDACTED]' in preview (coercion happens at parse)
  - 422 nested JSON value → { code: 'nested_value' }
  - 422 JSON array at root → { code: 'invalid_json_structure' }

File validation
  - 422 unsupported extension (.csv, .txt, .yaml) → { code: 'unsupported_file_type' }
  - 422 file exceeds 1 MB → { code: 'file_too_large' }
  - 422 501 entries → { code: 'import_too_large', limit: 500, found: 501 }
  - 422 exactly 500 entries → 201 (boundary: 500 is allowed)
  - 422 missing filename → { code: 'missing_filename' }
  - 422 unknown form field (extra field in multipart) → { code: 'unknown_field' }

Security
  - 404 project not found in caller's org (not 403)
  - 401 unauthenticated
  - 403 member role; 403 viewer role; 200 admin; 200 owner
  - 503 vault sealed (both import routes return 503 while sealed)
  - Audit: credential.bulk_import_initiated row written with { importId, itemCount, fileType };
    NO credential names or values in audit payload
  - Value never returned: parsed[0].value === '[REDACTED]' for every item

POST …/credentials/import/confirm
─────────────────────────────────────────────────────────────────────────
new_version action
  - 200 creates a new credential_versions row on the existing credential
  - 200 existing credential retains its original name, description, tags,
    expiresAt, rotationSchedule (none modified — metadata preservation test)
  - 200 credential_dependencies rows for the existing credential are unaffected
  - 200 newVersionNumber = previousMax + 1 (monotonic)
  - 200 credential.version_created audit row written with resourceId = existingCredentialId
  - 200 result[i].action === 'new_version'; result[i].credentialId === existingCredentialId

skip action
  - 200 item is not created; no credential_versions row; skipped count incremented
  - 200 existing credential is completely unmodified (no new version, no metadata change)
  - 200 result[i].action === 'skip'; result[i].credentialId === null

create_new action (non-conflicting)
  - 200 creates a new credentials row with the original name (no suffix)
  - 200 creates version 1 in credential_versions
  - 200 new credential has: description: null, tags: [], expiresAt: null,
    rotationSchedule: null, retentionCount: 3
  - 200 credential.created audit row written with resourceId = newCredentialId
  - 200 result[i].action === 'create_new'; result[i].credentialId === (new id)

create_new action (conflicting item)
  - 200 creates a new credentials row with name = '<original>_imported_<unix_ms>_<n>' suffix (timestamp + loop index guarantees uniqueness within same transaction)
  - 200 suffix is NOT added to the original credential's name
  - 200 two credentials named 'KEY' and 'KEY_imported_<ts>_<n>' exist after import

Mixed defaultAction + overrides
  - defaultAction: 'new_version', override API_KEY: 'create_new'
    → STRIPE_SECRET_KEY gets new version; API_KEY gets new credential (create_new)
  - defaultAction: 'skip', overrides: { STRIPE_SECRET_KEY: 'new_version' }
    → only STRIPE_SECRET_KEY is processed; others are skipped
  - override for a name not in the import → silently ignored; no error

Non-conflicting items with defaultAction: 'new_version'
  - 200 non-conflicting items are created as new credentials (not skipped)
    (defaultAction 'new_version' remapped to 'create_new' for non-conflicting items)

Non-conflicting items with defaultAction: 'skip'
  - 200 non-conflicting items are skipped; imported: 0, skipped: N

Expiry
  - 410 import_expired when expiresAt has passed
  - 404 import_not_found when importId is random UUID
  - 404 import_not_found when importId belongs to a different project (cross-project guard)
  - 404 import_not_found when importId belongs to a different org (RLS)

Security
  - 403 member role; 403 viewer role
  - 503 vault sealed
  - After successful confirm: pending_imports row is hard-deleted
  - After failed confirm (simulated DB error): pending_imports row is preserved (retry possible)
  - Audit: credential.bulk_import_confirmed row with { importId, imported, newVersions, skipped };
    NO credential names or values
  - AUDIT-FAILURE ROLLBACK: forced audit-write failure during confirm rolls back all credential
    inserts; returns 503; no credentials or versions are created

Value-never-returned regression (sentinel scan)
  - Seed a credential with a known sentinel plaintext value via Story 2.2's create endpoint
  - Import a .env file that contains a KEY with the SAME sentinel value (new conflict)
  - Call preview → assert sentinel does NOT appear anywhere in the response body
  - Call confirm (new_version) → assert sentinel does NOT appear anywhere in the response body
  - Also assert that the credential.value_revealed endpoint (Story 2.2) does return the
    sentinel (sanity check: the value IS in the DB, just never leaked by import)

Metadata preservation regression
  - Create a credential with expiresAt, rotationSchedule, tags=['prod'], description='desc'
    and a dependency record (credential_dependencies)
  - Import a .env file containing that credential's name with a new value
  - Confirm with 'new_version'
  - Assert: credentials.expiresAt unchanged, credentials.rotationSchedule unchanged,
    credentials.tags unchanged, credentials.description unchanged,
    credential_dependencies count unchanged for that credential
```

**Cleanup job unit test — `apps/api/src/workers/import-cleanup.test.ts`:**
```
- Expired rows (expiresAt < now) are deleted
- Non-expired rows (expiresAt > now) are preserved
- Running job twice is idempotent (second run deletes 0 rows)
- Deletion count is logged
```

---

### AC-13: Explicit Out of Scope

Do NOT implement in Story 2.5:

- **Frontend / web UI for the import flow** — this story is backend only. Story 2.6 (onboarding wizard) will link to the import flow, but the import UI itself is a separate effort.
- **Per-import-item conflict dialogs** — AC-E2b explicitly restricts to batch default + per-name override mode. Per-conflict UI is v2.
- **Import from remote URLs (GitHub raw, S3, etc.)** — file upload only in v1.
- **CSV import** — only `.env` and `.json` formats are supported.
- **Partial-success semantics** — the confirm step is all-or-nothing (single transaction). Partial writes on DB error are not supported in v1; the caller retries the whole confirm.
- **Import progress streaming (SSE)** — the confirm response is synchronous. Streaming is a future enhancement for large imports.
- **Unconfirmed import cancellation** — there is no explicit DELETE /import endpoint; imports expire automatically after 15 minutes.
- **Per-credential tag, description, expiresAt, or rotationSchedule in the import file** — the file format carries only `KEY=value` pairs. Lifecycle metadata must be set post-import via the existing endpoints (Stories 2.2/2.3/2.4).
- **Dependency recording during import** — importing a `.env` file does not populate `credential_dependencies`. Dependency recording is always manual (Story 2.4).
- **Import from secrets managers (AWS Secrets Manager, HashiCorp Vault, etc.)** — v1 supports only file-based import.
- **Import with custom conflict resolution per item in the preview response** — the preview returns a `suggestedAction` but conflict resolution is batch-first (default) + per-name override (not UI dialog per item in v1).
- **`retentionCount` or `rotationSchedule` fields in the import file format** — credentials created by import use system defaults (retentionCount: 3, no schedule).

---

## Tasks / Subtasks

- [x] **Task 1: `pending_imports` schema + migration** (AC: 1, 2)
  - [x] Create `packages/db/src/schema/pending-imports.ts` (JSONB items, file_type CHECK, item_count CHECK, no updated_at).
  - [x] Export from `packages/db/src/schema/index.ts`.
  - [x] `pnpm --filter @project-vault/db generate`; confirm next free number against `meta/_journal.json` (e.g. `0017_pending_imports.sql`); confirm both CHECK constraints emitted (hand-add if drizzle-kit omits).
  - [x] Add the RLS policy to the migration (no set_updated_at trigger — intentional).
  - [x] `pnpm --filter @project-vault/db check-rls` (no gap; do NOT exclude the table) + `migrate`.
- [x] **Task 2: DB-layer RLS isolation test** (AC: 12) — write `pending-imports-rls-isolation.test.ts`; confirm it fails before schema exists, passes after.
- [x] **Task 3: Shared parsers + schemas** (AC: 3, 4, 9)
  - [x] Create `packages/shared/src/utils/env-parser.ts` + `env-parser.test.ts` (red first).
  - [x] Create `packages/shared/src/utils/json-import-parser.ts` + `json-import-parser.test.ts` (red first).
  - [x] Create `packages/shared/src/schemas/imports.ts` with response schemas.
  - [x] Export all from `packages/shared/src/index.ts`.
  - [x] `pnpm --filter @project-vault/shared test`.
- [x] **Task 4: Add `@fastify/multipart` to API** (AC: 5)
  - [x] `pnpm --filter @project-vault/api add @fastify/multipart`
  - [x] Register in `apps/api/src/app.ts` with `limits: { fileSize: 1_048_576 }`.
  - [x] Add `@types/node` is already present; no additional type packages needed.
- [x] **Task 5: API schemas for import routes** (AC: 9)
  - [x] Extend `apps/api/src/modules/credentials/schema.ts` with `ImportParamsSchema`, `ImportConfirmBodySchema`.
  - [x] Unit-test `.strict()` rejection, importId UUID validation, overrides map validation.
- [x] **Task 6: POST /import parse & preview route** (AC: 5, 10, 11) — failing test first
  - [x] Multipart file extraction with `request.file()`.
  - [x] File type detection from filename extension.
  - [x] File size limit enforcement (catch multipart fileSize error).
  - [x] Parse file using the appropriate shared parser (env or JSON).
  - [x] 500-entry count check → `422 import_too_large`.
  - [x] Project existence check → `404 project_not_found`.
  - [x] Batch conflict detection (single IN query against credentials).
  - [x] Value encryption via `encrypt(plaintext, getPrimaryKey())`.
  - [x] Insert `pending_imports` row.
  - [x] Return preview with `[REDACTED]` values.
  - [x] Custom audit writer stashing `{ importId, itemCount, fileType }`.
- [x] **Task 7: POST /import/confirm route** (AC: 6, 7, 10, 11) — failing test first
  - [x] Load + validate import record (existence + expiry check → 404/410).
  - [x] Action resolution per item (defaultAction + overrides, non-conflicting remapping).
  - [x] Single-transaction application of all actions (new_version, create_new, skip).
  - [x] `new_version`: monotonic versionNumber via MAX + 1; ciphertext direct transfer; metadata preservation (no credentials row update).
  - [x] `create_new` (conflicting): suffix `_imported_<unix_ms>_<n>` (timestamp + 0-based loop index, e.g. `Date.now() + '_' + itemIndex`).
  - [x] `create_new` (non-conflicting): original name, no suffix.
  - [x] Per-credential audit events inside transaction.
  - [x] Hard-delete `pending_imports` after commit.
  - [x] Return results summary.
- [x] **Task 8: `import:cleanup-expired` pg-boss job** (AC: 8, 10) — failing test first
  - [x] Create `apps/api/src/workers/import-cleanup.ts`.
  - [x] Register in `workers/index.ts`.
  - [x] Add to `DIRECT_DB_ACCESS_CLASSIFICATIONS`.
  - [x] Unit test: expired rows deleted, non-expired preserved, idempotent.
- [x] **Task 9: Route registration + audit constants** (AC: 10)
  - [x] Register both routes in `routes.ts`; confirm both are in `ROUTE_FILES`.
  - [x] Add `credential.bulk_import_initiated` and `credential.bulk_import_confirmed` to `AuditEventType`.
  - [x] Classify both in `ROUTE_ACTION_CLASSIFICATIONS`.
  - [x] Run `route-audit.test.ts` in isolation — both routes must appear.
- [x] **Task 10: Security regression + sentinel-scan + metadata preservation** (AC: 11, 12)
  - [x] Sentinel-scan test: import a file with a known plaintext value; assert it never appears in preview or confirm response.
  - [x] Metadata-preservation test: confirm existing credential's expiresAt/rotationSchedule/tags/dependencies are unchanged after new_version import.
  - [x] Audit-failure rollback test: force audit write failure during confirm; assert no credentials or versions created.
- [x] **Task 11: Final verification** (AC: all)
  - [x] `pnpm --filter @project-vault/db test` + `check-rls`.
  - [x] `pnpm --filter @project-vault/api test` (integration + route-audit).
  - [x] `pnpm --filter @project-vault/shared test`.
  - [x] `pnpm check-search-index` (still clean — import never indexes values).
  - [x] `pnpm typecheck` + `pnpm lint` at repo root.

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Credentials module | `apps/api/src/modules/credentials/` (created by 2.2). Add both import routes to `routes.ts`; add request schemas to `schema.ts`; extract an `import-service.ts` for the confirm logic (it will be ~120+ lines — do NOT inline in the handler). The service must accept `tx: Tx` and use it exclusively — never `getDb()` inside a handler-invoked helper. |
| New DB schema file | `packages/db/src/schema/pending-imports.ts` — exported from `schema/index.ts`. |
| Migration | `packages/db/src/migrations/<next>_pending_imports.sql` — verify number against `meta/_journal.json`; never hardcode. |
| Shared parsers + schemas | `packages/shared/src/utils/env-parser.ts`, `packages/shared/src/utils/json-import-parser.ts`, `packages/shared/src/schemas/imports.ts`. |
| pg-boss cleanup job | `apps/api/src/workers/import-cleanup.ts` — registered in `workers/index.ts`. |
| Multipart registration | `await app.register(import('@fastify/multipart'), { limits: { fileSize: 1_048_576 } })` in `apps/api/src/app.ts` BEFORE any route plugin registration. |

### Key Code Patterns to Follow

- **SecureRoute:** copy the shape from `apps/api/src/modules/org/routes.ts` and 2.2/2.3/2.4's credentials routes. Use `allowedRoles: ['owner','admin']` (matches Story 2.4's access list gate).
- **Custom audit writer (capture new id / importId):** stash on `req` after the import record is created; read in the SecureRoute writer — exact pattern in Story 2.1 AC-4 / 2.2 AC-4. Note: for `POST /import`, the importId is the resource id; for `POST /import/confirm`, the importId comes from the body, not a URL param — use the custom writer to stash it.
- **Cross-org/missing → 404:** explicit project existence check + RLS for all DB reads. "Wrong org" and "missing" both return `404`.
- **Ciphertext direct transfer:** the `encryptedValue` from `pending_imports.items[i].encryptedValue` goes directly into `credential_versions.encrypted_value` as a JSON string — `JSON.stringify(item.encryptedValue)`. Never call `withSecret()` or `decrypt()` in the import path; there is no decrypt.
- **Multipart file reading:** `const file = await request.file()` (single file upload). Check `file?.fieldname === 'file'` and reject other fieldnames. The filename is at `file.filename`. Buffer the entire file: `const buf = await file.toBuffer()` then `const content = buf.toString('utf-8')`.
- **MAX + 1 for versionNumber:** same pattern as Story 2.2 add-version.
- **Timestamp serialization:** convert Drizzle `Date` → ISO string before sending (all response schemas use `z.iso.datetime()`).
- **Validation helper:** `validationError(parsed.error, 'body' | 'query' | 'params')` from `apps/api/src/lib/route-helpers.ts`.

### Tech Stack (Repo Pinned)

| Tech | Version | Notes |
|---|---|---|
| Drizzle ORM | `0.45.x` | `pgTable`, `uuid`, `text`, `timestamp`, `integer`, `jsonb`, `check`; `and`, `eq`, `inArray`, `lt`, `sql`. |
| zod | `zod/v4` | `import { z } from 'zod/v4'`; `.strict()` bodies; `.meta({ id })` on exported schemas. |
| Fastify | `5.8.5` | `secureRoute()`; `@fastify/type-provider-zod`. |
| `@fastify/multipart` | Latest (to be installed) | File upload handling; `limits.fileSize: 1_048_576`. |
| PostgreSQL | 16+ | `IN` for batch conflict detection; RLS; JSONB. |
| pg-boss | `12.23.0` | Cleanup job (`import:cleanup-expired`, `*/5 * * * *` cron). |
| `packages/crypto` | workspace | `encrypt()` + `getPrimaryKey()` for parse-time encryption; `withSecret()` is NOT used in this story (no decrypt path). |

### Architecture Compliance

- No bare `getDb()` in a SecureRoute handler — use the provided `tx`.
- `org_id`/`project_id` always from `auth`/URL, never the request body.
- RLS policy lives in the migration SQL, not application code; do NOT exclude `pending_imports` from the RLS coverage check.
- This story never decrypts any credential value — `withSecret()` is NOT called in the import flow. Values go from plaintext (file) → encrypted (memory) → stored ciphertext (pending_imports) → transferred ciphertext (credential_versions) with no intermediate decrypt.
- Forward-only migrations — revert via a new forward migration, never a hand-authored down.
- The `import:cleanup-expired` job uses the **admin** DB pool (bypass RLS); this is intentional and documented in `DIRECT_DB_ACCESS_CLASSIFICATIONS`.

### Anti-Patterns (Do Not)

- Do NOT return the actual value (even encrypted) in the preview response — always `"[REDACTED]"`.
- Do NOT decrypt the ciphertext on confirm — transfer it directly to `credential_versions`.
- Do NOT touch `credential.expiresAt`, `credential.rotationSchedule`, `credential.tags`, `credential.description`, or `credential_dependencies` on existing credentials during `new_version` action.
- Do NOT add a suffix to non-conflicting items in `create_new` — suffix is only for name-collision avoidance.
- Do NOT fail the whole confirm if one item's existing credential was deleted since preview — fallback gracefully (create a new credential instead of `new_version`).
- Do NOT run the credential retention job inline during confirm — retention is managed by the pg-boss retention worker (Story 2.2), not inline.
- Do NOT use `zod` to parse the multipart form body — `@fastify/multipart` handles the stream; Zod validates only URL params and the JSON confirm body.
- Do NOT hardcode the migration number — confirm against `meta/_journal.json`.
- Do NOT skip `writeAuditEvent` on either import route.
- Do NOT add `pending_imports` to `EXCLUDED_TABLES` in the RLS coverage check.
- Do NOT call `getPrimaryKey()` inside the per-item encryption loop — call it ONCE before the loop. A vault seal between items causes a mid-loop throw that produces a confusing error surface and implies partial work occurred.
- Do NOT allow two concurrent confirms on the same importId — `SELECT ... FOR UPDATE` is mandatory on the `pending_imports` row (AC-6).
- Do NOT forget the loop index in the conflicting `create_new` suffix — `Date.now()` alone is not unique within a single transaction's duration.
- Do NOT remap `new_version` override only for `defaultAction` — `resolveAction()` must remap it regardless of whether the action came from the default or an explicit per-name override.

---

## Previous Story Intelligence

### Story 2.2 (credentials schema + encryption + versioning)
- `credentials` + `credential_versions` tables already exist. Their Drizzle schema is the canonical shape for both `create_new` and `new_version` actions.
- `encrypt()` from `packages/crypto`: call signature is `encrypt(plaintext: Buffer, keyMaterial: Buffer): Promise<{ version: number; iv: string; ciphertext: string; tag: string }>`. The result is what gets stored in `credential_versions.encrypted_value` (as a JSON string).
- `getPrimaryKey()`: returns the current primary key material. Throws if vault is sealed.
- The add-version path (monotonic `MAX(version_number) + 1`, no dedup, `rotation_locked_at: null` for import-created versions) is the canonical pattern for creating new versions — 2.5 replicates this inside the import transaction.
- Custom audit writer pattern (stash on `req` after insert) established in 2.2 AC-4 — reuse for import.
- `CRON_REGEX` / `validateRotationCron` from Story 2.4: NOT relevant to this story (import never sets `rotationSchedule`).
- Cross-org returns 404 not 403; `.strict()` bodies; timestamp serialization (Date → ISO); fail-closed same-tx audit — all carry forward.

### Story 2.3 (credential list + search)
- `credentials.name` is the field used for conflict detection (exact match within project).
- The existing `credentials WHERE name IN (...)` query is the basis for conflict detection batch check.
- `ROUTE_ACTION_CLASSIFICATIONS` accepts a `mutation` POST with an audit event — this is the pattern for both import routes.

### Story 2.4 (dependency recording + lifecycle PATCH)
- `credentials.expires_at`, `credentials.rotation_schedule`, `credentials.tags` columns must NOT be touched by the `new_version` import action.
- `credential_dependencies` table must NOT be touched by any import action.
- The `allowedRoles: ['owner','admin']` pattern for the access-list gate applies here too (both import routes use the same elevated gate).

### Story 2.1 (projects + `orgScoped`)
- `orgScoped({ onDelete: 'cascade' })` is the exact call for any new org-scoped table.
- `withTestOrg()` / `withOrg()` for RLS-active integration tests.
- Admin/owner gating: `allowedRoles: ['owner', 'admin']` — same as the access list gate in 2.4.

---

## Git Intelligence Summary

Branch state (Epic 1 `done`, Epic 2 `in-progress`): Stories 2.0 `done`; 2.1 `in-progress`; 2.2/2.3/2.4 `ready-for-dev`. Migration chain tip is `0013_projects.sql` (Story 2.1). Stories 2.2–2.4 will create `0014`, `0015`, `0016` before this story runs — verify the actual next number in `meta/_journal.json` before generating.

Pattern observations (verified in the live tree via Story 2.4 Git Intelligence):
- Route modules export `async function xRoutes(fastify: FastifyApp): Promise<void>`; `org/routes.ts` shows `secureRoute()` + `allowedRoles` + `validationError()` shape.
- DB schema files use `orgScoped()` + a `(t) => ({ ...indexes, ...checks })` block.
- `packages/crypto` provides `encrypt()` / `withSecret()` / `getPrimaryKey()` — these are already imported in `credentials` routes (2.2); import the same exports.
- The API `package.json` does NOT have `@fastify/multipart` — this is a NEW required dependency.
- CI guard scripts (`check-rls`, `check-search-index`) live in `scripts/*.ts`; 2.5 adds no new guard but must keep both passing.
- pg-boss workers in `apps/api/src/workers/` — add `import-cleanup.ts` following the existing worker file pattern.

---

## Pre-mortem Failure Modes

| Failure mode | Why it happens | Prevention |
|---|---|---|
| Plaintext value persisted or logged | `entry.value` passed to logger, included in audit payload, or stored in JSONB before encrypt() | Encrypt immediately after parse; zero the plaintext buffer; log only counts, never names/values; sentinel-scan regression test. |
| Preview response leaks ciphertext | `encryptedValue` object returned instead of "[REDACTED]" | Preview response schema: `value: z.literal('[REDACTED]')`; integration test asserts sentinel not in preview body. |
| Confirm decrypts the value | Developer calls `withSecret()` or `decrypt()` in confirm | AC-7 specifies "ciphertext direct transfer"; code review + sentinel-scan test (if value appears in memory during confirm, it may leak in an error log). |
| Metadata corrupted on existing credential | `credentials` row updated (expiresAt, tags, etc.) during `new_version` | AC-7 and anti-patterns explicitly prohibit it; metadata-preservation regression test verifies. |
| Transaction rollback leaves partial state | Handler applies actions in multiple separate transactions | AC-6: single transaction for all confirm actions; the handler is structured with one `tx` block. |
| `pending_imports` row not deleted after confirm | `delete` skipped on error path or test double | AC-6: delete in follow-up after commit; test that row is absent after successful confirm. |
| Expired import not caught → wrong 404 | `expiresAt` check absent or uses wrong comparison | AC-6: `importRecord.expiresAt < new Date()` → `410`; test: manually set expiresAt to past. |
| Cross-project confirm | Caller confirms a different project's import | AC-6: WHERE clause includes `projectId`; RLS covers org scope; test: confirm with wrong projectId → 404. |
| File over 1 MB bypasses limit | `@fastify/multipart` not registered or limit wrong | Task 4: register before routes with `limits.fileSize: 1_048_576`; test: upload 1.1 MB file → 422 file_too_large. |
| 501 entries slip through count check | Check done before parse, not after | AC-5: count check on `entries.length` after parsing; test: 501-entry file → 422 import_too_large. |
| Unsupported file type (.txt) returns 500 | Type detection throws on unknown extension | AC-5: explicit `.env` / `.json` check before parse; unknown extension → 422 unsupported_file_type. |
| Conflict detection misses a collision | Conflict query uses wrong projectId or table | AC-5: WHERE includes both `projectId` and RLS org scope; test: same-name credential in same project → conflictsWith populated. |
| `create_new` adds suffix to non-conflicting item | Suffix logic doesn't check `conflictsWith === null` | AC-7: explicit `if (item.conflictsWith !== null)` check before suffix; test: non-conflicting create_new → no suffix. |
| Cleanup job deletes non-expired rows | WHERE clause wrong (> instead of <) | AC-8: `WHERE expires_at < NOW()`; unit test: non-expired row is preserved after job run. |
| Audit bypass on bulk import | `writeAuditEvent` omitted or batch event omitted | SecureRoute config; per-credential audit events inside tx; audit-failure-rollback test. |
| Route-audit CI fails | New routes not classified, or DIRECT_DB_ACCESS missing | AC-10: add both routes + cleanup job to their respective classification maps; run route-audit in isolation. |
| `.env` CRLF files produce wrong values | `\r` in value field | AC-3: `content.split(/\r?\n/)` to handle CRLF; unit test with CRLF input. |
| Vault sealed → 500 instead of 503 | vault-guard not active for import routes | Import routes are NOT on vault-guard allowlist (intentional); vault-guard returns 503 first; tests assert sealed → 503 for both routes. |
| Overrides for non-existent item names crash | `overrides[name]` lookup on undefined | AC-6: overrides are applied per item as `overrides?.[item.name]`; unknown keys silently ignored. |
| `MAX + 1` race for versionNumber | Two concurrent confirms on the same credential | Same race as Story 2.2 add-version — accepted; monotonic increment on the `credential_versions` `MAX(version_number)` is a TOCTOU; a DB unique constraint on `(credential_id, version_number)` would reject the second with a conflict → client retries. Story 2.2 documents this accepted risk. |
| `getPrimaryKey()` called per-item; vault seals at item 251 of 500 | Loop throws mid-way; partially-encrypted in-memory list is discarded, but error surface is confusing | Call `getPrimaryKey()` ONCE before the loop (AC-5); if vault seals it throws immediately before any item is encrypted. |
| Concurrent confirm double-executes batch | No row lock on `pending_imports` SELECT; two transactions both see non-expired row | `SELECT ... FOR UPDATE` on `pending_imports` (AC-6); second transaction blocks until first commits + deletes row, then returns 404. |
| Same-millisecond suffix collision for multiple `create_new` conflicting items | `Date.now()` returns same value for two items processed in same ms | Use `_imported_${Date.now()}_${itemIndex}` with a monotonic loop counter (AC-7). |
| Duplicate key in file creates two staged items; both applied on confirm | Parser does not deduplicate; both are stored in `pending_imports.items` | Last-occurrence-wins deduplication in `parseEnvFile` + `duplicate_key` warning emitted (AC-3). |
| Cleanup job silently skips expired rows because admin pool lacks BYPASSRLS | RLS policy returns zero rows for a session with no `app.current_org_id` | Admin pool role MUST have `BYPASSRLS` attribute; verify against Story 2.2 retention worker pool (AC-8). |
| Override of `new_version` on non-conflicting item crashes confirm | Override bypasses the `conflictsWith === null` remap; `item.conflictsWith!` is null | `resolveAction()` remaps `new_version` → `create_new` for non-conflicting items regardless of origin (default or override) (AC-6). |

---

## ADRs

### ADR-2.5-01: Two-step import (parse/preview → confirm) with a `pending_imports` staging table

| | |
|---|---|
| **Context** | Bulk import carries the highest mutation blast radius of any credential operation — a single bad file could overwrite hundreds of credentials. The import flow must make conflicts visible and require explicit confirmation before any mutation. |
| **Decision** | Two distinct HTTP endpoints: `POST /import` (parse + preview, no writes to credentials) and `POST /import/confirm` (apply). A `pending_imports` staging row stores encrypted parsed items for 15 minutes. |
| **Rationale** | The two-step pattern is a first-class requirement in the epic spec and the UX design principle ("nothing committed until the user confirms — converts a migration anxiety event into a trust-building moment"). Storing encrypted items allows the confirm to avoid re-parsing and re-uploading the file, preserving the "one-click confirm" UX. |
| **Consequences** | A new `pending_imports` table with a TTL + cleanup job. Encrypted values occupy DB storage for up to 15 minutes; the table stays small (max 500 items × 15 min × concurrent users). |

### ADR-2.5-02: Values encrypted at parse time; confirm transfers ciphertext without decrypt

| | |
|---|---|
| **Context** | Parsed import values are credential secrets. The confirm step needs to create `credential_versions` rows containing the ciphertext. Options: (a) store plaintext in `pending_imports` and encrypt on confirm; (b) encrypt at parse time and transfer ciphertext on confirm. |
| **Decision** | **(b)** — encrypt immediately after parsing; store only ciphertext in `pending_imports`; confirm transfers the ciphertext to `credential_versions` without any intermediate decrypt. |
| **Rationale** | Option (a) stores plaintext secrets in the DB — a catastrophic violation of the vault's security model. Option (b) ensures the plaintext exists only in process memory long enough to be encrypted, with zero persistence window. The confirm path never sees plaintext and cannot inadvertently log, audit, or expose it. |
| **Consequences** | `withSecret()` is not used in the import path. The encrypted blob from `packages/crypto` is treated as an opaque token by the confirm step. If the vault master key changes between preview and confirm (rekeying), the ciphertext may fail to decrypt later — but this is an extremely rare edge case and the caller can simply re-upload. |

### ADR-2.5-03: `create_new` suffix (`_imported_<unix_ms>_<n>`) is only applied on name collisions

| | |
|---|---|
| **Context** | The `create_new` action could always append a suffix (for discoverability) or only when needed (for clean names). |
| **Decision** | Suffix `_imported_<unix_ms>_<n>` (timestamp + 0-based loop index) is appended ONLY when `item.conflictsWith !== null` (a credential with the same name already exists). For non-conflicting items, `create_new` uses the original name. |
| **Rationale** | A suffix on non-conflicting items degrades UX — the user imports `STRIPE_SECRET_KEY` and ends up with a credential named `STRIPE_SECRET_KEY_imported_1751000000000`. The suffix exists to avoid collision, not to mark the import origin. When there is no collision, the original name is correct and clear. |
| **Consequences** | The `create_new` action has different output shapes for conflicting vs non-conflicting items. The suffix makes collisions visible without polluting non-collision imports. |

### ADR-2.5-04: `defaultAction: 'new_version'` on a non-conflicting item is remapped to `create_new`

| | |
|---|---|
| **Context** | A user may upload a file with a mix of conflicting and non-conflicting entries and set `defaultAction: 'new_version'`. For non-conflicting entries, there is no existing credential to add a version to. |
| **Decision** | For non-conflicting items, `new_version` is silently remapped to `create_new`. `skip` is honored as-is (explicitly skips a non-conflicting item). `create_new` is honored as-is. |
| **Rationale** | `new_version` on a non-conflicting entry cannot mean "add a version" — there is nothing to version against. The closest correct behavior is "create a new credential." The remap is transparent (the result item shows `action: 'create_new'` in the response), and no error is thrown. This prevents the common footgun of a user who wants all conflicts to get a new version, but forgets that the batch default also applies to non-conflicting entries. |
| **Consequences** | The confirm response `action` field for a remapped item shows `'create_new'`, not `'new_version'`. This is intentional — it accurately reflects what happened. |

### ADR-2.5-05: Single transaction for the entire confirm batch (all-or-nothing)

| | |
|---|---|
| **Context** | Confirming 500 imports in parallel or per-item transactions risks partial writes (50 of 500 created before a DB error). |
| **Options** | (a) Single transaction — all succeed or all roll back. (b) Per-item transactions — partial success possible. (c) Savepoints — partial rollback within a transaction. |
| **Decision** | **(a)** — single transaction for the entire confirm batch. |
| **Rationale** | Partial writes are more dangerous than failure: the user may not notice that 450 of 500 credentials were created, leading to silent data gaps. An all-or-nothing batch guarantees predictability. For v1 imports (≤500 items), the transaction is fast enough. If the transaction fails, the `pending_imports` row is preserved and the user can retry the confirm with the same `importId`. |
| **Consequences** | A single DB error (constraint violation, deadlock) rolls back all changes. The retry-on-failure path is safe because `pending_imports` is preserved. The 500-item cap limits the transaction size. |

### ADR-2.5-06: `admin` / `owner` role required for both import endpoints

| | |
|---|---|
| **Context** | Bulk import creates or versions potentially hundreds of credentials in one operation. The blast radius is proportionally higher than any individual credential mutation. |
| **Decision** | `allowedRoles: ['owner', 'admin']` for both `POST /import` and `POST /import/confirm`. |
| **Rationale** | The epic specifies "the user has `admin` or `owner` role" for the import endpoint. This is also consistent with Story 2.4's access-list gate (admin/owner-only for elevated information operations). A `member` role who can add individual credentials one at a time should not be able to create/version hundreds in one go — the incremental audit trail of individual creates is bypassed by a bulk import, making the admin gate appropriate. |
| **Consequences** | `member` and `viewer` callers receive `403`. |

### ADR-2.5-07: Custom .env parser (no `dotenv` npm dependency)

| | |
|---|---|
| **Context** | Parsing `.env` files could use an existing npm package (`dotenv`, `dotenv-parse-variables`, etc.) or a custom minimal implementation. |
| **Options** | (a) Add `dotenv` as a `packages/shared` dependency. (b) Custom parser implementing exactly the rules the epic specifies. |
| **Decision** | **(b)** — custom parser in `packages/shared/src/utils/env-parser.ts`. |
| **Rationale** | `dotenv`'s parsing behavior diverges from the epic spec on several edge cases (inline comment handling, key validation, warning behavior). A custom parser implements exactly the specified rules with no hidden behavior, keeps `packages/shared` dependency-light, and is fully testable. The parsing rules are simple enough (split by `\n`, handle three quote variants and `export ` prefix) that a bespoke implementation is lower risk than overriding `dotenv` defaults. |
| **Consequences** | Slightly more code to maintain, but zero risk of upstream behavioral changes breaking import semantics. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.5-Credential-Bulk-Import-from-env--JSON`
- Epic 2 meta-notes (AC-E2b batch conflict resolution, FR17): `_bmad-output/planning-artifacts/epics.md` (lines ~1036)
- UX import trust moment: `_bmad-output/planning-artifacts/ux-design-specification.md` (lines ~246–249)
- Story 2.2 (encrypt/versioning path, `withSecret`, `getPrimaryKey`, add-version pattern, custom audit writer): `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md`
- Story 2.3 (credential list, `CredentialSummarySchema`, conflict detection query basis): `_bmad-output/implementation-artifacts/2-3-credential-search-filter-and-tag-management.md`
- Story 2.4 (metadata columns to NOT touch, `allowedRoles: ['owner','admin']` pattern, `DIRECT_DB_ACCESS_CLASSIFICATIONS`): `_bmad-output/implementation-artifacts/2-4-dependent-system-recording-and-expiry-rotation-schedules.md`
- SecureRoute (`allowedRoles`, `resourceIdFromParams`, audit writer): `apps/api/src/lib/secure-route.ts`
- Admin-gated route + `validationError` pattern: `apps/api/src/modules/org/routes.ts`
- Route audit classification + `ROUTE_FILES`: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- Audit event union: `packages/shared/src/constants/audit-events.ts`
- Schema conventions (`orgScoped`, `text`+CHECK enum): `packages/db/src/schema/helpers.ts`
- RLS coverage check / `0001` trigger function: `scripts/check-rls-coverage.ts`, `packages/db/src/migrations/0001_rls_and_triggers.sql`
- Auth test helpers: `apps/api/src/__tests__/helpers/auth-test-helpers.ts`
- Encryption API (`encrypt`, `withSecret`, `getPrimaryKey`): `packages/crypto/src/index.ts`
- pg-boss worker patterns: `apps/api/src/workers/` (see Story 2.2 retention worker as model)
- `@fastify/multipart` documentation: https://github.com/fastify/fastify-multipart
- Repo TDD rule: `AGENTS.md`
- Key decisions to read first: **ADR-2.5-01** (two-step flow), **ADR-2.5-02** (encrypt-at-parse, no decrypt on confirm), **ADR-2.5-05** (single transaction, all-or-nothing).

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet (Cursor Agent)

### Debug Log References

- `make ci` green after fixing OpenAPI params on `/credentials/import*` routes, vault-guard 503 schema mismatch, admin DB URL for cleanup worker, and jscpd duplicates.
- Worker job registered as `import/cleanup-expired` (pg-boss disallows `:` in queue names).

### Completion Notes List

- Added `pending_imports` staging table (migration `0018`) with RLS, env/json parsers, multipart upload + confirm routes, import service, cleanup worker, audit/operational events, and integration tests (382 API tests pass).
- Import routes registered before `/:credentialId` routes; OpenAPI omits `params` on import paths (handler still validates via `parseParams`) to avoid swagger ref resolution errors.
- Removed `503: ApiErrorSchema` from import route response schemas so vault-guard `{ status: 'sealed' }` responses are not rejected by the serializer.
- `getAdminDb()` uses `ADMIN_DATABASE_URL` or postgres superuser only (never `vault_app`); `Makefile` test target and API `setup-env.ts` set `ADMIN_DATABASE_URL` for cleanup worker tests.

### File List

- `packages/db/src/schema/pending-imports.ts`
- `packages/db/src/migrations/0018_pending_imports.sql`
- `packages/db/src/__tests__/pending-imports-rls-isolation.test.ts`
- `packages/db/src/__tests__/pending-import-test-helpers.ts`
- `packages/db/src/__tests__/credential-test-helpers.ts` (withTwoTestOrgs)
- `packages/shared/src/utils/env-parser.ts`
- `packages/shared/src/utils/env-parser.test.ts`
- `packages/shared/src/utils/json-import-parser.ts`
- `packages/shared/src/utils/json-import-parser.test.ts`
- `packages/shared/src/schemas/imports.ts`
- `packages/shared/src/constants/audit-events.ts`
- `packages/shared/src/constants/operational-event-types.ts`
- `packages/shared/src/constants/mfa-exempt-routes.ts`
- `apps/api/src/lib/db.ts`
- `apps/api/src/app.ts`
- `apps/api/src/main.ts`
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/__tests__/setup-env.ts`
- `apps/api/src/modules/credentials/import-service.ts`
- `apps/api/src/modules/credentials/db-helpers.ts`
- `apps/api/src/modules/credentials/credential-integration-context.ts`
- `apps/api/src/modules/credentials/routes.ts`
- `apps/api/src/modules/credentials/schema.ts`
- `apps/api/src/modules/credentials/credential-import.test.ts`
- `apps/api/src/modules/credentials/credential-route-test-helpers.ts`
- `apps/api/src/workers/import-cleanup.ts`
- `apps/api/src/workers/import-cleanup.test.ts`
- `Makefile`
