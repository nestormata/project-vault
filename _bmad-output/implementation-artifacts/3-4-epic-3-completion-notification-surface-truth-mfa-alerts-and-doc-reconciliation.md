# Story 3.4: Epic 3 Completion — Notification Surface Truth, MFA Alerts & Doc Reconciliation

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-30 — Epic 3 closure story derived from epic-3-retro-2026-06-30.md.
     Closes G2 product-surface gate gaps: /alerts route truth, dashboard alert counts, MFA alert stubs,
     AC-E3a settings test UI, planning-doc reconciliation, and epic-close hygiene (P3, alert.pending_epic3 grep). -->

## Story

As a vault evaluator and org administrator,
I want notification routes, dashboard counts, MFA security alerts, and settings test delivery to reflect the notification infrastructure that Stories 3.1–3.3 shipped,
so that Epic 3 is **product-complete** per the G2 epic gate — not API/backend-complete with orphaned placeholders and silent MFA deferrals.

*Covers: FR51 (AC-E3a UI), FR73 (MFA complement), FR107 (nav/route truth), AC-E2d (alert portion), G2/G3 product-surface contract.*  
*Source: `_bmad-output/implementation-artifacts/epic-3-retro-2026-06-30.md`*

---

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** | N/A — **Epic 3 closure story** |
| **Honest placeholder AC** | Project-scoped `alertCount` stays `0` until alerts carry `project_id` (Epic 6+) — documented in ADR-3.4-02 |
| **Persona journey** | **Riley (admin):** bookmarks `/alerts` → lands on inbox at `/notifications` → org dashboard shows real unresolved alert count → Settings → Notifications → **Send test notification** confirms SMTP. **Morgan (member):** uses recovery code at login → receives email/inbox alert on own account. |

**Epic 3 gate:** After this story merges, SM may set `epic-3: done` in `sprint-status.yaml` **only if** all ACs pass and `scripts/check-alert-pending-epic3.ts` passes (zero `alert.pending_epic3` under `apps/api/src` — **no string-splitting bypasses**).

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Stories 3.1–3.3 merged and passing CI | Consumes existing dispatcher, templates, inbox, settings UI — no greenfield notification architecture. |
| Epic 3 retrospective reviewed | Scope derived from retro traceability matrix (CP-1–CP-5, P3-1–P3-3, D3-1–D3-2, O-1). |
| `@project-vault/shared` dashboard + project schemas | Extend counts in existing shapes — do not redefine Zod schemas inline. |

---

## Epic Cross-Story Context

| Story | Relationship to 3.4 |
|---|---|
| 3.1 | Admin test API `POST /api/v1/admin/notifications/test` exists. 3.4 adds **settings UI** wrapper (AC-E3a) and closes E3-1 doc debt. Sync story file `Status:` to `done` (P3). |
| 3.2 | `/settings/notifications` exists. 3.4 adds admin test panel; extends `NOTIFICATION_ALERT_TYPES` with MFA types for preferences/routing UI rows. |
| 3.3 | Inbox at `/notifications` + nav bell. 3.4 fixes **orphan `/alerts` placeholder** (G3) and wires org dashboard alert truth. |
| 1.8 / 1.9 | MFA recovery + failed-auth planted `alert.pending_epic3`. Failed-auth closed in 3.1; **MFA paths in `mfa.ts` are 3.4 scope**. |
| 2.8 | Dashboard truth pattern (`dashboard-stats.ts`, batched queries). 3.4 applies same discipline to **org-level** `unresolvedAlertCount`. |
| Epic 4 | Invitation emails need SMTP test path — 3.4 AC-E3a UI unblocks evaluator verification without curl. |
| Epic 6 | Project-scoped service alerts — **out of scope**; project list `alertCount` remains honestly `0` (ADR-3.4-02). |

---

## Retro Traceability Matrix

Every retro finding maps to an acceptance criterion:

| Retro ID | Finding | AC |
|---|---|---|
| A2 | `/alerts` placeholder while nav uses `/notifications` | AC-1 |
| A3 | `auth-guard.ts` lists orphan `/alerts` | AC-1 |
| A4 | Stale `placeholder-sections.test.ts` | AC-2 |
| A6 / CP-5 | Story 3.1 file `Status: review` vs sprint `done` | AC-3 |
| A5 / CP-5 | Story 3.3 Dev Agent Record empty | AC-3 |
| B1 / D3-2 | Story 3.3 persona says `/alerts` | AC-4 |
| B2 / O-1 / CP (AC-E3a) | No settings-page test notification | AC-5 |
| B3 / CP-4 | MFA `alert.pending_epic3` stubs | AC-6, AC-7 |
| B4 / D3-1 | Stale `mfa-policy-matrix.md` | AC-8 |
| B7 / CP-2 | Stale `deferred-work.md` `/alerts` row | AC-9 |
| C1 / CP-3 | Hardcoded alert counts | AC-10, AC-11 |
| E3-1 / P3-3 | SMTP env vs Epic 9 unresolved in deferred-work | AC-9 |
| P3-1 | No epic-close grep for `alert.pending_epic3` | AC-12 |
| P3-2 | Epics beta-cut vs G2 inbox note | AC-13 |
| C2 | Credential expiry notification jobs | **Out of scope** — remains in `deferred-work.md` |
| C3 | `notification_queue` failed/DLQ cleanup | **Out of scope** — track in deferred-work |
| C4 | Dispatcher N+1 preferences | **Out of scope** — TODO comment only |
| D1 | `architecture.md` secrets naming | **Out of scope** — Epic 2 retro D1 |

---

## Architecture Conflict Resolution

| Source wording | Canonical for 3.4 | Rationale |
|---|---|---|
| Story 3.3 persona: opens `/alerts` | Canonical route: **`/notifications`**; `/alerts` **301/302 redirects** | Implementation chose `/notifications`; nav-model already aligned (`nav-model.ts` line 11) |
| Epic 1.8: email alert to **the user** on recovery | Use **`dispatchDirectUserNotification()`** targeting `userId` — **not** org routing to admins | Security-sensitive self-alert; org routing would notify wrong people |
| MFA stub alert types `mfa.recovery_used` | Canonical registry IDs: **`security.mfa_recovery_used`**, **`security.mfa_recovery_codes_regenerated`** | Matches `NOTIFICATION_ALERT_TYPES` namespace pattern |
| AC-E3a: test from settings page | Web form action → existing **`POST /api/v1/admin/notifications/test`** | No duplicate SMTP logic in web layer |
| Project list `alertCount` | Remain **`0`** with ADR until `security_alerts.project_id` exists | Alerts are org-scoped today — do not duplicate org count on every project row |
| Org `unresolvedAlertCount` | **`COUNT(*)` from `security_alerts` WHERE `status != 'dismissed'`** | Org-admin aggregate only — **not** per-user inbox unread (see ADR-3.4-05) |
| MFA types in org routing UI | **`security.mfa_*` types excluded** from admin routing table | Direct-user alerts must not be routable to owner/admin (ADR-3.4-06) |
| MFA direct dispatch channels | **Email + inbox only** — no org Slack webhook | Self-alert to Slack webhook is wrong recipient model (ADR-3.4-07) |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| Route truth | `/alerts` redirects to `/notifications`; no `PlaceholderSection` on alerts URL |
| Placeholder tests | Updated — no "Epic 3" deferral copy for alerts |
| P3 hygiene | Story 3.1 file `Status: done`; 3.3 Dev Agent Record filled from git history |
| MFA alerts | New types in shared registry; templates; `dispatchDirectUserNotification`; remove `alert.pending_epic3` from `mfa.ts` |
| Dashboard truth | Org dashboard + project dashboard `unresolvedAlertCount` from DB |
| Settings test UI | Admin-only "Send test notification" on `/settings/notifications` |
| Docs | Update `deferred-work.md`, `mfa-policy-matrix.md`, epics beta-cut note, story 3.3 persona |
| Epic close guard | CI/test: zero `alert.pending_epic3` in `apps/api/src` |
| Epic status | SM sets `epic-3: done` after 3.4 merges + G2 checklist |

---

## AC-1: `/alerts` Route Redirect (G3)

**Given** Story 3.3 shipped the inbox at `(app)/notifications/*`,
**When** a user navigates to `/alerts` (bookmark, onboarding link, external doc),
**Then** replace the placeholder page with a **server redirect** to `/notifications`:

```typescript
// apps/web/src/routes/(app)/alerts/+page.server.ts
import { redirect } from '@sveltejs/kit'
import { resolve } from '$app/paths'

export function load() {
  redirect(302, resolve('/notifications'))
}
```

**And** delete `apps/web/src/routes/(app)/alerts/+page.svelte` (placeholder).

**And** keep `/alerts` in `auth-guard.ts` protected route list — redirect still requires auth.

**And** verify `nav-model.ts` continues to href `/notifications` (no change required if already correct).

**And** add web test: authenticated GET `/alerts` returns **302** with `Location` ending in `/notifications` (no placeholder HTML body).

**Pre-mortem hardening:** use **308 permanent redirect** if SEO/bookmarks should cache target; **302** acceptable for MVP — pick one and document in Dev Agent Record.

---

## AC-2: Placeholder Copy & Tests

**Given** alerts UI is no longer a placeholder,
**When** tests run,
**Then** update `apps/web/src/routes/placeholder-sections.test.ts`:

- Remove `alerts` from expected placeholder keys **OR** remove `alerts` entry from `placeholder-copy.ts` if no route references it.
- Assert `alerts` key absent from active placeholders (preferred) **or** copy no longer mentions "Epic 3".

**And** remove stale `alerts` blurb from `placeholder-copy.ts` if the key is deleted.

**Regression:** `health` and `settings` placeholder tests unchanged.

---

## AC-3: Story File Status & Dev Record Hygiene (P3)

**Given** sprint-status marks 3.1 and 3.3 as `done`,
**When** this story completes,
**Then**:

1. Set `3-1-email-and-slack-notification-delivery.md` header `Status: done` (after confirming code review complete — do not change if review findings remain open; fix findings first).
2. Fill `3-3-in-product-notification-inbox.md` **Dev Agent Record** from implementation git history:
   - Decisions, problems, test coverage, files changed (minimum 4 bullets each section).

**No code change required** for AC-3 beyond verification — documentation-only subtask acceptable in same PR.

---

## AC-4: Update Story 3.3 Persona Journey (D3-2)

**Given** canonical inbox URL is `/notifications`,
**When** docs are reconciled,
**Then** update Story 3.3 Product Surface Contract persona journey:

> **Morgan (member):** nav bell → opens **`/notifications`** inbox → marks read → SSE updates badge.

*(Process/doc AC — edit story file in same PR.)*

---

## AC-5: AC-E3a — Send Test Notification on Settings Page (O-1)

**Given** an org owner/admin with MFA enrolled visits `/settings/notifications`,
**When** they click **Send test notification**,
**Then** the page calls `POST /api/v1/admin/notifications/test` via the existing web API client and displays results:

```typescript
{ email: 'delivered' | 'failed' | 'not_configured', slack: 'delivered' | 'failed' | 'not_configured' }
```

**Implementation:**

1. Add `postAdminNotificationTest(fetch)` to `apps/web/src/lib/api/notifications.ts` (or `admin.ts` if that module exists — follow existing admin API client patterns).
2. Add `sendTest` form action in `(app)/settings/notifications/+page.server.ts` — **owner/admin + MFA** required (match API guards).
3. Add UI section in `+page.svelte` visible only when `data.isAdmin` — show success/warning banners per channel result; no fake "delivered" when API returns `not_configured`.

**And** add web unit test or server load test asserting admin sees the test panel; member does not.

**Security:** Do not expose SMTP credentials in UI — only status enum results (matches API).

**And** surface API **429** rate-limit responses from `POST /admin/notifications/test` (10/hour) as a user-visible warning — do not retry automatically.

**Note (existing 3.1 behavior):** test email sends to `SMTP_FROM`, not the admin's inbox — UI copy must say "Test sent to configured From address" to avoid false-negative evaluator confusion.

---

## AC-6: MFA Alert Types in Shared Registry

**Given** MFA recovery events must participate in preferences/routing,
**When** types are registered,
**Then** add to `packages/shared/src/constants/notification-types.ts`:

```typescript
export const NOTIFICATION_ALERT_TYPES = [
  'security.failed_auth_threshold',
  'security.mfa_recovery_used',              // NEW
  'security.mfa_recovery_codes_regenerated', // NEW
  'credential.expiry',
  // ... existing entries unchanged
] as const
```

**And** add labels in web `ALERT_TYPE_LABELS` on settings page:

| Type | Label |
|---|---|
| `security.mfa_recovery_used` | MFA Recovery Code Used |
| `security.mfa_recovery_codes_regenerated` | MFA Recovery Codes Regenerated |

**And** rebuild `@project-vault/shared` before API tests.

**And (ADR-3.4-06):** filter `security.mfa_recovery_used` and `security.mfa_recovery_codes_regenerated` **out of** the org routing form in `(app)/settings/notifications/+page.svelte` — these types are direct-user only and must not appear in `routeTo_*` selects. Preferences table may still show them for personal channel control.

---

## AC-7: Wire MFA Alerts — Remove `alert.pending_epic3` (CP-4)

**Given** Epic 3 notification infrastructure is live,
**When** MFA recovery events occur,
**Then** replace stdout stub logs in `apps/api/src/modules/auth/mfa.ts` with dispatcher calls.

### AC-7a: `dispatchDirectUserNotification()` helper

Add to `apps/api/src/notifications/dispatcher.ts`:

```typescript
/**
 * Delivers a notification to a specific user (self-alert).
 * Skips org routing — uses that user's preferences only.
 * Used for MFA recovery events (Epic 1.8 AC).
 */
export async function dispatchDirectUserNotification(opts: {
  orgId: string
  userId: string
  template: NotificationTemplate
  tx: Tx
}): Promise<NotificationQueueJob[]>
```

**Behavior:**

1. Load preferences via `getPreferences(orgId, userId, tx)`.
2. Filter to matching `alertType === template.templateId`.
3. Apply severity filter + dedup (same as `processRecipientPreferences`).
4. Enqueue **email and inbox channels only** (ADR-3.4-07 — no org Slack webhook for self-alerts).
5. Return jobs for `sendNotificationJobs()` **after** transaction commits.

**Mandatory wiring pattern (Self-Consistency — do not leave boss unreachable):**

| Callsite | Service returns | Route sends jobs |
|---|---|---|
| `POST /auth/mfa/recover` → `recoverWithCode()` | Extend return type with `notificationJobs: NotificationQueueJob[]` | `auth/routes.ts` ~line 560: after success, `await sendNotificationJobs(fastify.boss, result.notificationJobs)` |
| `POST /auth/mfa/regenerate-recovery-codes` → `regenerateRecoveryCodes()` | Return `{ recoveryCodes, generatedAt, notificationJobs }` from service | `auth/routes.ts` ~line 354–356: after `sendMfaAction`, send jobs via `fastify.boss` |

**Do not** import `BossService` into `mfa.ts` service layer — keep pg-boss at route/worker boundary (matches failed-auth worker pattern spirit).

**Multi-org edge case (Pre-mortem):** `recoverWithCode` uses `activeOrgForUser()` — notification must use **that resolved `orgId`**, not JWT org from a stale session. Test: user in two orgs recovers while membership active in org B → queue row `org_id = B`.

**Security (Red Team):** MFA template payloads must **never** include plaintext recovery codes, bcrypt hashes, or TOTP secrets — only `{ userId, remainingRecoveryCodes: number }`.

### AC-7b: Recovery code used

**When** `recoverWithCode()` succeeds (after audit write, before return),
**Then** dispatch:

```typescript
templateId: 'security.mfa_recovery_used'
severity: 'critical'
payload: { userId, remainingRecoveryCodes }
```

**And** remove lines 547–549 (`alert.pending_epic3` stdout).

### AC-7c: Recovery codes regenerated

**When** recovery codes are regenerated (after audit write),
**Then** dispatch:

```typescript
templateId: 'security.mfa_recovery_codes_regenerated'
severity: 'warning'
payload: { userId, remainingRecoveryCodes }
```

**And** remove lines 413–415 (`alert.pending_epic3` stdout).

### AC-7d: Templates

Add renderers in `apps/api/src/notifications/templates/` (new file or extend index):

| Template ID | Email subject (example) | Severity |
|---|---|---|
| `security.mfa_recovery_used` | `[Project Vault] MFA recovery code used on your account` | critical |
| `security.mfa_recovery_codes_regenerated` | `[Project Vault] MFA recovery codes were regenerated` | warning |

Must export `inboxTitle` / `inboxBody` for inbox worker (follow `security.failed_auth_threshold` pattern).

### AC-7e: Integration tests

Add `apps/api/src/modules/auth/mfa-notification.integration.test.ts` (or extend existing MFA integration suite):

1. Recovery code used → `notification_queue` row for affected user with `templateId: security.mfa_recovery_used`.
2. Regenerate codes → queue row with `security.mfa_recovery_codes_regenerated`.
3. Assert **no** log line containing `alert.pending_epic3` (capture stderr).
4. User with `channel: none` for type → suppressed (no queue row).
5. Payload snapshot test — rendered email/inbox body **must not** contain recovery code strings.
6. Cross-org isolation — org A alert enqueue must not appear under org B RLS scope.

---

## AC-8: Update MFA Policy Matrix (D3-1)

**Given** alert delivery status changed in Epic 3,
**When** docs are reconciled,
**Then** update `_bmad-output/planning-artifacts/mfa-policy-matrix.md` row **Alert delivery**:

| Surface | Status |
|---|---|
| FR73 failed-auth threshold | Live since Story 3.1 |
| MFA recovery used / codes regenerated | Live since Story 3.4 |
| Remaining `alert.pending_epic3` | **None** — grep gate |

Remove "stub until 3.1" language.

---

## AC-9: Deferred-Work & E3-1 Doc Reconciliation (CP-2, P3-3)

**When** this story merges,
**Then** update `_bmad-output/implementation-artifacts/deferred-work.md`:

1. **Close E3-1** — mark ✅ with reference: env-var SMTP MVP (Story 3.1 AC); Epic 9 adds admin UI (`FR86`) without breaking env fallback.
2. **Remove or update** shell placeholder row for `/alerts` — state: redirects to `/notifications` (Story 3.4).
3. **Add Epic 3 closure note** — epic `done` gated by this story.
4. Keep **credential expiry notification jobs** and **notification_queue DLQ cleanup** as open deferrals.

---

## AC-10: Org Dashboard `unresolvedAlertCount` (CP-3)

**Given** `security_alerts` rows exist for the org,
**When** `GET /api/v1/dashboard` is called,
**Then** `unresolvedAlertCount` equals:

```sql
SELECT count(*)::int FROM security_alerts
WHERE org_id = :orgId AND status != 'dismissed'
```

**Semantics (Self-Consistency):** Includes `PENDING_DELIVERY`, `delivered`, and any non-`dismissed` status. Excludes dismissed only. Does **not** count per-user `notification_inbox` unread rows (different metric — nav badge).

**Implementation:** Add `getUnresolvedSecurityAlertCount(tx)` to `apps/api/src/modules/projects/dashboard-stats.ts` (prefer extending `dashboard-stats.ts` for parity with Story 2.8). Query **must** run inside existing `withOrg` / `secureRoute` transaction — never bare `getDb()` (Red Team cross-org leak).

**And** update `getOrgDashboardData()` to use real count.

**And** extend `dashboard-stats.test.ts` fixture:

- Seed 2 alerts (one `delivered`, one `dismissed`) → expect count **1**.
- Seed zero alerts → expect **0**.

---

## AC-11: Project Dashboard `unresolvedAlertCount` (CP-3)

**Given** security alerts are org-scoped (no `project_id` column),
**When** `GET /api/v1/projects/:projectId/dashboard` is called,
**Then** `unresolvedAlertCount` returns the **same org-wide count** as AC-10 (not per-project).

**Document ADR-3.4-01** in Dev Agent Record: project dashboard shows org unresolved security alerts until Epic 6 project-scoped monitoring alerts exist.

**And** update `buildProjectDashboard()` in `dashboard-stats.ts` — pass org unresolved count into `unresolvedAlertCount` field.

---

## AC-12: ADR-3.4-02 — Project List `alertCount` Stays Zero

**Given** `GET /api/v1/projects` list items include `alertCount`,
**When** no project-scoped alert source exists,
**Then** `alertCount` remains **`0`** for each project.

**And** add code comment at `projects/routes.ts` line ~168 referencing ADR-3.4-02.

**Rationale:** Duplicating org-wide unresolved count on every project row misleads evaluators. Org dashboard (AC-10) is the truthful aggregate surface until Epic 6.

**Test:** Explicit assertion that list `alertCount` is 0 even when org has unresolved security alerts (documents honest semantics).

---

## AC-13: Epic-Close Guard — Zero `alert.pending_epic3` in Runtime Code

**Given** Epic 3 claims alert stubs are closed,
**When** CI runs,
**Then** add a guard (choose one):

**Option A (required):** `scripts/check-alert-pending-epic3.ts`:

- Recursively scan `apps/api/src/**/*.{ts,tsx,js}` (not docs, not `_bmad-output`).
- Fail on literal substring `alert.pending_epic3` (Red Team: reject split-string obfuscation).
- Exit 0 only when zero matches.

Wire into `Makefile` `ci` target same story (G3 — guard ships with story).

**Option B:** Vitest in `apps/api` scanning source files.

**Acceptance:** `rg 'alert\.pending_epic3' apps/api/src` returns **no matches** after AC-7.

---

## AC-14: Epics Beta-Cut Clarification (P3-2)

**When** docs are reconciled,
**Then** add a clarifying note to `_bmad-output/planning-artifacts/epics.md` Epic 3 header (after beta-cut line):

> **G2 gate:** FR107 inbox and FR100 routing are required for **epic completion** in sprint-status. T2 beta-cut defers them only for **external tier packaging**, not for marking `epic-3: done`.

*(Doc-only — PO/SM edit in same PR.)*

---

## AC-15: Epic 3 Completion — Sprint Status (G2)

**Given** all AC-1 through AC-14 pass and CI is green,
**When** code review marks Story 3.4 `done`,
**Then** SM updates `sprint-status.yaml`:

```yaml
epic-3: done
3-4-epic-3-completion-notification-surface-truth-mfa-alerts-and-doc-reconciliation: done
```

**Preconditions checklist (must all be true):**

- [ ] `/alerts` redirects; inbox works at `/notifications`
- [ ] Org dashboard shows real `unresolvedAlertCount`
- [ ] MFA alerts enqueue; no `alert.pending_epic3` in `apps/api/src`
- [ ] Settings test notification UI for admins
- [ ] `deferred-work.md` + `mfa-policy-matrix.md` updated
- [ ] `epic-3-retrospective: done` (already set)

---

## AC-16: Out of Scope

| Item | Deferred to |
|---|---|
| Credential expiry notification pg-boss jobs | Future story / Epic 3.x — columns exist from 2.4 |
| `notification_queue` failed status / DLQ cleanup | deferred-work.md |
| Dispatcher batch preference lookup (N+1) | Performance — TODO remains |
| `architecture.md` secrets→credentials rename | Epic 2 retro D1 |
| Move inbox from `/notifications` to `/alerts` | Rejected — redirect approach chosen |
| Playwright E2E for notifications | Test automation hardening |

---

## Architecture Decisions (Pre-approved)

### ADR-3.4-01: Project dashboard shows org-wide unresolved security alert count

Security alerts lack `project_id`. Project dashboard `unresolvedAlertCount` mirrors org count until Epic 6 introduces project-scoped alert entities.

### ADR-3.4-02: Project list `alertCount` remains zero

Per-project alert counts require project-scoped alert sources. List view stays `0` to avoid N duplicate org counts.

### ADR-3.4-03: MFA alerts use direct-user dispatch

MFA recovery notifications go to the affected user via `dispatchDirectUserNotification`, not org routing table defaults (which target owner/admin).

### ADR-3.4-04: `/alerts` permanent redirect

Preserve bookmarks and Story 2.x nav docs; canonical UI remains `/notifications` per Story 3.3 implementation.

### ADR-3.4-05: Org dashboard alert count ≠ inbox unread

`unresolvedAlertCount` on org/project dashboard reflects **org-admin `security_alerts` lifecycle** (undismissed). Per-user inbox unread remains on nav badge via `GET /users/me` + SSE — do not merge these metrics.

### ADR-3.4-06: MFA alert types excluded from org routing UI

`security.mfa_recovery_used` and `security.mfa_recovery_codes_regenerated` are always direct-to-subject. Org routing table must not offer them — prevents misconfiguration sending MFA self-alerts to owner role.

### ADR-3.4-07: Direct-user dispatch excludes Slack org webhook

MFA self-alerts enqueue email/inbox for the affected user only. Org-level Slack webhook is inappropriate (wrong audience, leaks account recovery signal to shared channel).

---

## Elicitation Refinements (2026-06-30)

Applied via advanced elicitation — Pre-mortem, Red Team vs Blue Team, Self-Consistency Validation, Security Audit Personas.

| Method | Key insight captured |
|---|---|
| Pre-mortem | Boss unreachable in `recoverWithCode` route → mandatory route-layer `sendNotificationJobs` table |
| Pre-mortem | Multi-org recovery must enqueue under resolved org, not assumed JWT org |
| Red Team | CI grep must reject obfuscated stub strings; dashboard query must stay RLS-scoped |
| Red Team | Test SMTP sends to `SMTP_FROM` — UI must not imply admin personal inbox |
| Self-Consistency | Dashboard counts `security_alerts` only; inbox unread stays separate (ADR-3.4-05) |
| Self-Consistency | `PENDING_DELIVERY` rows count as unresolved until dismissed |
| Security Audit | MFA payloads/templates must never leak recovery code material |
| Security Audit | MFA types hidden from org routing form (ADR-3.4-06); no Slack on direct dispatch (ADR-3.4-07) |

---

## Developer Pre-mortem: Likely Failure Points

1. **Jobs enqueued but never delivered** — `#1 failure mode`: service returns jobs but auth routes forget `sendNotificationJobs` post-commit.
2. **Template ID mismatch** — registry, dispatcher, templates, and tests must use identical strings (`security.mfa_recovery_used`).
3. **Forgetting to rebuild shared package** — MFA types won't compile in API until `pnpm --filter @project-vault/shared build`.
4. **Redirect loop** — ensure `/notifications` does not redirect back to `/alerts`.
5. **Dashboard test flakiness** — use `withTestOrg()` and seed `security_alerts` with explicit statuses including `PENDING_DELIVERY`.
6. **Admin test UI bypasses MFA** — server action must respect same auth guards as API (403 if unenrolled admin).
7. **Evaluator thinks SMTP broken** — test email goes to From address; missing UI copy causes false bug reports.
8. **Org routing misroutes MFA** — forgetting to filter MFA types in settings routing form.
9. **Cross-org count leak** — unresolved alert query outside `withOrg` transaction.

---

## File Structure Summary

```
apps/api/src/
  notifications/dispatcher.ts          ← MODIFY: dispatchDirectUserNotification
  notifications/templates/             ← MODIFY/ADD: MFA templates
  modules/auth/mfa.ts                    ← MODIFY: dispatchDirectUserNotification calls; return notificationJobs
  modules/auth/routes.ts                 ← MODIFY: sendNotificationJobs after recover + regenerate
  modules/projects/dashboard-stats.ts    ← MODIFY: unresolvedAlertCount query
  modules/projects/dashboard-stats.test.ts ← MODIFY
  modules/projects/routes.test.ts        ← MODIFY: alertCount zero semantics
  __tests__/ or modules/auth/            ← ADD: MFA notification integration tests

apps/web/src/
  routes/(app)/alerts/+page.server.ts    ← CREATE: redirect
  routes/(app)/alerts/+page.svelte      ← DELETE
  routes/(app)/settings/notifications/   ← MODIFY: test UI + action
  lib/api/notifications.ts               ← MODIFY: admin test client
  routes/placeholder-sections.test.ts    ← MODIFY

packages/shared/src/constants/notification-types.ts ← MODIFY

scripts/check-alert-pending-epic3.ts     ← CREATE (AC-13)
Makefile                                 ← MODIFY: wire guard

_bmad-output/
  implementation-artifacts/deferred-work.md           ← MODIFY
  implementation-artifacts/3-1-*.md                   ← MODIFY: Status
  implementation-artifacts/3-3-*.md                   ← MODIFY: persona + Dev Record
  planning-artifacts/mfa-policy-matrix.md             ← MODIFY
  planning-artifacts/epics.md                         ← MODIFY: G2 note
```

---

## Tasks

- [ ] AC-1: `/alerts` redirect; delete placeholder page
- [ ] AC-2: Placeholder copy + test updates
- [ ] AC-3: Sync story 3.1 status; backfill 3.3 Dev Agent Record
- [ ] AC-4: Update story 3.3 persona journey
- [ ] AC-5: Settings page send-test UI + API client
- [ ] AC-6: MFA types in shared registry + web labels; exclude MFA types from org routing UI
- [ ] AC-7: `dispatchDirectUserNotification`, templates, mfa.ts + auth/routes.ts job send, tests
- [ ] AC-8: Update mfa-policy-matrix.md
- [ ] AC-9: Update deferred-work.md (close E3-1, /alerts row)
- [ ] AC-10–11: Dashboard unresolved alert counts + tests
- [ ] AC-12: Document project list alertCount ADR + test
- [ ] AC-13: CI grep guard + Makefile
- [ ] AC-14: Epics G2 clarification note
- [ ] AC-15: Set epic-3 done after review (SM)

---

## Previous Story Intelligence (From Stories 3.1–3.3)

- **Outbox pattern:** enqueue in transaction, `sendNotificationJobs` after commit (`check-failed-auth-threshold.ts` is canonical).
- **Template fallback:** unknown template IDs still render generic email/inbox body — MFA should have explicit templates, not rely on fallback.
- **Default preferences include inbox** — MFA direct dispatch respects user prefs; tests should cover `none` channel suppression.
- **Route audit:** any new admin web action uses existing API — no new API routes required for AC-5.
- **jscpd / CI:** keep test helpers DRY; extract shared notification test fixtures if needed.

---

## Dev Agent Record

> **Fill in this section as you implement each phase.**

### Decisions Made During Implementation

### Problems Encountered

### Test Coverage Achieved

### Files Changed

### Notes for Epic 4

- SMTP test UI on settings page validates operator config before invitation emails (Story 4.1).
- MFA alerts live — recovery flows no longer silently defer delivery.

---

## References

- [Source: _bmad-output/implementation-artifacts/epic-3-retro-2026-06-30.md]
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md — G2/G3]
- [Source: _bmad-output/implementation-artifacts/2-8-epic-2-completion-credential-web-ui-dashboard-truth-and-ci-guards.md — closure pattern]
- [Source: apps/api/src/workers/check-failed-auth-threshold.ts — dispatch pattern]
- [Source: apps/api/src/modules/auth/mfa.ts — stub callsites lines ~413–415, ~547–549]
