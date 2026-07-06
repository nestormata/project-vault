# Story 5.3: Stale Rotation Recovery & Break-Glass Emergency Rotation

Status: done

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for the THIRD and final story in Epic 5 (Credential Rotation). Stories 5.1 and 5.2 are `ready-for-dev` but NOT YET IMPLEMENTED in this branch (confirmed via `ls`: no `apps/api/src/modules/rotation/`, no `packages/db/src/schema/rotations.ts` exist yet) — every reference below to `rotations`/`rotation_checklist_items` schema, the advisory-lock pattern, or the confirm/fail/retry/complete endpoints describes what 5.1's and 5.2's own story files specify they will build, not code that exists in this branch today. This story's own new code (break-glass, stale-recovery job, resume/abandon) assumes 5.1 AND 5.2 have both landed first. Read "Prerequisites" and "Conflict Resolution & Design Decisions" before touching anything — this story resolves several real conflicts between `architecture.md`, `prd.md`, and `epics.md` that the exhaustive research for this story surfaced, and modifies one already-shipped Story 2.2 function (`revealCurrentValue`). -->

## Story

As an organization admin handling an incident,
I want a break-glass emergency rotation path that immediately retires the old credential and a stale rotation recovery mechanism,
so that I can act in seconds during a breach without waiting for checklist confirmation, and abandoned rotations don't block future work.

*Covers: FR108, FR104.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-5.3-Stale-Rotation-Recovery--Break-Glass-Emergency-Rotation`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 5.1 (`rotations` + `rotation_checklist_items` tables, `apps/api/src/modules/rotation/{schema,service,routes}.ts`, advisory-lock pattern `pg_try_advisory_xact_lock(hashtextextended('rotation:' \|\| orgId \|\| ':' \|\| credentialId, 0))`) merged | This story adds new routes to the *existing* `apps/api/src/modules/rotation/` module (not a new module), reuses the exact lock-key format for break-glass, and depends on `rotations.status` already having `'stale_recovery'` and `'break_glass_complete'` as legal CHECK values (5.1 ADR-5.1-02 declared the **full** Epic 5 state vocabulary up front specifically so this story never needs a CHECK-widening migration). |
| Story 5.2 (checklist confirm/fail/retry/complete, rotation-scoped advisory lock `hashtextextended('rotation:' \|\| orgId \|\| ':' \|\| rotationId, 0)` + CAS backstop on `rotations.version`, `enqueueSecurityAlertNotification`/post-commit dispatch pattern) merged | This story's `resume`/`abandon` endpoints reuse 5.2's rotation-scoped lock+CAS pattern verbatim (AC-15), and its notification wiring reuses 5.2's exact enqueue/dispatch idiom (AC-7, AC-10). |
| Story 2.4 (`credential_dependencies`, `archivedAt`/`archivedBy` columns, **`DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId` already implemented and shipped**) merged and `done` | **Critical — read AC-16 before assuming FR104 needs new code.** The archive-dependency endpoint this story's `*Covers: FR104*` line references **already exists** in this codebase today (`apps/api/src/modules/credentials/routes.ts` ~line 991, `apps/api/src/modules/credentials/dependencies-service.ts` `archiveCredentialDependency()`). This story does **not** build a new endpoint — it verifies the existing one satisfies FR104's full letter once 5.1's checklist-generation query exists to interact with, and adds the regression test that interaction. |
| Story 2.2 (`credentials`/`credential_versions`, `revealCurrentValue()`, `addCredentialVersion()`, `listVersionHistory()`) merged and `done` | **This story modifies already-shipped, in-production code.** `revealCurrentValue()` (`apps/api/src/modules/credentials/service.ts` line 367) and `listVersionHistory()` (line 400) currently determine "the current version" using only `purgedAt IS NULL`. AC-13/AC-14 add a new `abandonedAt` column and require both functions' "current version" logic to also exclude abandoned versions — see "Conflict Resolution & Design Decisions" below for why this is necessary and how it's scoped to be a safe, additive change. |
| Epic 3 notification infrastructure (`enqueueSecurityAlertNotification`, `dispatchDirectUserNotification`, `resolveRoutingRecipients`, `security_alerts` table with `severity` column) merged and `done` | Break-glass and stale-recovery alerts reuse this verbatim — no new notification transport. See "Notification & Alert Routing" below for the exact recipient-resolution behavior this story inherits (including a documented FR100 routing limitation this story does not fix). |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | At this story's creation time the highest migration on disk is `0025_project_invitations.sql` (idx 25). Story 5.1's own migration is illustratively `0026_rotations.sql`, 5.2's is illustratively `0027_rotation_checklist_state.sql`. This story's migration is therefore illustratively **`0028_break_glass_and_stale_recovery.sql`** — **re-read the journal immediately before generating**; if other stories land first, use the actual next free number. |

---

## Conflict Resolution & Design Decisions (Read First — Do Not Skip)

Exhaustive research against `prd.md`, `architecture.md`, `epics.md`, and the actual codebase surfaced several real conflicts and open design questions that 5.1/5.2 did not have to resolve. Each is resolved here, following the same "epic + story-level text is authoritative over older/vaguer documents; codebase-established conventions win over epic prose when the epic doesn't literally match the schema" precedent 5.1's "Architecture Conflict Resolution" table and 5.2's ADRs established.

| # | Conflict | Resolution |
|---|---|---|
| CR1 | **PRD FR108** says break-glass "**immediately retires** the old credential... creates a **mandatory** post-rotation review task requiring confirmation... within a configurable grace window (default: **4 hours**)." **epics.md AC-E5c** (a later, more specific Epic 5 annotation) says the opposite: "Break-glass rotation does **NOT** immediately retire the old credential version... remains accessible for a configurable emergency overlap window (default: **1 hour**, `BREAK_GLASS_OVERLAP_MINUTES`)." **epics.md PJ8** says the sweep is "**non-blocking**," contradicting FR108's "mandatory... requiring confirmation." | **epics.md AC-E5c + PJ8 are canonical** (they are the later, Epic-5-specific refinement of the older, vaguer PRD text — same precedent as 5.1's Architecture Conflict Resolution table). Implementation: overlap window (default 60 min, `BREAK_GLASS_OVERLAP_MINUTES`), auto-retire via pg-boss job after expiry (AC-8), non-blocking sweep alert (AC-7) — **not** a new blocking "review task" entity. See ADR-5.3-01. |
| CR2 | **architecture.md**'s directory-structure comment describes `rotation-recover.ts` as running "on startup... scans stale `in_progress` rotations **where the advisory lock is no longer held**... transitions them to `status = 'abandoned'`" — i.e. lock-presence-based detection, auto-**abandon**. **epics.md AC-E5d** (Story 5.3's own, more specific AC) requires a **time-threshold** scan (`initiated_at < NOW() - INTERVAL '1 hour'`, configurable `STALE_ROTATION_THRESHOLD_MINUTES`) that transitions to **`stale_recovery`**, never auto-resolving — "an admin must explicitly choose... the system does not auto-resolve." | **epics.md AC-E5d is canonical, and it is also the only technically coherent option**: 5.1's ADR-5.1-01 established the advisory lock as **transaction-scoped** (`pg_try_advisory_xact_lock`), auto-released the instant the *initiation* transaction commits — it was never designed to stay held for a rotation's multi-request lifetime, so "check whether the lock is still held" cannot detect a stuck rotation; there is no lock left to check by the time a rotation is stale. The only viable signal is `rotations.initiated_at` age, confirming AC-E5d's design is not just epic-preferred but the *only* implementable one given 5.1's own locking design. Job transitions to `stale_recovery` (never `abandoned`) and never auto-resolves. See ADR-5.3-02. |
| CR3 | **epics.md Story 5.3 AC text** literally specifies flat paths for resume/abandon absent from context (`POST /api/v1/rotations/:rotationId/resume`), inconsistent with every other rotation mutation route (all nested under `/api/v1/projects/:projectId/credentials/:credentialId/rotations/...`). | **Nested paths are canonical** — identical resolution to 5.2's AC-13 (which resolved the same ambiguity for FR66's `GET` route): `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/resume` and `.../abandon`. Introducing a second, flat "rotation mutation" path shape fragments the API surface for zero functional gain. |
| CR4 | **epics.md** says break-glass is "scoped to `org_admin` role only; a project admin cannot trigger break-glass." The codebase has **no literal `org_admin` role** — `OrgRole` is `'owner' \| 'admin' \| 'member' \| 'viewer'` (`apps/api/src/plugins/require-org-role.ts`), and a **separate**, same-named-values `ProjectRoleSchema` exists for project membership (`packages/shared/src/schemas/projects.ts`) but rotation routes have never consulted it (5.1 AC-7 gates purely on `auth.orgRole`). | `org_admin` = `authContext.orgRole` at rank `'admin'` or above (`minimumRole: 'admin'`, which via `roleRank()` — owner=3 ≥ admin=2 — includes **both** `admin` and `owner`, identical to every other admin-tier gate in Epic 5: 5.1's initiation, 5.2's completion). Excluding `owner` would be an inconsistent, almost-certainly-unintended reading (owner is a strict superset of admin everywhere else in this codebase) — treated as PRD-shorthand, not a literal exclusion. "A project admin cannot trigger break-glass" is **automatically true, with no new code**: rotation routes have never read `ProjectRoleSchema` at all; only `auth.orgRole` gates them. See ADR-5.3-03. |
| CR5 | epics.md says abandon leaves "the old version remains current — the new version written at initiation is marked `abandoned_version`" — but `credential_versions` has **no version-selection/"current" flag column**; `revealCurrentValue()` (Story 2.2, already shipped) unconditionally serves `ORDER BY version_number DESC LIMIT 1` among non-purged rows. Taken literally, an abandoned rotation's new (likely-incomplete, possibly-wrong) value would keep being served by `GET .../value` forever. | New nullable `credential_versions.abandoned_at` column (mirrors the existing `purged_at`/`rotation_locked_at` purpose-specific-timestamp idiom — not a generic `status` enum, consistent with 2.2's own design). `revealCurrentValue()` and `listVersionHistory()`'s "current version" computation are extended to also require `abandoned_at IS NULL`. This is a **scoped, additive** change to already-shipped Story 2.2 code — see AC-13/AC-14 and the mandatory regression-test requirement. `addCredentialVersion()`'s next-version-number computation is **unaffected** (version numbers stay strictly monotonic forever; abandonment doesn't renumber anything). See ADR-5.3-04. |
| CR6 | Neither `prd.md` nor `epics.md` says what happens if `POST .../rotations/break-glass` is called while a **normal** (non-break-glass) rotation is already `in_progress` or `stale_recovery` for the same credential. | **Break-glass supersedes (auto-abandons) any existing active rotation** for the credential, inside the same transaction: the existing rotation transitions to `abandoned`, its `newVersionId` row gets `abandoned_at` set (same mechanics as a manual `abandon` call — CR5), its previous version's `rotation_locked_at` is cleared, and a `rotation.superseded_by_break_glass` audit event links both rotation IDs. This matches break-glass's incident-response urgency (no blocking pre-step required) while never silently discarding data. See ADR-5.3-05, AC-5. |
| CR7 | FR100's routing (`resolveRoutingRecipients`, Epic 3) targets **exactly one role** (`orgNotificationRouting.routeTo`, default `'owner'`) via **exact match** (`getMembersWithRole` filters `role = X`, not `role ≥ X`) — there is no "admin-and-above" tier concept in the routing system. epics.md's "notifies all org admins" implies a tier. | This story does **not** extend FR100 to a tier-based model (cross-cutting Epic 3 change, out of scope). Break-glass/stale-recovery alerts use `enqueueSecurityAlertNotification` exactly like every other security alert in this codebase (`security.failed_auth_threshold` is the precedent) — by default this reaches **owners only** (`DEFAULT_ROUTING_ROLE = 'owner'`) unless the org has configured `routeTo: 'admin'` for these specific alert types via the **existing** Story 3.2 preferences UI. Documented explicitly as a known, accepted limitation — not silently different from every other alert type in the system. See ADR-5.3-06. |
| CR8 | **Adversarial review of this story (critical finding)**: 5.1's partial unique index `idx_rotations_one_in_progress_per_credential` (`WHERE status = 'in_progress'`) does not cover `stale_recovery`, so nothing stops a normal `POST .../rotations` initiation from creating a second, independently-active rotation for a credential that already has one sitting in `stale_recovery` — breaking the "at most one active rotation per credential" invariant AC-5 (supersede) and AC-11 (resume) both assume. | Widen the index to `idx_rotations_one_active_per_credential ON rotations(credential_id) WHERE status IN ('in_progress', 'stale_recovery')`, replacing 5.1's narrower index in this story's own migration (5.1 has not shipped yet — see "Git Intelligence Summary"). 5.1's initiation endpoint must map the resulting `23505` to its existing `409 rotation_in_progress` code. See ADR-5.3-08, AC-1, AC-5. |

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (no web UI ships in this story — same gap 5.1/5.2 flagged) |
| **Linked UI story** (if API-only) | `TBD` — inherits the same blocking note 5.1 and 5.2 both raised: Epic 5 (`5-1`, `5-2`, `5-3` in `sprint-status.yaml`) has no dedicated frontend/web story. This story does not resolve that gap and must not be blocked on it. When this story reaches `review`, the reviewer/SM must check whether a web rotation-UI story has since been added (across all three Epic 5 API stories); if not, add a single consolidated entry to `deferred-work.md` §Epic 5 covering all three — do not create three duplicate entries. |
| **Honest placeholder AC** (if UI deferred) | No dashboard placeholder is touched by this story — `AC-E2d` (overdue rotations) and the project dashboard's `upcomingRotations` were both already wired to real data by Story 5.2 (`deferred-work.md` — confirmed no remaining Epic-5-tagged dashboard placeholder exists after 5.2 lands). This story's only user-facing surface (break-glass button, stale-recovery resume/abandon decision UI, dependency-archive confirmation) has no dashboard-count analog to fake or wire. |
| **Persona journey** | API-only, no evaluator-visible UI this story. Rationale unchanged from 5.1/5.2: the incident-response workflow (an org owner/admin invoking break-glass, or resolving a stale rotation) requires UI that doesn't exist until a web rotation story is scheduled. A single-story persona stub would misrepresent an unusable partial flow. |

### Persona journey stub

N/A for this story — API-only, no UI surface exists yet. See "Linked UI story" blocking note above (inherited unresolved from 5.1/5.2).

---

## Notification & Alert Routing (Read Before Coding AC-7/AC-10)

Reuses **existing** Epic 3 infrastructure verbatim — no new queue, dispatcher, or delivery mechanism, and no changes to `packages/shared/src/constants/notification-types.ts`'s recipient-resolution logic.

**Break-glass** (AC-7) — inside the same transaction as the break-glass mutation:
```typescript
import { enqueueSecurityAlertNotification, sendNotificationJobs } from '../../notifications/dispatcher.js'

const jobs = await enqueueSecurityAlertNotification({
  orgId,
  templateId: 'rotation.break_glass', // new NOTIFICATION_ALERT_TYPES entry — AC-21
  payload: { rotationId, credentialId, projectId, reason, dependentSystems }, // sweep checklist — CR1/PJ8
  severity: 'critical',
  tx,
})
```
Also insert a `security_alerts` row (`severity: 'critical'`, `alertType: 'rotation.break_glass'`) in the same transaction — same pairing `apps/api/src/workers/check-failed-auth-threshold.ts` uses to represent "high severity" (there is **no** `severity` column on `audit_log_entries`; FR108's "high-severity audit event" is represented via this paired `security_alerts` row, not a literal audit-table field).

**`payload.reason` is admin-controlled free text delivered to an external channel — see AC-7's "Reason-field sanitization" note before wiring this call.** Verify `apps/api/src/notifications/templates/index.ts`'s actual rendering behavior for Slack mrkdwn / HTML neutralization; do not assume it is already safe.

**Stale-recovery** (AC-10) — epics.md specifies **two** distinct recipients ("the initiating admin **and** FR100-configured recipients"):
```typescript
import { dispatchDirectUserNotification, enqueueSecurityAlertNotification } from '../notifications/dispatcher.js'

// (a) the specific admin who originally initiated the now-stale rotation
const directJobs = await dispatchDirectUserNotification({
  orgId, userId: rotation.initiatedBy,
  template: { templateId: 'rotation.stale', payload: { rotationId, credentialId }, severity: 'warning' },
  tx,
})
// (b) FR100-configured recipients generally ('rotation.stale' is already reserved in
// NOTIFICATION_ALERT_TYPES per Story 5.2's own forward-note — no new constant needed here)
const routedJobs = await enqueueSecurityAlertNotification({
  orgId, templateId: 'rotation.stale', payload: { rotationId, credentialId }, severity: 'warning', tx,
})
```
Both are dispatched post-commit via `sendNotificationJobs`, identical to 5.2's `sendPendingMfaNotifications`-derived pattern (best-effort; failure is logged, never surfaced as a 500 — the notification_queue rows are durable and the existing `notification:*-catchup` crons pick them up).

**Template rendering:** both new templates fall through to the **existing** generic `[Project Vault] Notification (${templateId})` renderer (`apps/api/src/notifications/templates/index.ts`) — no dedicated template files, identical precedent to 5.2's "Notification Integration Pattern" decision.

**Known limitation (CR7, ADR-5.3-06):** by default, both alert types route to org **owners only** (`DEFAULT_ROUTING_ROLE`), not automatically to `admin`-role members too, unless the org has configured `routeTo: 'admin'` for `rotation.break_glass`/`rotation.stale` via the existing Story 3.2 preferences UI. This is identical, unmodified behavior to every other alert type in the system (e.g. `security.failed_auth_threshold`) — not a new gap introduced here.

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Migration | `credential_versions` gets 2 new nullable columns: `abandoned_at`, `break_glass_overlap_expires_at`. `rotations`/`rotation_checklist_items` CHECK constraints are **unchanged** (5.1 already declared the full vocabulary). New index `idx_rotations_status_initiated` on `rotations(status, initiated_at)` for the recovery job's scan. **Also widens 5.1's `idx_rotations_one_in_progress_per_credential` to `idx_rotations_one_active_per_credential` (`WHERE status IN ('in_progress', 'stale_recovery')`) — see CR8/ADR-5.3-08.** |
| Break-glass | `POST .../rotations/break-glass` — `org_admin` (admin/owner) only. Creates `status: 'break_glass_complete'` immediately; old version enters overlap (not immediately retired); supersedes any existing active rotation (CR6); high-severity audit + alert with sweep checklist. |
| Overlap expiry | pg-boss job `rotation:break-glass-expire` (every 1 min) auto-retires (clears `rotation_locked_at`) any version whose `break_glass_overlap_expires_at` has passed; audit-logged. |
| Stale detection | pg-boss job `rotation:recover` — startup enqueue (`singletonKey`) + 15-min recurring cron — scans `in_progress` rotations older than `STALE_ROTATION_THRESHOLD_MINUTES` (default 60), transitions to `stale_recovery`, resets non-confirmed checklist items to `unconfirmed`, notifies. |
| Resume/Abandon | `POST .../rotations/:rotationId/resume` (`stale_recovery` → `in_progress`, checklist preserved) / `.../abandon` (`stale_recovery` → `abandoned`, new version gets `abandoned_at`, old version's `rotation_locked_at` cleared). Admin/owner only. Never auto-resolved by the system (AC-E5d). |
| FR104 | Already fully implemented by Story 2.4's `DELETE .../dependencies/:dependencyId`. This story adds **zero new code** — only the end-to-end regression test proving archived dependencies are excluded from new checklists (5.1) and preserved in historical ones. |
| Reveal/history compatibility | `revealCurrentValue()`/`listVersionHistory()` (Story 2.2, already shipped) extended to exclude `abandoned_at`-set versions from "current" — scoped, regression-tested change. |
| Concurrency (RS-E5a) | Break-glass reuses 5.1's credential-scoped advisory lock (serializes against concurrent normal-initiate too), plus a `FOR UPDATE NOWAIT` row-lock read on its supersede lookup mapped to `409 rotation_lock_contention` on contention (AC-5, AC-6). Resume/abandon reuse 5.2's rotation-scoped advisory-lock + CAS pattern verbatim. The widened `idx_rotations_one_active_per_credential` (CR8) is the durable backstop guaranteeing at most one active rotation per credential across `in_progress`/`stale_recovery`. |
| Security | RLS org-scoped (no new tables — 2 new columns on an existing RLS'd table); cross-org/cross-project/cross-credential/cross-rotation → 404; sealed vault → 503; `.strict()` bodies. |
| Audit | 6 new fail-closed/system audit events: `rotation.break_glass_initiated`, `rotation.break_glass_overlap_expired`, `rotation.superseded_by_break_glass`, `rotation.stale_detected`, `rotation.resumed`, `rotation.abandoned`. |
| Notifications | Break-glass: `enqueueSecurityAlertNotification` + paired `security_alerts` row (admin-supplied `reason` must be verified-safe or sanitized before outbound delivery — AC-7). Stale: `dispatchDirectUserNotification` (initiator) + `enqueueSecurityAlertNotification` (FR100 routing). |
| Tests | Break-glass (happy path, overlap window, supersede-existing-rotation, role, concurrency), overlap-expiry job, stale-detection job (threshold boundary, checklist reset, notification), resume, abandon (+ reveal/history regression), FR104 end-to-end, cross-tenant 404s, sealed vault 503, validation 422s, audit-write-failure rollback. |

---

### AC-1: Migration — `credential_versions` New Columns + `rotations` Index

**Given** break-glass needs to track when an overlap window expires and abandonment needs to mark a version as no longer eligible to be "current" (CR1, CR5),
**When** the migration is authored,
**Then** `packages/db/src/schema/credential-versions.ts` (Story 2.2's file — extended, not replaced) gains two new nullable columns:

```typescript
// Set by break-glass (AC-2) on the SUPERSEDED version; cleared by the overlap-expiry job (AC-8)
// when it also clears rotation_locked_at. Non-null = "this version is in its break-glass
// overlap window, protected from purge until this timestamp, then auto-retired."
breakGlassOverlapExpiresAt: timestamp('break_glass_overlap_expires_at', { withTimezone: true }),
// Set by abandon (AC-12) on the NEW version created at the abandoned rotation's initiation
// (or by break-glass's supersede path, AC-5, on a rotation it displaces). Non-null = "this
// version was never validated as good; excluded from revealCurrentValue()/listVersionHistory()'s
// 'current' computation (AC-13/AC-14), but NOT purged early — it stays queryable in history."
abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
```

**And** `packages/db/src/schema/rotations.ts` (5.1's file) gains one new index (no new columns — the full `status` CHECK vocabulary was already declared by 5.1 ADR-5.1-02):
```typescript
statusInitiatedIdx: index('idx_rotations_status_initiated').on(t.status, t.initiatedAt),
```
This supports the stale-detection job's `WHERE status = 'in_progress' AND initiated_at < $threshold` scan (AC-9) — 5.1's existing `idx_rotations_credential_status` indexes `(credentialId, status)`, not useful for an org-wide, credential-agnostic threshold scan.

**And** this story's migration also widens 5.1's partial unique index — `idx_rotations_one_in_progress_per_credential` (`UNIQUE (credential_id) WHERE status = 'in_progress'`) — to cover `stale_recovery` too, since 5.1 was designed before that status existed (adversarial-review finding against this story; see CR8/ADR-5.3-08):
```typescript
// packages/db/src/schema/rotations.ts — replaces 5.1's narrower index outright
oneActivePerCredentialIdx: uniqueIndex('idx_rotations_one_active_per_credential')
  .on(t.credentialId)
  .where(sql`${t.status} IN ('in_progress', 'stale_recovery')`),
```
5.1 has not been implemented yet (see "Git Intelligence Summary"), so this lands as a straight replacement inside this story's own migration rather than a follow-up `ALTER` against already-shipped code — whoever implements 5.1 and 5.3 together should build the index in this final, widened form from the start rather than building 5.1's narrower version first. **5.1's own normal-initiation endpoint must catch the resulting unique-violation** (`23505`) the same way it already catches the `in_progress`-only case today, and return the existing `409 rotation_in_progress` code — this is one shared invariant enforced by one index, not two independent checks.

**And** the migration `packages/db/src/migrations/00NN_break_glass_and_stale_recovery.sql` (R1 — verify number) is `ALTER TABLE credential_versions ADD COLUMN ...` ×2, `DROP INDEX idx_rotations_one_in_progress_per_credential` + `CREATE UNIQUE INDEX idx_rotations_one_active_per_credential ...` (the widened invariant above), and `CREATE INDEX idx_rotations_status_initiated ...` on `rotations` — no RLS change (both tables already have RLS from 2.2's/5.1's migrations), no CHECK-constraint changes.

**And** `pnpm --filter @project-vault/db check-rls` remains clean (no new tables) and `pnpm --filter @project-vault/db migrate` succeeds locally.

---

### AC-2: `POST .../rotations/break-glass` — Happy Path

**Given** an org admin/owner is authenticated and a credential exists (with zero or more non-archived dependencies, and with or without an existing active rotation — see AC-5 for the latter),
**When** they call `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass` with `{ newValue, reason }`,
**Then**, inside a single transaction, after acquiring the credential-scoped advisory lock (AC-6, reusing 5.1's exact lock key):
1. Row-lock and read the credential's current highest non-purged, non-abandoned `credential_versions` row (the version about to be superseded) — same `FOR UPDATE` pattern as 5.1 AC-4 step 3.
2. Insert a new `credential_versions` row with `encryptValue(newValue)` — same as normal initiation (5.1 AC-4 step 4).
3. `UPDATE credential_versions SET rotation_locked_at = NOW(), break_glass_overlap_expires_at = NOW() + ($BREAK_GLASS_OVERLAP_MINUTES || ' minutes')::interval WHERE id = <superseded version>` — the version is protected from purge **and** scheduled for auto-retirement (AC-8), per CR1's overlap-window design (**not** immediately retired, contradicting PRD FR108's literal text — see CR1).
4. If an active rotation (`in_progress` or `stale_recovery`) already exists for this credential, supersede it first (AC-5) — same transaction.
5. Insert one `rotations` row: `status: 'break_glass_complete'`, `initiatedBy: auth.userId`, `notes: reason`, `newVersionId`/`previousVersionId` set exactly like normal initiation. **No checklist items are created** — break-glass's entire premise is skipping the checklist (FR108: "immediately... without waiting for dependent system confirmations").
6. Write `rotation.break_glass_initiated` audit row (fail-closed) + `security_alerts` row (`severity: 'critical'`) + enqueue `rotation.break_glass` alert with the sweep checklist payload (AC-7).
7. Commit. Return `201`.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/00000000-0000-4000-8000-000000000020/rotations/break-glass
Content-Type: application/json
Cookie: access-token=<jwt>

{ "newValue": "sk_live_EXAMPLE_EMERGENCY_ROTATED_VALUE", "reason": "Stripe key found in a public GitHub gist — rotating immediately, incident INC-4471" }
```

**Response `201`:**
```json
{
  "data": {
    "id": "e5e5e5e5-0000-4000-8000-000000000001",
    "credentialId": "00000000-0000-4000-8000-000000000020",
    "projectId": "00000000-0000-4000-8000-000000000010",
    "status": "break_glass_complete",
    "initiatedBy": "11111111-1111-4111-8111-111111111111",
    "initiatedAt": "2026-07-01T15:10:00.000Z",
    "notes": "Stripe key found in a public GitHub gist — rotating immediately, incident INC-4471",
    "checklistItems": [],
    "previousVersionOverlap": {
      "versionNumber": 4,
      "breakGlassOverlapExpiresAt": "2026-07-01T16:10:00.000Z"
    }
  }
}
```

**And** `GET .../credentials/:credentialId/value` immediately after this call returns the **new** value — same "live at initiation" invariant as normal rotation (ADR-5.1-04) — break-glass does not change this, it only changes how the *old* version's retirement is timed.

**And** `newValue`/`reason` are never logged or audit-payloaded verbatim beyond the audit row's own `reason` field (which is expected free text describing the incident, not a secret — same treatment as `notes` on normal initiation); `newValue` itself is never included in any audit payload, log line, or alert payload (same discipline as 5.1 AC-14).

---

### AC-3: Break-Glass — Role Enforcement (403)

**Given** CR4 resolves "org_admin" to `minimumRole: 'admin'` (admin **and** owner — see CR4's full reasoning),
**When** a user with `member` or `viewer` org role calls `POST .../rotations/break-glass`,
**Then**:
```http
HTTP 403
{ "code": "insufficient_role", "message": "Insufficient permissions" }
```

**And** an `owner` **is** permitted (CR4 — "org_admin only" is read as "admin-tier and above," not literal exclusion of the senior `owner` role).

**And** — the critical edge case CR4 exists to document — a user whose **project**-level role (`ProjectRoleSchema`) is `admin` but whose **org**-level role (`OrgRole`) is `member` is rejected with the same `403`: rotation routes have never consulted `ProjectRoleSchema` (5.1 AC-7 precedent), so there is no code path by which a project-scoped admin could reach this endpoint — the epic's "a project admin cannot trigger break-glass" requirement is satisfied with **zero new authorization code**. A test must seed exactly this scenario (org role `member`, project role `admin` on the target project) and assert `403`, to make this structural guarantee explicit and regression-proof rather than merely inferred.

**And** MFA enforcement is verified with a dedicated test (same pattern as 5.1 AC-7/5.2 AC-16) — break-glass is the single highest-risk endpoint in Epic 5; do not take "handled globally" on faith here of all places.

---

### AC-4: Break-Glass — Request Validation (422)

**Given** the request body schema:
```typescript
const BreakGlassRotationBodySchema = z.object({
  newValue: z.string().min(1).max(65536),
  reason: z.string().trim().min(1).max(1024),
}).strict()
```
(`reason` is **required**, unlike normal initiation's optional `notes` — FR108/AC-E5c's audit trail depends on always having an incident reason on record; there is no "break-glass with no explanation" path),

**When** invalid bodies are sent:

| Invalid body | Expected `422` `code` |
|---|---|
| `{}` (missing both fields) | `validation_error` (Zod paths `["newValue"]`, `["reason"]`) |
| `{ "newValue": "x" }` (missing `reason`) | `validation_error` (Zod path `["reason"]`) |
| `{ "newValue": "x", "reason": "" }` / `{ "reason": "   " }` (empty/whitespace-only) | `validation_error` |
| `{ "newValue": "", "reason": "incident" }` (empty value) | `validation_error` |
| `{ "newValue": "x".repeat(65537), "reason": "incident" }` | `validation_error` |
| `{ "newValue": "x", "reason": "x".repeat(1025) }` | `validation_error` |
| `{ "newValue": "x", "reason": "incident", "extra": true }` (`.strict()`) | `validation_error` |

**Then** every case is `422` via `validationError()`, no DB write, no advisory lock acquired.

---

### AC-5: Break-Glass — Supersedes Any Existing Active Rotation (CR6)

**Given** an existing rotation for the credential is `in_progress` or `stale_recovery` when break-glass is called,
**When** the break-glass transaction runs (after acquiring the credential-scoped lock, which serializes this against a concurrent normal-`initiate` call too — see AC-6),
**Then**, before inserting the new `break_glass_complete` rotation row:
1. `SELECT id, new_version_id, previous_version_id FROM rotations WHERE credential_id = $1 AND status IN ('in_progress','stale_recovery') FOR UPDATE NOWAIT` — at most one row is now a **real, enforced** guarantee (CR8/ADR-5.3-08's widened `idx_rotations_one_active_per_credential` covers both statuses in a single constraint, not two independent ones). `NOWAIT` (not a blocking `FOR UPDATE`) matters specifically here: a concurrent human `confirm`/`fail`/`retry`/`complete` call (5.2) acquires a **rotation**-scoped advisory lock, a different key domain from break-glass's **credential**-scoped lock (AC-6) — the two do not serialize against each other, so a plain blocking `FOR UPDATE` could silently stall behind a mid-flight 5.2 transaction, contradicting break-glass's fail-fast, act-in-seconds premise. If `NOWAIT` raises `55P03 lock_not_available`, catch it and return the identical `409 rotation_lock_contention` shape AC-6 already defines for advisory-lock contention — same failure mode from the caller's point of view ("someone else is touching this rotation right now, retry").
2. If found: `UPDATE rotations SET status = 'abandoned', version = version + 1 WHERE id = <found id>`.
3. `UPDATE credential_versions SET abandoned_at = NOW() WHERE id = <found.newVersionId>` (identical mechanic to AC-12's manual abandon).
4. `UPDATE credential_versions SET rotation_locked_at = NULL WHERE id = <found.previousVersionId>` (the now-abandoned rotation's superseded version no longer needs the lock — it is not "current" by construction, since a newer version was already inserted for the *superseded* rotation, and break-glass is about to insert yet another).
5. Proceed with AC-2's steps 1-7 to insert the new break-glass rotation row, **then** write the `rotation.superseded_by_break_glass` audit row: `payload: { supersededRotationId: <found id>, supersedingRotationId: <the just-inserted break-glass rotation's id> }`. There is always exactly one audit row for this event and it is always written with both IDs already populated — never a placeholder `null` and never a second row filled in after the fact (this ordering, not "implementer's choice," is the resolved design).

**And** the newly-inserted break-glass rotation's `previousVersionId` (AC-2 step 1's row-lock read) correctly resolves back to whatever was current before the superseded rotation started, **not** the abandoned rotation's half-finished new version — because the *superseded* rotation's own `newVersionId` was just marked `abandoned_at` in step 3 above, excluding it from the "current" computation (CR5).

**Response:** identical `201` shape to AC-2, with no field distinguishing "there was a superseded rotation" in the direct response — that fact is discoverable via `GET .../rotations` history (the superseded rotation now shows `status: 'abandoned'`) and via the `rotation.superseded_by_break_glass` audit entry, not via the break-glass response body (keeps the response shape identical regardless of this edge case, simplifying client handling).

**Test:** initiate a normal rotation (5.1), leave it `in_progress` with 2 pending checklist items, then call break-glass on the same credential; assert: the original rotation is now `abandoned`; its `newVersionId` row has `abandoned_at` set; `GET .../value` returns the break-glass value (not the original rotation's half-done value); the break-glass rotation's `previousVersionId` correctly points to the version that was current *before either rotation started* (i.e., 2 versions back from the break-glass rotation's own new version).

---

### AC-6: Break-Glass — Concurrency

**Given** RS-E5a's optimistic-locking requirement, and break-glass being a form of rotation initiation (not a mutation of an *existing* rotation, unlike confirm/fail/retry/complete/resume/abandon),
**When** `POST .../rotations/break-glass` is called,
**Then** it reuses 5.1's **credential**-scoped lock verbatim: `pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || credentialId, 0))` — the exact same lock key normal initiation uses. If the lock is already held (a concurrent normal-`initiate` or another concurrent break-glass call on the **same credential**), return immediately:
```http
HTTP 409
{ "code": "rotation_lock_contention", "message": "Another rotation operation is in progress for this credential. Retry.", "credentialId": "00000000-...-0020" }
```

**And**, critically, this is a **different** `code` from 5.1 AC-5's `rotation_in_progress` — because break-glass **never** returns `rotation_in_progress` (an existing active rotation does not block break-glass; it gets superseded per AC-5). `rotation_lock_contention` fires **only** on genuine simultaneous-request lock contention, never on "a rotation happens to already exist."

**And** reusing the identical lock key as normal initiation means a break-glass call and a concurrent normal-`initiate` call on the same credential correctly serialize against each other too (one succeeds, the other gets its own respective 409) — this is a deliberate, free consequence of key reuse, not additional code.

**And** `rotation_lock_contention` has a **second** source distinct from this advisory-lock case: AC-5 step 1's `FOR UPDATE NOWAIT` row-lock, taken against a concurrent 5.2 `confirm`/`fail`/`retry`/`complete` call's **rotation**-scoped advisory lock (a different key domain that the credential-scoped lock above does not serialize against). Both cases return the identical `409 rotation_lock_contention` shape — a caller cannot distinguish "the credential-scoped advisory lock was held" from "the row I'd need to supersede was locked by a concurrent human action," and does not need to; the correct client behavior (retry) is the same either way.

**Test:** two `Promise.all`-raced break-glass calls on the same credential → exactly one `201`, one `409 rotation_lock_contention`. A break-glass call racing a concurrent normal-`initiate` call on the same credential → exactly one succeeds, the other gets its respective lock-contention `409`. A break-glass call racing a concurrent 5.2 `confirm` call on an `in_progress` rotation for the same credential (contrived via a held row lock on a separate connection, mirroring 5.2 AC-19's backstop-proving test style) → break-glass's `NOWAIT` row-lock acquisition fails immediately (no blocking wait) and returns `409 rotation_lock_contention`.

---

### AC-7: Break-Glass — Audit, Security Alert & Sweep-Checklist Notification

**Given** FR108 requires "recorded as a separate high-severity audit event, automatically notifies all org admins... [with] a mandatory post-rotation review" (resolved per CR1/CR7 to: fail-closed audit + paired critical `security_alerts` row + non-blocking sweep-checklist alert via standard FR100 routing),
**When** break-glass succeeds (AC-2 or AC-5's superseding variant),
**Then**, in the same transaction:
1. `writeHumanAuditEntryOrFailClosed(tx, { orgId, actorUserId: auth.userId, eventType: 'rotation.break_glass_initiated', resourceId: rotation.id, resourceType: 'rotation', payload: { credentialId, projectId, reason, supersededRotationId } })`.
2. `INSERT INTO security_alerts (org_id, alert_type, severity, payload, status) VALUES ($orgId, 'rotation.break_glass', 'critical', $payload, 'delivered')` — pairs with the audit row to represent "high severity" (no literal `severity` column exists on `audit_log_entries` — see "Notification & Alert Routing").
3. `SELECT id, system_name FROM credential_dependencies WHERE credential_id = $1 AND archived_at IS NULL` (the sweep checklist — PJ8(a): "emits a 'sweep required' audit event listing all FR16-recorded dependent systems").
4. `enqueueSecurityAlertNotification({ orgId, templateId: 'rotation.break_glass', payload: { rotationId, credentialId, reason, dependentSystems }, severity: 'critical', tx })`.
5. Commit. Post-commit, best-effort `sendNotificationJobs` (never surfaces as a 500 on delivery failure — durable queue row + existing catchup crons pick it up, identical to 5.2's documented behavior).

**Response:** unchanged from AC-2 — the sweep checklist is delivered via the **notification payload**, not the HTTP response body (PJ8(b)'s "UI surfaces a... checklist" is a future web-story concern; this story's API-side deliverable is the notification payload carrying the data).

**Edge case — zero dependent systems:** `dependentSystems: []` in both the audit payload and the alert payload — a credential break-glass-rotated with no recorded dependencies still gets the full audit/alert treatment, just with an empty sweep list (not an error, not a different code path).

**Reason-field sanitization (adversarial-review finding, high):** `reason` is free text, up to 1024 chars, fully admin-controlled (AC-4), and flows into step 1's audit payload, step 2's `security_alerts` payload, and step 4's outbound notification payload — the last of which is eventually rendered into an **external** Slack/email message via the generic fallback renderer (see "Notification & Alert Routing"). Audit/`security_alerts` storage is safe (structured JSON payload fields, never interpolated as markup). The outbound-delivery path is not automatically safe: **before wiring step 4, read `apps/api/src/notifications/templates/index.ts`'s actual rendering behavior and confirm (or add) that free-text payload fields are never interpolated as Slack mrkdwn or raw HTML** — do not assume escaping exists without checking the real renderer. If the renderer does not already neutralize control sequences, add an explicit sanitization step for `reason` specifically at the point it enters the notification payload (step 4), not at storage (steps 1-2 must keep the raw, unmodified text for audit fidelity). This matters precisely because `reason` is designed to carry free-form incident narrative during a high-stress, fast-moving break-glass event — exactly the scenario where an attacker holding compromised admin credentials has both motive and opportunity to abuse an unescaped delivery channel (e.g. Slack `@channel`/`@here`/mrkdwn abuse, HTML/markup injection in the email renderer).

**Test:** break-glass on a credential with 3 non-archived dependencies; assert the audit payload and the enqueued notification job's payload both list all 3 system names; assert a `security_alerts` row with `severity: 'critical'`, `alertType: 'rotation.break_glass'` exists; assert an audit-write-failure (forced) rolls back the entire transaction — zero `rotations`/`credential_versions`/`security_alerts` rows persist (same `FORCED_AUDIT_FAILURE` harness pattern as 5.1/5.2). **And** a dedicated test: break-glass with `reason` containing a Slack mrkdwn control sequence (e.g. `<!channel>`) and HTML-special characters (`<script>alert(1)</script>`, `&`, `"`); assert the stored audit/`security_alerts` payload preserves the raw string verbatim (audit fidelity is never lossy), and assert the rendered/delivered notification form neutralizes it per whatever the actual `templates/index.ts` renderer does (verified, not assumed).

---

### AC-8: Break-Glass Overlap-Expiry Job

**Given** AC-E5c requires the superseded version to be "automatically retire[d]" after the overlap window, via a pg-boss job (CR1),
**When** `apps/api/src/workers/rotation-break-glass-expire.ts` runs (registered as pg-boss job `rotation:break-glass-expire`, cron `* * * * *` — every minute, matching `security/check-failed-auth-threshold`'s cadence for a security-relevant cleanup job),
**Then**, for each org (`fetchAllOrgIds()` + `runOrgScopedJob`, identical iteration pattern to `check-failed-auth-threshold.ts`):
1. `SELECT id, credential_id FROM credential_versions WHERE org_id = $orgId AND break_glass_overlap_expires_at IS NOT NULL AND break_glass_overlap_expires_at <= NOW()`.
2. For each match, inside a per-row advisory-locked step (`pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || credentialId, 0))` — same credential-scoped key as break-glass itself, so a concurrent break-glass call on the same credential can never race the expiry job mid-transition): `UPDATE credential_versions SET rotation_locked_at = NULL, break_glass_overlap_expires_at = NULL WHERE id = $versionId AND break_glass_overlap_expires_at <= NOW()` (the `WHERE` re-check is the CAS-equivalent — if the row's overlap window was extended or cleared by something else between steps 1 and 2, this is a safe no-op).
3. Write a **system-actor** audit row (manual construction — `computeAuditHmac` + `tx.insert(auditLogEntries)`, `actorTokenId: null, actorType: 'system'`, identical pattern to `check-failed-auth-threshold.ts`'s `insertAuditRow`): `eventType: 'rotation.break_glass_overlap_expired'`, `payload: { credentialVersionId, credentialId }`.

**And** the lock-acquisition-fails case (step 2's lock is held by a concurrent break-glass call on the same credential) is a silent skip, not an error — the next minute's run picks it up.

**Edge case — job runs while no rows match:** no-op, no audit rows, no error — same "nothing to do" behavior as every other prune-style worker.

**Edge case — `BREAK_GLASS_OVERLAP_MINUTES` lowered by an operator after a break-glass rotation already set a longer `break_glass_overlap_expires_at`:** the already-stored absolute timestamp is honored as-is (this job never recomputes existing rows against the current env value) — matches 5.2 AC-7's identical "env var read fresh per new action, not retroactively applied to in-flight state" precedent.

**Test:** break-glass a credential with `BREAK_GLASS_OVERLAP_MINUTES=1`; wait/advance past 1 minute (or seed a row with an already-past `break_glass_overlap_expires_at` directly for a deterministic test); run the job; assert `rotation_locked_at`/`break_glass_overlap_expires_at` are both `NULL` and the version is now a normal retention-purge candidate (reuse the existing purge-candidate query from `prune-credential-versions.ts`, same assertion style as 5.1 AC-13's inverse test).

---

### AC-9: Stale-Rotation Detection Job — Startup + 15-Minute Recurring

**Given** AC-E5d requires a startup job **and** a 15-minute recurring pg-boss check (CR2 — resolved as the only technically coherent design given 5.1's transaction-scoped lock),
**When** `apps/api/src/workers/rotation-recover.ts` (`rotation:recover` job) runs — registered **both**:
```typescript
// main.ts registerSchedules
'rotation:recover': { cron: '*/15 * * * *' },
```
**and** enqueued once immediately at every API startup, deduplicated:
```typescript
// main.ts, inside startBossAndRegisterWorkers(), alongside the existing
// notification:backfill-pending-delivery send call:
await boss.send('rotation:recover', {}, { singletonKey: 'rotation:recover' })
```
(this requires adding `singletonKey?: string` to `BossSendOptions` in `apps/api/src/lib/boss.ts` and threading it through to the underlying `this.#boss.send(name, data, options)` call — a small, additive change; `pg-boss`'s native `send()` already supports `singletonKey`, this codebase's thin wrapper type just doesn't expose it yet),

**Then**, for each org:
1. `SELECT id, credential_id, initiated_by FROM rotations WHERE org_id = $orgId AND status = 'in_progress' AND initiated_at < NOW() - ($STALE_ROTATION_THRESHOLD_MINUTES || ' minutes')::interval` (uses the new `idx_rotations_status_initiated` index, AC-1 — note this is a **global**, org-scoped scan, not filtered by credential, unlike everything else in Epic 5 so far).
2. For each match, inside a per-rotation advisory-locked transaction (`pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || rotationId, 0))` — the **rotation**-scoped key, same domain 5.2's AC-8 established, so this job can never race a concurrent human `confirm`/`fail`/`retry`/`complete` call on the same rotation):
   - `UPDATE rotations SET status = 'stale_recovery', version = version + 1 WHERE id = $rotationId AND status = 'in_progress'` (re-checked inside the lock — AC-10).
   - `UPDATE rotation_checklist_items SET status = 'unconfirmed' WHERE rotation_id = $rotationId AND status IN ('unconfirmed','failed','max_retries_exceeded')` (i.e. every non-`confirmed` item — `confirmed` items are left untouched; `retryCount` is **not** reset, matching 5.2's established "retryCount is a permanent historical record" philosophy — see AC-10 for the documented consequence).
   - Write system-actor audit row `rotation.stale_detected` (payload: `{ credentialId, initiatedBy, thresholdMinutes, pendingItemsReset }`).
   - Notify (AC-10).

**And** the lock-acquisition-fails case (a human is mid-`confirm`/`complete` on the same rotation exactly as the job scans it) is a silent skip for this cycle — the next 15-minute run (or the next startup) picks it up if it's still stale then.

**Edge case — a rotation is exactly at the threshold boundary** (`initiated_at = NOW() - threshold`, to the second): the `<` comparison excludes it (not yet stale) — a test must assert a rotation initiated exactly 60 minutes and 1 second ago (with default threshold) IS picked up, and one initiated exactly 59 minutes 59 seconds ago is NOT.

**Edge case — the job runs but finds zero stale rotations:** no-op, no error, no audit rows (same as AC-8's zero-match case).

---

### AC-10: Stale-Rotation Detection — Notification (Initiator + FR100 Routing)

**Given** epics.md specifies two distinct recipients ("the initiating admin and FR100-configured recipients" — see "Notification & Alert Routing" above),
**When** AC-9's job transitions a rotation to `stale_recovery`,
**Then**, post-commit (same durable-queue-then-best-effort-dispatch pattern as every other notification in Epic 5):
1. `dispatchDirectUserNotification({ orgId, userId: rotation.initiatedBy, template: { templateId: 'rotation.stale', payload: { rotationId, credentialId }, severity: 'warning' }, tx })` — reaches the specific admin who started it, regardless of their current org role (they may have been demoted since initiating — this still notifies them; whether they can still *act* on the resume/abandon decision is a separate, role-gated concern, AC-14).
2. `enqueueSecurityAlertNotification({ orgId, templateId: 'rotation.stale', payload: { rotationId, credentialId }, severity: 'warning', tx })` — the general FR100-routed alert (defaults to org owners per CR7).

**And** the documented `retryCount`-not-reset consequence from AC-9: an item that was `max_retries_exceeded` before staleness (retryCount already at the configured cap) is reset to `unconfirmed` by the job but **keeps** its `retryCount`. If a human later calls `fail` then `retry` on it (5.2's endpoints), the `retry` call will immediately re-hit `max_retries_exceeded` (cap already reached) — this is not a bug; the item remains reachable via `confirm` directly (5.2 AC-2 allows confirming from any prior state). Document this in a code comment at the reset site, not just here.

**Test:** seed a rotation with items in `confirmed`, `failed`, and `max_retries_exceeded` states; run the stale-detection job; assert only the `failed`/`max_retries_exceeded` items become `unconfirmed` (the `confirmed` one is untouched); assert `retryCount` is preserved on the reset item; assert both notification calls fire with the correct recipient/payload.

---

### AC-11: `POST .../rotations/:rotationId/resume` — Happy Path

**Given** a rotation is `stale_recovery` (CR3 — nested path),
**When** a user with `admin`/`owner` org role calls this endpoint (empty body, `.strict()`),
**Then**, inside the rotation-scoped advisory-locked transaction (reusing 5.2's AC-8 pattern verbatim):
1. `UPDATE rotations SET status = 'in_progress', version = version + 1 WHERE id = $rotationId AND status = 'stale_recovery' RETURNING *`.
2. **Checklist items are left exactly as they are** — "checklist preserved" per epics.md; whatever AC-9's job reset to `unconfirmed` (or left as `confirmed`) stays that way. No additional item mutation happens on resume.
3. Write `rotation.resumed` audit row (fail-closed): `payload: { credentialId, previousStatus: 'stale_recovery' }`.
4. Commit. Return `200` with the full rotation detail (same shape as 5.1's `GET .../rotations/:rotationId`), `status: 'in_progress'`.

**Response `200`:**
```json
{ "data": { "id": "b2a1c3d4-...-000099", "status": "in_progress", "version": 7, "checklistItems": [ { "id": "...", "status": "unconfirmed", "retryCount": 3, "...": "..." } ] } }
```
(note `retryCount: 3` on an `unconfirmed` item — the visible consequence of AC-10's documented reset behavior.)

**And** a resumed rotation is now subject to AC-9's stale-detection job again on its next cycle if it stays untouched past the threshold — resuming does not grant any special exemption; a rotation can cycle `in_progress` → `stale_recovery` → `in_progress` → `stale_recovery` indefinitely if nobody acts on it, which is the correct, honest reflection of "still nobody has finished this."

**And** step 1's `UPDATE ... status = 'in_progress'` can never violate CR8/ADR-5.3-08's widened `idx_rotations_one_active_per_credential`: that index constrains "at most one row per credential across `{in_progress, stale_recovery}`," and the row being resumed was already counted inside that set before the transition — flipping its own status within the set cannot create a second member of the set. No defensive `23505` handling is needed here (unlike a naive narrower-index design would have required); this is a direct, structural consequence of CR8's fix, not a separate guard this AC has to build.

---

### AC-12: `POST .../rotations/:rotationId/abandon` — Happy Path

**Given** a rotation is `stale_recovery`,
**When** a user with `admin`/`owner` org role calls this endpoint (empty body, `.strict()`),
**Then**, inside the same rotation-scoped locked-transaction pattern:
1. `UPDATE rotations SET status = 'abandoned', version = version + 1 WHERE id = $rotationId AND status = 'stale_recovery' RETURNING *`.
2. `UPDATE credential_versions SET abandoned_at = NOW() WHERE id = $rotation.newVersionId` — CR5's mechanic: the never-completed new value is excluded from "current" from this point forward.
3. `UPDATE credential_versions SET rotation_locked_at = NULL WHERE id = $rotation.previousVersionId` — the old version is no longer locked by an active rotation (the rotation is now terminal); it is once again the "current" version per AC-13's updated `revealCurrentValue()` logic, and once again subject to normal retention-purge rules (though as the now-highest non-abandoned version, it is very unlikely to be an immediate purge candidate).
4. Write `rotation.abandoned` audit row (fail-closed): `payload: { credentialId, abandonedVersionId: rotation.newVersionId, restoredCurrentVersionId: rotation.previousVersionId }`.
5. Commit. Return `200`.

**Response `200`:** `{ "data": { "id": "...", "status": "abandoned", "version": 7 } }`.

**And**, critically — a test asserts the full round-trip: `GET .../credentials/:credentialId/value` **before** this call returns the abandoned rotation's (never-finished) new value; **after** this call, the identical endpoint returns the **previous** value again, with **zero code changes needed in the `/value` route itself** — the behavior change is entirely contained in AC-13's `abandoned_at IS NULL` filter addition to `revealCurrentValue()`.

**Edge case — the abandoned rotation had a break-glass origin via AC-5's supersede path (not a `stale_recovery` → manual-abandon path):** already fully handled by AC-5 itself using the identical `abandoned_at`/`rotation_locked_at` mechanics — this endpoint is not the only code path that can produce an `abandoned` rotation, and a test should confirm both paths converge on the same observable state (a credential whose rotation was superseded by break-glass, queried via `GET .../rotations`, shows `status: 'abandoned'` identically to one manually abandoned via this endpoint).

---

### AC-13: `revealCurrentValue()` — Excludes Abandoned Versions (Regression-Critical)

**Given** CR5's design requires an abandoned version to stop being "current" without a literal schema `status` column,
**When** Story 2.2's **already-shipped** `revealCurrentValue()` (`apps/api/src/modules/credentials/service.ts` line 367) is modified,
**Then** its `WHERE` clause changes from:
```typescript
and(eq(credentialVersions.credentialId, params.credentialId), isNull(credentialVersions.purgedAt))
```
to:
```typescript
and(
  eq(credentialVersions.credentialId, params.credentialId),
  isNull(credentialVersions.purgedAt),
  isNull(credentialVersions.abandonedAt)
)
```
(`.orderBy(desc(credentialVersions.versionNumber)).limit(1)` is unchanged.)

**And** `addCredentialVersion()`'s next-version-number computation (`MAX(version_number) + 1`) is **explicitly unaffected** — do not add an `abandonedAt` filter there; version numbers remain strictly monotonic regardless of abandonment, matching every other "history is permanent" invariant in this codebase.

**Mandatory regression test (this is the single highest-risk change in this story):** a credential that has **never** had any rotation, break-glass, or abandonment (i.e., every pre-Epic-5 test scenario) must behave **byte-for-byte identically** before and after this change — `abandonedAt` is always `NULL` for such a credential's versions, so the added `isNull(...)` clause is always-true and a pure no-op. Add a test asserting `revealCurrentValue()` on a credential with 3 normal (non-rotation) versions returns the highest one, exactly as it did before this story, run against the **existing** Story 2.2 test suite (do not write a parallel/duplicate test file — extend the existing one so the regression coverage lives next to what it protects).

---

### AC-14: `listVersionHistory()` — Excludes Abandoned Versions from "Current"

**Given** the same Story-2.2-owned function (`apps/api/src/modules/credentials/service.ts` line 400) computes `isCurrent` per row for the version-history list,
**When** it is modified,
**Then**:
1. The `select` gains `abandonedAt: credentialVersions.abandonedAt`.
2. `currentVersionNumber` computation changes from `rows.find((row) => row.purgedAt === null)?.versionNumber` to `rows.find((row) => row.purgedAt === null && row.abandonedAt === null)?.versionNumber`.
3. The mapped response row gains `abandonedAt: row.abandonedAt?.toISOString() ?? null` (additive field, alongside the existing `purgedAt`/`isCurrent` — mirrors the existing pattern exactly, gives a future UI enough signal to render "this version was abandoned" distinctly from "this version was purged").

**Edge case — a credential whose only rotation ever was abandoned, and it was the credential's very first rotation (version 1 is the pre-rotation baseline, version 2 is the abandoned new value):** `isCurrent` correctly resolves back to version 1 (the first row, scanning `DESC`, with both `purgedAt` and `abandonedAt` null) — test this exact scenario explicitly, since it's the "smallest possible" abandon case and a natural off-by-one trap (a naive implementation might assume `isCurrent` always lands on some *rotated* version rather than potentially falling all the way back to the original).

**Regression test:** identical requirement to AC-13 — a non-rotation credential's version history is byte-for-byte unchanged (the new `abandonedAt` field is present but always `null`, `isCurrent` computation is unaffected).

---

### AC-15: Resume/Abandon — Concurrency (RS-E5a)

**Given** resume and abandon are mutations of an *existing* rotation record (unlike break-glass, which creates a new one),
**When** either endpoint is called,
**Then** they reuse 5.2's AC-8 rotation-scoped advisory-lock + CAS pattern **verbatim** — same lock key format (`hashtextextended('rotation:' || orgId || ':' || rotationId, 0)`), same `409 { code: "concurrent_modification", currentVersion }` shape on lock contention or a lost CAS race, same "lock is rotation-scoped, not item-scoped" caveat (irrelevant here since neither endpoint touches individual checklist items, but the lock still serializes against a concurrent `confirm`/`fail`/`retry`/`complete` call on the *same* rotation — which, given the rotation is `stale_recovery`, those four endpoints would reject anyway per their own `rotation_not_active`-style guard, AC-3 of Story 5.2 — but the lock still prevents a genuinely racy interleaving during the transition itself).

**And**, critically, resume/abandon must also correctly interleave with AC-9's stale-detection job and AC-8's overlap-expiry job — both acquire the identical lock domains (rotation-scoped for AC-9, credential-scoped for AC-8), so a human's resume/abandon call and a concurrent job run on the same rotation/credential are mutually exclusive by construction, with whichever acquires the lock first winning and the other silently skipping (jobs) or receiving `409` (human-facing endpoints).

**Test:** two `Promise.all`-raced calls — one `resume`, one `abandon` — on the same `stale_recovery` rotation → exactly one `200`, one `409`. A `resume` call racing the stale-detection job's own re-scan of the *same* rotation (contrived via a held lock on a separate connection, mirroring 5.2 AC-19's backstop-proving test style) → the human call and the job never corrupt state; the loser either gets `409` (human) or silently skips (job).

---

### AC-16: FR104 — Dependency Archival (Already Implemented, Verify + Regression Test Only)

**Given** `DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId` (`apps/api/src/modules/credentials/routes.ts` ~line 991, `archiveCredentialDependency()` in `dependencies-service.ts`) **already exists and is shipped** (Story 2.4, `done`), setting `archivedAt`/`archivedBy` (not a hard delete) and writing `credential.dependency_archived` audit,
**When** this story is implemented,
**Then** **no new endpoint, route, schema, or service function is written for FR104.** This story's only FR104-related work is:
1. Confirm (do not re-implement) that 5.1's checklist-generation query (`WHERE credential_id = $1 AND archived_at IS NULL`) correctly excludes archived dependencies from new rotation checklists — this was always 5.1's job, already specified in 5.1's own AC-4 step 6; this story just verifies it end-to-end for the first time, since 5.1 and 2.4's own archival endpoint could never be exercised together until both exist.
2. Confirm archived dependencies remain visible in **historical** rotation checklist items (5.1's snapshot design, ADR-5.1-05: `systemName` is copied at rotation-initiation time, never live-joined) — an already-confirmed checklist item referencing a since-archived dependency shows the dependency's name exactly as it was, unaffected by the later archival.
3. Add the missing end-to-end integration test.

**Test:** create a credential with 2 dependencies; initiate a rotation (2 checklist items); confirm both; complete the rotation; **archive** one dependency; initiate a **second** rotation on the same credential; assert the second rotation's checklist has exactly 1 item (the non-archived dependency); assert the **first** rotation's (historical) checklist still shows 2 items, including the now-archived one, with its original `systemName` snapshot intact.

**Explicitly not done:** changing the existing endpoint's `minimumRole: 'member'` to match epics.md Story 5.3's literal "only users with rotation initiation permission [admin/owner] may archive dependencies" text — see ADR-5.3-07 for why this would be an undocumented, out-of-scope breaking change to already-shipped Story 2.4 behavior.

---

### AC-17: Resume/Abandon — Invalid State (409/422)

**Given** resume and abandon are only reachable from `stale_recovery` (a deliberate scope boundary — see "Explicit Out of Scope," AC-25),
**When** either endpoint is called against a rotation whose status is **not** `stale_recovery` (e.g. `in_progress`, `completed`, `abandoned`, `break_glass_complete`),
**Then**:
```http
HTTP 422
{ "code": "rotation_not_stale", "message": "This rotation is not awaiting stale-recovery resolution.", "status": "in_progress" }
```
(checked immediately after acquiring the advisory lock, before any other write — mirrors 5.2 AC-3's `rotation_not_active` precedence pattern.)

**And** calling `abandon` on an already-`abandoned` rotation, or `resume` on an already-`in_progress` one, hits this identical `422` — there is no idempotent "already done" `409` distinction here (unlike 5.2 AC-3's `confirm`), because resume/abandon are rotation-level, single-shot terminal-ish transitions with no plausible legitimate double-submit scenario analogous to a checklist item's re-confirm race.

**Test:** attempt `resume` on an `in_progress` rotation (never went stale) → `422 rotation_not_stale`. Attempt `abandon` on a `completed` rotation → same. Attempt `resume` immediately after a successful `abandon` of the same rotation (now `abandoned`, not `stale_recovery`) → same.

---

### AC-18: Resume/Abandon — Role Enforcement (403)

**Given** resume/abandon are irreversible-or-near-irreversible decisions matching the risk tier of rotation initiation (5.1 AC-7) and completion (5.2 AC-16),
**When** a user with `member` or `viewer` org role calls either endpoint,
**Then**:
```http
HTTP 403
{ "code": "insufficient_role", "message": "Insufficient permissions" }
```

**Implementation:** `minimumRole: 'admin'` on both routes (admin + owner, same rank comparison as every other admin-tier gate in Epic 5).

**And**, mirroring 5.1 AC-7 / 5.2 AC-16 / AC-3 above, a dedicated test verifies MFA enforcement actually applies to both endpoints — do not take "handled globally" on faith for either.

---

### AC-19: Cross-Tenant / Not-Found Isolation (404, No Enumeration)

**Given** every endpoint in this story resolves a `:rotationId` or `:credentialId` scoped by RLS to `app.current_org_id`, identical to 5.1/5.2's established pattern,
**When** any of the following occurs:
- `:projectId`/`:credentialId`/`:rotationId` combination is valid but belongs to a different org (RLS-unreachable; app-layer backstop, same as 5.1 AC-8/5.2 AC-17),
- `:rotationId` exists but doesn't belong to the `:credentialId` in the path,
- any ID is a syntactically valid UUID that simply doesn't exist,

**Then** every case returns the identical `404`:
```http
HTTP 404
{ "code": "rotation_not_found", "message": "Rotation not found" }
```
for the resume/abandon endpoints, or:
```http
HTTP 404
{ "code": "credential_not_found", "message": "Credential not found" }
```
for `break-glass` (which resolves a credential, not an existing rotation, as its primary path parameter) — never a `403`, never a response revealing *which* case was true.

**And** malformed (non-UUID) path parameters are a Zod validation failure → `422 { code: "validation_error", ... }`, never folded into `404` (same `parseParams` pattern as every prior Epic 5 route).

**And** an integration test seeds two orgs, creates a credential + rotation in org A, and asserts an org-B admin gets `404` (not `403`, not data leakage) on `break-glass`, `resume`, and `abandon`.

---

### AC-20: Sealed Vault (503)

**Given** `break-glass` touches credential plaintext (identical risk profile to normal initiation) and `resume`/`abandon` do not (pure workflow metadata, like 5.2's confirm/fail/retry/complete), but `VAULT_GUARD_ALLOWLIST` cannot pattern-match parameterized routes (5.1 AC-9's documented, unchanged structural limitation),
**When** any of this story's three routes is called while the vault is sealed,
**Then** the response is the standard:
```http
HTTP 503
{ "status": "sealed" }
```
for all three — including `resume`/`abandon`, which, like 5.2's read/write metadata routes, are swept into the same allowlist limitation even though they don't strictly need to be. This is the same "consciously accepted trade-off" 5.1/5.2 already documented; this story does not re-litigate it.

**And** the two pg-boss jobs (AC-8, AC-9) are **not** gated by vault-seal status at all — they are backend workers, not HTTP routes, and `rotation_locked_at`/status-transition bookkeeping does not require the vault to be unsealed (no plaintext is touched by either job). Both jobs are, however, gated on vault-**unseal** for a different reason: they are registered inside `startBossAndRegisterWorkers()`, which itself only runs after `setOnVaultUnsealed(...)` fires (same registration gate as every other pg-boss job in this codebase) — so in practice neither job runs at all until the vault has been unsealed at least once, but once running, a *subsequent* re-seal does not pause them (matches the documented behavior of every other existing recurring job).

**Test:** one smoke test per route asserting `503` while sealed (matching the "read-adjacent routes don't need a separate assertion beyond one smoke check" precedent).

---

### AC-21: Audit Logging — 6 New Events

**Given** every mutation in this story writes an audit row (fail-closed for human-initiated routes; system-actor manual construction for the two background jobs, matching `check-failed-auth-threshold.ts`'s precedent),
**When** each action succeeds,
**Then** the following `AuditEvent` constants are added to `packages/shared/src/constants/audit-events.ts` (both the const object and the type union, following the exact `CREDENTIAL_*`/`PROJECT_*` pattern):

| Constant | String value | Written by | Actor |
|---|---|---|---|
| `ROTATION_BREAK_GLASS_INITIATED` | `rotation.break_glass_initiated` | AC-7 | human (fail-closed) |
| `ROTATION_SUPERSEDED_BY_BREAK_GLASS` | `rotation.superseded_by_break_glass` | AC-5 | human (fail-closed) |
| `ROTATION_BREAK_GLASS_OVERLAP_EXPIRED` | `rotation.break_glass_overlap_expired` | AC-8 | system |
| `ROTATION_STALE_DETECTED` | `rotation.stale_detected` | AC-9 | system |
| `ROTATION_RESUMED` | `rotation.resumed` | AC-11 | human (fail-closed) |
| `ROTATION_ABANDONED` | `rotation.abandoned` | AC-12 | human (fail-closed) |

**And** the two system-actor events (AC-8, AC-9) use the **manual** audit-insert pattern (`computeAuditHmac` + `tx.insert(auditLogEntries).values({ actorTokenId: null, actorType: 'system', ... })`), copied verbatim from `check-failed-auth-threshold.ts`'s `insertAuditRow()` — **not** `writeHumanAuditEntryOrFailClosed`, which requires a human `actorUserId` and is only for the four HTTP-route-driven events.

**And** every payload contains only IDs, counts, timestamps, and the free-text `reason` field (break-glass) — never `newValue` or any derivative (same discipline as 5.1 AC-14/5.2 AC-21).

**And** an audit-write-failure test (reusing the `FORCED_AUDIT_FAILURE` harness) is required for `break-glass` and `abandon` (the two most consequential human-initiated endpoints in this story) — asserts full transaction rollback: no `rotations`/`credential_versions` state changes persist.

---

### AC-22: Route Registration & Audit Classification

**Given** `route-audit.test.ts` requires every route classified in `ROUTE_ACTION_CLASSIFICATIONS` (`apps/api/src/lib/route-exemptions.ts`),
**When** the three new HTTP routes are added to the **existing** `apps/api/src/modules/rotation/routes.ts` (5.1/5.2's file — same `rotationRoutes(fastify)` export, no new registration call needed),
**Then** three entries are added:
```typescript
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass': {
  action: 'mutation', auditEvent: 'rotation.break_glass_initiated', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/resume': {
  action: 'mutation', auditEvent: 'rotation.resumed', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/abandon': {
  action: 'mutation', auditEvent: 'rotation.abandoned', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
```

**And** the two pg-boss jobs are **not** routes and are **not** added to `ROUTE_ACTION_CLASSIFICATIONS` — that registry is exclusively for HTTP routes discovered via `app.ts` static analysis; background-job audit coverage is verified by their own dedicated integration tests (AC-8, AC-9), not the route-audit CI gate.

**And** `pnpm --filter @project-vault/api test route-audit.test.ts` passes with zero unclassified routes.

---

### AC-23: Rate Limiting

**Given** the repo-wide `120 req/min` default applies unless overridden,
**When** the three routes are registered,
**Then**: `POST .../rotations/break-glass` uses `{ max: 10, timeWindowMs: 60_000, key: 'POST .../rotations/break-glass' }` — **tighter** than normal initiation's `30/min` (5.1 AC-17), reflecting that break-glass is a rarer, higher-blast-radius action than routine rotation initiation; a legitimate incident responder needs at most a handful of break-glass calls per minute across an entire org, never 10+. `resume`/`abandon` use `{ max: 30, timeWindowMs: 60_000, key: '<METHOD PATH>' }` — matching normal initiation's cadence (occasional admin decisions, not routine bookkeeping).

**And**, per the verified-not-assumed convention 5.2 AC-23 established, all three buckets are per-authenticated-`userId` (`` `${userId}:${key}` `` prefix applied by `enforceRouteRateLimit`), never global or org-pooled — confirmed against the actual `secure-route.ts`/`route-helpers.ts` implementation, not assumed.

---

### AC-24: Operational Metrics & Logging

**Given** the Maintainability NFR requires structured logging and Prometheus metrics for every rotation outcome, and break-glass/stale-recovery are the highest-signal operational events in Epic 5,
**When** each action succeeds, hits a state-machine conflict, hits the concurrency lock, fails validation, or fails audit,
**Then** emit structured pino log lines per outcome (e.g. `{ event: 'rotation.break_glass.success', credentialId, rotationId, supersededRotationId }`, `{ event: 'rotation.stale_detected', rotationId, credentialId, pendingItemsReset }`, `{ event: 'rotation.resume.success', rotationId }`, `{ event: 'rotation.abandon.success', rotationId }`) and increment `prom-client` counters:
- `rotation_break_glass_total{outcome="success"|"conflict"|"validation_error"|"audit_failed"}`
- `rotation_stale_detections_total` (incremented once per rotation transitioned to `stale_recovery` by AC-9's job — this is the primary operational health signal for "how often do rotations go unattended")
- `rotation_resolutions_total{outcome="resumed"|"abandoned"}`
- `rotation_break_glass_overlap_expirations_total` (AC-8's job)

**And** a gauge, `rotations_stale_recovery_pending_total`, reporting the current count of `rotations` rows with `status = 'stale_recovery'` — the same periodic-query-backed `prom-client` `Gauge` + `collect()` pattern as 5.1 AC-18/5.2 AC-24 — the operational visibility for "how many rotations are currently stuck awaiting a human decision."

**Critical:** never log `newValue` or any derivative — log only IDs, counts, timestamps, and the `reason` free-text field for break-glass (which is expected to be human-written incident context, not a secret, but is still excluded from any *metric label* — free text never becomes a Prometheus label value, only a structured log field).

---

### AC-25: Explicit Out of Scope

The following are **intentionally not implemented** in this story:

- **Abandoning or resuming an `in_progress` rotation directly**, without first passing through `stale_recovery` — AC-E5d's literal text ("from `stale_recovery` state, an admin must explicitly choose") only requests this narrow transition; a general "abandon any active rotation on demand" feature is not requested and is not built (AC-17).
- **A separate, tier-based ("admin-and-above") FR100 routing model** — CR7/ADR-5.3-06; this story uses the existing single-role routing verbatim.
- **A literal "mandatory post-rotation review task" entity/table** with its own approval workflow — CR1/ADR-5.3-01; the sweep checklist is delivered via the existing alert-payload mechanism, non-blocking, per epics.md PJ8 (superseding PRD FR108's older "mandatory... grace window" framing).
- **Changing Story 2.4's `DELETE .../dependencies/:dependencyId` role from `member` to `admin`/`owner`** to literally match epics.md's FR104 AC text — ADR-5.3-07; this would be an out-of-scope breaking change to already-shipped behavior.
- **A version-specific "reveal the old value during break-glass overlap" endpoint** — no such endpoint exists anywhere in this codebase today (only `GET .../value` for the current/highest version); "accessible... to allow in-flight systems to drain" (AC-E5c) means "protected from purge," not "independently re-revealable via a new API." Building one is a distinct, unrequested feature.
- **Extending `BossSendOptions`/`BossService` beyond adding `singletonKey`** — no other pg-boss wrapper capability is needed by this story.
- **Web/UI screens** for break-glass, stale-recovery resolution, or the sweep checklist — see Product Surface Contract above.
- **Machine user API key emergency rotation** — PJ7 explicitly scopes FR108 to vault-stored credentials only; the machine-user gap is Epic 7's job.

---

## Tasks / Subtasks

- [x] **Task 1: Schema migration** (AC-1)
  - [x] Add `breakGlassOverlapExpiresAt`, `abandonedAt` to `packages/db/src/schema/credential-versions.ts`
  - [x] Add `idx_rotations_status_initiated` to `packages/db/src/schema/rotations.ts`
  - [x] Widen 5.1's `idx_rotations_one_in_progress_per_credential` to `idx_rotations_one_active_per_credential` (`WHERE status IN ('in_progress', 'stale_recovery')`) — CR8/ADR-5.3-08
  - [x] Generate/author migration (verify next-free number against `meta/_journal.json` — R1)
  - [x] `pnpm --filter @project-vault/db check-rls` clean; `pnpm --filter @project-vault/db migrate` succeeds locally
- [x] **Task 2: Shared Zod schemas & constants** (extends `packages/shared/src/schemas/rotations.ts` from 5.1/5.2)
  - [x] `BreakGlassRotationBodySchema`, empty-body schemas for resume/abandon
  - [x] Add `abandonedAt` to any response schema that surfaces version data
  - [x] Add 6 new `AuditEvent.*` constants (AC-21)
  - [x] Add `'rotation.break_glass'` to `NOTIFICATION_ALERT_TYPES` (`'rotation.stale'` already reserved)
- [x] **Task 3: Config** — add `BREAK_GLASS_OVERLAP_MINUTES: z.coerce.number().int().min(1).max(1440).default(60)` and `STALE_ROTATION_THRESHOLD_MINUTES: z.coerce.number().int().min(15).max(10080).default(60)` to `apps/api/src/config/env.ts`
- [x] **Task 4: `apps/api/src/lib/boss.ts`** — add `singletonKey?: string` to `BossSendOptions`, thread through to `this.#boss.send(name, data, options)`
- [x] **Task 5: Extend `apps/api/src/modules/rotation/` module** (5.1/5.2's files, not a new module)
  - [x] `service.ts`: `breakGlassRotation`, `supersedeActiveRotation` (shared by AC-5 and any future caller — uses `FOR UPDATE NOWAIT`, maps lock failure to `409 rotation_lock_contention`), `resumeRotation`, `abandonRotation`
  - [x] `routes.ts`: register the 3 new endpoints via `secureRoute()`
- [x] **Task 6: Modify Story 2.2's `apps/api/src/modules/credentials/service.ts`** (AC-13, AC-14 — regression-critical)
  - [x] `revealCurrentValue()`: add `isNull(credentialVersions.abandonedAt)`
  - [x] `listVersionHistory()`: select `abandonedAt`, update `currentVersionNumber` computation, add `abandonedAt` to mapped response
  - [x] Extend the **existing** Story 2.2 test file(s) for these functions with the regression assertions from AC-13/AC-14 — do not create a parallel test file
- [x] **Task 7: New worker `apps/api/src/workers/rotation-break-glass-expire.ts`** (AC-8)
- [x] **Task 8: New worker `apps/api/src/workers/rotation-recover.ts`** (AC-9, AC-10)
- [x] **Task 9: `main.ts` wiring** — register both new jobs in `registerSchedules`/`registerWorkers`; add the startup `boss.send('rotation:recover', {}, { singletonKey: 'rotation:recover' })` call
- [x] **Task 10: Notification integration** (AC-7, AC-10) — wire `enqueueSecurityAlertNotification`/`dispatchDirectUserNotification` + post-commit `sendNotificationJobs`; verify (or add) `reason`-field sanitization against `apps/api/src/notifications/templates/index.ts`'s actual renderer before wiring break-glass's payload
- [x] **Task 11: Route audit + classification** (AC-22)
- [x] **Task 12: Metrics/logging** (AC-24)
- [x] **Task 13: FR104 regression test only — no new code** (AC-16)
- [x] **Task 14: Integration & unit tests** (AC-2 through AC-15, AC-17 through AC-23, AC-Quick-Reference "Tests" row)

---

## Dev Notes

### Project Structure Notes

- **No new module** — HTTP routes land in 5.1/5.2's existing `apps/api/src/modules/rotation/{schema,service,routes}.ts` files.
- **Two new worker files**: `apps/api/src/workers/rotation-recover.ts` (matches 5.1's own forward-reference and architecture.md's directory listing verbatim) and `apps/api/src/workers/rotation-break-glass-expire.ts` (new, kebab-case, matches the `check-*`/`prune-*` naming convention).
- **One modified already-shipped file**: `apps/api/src/modules/credentials/service.ts` (Story 2.2) — `revealCurrentValue()` and `listVersionHistory()` only. Do not touch `addCredentialVersion()`.
- **One extended already-shipped schema file**: `packages/db/src/schema/credential-versions.ts` (Story 2.2) — 2 new nullable columns, additive only.
- **One extended already-shipped schema file**: `packages/db/src/schema/rotations.ts` (Story 5.1) — 1 new index, no new columns, no CHECK changes.
- **One small, additive change to shared infrastructure**: `apps/api/src/lib/boss.ts`'s `BossSendOptions` gains `singletonKey?: string`.

### Key Code Patterns to Follow

- **Credential-scoped advisory lock (break-glass):** copy 5.1's `pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || credentialId, 0))` verbatim — same key domain as normal initiation, deliberately (AC-6).
- **Rotation-scoped advisory lock + CAS (resume/abandon):** copy 5.2's AC-8 pattern verbatim — same key domain as confirm/fail/retry/complete (AC-15).
- **System-actor audit write (both new workers):** copy `check-failed-auth-threshold.ts`'s `insertAuditRow()` verbatim (`computeAuditHmac` + manual `tx.insert(auditLogEntries)`, `actorTokenId: null, actorType: 'system'`) — do **not** use `writeHumanAuditEntryOrFailClosed` for these (it requires a human `actorUserId`).
- **Org iteration for background jobs:** copy `check-failed-auth-threshold.ts`'s `fetchAllOrgIds()` + `runOrgScopedJob(orgId, jobName, async ({tx}) => {...})` pattern verbatim for both new workers.
- **Notification enqueue + post-commit dispatch:** copy 5.2's "Notification Integration Pattern" (itself copied from `auth/routes.ts`'s `sendPendingMfaNotifications`) verbatim.
- **Fail-closed audit (human-initiated routes):** identical to 5.1/5.2 — `writeHumanAuditEntryOrFailClosed(tx, { orgId, actorUserId, eventType, resourceId, resourceType: 'rotation', payload, request })`.
- **Startup-once job enqueue:** copy `main.ts`'s existing `await boss.send('notification:backfill-pending-delivery', {})` call site pattern, adding the `singletonKey` option (Task 4).

### Tech Stack (Repo Pinned — unchanged from 5.1/5.2)

- Drizzle ORM 0.45.x, Zod v4 (`zod/v4`), Fastify v5, pg-boss (two new job types: `rotation:recover`, `rotation:break-glass-expire` — both colon-domain-named per `architecture.md`'s documented `{domain}:{action}` convention).

### Architecture Compliance

- MFA enforcement: global middleware — but see AC-3/AC-18's explicit test requirements for `break-glass`/`resume`/`abandon`.
- RLS: no new tables in this story; both modified tables (`credential_versions`, `rotations`) already have RLS.
- CR2's resolution supersedes `architecture.md`'s literal `rotation-recover.ts` description (lock-presence detection, auto-abandon) — implement per this story's AC-9/AC-10 (time-threshold detection, `stale_recovery` transition, never auto-resolve), not per the architecture doc's prose.

### Anti-Patterns (Do Not)

- Do NOT add a `status` enum column to `credential_versions` to represent break-glass-overlap or abandonment — use the two new purpose-specific nullable timestamp columns (AC-1), matching `rotationLockedAt`/`purgedAt`'s existing idiom.
- Do NOT implement the stale-detection job using lock-presence checking — the lock is transaction-scoped and does not survive past the initiation call; only a time-threshold scan is coherent (CR2).
- Do NOT let the stale-detection job auto-resolve (auto-abandon or auto-complete) a stale rotation — `stale_recovery` is a human-decision-only terminal-adjacent state (AC-E5d).
- Do NOT block break-glass on an existing active rotation for the same credential — supersede it instead (AC-5, CR6).
- Do NOT change Story 2.4's dependency-archive endpoint's role gate (AC-16, ADR-5.3-07).
- Do NOT build a new "reveal old version during overlap" endpoint (AC-25).
- Do NOT touch `addCredentialVersion()`'s next-version-number computation when modifying `revealCurrentValue()`/`listVersionHistory()` (AC-13/AC-14) — version numbers stay monotonic regardless of abandonment.
- Do NOT add `resume`/`abandon` support for any rotation state other than `stale_recovery` (AC-17, AC-25).
- Do NOT implement 5.1's normal-initiation endpoint or this story's break-glass/resume against 5.1's original `idx_rotations_one_in_progress_per_credential` — build the widened `idx_rotations_one_active_per_credential` (covering `stale_recovery` too) from the start (CR8/ADR-5.3-08, AC-1).
- Do NOT use a plain blocking `FOR UPDATE` in AC-5's supersede row-lock read — use `FOR UPDATE NOWAIT` and map lock failure to `409 rotation_lock_contention` (AC-5, AC-6).
- Do NOT deliver `reason` to an outbound Slack/email notification without first verifying (or adding) escaping in `apps/api/src/notifications/templates/index.ts` — do not assume the generic renderer already neutralizes mrkdwn/HTML (AC-7).

---

## Previous Story Intelligence

### Story 5.1 (`rotations` + `rotation_checklist_items`, ready-for-dev, not yet implemented)
- Established the credential-scoped advisory-lock pattern (ADR-5.1-01) this story's break-glass (AC-6) directly reuses with the **identical** key — deliberately, so break-glass and normal initiation serialize against each other for free.
- ADR-5.1-02 declared the full Epic 5 `status` vocabulary (including `stale_recovery`, `break_glass_complete`, `abandoned`) up front specifically so this story never needs a CHECK-widening migration — confirmed still true; this story adds zero new `status` values.
- ADR-5.1-04 established "new version is live at initiation, not completion" — this story's CR5/AC-13 resolution is the *first* time that invariant needs a documented exception (an abandoned new version must stop being "current" despite being the highest version number) — read both ADRs together, they are not in conflict, but a careless implementer could mistake AC-13's `abandonedAt` filter as contradicting ADR-5.1-04's principle; it does not — ADR-5.1-04 is about *normal* rotations, AC-13 only ever fires for the narrow abandoned-rotation case.

### Story 5.2 (checklist confirm/fail/retry/complete, ready-for-dev, not yet implemented)
- Established the rotation-scoped advisory-lock + CAS pattern (ADR-5.2-01) this story's resume/abandon (AC-15) directly reuses.
- ADR-5.2-02 established "retiring means clearing `rotation_locked_at`, not a `status` column" — this story's abandon/supersede logic (AC-5, AC-12) follows the identical principle, clearing `rotation_locked_at` on the previous version at every terminal (non-`completed`) transition too, generalizing ADR-5.2-02 beyond just `complete`.
- Reserved `'rotation.stale'` in `NOTIFICATION_ALERT_TYPES` specifically anticipating this story ("reserved for 5.3, unused until then") — confirmed still true; this story is the first to actually enqueue it.
- Established the "retryCount is a permanent historical record, never reset" philosophy — this story's checklist-reset-on-staleness logic (AC-9/AC-10) deliberately follows the same philosophy (resets `status`, never `retryCount`).

### Story 2.4 (`credential_dependencies`, `rotationSchedule`, done, implemented)
- Its `DELETE .../dependencies/:dependencyId` endpoint already fully implements FR104's literal behavior (archive not delete, hidden from new checklists via 5.1's own filter, preserved in history) — confirmed by direct code read (`apps/api/src/modules/credentials/routes.ts` line 991-1052), not assumed. This story adds zero new code for FR104 (AC-16).

### Story 2.2 (`credentials`/`credential_versions`, done, implemented)
- `revealCurrentValue()`, `addCredentialVersion()`, `listVersionHistory()` confirmed by direct code read (`apps/api/src/modules/credentials/service.ts` lines 320-427) — exact current implementation captured verbatim in AC-13/AC-14 to make the diff unambiguous.
- `rotation_locked_at` was built by 2.2 "specifically anticipating" Epic 5 (2.2's own comment: "when non-null, this version is locked by an in-progress or stale-recovery rotation") — confirming 2.2's authors already knew `stale_recovery` would exist, well before Epic 5 was written. This story's `abandoned_at` addition is philosophically the same kind of forward-compatible, purpose-specific column.

### Epic 3 (notification infrastructure, done, implemented)
- `enqueueSecurityAlertNotification`, `dispatchDirectUserNotification`, `resolveRoutingRecipients` confirmed by direct code read (`apps/api/src/notifications/dispatcher.ts`, `apps/api/src/modules/notifications/routing.ts`) — including the exact-match (not tier-based) role-routing semantic that produced CR7's documented limitation.

---

## Git Intelligence Summary

At story-creation time, the most recent commits (`git log --oneline -5`) are `8a6ed80 docs(story): address adversarial-review findings in 5-2` and `0bee13f docs(story): create and adversarially review 5-2` — confirming 5.1 and 5.2 have both been through their own create → adversarial-review → fix cycle but have **no implementation commits yet**. `apps/api/src/modules/rotation/`, `packages/db/src/schema/rotations.ts`, and `packages/db/src/schema/rotation-checklist-items.ts` are all absent from this branch (`ls` confirmed). Whoever implements this story must implement (or verify prior implementation of) 5.1 and 5.2 first, in that order — this story's tasks assume both stories' exact final schema/route shapes as specified in their own story files, not as currently-existing code. The established landing pattern for a story once implementation starts (visible in every prior epic): schema + migration first, then module/worker code, then route-audit classification, then tests.

---

## Pre-mortem Failure Modes

1. **Implementing the stale-detection job per `architecture.md`'s literal prose (lock-presence detection, auto-abandon) instead of this story's AC-9/AC-10 (time-threshold, `stale_recovery`, never auto-resolve).** This would silently violate AC-E5d's explicit "the system does not auto-resolve" requirement and produce a job that can never actually detect anything, since the advisory lock it would check for is transaction-scoped and released the instant *initiation* commits — there is no lock left to find "still held" by the time a rotation is stale. Read CR2 before writing a single line of `rotation-recover.ts`.
2. **Forgetting to filter `revealCurrentValue()`/`listVersionHistory()` by `abandonedAt`, or filtering it in the wrong function.** If only `listVersionHistory()` is updated but not `revealCurrentValue()` (or vice versa), `GET .../value` and the version-history list would disagree about which version is "current" after an abandonment — a subtle, hard-to-notice inconsistency that only manifests in the specific abandon-then-reveal sequence AC-12's mandatory test exercises. Both functions must change together.
3. **Adding the `abandonedAt` filter to `addCredentialVersion()`'s next-version-number computation.** This would be wrong — version numbers must stay strictly monotonic regardless of abandonment (an abandoned version still "happened" and consumed a number); filtering it there would cause a future `addCredentialVersion()` call to reuse an already-used version number, likely tripping the (currently-unique-per-credential, though not literally indexed today) version-number invariant in confusing ways.
4. **Blocking break-glass when an active rotation already exists**, instead of superseding it (AC-5). This would defeat the entire "act in seconds during a breach" premise of FR108 and force an incident responder through an extra manual cleanup step before they can act. Read CR6 before adding any "reject if rotation already active" check to the break-glass handler.
5. **Reusing `purgedAt` instead of adding `abandonedAt`** to represent abandonment (a plausible-seeming shortcut since `purgedAt IS NULL` is already filtered by `revealCurrentValue()`). This would be wrong: the retention `prune-credential-versions.ts` worker's purge semantics (zeroing `encryptedValue`, clearing `keyVersion`) are a *different* event from abandonment, and conflating them would make an incident investigator looking at `listVersionHistory()` see a version "purged" seconds after creation, which looks exactly like a retention-policy bug rather than an intentional abandonment. Read CR5/ADR-5.3-04 before touching `purgedAt` for this purpose.
6. **Extending FR100's routing to a tier-based ("admin-and-above") model** to more literally satisfy "notifies all org admins," instead of using the existing single-role routing as-is (CR7). This is real, cross-cutting Epic 3 scope creep — `resolveRoutingRecipients`/`getMembersWithRole` are shared infrastructure used by every alert type in the system; changing their semantics here would silently change behavior for `security.failed_auth_threshold` and every other existing alert type too.
7. **Skipping the mandatory Story-2.2-file regression tests** (AC-13/AC-14) because "the change is small." This is the single highest-risk change in this story precisely because it touches already-shipped, in-production code with no dedicated Epic-5-only test file to isolate the blast radius — a regression here silently breaks `GET .../value` for every non-rotation credential in the system if the `isNull()` clause is malformed.
8. **Building 5.1's normal-initiation endpoint against its original, narrower `idx_rotations_one_in_progress_per_credential` and only widening it later.** Because 5.1 has not shipped, 5.1 and 5.3 must be implemented against the **final**, widened index (`idx_rotations_one_active_per_credential`, covering both `in_progress` and `stale_recovery`) from the start (CR8/ADR-5.3-08) — otherwise a credential can end up with two simultaneously "active" rotations, breaking the single-row assumption AC-5's supersede lookup and AC-11's resume both depend on.
9. **Using a plain blocking `FOR UPDATE` in AC-5's supersede lookup instead of `FOR UPDATE NOWAIT`.** A concurrent 5.2 `confirm`/`fail`/`retry`/`complete` call holds a *rotation*-scoped advisory lock, a different key domain from break-glass's *credential*-scoped lock — the two do not serialize, so a blocking row-lock read can silently stall break-glass behind an unrelated in-flight human action, defeating its entire "act in seconds" premise (AC-5, AC-6).
10. **Wiring `reason` into the break-glass notification payload (AC-7) without first checking `apps/api/src/notifications/templates/index.ts`'s actual Slack/email rendering behavior.** `reason` is admin-controlled free text delivered to an external channel during a high-stress incident — exactly when an attacker with compromised admin credentials has both motive and opportunity to abuse an unescaped renderer (Slack mrkdwn/`@channel` abuse, HTML injection). Verify escaping exists before assuming it does; add it if it doesn't.

---

## ADRs

### ADR-5.3-01: The FR108 "mandatory post-rotation review task" is resolved as a non-blocking alert payload, not a new entity (CR1)

PRD FR108's "mandatory... grace window (default 4 hours)" predates Epic 5's refinement into `epics.md`, which explicitly narrows this to a non-blocking "sweep checklist" delivered via the alert payload (PJ8) and a 1-hour, not 4-hour, overlap window (AC-E5c). Building a new `review_tasks` table/workflow to literally satisfy the older PRD wording would duplicate information already available via `credential_dependencies` (FR16) and would introduce a blocking gate the more specific, later Epic 5 text explicitly disclaims ("even if non-blocking"). Same category of resolution as 5.1's Architecture Conflict Resolution table: later, more specific epic text wins over older, vaguer PRD/architecture prose.

### ADR-5.3-02: Stale-rotation detection uses a time-threshold scan, never lock-presence detection (CR2)

`architecture.md`'s directory-structure comment describing `rotation-recover.ts` predates 5.1's own advisory-locking design decision (ADR-5.1-01: transaction-scoped, released at initiation-commit). By the time a rotation could plausibly be "stale," no lock from its initiation is held anywhere — there is nothing left to detect via lock presence. `epics.md` AC-E5d's `initiated_at < threshold` scan is therefore not just the epic-preferred design but the only one that is actually implementable given the codebase's own established locking architecture. The job also never auto-abandons (contradicting architecture.md's stale prose) — AC-E5d is explicit that resolution is always a human decision.

### ADR-5.3-03: "org_admin role only" resolves to `minimumRole: 'admin'` (admin + owner), with no project-role dimension involved (CR4)

The codebase has no literal `org_admin` role and no project-role check on any rotation route (5.1 AC-7 precedent, unchanged by this story). "org_admin" is read as PRD-shorthand for the same admin-tier rank check every other Epic 5 admin-gated action uses; excluding `owner` would be an inconsistent, almost-certainly-unintended reading given `owner` is a strict superset of `admin` everywhere else. "A project admin cannot trigger break-glass" is automatically true because rotation routes have never consulted `ProjectRoleSchema` — this is a structural guarantee proven by a dedicated test (AC-3), not new authorization code.

### ADR-5.3-04: Abandonment is represented by a new `credential_versions.abandoned_at` timestamp column, filtered into the existing `revealCurrentValue()`/`listVersionHistory()` "current version" queries (CR5)

`epics.md`'s literal "the new version... is marked `abandoned_version`" text is PRD-level shorthand for a behavior, not a literal schema instruction — same category of resolution as 5.2's ADR-5.2-02 for "status is set to retired." A new nullable timestamp column, following the exact `rotationLockedAt`/`purgedAt` purpose-specific-column idiom Story 2.2 already established, is added and threaded into the two existing "what is current" queries. `addCredentialVersion()`'s version-numbering logic is deliberately untouched — version numbers remain permanent history regardless of abandonment, consistent with "immutable, append-only" (2.2's own documented invariant for `credential_versions`).

### ADR-5.3-05: Break-glass supersedes (auto-abandons) any existing active rotation for the same credential, rather than blocking (CR6)

Neither `prd.md` nor `epics.md` addresses this interaction explicitly. Given FR108's stated purpose — acting "in seconds during a breach" — requiring the incident responder to first manually resolve an unrelated stuck rotation before they can break-glass would directly undermine the feature's reason for existing. Superseding reuses the exact same abandonment mechanics (ADR-5.3-04) already built for the manual `abandon` endpoint, adding no new state-transition vocabulary, and is fully auditable via the new `rotation.superseded_by_break_glass` event — nothing is silently lost, only marked terminal.

**Audit-payload shape (Story 5.5 AC-11 — pinned down, no longer "implementer's choice"):** the shipped shape is **a second, separate audit row** (not a field added to the superseded rotation's own `rotation.initiated` row) — `eventType: 'rotation.superseded_by_break_glass'`, `resourceId: <the new break-glass rotation's id>`, `payload: { supersededRotationId: <the rotation that was auto-abandoned>, supersedingRotationId: <the new break-glass rotation's id> }`. Both IDs are always populated on this one row, so reconstructing "who superseded whom" never requires joining back to the superseded rotation's own audit trail — no further adjustment for Epic 8's future audit-query UI is needed on that account. Locked in by `apps/api/src/modules/rotation/routes.test.ts`'s break-glass supersede audit test.

### ADR-5.3-06: Break-glass/stale-recovery alerts use FR100's existing single-role routing verbatim; no tier-based "admin-and-above" routing is built (CR7)

`resolveRoutingRecipients`/`getMembersWithRole` (Epic 3, Story 3.2) route to exactly one configured role (default `owner`) via exact match, not rank comparison — a real, pre-existing limitation of the FR100 design, not something introduced by this story. Extending it to a tier model would be a cross-cutting change to shared notification infrastructure used by every alert type in the system (`security.failed_auth_threshold`, `service.down`, etc.), well beyond this story's scope. This story documents the limitation explicitly (orgs that want both owners and admins notified must configure `routeTo: 'admin'` via the existing preferences UI, accepting they'll then miss the owner unless the owner is *also* an admin-role member, which is impossible by definition) rather than silently building a special case for just these two alert types.

### ADR-5.3-07: Story 2.4's dependency-archive endpoint role (`member`) is not tightened to match epics.md Story 5.3's literal "rotation initiation permission" text

Changing an already-shipped, `done` Story 2.4 endpoint's authorization threshold from `member` to `admin`/`owner` is a real behavioral/breaking change with no epic-level rationale beyond a loose paraphrase ("only users with rotation initiation permission") that itself conflicts with Story 2.4's own deliberate design choice (matching the general dependency-mutation minimum — if `member` can *add* a dependency, `member` should be able to *archive* one, symmetric mutation permissions). Tightening this now, inside a story ostensibly about break-glass/stale-recovery, would be undocumented scope creep into a different, already-completed story's authorization design. If this role needs to change, it should be its own story with its own justification and its own migration-of-expectations discussion, not a side effect of this one.

### ADR-5.3-08: The "at most one active rotation per credential" invariant is enforced by a single widened unique index covering both `in_progress` and `stale_recovery`, not by the queries that read it (adversarial-review finding, critical; CR8)

5.1's partial unique index (`idx_rotations_one_in_progress_per_credential`) only ever needed to cover `in_progress` because `stale_recovery` did not exist when 5.1 was designed. Once this story introduces `stale_recovery` as a second "active" status, every downstream assumption of "at most one active rotation per credential" — AC-5's supersede lookup, AC-11's resume transition — is only as correct as the constraint that actually enforces it, and the narrower index does not. Widening the index (`idx_rotations_one_active_per_credential ON rotations(credential_id) WHERE status IN ('in_progress', 'stale_recovery')`), rather than adding an application-level pre-check before initiation, follows the same pattern 5.1/5.2 already use everywhere else for this exact class of invariant: a real database constraint that survives concurrent requests, not a read-then-write check with its own race window. This also *removes* code that would otherwise be needed: AC-11's resume no longer requires defensive `23505` handling, because the row being resumed was already the only active row for its credential under the widened constraint — resuming it can never conflict with itself. Because 5.1 has not shipped yet (see "Git Intelligence Summary"), this widening lands as this story's own migration outright, not a follow-up `ALTER` against already-shipped code; 5.1's initiation endpoint must map the resulting unique-violation to its existing `409 rotation_in_progress` code.

---

## References

- Epic source: `_bmad-output/planning-artifacts/epics.md` lines 1546-1559 (Epic 5 intro + `PJ7`, `PJ8`, `AC-E5c`, `AC-E5d`, `RS-E5a`), lines 1623-1650 (Story 5.3).
- PRD: `_bmad-output/planning-artifacts/prd.md` — FR108 (break-glass, ~line 78700 region, "Operational Monitoring & Alerts" neighborhood), FR104 (dependency archival), FR100 (per-alert-type routing), Reliability NFRs (atomic writes, rotation durability) at lines 1036-1043. **Note (CR1):** FR108's literal PRD text conflicts with epics.md's more specific AC-E5c/PJ8 — epics.md is canonical, see Conflict Resolution table.
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — `rotation:recover` job description (~line 50800, ~line 88609 — **superseded by CR2/ADR-5.3-02, do not implement as literally described**), pg-boss job-naming convention (~line 58585), OrgAdmin/MFA-enforcement convention (~line 32684), `org_health_snapshot` recurring-job precedent (~line 80348).
- Predecessor schema + patterns this story extends: `_bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md` (AC-1 schema, AC-4/AC-5 lock pattern, ADR-5.1-01/02/04), `_bmad-output/implementation-artifacts/5-2-rotation-checklist-confirmation-and-completion.md` (AC-8 lock+CAS pattern, ADR-5.2-01/02/03, "Notification Integration Pattern").
- Story 2.4 (FR104 already-implemented): `_bmad-output/implementation-artifacts/2-4-dependent-system-recording-and-expiry-rotation-schedules.md`; actual code: `apps/api/src/modules/credentials/routes.ts` lines 991-1052, `apps/api/src/modules/credentials/dependencies-service.ts` (`archiveCredentialDependency`).
- Story 2.2 (functions modified by AC-13/AC-14): actual code `apps/api/src/modules/credentials/service.ts` lines 320-427 (`addCredentialVersion`, `revealCurrentValue`, `listVersionHistory`); schema `packages/db/src/schema/credential-versions.ts`.
- Retention job (unaffected by this story, confirmed by code read): `apps/api/src/workers/prune-credential-versions.ts` — already filters `isNull(rotationLockedAt)`, no `abandonedAt` interaction needed.
- Background job precedent: `apps/api/src/workers/check-failed-auth-threshold.ts` (org-iteration, per-item advisory lock + dedup, system-actor audit write, paired `security_alerts` insert — copied verbatim by both new workers).
- pg-boss wrapper: `apps/api/src/lib/boss.ts` (`BossService`, `BossSendOptions` — gains `singletonKey`), `apps/api/src/main.ts` lines 96-174 (`registerSchedules`/`registerWorkers`/startup-send wiring).
- Notification infrastructure: `apps/api/src/notifications/dispatcher.ts` (`enqueueSecurityAlertNotification`, `dispatchDirectUserNotification`, `createOrgAdminNotificationEntries`), `apps/api/src/modules/notifications/routing.ts` (`resolveRoutingRecipients`, `getMembersWithRole` — source of CR7's documented limitation), `packages/shared/src/constants/notification-types.ts`.
- Role system: `apps/api/src/plugins/require-org-role.ts` (`OrgRole`), `apps/api/src/lib/secure-route.ts` (`roleRank`, `hasSufficientRole`, `minimumRole`), `packages/shared/src/schemas/projects.ts` (`ProjectRoleSchema` — confirmed unconsulted by rotation routes).
- SecureRoute framework + same-tx fail-closed audit: `apps/api/src/lib/secure-route.ts`, `apps/api/src/lib/audit-or-fail-closed.ts`.
- Route-audit registries: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`.
- Audit-event constants: `packages/shared/src/constants/audit-events.ts`.
- `security_alerts` schema (severity pairing): `packages/db/src/schema/security-alerts.ts`.
- Config pattern precedent: `apps/api/src/config/env.ts` (`FAILED_AUTH_THRESHOLD_COUNT`, `MFA_LOGIN_MAX_ATTEMPTS`).
- Migration journal (verify R1 before generating): `packages/db/src/migrations/meta/_journal.json`.
- Product Surface Contract rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`.
- Repo TDD rule: `AGENTS.md`.

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6 (via `/bmad-dev-story`, resumed and finalized directly in the pick-story orchestrator session after the original delegated subagent hit a session limit mid-task)

### Debug Log References

- After the initial implementation pass, the test DB migration (`0033_break_glass_and_stale_recovery.sql`) had not been applied; running `pnpm --filter @project-vault/db db:migrate` resolved a wave of 79 failing tests that were all schema-mismatch symptoms, not logic bugs.
- `rotation-recover.test.ts`'s boundary test used a 1-second margin around the 60-minute stale threshold, which flaked under real seed-call latency; widened to a 30-second margin (test-only fix, no behavior change).
- `jscpd` (repo-wide 0% duplication gate) flagged 14 clones introduced by this story; resolved via shared test/production helpers (`writeRotationAuditEntry`, `callResolutionService`, `expectForbiddenForMemberAndViewer`, `assertExactlyOneConflict`, `findBreakGlassAuditPayload`/`findBreakGlassAlertRows`/`findBreakGlassQueueRows`, `ensureWorkerTestEnv`/`findAuditRowOrgIds`/`withTwoTestOrgs` in `worker-test-helpers.ts`).
- That same dedup refactor (and a pre-existing gap in the interrupted agent's resume/abandon audit-write helper) broke `route-audit.test.ts`'s same-transaction-delegation check for initiate/break-glass/resume/abandon, since the audit write moved behind helper functions that no longer had a literal `secureCtx.tx` in the route's own source. Fixed by having `writeRotationAuditEntry`/`writeResolutionAuditOrThrow` accept `tx`/`auth` explicitly (callers pass `secureCtx.tx`/`secureCtx.auth`) and updating `route-exemptions.ts`'s `sameTransactionAuditService` values to the real delegate names.

### Completion Notes List

- AC-1 (migration): `credential_versions.breakGlassOverlapExpiresAt`/`abandonedAt`, widened `idx_rotations_one_active_per_credential`, new `idx_rotations_status_initiated` — `packages/db/src/migrations/0033_break_glass_and_stale_recovery.sql`.
- AC-2–AC-6 (break-glass initiate): `POST .../rotations/break-glass` — immediate live-value write, overlap window, auto-abandon+supersede of any existing active rotation, role/MFA enforcement, lock-contention 409.
- AC-7 (break-glass audit/alert/notification): audit event, paired `security_alerts` row, `enqueueSecurityAlertNotification` dispatch with reason-field HTML-escaping verified against the real template renderer.
- AC-8 (break-glass overlap expiry): `rotation-break-glass-expire.ts` worker, per-org scoped, auto-retires expired overlap versions.
- AC-9/AC-10 (stale-rotation detection): `rotation-recover.ts` worker — time-threshold scan (never lock-presence-based), transitions to `stale_recovery`, resets non-confirmed checklist items, dual notification (initiator + FR100-routed).
- AC-11/AC-12 (resume/abandon happy path): rotation-scoped lock + CAS, checklist preserved on resume, new version marked `abandonedAt` on abandon with old value restored.
- AC-13/AC-14 (abandoned-version exclusion, regression-critical): `revealCurrentValue()`/`listVersionHistory()` in `credentials/service.ts` now exclude `abandonedAt IS NOT NULL` rows from "current".
- AC-15 (resume/abandon concurrency): racing calls resolve to exactly one 200 / one 409 `concurrent_modification`.
- AC-16 (FR104 regression): existing dependency-archival endpoint verified end-to-end against a real checklist-generation interaction; no new production code.
- AC-17/AC-18 (invalid-state, role/MFA enforcement for resume/abandon): 422 `rotation_not_stale`, 403/`mfa_required` gating.
- AC-19 (cross-tenant isolation): break-glass/resume/abandon all 404 (not 403) cross-org.
- AC-20 (sealed vault): break-glass/resume/abandon fail closed with 503.
- AC-21 (audit events): 6 new `AuditEvent.*` constants.
- AC-22 (route audit/classification): all 3 new routes registered via `secureRoute()`; `route-exemptions.ts` classifications added and same-transaction-delegation verified.
- AC-23 (rate limiting): break-glass/resume/abandon covered by `resolutionRateLimit`/existing rate-limit config.
- AC-24 (metrics/logging): `rotationBreakGlassTotal`, `rotationStaleDetectionsTotal`, `rotationResolutionsTotal`, `rotationBreakGlassOverlapExpirationsTotal`, `rotationsStaleRecoveryPendingTotal` gauges/counters.
- Final verification: `tsc --noEmit` clean across `apps/api`/`packages/db`/`packages/shared`; `eslint` 0 errors (pre-existing unrelated warnings only); `jscpd` 0 clones repo-wide; 249/249 tests passing across every touched suite (rotation routes/service/schema/metrics, both new workers, prune-credential-versions, credentials service, boss, env, route-audit).
- Not yet run in this session: the full `make ci` gate (typecheck/lint/migrate/check-rls/audit-baseline/env-example/pnpm audit/generate-spec) — deferred to the pick-story flow's C3 CI-gate step.

### File List

**Migration / schema**
- `packages/db/src/migrations/0033_break_glass_and_stale_recovery.sql` (new)
- `packages/db/src/migrations/meta/0031_snapshot.json` (new)
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/credential-versions.ts`
- `packages/db/src/schema/rotations.ts`
- `packages/db/src/schema/rotations-schema.test.ts`

**Shared package**
- `packages/shared/src/constants/audit-events.ts` (+ test)
- `packages/shared/src/constants/notification-types.ts` (+ test)
- `packages/shared/src/constants/operational-event-types.ts` (+ test)
- `packages/shared/src/schemas/credentials.ts` (+ test)
- `packages/shared/src/schemas/rotations.ts` (+ test)

**API — rotation module**
- `apps/api/src/modules/rotation/service.ts`
- `apps/api/src/modules/rotation/routes.ts` (+ test)
- `apps/api/src/modules/rotation/schema.ts` (+ test)
- `apps/api/src/modules/rotation/metrics.ts` (+ test)

**API — credentials (Story 2.2 regression-critical change)**
- `apps/api/src/modules/credentials/service.ts`
- `apps/api/src/modules/credentials/db-helpers.ts`
- `apps/api/src/modules/credentials/routes.test.ts`

**API — new workers**
- `apps/api/src/workers/rotation-break-glass-expire.ts` (new, + test)
- `apps/api/src/workers/rotation-recover.ts` (new, + test)
- `apps/api/src/workers/worker-test-helpers.ts` (new)
- `apps/api/src/workers/prune-credential-versions.test.ts` (dedup-only changes)

**API — lib / config / wiring**
- `apps/api/src/lib/rotation-locks.ts` (new)
- `apps/api/src/lib/boss.ts` (+ test)
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/config/env.ts` (+ test)
- `apps/api/src/main.ts`
- `.env.example`
</content>
