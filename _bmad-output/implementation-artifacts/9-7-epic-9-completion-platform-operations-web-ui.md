# Story 9.7: Epic 9 Completion — Platform Operations Web UI

Status: ready-for-dev

<!-- Story derived from epic-9-retro-2026-07-08.md's Finding 1 [REPEAT 4x] + Action Item A9-1.
     Closes the platform-operations web UI gap flagged in near-identical language by Stories 9.1,
     9.2, 9.3, 9.4, and 9.6's own Product Surface Contract sections — every one of those five
     stories is "api"-only with a "TBD" linked-UI-story field, each deferring resolution to "Epic 9
     sprint planning/retrospective." It sat unresolved through all five stories until this retro.
     This is the exact "flag it in prose, catch it at the next retro" pattern this project's own
     retros have now diagnosed four times running (Epic 6's Finding #1/A6-1, Epic 7's A7-1, Epic
     8's Finding 2/A8-1/P8-2, and now Epic 9's Finding 1) — this story is the fix for THIS
     occurrence, following the closure-story precedent already used for Epic 2 (2-8), Epic 3
     (3-4), Epic 5 (5-4/5-5), Epic 6 (6-4), Epic 7 (8-6), and Epic 8 (8-7). `epic-9` stays
     `in-progress` until this story lands (Product Surface Contract G2 gate). `deferred-work.md`'s
     "Web UI gaps" table gains a row for this scope as part of this story's own documentation
     tasks (Task 9) — the worktree this story was authored in branched before the retro's own
     `deferred-work.md` edit was committed to `main`, so this story adds it directly rather than
     assuming it already exists. -->

<!-- Retro-assigned technical debt bundled into this story per epic-9-retro-2026-07-08.md's
     explicit resolution text: TD9-1 (`assetsPresentFromTables` missing `data_erasure_requests`,
     9-1 D8 obligation) is "rolled into 9-7 as an AC" — see AC-F5. TD9-2 (9-4's maintenance-mode
     bypass catching real bugs, not just storage failures) is explicitly "either/or" per the
     retro's own resolution text ("rolled into 9-7's AC list OR tracked in deferred-work.md... if
     neither happens before 9-7 ships, it must be added to deferred-work.md at 9-7's own retro") —
     this story takes the deferred-work.md path (see AC-T2) because narrowing that bypass is a
     backend audit-logging behavior change unrelated to this story's UI surface scope, not a
     UI-screen gap; folding it in here would silently smuggle unrelated backend scope into a
     closure story whose entire premise is "the UI didn't exist," and the retro itself accepts
     this as a valid resolution path. -->

## Story

As Priya, Project Vault's platform operator (self-hosting the instance; PJ9 in the UX design
spec) — and as any future platform operator who is not comfortable operating entirely through
`curl`/Postman against the OpenAPI spec —
I want a web UI for triggering and restoring encrypted backups, configuring system settings and
multi-org provisioning, monitoring resource usage and key-custody/audit-storage risk, understanding
my current version and how to safely upgrade, browsing the live API documentation, and searching my
own privileged actions in a platform-level audit log that is visibly and functionally distinct from
any single organization's audit log,
so that the platform-operations capabilities already fully built and tested on the backend by
Stories 9.1, 9.2, 9.3, 9.4, and 9.6 are actually usable without direct database access or hand-rolled
HTTP calls, and Epic 9 can close without leaving its own operator-facing UI gap untracked for a
fifth epic running.

*Closes: Epic 9 retrospective Finding 1 [REPEAT 4x] / Action Item A9-1.*
[Source: `_bmad-output/implementation-artifacts/epic-9-retro-2026-07-08.md`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — primarily `web`, but honestly declared `both` rather than a falsely-clean `web` because this story requires four small, additive-only backend touches that are genuinely necessary for the UI to function safely and correctly (no new tables, no new migrations, zero schema changes) — see Key Design Decision D2 for the full, closed list. Do not add any backend surface beyond that enumerated list without updating this section. |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story **is** the linked follow-up all five of 9.1/9.2/9.3/9.4/9.6 pointed to via their `TBD` field. |
| **Honest placeholder AC** (if UI deferred) | N/A — nothing is deferred further, except two narrow, explicitly-scoped, already-existing backend limitations carried forward as documented UI copy (no live backup-job progress polling, D3; no literal in-app "click to upgrade" trigger, D4 — self-hosted in-place upgrades are inherently an out-of-band `docker compose up -d` operation, not something a running instance can perform on itself). |
| **Persona journey** | See below |

### Persona journey stub

**Priya (platform operator, self-hosting a multi-org instance):** Priya logs in with the very
first account created on the instance (auto-flagged `is_platform_operator = true` at
registration, Story 9.1 D1) and sees a new **Platform Admin** item in the primary nav that no
other user in any org ever sees. She opens it and lands on `/platform`, a tile list mirroring the
familiar `/settings` pattern. She clicks **Backups**, sees the last night's scheduled backup
succeeded at 2.3 GB, and triggers an ad-hoc backup before a risky maintenance window — the new row
appears in the list immediately, showing "In progress…" until she refreshes a minute later and
sees it flip to a real size with a "Validate" action next to it. She runs a restore-validation
check on last week's backup and sees `assetsPresent` now correctly reports `dataErasureRequests:
true` (previously silently missing, TD9-1) alongside the other four asset checks. She then visits
**Settings**, updates the SMTP `from` address, and separately visits **Organizations** to
provision a second org for a new client team by email, without ever touching a database console.
On **Resource Usage** she sees a banner: "Key custody risk: `kms_type=file` and backups are
enabled — a single lost key file means unrecoverable data" (FR109), and clicks through to fix her
KMS configuration. Ahead of a planned version bump, she opens **Upgrade** and sees she's on
`0.9.0`, that her running migrations are all additive-only, and a link to the live Swagger UI
(only shown because her instance has `ENABLE_API_DOCS=true`) plus a link to the runbook's upgrade
procedure. Finally, investigating a support ticket, she opens **Platform Audit Log** — a page
explicitly labeled "separate from any organization's own audit log" — searches her own
`org.created` action from earlier that day, and runs an integrity-verify check that reports
"14 records verified — no tampering detected."

**Alex (org admin, NOT a platform operator, in a completely unrelated org):** Alex logs in and
never sees a "Platform Admin" nav item at all — it's conditionally rendered only for
`isPlatformOperator` users. If Alex directly navigates to `/platform/backups` by guessing the URL,
the page loads with a "This page requires platform operator privileges" notice and no backup data
of any kind, matching the backend's own `403 platform_operator_required` on every underlying
endpoint (defense in depth: nav hides it, page-level gate blocks it, API enforces it a third time).

---

## Background: What Already Exists (Read Before Coding)

This story adds a web UI (plus four small, explicitly-scoped backend touches, D2) on top of an
already-shipped, already-tested backend. Do not re-implement, re-validate, or "helpfully" extend
any backend behavior described below beyond what D2 explicitly lists — treat
`apps/api/src/modules/backup/`, `apps/api/src/modules/platform-admin/`, and
`apps/api/src/modules/platform-audit/` as stable, already-reviewed dependencies. This section
exists so the dev agent does not have to re-read all of 9.1/9.2/9.3/9.4/9.6 to find these facts.

### Full endpoint inventory this story's UI consumes

| Endpoint (relative) | Full path | Registered by (`app.ts` prefix) | Response envelope | Role gate | MFA | Source story | Consumed by AC group |
|---|---|---|---|---|---|---|---|
| `GET /auth/me` (existing, **extended** by this story, D2.1) | `/api/v1/auth/me` | `authRoutes`, `/api/v1/auth` | `{data:{...}}` | any authenticated user | no | 1.7, extended by this story | A |
| `POST /backup/trigger` | `/api/v1/admin/backup/trigger` | `backupRoutes`, `/api/v1/admin` | `{data:{...}}` | platform operator | **no** | 9.1 | D |
| `GET /backups` (existing, **extended** by this story, D2.2) | `/api/v1/admin/backups` | `backupRoutes`, `/api/v1/admin` | `{data:{items}}` | platform operator | no | 9.1, extended by this story | C |
| `POST /backups/:filename/restore` | `/api/v1/admin/backups/:filename/restore` | `backupRoutes`, `/api/v1/admin` | `{data:{...}}` | platform operator | no | 9.1/9.6 | E |
| `POST /backups/:filename/validate` (existing, **extended** by this story, D2.3) | `/api/v1/admin/backups/:filename/validate` | `backupRoutes`, `/api/v1/admin` | `{data:{...}}` | platform operator | no | 9.1, extended by this story | F |
| `GET /settings` | `/api/v1/admin/settings` | `settingsRoutes`, `/api/v1/admin` | **unwrapped** (no `data` key) | platform operator | **yes** | 9.2 | G |
| `PUT /settings` | `/api/v1/admin/settings` | `settingsRoutes`, `/api/v1/admin` | **unwrapped** | platform operator | yes | 9.2 | G |
| `POST /orgs` | `/api/v1/admin/orgs` | `orgsRoutes`, `/api/v1/admin` | **unwrapped** | platform operator | yes | 9.2 | H |
| `GET /orgs` | `/api/v1/admin/orgs` | `orgsRoutes`, `/api/v1/admin` | **unwrapped** | platform operator | yes | 9.2 | H |
| `GET /resource-usage` | `/api/v1/admin/resource-usage` | `resourceUsageRoutes`, `/api/v1/admin` | **unwrapped** | platform operator | yes | 9.2 | I |
| `GET /ready` (existing, public, **not modified**) | `/ready` (bare, no `/api/v1` prefix) | `healthRoutes`, root | bare `{status, warnings?}` | none (public) | n/a | 1.3, extended by 9.2 (`warnings`) | B, I |
| `GET /health` (existing, public, **not modified**) | `/health` (bare, no `/api/v1` prefix) | `healthRoutes`, root | bare `{status, version}` | none (public) | n/a | 1.3 | J |
| `GET /openapi.json` (existing, conditionally registered) | `/api/v1/openapi.json` | `openapiRoutes`, `/api/v1` (only when `ENABLE_API_DOCS` truthy) | raw OpenAPI doc | none (public when enabled) | n/a | 9.3 D5 | J |
| `GET /docs` (existing, conditionally registered) | `/api/v1/docs` | `swaggerUi`, routePrefix (only when `ENABLE_API_DOCS` truthy) | HTML | none (public when enabled) | n/a | 9.3 D5 | J |
| `GET /audit/events` | `/api/v1/platform/audit/events` | `platformAuditRoutes`, `/api/v1/platform` | `{data:{items,...pagination}}` | platform operator | yes | 9.4 | K |
| `GET /audit/verify` | `/api/v1/platform/audit/verify` | `platformAuditRoutes`, `/api/v1/platform` | `{data:{...}}` | platform operator | yes | 9.4 | L |
| `POST /maintenance-mode` | `/api/v1/platform/maintenance-mode` | `platformAuditRoutes`, `/api/v1/platform` | bare (no `data` wrapper) | platform operator | yes | 9.4 | M |
| `GET /maintenance-mode` (**new**, D2.4) | `/api/v1/platform/maintenance-mode` | `platformAuditRoutes`, `/api/v1/platform` | `{data:{...}}` | platform operator | no (read-only) | new, this story | M |

**Two response-envelope inconsistencies to watch for (pre-existing, do not "fix" them):**
`modules/platform-admin/` routes (`settings`, `orgs`, `resource-usage`) return their payload
**unwrapped** (no top-level `data` key), while `modules/backup/` and `modules/platform-audit/`
routes wrap in `{data: ...}`. `apiFetch`'s existing `parseApiEnvelope()`
(`apps/web/src/lib/api/client.ts`) already handles both transparently (`'data' in body ? body.data
: body`) — do not add any special-casing in new API client code, just call `apiFetch<T>(...)` and
trust it.

**No `jobId`-status-poll endpoint exists** for `POST /backup/trigger`'s returned `{jobId,
status:'running'}` — see D3.

### Existing conventions this story must reuse, not reinvent

- **`DataTable.svelte`** (`apps/web/src/lib/components/tables/DataTable.svelte`) — reuse for the
  backups list, orgs list, and platform-audit-events list rather than hand-rolling a fourth
  `<table>` markup block.
- **`ConfirmDeleteButton.svelte`** (`apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte`)
  — the two-step "click once to arm, click again to confirm" pattern already used by Stories 6.4,
  8.6, and 8.7. Reuse its exact interaction model (adapt the label props; it is not
  delete-specific despite the name) for: trigger backup, activate/deactivate maintenance mode.
- **`TypedConfirmInput.svelte`** (`apps/web/src/lib/components/forms/TypedConfirmInput.svelte`) —
  reuse for the restore-backup confirmation (the operator must type the exact filename to arm the
  restore button), matching the existing precedent for irreversible actions (8.7's pseudonymize
  and erasure-execute flows).
- **`PageAlertBanner.svelte`** (`apps/web/src/lib/components/PageAlertBanner.svelte`) — reuse for
  the sealed-vault and "platform operator privileges required" full-page states.
- **`MfaAwareErrorAlert.svelte`** (`apps/web/src/lib/components/MfaAwareErrorAlert.svelte`) — reuse
  for any `mfa_required` 403 surfaced by the MFA-gated mutations (settings PUT, org create,
  maintenance-mode POST). Note: `backup/trigger`, `backups/:filename/restore`, and
  `backups/:filename/validate` do **not** set `requireMfa: true` in the current shipped code
  (confirmed by direct inspection of `apps/api/src/modules/backup/routes.ts`) — do not assume MFA
  gating on the backup screens; only settings/orgs/resource-usage/audit/maintenance-mode routes
  require it. This asymmetry is pre-existing and out of scope to change.
- **`requireUser(locals)`** (`apps/web/src/lib/server/require-user.ts`) — call before any new
  `+page.server.ts`'s platform-operator check.
- **`ApiClientError`** (`apps/web/src/lib/api/client.ts`) — the existing pattern of catching a
  `401`/`403`/`409`/`422`/`429`/`503` and mapping it to a friendly page state.
- **`/settings/+page.svelte`**'s tile-list pattern (`<ul class="divide-y ...">` of `<a>` rows) —
  this story's new `/platform/+page.svelte` landing page reuses the identical markup structure for
  its own four tiles (do not invent a fifth visual pattern for what is functionally the same kind
  of page).
- **`isProtectedAppPath()`** (`apps/web/src/lib/server/auth-guard.ts`) — must gain `/platform` so
  the existing global sealed-vault redirect (`hooks.server.ts`'s `redirectIfVaultUnavailable`)
  covers every new route automatically, the same way it already covers `/dashboard`, `/settings`,
  etc.

---

## Retro Traceability Matrix

| Finding | Source | AC group |
|---|---|---|
| No web UI exists for backup/restore admin (trigger, list, restore, validate) | 9.1/9.6 Product Surface Contract ("TBD" gap); `epic-9-retro-2026-07-08.md` Finding 1 | C, D, E, F |
| No web UI for system settings / multi-org / resource usage | 9.2 Product Surface Contract; retro Finding 1 | G, H, I |
| No web UI for version/upgrade info or an in-app API-docs browser | 9.3 Product Surface Contract; retro Finding 1 | J |
| No web UI for the Platform Operator Audit Log, and no UI enforcement of PJ9's "visibly distinct from the per-org log" requirement | 9.4 Product Surface Contract; retro Finding 1; epics.md `PJ9 — Cross-log search` note | K, L, M |
| `assetsPresentFromTables` never extended for `data_erasure_requests` (9-1 D8 obligation) | Retro Finding 5 / TD9-1 / Action Item A9-3 | F |
| `/settings` placeholder copy stale relative to shipped settings API | Retro Finding 7 / Action Item A9-4 | T |
| 9-4 maintenance-mode bypass scope too broad (adversarial-review high finding, no trigger condition) | Retro Finding 6 / TD9-2 / Action Item A9-6 | T (documented as deferred-work.md entry, not fixed here — see D8) |
| Epic 9's UI gap had no `deferred-work.md` row going into this retro | Retro Finding 1 / Action Item A9-1 | T |

*(This story's scope is deliberately narrow to the UI gap Finding 1 identifies, plus the two named
technical-debt items the retro explicitly rolled into it (TD9-1, TD9-2). The retro's other Epic 9
findings — the `check-psc-tbd-tracking` CI gate (Finding 2, already built by the retro session
itself, not a story), Story 8-6's outstanding retroactive adversarial review (Finding 3, tracked
separately as `8-8`), and the retro-cadence process finding (Finding 4) — are explicitly **not**
bundled into this story. Do not fold them in here.)*

---

## Key Design Decisions

**Read this section before writing any code.**

### D1 — Route structure: a new top-level `/platform` section, distinct from org `/settings`

Platform-operator status (`users.is_platform_operator`) is an authorization axis completely
orthogonal to org role (`orgRole: 'owner'|'admin'|'member'|'viewer'`) — a platform operator is
simultaneously a regular member of exactly one org (Story 9.1 D1) and can also see instance-wide
data no org role ever grants. Nesting these screens under the existing org-scoped `/settings` (the
way 8.7 nested `/settings/audit/*`) would conflate two unrelated authorization models on one route
tree. **Decision:**

- New top-level route group `/platform`, gated on `isPlatformOperator`, not `orgRole`.
- `/platform` — **landing page**: tile list (mirrors `/settings/+page.svelte`'s pattern) linking to
  the four areas below, plus a warnings banner sourced from `GET /ready`'s `warnings` array (AC
  group B).
- `/platform/backups` — **Backups**: list/trigger/restore/validate (AC groups C, D, E, F).
- `/platform/settings` — **System Settings**: SMTP/backup-override/notification-defaults/
  instance-policy form (AC group G).
- `/platform/settings/orgs` — **Organizations**: multi-org list + create (AC group H). Nested under
  `/settings` (not a sibling top-level tile) because it is conceptually "instance configuration,"
  matching 8.7's D1 precedent of nesting closely-related admin concerns one level deep rather than
  cluttering the top-level tile list.
- `/platform/settings/resource-usage` — **Resource Usage**: read-only dashboard (AC group I),
  nested alongside `orgs` for the same reason.
- `/platform/upgrade` — **Version & Upgrade**: version display, migration-safety explainer,
  conditional API-docs link (AC group J).
- `/platform/audit` — **Platform Operator Audit Log**: search/verify/maintenance-mode (AC groups
  K, L, M). Explicitly a sibling of `/platform`, not nested under `/settings/audit` (the existing
  **org-scoped** audit log) — the two must never share a route prefix, reinforcing PJ9's "visibly
  distinct" requirement at the URL level, not just in page copy.
- A new "Platform Admin" primary-nav item (`nav-model.ts`) appears only when
  `locals.user.isPlatformOperator` is `true`; it links to `/platform`.

### D2 — The closed list of backend touches (surface scope = `both`, not `web`)

Exactly four small, additive-only backend changes are required. No others are in scope. Each is
justified individually; do not add a fifth without updating the Product Surface Contract section.

**D2.1 — Expose `isPlatformOperator` on `GET /api/v1/auth/me`.** The backend already computes
`authContext.isPlatformOperator` (`apps/api/src/@types/fastify.d.ts`, populated at JWT-verification
time from `users.is_platform_operator`) but the `/me` handler
(`apps/api/src/modules/auth/routes.ts:413-434`) never includes it in the response, and
`authMeResponseSchema` (`apps/api/src/modules/auth/schema.ts:86`) has no field for it. Without this,
the web app's `AuthUser`/`locals.user` (populated via `resolveAuthContext()` →
`getCurrentUser()` → `GET /auth/me`, `apps/web/src/lib/server/auth-guard.ts`) has **no way at all**
to know if the logged-in user is a platform operator — the nav item and every page-level gate in
this story are impossible to build without this one field. Add `isPlatformOperator: z.boolean()`
to `authMeResponseSchema`'s `data` object and `authContext.isPlatformOperator` to the handler's
returned object. Zero schema/migration change (the column already exists, shipped by 9.1).

**D2.2 — Add `status` and `errorMessage` to `GET /admin/backups`'s list items.** Direct inspection
of `packages/db/src/schema/backup-runs.ts` shows `backup_runs.status` (`running`/`succeeded`/
`failed`) and `backup_runs.error_message` columns already exist and are already populated
(`service.ts`'s `restoreFromBackup`/backup-snapshot worker set them), but `listBackups()`
(`apps/api/src/modules/backup/service.ts:377-396`) selects neither, and `BackupListItemSchema`
(`apps/api/src/modules/backup/schema.ts:38-44`) has no field for either. Since `listBackups()`
has no `WHERE status = ...` filter at all, a currently-running or a failed backup row is **already
present** in every `GET /admin/backups` response today — it is simply indistinguishable from a
successful one except by `sizeBytes` happening to be `null`, which is fragile and undocumented.
Add `status: z.enum(['running','succeeded','failed'])` and `errorMessage: z.string().nullable()`
to `BackupListItemSchema`, select both columns in `listBackups()`, and map them through unchanged.
This is the difference between a backup screen that can tell an operator "this backup failed:
`<reason>`" versus one that silently shows a blank/null row and lets the operator believe nothing
is wrong. Zero schema/migration change (columns already exist, shipped by 9.1/9.6).

**D2.3 — Add `dataErasureRequests` to backup-validate's `assetsPresent` (TD9-1).** Per the retro's
explicit instruction, extend `BackupAssetsPresent`/`assetsPresentFromTables()`
(`apps/api/src/modules/backup/dump-inspect.ts`) and `BackupAssetsPresentSchema`
(`apps/api/src/modules/backup/schema.ts:114-119`) with a fifth boolean field,
`dataErasureRequests: tables.has('data_erasure_requests')`, matching the exact pattern of the four
existing fields. See AC-F5 for full detail. Zero schema/migration change (checks an existing table
name against existing pg_dump text output).

**D2.4 — New `GET /api/v1/platform/maintenance-mode` status endpoint.** No GET endpoint exists
anywhere to read the *current* state of platform-audit maintenance mode — only
`POST /platform/maintenance-mode` exists, which returns the result of whichever action was just
taken but tells you nothing if you load the page fresh. Maintenance mode is a fail-closed-bypass
safety valve (Story 9.4 AC-15/AC-16): an operator toggling it **blind**, with no way to see whether
it is currently active before deciding to activate or deactivate, is a genuine operational hazard
this story must not ship. Add a new `GET /maintenance-mode` route to
`apps/api/src/modules/platform-audit/routes.ts`, backed by a new `getMaintenanceModeStatus(tx)`
function in `maintenance-mode.ts` that selects the single row from `platformAuditMaintenanceState`
(reusing the exact same table `isMaintenanceModeActive()` already reads) plus a
`count(*)` from `platformAuditPendingEntries`. Response:
`{ data: { active: boolean, reason: string | null, activatedAt: string | null, deactivatedAt:
string | null, pendingEntriesCount: number } }`. Security block: `requireOrgScope: false,
requirePlatformOperator: true, requireMfa: false, writeAuditEvent: false` (a read has no reason to
require MFA, matching `GET /audit/events`'s precedent). This is the **only** genuinely new
capability this story adds to the backend — everything else in D2 is exposing data that already
exists. Zero schema/migration change (reads existing tables from 9.4's migration 0041).

**Do not** add any other backend route, table, column, or migration. In particular: do **not**
add a `jobId`-status-poll endpoint for backups (D3), do **not** add an in-app upgrade-trigger
endpoint (D4), and do **not** narrow the 9-4 maintenance-mode bypass scope (D8/TD9-2) as part of
this story.

### D3 — No live backup-job progress polling: an accepted, documented UI limitation

`POST /backup/trigger`'s `{jobId, status:'running'}` response has no corresponding
`GET /backup/jobs/:jobId` (or any other) endpoint to poll. Adding one is out of scope (D2 is a
closed list). **Decision:** the trigger button shows an optimistic "Backup triggered — refresh the
list below to see progress" toast/inline message immediately on `202`, then the operator manually
reloads (or the page's own `load` re-runs on navigation) `GET /admin/backups` to see the new row —
which, thanks to D2.2, now shows `status: 'running'` distinctly from `'succeeded'`/`'failed'`. No
auto-polling/auto-refresh interval is required or expected in v1; do not build one.

### D4 — The "version-upgrade trigger" is informational, not an in-app upgrade button

Self-hosted in-place upgrades happen via an operator running `docker compose up -d` with a newer
image *outside* the currently-running instance (epics.md AC-E9b; Story 9.3's entire migration-guard
design assumes migrations run in a separate one-shot `migrate` container *before* the API process
starts serving traffic). A running API instance has no mechanism to replace its own container
image — there is no meaningful "upgrade" action a web UI button could perform. **Decision:**
`/platform/upgrade` is an informational page: current version (from the existing public
`GET /health`), a short explainer of the additive-only migration-safety guarantee (linking to
`docs/runbook.md § Upgrades`), and the conditional API-docs link (D5). It has zero mutating
actions and zero new backend routes. Do not build (or imply via copy) a literal "click here to
upgrade" control.

### D5 — API docs reachability: probe, don't assume

`GET /api/v1/docs` and `GET /api/v1/openapi.json` are **conditionally registered** — only when
`docsEnabled({enableApiDocs: env.ENABLE_API_DOCS, nodeEnv: env.NODE_ENV})` is true
(`apps/api/src/app.ts:184-187`); otherwise they are not registered at all and return a plain `404`
(deliberate, per Story 9.3 D5's "no information leak" design). The web app cannot know
`ENABLE_API_DOCS`'s value directly (it's an API-process env var, not exposed anywhere). **Decision:**
`/platform/upgrade/+page.server.ts`'s `load` function does a server-side `fetch('/api/v1/openapi.json')`
(via the existing SvelteKit → API proxy, same `fetch` used by every other `+page.server.ts`) and
checks `response.ok`: `200` → render a live "Open API Documentation (Swagger UI)" link to
`/api/v1/docs`; `404` → render a disabled-looking note: "API documentation browsing is not enabled
on this instance (`ENABLE_API_DOCS`)." Treat any other status (e.g. a `503` sealed-vault response)
the same as "not available right now," not as a hard page error.

### D6 — Sealed-vault handling: global redirect for page loads, per-action handling for mutations

`isProtectedAppPath()` (`apps/web/src/lib/server/auth-guard.ts`) already drives
`hooks.server.ts`'s `redirectIfVaultUnavailable` — every path in that list gets redirected to
`/vault` before any page-level code runs, if the vault is sealed/uninitialized. **Decision:** add
`/platform` to `isProtectedAppPath()`'s array so every new route under this story inherits that
global redirect for free on page load — do not re-implement sealed-vault detection in each new
`+page.server.ts`'s `load` function. However, every backend route this story's UI calls still
declares its own `503` sealed-vault response schema (the vault can seal *during* an active
session, after the page already loaded) — every mutating action (trigger/restore/validate backup,
save settings, create org, activate/deactivate maintenance mode) must still catch an `ApiClientError`
with `status === 503` and show a friendly "The vault was sealed while you were on this page —
<a href="/vault">unseal it</a> to continue" message, exactly like the existing dashboard/credential
pages already do for their own mutations.

### D7 — jscpd zero-duplication risk: extract shared gate primitives up front

This story adds **seven** new pages that each need the identical "is this user a platform
operator?" gate (five under `/platform/*` proper, two nested under `/platform/settings/*`). Building
seven nearly-identical `if (!user.isPlatformOperator) return { allowed: false }` blocks plus seven
nearly-identical "This page requires platform operator privileges" `{#if !data.allowed}` markup
blocks is exactly the shape of duplication that has tripped `pnpm jscpd`'s zero-clone CI gate on
three of the last four completion stories (6-4, 8-5, 8-7 — see their Dev Agent Records). **Decision:**
before writing any of the seven pages, create:

- `apps/web/src/lib/server/require-platform-operator.ts` exporting a single
  `platformOperatorGate(locals): { allowed: true; user: AuthUser } | { allowed: false }` helper
  (calls `requireUser(locals)` internally, then checks `.isPlatformOperator`).
- A shared `PlatformOperatorRequiredNotice.svelte` component (in
  `apps/web/src/lib/components/`) rendering the "This page requires platform operator privileges"
  markup with a "← Back to Dashboard" link, parameterized by nothing (it is always the same
  message) — used by all seven pages' `{#if !data.allowed}` branch.

Every one of the seven `+page.server.ts` files calls `platformOperatorGate(locals)` first; every
one of the seven `+page.svelte` files renders `<PlatformOperatorRequiredNotice />` when
`!data.allowed`. Do not let seven independent copies accumulate before running `pnpm jscpd`.

### D8 — TD9-2 (9-4 maintenance-mode bypass scope) is tracked, not fixed, by this story

The retro's own resolution text for this finding is explicitly either/or: "rolled into 9-7's AC
list OR tracked in deferred-work.md as a named item." Narrowing `writePlatformAuditEntryOrFailClosed`'s
maintenance-mode bypass to trigger only on genuine storage failures (not any write failure,
including real application bugs) is a backend audit-logging behavior change with no UI-visible
surface — it does not belong in a story whose entire premise is "the UI screens didn't exist yet."
This story instead adds a `deferred-work.md` entry naming it explicitly (AC-T2), satisfying the
retro's own "if neither happens before 9-7 ships, it must be explicitly added to deferred-work.md
at 9-7's own retro" fallback — done proactively here rather than left for a future retro to catch
a fifth time.

---

## Acceptance Criteria

### AC Group A — Platform-operator identity exposure & navigation gating

**AC-A1 — `GET /auth/me` includes `isPlatformOperator`.**
**Given** a user who registered as the very first account on the instance (auto-flagged
`is_platform_operator = true` per Story 9.1's bootstrap logic),
**When** they call `GET /api/v1/auth/me`,
**Then** the response's `data` object includes `isPlatformOperator: true` alongside the existing
fields (`userId`, `orgId`, `orgRole`, etc.).

**Example (positive):** the platform operator logs in; `curl -b cookies.txt
https://vault.example.com/api/v1/auth/me` returns `{"data":{"userId":"...","orgRole":"owner",
"isPlatformOperator":true,...}}`.

**Example (edge — regular user):** a second user registers into a different org (not the
first-ever account); their `GET /auth/me` response includes `"isPlatformOperator":false`.
`authMeResponseSchema` marks the field required (not optional) — a client that used to tolerate a
missing field must not silently treat `undefined` as falsy by accident; the field is always
present as an explicit boolean.

**AC-A2 — "Platform Admin" nav item renders only for platform operators.**
**Given** `locals.user.isPlatformOperator === true`,
**When** any authenticated page under `(app)` renders `PrimaryNav.svelte`,
**Then** a "Platform Admin" item (`mobileLabel: 'Platform'`) appears in the nav, linking to
`/platform`, after the existing "Settings" item.

**Example (positive):** Priya (platform operator) sees six nav items: Dashboard, Projects,
Credentials, Alerts, Health, Settings, **Platform Admin**.

**Example (edge — regular user):** Alex (org admin, not a platform operator) sees exactly the
five pre-existing nav items — no "Platform Admin" entry, no dead link, no disabled-but-visible
item. `getPrimaryNavItems()` must take `isPlatformOperator: boolean` as a parameter and
conditionally append the item, not filter it client-side after always including it (which would
briefly flash the item during hydration).

**AC-A3 — Direct navigation to any `/platform/*` route by a non-platform-operator shows a gated
notice, not a 404 or a crash.**
**Given** a logged-in user with `isPlatformOperator: false`,
**When** they navigate directly to `/platform`, `/platform/backups`, `/platform/settings`,
`/platform/settings/orgs`, `/platform/settings/resource-usage`, `/platform/upgrade`, or
`/platform/audit` (by URL, bookmark, or back-button — not via the nav, which never shows the link
to them),
**Then** each page's `load` function (via the shared `platformOperatorGate()` helper, D7) returns
`{ allowed: false }` and the page renders `<PlatformOperatorRequiredNotice />` with **zero**
platform data fetched or displayed (no backend calls made at all for the gated content — only the
gate check itself, which is a pure client-side field check on already-loaded `locals.user`, runs).

**Example (positive):** Alex types `/platform/backups` into the address bar; the page renders the
notice; no `GET /api/v1/admin/backups` network request appears in the browser's network tab at
all (the `load` function returns before ever calling the backup API client).

**Example (edge — session role change mid-visit):** Priya is demoted from platform operator by
direct DB intervention (out of band; there's no in-app "revoke platform operator" flow in v1)
while she has `/platform/backups` open in a stale tab. Her next server-rendered navigation
(including a hard refresh) re-runs `load`, re-fetches `/auth/me` via the existing session
middleware, and shows the gated notice — session data is never cached client-side in a way that
would let a stale `isPlatformOperator: true` persist past the next full page load.

**AC-A4 — Backend defense-in-depth: even if a UI gate were bypassed, every underlying endpoint
independently rejects non-platform-operators with `403`.**
**Given** a non-platform-operator's valid session cookie,
**When** they call any of `POST /admin/backup/trigger`, `GET /admin/backups`,
`POST /admin/backups/:filename/restore`, `POST /admin/backups/:filename/validate`,
`GET`/`PUT /admin/settings`, `POST`/`GET /admin/orgs`, `GET /admin/resource-usage`,
`GET /platform/audit/events`, `GET /platform/audit/verify`, `POST`/`GET /platform/maintenance-mode`
directly (bypassing the web UI entirely, e.g. via `curl`),
**Then** every one returns `403 { code: 'platform_operator_required', ... }` — this is pre-existing
behavior (`requirePlatformOperator()`, `apps/api/src/plugins/require-platform-operator.ts`); this
AC exists to require an **integration test asserting it explicitly for the one new endpoint this
story adds** (`GET /maintenance-mode`, D2.4) and to require this story's own test suite to
**not** weaken, mock around, or bypass this check anywhere in its new frontend code (e.g. no
client-side-only gate that trusts an unverified cookie claim).

**Example (positive):** a machine-user API key (never platform-operator-eligible per Story 9.1
D1's scope) attempting `GET /api/v1/platform/maintenance-mode` gets `403`.

**Example (edge — cross-org platform operator boundary):** the platform operator account belongs
to exactly one "home" org (Story 9.1 D1) but every platform-admin/platform-audit endpoint is
`requireOrgScope: false` — confirm (via existing 9.2/9.4 tests, not new ones needed) that a
platform operator's own `orgId` never silently scopes any of these instance-wide responses; this
AC's new test only needs to add the missing `403` coverage for the one new route, not re-verify
the other nine already-tested routes.

---

### AC Group B — Platform Admin landing page (`/platform`)

**AC-B1 — Landing page renders a tile per admin area.**
**Given** an authenticated platform operator,
**When** they visit `/platform`,
**Then** the page renders a tile list (reusing `/settings/+page.svelte`'s markup pattern) with
four tiles: **Backups** (→ `/platform/backups`), **System Settings** (→ `/platform/settings`),
**Version & Upgrade** (→ `/platform/upgrade`), **Platform Operator Audit Log** (→
`/platform/audit`) — each with a one-line description. "Organizations" and "Resource Usage" are
**not** separate top-level tiles (they are reached via links inside the System Settings page,
matching D1's nesting decision) — do not add six tiles when the route structure specifies four.

**Example (positive):** the rendered page has exactly four `<a>` tile rows, each resolving via
`resolve()` (SvelteKit's typed path helper, matching every other tile-list page in this app) to a
real, non-404 route.

**Example (edge — empty/degenerate state):** there is no "empty state" for this page — it always
renders the same four static tiles regardless of any backend data (no dynamic content on this
page itself), so there is no loading spinner or error state to design for `/platform` itself.

**AC-B2 — Landing page surfaces `/ready`'s operational warnings as a banner.**
**Given** the backend's `GET /ready` currently returns `{status: 'ready', warnings: [...]}`
containing one or both of `'audit_storage_critical'` or `'key_custody_risk'` (Story 9.2 AC-18/
AC-E9d),
**When** the platform operator loads `/platform`,
**Then** the page fetches `/ready` server-side and renders a warning banner above the tile list
for each active warning, using human copy: `'audit_storage_critical'` → "Audit log storage is at
critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`." (link to
`/platform/settings/resource-usage`); `'key_custody_risk'` → "Master key custody risk: a single
lost key file means unrecoverable data, or the key hasn't been rotated recently." (link to
`/platform/settings`).

**Example (positive):** `GET /ready` returns `{"status":"ready","warnings":["key_custody_risk"]}`;
the landing page shows exactly one amber banner with the key-custody copy and a working link.

**Example (edge — no warnings, or `/ready` itself fails):** `GET /ready` returns
`{"status":"ready"}` with no `warnings` key at all (the common case) → no banner renders, page
looks identical to AC-B1's base case. **Edge (network/parse failure):** if the `/ready` fetch
itself throws or returns a non-JSON body, the landing page must not crash — catch the error,
render zero banners (fail open to "no known warnings," not to a scary error state for a
best-effort banner), and log nothing user-visible; the four tiles still render regardless.

**Example (edge — both warnings active simultaneously):** `warnings: ["audit_storage_critical",
"key_custody_risk"]` renders both banners stacked, each independently dismissible-free (no
dismiss action in v1 — these reflect live backend state and would reappear on next load anyway).

---

### AC Group C — Backup & Restore: list

**AC-C1 — Backups list renders with status, size, verification, and key version.**
**Given** the platform operator navigates to `/platform/backups`,
**When** the page loads,
**Then** it calls `GET /api/v1/admin/backups` and renders a `DataTable` with columns: Filename,
Started, Status, Size, Verified, Key Version — `status` and `errorMessage` are the two fields
added by D2.2.

**Example (positive):** three backups exist — one `succeeded`/`verified: 'valid'`/2.3 GB, one
`succeeded`/`verified: 'unverified'`/2.1 GB, one `failed` with `errorMessage: "pg_dump exited with
code 1"`. The table renders three rows; the failed row's Status cell shows "Failed" in a
distinguishing style (e.g. red text) with the error message visible (as a tooltip or inline
sub-text), not silently blank.

**Example (edge — currently-running backup in the list):** a fourth row has `status: 'running'`,
`sizeBytes: null`, `verified: 'unverified'`. The Size column shows "In progress…" (not `null`,
not `0 B`, not a blank cell) instead of attempting to format `null` bytes.

**Example (edge — empty list, backup never configured):** `GET /api/v1/admin/backups` returns
`{"data":{"items":[]}}` on a fresh instance that has never run a backup. The page shows an honest
empty state: "No backups yet." with the trigger button still available (AC-D1) rather than a
misleading "Loading…" that never resolves or a confusing blank table with just headers.

**AC-C2 — Backup-not-configured instance shows an honest disabled state, not a broken list.**
**Given** the instance has neither `BACKUP_STORAGE_PATH` nor `BACKUP_S3_BUCKET` configured
(`isBackupEnabled()` returns `false`),
**When** the platform operator visits `/platform/backups`,
**Then** `GET /api/v1/admin/backups` itself still succeeds (it has no `isBackupEnabled()` guard —
confirmed by direct inspection of `routes.ts`; only `trigger` checks it) and returns an empty or
populated historical list; the page additionally must attempt `POST /admin/backup/trigger` only
when the operator clicks Trigger, at which point AC-D2's `503 backup_not_configured` handling
applies — there is no separate "is backup configured" indicator needed on page load, since the
list itself always renders correctly regardless of current configuration state.

**Example (positive):** an instance with backup disabled but three historical backups from before
it was disabled still shows all three rows correctly.

**Example (edge):** an instance that has never had backup configured and never had a backup run
shows the AC-C1 empty state; clicking Trigger produces AC-D2's `503`.

---

### AC Group D — Backup & Restore: trigger

**AC-D1 — Triggering a backup shows an optimistic confirmation, not a live progress bar (D3).**
**Given** the platform operator is on `/platform/backups` and no backup is currently running,
**When** they click "Trigger backup now" (using the `ConfirmDeleteButton`-pattern two-step
control, relabeled "Trigger backup now" → "Confirm trigger?"),
**Then** the UI calls `POST /api/v1/admin/backup/trigger`; on `202`, it shows an inline success
message "Backup triggered (job `<jobId>`). Refresh the list below to check progress." and
re-fetches the list once immediately (the new `status: 'running'` row should already be visible,
per D2.2, without requiring a manual refresh for this one case — the "refresh to check progress"
copy applies to watching it *complete*, not to seeing it start).

**Example (positive):** click → `202 {"data":{"jobId":"...", "status":"running"}}` → success
message shown → the list re-fetch shows a new top row with `status: 'running'`.

**Example (edge — a backup is already running, `409`):** clicking Trigger when
`acquireBackupSlot()` is already held returns `409 {"code":"backup_already_running","message":"A
backup is already in progress (started at ...)","jobId":"..."}`. The UI shows this exact message
inline (not a generic "failed" message) and does **not** re-arm the confirm button into a
misleading "try again" state — the button returns to its initial "Trigger backup now" label.

**AC-D2 — Backup-not-configured instance shows a clear, actionable error on trigger attempt.**
**Given** `isBackupEnabled()` is `false` on the instance,
**When** the platform operator clicks Trigger,
**Then** the request returns `503 {"code":"backup_not_configured","message":"Backup is not
configured on this instance. Set BACKUP_STORAGE_PATH or BACKUP_S3_BUCKET."}`, and the UI renders
this message verbatim (it is already operator-actionable env-var guidance — do not paraphrase it
into something vaguer).

**Example (positive/only path for this AC):** exactly the scenario above; there is no "success"
variant for a not-configured instance.

**Example (edge — vault sealed mid-click, D6):** the vault becomes sealed between page load and
the click; the response is `503 {"status":"sealed","message":"..."}` (a **different** 503 shape
from `backup_not_configured` — both share status code 503 but different bodies per
`VaultSealedResponseSchema` vs `BackupNotConfiguredErrorSchema`). The UI must branch on the
response body's shape (presence of `code` vs `status`), not just the HTTP status code, and show
"The vault was sealed while you were on this page — <a>unseal it</a> to continue" for the sealed
case specifically, not the generic backup-not-configured copy.

**AC-D3 — Rate limiting on trigger surfaces a friendly retry message.**
**Given** the trigger route's `rateLimit: {max: 10, timeWindowMs: 60_000}`,
**When** the platform operator clicks Trigger more than 10 times within 60 seconds (e.g. rapid
double-clicking past the two-step confirm, or a genuinely impatient retry loop),
**Then** the 11th request returns `429`, and the UI shows "Too many trigger attempts — wait a
moment and try again." rather than a raw error dump.

**Example (positive):** attempts 1-10 within the window behave normally (each either succeeds or
hits `409` if already running); attempt 11 gets `429`.

**Example (edge — `429` on an already-armed confirm button):** if the `429` occurs on the
*confirming* click (not the arming click), the two-step control must fully reset to its initial
unarmed state rather than getting stuck in a "confirming" visual state with no way to retry
without a page reload.

---

### AC Group E — Backup & Restore: restore (destructive)

**AC-E1 — Restore requires typing the exact filename plus a reason, matching the backend's
confirmation contract.**
**Given** a completed backup row in the list,
**When** the platform operator clicks "Restore" on that row,
**Then** a confirmation panel expands (not a native `window.confirm()` — matching this codebase's
established two-step/typed-confirm conventions, never a browser-native dialog) requiring: (a) a
`TypedConfirmInput` where `expectedValue` is the exact filename, and (b) a free-text "Reason for
restore" field; the "Restore" submit button stays disabled until both the typed filename matches
**and** the reason field is non-empty, mirroring the backend's own `400 confirmation_required`
contract (`!parsed.data.confirmRestore || !parsed.data.reason`).

**Example (positive):** operator types the exact filename `backup_20260701T030000Z_org-abc.vault`
into the confirm input and "Emergency restore ahead of a corrupted-data incident" into the reason
field; the button enables; clicking it sends `POST /admin/backups/<filename>/restore
{confirmRestore: true, reason: "..."}`.

**Example (edge — reason omitted client-side despite a matching filename):** the button remains
disabled — this is a pure client-side UX guard preventing an avoidable round-trip to the server's
own `400`; it does not replace the server-side check (a direct API call without a reason still
gets the server's `400 confirmation_required`, confirmed by AC-E5).

**AC-E2 — A successful restore shows the sealed-after-restore outcome clearly, including the
"you must now manually unseal" next step.**
**Given** a valid restore request against an existing, checksum-matching, decryptable backup,
**When** the restore completes,
**Then** the response is `200 {"data":{"restored":true,"filename":"...",
"sealedAfterRestore":true}}`; the UI shows a prominent success state: "Restore complete. The vault
has been automatically sealed and requires manual unseal to resume operation." with a direct link
to `/vault` (the existing unseal page) — not a generic "success" toast that leaves the operator
unaware the vault is now sealed.

**Example (positive):** exactly the scenario above; clicking the `/vault` link takes the operator
straight into the existing unseal flow.

**Example (edge — operator navigates away before seeing the success message):** since restore is
synchronous (the `POST` doesn't return until the whole operation — including reseal — has
completed, per Story 9.5's documented drift correction: "restore completes synchronously, not an
async job"), there is no risk of a "restore succeeded but the operator never saw it" race from
navigating away mid-request — the browser's own fetch simply resolves after the (potentially
multi-second) restore completes; the UI must show a pending/spinner state for the full duration of
the request (do not treat this as instant), and if the operator navigates away, the request itself
completes server-side regardless (the vault reseals either way).

**AC-E3 — Restore failure modes each surface their own distinct, correctly-worded message.**
**Given** the five documented `RestoreOutcome` failure codes,
**When** each occurs,
**Then** the UI shows the corresponding message without conflating them:
- `not_found` (`404`) → "No backup found with that filename." (should be rare in practice since
  the filename comes from the list the UI itself rendered — covers the race where the file was
  deleted by retention pruning between page load and the restore click, AC-E6).
- `checksum_mismatch` (`422`) → "Stored checksum does not match the backup file — refusing to
  restore a potentially corrupted or tampered backup." (do not soften this to "please try again" —
  it is a security-relevant refusal, the wording must stay intact).
- `decrypt_failed` (`401`) → "Backup could not be decrypted with the current master key." (per
  Story 1.5's "no oracle" discipline this deliberately does not distinguish "wrong key" from
  "corrupted ciphertext" — do not add UI copy that tries to guess which one it was).
- `restore_failed` (`500`) → "Restore failed unexpectedly. See server logs for details." (an
  intentionally generic operator-facing message; the real stderr tail is server-log-only per the
  route's own sanitization).
- `confirmation_required` (`400`) → should be unreachable via the UI given AC-E1's client-side
  gate, but if hit anyway (e.g. a stale form resubmit), shows "Restore is destructive.
  `confirmRestore: true` and a reason are both required."

**Example (positive, one representative case):** an operator attempts to restore a backup file
whose on-disk checksum no longer matches its metadata sidecar (simulated corruption); UI shows the
`checksum_mismatch` copy verbatim as specified above.

**Example (edge — two failure modes share HTTP 401):** both `decrypt_failed` and a plain
authentication failure (expired session) can return `401`; the UI must distinguish them by
response body shape (`BackupDecryptFailedErrorSchema`'s `{code:'backup_decrypt_failed',...}` vs a
bare `ApiErrorSchema`), not by status code alone, or a legitimately-decrypt-failed restore attempt
would incorrectly bounce the operator to `/login`.

**AC-E4 — Concurrency: restore-in-progress and backup-in-progress locks (Story 9.6) surface as
distinct `409` messages.**
**Given** Story 9.6's session-scoped advisory lock (shared between restore and backup-trigger),
**When** the platform operator attempts a restore while (a) another restore is already running, or
(b) a backup snapshot is currently mid-flight,
**Then** the UI shows: (a) "Another restore is already in progress. Wait for it to complete before
retrying." (`409 {code:'restore_in_progress'}`); (b) "A backup is currently running. Wait for it
to complete before restoring." (`409 {code:'backup_in_progress'}`) — these are two different,
correctly-attributed messages, not a single generic "conflict" message.

**Example (positive, case a):** operator A starts a restore in one browser tab; operator B (or the
same operator in a second tab) attempts a second restore concurrently; the second request gets the
`restore_in_progress` message.

**Example (edge — documented message-attribution imprecision, D1.10 from 9.6):** per 9.6's own
documented, accepted trade-off, a backup-trigger's transient lock hold can rarely be mislabeled as
`restore_in_progress` — this is pre-existing backend behavior, not something this story's UI
should try to disambiguate further; display whichever `code` the response actually contains,
verbatim-mapped per the table above.

**AC-E5 — Restore rejects a malformed/path-traversal filename before any lock or DB work
(Story 9.6 D1.9) — the UI never constructs such a request, but must handle it gracefully if it
somehow occurs.**
**Given** the filename in the restore URL is always taken from a value the list itself rendered
(never free-typed by the operator for the URL path, only for the *confirmation* input, AC-E1),
**When** a restore request is nonetheless sent with an invalid filename (e.g. a stale/tampered
client state, or a direct non-UI API call),
**Then** the backend returns `400 {"code":"invalid_filename","message":"Not a well-formed backup
filename."}` before touching any lock; the UI (if it ever receives this, which should not happen
through normal use) shows this message plainly rather than crashing on an unexpected 400 shape.

**Example (positive — this is fundamentally a defense-in-depth AC):** a direct `curl` to
`/admin/backups/../../etc/passwd/restore` gets `400 invalid_filename` — confirms the existing
backend guard is untouched by this story; no new UI-side path-validation logic is needed or
should be added (the backend is the sole source of truth here).

**Example (edge):** N/A beyond the above — this AC is primarily a "does the UI's generic
error-rendering path handle an unfamiliar 400 code gracefully" smoke check, not a new behavior.

**AC-E6 — Restore against a backup that was pruned by retention between page-load and click shows
`not_found`, not a crash.**
**Given** the operator's `/platform/backups` list was loaded, then the daily retention-pruning job
(Story 9.1 AC, `BACKUP_RETENTION_COUNT`) deletes the oldest backup file before the operator clicks
Restore on that now-stale row,
**When** the restore request is sent,
**Then** it returns `404 backup_not_found` (AC-E3's `not_found` case) and the UI shows that
message, then removes the now-invalid row from the client-side list state (or triggers a full
list re-fetch) so the operator isn't left with a dead "Restore" button for a file that no longer
exists.

**Example (positive):** exactly the race described; UI shows "No backup found with that
filename." and refreshes the list, which no longer contains that row.

**Example (edge — the row disappearing mid-confirmation-panel-being-open):** if the operator has
the restore confirmation panel already expanded for that row when the backend-side deletion
happens, submitting still correctly surfaces the `404` — there is no client-side staleness check
required beyond handling the server's honest answer.

---

### AC Group F — Backup & Restore: validate

**AC-F1 — Validate renders structural-integrity results per asset type.**
**Given** the platform operator clicks "Validate" on a backup row,
**When** `POST /admin/backups/:filename/validate` returns
`{"data":{"valid":true,"assetsPresent":{"credentials":true,"projects":true,"users":true,
"auditEvents":true,"dataErasureRequests":true},"checksum":"match"}}` (the fifth field added by
D2.3/AC-F5),
**Then** the UI renders a checklist: overall "Valid ✓" / "Invalid ✗" state, a checksum row
("match"/"mismatch"), and one row per `assetsPresent` key showing present/missing — all five keys,
including the new `dataErasureRequests` one, in a stable, documented order.

**Example (positive):** exactly the scenario above; all five asset rows show ✓.

**Example (edge — a genuinely missing asset table, e.g. a very old backup predating a table):**
`assetsPresent: {..., dataErasureRequests: false}` on a backup taken before migration 0037 ever
ran — the UI shows this row as "✗ Missing" without marking the overall backup "Invalid" purely
because of it (`valid` and `assetsPresent` are independent fields per the schema — `valid` reflects
whether the dump is structurally readable at all, not whether every possible table happens to be
present; do not conflate the two in the UI's overall verdict logic).

**AC-F2 — Checksum mismatch renders as a clear warning, not buried in the checklist.**
**Given** `checksum: "mismatch"`,
**When** the validate result renders,
**Then** it shows a prominent warning banner above the checklist: "Checksum mismatch — this backup
file may be corrupted or tampered with." in addition to (not instead of) the per-field checklist.

**Example (positive):** a backup file that was manually edited on disk (simulated in a test via a
corrupted fixture) validates with `checksum: "mismatch"`; banner renders.

**Example (edge — mismatch alongside otherwise-valid asset presence):** `assetsPresent` can still
report all tables present (structural read succeeded) even when the checksum doesn't match — this
is expected (checksum covers tamper-evidence, not structural parseability) and the UI must show
both pieces of information without implying a contradiction.

**AC-F3 — Validate updates the row's `verified` status visible in the list (AC-C1) after
completion.**
**Given** a backup row previously showing `verified: 'unverified'`,
**When** validate completes (either outcome),
**Then** the backend's `updateBackupVerifiedStatus()` call (already existing, unmodified) persists
`'valid'` or `'invalid'`; the UI re-fetches or optimistically updates that row's Verified column
to reflect the new value without requiring a full page reload.

**Example (positive):** validate returns `valid: true` → the list row's Verified badge flips from
"Unverified" to "Valid" immediately.

**Example (edge — validate fails at the transport/decrypt level rather than returning a structured
`valid: false`):** if `validateBackupFile()` itself throws (e.g. the file is missing from storage
entirely — a different failure mode than a decodable-but-corrupted file), the route has no
documented alternate response shape for this in the existing code; the UI must fall back to its
generic error-alert handling (a caught, unstructured error) rather than assuming the response is
always the well-formed validate schema — do not let an unexpected shape crash the page (wrap the
JSON parse / field access defensively).

**AC-F4 — Validate is available even when backup is not currently configured, for historical
backups.**
**Given** an instance where backup has since been disabled but historical backup files remain on
the configured (now possibly stale) storage path,
**When** the operator clicks Validate on a historical row,
**Then** the request proceeds normally (the validate route has no `isBackupEnabled()` guard,
confirmed by inspection — only the trigger route checks it) — this AC exists purely to prevent the
dev agent from adding an incorrect client-side "disable Validate when backup is off" guard that
the backend itself does not impose.

**Example (positive):** backup disabled, three historical rows exist, Validate works normally on
all three.

**Example (edge):** N/A — this AC is a "do not over-restrict" guardrail, not a new failure path.

**AC-F5 — TD9-1: `assetsPresentFromTables` and its schema gain `dataErasureRequests` (D2.3).**
**Given** `apps/api/src/modules/backup/dump-inspect.ts`'s `assetsPresentFromTables()` currently
checks only `credentials`, `projects`, `users`, `audit_log_entries`,
**When** this story's backend change lands,
**Then** `BackupAssetsPresent` gains a fifth field `dataErasureRequests: boolean`,
`assetsPresentFromTables()` returns `dataErasureRequests: tables.has('data_erasure_requests')`, and
`BackupAssetsPresentSchema` (`schema.ts`) gains `dataErasureRequests: z.boolean()` — matching the
exact existing pattern for the other four fields, alphabetical-order-agnostic (keep it last, after
`auditEvents`, to minimize diff noise against the existing four-field literal).

**Example (positive):** a pg_dump text blob containing `CREATE TABLE "data_erasure_requests" (`
(migration 0037's table, confirmed already shipped) → `extractTableNames()` already includes
`data_erasure_requests` in its `Set` (no change needed to the regex-based extractor itself, only
to which keys `assetsPresentFromTables()` reads out of that set) → `assetsPresent.dataErasureRequests
=== true`.

**Example (edge — a pg_dump from a version genuinely predating migration 0037, e.g. a very old
retained backup):** `tables` does not contain `data_erasure_requests` → the field is `false`,
correctly reflecting that this specific backup predates Epic 8's compliance schema — this is the
exact "silent under-validation" gap TD9-1 was about; after this fix, it is loud instead of silent
(visible as an explicit `false` in both the API response and, per AC-F1, the UI checklist).

---

### AC Group G — System Settings

**AC-G1 — Settings page loads and pre-populates the current effective configuration.**
**Given** the platform operator navigates to `/platform/settings`,
**When** the page's `load` function calls `GET /api/v1/admin/settings`,
**Then** the form renders pre-populated with the current `smtp` (host/port/user/from —
`configured` boolean shown as a "Password is currently set" indicator, never the actual password),
`backup` (schedule/retentionCount/storageType, shown read-only — these are the *effective*
resolved values, not directly editable inputs; see AC-G2 for the override fields), `notifications`
(defaultSlackWebhook), and `instancePolicy` (maxOrgs/maxUsersPerOrg/sessionIdleTimeoutMinutes)
sections.

**Example (positive):** `GET /admin/settings` returns
`{"smtp":{"host":"smtp.example.com","port":587,"user":"noreply","from":"noreply@example.com",
"configured":true},"backup":{"schedule":"0 3 * * *","retentionCount":7,"storageType":"filesystem"},
"notifications":{"defaultSlackWebhook":null},"instancePolicy":{"maxOrgs":10,"maxUsersPerOrg":50,
"sessionIdleTimeoutMinutes":30}}` — every field pre-populates the matching input; the SMTP password
input is left blank with placeholder text "Leave blank to keep the current password" rather than
showing the literal string `[configured]` in an editable field (the `configured: true` boolean is
a separate read-only indicator, not the password field's bound value).

**Example (edge — nothing configured yet, all nulls):** a fresh instance returns
`{"smtp":{"host":null,"port":null,"user":null,"from":null,"configured":false},...}` — every SMTP
input renders empty with no placeholder implying a value exists; the "Password is currently set"
indicator does not render at all (only shown when `configured: true`).

**AC-G2 — Partial update: only changed fields are sent; the SMTP password is never accidentally
overwritten with a blank.**
**Given** the operator changes only the SMTP `from` address, leaving the password field blank,
**When** they submit,
**Then** the `PUT /admin/settings` request body includes `smtp: {from: "new@example.com"}` and
**omits** the `password` key entirely (never sends an empty string) — the backend's own contract
(`password` only updated when explicitly provided) depends on the client never sending a falsy
placeholder for "unchanged."

**Example (positive):** submit with only `from` changed → request body `{"smtp":{"from":
"new@example.com"}}`; response confirms `configured: true` (password untouched from its prior
state).

**Example (edge — operator explicitly wants to change the password):** they type a new value into
the password field → request body includes `password: "<new value>"` in the same `smtp` object;
after a successful save, the password input is cleared back to blank (never re-displays what was
just typed, matching the codebase's "never redisplay a secret" convention from 8.7's forwarding
page).

**AC-G3 — Validation errors from `PUT /admin/settings` render inline per field, not as a generic
alert.**
**Given** the operator submits an invalid `instancePolicy.maxOrgs` (e.g. `0`, violating the
backend's `min(1)` constraint),
**When** the request returns `422`,
**Then** the UI surfaces the validation error next to the `maxOrgs` input specifically (parsing
the Zod validation error shape the same way `settings/audit/+page.svelte`'s existing
`validationError()`-driven 422 handling does elsewhere in this codebase), not as an unattributed
top-of-page banner.

**Example (positive):** submit `{"instancePolicy":{"maxOrgs":0}}` → `422` with a field-path-tagged
error → "Must be at least 1" renders directly under the Max Orgs input.

**Example (edge — multiple simultaneous field errors):** submitting both an invalid `maxOrgs` and
an invalid SMTP `from` (not a valid email) in the same request surfaces both inline errors
simultaneously, each attributed to its own input — not just the first one found.

**AC-G4 — MFA-gated mutation: an un-enrolled operator attempting to save settings sees the
existing MFA-required UX, not a raw 403.**
**Given** `PUT /admin/settings` has `requireMfa: true` and the platform operator has not completed
MFA enrollment (or is outside an active grace period, per the existing MFA-enforcement worker),
**When** they submit the settings form,
**Then** the request returns the existing `mfa_required` 403 shape, and the UI renders it via the
shared `MfaAwareErrorAlert.svelte` component (linking to `/settings/security` to enroll) — reusing
the exact existing component and copy convention, not inventing new MFA-prompt copy for this one
form.

**Example (positive):** an un-enrolled platform operator (still within their grace period, so they
can otherwise use the app) attempts to save settings; sees "MFA required for this action. <a>Enable
MFA</a>." inline.

**Example (edge — MFA required on read too?):** confirm via the endpoint inventory (D2's table)
that `GET /admin/settings` does **not** require MFA (only the `PUT` does) — the settings page must
still load and display current values for an un-enrolled operator; only the *save* action is
blocked. Do not gate the entire page behind MFA when only the mutation requires it.

**AC-G5 — Read-only backup section on this page links to the Backups screen, does not duplicate
its controls.**
**Given** the settings page's `backup` section shows the *effective* schedule/retention/storage
type as read-only text,
**When** the operator wants to trigger, restore, or validate a backup,
**Then** the page provides a "→ Manage backups" link to `/platform/backups` rather than
re-implementing any backup action inline — the settings page's backup section is informational
only (it shows what the *scheduled* defaults are, including any `scheduleOverride`/
`retentionCountOverride` this form can write), never a second place to trigger a backup.

**Example (positive):** the backup section shows "Schedule: `0 3 * * *`, Retention: 7 backups,
Storage: filesystem" plus editable override inputs (`scheduleOverride`, `retentionCountOverride`)
and the "→ Manage backups" link.

**Example (edge — an override is saved but the *effective* schedule shown was computed before the
override):** after saving a new `scheduleOverride`, the page must re-fetch `GET /admin/settings`
(not just optimistically echo back the submitted value) so the displayed "effective" values always
reflect the backend's own resolution logic (`resolveEffectiveSettings()`), which may apply
additional defaults/clamping beyond what was literally submitted.

---

### AC Group H — Multi-Org management

**AC-H1 — Organizations list renders with member counts.**
**Given** the platform operator navigates to `/platform/settings/orgs`,
**When** the page loads,
**Then** it calls `GET /api/v1/admin/orgs` and renders a `DataTable` with columns: Name, Slug,
Created, Members — using the existing `memberCount` field.

**Example (positive):** two orgs exist; both render with their real `memberCount`.

**Example (edge — a brand-new instance with only the operator's own home org):** exactly one row
renders (the org created at vault-init time, per Story 9.1's bootstrap), with `memberCount: 1`.

**AC-H2 — Creating an org resolves to either "existing user added" or "invited new user," and the
UI reflects which one happened.**
**Given** the operator submits the create-org form with a name and an owner email,
**When** `POST /admin/orgs` succeeds,
**Then** the response's `ownerAccountAction` (`'existing_user_added'` | `'invited_new_user'`)
drives distinct confirmation copy: existing-user case → "Organization `<name>` created. `<email>`
was added as owner (existing account)."; invited case → "Organization `<name>` created. An
invitation was sent to `<email>`." — do not show one generic "Organization created" message that
hides which path was taken, since the operator needs to know whether to expect the new owner to
already have access or to be waiting on an email.

**Example (positive, existing-user path):** owner email matches an already-registered user →
`ownerAccountAction: 'existing_user_added'` → first message variant shown.

**Example (edge, invited path):** owner email has no existing account → `ownerAccountAction:
'invited_new_user'` → second message variant shown; the new org row appears in the list
immediately (re-fetch or optimistic prepend) even though the invited user hasn't accepted yet.

**AC-H3 — Duplicate org name/slug collision surfaces as a clear inline error.**
**Given** the backend's `409` response for a name/slug collision,
**When** the operator submits a name that collides with an existing org,
**Then** the form shows the collision error inline near the Name field, and the form's values are
preserved (not cleared) so the operator can adjust just the name without re-typing the email.

**Example (positive):** submitting "Acme Corp" when an org with that name/slug already exists
returns `409`; error shown inline; email field still populated.

**Example (edge — the `maxOrgs` instance-policy cap is reached, TOCTOU-hardened per Story 9.2's
code-review fix):** submitting a valid new org when the instance is already at its configured
`maxOrgs` limit returns the existing capacity-exceeded error (Story 9.2's fixed TOCTOU race
guards this server-side); the UI shows this as a distinct message from the name-collision `409`
(different `code`), e.g. "This instance has reached its maximum of `<maxOrgs>` organizations. Increase
the limit in Settings or archive an existing org first." with a link back to `/platform/settings`.

**AC-H4 — Invalid owner email shows client-side validation before any network call.**
**Given** the operator types a malformed email (e.g. `"not-an-email"`) into the owner-email field,
**When** they attempt to submit,
**Then** the form blocks submission client-side (HTML5 `type="email"` validation or an equivalent
JS check, matching this codebase's existing "client-side pre-check ahead of the server's own 422"
convention from 6.4/8.7) with an inline message, before any `POST /admin/orgs` request is sent.

**Example (positive):** typing `"not-an-email"` and clicking submit shows "Enter a valid email
address." with no network request in the browser's network tab.

**Example (edge — server-side 422 as the ultimate authority):** if a client-side check were
somehow bypassed (e.g. browser extension interference, or a future regression in the client
check), the server's own `422` on `CreateOrgRequestSchema`'s `z.email()` validation is still the
authoritative guard — the UI's generic 422 handling (AC-G3's pattern) must correctly render this
too, not just the client-pre-checked happy path.

---

### AC Group I — Resource Usage dashboard

**AC-I1 — Resource usage renders each metric against its limit with a computed percentage.**
**Given** the platform operator navigates to `/platform/settings/resource-usage`,
**When** the page loads `GET /admin/resource-usage`,
**Then** it renders: Orgs (current/limit + %), a per-org table of Users (current/limit + %), a
per-project table of Secrets (current, no limit in v1 per the schema's advisory-only design),
Audit Log Entries (current/limit + %), Storage Bytes (current/limit + %, human-formatted, e.g.
"1.2 GB / 5 GB"), and Audit Log Storage specifically (currentBytes/limitBytes/utilizationPct,
already computed by the backend — do not recompute the percentage client-side from the raw bytes,
use `utilizationPct` directly to avoid any rounding-divergence from the backend's own alerting
thresholds).

**Example (positive):** `orgs: {current: 3, limit: 10}` renders "3 / 10 (30%)"; `auditLogStorage:
{currentBytes: 42000000000, limitBytes: 50000000000, utilizationPct: 84}` renders "84%" using the
provided value, not `42000000000/50000000000*100` recomputed independently.

**Example (edge — a `null` limit, meaning "no hard cap configured"):** `storageBytes: {current:
900000, limit: null}` renders "900 KB / No limit configured" (or equivalent honest copy) rather
than attempting a percentage-of-null computation (which would be `NaN` or a divide-by-zero) or
silently hiding the metric.

**AC-I2 — Threshold-crossing metrics (80/90/95%) render with escalating visual severity.**
**Given** the backend's documented 80/90/95% alert thresholds (Story 9.2 AC-13/AC-E9d),
**When** a metric's computed percentage crosses one of these bands,
**Then** the UI applies escalating styling: <80% neutral, 80-89% amber "Approaching limit," 90-94%
orange "High usage," ≥95% red "Critical" — computed purely client-side from the already-returned
current/limit numbers (no new backend field needed for this since `auditLogStorage.utilizationPct`
already exists and the others are simple `current/limit`).

**Example (positive):** `usersPerOrg: [{orgId:"...", current: 47, limit: 50}]` → 94% → orange
"High usage" styling on that org's row.

**Example (edge — a metric with `limit: null` never triggers threshold styling):** since
percentage is undefined for an uncapped metric, it always renders in the neutral/no-threshold
style regardless of how large `current` is — do not fabricate a percentage against a null limit to
force a color band.

**AC-I3 — Key-custody-risk and audit-storage-critical warnings repeat here (not just on the
landing page) with more actionable detail.**
**Given** AC-B2 already shows these as banners on `/platform`,
**When** the operator drills into `/platform/settings/resource-usage` specifically,
**Then** the same warnings render again here, but with the specific numeric context available on
this page (e.g. "Audit log storage at 84% (`42 GB` / `50 GB`) — critical threshold is 95%.")
rather than the landing page's generic copy — this is intentional duplication across two pages for
an operator who lands directly on this deep page via a bookmark and never sees the landing page's
banner.

**Example (positive):** both `/platform` and `/platform/settings/resource-usage` show a
key-custody-risk warning simultaneously when the condition is active; the resource-usage page's
version includes the numeric audit-storage percentage, the landing page's does not.

**Example (edge — warnings differ between the two pages if `/ready`'s state changes between the
two page loads):** since each page independently fetches `/ready` (no shared client-side cache),
it is possible (though rare, given both loads happen in quick succession) for the two pages to
show slightly different warning states if the underlying condition resolves in between — this is
an accepted, documented eventual-consistency characteristic, not a bug to engineer around.

---

### AC Group J — Version & Upgrade / API docs browser

**AC-J1 — Version display sources from the existing public `/health` endpoint.**
**Given** the platform operator navigates to `/platform/upgrade`,
**When** the page loads,
**Then** it fetches `GET /health` (bare path, existing public endpoint, no auth required — same
one the container's own Docker healthcheck uses) and displays `version` (from
`apps/api/package.json` at build time) prominently, e.g. "Running version 0.9.0."

**Example (positive):** `GET /health` returns `{"status":"ok","version":"0.9.0"}` → "Running
version 0.9.0" renders.

**Example (edge — `/health` itself is unreachable, e.g. a network blip):** the page must not crash
if this fetch fails; render "Version information unavailable" instead of the version line, while
the rest of the page (migration explainer, docs link) still renders independently (this page's
sections must fail independently of each other, not all-or-nothing).

**AC-J2 — Migration-safety explainer is static informational copy, correctly describing the
additive-only guarantee, with a link to the runbook.**
**Given** Story 9.3's additive-only migration guard (`migration-compatibility-check.ts`,
`guarded-migrate.ts`),
**When** the operator views this page,
**Then** it shows a short, accurate explanation: in-place upgrades apply only additive schema
migrations automatically on `docker compose up -d`; a destructive migration (column/table
drop/rename) requires an explicit offline procedure documented in `docs/runbook.md § Upgrades` —
with a real, working link/reference to that document (this is documentation content, not a
dynamic API-driven display — there is no live "here are your pending migrations" feature, D4).

**Example (positive):** the explainer text and runbook link render identically regardless of the
instance's actual state (this section has no dynamic data dependency).

**Example (edge — do not imply a live check occurred):** the copy must not say anything like
"Your pending migrations have been verified as safe" (implying a live, per-instance check ran) —
it must describe the *general, always-true* guarantee the guard provides, since this page performs
no live migration inspection (D4 — no such backend capability exists to query).

**AC-J3 — API docs link is conditionally live, based on a server-side reachability probe (D5).**
**Given** `/api/v1/openapi.json` may or may not be registered depending on `ENABLE_API_DOCS`,
**When** the page's `load` function probes it server-side,
**Then**: if the probe returns `200`, render a live "Open API Documentation (Swagger UI) →" link
to `/api/v1/docs` (opens in the same app shell, or a new tab — either is acceptable, but must be a
real working `<a href>`, not a `<button>` with no destination); if `404`, render "API documentation
browsing is not enabled on this instance. Set `ENABLE_API_DOCS=true` to enable it." as plain,
non-interactive text (no dead link).

**Example (positive):** an instance with `ENABLE_API_DOCS=true` → probe returns `200` → live link
renders → clicking it lands on the real Swagger UI showing every registered route.

**Example (edge — probe returns `503` because the vault happens to be sealed at that exact
moment):** per D5, treat any non-`200` (`404` or otherwise, including `503`) the same as "not
available right now" — do not build a third distinct message for the sealed case specifically;
the generic "not enabled/not available" copy is acceptable for all non-`200` outcomes on this
best-effort probe.

**AC-J4 — This page has zero mutating actions (D4 guardrail, explicit negative-space AC).**
**Given** D4's explicit decision that there is no in-app upgrade-trigger capability,
**When** a developer reviews this page's implementation,
**Then** confirm it contains no `POST`/`PUT`/`PATCH`/`DELETE` calls anywhere, no buttons implying
an upgrade action will be performed by clicking them, and no copy suggesting the operator can
"upgrade from here" — this AC exists specifically to be checked in code review as a guardrail
against scope creep (a developer inventing a fictitious upgrade-trigger endpoint that doesn't
exist), not because there is a runtime behavior to test.

**Example (positive):** a code-review pass over the page's `+page.svelte`/`+page.server.ts`/API
client usage confirms zero mutating HTTP verbs.

**Example (edge):** N/A — this is a static/structural guardrail AC, not a runtime scenario.

---

### AC Group K — Platform Operator Audit Log: search

**AC-K1 — The page is clearly, visibly labeled as distinct from the per-org audit log (PJ9).**
**Given** epics.md's explicit `PJ9 — Cross-log search` requirement ("clear UI labeling
distinguishing the two logs"),
**When** the operator visits `/platform/audit`,
**Then** the page's `<h1>` reads "Platform Operator Audit Log" (never just "Audit Log," which is
already the org-scoped page's title at `/settings/audit`), and a subtitle/tooltip explicitly states:
"This is a separate log from your organization's own audit log (Settings → Audit & Compliance) —
it records platform-operator actions across all organizations, not per-org activity. There is no
unified cross-log search in this version."

**Example (positive):** the rendered page title, tab title (`<svelte:head><title>`), and subtitle
text all distinguish this page from `/settings/audit`'s "Audit & Compliance" / "Audit Log" naming
— a screenshot comparison of the two pages' headers should make the distinction obvious without
reading URLs.

**Example (edge — an operator who is also an org owner navigates between the two pages in the same
session):** the two pages' data never mix — `/settings/audit` continues to show only that
operator's home-org `audit_log_entries` rows (unchanged, pre-existing behavior); `/platform/audit`
shows only `platform_audit_events` rows; there is no combined view, and the UI must not imply one
exists anywhere (no "view all logs" link connecting them).

**AC-K2 — Search/filter form covers all documented query parameters.**
**Given** `PlatformAuditEventsQuerySchema`'s fields (`operatorId`, `actionType`, `targetOrgId`,
`targetUserId`, `from`, `to`, plus pagination),
**When** the operator uses the search form,
**Then** all six filter fields are available as form inputs, and submitting sends only the
non-empty ones as query params (matching `/settings/audit`'s existing `readFilters()` pattern of
omitting empty filter keys entirely rather than sending empty strings).

**Example (positive):** filtering by `actionType: "org.created"` and a date range renders only
matching rows, with the active filter summary shown above the results table (reusing
`/settings/audit`'s `filterSummary()` pattern).

**Example (edge — `to` before `from`):** client-side validation (reusing
`validateDateRange()` from `$lib/audit/date-range.js`, the exact existing shared utility) blocks
submission with "End date must be after start date," matching `/settings/audit`'s AC-B2 precedent
exactly — do not reinvent date-range validation for this page.

**AC-K3 — Results table shows `X-Log-Scope: platform` awareness — a defensive integrity check,
not just a display concern.**
**Given** every response from `platformAuditRoutes` carries an `X-Log-Scope: platform` response
header (Story 9.4 AC-12),
**When** the API client wrapper for this page's requests receives a response,
**Then** it should not need to inspect this header for normal operation (it's a defense-in-depth
signal for API consumers, not something the UI must act on) — this AC exists to explicitly
document that the header's *absence* would indicate the client accidentally called the wrong
endpoint (e.g. `/org/audit/events` instead of `/platform/audit/events`), and code review should
verify the new `platform-audit.ts` API client module's base path is `/api/v1/platform`, never
`/api/v1/org`, anywhere in its implementation.

**Example (positive):** a manual `curl -I` against `/api/v1/platform/audit/events` while
authenticated as the platform operator shows `X-Log-Scope: platform` in the response headers,
confirming the route family is correctly registered.

**Example (edge — a copy-paste mistake reusing 8.7's org-audit API client as a starting point):**
this AC exists specifically because 8.7's `audit.ts` API client (`$lib/api/audit.ts`) is a
plausible, superficially-similar copy-paste source for a developer building this page — code
review must confirm the new module is genuinely independent, targets `/api/v1/platform/...`
throughout, and does not accidentally import or extend the org-scoped `audit.ts` module.

**AC-K4 — Pagination follows the existing `{items, page, limit, total, hasNext}` convention.**
**Given** `PlatformAuditEventsResponseSchema`'s `paginatedListMetaFields`,
**When** results span multiple pages,
**Then** pagination controls (Previous/Next, reflecting `hasNext` and current `page`) work
identically to `/settings/audit`'s existing pagination, preserving active filters across page
navigation (reusing the `pageHref()` pattern of building a `URLSearchParams` from current filters
plus the target page).

**Example (positive):** 45 platform-audit events with `limit: 20` → page 1 shows 20 rows with
"Next" enabled; page 3 shows 5 rows with "Next" disabled (`hasNext: false`).

**Example (edge — a search failure on one page must not crash the whole page, matching
`/settings/audit`'s AC-B1/O1 precedent):** a transient `429` or `500` while fetching page 2 shows
an inline error message with the filter/search form still fully usable, not a blank page or a
thrown exception.

---

### AC Group L — Platform Operator Audit Log: integrity verify

**AC-L1 — Verify panel runs an HMAC integrity check over a date range and shows a pass/fail
summary.**
**Given** the operator provides a `from`/`to` range (both required per
`PlatformAuditVerifyQuerySchema`),
**When** they run "Verify integrity,"
**Then** `GET /platform/audit/verify?from=...&to=...` returns
`{"data":{"summary":"...","rowsChecked":N,"passed":N,"failed":[...],"failedCount":N,
"failedTruncated":bool,"verifiedAt":"..."}}`; the UI renders the `summary` string prominently
(e.g. "14 records verified — no tampering detected," matching the existing org-audit verify
panel's phrasing convention) plus a `rowsChecked`/`passed`/`failedCount` breakdown.

**Example (positive):** `{"rowsChecked":14,"passed":14,"failedCount":0,"failed":[]}` → "14 records
verified — no tampering detected."

**Example (edge — tampering detected):** `{"rowsChecked":14,"passed":12,"failedCount":2,
"failed":[{"id":"...","actionType":"org.created","timestamp":"..."}, {...}],
"failedTruncated":false}` → the UI must render this as a clear failure state (not just a smaller
success number), listing the failed entries' `actionType`/`timestamp` so the operator has a
starting point for investigation — this is a security-critical result and must visually stand out
(e.g. red banner), never rendered with the same neutral styling as a clean pass.

**AC-L2 — Both required date fields are enforced client-side before submission.**
**Given** `PlatformAuditVerifyQuerySchema` requires both `from` and `to` (no optional defaults,
unlike the search form's optional filters),
**When** the operator attempts to run verify with either field empty,
**Then** the button is disabled (or submission is blocked with an inline message) until both are
populated — do not send a request that will predictably `422`.

**Example (positive):** both dates populated → button enabled → request sent.

**Example (edge — a very large date range, e.g. the full platform-audit retention window of up to
`PLATFORM_AUDIT_RETENTION_DAYS` at its default 365 days):** the UI does not impose its own
artificial range cap (none is documented in the schema) — a full-year verify request is allowed
to be submitted; the page must show a pending/loading state for however long the (potentially
slow, full-table-scanning) backend operation takes, rather than assuming it resolves instantly.

**AC-L3 — Verify itself self-audits (Story 9.4 AC-11) — the UI does not need to display this, but
must not break it.**
**Given** every successful `GET /platform/audit/verify` call writes its own
`integrity_verify_run` platform-audit entry (audit-of-the-auditor),
**When** the operator runs verify and then immediately re-runs a search (AC group K) for their own
`operatorId`,
**Then** the new self-audit entry appears in the search results (this is existing backend
behavior, unmodified) — this AC exists to confirm the UI's search results view is not
accidentally filtering out or hiding `actionType: 'integrity_verify_run'` rows via any
UI-side allowlist of "interesting" action types (there must be no such allowlist — all
`actionType` values render identically in the results table).

**Example (positive):** after running verify, searching with no filters shows the new
`integrity_verify_run` row at the top (most recent) of the results.

**Example (edge — the verify call itself fails to self-audit, `503 platform_audit_write_failed`):**
per the existing backend code (`handleGetVerify`'s catch block), a `SameTransactionPlatformAuditWriteError`
during the self-audit write causes the **entire** verify operation to fail with `503` — the
verify results are never returned to the operator in this case, even though the actual
verification computation may have succeeded internally; the UI must show this as "Platform audit
logging is unavailable — verification could not be completed" (matching the error body's message),
not attempt to salvage or partially display a verify result that was never actually returned.

---

### AC Group M — Maintenance mode status & toggle

**AC-M1 — Current maintenance-mode status is visible before any toggle action (D2.4, the core
safety fix this AC group exists for).**
**Given** the new `GET /api/v1/platform/maintenance-mode` endpoint (D2.4),
**When** the operator visits `/platform/audit`,
**Then** the page loads and displays current status prominently at the top: if `active: false`,
a neutral "Maintenance mode: inactive" indicator; if `active: true`, a persistent, high-visibility
banner "⚠ Maintenance mode is ACTIVE (activated `<activatedAt>`, reason: `<reason>`) — the
fail-closed audit guarantee is currently bypassed. `<pendingEntriesCount>` entries queued." — this
banner must remain visible regardless of scroll position or which tab/section of the page the
operator is viewing (persistent within the page, not a dismissible toast).

**Example (positive, inactive):** `{"data":{"active":false,"reason":null,"activatedAt":null,
"deactivatedAt":"2026-07-01T00:00:00Z","pendingEntriesCount":0}}` → neutral status shown.

**Example (positive, active):** `{"data":{"active":true,"reason":"Emergency recovery during audit
storage outage","activatedAt":"2026-07-08T12:00:00Z","deactivatedAt":null,
"pendingEntriesCount":3}}` → the full warning banner renders with all four pieces of information
(reason, activated time, pending count) — not a generic "maintenance mode is on" with no detail.

**Example (edge — the status fetch itself fails):** if `GET /maintenance-mode` fails (network
error, unexpected 500), the page must **not** default to displaying "inactive" (a false negative
here is actively dangerous — an operator might toggle activate again, or fail to realize a bypass
is already in effect); instead show an explicit "Maintenance mode status unavailable — action
disabled until status can be confirmed" state, and disable both the activate and deactivate
controls until a successful status fetch succeeds. **Fail closed on the UI's own display, matching
the backend's own fail-closed philosophy for this exact feature.**

**AC-M2 — Activating maintenance mode requires a reason and uses the two-step confirm pattern.**
**Given** `active: false`,
**When** the operator wants to activate,
**Then** they must provide a non-empty `reason` (client-side required field, matching the
backend's own `superRefine` requiring `reason` whenever `action !== 'deactivate'`) and use the
`ConfirmDeleteButton`-style two-step confirm (arm → confirm) before the `POST
{action:'activate', reason}` request fires.

**Example (positive):** operator types "Planned audit-storage maintenance window" and confirms →
`200 {"active":true,"activatedAt":"...","reason":"..."}` → the page's status banner (AC-M1)
updates to reflect the new active state without requiring a manual reload.

**Example (edge — already active, `409`):** if a concurrent activation already happened (e.g.
another operator, or a second tab) between this page's load and the click, the backend returns
`409 {"code":"maintenance_mode_already_active",...}`; the UI shows this message and immediately
re-fetches `GET /maintenance-mode` to resync its displayed status to the now-current truth (do not
leave the page showing stale "inactive" after a `409` proves it's actually active).

**AC-M3 — Deactivating shows the drain outcome honestly, including the "still unavailable" failure
case.**
**Given** `active: true`,
**When** the operator clicks "Deactivate" (no reason required for deactivate, per the schema),
**Then** on success (`200 {"active":false,"deactivatedAt":"..."}`), the status banner updates to
inactive and shows "Maintenance mode deactivated. All queued entries were successfully recorded."
(only claim this if the request actually succeeded — a `200` response from this endpoint means
drain-and-deactivate fully succeeded per the backend's own invariant, so this claim is always
truthful when shown).

**Example (positive):** 3 pending entries drain successfully → `200` → banner clears, success
message shown.

**Example (edge — still unavailable, `503`):** if the underlying platform-audit write path is
still genuinely broken (e.g. the audit key is unavailable), the backend returns
`503 {"code":"platform_audit_write_failed","message":"Cannot deactivate maintenance mode: platform
audit log is still unavailable"}` and `active` remains `true` server-side; the UI must show this
exact message, **keep the active-maintenance banner visible** (re-fetch status to confirm it's
still `true`, do not optimistically clear it), and allow the operator to retry deactivation once
the underlying issue is fixed — this is the single most safety-critical error path in this entire
story: silently showing "deactivated" when the backend refused would be a materially dangerous UI
bug.

**AC-M4 — Concurrent deactivation race: a "someone else already fixed it" outcome is shown
accurately, not as an error.**
**Given** Story 9.4's documented concurrent-drain-race handling (`wasActive` tracking in
`drainPendingEntries`),
**When** two operators (or two tabs) both click Deactivate at nearly the same time and the first
one's drain already completed the transition,
**Then** the second request still returns `200 {"active":false,"deactivatedAt":"..."}` (the
backend's `deactivateMaintenanceMode` returns success, not an error, for this race per its own
documented `!result.wasActive` branch) — the UI shows the same success message as AC-M3's normal
case; there is no special "someone else already did this" copy needed since the backend itself
doesn't distinguish the two cases in its response, and the UI should not invent a distinction the
API doesn't provide.

**Example (positive):** operator B's deactivate click resolves with the same `200` shape as if
they had been the one to trigger the actual drain — no error, no confusing "nothing to do"
message, just the normal success path.

**Example (edge — this AC is a "do not over-engineer" guardrail):** do not add client-side logic
attempting to detect and special-case this race (e.g. comparing timestamps) — the backend
response is already correct and sufficient; adding UI-side speculation about *why* a
`200` occurred would be presumptuous and could be wrong.

---

### AC Group N — Cross-cutting authorization & tenant isolation

**AC-N1 — RLS enforcement on `platform_audit_events` is independent of and in addition to the
application-layer `requirePlatformOperator()` gate.**
**Given** `platform_audit_events`'s RLS policy requires `app.platform_operator_verified = 'true'`
(set only by `withPlatformOperatorContext()`, called only from within already-gated route
handlers),
**When** this story's own tests are written for the new `GET /maintenance-mode` route (D2.4),
**Then** include (mirroring 9.4's existing `platform-audit-events-immutability-and-rls.test.ts`
pattern) a test confirming a direct query against `platform_audit_maintenance_state`/
`platform_audit_pending_entries` (the tables the new route reads) without an org-scoped RLS
context still returns the single global row correctly for a platform operator's request context
(these two tables, per Story 9.4's design, are **not** RLS-restricted the same way
`platform_audit_events` is — they hold exactly one global row and a queue, not per-org data;
confirm this via `check-rls-coverage.ts`'s existing `EXCLUDED_TABLES` treatment rather than
assuming RLS parity with `platform_audit_events` that doesn't actually exist for these two
tables).

**Example (positive):** the new route's own integration test, run as a properly-authenticated
platform operator, successfully reads the maintenance-state row.

**Example (edge — a non-platform-operator with a valid session directly queries these tables via
some other already-gated route that happens to share a DB connection):** not reachable through
any existing route (`platform_audit_maintenance_state`/`platform_audit_pending_entries` are only
ever touched by `platform-audit/*.ts` modules, all gated by `requirePlatformOperator()`) — this
AC's test only needs to cover the one new route's own gate, not invent a new cross-table leakage
scenario that has no code path to exploit it.

**AC-N2 — A platform operator's own org membership never grants extra visibility into other orgs'
data through any of this story's new UI, beyond what the existing instance-wide platform-admin
endpoints already (correctly) expose.**
**Given** the platform operator is simultaneously a regular member of exactly one "home" org,
**When** they use any `/platform/*` page,
**Then** confirm (via manual review, not new tests — the underlying endpoints are already
`requireOrgScope: false` and already tested by 9.1/9.2/9.4) that no new frontend code introduces
an accidental `orgId`-scoped filter that would hide other orgs' data from these instance-wide
views, and conversely that no new frontend code leaks the platform operator's *own* org's
regular-user data (credentials, projects) into any `/platform/*` page — these pages show only
`platform_audit_events`/`backup_runs`/`system_settings`/`organizations` (metadata)/resource-count
aggregates, never actual per-org secret/credential content.

**Example (positive):** the Organizations list (AC-H1) shows every org's name/slug/member-count,
including orgs the platform operator personally has zero membership in — this is correct,
intended behavior for an instance-wide admin view, not a tenant-isolation violation.

**Example (edge — a regular org-scoped page accidentally reused on a `/platform/*` route):**
code review confirms no `/platform/*` page imports or calls any `$lib/api/*` client function that
targets `/api/v1/org/...` or `/api/v1/projects/...` (org-scoped endpoints) — every `/platform/*`
page's data calls target only `/api/v1/admin/...`, `/api/v1/platform/...`, `/api/v1/auth/me`, or
the bare `/health`/`/ready` endpoints.

**AC-N3 — Every new page's `+page.server.ts` calls the shared `platformOperatorGate()` helper
(D7) — verified structurally, not just behaviorally.**
**Given** D7's explicit anti-duplication decision,
**When** code review examines the seven new/nested `+page.server.ts` files,
**Then** confirm each one imports and calls `platformOperatorGate(locals)` from
`$lib/server/require-platform-operator.js`, and none of them re-implements the
`user.isPlatformOperator` check inline — this is a structural/DRY guardrail AC directly motivated
by this codebase's repeated jscpd CI failures on near-identical prior completion stories (6-4,
8-5, 8-7), to be caught in code review before a CI run is even attempted, not after.

**Example (positive):** `grep -rn "platformOperatorGate" apps/web/src/routes/\(app\)/platform`
finds exactly seven call sites (one per page).

**Example (edge — a page that legitimately needs additional data beyond the gate, e.g. the
backups list):** the gate check still happens first, before any additional page-specific data
fetching — `platformOperatorGate()` returning `{allowed: false}` must short-circuit before any
`GET /admin/backups`-style call, never fetch-then-discard.

---

### AC Group O — Sealed-vault & error-state handling

**AC-O1 — `/platform` is added to the global sealed-vault redirect list (D6).**
**Given** `isProtectedAppPath()`'s existing array,
**When** this story ships,
**Then** `/platform` is added to that array, and a direct test (extending
`apps/web/src/lib/server/auth-guard.test.ts` if it exists, or the equivalent hooks-level test)
confirms `isProtectedAppPath('/platform')` and `isProtectedAppPath('/platform/backups')` both
return `true`.

**Example (positive):** a sealed-vault instance redirects any `/platform/*` navigation attempt
straight to `/vault`, exactly as it already does for `/dashboard`, `/settings`, etc.

**Example (edge — the vault seals mid-session, not just on cold page load):** since
`hooks.server.ts`'s redirect only runs on server-rendered navigation, a client-side action
(e.g. clicking Trigger Backup) that hits a live `503 {status:'sealed'}` response is **not**
caught by this global redirect (it only fires on page loads, not on client-side fetches) —
AC-D2's edge case (and the equivalent per-mutation handling across every other AC group)
covers this separately; do not assume AC-O1 alone is sufficient sealed-vault coverage.

**AC-O2 — Every mutating action across this story's seven pages has a documented, tested `503`
sealed-vault handling path (a completeness sweep across all groups, not a new mechanism).**
**Given** trigger/restore/validate backup, save settings, create org, and activate/deactivate
maintenance mode are this story's six mutating actions,
**When** each is reviewed,
**Then** confirm each one's error-handling branch checks for the `VaultSealedResponseSchema`
shape (`{status: 'sealed'|string, message}`, distinguished from that action's own specific error
codes by the *absence* of a `code` field) and shows the shared "vault sealed — unseal to continue"
copy (D6) — this AC is a completeness checklist, cross-referencing AC-D2, AC-E2/E3, AC-G4, AC-H2/H3,
and AC-M2/M3's individual sealed-handling mentions into one explicit sign-off item for code
review.

**Example (positive):** a code-review checklist pass confirms all six mutation call sites include
this branch.

**Example (edge — a mutation whose success schema happens to also lack a `code` field, risking a
false-positive "sealed" detection):** confirm the discriminator used is specifically "has a
`status` field AND lacks a `data` field AND lacks a `code` field" (matching
`VaultSealedResponseSchema`'s exact shape `{status, message}`) rather than a looser check like
"has any `status` field," since some success responses (e.g. `BackupTriggerResponseSchema`'s
`{data: {jobId, status: 'running'}}`) also happen to contain a `status` key, just nested under
`data` — the discrimination must be on the top-level response shape, not a naive
`'status' in body` check against the parsed JSON regardless of nesting.

---

### AC Group T — Documentation & tracked technical debt

**AC-T1 — Stale `/settings` placeholder copy is removed (Retro Finding 7 / A9-4).**
**Given** `apps/web/src/lib/components/shell/placeholder-copy.ts`'s `'settings'` key
(`"Settings are limited while the MVP shell is being assembled."`) is confirmed dead code — no
route calls `getPlaceholderSection('settings')` anywhere in `apps/web/src/routes` (only
`placeholder-sections.test.ts` references the key, purely to assert it exists),
**When** this story ships,
**Then** remove the `'settings'` key from `PlaceholderSectionKey`, `placeholderSections`, and
`getPlaceholderSection()`'s switch, and update `placeholder-sections.test.ts`'s assertion from
`['projects', 'credentials', 'settings']` to `['projects', 'credentials']` — do not merely reword
the stale copy (the retro's own suggested fix), since the key has zero live callers and keeping it
around as unreachable dead code is worse than removing it entirely; if a future story needs a
settings placeholder again, it can be re-added at that point with accurate copy.

**Example (positive):** `pnpm --filter web test placeholder-sections` passes with the updated
two-key assertion; `grep -rn "getPlaceholderSection('settings')" apps/web/src/routes` returns zero
matches both before and after this change (confirming it was truly dead).

**Example (edge — if a live caller is discovered during implementation that this research missed):**
if the dev agent finds an actual live usage of the `'settings'` placeholder key that this story's
research did not catch, stop and update this AC's approach to a copy-rewrite instead of a removal
(matching the retro's originally-suggested, more conservative fix) — do not remove a key a real
route still depends on.

**AC-T2 — `deferred-work.md` gains a tracked entry for TD9-2 (9-4 maintenance-mode bypass scope,
D8).**
**Given** D8's decision not to fix TD9-2's backend behavior in this story,
**When** this story ships,
**Then** add a row to `deferred-work.md`'s technical-debt tracking (following the existing
"Web UI gaps" / retro-debt table conventions used for prior epics) explicitly naming: "9-4's
`writePlatformAuditEntryOrFailClosed` maintenance-mode bypass triggers on *any* write failure
during an active maintenance window, not narrowly on 'audit storage unavailable' — a genuine
application bug during a maintenance window is silently queued into
`platform_audit_pending_entries` rather than surfacing as a defect (adversarial-review high
finding on Story 9.4, epic-9-retro-2026-07-08.md Finding 6/TD9-2)," with target: "backend
follow-up story, not yet scheduled."

**Example (positive):** `deferred-work.md` contains this exact entry after this story merges,
citing this story (`9-7-...`) as the source of the tracked-not-fixed decision.

**Example (edge — this AC has no runtime/test verification, it is a documentation deliverable):**
verified by direct file inspection in code review, the same way Story 9.5's documentation-only ACs
were verified (no automated test asserts markdown file contents in this codebase's existing
conventions).

**AC-T3 — `deferred-work.md`'s "Web UI gaps" table row for Epic 9's platform-operations UI is
marked resolved, citing this story.**
**Given** the precedent set by every prior completion story (5-4, 6-4, 8-6, 8-7) updating its own
`deferred-work.md` row from "no dedicated web story exists" to "Resolved — scheduled/shipped as
`<story-key>`,"
**When** this story ships,
**Then** `deferred-work.md` gains (or updates, if the retro's own uncommitted edit is later merged
and creates a duplicate to reconcile) a row for "Platform operations admin UI (backup/restore,
system settings, multi-org, resource usage, version/upgrade, platform operator audit log)" citing
API stories 9.1/9.2/9.3/9.4/9.6, with resolution: "Resolved — shipped as
`9-7-epic-9-completion-platform-operations-web-ui`."

**Example (positive):** the row exists and is accurate after this story merges.

**Example (edge — a duplicate row from the retro session's own uncommitted `main`-branch edit is
later merged separately):** if a future merge introduces a near-duplicate row (since this
worktree branched before that edit was committed), reconcile by keeping one row and removing the
duplicate — do not leave two rows describing the same resolved gap; this is a known, documented
risk of two parallel worktrees editing the same tracked-debt document independently, not a defect
in this story's own work.

---

## Tasks / Subtasks

- [ ] **Task 1 — Backend: expose `isPlatformOperator` on `/auth/me` (D2.1)** (AC: A1)
  - [ ] Add `isPlatformOperator: z.boolean()` to `authMeResponseSchema` (`apps/api/src/modules/auth/schema.ts`)
  - [ ] Include `authContext.isPlatformOperator` in the `/me` handler's returned object (`apps/api/src/modules/auth/routes.ts`)
  - [ ] Write/update integration test asserting the field for both a platform-operator and a regular user
- [ ] **Task 2 — Backend: extend backup list + validate schemas (D2.2, D2.3/TD9-1)** (AC: C1, F5)
  - [ ] Add `status`, `errorMessage` to `BackupListItemSchema` and `listBackups()`
  - [ ] Add `dataErasureRequests` to `BackupAssetsPresent`/`assetsPresentFromTables()`/`BackupAssetsPresentSchema`
  - [ ] Update/add unit tests for both extensions
- [ ] **Task 3 — Backend: new `GET /platform/maintenance-mode` status route (D2.4)** (AC: M1, N1)
  - [ ] `getMaintenanceModeStatus(tx)` in `maintenance-mode.ts`
  - [ ] New route + schema in `platform-audit/routes.ts` / `schema.ts`
  - [ ] Integration test incl. `403` for non-platform-operator (AC-A4)
- [ ] **Task 4 — Web: shared platform-operator gate primitives (D7)** (AC: A3, N3)
  - [ ] `platformOperatorGate()` helper, `PlatformOperatorRequiredNotice.svelte`
  - [ ] `isProtectedAppPath()` gains `/platform` (AC-O1)
  - [ ] `AuthUser` type gains `isPlatformOperator`; nav-model gains conditional item (AC-A2)
- [ ] **Task 5 — Web: `/platform` landing page** (AC: B1, B2)
- [ ] **Task 6 — Web: `/platform/backups`** (AC: C1-C2, D1-D3, E1-E6, F1-F4)
  - [ ] New `platform-backups.ts` API client
  - [ ] List + trigger + restore (typed-confirm) + validate panels
- [ ] **Task 7 — Web: `/platform/settings` + nested `orgs`/`resource-usage`** (AC: G1-G5, H1-H4, I1-I3)
  - [ ] New `platform-admin.ts` API client (settings/orgs/resource-usage)
- [ ] **Task 8 — Web: `/platform/upgrade`** (AC: J1-J4)
- [ ] **Task 9 — Web: `/platform/audit`** (AC: K1-K4, L1-L3, M1-M4)
  - [ ] New `platform-audit.ts` API client (events/verify/maintenance-mode GET+POST)
- [ ] **Task 10 — Cross-cutting hardening** (AC: A4, N1-N3, O1-O2)
- [ ] **Task 11 — Cleanup & documentation** (AC: T1-T3)
  - [ ] Remove stale `'settings'` placeholder key + test update
  - [ ] `deferred-work.md`: TD9-2 entry + Web-UI-gaps row resolution
- [ ] **Task 12 — Full regression sweep**
  - [ ] `pnpm --filter api test`, `pnpm --filter web test`, `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm jscpd`, `pnpm generate-spec` + `git diff --exit-code packages/shared/openapi.json`, `pnpm check-story-status-sync`, full `make ci`

---

## Dev Notes

- **TDD red-green per AGENTS.md:** for every AC above, write the failing test first (backend
  integration test for Tasks 1-3; Vitest + Testing Library component/page test for Tasks 4-9),
  confirm it fails for the expected reason, then implement the minimal change.
- **jscpd is a real, repeated risk on this exact class of story** (D7) — extract shared primitives
  *before* writing the seven pages, not after a failing CI run.
- **Response-envelope inconsistency (unwrapped `platform-admin` vs wrapped `backup`/`platform-audit`)
  is pre-existing and must not be "fixed"** as part of this story — `apiFetch` already handles
  both.
- **MFA gating is asymmetric across this story's own endpoints** — backup routes have none;
  settings/orgs/resource-usage/platform-audit/maintenance-mode all do. Do not assume uniform MFA
  UX across all seven pages.
- **No new database migration is required anywhere in this story.** Every backend touch (D2) reads
  or extends the shape of existing, already-migrated tables/columns. If implementation reveals a
  need for a migration, stop and reconcile against this Dev Notes section before proceeding —
  that would indicate a scope misunderstanding.
- **Do not build:** a backup-job progress poller (D3), an in-app upgrade-trigger action (D4), or a
  narrowed maintenance-mode bypass (D8) — each has an explicit rationale above for why it is out
  of scope.

### Project Structure Notes

- New route files all live under `apps/web/src/routes/(app)/platform/` mirroring the existing
  `(app)/settings/` structure exactly (`+page.server.ts` + `+page.svelte` pairs, `.test.ts` files
  colocated per the existing convention e.g. `settings/audit/audit-page.test.ts`).
- New API client modules live in `apps/web/src/lib/api/` alongside every existing one
  (`platform-backups.ts`, `platform-admin.ts`, `platform-audit.ts`).
- New shared server helper: `apps/web/src/lib/server/require-platform-operator.ts`.
- New shared component: `apps/web/src/lib/components/PlatformOperatorRequiredNotice.svelte`.
- No changes to `packages/db/` schema files or `packages/db/src/migrations/`.
- No changes to `packages/shared/` beyond `packages/shared/openapi.json` regenerating automatically
  via `pnpm generate-spec` to reflect the one new route (D2.4) and the extended response schemas
  (D2.1-D2.3) — commit the regenerated spec as part of this story, matching every prior story's
  convention (`make ci`'s `git diff --exit-code packages/shared/openapi.json` check enforces this).

### References

- [Source: `_bmad-output/implementation-artifacts/epic-9-retro-2026-07-08.md`] — Finding 1
  [REPEAT 4x], Findings 5-7, Action Items A9-1/A9-3/A9-4/A9-6, TD9-1/TD9-2.
- [Source: `_bmad-output/planning-artifacts/epics.md#Epic 9: Platform Operations, API &
  Self-Hosting`] (lines ~1989-2175) — literal Stories 9.1-9.5 AC text; PJ9 cross-log-search note;
  AC-E9a/b/c/d.
- [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`] — G1-G4, P3.
- [Source: `_bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md`] — D1
  (platform-operator flag), D8 (assetsPresentFromTables obligation).
- [Source: `_bmad-output/implementation-artifacts/9-2-system-settings-multi-org-and-resource-monitoring.md`]
  — D2 (route/module separation from org-scoped admin), AC-13/AC-E9d thresholds.
- [Source: `_bmad-output/implementation-artifacts/9-3-in-place-version-upgrades-and-api-parity-verification.md`]
  — D5 (docs-enabled gating), AC-E9b (additive-only upgrade scope), AC-19 (version sourcing).
- [Source: `_bmad-output/implementation-artifacts/9-4-platform-operator-audit-log.md`] — D8
  (maintenance-mode design), AC-9 through AC-16.
- [Source: `_bmad-output/implementation-artifacts/9-6-backup-restore-hardening.md`] — D1
  (restore-lock concurrency), D1.9/D1.10 (filename validation, message attribution).
- [Source: `_bmad-output/implementation-artifacts/8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt.md`]
  — closure-story structural precedent (D1 route-nesting pattern, shared-component reuse list,
  jscpd-risk framing).
- Direct code inspection (this story's own research, cited inline throughout): `apps/api/src/modules/backup/{routes,service,schema,dump-inspect,config}.ts`,
  `apps/api/src/modules/platform-admin/{settings,orgs,resource-usage}-routes.ts` + `schema.ts` +
  `route-common.ts`, `apps/api/src/modules/platform-audit/{routes,schema,maintenance-mode}.ts`,
  `apps/api/src/modules/auth/{routes,schema,service}.ts`, `apps/api/src/plugins/require-platform-operator.ts`,
  `apps/api/src/app.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/plugins/vault-guard.ts`,
  `packages/db/src/schema/backup-runs.ts`, `apps/web/src/lib/{api,server,components}/**`.

## Dev Agent Record

### Agent Model Used

_To be filled in by the dev agent._

### Debug Log References

### Completion Notes List

### File List
