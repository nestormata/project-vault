# Story 2.7: Cross-Project Global Search

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-28 — comprehensive developer guide for the cross-project global search feature (FR80). This story adds: (1) a PostgreSQL migration introducing `pg_trgm` trigram indexes on `credentials.name`, `credentials.description`, `credentials.tags`, `projects.name`, and `projects.tags` (never on value/encrypted columns); (2) a new `modules/search/` API module implementing `GET /api/v1/search` behind SecureRoute with org-scoped RLS; (3) a `GlobalSearch.svelte` command-palette component triggered by Cmd+K/Ctrl+K wired into the existing AppShell. Relies on: Story 2.3 (check-search-index.ts CI lint rule, ILIKE foundation), Story 2.2 (value-free credentials schema), Story 2.1 (projects table + RLS). Consumed by: AppShell global nav. -->

## Story

As a developer working across multiple projects,
I want to search all accessible credential metadata and projects by name, description, or tag from anywhere in the product,
so that I can navigate to any asset in under 3 keystrokes without knowing which project it belongs to — making credential retrieval faster than navigation and faster than HashiCorp Vault's path-based model.

*Covers: FR80, UX-DR8.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.7-Cross-Project-Global-Search`]

> **The single most critical invariant in this story (read first):** global search MUST NEVER match, index, or return credential values or any secret material. The `credentials` table has **no `value`/`encrypted_value` column** (value material lives only in `credential_versions.encrypted_value`, introduced clean in Story 2.2 per RS-E2a). This story's `pg_trgm` indexes go exclusively on `name`, `description`, and `tags` columns. The negative test (searching a known stored credential plaintext returns **zero** results, zero hits) is a **required passing CI check** (AC-E2a blocker). The existing `scripts/check-search-index.ts` CI lint rule (Story 2.3) must continue to pass — any index referencing a value-bearing column causes an automatic CI failure and fails security review.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.2 (`credentials` + `credential_versions` tables, no `value` column on `credentials`) is merged | The `credentials` table has no `value`/`encrypted_value` column. Search indexes are safe to add on `name`/`description`/`tags` without value-leak risk. Confirm by reading the live schema before adding indexes. |
| Story 2.3 (`scripts/check-search-index.ts` CI lint rule, `projects.tags` column, credential list/search foundation) is merged | This story's new `pg_trgm` indexes MUST pass `check-search-index.ts`. The script must already exist (Story 2.3 created it). Run `pnpm check-search-index` before and after adding the migration. |
| Story 2.1 (`projects` table + `project_memberships` + `modules/projects/routes.ts`) is merged | The search query JOINs across `projects` and `credentials`. Both tables must exist with their RLS policies. |
| Story 1.11 (`SecureRoute` framework + `route-audit.test.ts` CI gate) is merged | The `GET /api/v1/search` route must be registered with `secureRoute()` and classified in `ROUTE_ACTION_CLASSIFICATIONS`. |
| Story 1.5 vault init/unseal is merged | The search route is NOT on the vault-guard allowlist. A sealed vault must return `503 { status: "sealed" }` even for search requests. Tests must assert this fail-closed behavior. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ As of writing, the highest committed migration is `0013_projects.sql`. Stories 2.2–2.6 will land migrations `0014` through `0018` (or higher). **Before generating this story's migration**, run a fresh check of `packages/db/src/migrations/meta/_journal.json` and use the **next free sequential number**. Every `0019_*` reference below is an illustrative placeholder — re-read the journal every time and substitute the real next number. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.7 |
|---|---|
| 2.1 | Created `projects` + `project_memberships` tables with org-scoped RLS. The search query JOINs `projects` and filters via `project_memberships` to respect per-project access. The `projects.name` column is indexed by this story. |
| 2.2 | Created `credentials` (with `name`, `description`, `tags` columns; **no `value` column**) and `credential_versions` (value material only). The deliberate absence of `value` on `credentials` is the architectural guarantee that makes search safe. **Do not read or join `credential_versions` in the search query.** |
| 2.3 | Created `projects.tags` JSONB column, the canonical FR97 pagination helper, and the `scripts/check-search-index.ts` CI lint rule. This story adds `pg_trgm` indexes (Story 2.3 explicitly deferred them here). The `check-search-index.ts` rule MUST continue to pass after this story's migration lands. |
| 2.4 | Added `expires_at`, `rotation_schedule`, `dependent_systems` to `credentials`. The search result response MAY include `expiresAt` in the credential result shape for quick-action UX (shows "expires soon" badge), but search filters do NOT filter on these fields — that is Story 2.3 (per-project filter). |
| 2.6 | The onboarding wizard Step 3 ("What's next?") references global search in copy only; Story 2.6 does not implement search. This story provides the actual implementation. |
| 2.0 | The `AppShell.svelte` + `PrimaryNav.svelte` components exist. This story adds `GlobalSearch.svelte` and wires the keyboard shortcut into the `(app)/+layout.svelte`. Do not break the auth guard, SSR flow, or existing layout hierarchy. |
| 4.1 | Per-project RBAC (future). In v1, project access is checked via `project_memberships.org_id = :orgId` — Viewer role and above. Once Epic 4 lands project-level roles, the search query's membership JOIN must be tightened; that is a Story 4.x concern, not 2.7. |
| 8.x | Search queries that reveal credential metadata generate a `credential.search` audit event. This follows PJ5 (pre-audit-log coverage): write to `audit_log_entries` now so it is queryable when Epic 8 audit UI lands. Actor is stored as `user_identity_token` reference (NOT raw `userId`) per PJ6. |

---

## Architecture Decisions

| ADR | Decision | Rationale |
|---|---|---|
| ADR-2.7-01 | Use `pg_trgm` GIN indexes (not `tsvector`) | Architecture doc says "PostgreSQL tsvector for cross-project search" but epic readiness note (2026-06-27) specifies `pg_trgm`. Trigram supports substring matching — critical for UX-DR8 "3 keystrokes" UX. `tsvector` does NOT match substrings (lexeme decomposition only). `pg_trgm` is correct at v1 scale (≤10,000 secrets). Migration path to `tsvector` in v2 if scale requires. |
| ADR-2.7-02 | No cursor pagination — single page `limit ≤ 50` | Command-palette search is single-shot retrieval (UX-DR8). Cursor pagination adds backend complexity with zero UX benefit. Epic AC explicitly caps at 50. Compatible with future cursor pagination if ever needed. |
| ADR-2.7-03 | `GlobalSearch.svelte` in `(app)/+layout.svelte`, not a page | The search palette must overlay ALL app pages. A `+page.svelte` approach would require navigation just to access search, violating UX-DR8. Layout-level mounting means Cmd+K works from any page. |
| ADR-2.7-04 | Client-side fetch for search results (no SSR) | Search is a reactive command-palette interaction, not an initial page load. SSR-loading search results makes no sense. Client-side `fetch` with `credentials: 'include'` is correct. SvelteKit `openapi-fetch` typed client is used for consistency. |
| ADR-2.7-05 | Separate `modules/search/` module (not added to projects module) | `modules/projects/routes.ts` is already large and handles project CRUD. Cross-type search is a distinct concern that JOINs multiple tables. A separate module is easier to test, review, and evolve. |

---



| Architecture / Epic wording | Canonical implementation for 2.7 | Rationale |
|---|---|---|
| Architecture: "PostgreSQL `tsvector` for cross-project search (FR80)" | Implement using **`pg_trgm` trigram indexes + `similarity()` / `word_similarity()` scoring**. Do NOT add `tsvector`/`to_tsvector` generated columns. | The epics readiness note (2026-06-27) specifies "pg_trgm trigram indexes on name/description/tags columns". `pg_trgm` supports substring matching (LIKE with index) and similarity scoring without a separate `tsvector` column, which is a simpler migration at v1 scale (≤10,000 secrets). Both are "full-text" in the architecture's intent. |
| Architecture: cursor pagination for search | Use **`limit` + `offset = 0`** (single-page, no cursor). Search is a single-shot retrieval pattern (UX-DR8: "under 3 keystrokes"), not a scrollable list. The epic AC explicitly caps `limit` at 50. | Cursor pagination adds complexity with no UX benefit for a command-palette interaction. If future pagination is needed, the schema is compatible. |
| Architecture: `SecureRoute` for all routes | Use `secureRoute()` for `GET /api/v1/search`. The route is a `read` action (metadata only); search audit events ARE written (credential metadata access, PJ5). The route is NOT classified as `audit-omitted` even though it is a read — credential name reveal is an auditable event. | Credential search is metadata access, but it is explicitly auditable per PJ5 + AC-E2a security requirements. |
| Frontend: SvelteKit SSR load for search | Search is **client-side only** (no `+page.server.ts` load for search results). The command palette fires a client-side `fetch('/api/v1/search?q=...')` with `credentials: 'include'`. | SSR-loading search results on page load makes no sense for a command-palette interaction. SSR is used for initial page data; search is reactive. |
| `ROUTE_ACTION_CLASSIFICATIONS` key for search | Register as `'GET /search': { action: 'read', resource: 'credential_metadata', auditEvent: 'credential.search' }` | Consistent with the audit vocabulary established in Stories 2.2/2.3. |

---

## Security Invariants (Non-Negotiable)

These invariants are checked by CI and security review. **Violating any one of these fails the story.**

| # | Invariant | How it is enforced |
|---|---|---|
| INV-1 | Credential `value` / `encrypted_value` is NEVER searched, indexed, matched, or returned | The `credentials` table has no value column (Story 2.2 RS-E2a). `check-search-index.ts` fails CI if a value column is ever indexed. Negative test: searching known plaintext → 0 results. |
| INV-2 | Search results are org-scoped at the DB query level, not post-filtered | The SQL query includes `WHERE credentials.org_id = :orgId` (enforced by RLS via `set local app.current_org_id`). Never filter client-side. A user from Org A must not see any result from Org B — assert in integration tests. |
| INV-3 | `GET /api/v1/search` requires authentication | Unauthenticated call → 401. Sealed vault → 503. Both asserted in tests. |
| INV-4 | `check-search-index.ts` passes after this story's migration | Run `pnpm check-search-index` in the migration AC. New trigram indexes go on `name`/`description`/`tags` ONLY. Any PR that adds a value-column index causes CI failure. |
| INV-5 | Actor stored as `user_identity_token` reference in audit | `actorTokenId` in every `credential.search` audit entry MUST use `firstActorTokenIdForUser(userId, tx)` — never raw `userId`. PJ6 invariant from Epic 1. |

---

## Database Schema

### Migration: `0019_global_search_trgm_indexes.sql` (number is illustrative — use next free)

> **R1 — Always re-read `meta/_journal.json` before running `drizzle-kit generate`.** The real migration number will be higher than 0019 depending on what stories 2.2–2.6 actually committed.

This migration does two things:

1. Enable the `pg_trgm` extension (idempotent).
2. Add GIN trigram indexes on the searchable columns of `credentials` and `projects`.

The migration contains **no schema changes** — only extension activation and index creation. No new columns, no `ALTER TABLE`, no `tsvector`. This is intentional: the indexes are pure performance additions on top of the existing Story 2.2/2.3 schema.

```sql
-- Enable pg_trgm extension (idempotent, safe to run in CI and production)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes on credentials (searchable metadata only)
-- NEVER on value/encrypted_value columns — those don't exist on credentials (RS-E2a)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credentials_name_trgm
  ON credentials USING GIN (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credentials_description_trgm
  ON credentials USING GIN (description gin_trgm_ops);

-- tags is jsonb; cast to text for trigram matching
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credentials_tags_trgm
  ON credentials USING GIN (CAST(tags AS text) gin_trgm_ops);

-- Trigram indexes on projects (name and tags)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_name_trgm
  ON projects USING GIN (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_tags_trgm
  ON projects USING GIN (CAST(tags AS text) gin_trgm_ops);
```

**Post-migration validation checklist:**
- [ ] `pnpm --filter @project-vault/db check-rls` still reports zero gaps (new indexes don't affect RLS)
- [ ] `pnpm check-search-index` exits 0 (none of the new indexes touch `value`/`encrypted_value`)
- [ ] `pnpm --filter @project-vault/db migrate` applies cleanly on a fresh database and an existing database
- [ ] Drizzle schema files do NOT need to change — the indexes are SQL-only (Drizzle `index()` declarations are optional for pure-SQL migrations; do not invent Drizzle index declarations for these)

**Why `CREATE INDEX CONCURRENTLY`:** avoids table lock during CI migrations. This is safe even in migration files when the migration runner does not wrap DDL in a transaction (Drizzle's default for `CONCURRENTLY`). If the runner wraps DDL in a transaction, remove `CONCURRENTLY` — they are equivalent in a fresh CI database.

---

## API Design

### `GET /api/v1/search`

**Module location:** `apps/api/src/modules/search/` (new module — do NOT add search logic to `modules/projects/routes.ts` or any existing module)

**Files to create:**
- `apps/api/src/modules/search/schema.ts` — Zod request/response schemas
- `apps/api/src/modules/search/routes.ts` — Fastify route registration via `secureRoute()`
- `apps/api/src/modules/search/service.ts` — DB query logic (pure function, no Fastify dependency)
- `apps/api/src/modules/search/routes.test.ts` — integration tests (real test DB, no DB mocks)

**Register in `apps/api/src/app.ts`** (or `routes/index.ts` — follow the existing module registration pattern established in Stories 2.1/2.3):

```typescript
import { registerSearchRoutes } from './modules/search/routes.js'
// ... register alongside projects, auth, org modules
await fastify.register(registerSearchRoutes)
```

---

### Query Parameters (`SearchQuerySchema`)

```typescript
// apps/api/src/modules/search/schema.ts
import { z } from 'zod/v4'

const SEARCH_TYPE = z.enum(['credentials', 'projects'])

export const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    types: z
      .string()
      .optional()
      .transform((val) =>
        val ? (val.split(',').filter((t): t is 'credentials' | 'projects' =>
          ['credentials', 'projects'].includes(t)) as Array<'credentials' | 'projects'>)
          : (['credentials', 'projects'] as const)
      ),
    limit: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : 20))
      .pipe(z.number().int().min(1).max(50)),
  })
  .strict()
  .meta({ id: 'SearchQuery' })
```

**Constraints:**
- `q`: 1–200 characters (trimmed). Minimum 1 character required — no empty-string searches.
- `types`: comma-separated subset of `credentials,projects`. Defaults to both if omitted.
- `limit`: integer 1–50. Default 20. **Hard cap at 50** — the epic explicitly requires this; do not raise it.
- No `page`/`offset` — search is single-shot (command-palette pattern, not paginated browse).

---

### Response Shape (`SearchResponseSchema`)

```typescript
// apps/api/src/modules/search/schema.ts (continued)

export const SearchResultItemSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('credential'),
      id: z.uuid(),
      name: z.string(),
      description: z.string().nullable(),
      tags: z.array(z.string()),
      projectId: z.uuid(),
      projectName: z.string(),
      matchedField: z.enum(['name', 'description', 'tags']),
      snippet: z.string().nullable(),
      expiresAt: z.string().datetime().nullable(),    // ISO-8601; for "expires soon" badge — NOT the value
    }),
    z.object({
      type: z.literal('project'),
      id: z.uuid(),
      name: z.string(),
      description: z.string().nullable(),
      tags: z.array(z.string()),
      slug: z.string(),
      matchedField: z.enum(['name', 'tags']),
      snippet: z.string().nullable(),
      credentialCount: z.number().int().nonnegative(), // approximate count for context
    }),
  ])
  .meta({ id: 'SearchResultItem' })

export const SearchResponseSchema = z
  .object({
    data: z.object({
      results: z.array(SearchResultItemSchema),
      total: z.number().int().nonnegative(),
      query: z.string(),
      types: z.array(z.enum(['credentials', 'projects'])),
    }),
  })
  .meta({ id: 'SearchResponse' })
```

**What is NEVER in the response:**
- Credential `value`, `encrypted_value`, or any field from `credential_versions`
- Any field from `credential_versions` table — the query must not JOIN this table
- Any internal system identifiers beyond `id`, `projectId`

---

### Route Handler

```typescript
// apps/api/src/modules/search/routes.ts (abbreviated pattern)
import { secureRoute } from '../../lib/secure-route.js'
import { SearchQuerySchema, SearchResponseSchema } from './schema.js'
import { executeSearch } from './service.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import type { FastifyApp } from '../../lib/fastify-app.js'

export async function registerSearchRoutes(fastify: FastifyApp) {
  fastify.get(
    '/api/v1/search',
    secureRoute({
      schema: {
        querystring: SearchQuerySchema,
        response: { 200: SearchResponseSchema },
      },
      // action: 'read', resource: 'credential_metadata' — registered in ROUTE_ACTION_CLASSIFICATIONS
    }),
    async (request, reply) => {
      const { orgId, userId } = request.authContext
      const { q, types, limit } = request.query

      const results = await executeSearch({ db: fastify.db, orgId, q, types, limit })

      // PJ5 + PJ6: audit credential metadata access
      if (results.results.some((r) => r.type === 'credential')) {
        await fastify.db.transaction(async (tx) => {
          const actorTokenId = await firstActorTokenIdForUser(userId, tx)
          await writeHumanAuditEntry({
            tx,
            orgId,
            actorTokenId,
            eventType: 'credential.search',
            resourceId: null,
            payload: { query: q, types, resultCount: results.total },
            request,
          })
        })
      }

      return reply.status(200).send({ data: { ...results, query: q, types } })
    }
  )
}
```

**`ROUTE_ACTION_CLASSIFICATIONS` entry (in `lib/route-helpers.ts` or equivalent):**

```typescript
'GET /api/v1/search': {
  action: 'read',
  resource: 'credential_metadata',
  auditEvent: 'credential.search',
  // NOT audit-omitted — credential metadata access is auditable (PJ5)
}
```

**`ROUTE_FILES` registration (CI-critical):** add `'modules/search/routes.ts'` to the `ROUTE_FILES` array in `apps/api/src/__tests__/route-audit.test.ts`. A typo here silently skips the file and the route-audit gate will not enforce the classification — run `pnpm --filter @project-vault/api test route-audit` in isolation after adding the entry to confirm `GET /api/v1/search` appears.

**`AuditEventType` update (CI-critical):** add `'credential.search'` to the `AuditEventType` union in `packages/shared/src/constants/audit-events.ts`. The string must be byte-identical to the value used in `writeAuditEvent` and `ROUTE_ACTION_CLASSIFICATIONS`. Run `pnpm --filter @project-vault/shared test` and `pnpm typecheck` after.

---

### Search Service: SQL Query

The query logic lives in `service.ts` (no Fastify imports — pure DB function, testable in isolation).

#### Credential search query

```typescript
// apps/api/src/modules/search/service.ts (credential branch)
import { sql, and, eq, or, ilike } from 'drizzle-orm'
import type { Db } from '@project-vault/db'
import { credentials, projects, projectMemberships } from '@project-vault/db/schema'

export async function executeSearch({ db, orgId, q, types, limit }: SearchInput): Promise<SearchOutput> {
  const results: SearchResultItem[] = []

  if (types.includes('credentials')) {
    const credRows = await db
      .select({
        id: credentials.id,
        name: credentials.name,
        description: credentials.description,
        tags: credentials.tags,
        expiresAt: credentials.expiresAt,
        projectId: projects.id,
        projectName: projects.name,
        nameSim: sql<number>`word_similarity(${q}, ${credentials.name})`,
        descSim: sql<number>`word_similarity(${q}, ${credentials.description})`,
      })
      .from(credentials)
      .innerJoin(projects, eq(credentials.projectId, projects.id))
      // RLS enforces org_id; the explicit filter is defense-in-depth
      .where(
        and(
          eq(credentials.orgId, orgId),
          eq(projects.orgId, orgId),
          isNull(projects.archivedAt),              // exclude archived projects
          or(
            sql`${credentials.name} ILIKE ${`%${q}%`}`,
            sql`${credentials.description} ILIKE ${`%${q}%`}`,
            sql`CAST(${credentials.tags} AS text) ILIKE ${`%${q}%`}`
          )
        )
      )
      .orderBy(
        sql`
          CASE
            WHEN LOWER(${credentials.name}) = LOWER(${q}) THEN 3
            WHEN LOWER(${credentials.name}) ILIKE LOWER(${`${q}%`}) THEN 2
            ELSE 1
          END DESC,
          ${credentials.updatedAt} DESC
        `
      )
      .limit(limit)

    // map to SearchResultItem (credential shape) — see result mapping section
    results.push(...mapCredentialRows(credRows, q))
  }

  if (types.includes('projects')) {
    // similar query on projects table, no credential_versions JOIN
  }

  return { results, total: results.length }
}
```

**Critical query rules:**
- Never JOIN `credential_versions` — the value material lives there and must never enter the query path.
- `credentials.orgId = :orgId` is both an explicit WHERE clause AND enforced by RLS (defense-in-depth).
- The trigram `ILIKE` with `%q%` pattern activates the GIN index when `pg_trgm` is installed.
- `word_similarity()` requires `pg_trgm` to be active (enabled by this story's migration).

#### Relevance ordering (3-tier)

Results within each type are sorted by:
1. **Tier 3 (highest):** exact name match, case-insensitive (`LOWER(name) = LOWER(q)`)
2. **Tier 2:** prefix name match (`LOWER(name) ILIKE LOWER(q || '%')`)
3. **Tier 1 (lowest):** substring or description/tag match
4. **Within tier:** `updatedAt DESC` (most recently touched first)

This ordering is computed in SQL (not in application code) so the `LIMIT` clause applies correctly.

#### Snippet generation

The `snippet` field is a short string showing context around the match (max 120 chars). Generate server-side:

```typescript
function generateSnippet(text: string | null, query: string): string | null {
  if (!text) return null
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, 120)
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + query.length + 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}
```

**No** server-side HTML bolding/highlighting — the client component handles highlighting.

---

## Frontend Design

### Component: `GlobalSearch.svelte`

**Location:** `apps/web/src/lib/components/shell/GlobalSearch.svelte` (alongside existing `AppShell.svelte`, `PrimaryNav.svelte`)

**Wiring point:** `apps/web/src/routes/(app)/+layout.svelte` — add `<GlobalSearch />` as a sibling to `<AppShell>` so it overlays the entire `(app)` scope, not a single page.

> **Cross-story layout conflict (Story 2.6):** Story 2.6 also modifies `(app)/+layout.svelte` to add the onboarding wizard guard (`{#if !onboardingDone}<OnboardingWizard />{:else}{@render children()}{/if}`). When implementing this story, **preserve that guard block** — do not replace the conditional render with an unconditional `{@render children()}`. The correct merged shape is: wizard guard wrapping `{@render children()}`, with `<GlobalSearch />` mounted as an unconditional sibling outside the wizard guard so it is always available regardless of onboarding state.

**Trigger mechanism (UX-DR8):**
- Keyboard: `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) fires from anywhere in the `(app)` layout
- Click: a search icon button in `PrimaryNav.svelte` (add alongside existing nav items) toggles the palette

**Interaction flow:**

```
User presses Cmd+K
  → GlobalSearch modal opens (full-width overlay, centered in viewport)
  → Focus moves to the <input> automatically (focus trap active)
  → User types (debounced 200ms)
  → Client-side fetch: GET /api/v1/search?q=<term>&limit=10
  → Results appear below the input, grouped by type (Projects / Credentials)
  → Arrow keys navigate results
  → Enter navigates to the selected result
  → Escape or click-outside closes the modal
  → Tab cycles through results (accessible)
```

**Component structure:**

```svelte
<!-- GlobalSearch.svelte (simplified structure) -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { apiClient } from '$lib/api/client.js'

  let open = $state(false)
  let query = $state('')
  let results = $state<SearchResultItem[]>([])
  let loading = $state(false)
  let selectedIndex = $state(0)
  let debounceTimer: ReturnType<typeof setTimeout>

  function openSearch() { open = true; query = ''; results = [] }
  function closeSearch() { open = false; query = ''; results = [] }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      open ? closeSearch() : openSearch()
    }
  }

  async function search(q: string) {
    if (q.trim().length === 0) { results = []; return }
    loading = true
    const res = await apiClient.GET('/api/v1/search', { params: { query: { q, limit: 10 } } })
    results = res.data?.results ?? []
    loading = false
    selectedIndex = 0
  }

  function handleQueryChange() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => search(query), 200)
  }

  function navigate(item: SearchResultItem) {
    closeSearch()
    if (item.type === 'credential') goto(`/projects/${item.projectId}/credentials/${item.id}`)
    if (item.type === 'project') goto(`/projects/${item.id}`)
  }

  onMount(() => window.addEventListener('keydown', handleKeydown))
  onDestroy(() => window.removeEventListener('keydown', handleKeydown))
</script>

{#if open}
  <!-- Focus trap + ARIA dialog pattern -->
  <div role="dialog" aria-modal="true" aria-label="Global search" class="search-overlay" ...>
    <div class="search-panel">
      <input
        bind:value={query}
        oninput={handleQueryChange}
        placeholder="Search credentials, projects…"
        aria-label="Search"
        aria-autocomplete="list"
        aria-controls="search-results"
        autocomplete="off"
        autofocus
      />
      {#if loading}
        <span aria-live="polite" class="sr-only">Searching…</span>
      {/if}
      <ul id="search-results" role="listbox">
        <!-- grouped by type -->
        {#each groupedResults as group}
          <li role="group" aria-label={group.label}>
            <ul>
              {#each group.items as item, i}
                <li
                  role="option"
                  aria-selected={selectedIndex === i}
                  onclick={() => navigate(item)}
                >
                  <!-- item renderer -->
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
      {#if query.length > 0 && results.length === 0 && !loading}
        <p class="empty-state">No results for "<span>{query}</span>"</p>
      {/if}
      <footer class="search-hint">
        <kbd>↑↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>Esc</kbd> close
      </footer>
    </div>
  </div>
{/if}
```

**Accessibility requirements (WCAG 2.1 AA — required by UX-DR15):**
- `role="dialog" aria-modal="true"` on the overlay container
- `role="listbox"` + `role="option"` on results (combobox-lite ARIA pattern)
- `aria-selected` on the keyboard-focused result
- `aria-live="polite"` on the loading state
- Focus trap: Tab/Shift+Tab stays within the search panel while open
- Escape always closes and returns focus to the element that opened the search
- Keyboard shortcut hint visible on initial open (first-time discovery)
- Color contrast for the match highlight meets AA ratio

**Search result item rendering:**

Each result item shows:
- **Credential result:** `[credential icon] {projectSlug} / {name}` — `{snippet}` — optionally `[expires soon badge]` if `expiresAt` is within 30 days. When multiple credentials share the same `name` (common for e.g., "DATABASE_URL" across projects), the `projectSlug` prefix is the only disambiguation — make it visually prominent (semibold, muted color), not a secondary afterthought.
- **Project result:** `[project icon] {name}` — `{credentialCount} credentials` — `{snippet}`

Match highlighting: bold the matching substring in `name` and `snippet` client-side (split on the query term, wrap in `<mark>`).

**PrimaryNav integration:**

Add a search trigger button to `apps/web/src/lib/components/shell/PrimaryNav.svelte`:

```svelte
<!-- In PrimaryNav.svelte, alongside existing navigation items -->
<button
  onclick={() => dispatch('openSearch')}
  aria-label="Search (⌘K)"
  class="nav-search-trigger"
  title="Search (⌘K)"
  style="min-width: 44px; min-height: 44px;"  <!-- mobile tap target UX-DR10 -->
>
  <!-- search icon svg -->
  <span class="sr-only">Search</span>
  <!-- Hide keyboard shortcut hint on mobile viewports (it's irrelevant on touch) -->
  <kbd class="nav-shortcut hidden sm:inline" aria-hidden="true">⌘K</kbd>
</button>
```

The `openSearch` event bubbles up to `+layout.svelte` which sets the `GlobalSearch` open state.

> **Svelte 5 runes note:** The project uses Svelte 5 runes mode. `createEventDispatcher` is deprecated in runes components. Use a `$props()` callback instead: declare `let { onsearch }: { onsearch?: () => void } = $props()` in `PrimaryNav.svelte` and call `onsearch?.()` from the button. In `+layout.svelte`, bind it as `<PrimaryNav onsearch={() => (searchOpen = true)} />`. Do NOT use `createEventDispatcher` in a runes-mode component — it will trigger a deprecation warning and may break in a future Svelte 5 minor.

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| **Migration** | `pg_trgm` extension enabled; GIN indexes on `credentials.name`, `credentials.description`, `credentials.tags`, `projects.name`, `projects.tags`; `check-search-index.ts` passes; no value-column index |
| **API: basic search** | `GET /api/v1/search?q=stripe` returns `{ data: { results, total, query, types } }` — credentials and projects matching "stripe" |
| **API: type filter** | `?types=credentials` returns only credential results; `?types=projects` returns only project results |
| **API: limit** | `?limit=50` is accepted; `?limit=51` returns 400; default is 20 |
| **API: relevance order** | Exact name match ranked above prefix match, ranked above substring/tag/description match; within tier, most recently updated first |
| **API: value exclusion (BLOCKER)** | Searching a known credential plaintext returns **zero results** — this must be a named required test |
| **API: org isolation** | User in Org A receives zero results from Org B — enforced at DB level, asserted in integration test |
| **API: auth** | Unauthenticated: 401; sealed vault: 503; authenticated: 200 |
| **API: audit** | Every search that returns ≥1 credential result writes a `credential.search` audit entry with `user_identity_token` reference |
| **Frontend: Cmd+K** | Pressing Cmd+K (Mac) or Ctrl+K (Win/Linux) from any `(app)` page opens the search palette |
| **Frontend: nav button** | Clicking the search icon in `PrimaryNav` also opens the palette |
| **Frontend: results** | Results grouped by type; credential and project results rendered with icon, name, project badge (credentials), snippet, expiry badge (expiring credentials) |
| **Frontend: navigation** | Selecting a credential result navigates to `/projects/:projectId/credentials/:id`; selecting a project navigates to `/projects/:id` |
| **Frontend: accessibility** | ARIA dialog pattern, focus trap, keyboard navigation, `aria-live` loading state; passes axe-core WCAG 2.1 AA in CI |
| **Frontend: debounce** | Search fires after 200ms of input inactivity (no request on every keystroke) |
| **Frontend: empty state** | When `q.length > 0` and no results: "No results for '{query}'" |
| **Frontend: close behavior** | Escape closes palette; click-outside closes palette; both restore focus to pre-open element |

---

### AC-1: Migration — `pg_trgm` Extension and GIN Indexes

**Given** the `pg_trgm` extension is not yet active in the database,
**When** Story 2.7's migration runs,
**Then** `CREATE EXTENSION IF NOT EXISTS pg_trgm` executes without error (idempotent — safe to run on a database that already has it).

**And** the following GIN trigram indexes are created (illustrative names — use `IF NOT EXISTS` for idempotency):

| Index name | Table | Column | Notes |
|---|---|---|---|
| `idx_credentials_name_trgm` | `credentials` | `name` | Never on `value` |
| `idx_credentials_description_trgm` | `credentials` | `description` | Never on `encrypted_value` |
| `idx_credentials_tags_trgm` | `credentials` | `CAST(tags AS text)` | JSONB cast; `tags` is metadata not value material |
| `idx_projects_name_trgm` | `projects` | `name` | |
| `idx_projects_tags_trgm` | `projects` | `CAST(tags AS text)` | |

**And** after the migration, `pnpm check-search-index` exits 0 — no value-column index is detected.

**And** `pnpm --filter @project-vault/db check-rls` reports zero RLS gaps — new indexes do not affect RLS policies.

**And** the migration applies cleanly on both a fresh (empty) database and an existing populated database.

---

### AC-2: API — Basic Search Across Types

**Given** the authenticated user in Org A has access to two projects: "payments" (containing a credential named "Stripe API Key") and "auth-service" (containing a credential named "Auth0 Client Secret"),

**When** they call `GET /api/v1/search?q=stripe`,

**Then** the response is `200 OK` with body:

```json
{
  "data": {
    "results": [
      {
        "type": "credential",
        "id": "<uuid>",
        "name": "Stripe API Key",
        "description": null,
        "tags": [],
        "projectId": "<payments-project-uuid>",
        "projectName": "payments",
        "matchedField": "name",
        "snippet": "Stripe API Key",
        "expiresAt": null
      }
    ],
    "total": 1,
    "query": "stripe",
    "types": ["credentials", "projects"]
  }
}
```

**And** the "Auth0 Client Secret" credential is NOT in the results (it does not match "stripe").

**And** the response time is p95 ≤ 300ms on a database with 10,000 credentials (NFR-PERF target).

---

### AC-3: Type Filtering

**Given** the user has credentials named "Stripe API Key" and a project named "stripe-integrations",

**When** they call `GET /api/v1/search?q=stripe&types=credentials`,

**Then** the response includes only `type: "credential"` results — no project results.

**When** they call `GET /api/v1/search?q=stripe&types=projects`,

**Then** the response includes only `type: "project"` results — no credential results.

**When** they call `GET /api/v1/search?q=stripe` (no `types` param),

**Then** both credential and project results are returned (default behavior: all types).

**When** they call `GET /api/v1/search?q=stripe&types=invalid`,

**Then** the response is `400 Bad Request` with `{ error: "INVALID_SEARCH_TYPE", message: "..." }`.

---

### AC-4: Limit Enforcement

**Given** 30 credentials match the query "api",

**When** the user calls `GET /api/v1/search?q=api&limit=10`,

**Then** the response contains at most 10 results and `total` reflects the count returned (not the database total match count — this is a single-page result, not cursor pagination).

**When** they call `GET /api/v1/search?q=api&limit=51`,

**Then** the response is `400 Bad Request` with `{ error: "VALIDATION_ERROR", message: "limit must be ≤ 50" }`.

**When** they call `GET /api/v1/search?q=api` (no `limit` param),

**Then** the default limit of 20 is applied.

---

### AC-5: Relevance Ordering

**Given** the database contains:
- Credential A with `name = "GitHub Token"` (exact match for query "github token")
- Credential B with `name = "GitHub Actions Deploy Key"` (prefix match for "github")
- Credential C with `description = "Used for GitHub CI pipelines"` (description match for "github")
- All three are in the same project and same org

**When** the user calls `GET /api/v1/search?q=github token`,

**Then** the results are ordered:
1. Credential A ("GitHub Token") — Tier 3 (exact name match)
2. Credential B ("GitHub Actions Deploy Key") — Tier 2 (prefix match)
3. Credential C — Tier 1 (description match)

**And** within the same tier, the most recently `updatedAt` result appears first.

---

### AC-6: Negative Security Test (BLOCKER — AC-E2a)

> **This test must exist as a named, non-skippable test and must pass for the story to be considered complete.**

**Given** a credential named "PaymentProcessor Key" with value `sk_live_SENSITIVE_VALUE_12345` stored in `credential_versions.encrypted_value` (encrypted at rest),

**When** the user calls `GET /api/v1/search?q=SENSITIVE_VALUE_12345`,

**Then** the response is `200 OK` with `{ data: { results: [], total: 0 } }` — zero results.

**And** the SQL query plan confirms that `credential_versions` table is NOT accessed (assert via `EXPLAIN` or by verifying the query does not JOIN `credential_versions`).

**And** this test is named `'should return zero results when searching a known credential value (AC-E2a blocker)'` and is NOT marked skip/todo.

---

### AC-7: Cross-Org Isolation

**Given** Org A has a credential named "Org A Stripe Key" and Org B has a credential named "Org B Stripe Key",

**When** an authenticated user from Org A calls `GET /api/v1/search?q=stripe`,

**Then** only "Org A Stripe Key" appears in the results.

**And** "Org B Stripe Key" is NOT present in the results regardless of its name.

**And** this isolation is enforced at the DB query level (via `org_id = :orgId` WHERE clause + RLS) — NOT via post-query filtering.

**And** a second integration test asserts this from the Org B user's perspective (zero results for Org A's credentials).

---

### AC-8: Authentication and Sealed Vault

**Given** no valid session cookie is present,

**When** a request is sent to `GET /api/v1/search?q=stripe`,

**Then** the response is `401 Unauthorized` with `{ error: "UNAUTHORIZED", message: "Authentication required" }`.

**Given** the vault is sealed (vault_state.status = 'sealed'),

**When** an authenticated user calls `GET /api/v1/search?q=stripe`,

**Then** the response is `503 Service Unavailable` with `{ error: "VAULT_SEALED", message: "..." }`.

---

### AC-9: Audit Event for Credential Search

**Given** an authenticated user performs a search that returns at least one credential result,

**When** `GET /api/v1/search?q=stripe&types=credentials` returns credentials,

**Then** an `audit_log_entries` row is inserted within the same request (PJ5 — same-transaction write for audit, fail-closed):

```json
{
  "eventType": "credential.search",
  "orgId": "<orgId>",
  "actorTokenId": "<user_identity_token_id>",
  "resourceId": null,
  "payload": {
    "query": "stripe",
    "types": ["credentials"],
    "resultCount": 1
  }
}
```

**And** the `actorTokenId` is a `user_identity_tokens.id` reference (NOT the raw `userId`) — PJ6 invariant.

**And** if the audit write fails (e.g., DB constraint violation), the search request itself returns an error (fail-closed — do not return search results if the audit write fails).

**Given** a search that returns ONLY project results (no credentials),

**Then** no audit entry is written (project metadata access is not auditable at this granularity).

---

### AC-10: Frontend — Command Palette Opens and Closes

**Given** the user is on any page within the `(app)` layout,

**When** they press `Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux),

**Then** the `GlobalSearch` command palette opens with focus immediately on the text input.

**And** pressing `Escape` closes the palette and returns focus to the element that had focus before the palette opened.

**And** clicking outside the palette panel (on the overlay backdrop) closes the palette.

**And** clicking the search icon in `PrimaryNav` also opens the palette.

---

### AC-11: Frontend — Search Results and Navigation

**Given** the command palette is open and the user types "stripe" (after 200ms debounce),

**Then** a `GET /api/v1/search?q=stripe&limit=10` request is made.

**And** results are displayed grouped by type:

```
Projects
  ▸ stripe-integrations          [3 credentials]  "…stripe integration setup…"

Credentials
  ▸ Stripe API Key               [payments]       expires in 12 days ⚠️
  ▸ Stripe Webhook Secret        [payments]
```

**And** the matching substring "Stripe" / "stripe" is bolded in the result name and snippet.

**And** pressing `↓` moves keyboard focus to the next result; `↑` moves up; `Enter` selects.

**And** selecting a credential result navigates to `/projects/{projectId}/credentials/{credentialId}` and the palette closes.

**And** selecting a project result navigates to `/projects/{projectId}` and the palette closes.

---

### AC-12: Frontend — Empty State and Loading

**Given** the palette is open and the user types "zzznomatch",

**Then** after the API returns `{ results: [], total: 0 }`, the palette shows:

```
No results for "zzznomatch"
```

**Given** the palette is open, the user has typed a query, and the API request is in flight,

**Then** a loading indicator (spinner or skeleton) is visible and `aria-live="polite"` announces "Searching…".

**Given** the palette is open and the input is empty (user has not typed yet),

**Then** no API request is made and the results area is empty (no loading indicator, no empty state).

---

### AC-13: Frontend — Accessibility (WCAG 2.1 AA)

**Given** the palette is open,

**When** the accessibility CI gate runs (`axe-core` via Playwright),

**Then** zero WCAG 2.1 AA violations are reported for the search palette.

**And** the palette has `role="dialog"`, `aria-modal="true"`, `aria-label="Global search"`.

**And** results list has `role="listbox"` and each result has `role="option"` with `aria-selected`.

**And** focus is trapped within the palette (Tab does not escape to page content behind the overlay).

**And** closing the palette restores focus to the previously focused element.

---

### AC-14: `check-search-index.ts` CI Lint Rule Continues to Pass

**Given** this story adds new GIN trigram indexes,

**When** `pnpm check-search-index` runs against the updated migration file,

**Then** it exits 0 and reports no violations.

**And** a test in `scripts/check-search-index.test.ts` (existing from Story 2.3) adds cases that verify:
- The new `idx_credentials_name_trgm` index on `name` is correctly classified as safe (not a value-bearing column)
- A hypothetical `CREATE INDEX idx_creds_value_trgm ON credentials USING GIN (value gin_trgm_ops)` is correctly flagged as a violation (regression guard)

---

## File Structure

```
apps/
  api/
    src/
      modules/
        search/
          routes.ts           ← NEW: Fastify route registration
          schema.ts           ← NEW: Zod request/response schemas
          service.ts          ← NEW: DB query logic (pure function)
          routes.test.ts      ← NEW: integration tests (real DB)
  web/
    src/
      lib/
        api/
          search.ts           ← NEW: typed API client function for search
        components/
          shell/
            GlobalSearch.svelte  ← NEW: command palette component
            PrimaryNav.svelte    ← MODIFY: add search icon + Cmd+K hint
      routes/
        (app)/
          +layout.svelte       ← MODIFY: mount GlobalSearch component, handle keyboard shortcut

packages/
  db/
    src/
      migrations/
        0019_global_search_trgm_indexes.sql  ← NEW (number is illustrative)
      schema/
        (no changes — indexes are SQL-only, not Drizzle ORM declarations)

scripts/
  check-search-index.ts        ← EXISTING (Story 2.3): must continue to pass
  check-search-index.test.ts   ← MODIFY: add cases for new trgm index names
```

**Files NOT to touch:**
- `packages/db/src/schema/credentials.ts` — no column changes
- `packages/db/src/schema/projects.ts` — no column changes (tags already added in 2.3)
- `apps/api/src/modules/projects/routes.ts` — search is a separate module
- Any `credential_versions` query path — must not be touched by search

---

## Testing Requirements

### Integration Tests (`routes.test.ts`)

All tests use a real test PostgreSQL database (no DB mocks) — consistent with project convention established in Stories 1.x/2.x.

```
REQUIRED tests (named exactly as shown — these are the CI-checked scenarios):

  Basic functionality:
  ✓ 'should return credential results matching query by name'
  ✓ 'should return project results matching query by name'
  ✓ 'should return results from both types when types param is omitted'
  ✓ 'should filter to credentials only when types=credentials'
  ✓ 'should filter to projects only when types=projects'
  ✓ 'should apply default limit of 20 when limit param is omitted'
  ✓ 'should respect limit param up to max of 50'
  ✓ 'should return 400 when limit exceeds 50'
  ✓ 'should return 400 when q is empty string'

  Relevance ordering:
  ✓ 'should rank exact name match above prefix match above substring match'
  ✓ 'should rank more recently updated results first within same tier'

  Security:
  ✓ 'should return zero results when searching a known credential value (AC-E2a blocker)'
  ✓ 'should return zero results for a user from Org B when searching Org A credentials'
  ✓ 'should return zero results from Org B when searching by a tag that only exists in Org B'
  ✓ 'should return 401 for unauthenticated requests'
  ✓ 'should return 503 when vault is sealed'

  Audit:
  ✓ 'should write a credential.search audit entry when credential results are returned'
  ✓ 'should store actorTokenId (not raw userId) in audit entry'
  ✓ 'should NOT write audit entry when only project results are returned'

  Tag search:
  ✓ 'should return credentials matching a tag substring'
  ✓ 'should return projects matching a tag substring'

  Edge cases:
  ✓ 'should return empty results when no credentials or projects match'
  ✓ 'should handle special characters in query without SQL error'
  ✓ 'should handle Unicode and emoji characters in query without SQL error'
  ✓ 'should handle SQL injection attempt in q parameter without leaking data'
  ✓ 'should handle very long query (200 chars) without error'
  ✓ 'should return 400 when query exceeds 200 chars'
  ✓ 'should return 400 when limit is a non-integer string (e.g. "10abc")'
  ✓ 'should not return archived projects in search results'
  ✓ 'should not return credentials from archived projects in search results'
  ✓ 'should return 503 when vault is sealed (route must NOT be on vault-guard allowlist)'
```

### Frontend Tests (`GlobalSearch.svelte`)

Unit tests using Vitest + `@testing-library/svelte`:

```
  ✓ 'opens when Cmd+K is pressed'
  ✓ 'opens when Ctrl+K is pressed'
  ✓ 'closes when Escape is pressed'
  ✓ 'closes when backdrop is clicked'
  ✓ 'renders credential results with project badge and snippet'
  ✓ 'renders project results with credential count'
  ✓ 'shows loading state during fetch'
  ✓ 'shows empty state when results are empty and query is non-empty'
  ✓ 'does not fire API call when query is empty'
  ✓ 'debounces input — only fires after 200ms of inactivity'
  ✓ 'cancels previous in-flight request when new query is typed (AbortController)'
  ✓ 'navigates to credential page on credential result selection'
  ✓ 'navigates to project page on project result selection'
  ✓ 'highlights matching substring in result names'
  ✓ 'shows expiry badge for credentials expiring within 30 days'
```

---

## Performance Notes

- **Target:** `GET /api/v1/search` p95 ≤ 300ms (architecture NFR — `Secret search/filter: p95 ≤300ms paginated`).
- **Index strategy:** GIN trigram indexes (`gin_trgm_ops`) support `ILIKE '%q%'` with PostgreSQL index scan. At 10,000 credentials (v1 target), this comfortably meets the 300ms target.
- **No external search engine:** PostgreSQL `pg_trgm` is explicitly called out in the architecture as sufficient for v1 scale. Do not introduce Elasticsearch, Typesense, Meilisearch, or any external dependency.
- **Debounce (frontend):** 200ms debounce on input prevents excessive API calls during fast typing. Adjust if UX testing shows it feels sluggish.
- **`LIMIT` default 20:** The command palette shows ≤20 results by default, which limits query result size and serialization cost.

---

## Dev Notes / Common Mistakes to Avoid

| Mistake | Prevention |
|---|---|
| Joining `credential_versions` in the search query | The `credentials` table has all searchable metadata. `credential_versions` has the value material. Never join it. The negative test will catch this. |
| Adding a `value` column search path "just in case" | RS-E2a is absolute: no value search, ever. `check-search-index.ts` + the negative test enforce it. |
| Using `LIKE 'q%'` (prefix only) instead of `ILIKE '%q%'` (substring) | The UX requires substring matching ("stripe" finds "Stripe API Key" and "Old Stripe"). Use `ILIKE '%q%'` which activates the trigram index. |
| Storing raw `userId` in audit `actorTokenId` | Always use `firstActorTokenIdForUser(userId, tx)`. PJ6 invariant — raw user IDs in audit are a security review fail. |
| Skipping the audit write on error | The audit write is fail-closed: if it fails, the search response returns an error. Do not silently swallow audit write failures. |
| Adding Drizzle `index()` declarations for the trigram indexes | These indexes use `USING GIN (... gin_trgm_ops)` which Drizzle does not natively support in ORM notation. Use raw SQL in the migration file only. |
| Post-query org filtering | Org scoping must be in the SQL `WHERE` clause. RLS also enforces it, but the explicit clause is defense-in-depth. Never filter in TypeScript after fetching. |
| Making `GlobalSearch.svelte` a page (`+page.svelte`) | It is a layout-level overlay. Mount in `(app)/+layout.svelte` so it covers all app pages, not just one route. |
| Forgetting focus trap in the search overlay | The WCAG 2.1 AA axe-core gate will catch it, but a missing focus trap also breaks keyboard-only users. Implement before testing. |
| Race condition: slow request 1 overwriting fast request 2 results | Use `AbortController` — every new search call aborts the previous in-flight fetch. Set `const controller = new AbortController()` on each debounced call and pass `signal: controller.signal` to `fetch`. Cancel previous controller before creating a new one. |
| Vault guard allowlist containing the search route | Do NOT add `GET /api/v1/search` to the vault-guard allowlist. The route must return 503 when sealed — test AC-8 explicitly asserts this. |
| Query injection via `q` parameter (SQL injection) | Drizzle ORM's `sql` template literal ALWAYS uses bind parameters. The `q` value must NEVER be string-interpolated into a SQL string. Use `sql\`... ILIKE ${'%' + q + '%'}\`` with proper parameterization, or use Drizzle's `ilike()` helper. Zero tolerance for string interpolation in DB queries. |
| Using `window.addEventListener` without cleanup | `onDestroy` must call `window.removeEventListener('keydown', handleKeydown)` to avoid stacking listeners on layout re-mounts. |

---

## Dependencies

### Relies On

| Story | What is needed |
|---|---|
| 2.1 | `projects` table, `project_memberships` table, RLS policies, project creation API |
| 2.2 | `credentials` table with no `value` column (RS-E2a) — the search invariant depends on this |
| 2.3 | `scripts/check-search-index.ts` CI lint rule, `projects.tags` JSONB column, canonical FR97 pagination helper in `lib/pagination.ts` (not used directly but follow same code style) |
| 1.11 | `SecureRoute` framework, `route-audit.test.ts` CI gate — all new routes must pass the audit gate |
| 2.0 | `AppShell.svelte`, `PrimaryNav.svelte` exist and accept composition — `GlobalSearch.svelte` is added as a sibling component |

### Consumed By

| Consumer | What is consumed |
|---|---|
| `AppShell` / global nav | `GlobalSearch.svelte` command palette + keyboard shortcut |
| Epic 3 (notification inbox) | When notification delivers a link to a credential, users may search to navigate there — no API contract dependency, but search must remain available |
| Story 2.6 (onboarding wizard) | Step 3 copy references global search — no API dependency, purely informational |
| Future API consumers (FR47) | `GET /api/v1/search` is part of the REST API surface; it MUST appear in the OpenAPI spec auto-generated by `@fastify/swagger` |

---

## Out of Scope

The following are explicitly deferred to later stories or epics. Do NOT implement:

- Paginated search results beyond a single page of 50 (scrollable infinite search is v2 UX)
- Search by `expiresAt` range (filter by expiry is Story 2.3 per-project, not global)
- Audit log / security event search (Epic 8 scope)
- Service, certificate, domain search (Epics 4/6 introduce these entity types; extend search then)
- Full-text `tsvector`/`ts_rank` scoring (trigram is sufficient at v1 scale; upgrade path is a later migration)
- "Recent searches" history stored per user (v2 UX feature)
- Keyboard shortcut customization (v2 UX feature)
- Search in machine-user / API context without a browser session (FR47's REST surface is enough; no dedicated machine-user search SDK needed in v1)
