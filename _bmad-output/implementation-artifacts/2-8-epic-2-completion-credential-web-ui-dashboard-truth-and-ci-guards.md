# Story 2.8: Epic 2 Completion — Credential Web UI, Dashboard Truth & CI Guards

Status: done

<!-- Ultimate context engine analysis completed 2026-06-29 — expanded 2026-06-29 with worked examples, extended ACs, and quality guardrails (Failure Mode Analysis, Red Team, Persona Focus Group, Pre-mortem). Closes Epic 2 product gaps from epic-2-retro-2026-06-29.md. -->

## Story

As a vault evaluator using the web UI,
I want to manage credentials end-to-end (list, create, reveal, import), see truthful project and org dashboards, and navigate from global search without dead links,
so that Epic 2 delivers a coherent product experience — not an API-only backend with placeholder pages.

*Covers: FR1, FR7, FR10, FR14, FR17, FR80 (web consumption), AC-E2d (partial), AC-E2f (honest states — now with real data), RS-E2a (CI enforcement).*  
*Source: `_bmad-output/implementation-artifacts/epic-2-retro-2026-06-29.md`*

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Stories 2.0–2.7 merged and passing CI | This story consumes existing APIs, shell components, and schemas — no new credential encryption/search logic. |
| Epic 2 retrospective reviewed | Scope derived from retro action items T1–T5, E3-3 (credential portion only). |
| `@project-vault/shared` credential + dashboard schemas | Reuse `CredentialSummarySchema`, `ProjectDashboardSchema`, etc. — do not redefine shapes inline in `apps/web`. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.8 |
|---|---|
| 2.0 | Established shell, `lib/api/*`, honest placeholders, security invariants (no token/value persistence). **Replace** credentials placeholder copy and route — do not break vault/auth guards. |
| 2.1 | `GET /api/v1/projects`, `GET /projects/:id/dashboard` exist but return **hardcoded zero counts** in `routes.ts` lines 173–174 and `emptyDashboard()`. 2.8 wires real credential aggregates and adds org-wide dashboard endpoint (AC-E2d). |
| 2.2 | Credential CRUD/value/version APIs. Web UI must call these — never bypass encrypt/audit paths. No metadata-only GET exists today — **add in 2.8 (AC-13)**. |
| 2.3 | List/filter/tag APIs + `scripts/check-search-index.ts`. 2.8 adds that script to CI; web list uses paginated list endpoint. Status semantics in `service.ts` CASE (lines 132–136) are canonical. |
| 2.4 | Dependencies, lifecycle fields on credentials. Detail page shows metadata read-only; dependency list read-only optional. |
| 2.5 | Bulk import two-step API. 2.8 ships import UI; enables onboarding `importRouteLive`. |
| 2.6 | Onboarding Step 3 links to `/credentials/import` when live. 2.8 must set `importRouteLive` from layout load once import route exists. |
| 2.7 | `GlobalSearch.svelte` navigates to `/projects/:projectId/credentials/:credentialId` — **route must exist** (currently 404). Test already asserts `goto('/projects/proj-1/credentials/cred-1')`. |
| Epic 3 | Alert counts stay `0`; `/alerts` remains placeholder. Do not block Epic 3 on this story, but complete 2.8 before Epic 3.3 inbox UX. |
| Epic 5 | `projectsWithOverdueRotations` returns empty array + `count: 0` with schema slot — rotations not implemented yet. |

---

## Retro Traceability Matrix

Every retro finding maps to an acceptance criterion:

| Retro finding | AC |
|---|---|
| `check-search-index` not in CI | AC-1 |
| Dashboard counts hardcoded `0` | AC-2, AC-3 |
| AC-E2d org aggregate missing | AC-4 |
| `/credentials` placeholder | AC-5, AC-6 |
| Global search → missing route | AC-7 |
| Bulk import API-only | AC-8 |
| Onboarding dead import link | AC-9 |
| Placeholder copy says "Story 2.2" | AC-10 |
| Story 2.4/2.6 status drift | AC-11 (process — already synced to `done`) |
| No metadata GET for detail page | AC-13 |
| Role-gated UI not specified | AC-14 |
| Value leakage / XSS in web surface | AC-15 |
| N+1 aggregate queries | AC-16 |

**Explicitly out of scope (other retro items):**

- Epic 3 SMTP env vs settings (Story 3.1 / E3-1)
- Epic 1 retrospective (P4)
- Full `architecture.md` secrets→credentials rename (D1 — note in completion only)
- Fine-grained `read:secret_value` permissions (Epic 4)
- Playwright E2E suite
- Retention dry-run operator runbook (`specs/` — offer at completion, not implementation)

---

## Architecture Conflict Resolution

| Source wording | Canonical for 2.8 | Rationale |
|---|---|---|
| Story 2.2: "Frontend / web UI — out of scope" | **In scope for 2.8** — deliberate epic completion story | Retro accepted API/UI split; this story closes it |
| ADR-2.1-08: defer AC-E2d aggregate endpoint | Implement **`GET /api/v1/dashboard`** now for credential/expiry portions; rotations/alerts honestly empty | Data sources for credentials exist; deferral expired |
| Story 2.0 placeholder `/credentials` | Replace with **project-scoped** credential IA under `/projects/[projectId]/credentials/*` | Matches project-centric model (UX-DR1) |
| GlobalSearch navigates to credential detail URL | Implement matching SvelteKit route — do not change search URL shape | 2.7 tests assert that navigation target |
| Onboarding import link `/credentials/import` | Implement at **`/projects/[projectId]/credentials/import`** AND top-level **`/credentials/import`** that requires project selection if no `projectId` | Step 3 href is `/credentials/import` today — must resolve without 404 |

---

## Scenario Fixture Catalog

Use this **shared seed dataset** across API and web tests. Freeze `now` in tests via `vi.setSystemTime` or DB transaction clock where supported.

### Organizations & projects

| Entity | ID (test UUID) | Notes |
|---|---|---|
| Org Alpha | `11111111-1111-4111-8111-111111111111` | Primary test org |
| Org Beta | `22222222-2222-4222-8222-222222222222` | Cross-org isolation tests |
| Project Payments | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | slug `payments`, 3 credentials below |
| Project Infra | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` | slug `infra`, empty credentials |

### Credentials in Payments (assume `now = 2026-06-29T12:00:00.000Z`)

| Name | `expires_at` | Expected `status` (list API) | Bucket for dashboard |
|---|---|---|---|
| `Stripe Secret Key` | `2026-07-15T00:00:00.000Z` | `expiring` | `expiringSoon` / `expiringCount` |
| `Legacy API Token` | `2026-06-01T00:00:00.000Z` | `expired` | `expired` |
| `Internal Service Key` | `null` | `active` | `active` |

**Expected aggregates for Payments:**

- `credentialCount`: 3  
- `expiringCount`: 1 (Stripe only — window is `(now, now+30d]`, exclusive of already-expired)  
- `credentialStats`: `{ active: 1, expiringSoon: 1, expired: 1 }`  
- `isEmpty`: false  
- `suggestedActions`: `[]` (has credentials; drop empty-state actions)

**Expected org dashboard (Org Alpha, same fixture):**

- `totalCredentials`: 3  
- `expiringWithin30Days.count`: 1  
- `expiringWithin30Days.items[0].name`: `"Stripe Secret Key"`  
- `projectsWithOverdueRotations`: `{ count: 0, items: [] }`  
- `unresolvedAlertCount`: 0  

### Import fixture (`.env` upload)

```env
STRIPE_SECRET_KEY=sk_live_redacted_in_tests
NEW_KEY=nk_test_value
DUPLICATE_NAME=will_conflict
```

Assume `DUPLICATE_NAME` already exists as credential name in project → preview shows `conflictsWith` UUID and `suggestedAction: 'new_version'`.

---

## Persona Journeys (Focus Group)

These journeys are **acceptance anchors** — each must be manually smoke-tested in Task 7.

### Alex — Viewer (read-only evaluator)

1. Opens `/projects` → sees Payments card with **Credentials: 3**, **Expiring: 1** (not zeros).  
2. Opens `/projects/{paymentsId}/credentials` → list renders; **no** "Add credential" or "Import" buttons.  
3. Opens credential detail → metadata visible; **no** "Reveal value" button.  
4. Onboarding Step 3 → import link shows **disabled** "coming soon" (viewer cannot import).  
5. Cmd+K → selects Stripe → lands on detail page **200**, not 404.

### Morgan — Member (day-to-day operator)

1. Creates credential via `/projects/{id}/credentials/new` → redirected to detail.  
2. Clicks "Reveal value" → value shown in masked panel; navigating away clears it.  
3. Filters list `status=expiring` → only Stripe row.  
4. Cannot access import UI (403 message, not form).

### Riley — Admin (onboarding + bulk import)

1. Completes onboarding → Step 3 shows **live** link to `/credentials/import`.  
2. Gateway `/credentials/import` → picks Payments → project-scoped import.  
3. Uploads `.env` → preview table (values redacted as `[REDACTED]`) → confirms with `new_version` default → summary with counts.  
4. Org dashboard `/dashboard` → sees expiring list panel with Stripe entry.

---

## Quality Guardrails (Elicitation Synthesis)

### Failure Mode Analysis — mitigations required

| Component | Failure mode | Required mitigation | AC |
|---|---|---|---|
| Project list GET | N+1 per-project COUNT queries | Single batched aggregate query keyed by `project_id` | AC-2, AC-16 |
| Project dashboard | Stale zeros if `emptyDashboard()` left in place | Replace handler body; delete hardcoded path | AC-3 |
| Org dashboard | Cross-org data leak | Use `secureCtx.tx` only; test Org Beta user sees empty/404 | AC-4, AC-12 |
| Import confirm | Preview `importId` expired mid-flow | Surface API `import_expired` code; allow re-upload | AC-8 |
| Global search | 404 on credential select | Implement SvelteKit route before merging | AC-7 |
| Reveal panel | Value persists in DOM after navigation | Clear `$state` on `onDestroy`; test storage spy | AC-6, AC-15 |
| Layout load | `importRouteLive` always false | Set true when admin/owner AND import route exists | AC-9 |
| CI | Developer skips scanner locally | `make ci` + GitHub step fail without it | AC-1 |

### Red Team — security hardening required

| Attack / leak vector | Defense | AC |
|---|---|---|
| XSS via credential `name`/`description` in list | Svelte text interpolation only — **never** `{@html}` on user fields | AC-15 |
| Value in browser storage | No localStorage/sessionStorage; test spies assert zero writes | AC-15 |
| Value in URL or page title | Never append value to `goto`, query params, or `<title>` | AC-15 |
| Import file contents in client logs | No `console.log` of FormData; errors use API codes only | AC-8, AC-15 |
| Clipboard exfiltration after reveal | Copy is explicit user action; clear `$state` on unmount regardless | ADR-2.8-04 |
| Viewer escalates via direct API | UI hides actions; API already enforces — verify 403 in web error states | AC-14 |

### Pre-mortem — story fails if any of these ship

| Failure scenario | Prevention test |
|---|---|
| `make ci` passes but RS-E2a unenforced | Assert Makefile contains `pnpm check-search-index` |
| Projects page still shows all zeros with seeded DB | AC-2 integration test with fixture catalog |
| Search navigates to 404 | Route module exists + GlobalSearch test passes |
| Onboarding import link dead for admin | Layout passes `importRouteLive: true`; link resolves |
| Dashboard violates AC-E2f (fake data) | Rotations/alerts stay zero; credential counts are real |
| Epic 2 marked done with placeholder `/credentials` | AC-5 removes `PlaceholderSection` |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| CI | `pnpm check-search-index` in `make ci` + GitHub CI |
| Project list counts | Real `credentialCount`, `expiringCount` from DB |
| Project dashboard | Real `credentialStats`; `isEmpty`/`suggestedActions` derived from truth |
| Org dashboard API | `GET /api/v1/dashboard` — AC-E2d credential slice |
| Credential web UI | List, create, detail, reveal (member+) under project routes |
| Global search | Credential result opens valid page |
| Bulk import UI | Preview → confirm; admin/owner gated |
| Onboarding | `importRouteLive: true` when import route shipped |
| Placeholders | Update stale Story 2.0/2.2 copy on credentials nav |
| Metadata GET | Dedicated metadata endpoint for detail page |
| Role matrix | Viewer/member/admin UI visibility enforced |
| Security | No value persistence; XSS-safe rendering |
| Performance | Batched aggregates, no N+1 |
| Tests | TDD red-green per `AGENTS.md`; web + API focused tests |

---

### AC-1: RS-E2a CI Enforcement

**Given** `scripts/check-search-index.ts` exists from Story 2.3,  
**When** Story 2.8 is complete,  
**Then**:

1. Add to `Makefile` `ci` target (after `check-rls`, before `test`):

```makefile
pnpm check-search-index
```

2. Add GitHub Actions step in `.github/workflows/ci.yml` immediately after "Check RLS policy coverage":

```yaml
- name: Check search index safety (RS-E2a)
  run: pnpm check-search-index
```

**And** `pnpm check-search-index` exits 0 on the current tree.  
**And** no change to the scanner logic unless required — this AC is pipeline wiring only.

#### Worked example — CI failure

If a developer adds `CREATE INDEX ... ON credentials (encrypted_value)` in a migration, `pnpm check-search-index` exits non-zero with a message naming the offending index. Both `make ci` and GitHub CI must fail before merge.

#### Negative example — do NOT

- Add the step only to GitHub CI but skip `Makefile` (local/CI drift).  
- Gate the step behind an env flag.

---

### AC-2: Project List — Truthful Per-Project Counts

**Given** the Scenario Fixture Catalog credentials in Payments,  
**When** `GET /api/v1/projects` runs for an Org Alpha member,  
**Then** the Payments item includes:

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "name": "Payments",
  "credentialCount": 3,
  "expiringCount": 1,
  "alertCount": 0
}
```

**And** Infra item shows `credentialCount: 0`, `expiringCount: 0`.  
**And** `alertCount` remains **`0`** until Epic 3.

**Implementation guidance:**

- Add `apps/api/src/modules/projects/dashboard-stats.ts` with batched aggregate query — **one query for all visible projects**, not N+1 per project.  
- Reuse the same 30-day window and status semantics as `listCredentials`:

```sql
-- expiringCount: expires_at IS NOT NULL AND expires_at > now() AND expires_at <= now() + interval '30 days'
-- (matches service.ts: expired uses <= now(); expiring uses <= now()+30d and not expired)
```

- Update `apps/api/src/modules/projects/routes.test.ts`: seed fixture catalog, assert non-zero counts.

**Edge cases:**

| Case | Expected |
|---|---|
| Credential expires exactly at `now()` | Counts as `expired`, not `expiring` |
| Credential expires at `now() + 30 days` | Counts as `expiring` (inclusive upper bound per service.ts) |
| Archived project | Excluded from list (existing behavior) |
| Org Beta user | Does not see Org Alpha project counts |

**And** existing FR97 unpaginated project list behavior unchanged (ADR-2.1-06).

---

### AC-3: Project Dashboard — Truthful `credentialStats`

**Given** Payments fixture (3 credentials),  
**When** `GET /api/v1/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/dashboard` runs,  
**Then** response matches:

```json
{
  "data": {
    "credentialStats": { "active": 1, "expiringSoon": 1, "expired": 1 },
    "upcomingRotations": [],
    "monitoredServiceHealth": { "healthy": 0, "degraded": 0, "down": 0 },
    "recentAccessEvents": [],
    "unresolvedAlertCount": 0,
    "isEmpty": false,
    "suggestedActions": []
  }
}
```

**Given** Infra project (zero credentials),  
**When** dashboard runs,  
**Then** `isEmpty: true` and `suggestedActions` includes `import_credentials` (and other empty-state actions per Story 2.1 semantics).

**And** replace `emptyDashboard()` hardcoded zeros — the handler at `routes.ts:207` must call stats helper, not return stub.

**And** `upcomingRotations`, `recentAccessEvents`, `unresolvedAlertCount`, `monitoredServiceHealth` remain empty/zero until Epic 5/3/6 — **not errors** (AC-E2f honest partial).

#### Worked example — web consumption

`apps/web/src/routes/(app)/dashboard/+page.server.ts` already calls `getProjectDashboard`. After AC-3, the dashboard page must show non-zero stat cards when fixture is seeded — update `+page.svelte` if it still renders placeholder zeros from stale copy.

---

### AC-4: Org-Wide Dashboard API (AC-E2d — Credential Portion)

**Given** Org Alpha fixture,  
**When** authenticated viewer+ calls **`GET /api/v1/dashboard`**,  
**Then** return:

```json
{
  "data": {
    "totalCredentials": 3,
    "expiringWithin30Days": {
      "count": 1,
      "items": [
        {
          "id": "<stripe-credential-uuid>",
          "name": "Stripe Secret Key",
          "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "projectName": "Payments",
          "expiresAt": "2026-07-15T00:00:00.000Z"
        }
      ]
    },
    "projectsWithOverdueRotations": { "count": 0, "items": [] },
    "unresolvedAlertCount": 0
  }
}
```

**Schema:** add `packages/shared/src/schemas/org-dashboard.ts`:

```typescript
export const ExpiringCredentialItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  projectId: z.uuid(),
  projectName: z.string(),
  expiresAt: z.iso.datetime(),
})

export const OrgDashboardSchema = z.object({
  totalCredentials: z.number().int().nonnegative(),
  expiringWithin30Days: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(ExpiringCredentialItemSchema),
  }),
  projectsWithOverdueRotations: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(UpcomingRotationSchema), // reuse from dashboard.ts — empty in 2.8
  }),
  unresolvedAlertCount: z.number().int().nonnegative(),
})
```

**Route registration:**

- New `modules/dashboard/routes.ts` registered at prefix `/api/v1/dashboard` with single `GET /` route (preferred over bloating projects module).  
- `secureRoute`, `minimumRole: 'viewer'`, `writeAuditEvent: false`.  
- Classify in `ROUTE_ACTION_CLASSIFICATIONS` + `ROUTE_FILES`.

**Query rules:**

- Org-scoped via RLS (`tx` from SecureRoute).  
- `expiringWithin30Days.items` capped at **20**, ordered by `expires_at ASC`.  
- If org has 25 expiring credentials, `count: 25` but `items.length === 20`.

**Web consumption:** update `apps/web/src/routes/(app)/dashboard/+page.server.ts` to call org dashboard when no project selected (or add org-wide panel above project picker). Show expiring list with links to `/projects/{projectId}/credentials/{id}`.

---

### AC-5: Top-Level `/credentials` — Project Gateway

**Given** credentials are project-scoped,  
**When** user visits `/credentials`,  
**Then** replace `PlaceholderSection` (`credentials/+page.svelte` today) with a **project picker**:

```svelte
<!-- conceptual — match existing projects card styling from projects/+page.svelte -->
<ul>
  {#each data.projects.items as project}
    <li><a href={resolve(`/projects/${project.id}/credentials`)}>{project.name}</a></li>
  {/each}
</ul>
```

**Empty state:** no projects → prompt linking to `/projects/new`.  
**Copy:** "Credentials live inside projects — pick a project to manage secrets."

**And** remove stale copy from `placeholder-copy.ts` credentials entry or repoint to gateway behavior.

---

### AC-6: Project-Scoped Credential Web UI

**Given** user has access to a project,  
**When** they navigate `/projects/[projectId]/credentials`,  
**Then** implement:

#### Route tree

```text
apps/web/src/routes/(app)/projects/[projectId]/
├── credentials/
│   ├── +page.server.ts          # list load: q, tags, status, page
│   ├── +page.svelte             # paginated list, filters, links
│   ├── new/
│   │   └── +page.svelte         # create form → POST credentials
│   ├── import/
│   │   └── +page.svelte         # bulk import (AC-8)
│   └── [credentialId]/
│       ├── +page.server.ts      # metadata load via GET (AC-13)
│       └── +page.svelte         # detail + reveal + version history
```

#### List page — worked example

Request: `GET /api/v1/projects/{id}/credentials?status=expiring&page=1&limit=20`

Render row for Stripe:

| Column | Value |
|---|---|
| Name | Stripe Secret Key |
| Status badge | `expiring` (amber) |
| Tags | (from API) |
| Expires | Jul 15, 2026 |
| Dependencies | icon if `hasDependencies` |

**Never** display credential values in list (RS-E2a).

#### Create page — worked example

```typescript
// POST body
{ "name": "New DB Password", "value": "s3cret!", "description": "Prod read replica", "tags": ["db"] }
// 201 → redirect to /projects/{id}/credentials/{newId}
```

**And** clear value input after submit (success or failure).  
**And** viewer: hide create/import actions (AC-14).

#### Detail page — worked example

1. `+page.server.ts` loads metadata via AC-13 GET.  
2. Member clicks "Reveal value" → client `GET .../value` → show in `<pre class="font-mono">` with copy button.  
3. Versions section from `GET .../versions` — metadata only, no values.

**Security:** revealed value only in component `$state`; clear on navigate/unmount; never localStorage/sessionStorage/URL.

#### API client extensions (`apps/web/src/lib/api/credentials.ts`)

Extend beyond today's `createCredential` only:

```typescript
export function listCredentials(fetchFn, projectId, query) { /* ... */ }
export function getCredential(fetchFn, projectId, credentialId) { /* AC-13 */ }
export function revealCredentialValue(fetchFn, projectId, credentialId) { /* ... */ }
export function listCredentialVersions(fetchFn, projectId, credentialId) { /* ... */ }
```

---

### AC-7: Global Search Deep Link Fix

**Given** `GlobalSearch.svelte` line 86:

```typescript
await goto(resolve(`/projects/${item.projectId}/credentials/${item.id}`))
```

**When** user selects credential result `cred-1` in project `proj-1`,  
**Then** SvelteKit serves `projects/[projectId]/credentials/[credentialId]/+page.svelte` with **200**.

**And** existing test in `GlobalSearch.test.ts:138-145` continues to pass.  
**And** add route-existence test (e.g. import route module in vitest or `routes` contract test).

**Optional enhancement:** project cards on `/projects` link to `/projects/{id}/credentials`.

---

### AC-8: Bulk Import Web UI

**Given** Story 2.5 import APIs,  
**When** admin/owner visits import UI,  
**Then** implement two-step flow:

#### Step 1 — preview

```http
POST /api/v1/projects/{projectId}/credentials/import
Content-Type: multipart/form-data

file=<.env>
```

Preview UI table row example:

| Name | Conflict | Suggested action |
|---|---|---|
| `STRIPE_SECRET_KEY` | existing `Stripe Secret Key` | `new_version` |
| `NEW_KEY` | — | `create_new` |

Values shown as **`[REDACTED]`** only (matches `ParsedImportItemSchema`).

#### Step 2 — confirm

```http
POST /api/v1/projects/{projectId}/credentials/import/confirm
{ "importId": "<uuid>", "defaultAction": "new_version" }
```

Result summary: `imported: 2, newVersions: 1, skipped: 0`.

**Routes:**

- Primary: `/projects/[projectId]/credentials/import`  
- Gateway: `/credentials/import` — project selector → redirect to project-scoped import

**Error handling examples:**

| API code | UI behavior |
|---|---|
| `import_too_large` | Inline error banner, no retry loop |
| `import_expired` | "Preview expired — upload again" |
| `import_not_found` | Same as expired |

**And** viewer/member without admin/owner sees 403 message — not the form.  
**And** do not log file contents client-side.

---

### AC-9: Onboarding Wizard — Import Link Live

**Given** import route exists and user is admin/owner,  
**When** `(app)/+layout.server.ts` loads,  
**Then** return `importRouteLive: true` in layout data passed to onboarding overlay.

Current layout (`+layout.server.ts`) does **not** set this — add:

```typescript
importRouteLive: ['owner', 'admin'].includes(locals.user.orgRole),
```

**And** `OnboardingStep3.svelte` renders active link to `/credentials/import` (existing href line 46).  
**And** viewer role keeps disabled "coming soon" span.

---

### AC-10: Stale Placeholder Copy Cleanup

**Given** Epic 2 credential features are live,  
**When** user views navigation/help copy,  
**Then** replace strings like:

| File | Before | After |
|---|---|---|
| `placeholder-copy.ts:15` | "Credential storage arrives in Story 2.2." | "Choose a project to manage credentials." or remove credentials from placeholder map |
| `dashboard-copy.ts` | deferral labels for live actions | link to `/projects/{id}/credentials/new` |

**Files to check:**

- `apps/web/src/lib/components/shell/placeholder-copy.ts`  
- `apps/web/src/lib/components/dashboard/dashboard-copy.ts`  
- `DashboardPlaceholderGrid` if it still defers credential actions

**And** alerts/health/settings placeholders **unchanged** (Epic 3/6).

---

### AC-11: Process Verification (Retro Hygiene)

**Given** stories 2.4 and 2.6 were reviewed,  
**When** this story completes,  
**Then** confirm story files `2-4-*.md` and `2-6-*.md` remain `Status: done` (synced 2026-06-29).

---

### AC-12: Automated Tests (TDD)

Follow `AGENTS.md` red-green. Minimum test coverage:

**API**

```text
apps/api/src/modules/projects/dashboard-stats.test.ts
  ✓ fixture catalog → project list credentialCount / expiringCount
  ✓ project dashboard credentialStats {1,1,1}
  ✓ GET /api/v1/dashboard total + expiring list (≤20 items)
  ✓ Org Beta user → 0 credentials / empty items (RLS isolation)

apps/api/src/modules/credentials/routes.test.ts (extend)
  ✓ GET /projects/:id/credentials/:credentialId → metadata, no value field
```

**Web**

```text
apps/web/src/lib/api/credentials.test.ts
  ✓ list/create/reveal/get helpers normalize responses

apps/web/src/routes/projects-credentials.test.ts
  ✓ list renders 3 rows from mocked load
  ✓ create form clears value input after submit
  ✓ detail reveal: localStorage/sessionStorage never written
  ✓ import preview → confirm mock flow

apps/web/src/lib/components/shell/GlobalSearch.test.ts
  ✓ credential navigation target (existing test)
```

**And** run before completion:

```bash
pnpm check-search-index
pnpm --filter @project-vault/api test
pnpm --filter @project-vault/web test
pnpm typecheck
```

---

### AC-13: Metadata GET Endpoint (Mandatory)

**Given** no `GET /api/v1/projects/:projectId/credentials/:credentialId` exists today (only list, value, versions),  
**When** detail page loads,  
**Then** add metadata-only route:

```typescript
// Response shape: CredentialDetailSchema (no value field)
secureRoute({
  method: 'GET',
  url: '/:projectId/credentials/:credentialId',
  security: { minimumRole: 'viewer', writeAuditEvent: false },
  // returns 404 if credential not in project/org
})
```

**And** web `+page.server.ts` uses this route — **do not** filter list by name or fetch value endpoint for metadata.

---

### AC-14: Role-Based UI Visibility Matrix

| Surface | viewer | member | admin/owner |
|---|---|---|---|
| Credential list | read | read | read |
| Create credential | hidden | show | show |
| Reveal value | hidden | show | show |
| Import UI | hidden | hidden | show |
| Onboarding import link | disabled | disabled | live (AC-9) |

**And** hiding UI is not sufficient alone — verify API 403 paths render friendly error states when URL accessed directly.

---

### AC-15: Web Security — No Value Leakage, XSS-Safe

**Given** credential name contains `<script>alert(1)</script>`,  
**When** rendered in list or detail,  
**Then** text is escaped (Svelte default) — no script execution.

**Given** user reveals a value,  
**When** they navigate away or close tab,  
**Then**:

- `$state` cleared on unmount  
- `localStorage`, `sessionStorage` never contain value (test with spies)  
- Value never appears in `document.title`, URL, or SSR HTML

**Given** import upload fails,  
**When** error is displayed,  
**Then** only API `code`/`message` shown — not raw file contents.

---

### AC-16: Performance — Batched Aggregates

**Given** org with 50 projects each having credentials,  
**When** `GET /api/v1/projects` runs,  
**Then** credential aggregates use **≤ 2 queries** (projects + batched stats) — not 51.

**And** add test or query-count assertion in `dashboard-stats.test.ts` (mock/spy on tx.execute count acceptable).

---

## ADRs

### ADR-2.8-01: Epic completion via Story 2.8 rather than Epic 2.9

| | |
|---|---|
| **Context** | Retro found API/UI split after Stories 2.2–2.7. Options: new epic vs final Epic 2 story. |
| **Decision** | Story **2.8** under Epic 2, reopen epic to `in-progress` until done. |
| **Rationale** | Same FR coverage; keeps credential work one epic for beta tier 0. |
| **Consequences** | Epic 2 closes only when 2.8 merges. |

### ADR-2.8-02: Project-scoped credential routes (not global `/credentials/:id`)

| | |
|---|---|
| **Context** | GlobalSearch uses project-scoped URL; top-level `/credentials` exists from 2.0. |
| **Decision** | Canonical detail URL: `/projects/[projectId]/credentials/[credentialId]`. Top-level `/credentials` is gateway only. |
| **Rationale** | Matches project-centric IA; API is project-scoped. |
| **Consequences** | All new links use project-scoped paths. |

### ADR-2.8-03: AC-E2d partial delivery — credentials now, rotations/alerts honest empty

| | |
|---|---|
| **Context** | AC-E2d requires rotations and alerts; Epic 5/3 not shipped. |
| **Decision** | Ship org dashboard with real credential/expiry data; rotations/alerts return zero/empty with stable schema. |
| **Rationale** | Better truthful partial than continued all-zero dashboard. |
| **Consequences** | Epic 5/3 extend same endpoint later — no breaking shape changes. |

### ADR-2.8-04: Revealed values live only in ephemeral component state

| | |
|---|---|
| **Context** | ADR-2.0-03 forbids token storage; same applies to credential values. |
| **Decision** | Reveal UI holds value in `$state` only; clear on unmount; optional copy-to-clipboard; no `{@html}`. |
| **Rationale** | Consistent with vault platform security posture. |
| **Consequences** | No "remember revealed value" across navigation. |

### ADR-2.8-05: Mandatory metadata GET (not list-filter workaround)

| | |
|---|---|
| **Context** | Detail page needs stable load path; list filter by name is fragile. |
| **Decision** | Add `GET .../credentials/:credentialId` returning `CredentialDetailSchema`. |
| **Rationale** | GlobalSearch deep links land on detail; SSR needs single-resource fetch. |
| **Consequences** | One additional read route; no value material exposed. |

---

## Tasks / Subtasks

> TDD red-green: failing test first for each task.

- [x] **Task 1: CI wiring (AC-1)**  
  - [x] Add `check-search-index` to `Makefile` `ci` target  
  - [x] Add CI workflow step after RLS check  
  - [x] Verify local `make ci` invokes scanner

- [x] **Task 2: Dashboard stats backend (AC-2, AC-3, AC-4, AC-16)**  
  - [x] Implement `dashboard-stats.ts` with batched aggregates  
  - [x] Wire project list + project dashboard handlers  
  - [x] Add `GET /api/v1/dashboard` + `org-dashboard.ts` schema  
  - [x] API tests using Scenario Fixture Catalog

- [x] **Task 3: Metadata GET + API client (AC-6, AC-13)**  
  - [x] Add `GET .../credentials/:credentialId` route + tests  
  - [x] Extend `lib/api/credentials.ts` + tests

- [x] **Task 4: Credential web routes (AC-5, AC-6, AC-7, AC-14, AC-15)**  
  - [x] Gateway `/credentials`  
  - [x] Project list/create/detail pages with role gates  
  - [x] Reveal security (state clear, storage spies)  
  - [x] GlobalSearch route regression

- [x] **Task 5: Bulk import UI (AC-8, AC-9)**  
  - [x] Project import page + gateway `/credentials/import`  
  - [x] Wire `importRouteLive` in `+layout.server.ts`

- [x] **Task 6: Placeholder copy + org dashboard web (AC-3, AC-4, AC-10)**  
  - [x] Update placeholder + dashboard copy maps  
  - [x] Wire dashboard page to org dashboard API + expiring panel

- [x] **Task 7: Final verification (AC-11, AC-12)**  
  - [x] Persona journey smoke (Alex, Morgan, Riley)  
  - [x] Full focused test run + typecheck  
  - [x] Pre-mortem checklist all green

---

## Dev Notes

### Reuse — Do Not Reinvent

| Need | Use |
|---|---|
| List/filter semantics | `apps/api/src/modules/credentials/service.ts` → `listCredentials` |
| Status CASE expression | Same file lines 132–136 — dashboard buckets must match |
| Pagination | `apps/api/src/lib/pagination.ts` |
| Shared types | `@project-vault/shared` schemas |
| API boundary | `apps/web/src/lib/api/client.ts` + server proxy |
| Auth role in UI | `data.user.orgRole` from `(app)/+layout.server.ts` |
| Import logic | `apps/api/src/modules/credentials/import-service.ts` — UI only |
| Project card styling | `apps/web/src/routes/(app)/projects/+page.svelte` |

### Security Invariants

- Never log credential `value` in web or API client code  
- Reveal requires member+ (hide button for viewer)  
- Import requires admin/owner  
- RS-E2a unchanged — no value in search/list UI  
- HttpOnly cookies only — `credentials: 'include'`

### Project Structure

| Area | Path |
|---|---|
| New web components | `apps/web/src/lib/components/credentials/` |
| API stats | `apps/api/src/modules/projects/dashboard-stats.ts` |
| Org dashboard routes | `apps/api/src/modules/dashboard/routes.ts` |
| Org dashboard schema | `packages/shared/src/schemas/org-dashboard.ts` |
| Tests co-located | `*.test.ts` next to modules |

### Anti-Patterns (Do Not)

- Do not store revealed values in browser storage  
- Do not add credential values to dashboard aggregates beyond counts/names/expiry  
- Do not fake alert or rotation data  
- Do not skip `check-search-index` CI wiring "because tests pass locally"  
- Do not implement Epic 3 inbox or Epic 5 rotation UI in this story  
- Do not load detail metadata via list endpoint or value endpoint  
- Do not run per-project COUNT in a loop (N+1)

---

## Previous Story Intelligence

From **Story 2.7**: GlobalSearch uses client fetch + AbortController; navigation URL is fixed — implement route, don't change GlobalSearch URL. Test at line 138 already encodes expected path.

From **Story 2.6**: Onboarding uses `importRouteLive` prop; wizard is layout-overlay; respect viewer bypass path.

From **Story 2.0**: SSR auth guard + API proxy patterns — all new pages live under `(app)` group with existing layout server load.

From **Story 2.1 ADR-2.1-08**: AC-E2d deferral explicitly expired when credential tables exist — 2.8 delivers credential slice.

From **Story 2.3**: `check-search-index.ts` must pass after any migration — run before and after dashboard work.

---

## References

- Epic 2 retro: `_bmad-output/implementation-artifacts/epic-2-retro-2026-06-29.md`
- AC-E2d / AC-E2f: `_bmad-output/planning-artifacts/epics.md` (Epic 2 constraints)
- Credential API: `apps/api/src/modules/credentials/routes.ts`
- Project API (hardcoded zeros): `apps/api/src/modules/projects/routes.ts`
- Global search: `apps/web/src/lib/components/shell/GlobalSearch.svelte`
- RS-E2a scanner: `scripts/check-search-index.ts`
- Dashboard schema: `packages/shared/src/schemas/dashboard.ts`
- Frontend architecture: `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`
- Repo TDD rule: `AGENTS.md`

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
