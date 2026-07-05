# Story 8.3: Access Reports, Dormant Users & Audit PII Management

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an organization administrator,
I want point-in-time access reports, dormant account detection, and compliant pseudonymization of departed users' audit trail identities,
so that I can demonstrate access governance and protect privacy without losing the integrity of historical records.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints (access report, dormancy settings, pseudonymize) consumed via API/curl, not a web screen |
| **Linked UI story** (if API-only) | `TBD` — **this is the THIRD consecutive Epic 8 story to hit this exact gap, and it is materially different from 8.1/8.2's version of it.** Stories 8.1 and 8.2 both flagged "no story anywhere scopes a dedicated audit-log web UI" and deferred it as an accepted trade-off. This story's own epics.md AC text is more explicit than either of theirs: it literally requires the access report be "displayed as a paginated UI table" (not merely implied by a persona journey, as 8.1/8.2's UI hints were). Building that UI is a non-trivial SvelteKit undertaking (new route, new data-table component, role-gated nav entry) that is out of scope for this story to absorb silently — this story delivers the correct, fully-tested API surface the UI will consume. **Escalation, not a repeat of the same deferral:** this story's Dev Notes require the developer to raise a dedicated Epic 8 UI story (covering the access-report table, the dormant-alert admin actions, and — from 8.2 — search/export) at Epic 8 sprint planning before this story reaches `done`, and Epic 8 cannot reach `epic-8: done` per Product Surface Contract G2 until that story exists and is at least scheduled. Do not let this become a fourth silent deferral. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none exists yet for this surface (confirmed: zero files under `apps/web/src` reference audit, security-alerts, or dormancy anything), and no SvelteKit route should be stubbed in this story (dead route with no linked follow-up story). |
| **Persona journey** | N/A for this story's actual surface (API-only). **Honest description of the eventual evaluator-visible journey, for the follow-up UI story to implement:** Dana (Security & Compliance Lead) opens Settings → Access & Compliance, picks an "as of" date (defaulting to today), and sees a paginated table of every user, their org role, and their per-project roles as of that date — she uses this before a SOC 2 audit to answer "who had access to what, and when" (`ux-design-specification.md:82-87`, "terminated-employee access is a frequent auditor question"). Separately, she sees a list of dormant-user alerts with dismiss/deactivate actions inline. Until the UI story ships, Dana (or the engineer supporting her) uses the API directly. |

---

## Key Design Decisions & Open Questions

### D1 — Reuse 8.1/8.2/7.2 primitives; this story adds exactly one migration and no new tables

`audit_log_entries`, `user_identity_tokens`, `org_memberships`, `project_memberships`, `security_alerts`, `organizations` all already exist with every column this story needs (confirmed by reading the actual Drizzle schema files, not just epics.md). Concretely reused, unmodified:

- `apps/api/src/lib/audit-or-fail-closed.ts` → `writeHumanAuditEntryOrFailClosed` (this story's audit writes).
- `apps/api/src/modules/audit/actor-token.ts` → `firstActorTokenIdForUser` (dismiss/deactivate actor resolution — already used by `org/security-alerts.ts`).
- `apps/api/src/modules/org/security-alerts.ts` → `dismissSecurityAlertByToken` and the generic `POST /api/v1/security-alerts/:alertId/dismiss` route (`apps/api/src/modules/org/security-alert-actions-routes.ts`) — **this story adds zero new dismiss code**, only a payload-schema registration (D6).
- `apps/api/src/workers/machine-key-dormancy-check.ts` (Story 7.2) — line-for-line structural template for this story's new `user-dormancy-check.ts` worker: `fetchAllOrgIds()` → `runOrgScopedJob()` per org → threshold read from a per-org `organizations` column → `INSERT ... ON CONFLICT DO NOTHING` against a partial unique index for dedup → `createOrgAdminNotificationEntries` + `sendNotificationJobs`.
- `apps/api/src/modules/org/organization-settings-routes.ts` (Story 7.2 D8) — line-for-line template for this story's new `PATCH /api/v1/organizations/:orgId/user-dormancy-settings` registration (same file, second `secureRoute` call).
- `apps/api/src/modules/org/routes.ts`'s existing `POST /users/:userId/deactivate` handler — the "admin can deactivate" half of dormant-user handling calls this **unchanged, existing** endpoint. This story does not touch deactivation logic.

**New code this story actually owns:** one migration (D5), one worker (dormancy detection), one settings route (dormancy threshold), one route (pseudonymize), one route (access report), two new `AuditEvent` constants, one write-path fix (D3), and the corresponding tests.

### D2 — Point-in-time access report: two-tier resolution, because current-state tables cannot answer historical questions about removed users

The naive approach — `SELECT * FROM org_memberships JOIN project_memberships` — only ever answers "who has access **right now**." It cannot answer "who had access on 2026-03-01" for a user who has since been fully removed, because `removeUserFromOrgMemberships()` (`apps/api/src/modules/org/user-management.ts:60-75`) performs a **hard `DELETE`** on both `org_memberships` and `project_memberships` — the row is gone, not soft-deleted. The only remaining record of that access ever existing is the audit log.

**Resolution — two code paths sharing one output shape:**

1. **Fast path (`asOf` omitted, or resolves to "now"):** query `org_memberships` + `project_memberships` directly (current state is correct by definition for "now"). This is a new query, not a reuse of `listOrgUsers()` (`apps/api/src/modules/org/user-management.ts:14-52`) — see D4 for why that function's `displayName` convention must **not** be reused here.
2. **Historical path (`asOf` is any other valid past timestamp):** reconstruct via **audit-event replay**. For each `(orgId, userId, projectId)` triple, scan `audit_log_entries` rows with `orgId` matching and `eventType` in the membership-mutation set below, ordered by `createdAt ASC`, up to and including `asOf`; the last event before/at `asOf` per triple determines whether access existed and at what role at that instant:
   - `project.invitation_accepted` (grant, `resourceId` = the accepting user's `actor_token_id`'s user, `payload.projectId`/`payload.role` — confirm exact payload shape against the shipped `invitations/token-routes.ts` handler at implementation time, it is not yet finalized in this story's research) → membership exists from this event's `createdAt` onward.
   - `project.member_role_changed` → role changes to `payload.newRole` from this event's `createdAt` onward.
   - `project.member_removed` / `project.ownership_transferred` (removal side) → membership ends at this event's `createdAt`.
   - `project.ownership_transferred` (grant side) → new owner's membership begins/changes at this event's `createdAt`.
   - `org.user_removed` → **all** of that user's project memberships in the org end at this event's `createdAt` (cascading removal), and the user drops out of the report entirely for any `asOf` at or after this timestamp.
   - `org.user_deactivated` → user's `status` becomes `deactivated` at this event's `createdAt` (they remain **in** the report — deactivated ≠ removed — with `status: "deactivated"`, per epics.md's own report shape including a status-bearing field).
   - **Org-level role is treated as immutable after initial grant** (confirmed: `apps/api/src/modules/org/routes.ts` has exactly one `update(orgMemberships)` call site, and it only ever changes `status`, never `role` — there is no org-role-change endpoint anywhere in this codebase). So a user's `orgRole` in a historical report is simply whatever it was at the org-membership-creation event; no replay needed for that one field.
3. **Both paths resolve `displayName` via `user_identity_tokens.displayName`, never `users.email`** (D4). Both paths return the exact same response shape (see AC-1/AC-2), so the caller cannot tell which path served the request except via response latency.

**Validation boundary:** `asOf` must not be before the org's `createdAt` (nothing to report — reject, don't silently return empty, per AC-5) and must not be in the future (reject — a report about access that hasn't happened yet is meaningless).

### D3 — `org_memberships.lastActiveAt` is a real, already-migrated column that no code path currently writes — this story must add the write path

Confirmed by exhaustive grep: `org_memberships.lastActiveAt` (`packages/db/src/schema/org-memberships.ts:16`) has **zero writers** anywhere in `apps/api/src`. Only `sessions.lastActiveAt` (a different table) is actively maintained, via `touchSessionActivity()` (`apps/api/src/modules/auth/session-activity.ts`), called from `apps/api/src/plugins/authenticate.ts:172` (`touchActivityWithoutBlocking`) on every authenticated request. Without a fix, the dormant-user job would see every user's `lastActiveAt` as permanently `NULL`, making the feature non-functional for anyone who has ever been active (it would only ever flag users by their `createdAt` fallback, never by genuine inactivity).

**Resolution:** add a sibling function `touchOrgMembershipActivity(orgId, userId)` to `session-activity.ts`, using its own debounce map (keyed by `${orgId}:${userId}`, reusing `env.SESSION_ACTIVITY_DEBOUNCE_SECONDS` — do not add a new env var), called from `authenticate.ts`'s existing `touchActivityWithoutBlocking` alongside (not instead of) `touchSessionActivity`, wrapped in the same fail-open `try/catch` (a failed activity touch must never fail the request). `session.orgId` and `session.userId` are already in scope at that call site (`authenticate.ts:172`, confirmed by reading the file — no plumbing needed to get the IDs there).

### D4 — Access report and CSV export must resolve `displayName` via `user_identity_tokens`, not `users.email` — do not reuse `listOrgUsers()`'s convention

`listOrgUsers()` (`apps/api/src/modules/org/user-management.ts:44-51`, powering the existing org user-management list) derives `displayName` from `users.email` directly, with an explicit comment: `// D3: no dedicated profile column; derive from email.` That convention **predates pseudonymization** and is correct for its own screen, but is the exact wrong choice here: `user_identity_tokens.displayName` is initialized to the user's email at registration (`apps/api/src/modules/auth/service.ts:385`, `values({ userId: user.id, displayName: email })`) and **only diverges from `users.email` once pseudonymized** (this story's own new endpoint, AC-16 onward). An access report — the compliance artifact this story exists to produce — that silently reads `users.email` instead would keep leaking a pseudonymized user's real email in every report generated after pseudonymization, defeating FR44 entirely. **The access-report query, in both D2 code paths, must join through `user_identity_tokens` (by `userId`, using the same "first created wins" ordering `firstActorTokenIdForUser()` already uses) for `displayName` — never `users.email`.**

### D5 — One new migration: `organizations.user_dormancy_threshold_days` column + a partial unique index on `security_alerts`; no new tables

Mirrors Story 7.2's `machineKeyDormancyThresholdDays` exactly (`packages/db/src/schema/organizations.ts:12-15`, `CHECK ... IN (30, 60, 90, 180)`) and Story 7.2's `idx_security_alerts_dormant_key` dedup index (`packages/db/src/schema/security-alerts.ts:34-36`). New column: `userDormancyThresholdDays integer NOT NULL DEFAULT 90 CHECK (... IN (30, 60, 90, 180))`. New index: `idx_security_alerts_dormant_user UNIQUE ON (payload->>'userId') WHERE alert_type = 'user.dormant' AND status != 'dismissed'`.

**Migration numbering is not yet knowable and must not be hardcoded.** As of this story's creation, the latest committed migration is `0033_break_glass_and_stale_recovery.sql` (confirmed via `packages/db/src/migrations/meta/_journal.json`, `idx: 33`). Stories 8.1 and 8.2 are both unmerged (`ready-for-dev`, not `done` — see D7/Prerequisites) and each plans its own migration(s); **check `_journal.json` again at implementation time** and claim whatever index is actually next-free once 8.1 and 8.2 have landed. Do not assume "0034" — that is only correct if no other migration lands first.

### D6 — Alert payload schema registration, not a new dismiss endpoint

The generic `POST /api/v1/security-alerts/:alertId/dismiss` route (`apps/api/src/modules/org/security-alert-actions-routes.ts`) already works for **any** `alertType` — its own code comment says so explicitly ("generic dismiss endpoint, not machine-key-specific at the route level so any future `security_alerts` alertType can reuse it without a new endpoint"). This story's only obligation for "admin can dismiss a dormant-user alert with a reason" is: (a) add `userDormantPayloadSchema` to `apps/api/src/modules/org/schema.ts` (mirroring `machineKeyDormantPayloadSchema`), union it into `securityAlertPayloadSchema`, and (b) register `'user.dormant': userDormantPayloadSchema` in `PAYLOAD_SCHEMA_BY_ALERT_TYPE` (`apps/api/src/modules/org/security-alerts.ts:29-33`) so `GET /org/security-alerts` renders the new alert type's payload instead of silently dropping it (per that file's own `ADR-6.2-07` comment about exactly this failure mode).

### D7 — 8.1 and 8.2 are hard prerequisites, not soft references — confirmed by direct filesystem inspection, not by trusting `sprint-status.yaml`'s label alone

`sprint-status.yaml` lists both `8-1-tamper-evident-audit-log-with-hmac-integrity` and `8-2-audit-log-search-export-and-external-forwarding` as `ready-for-dev` (story files exist, reviewed, not yet coded). Direct inspection confirms their actual deliverables do not exist yet: `apps/api/src/modules/audit/routes.ts`, `verify.ts` (8.1) and `search.ts`, `export.ts`, `csv.ts`, `forwarding.ts`, `retention.ts` (8.2) are **absent**; `apps/api/src/app.ts` registers no `auditRoutes`; `packages/db/src/check-audit-actor-token-coverage.ts` (8.1's backfill-check utility) does not exist. This story literally cannot re-run "the backfill check from Story 8.1" (its own epics.md AC text) if that check hasn't been built, and cannot satisfy "reuse `csv.ts`" (8.2's own cross-story-context note about this story) if `csv.ts` doesn't exist. **Following the exact precedent 8.2's own story file set for its dependency on 8.1** ("must be `done`, not just `ready-for-dev`"), this story's Prerequisites table below makes the same call for both 8.1 and 8.2. This story file can and should be written now (planning is not blocked), but implementation must not start before 8.1 and 8.2 are both `done`.

### D8 — Resolving AC-E8d against a DB trigger that already forbids what it literally asks for

Epics.md's AC-E8d says a user "whose `user_identity_token` has already been pseudonymized... can be re-pseudonymized (**alias replaced with a new alias**) without error." But `packages/db/src/migrations/0001_rls_and_triggers.sql:72-87` already ships a trigger, `prevent_pseudonym_reversal()`, `BEFORE UPDATE ON user_identity_tokens`:

```sql
IF OLD.pseudonymized_at IS NOT NULL AND NEW.display_name != OLD.display_name THEN
  RAISE EXCEPTION 'user_identity_tokens: display_name cannot be modified after pseudonymization — GDPR erasure is permanent';
END IF;
```

This trigger makes issuing a **second, different** alias to an already-pseudonymized user a guaranteed runtime exception — the literal epics.md wording is not implementable against the shipped schema. **Resolution, treated as authoritative over the epics.md phrasing (the trigger's own comment states its intent plainly — "GDPR erasure is permanent" — and that intent is more consistent with the compliance goal FR44 actually serves than a regenerable alias would be):** "idempotent re-pseudonymization" in this story means **a second call is a no-op that returns the existing alias and `pseudonymizedAt` unchanged, performs no `UPDATE`, and returns `200` (not an error, satisfying the "without error" half of AC-E8d)** — it does not generate a new alias. AC-17/AC-18 below implement and test exactly this behavior. Do not attempt to work around the trigger (e.g., by clearing `pseudonymized_at` first) — that would defeat the trigger's entire purpose.

### D9 — Cross-org display-name bleed: accepted, not fixed — resolving the open item 8.2's adversarial review explicitly carried forward to this story

8.2's story file (`_bmad-output/implementation-artifacts/8-2-audit-log-search-export-and-external-forwarding.md`, Epic Cross-Story Context table, Story 8.3 row) and its adversarial-review addendum both flag, by name, that this story must make an explicit decision: `user_identity_tokens` is platform-level, not org-scoped (`packages/db/src/schema/user-identity-tokens.ts:4`, "Not org-scoped: platform-level identity table shared across orgs"), and a single `org_memberships` row is keyed `(org_id, user_id)` — meaning **one user can belong to multiple orgs, sharing one `user_identity_tokens` row.** Pseudonymizing that user from Org A's owner action changes how their historical audit rows render in **every other org they belong to**, not just Org A, because every org's audit export/access-report performs the same live join against the same shared row.

**Decision: accepted, not fixed, in this story.** Building an org-scoped display-name mechanism would mean either (a) one `user_identity_tokens` row per `(org, user)` pair — a schema change touching Story 1.6's identity model and every existing audit row's join, far beyond this story's charter — or (b) a per-org display-name override table layered on top, adding complexity for a scenario (a user simultaneously active in multiple orgs, one of which erases them) that is a real but narrow edge case. This story documents the behavior plainly (AC-22) rather than silently shipping it as an unstated side effect, and requires the pseudonymize endpoint's response and the access-report's Dev Notes to say so explicitly, so a future reader — including the eventual UI story (Product Surface Contract note above) — designs around a known fact instead of rediscovering a surprise. If cross-org isolation of PII becomes a hard compliance requirement later, that is new-story-sized work, not a fix to bolt on here.

### D10 — FR44's "upon account deletion" vs. this story's on-demand endpoint: a stated scope boundary, not a silent gap

PRD FR44 (`prd.md:927`) says pseudonymization happens "upon account deletion." This story's actual endpoint, `POST /users/:userId/pseudonymize`, is **on-demand, owner-triggered, and not tied to any deletion flow** — there is no account-deletion flow in this codebase yet (Story 8.4, `data-subject-erasure-request-handling`, is `backlog` and is where deletion will live; its own epics.md AC text literally says step 1 of erasure execution is "pseudonymized (**Story 8.3 mechanism**)"). **This story ships the mechanism; Story 8.4 is what will call it as part of a deletion flow.** State this explicitly rather than trying to retrofit an account-deletion trigger into this story that doesn't otherwise exist.

### D11 — Backfill check's human-only scope is correct and complete, closing 8.1's forward-reference

8.1's own story text defers an open question to "Story 7.1/7.2 or Story 8.3": whether the backfill/coverage check (scoped to `actor_type = 'human'` rows only) needs an analogous check for `actor_type = 'machine_user'` rows. It does not. Machine-user audit rows are written via `apps/api/src/modules/audit/machine-entry.ts`, which — by design, confirmed by reading the file — always sets `actorTokenId: null` for machine-user rows; machine users are identified through the separate `machine_users` table (Story 7.1), never through `user_identity_tokens`. There is no gap to backfill: a `null` `actor_token_id` on a `machine_user`-typed row is the permanent, intended state, not an omission. AC-24 makes this an explicit, tested assertion rather than leaving the question open a second time.

### D12 — Alert-audience wording reconciled: FR71 ("Organization Admins") vs. epics.md's Story 8.3 AC ("org owners")

FR71 (`prd.md:931`) says dormant-user alerts go to "Organization Admins" (the PRD's general term for the admin persona, covering both the `admin` and `owner` roles). Epics.md's own Story 8.3 AC text narrows this to "alerts to org owners." This story follows the existing, already-built routing mechanism (`apps/api/src/modules/notifications/routing.ts`, `resolveRoutingRecipients`) exactly as Story 7.2's `machine_key.dormant` alert type does: **default routing role is `owner`** (satisfying the epics.md AC literally and matching every other Epic 8 compliance-sensitive alert), but because routing is already per-alert-type configurable via `org_notification_routing` (no new mechanism needed), an org can widen it to `admin` too without any code change — reconciling FR71's broader "Admins" wording without contradicting the epic AC's specific default.

---

## Prerequisites

| Prerequisite | Why | Status |
|---|---|---|
| **Story 8.1 (Tamper-Evident Audit Log with HMAC Integrity) — must be `done`, not just `ready-for-dev`** | Ships `checkAuditActorTokenCoverage()` (the backfill check this story's own epics.md AC requires re-running), `verifyAuditRange()` (this story's HMAC-integrity-preserved assertion, AC-19), and `apps/api/src/modules/audit/routes.ts` (this story's access-report route is registered alongside it). | `ready-for-dev` — **not yet implemented** (confirmed: `apps/api/src/modules/audit/` contains no `routes.ts`/`verify.ts`; no CI script for actor-token coverage exists) |
| **Story 8.2 (Audit Log Search, Export & External Forwarding) — must be `done`, not just `ready-for-dev`** | Ships `apps/api/src/modules/audit/csv.ts`'s `toCsvRow()` (this story's access-report CSV export reuses it, per D1/AC-3) and `GET /audit/events` (this story's AC-25 needs it to assert FR102's "queryable via standard audit search"). | `ready-for-dev` — **not yet implemented** (confirmed: no `csv.ts`, `search.ts`, `export.ts` anywhere in the repo) |
| Story 7.2 (Machine User Authentication & Programmatic Secret Retrieval) | Source of the dormancy-job/settings-route/dismiss-endpoint patterns this story's D1/D5/D6/D12 mirror structurally | `done` |
| Story 4.3 (Account Deactivation & Recovery) | Ships the existing `POST /users/:userId/deactivate` endpoint this story's dormant-user "deactivate" action calls unchanged, and the `ORG_USER_DEACTIVATED`/`ACCOUNT_RECOVERY_*` audit events this story's AC-25 asserts are queryable | `done` |
| Story 1.4 (Database Foundation, RLS, core schema) | RLS/migration conventions this story's new column/index follow | `done` |
| Story 1.6 (User Registration) | `user_identity_tokens` creation-at-registration behavior this story's D4/D8 depend on | `done` |
| Story 1.11 (SecureRoute framework) | `secureRoute()`, transaction-scoped RLS context, rate limiting — this story's new routes use the same framework | `done` |
| `packages/db/src/migrations/meta/_journal.json` — latest migration is `0033_break_glass_and_stale_recovery.sql` (idx 33) at the time of this story's creation | This story adds one migration (D5) — confirm the actual next-free index at implementation time, after 8.1/8.2's own migrations (if any) have landed | informational |

---

## Epic Cross-Story Context

| Story | Relationship to 8.3 |
|---|---|
| 8.1 (Tamper-Evident Audit Log, `ready-for-dev`) | Hard prerequisite (D7); source of `checkAuditActorTokenCoverage()` (AC-23/AC-24) and `verifyAuditRange()` (AC-19). |
| 8.2 (Audit Log Search/Export/Forwarding, `ready-for-dev`) | Hard prerequisite (D7); source of `csv.ts`'s `toCsvRow()` (AC-3) and `GET /audit/events` (AC-25). Its own story file explicitly carries forward the cross-org display-name-bleed decision to this story (D9) and states this story's pseudonymization is what makes its own `actor_display_name` export column show an alias post-pseudonymization (already correct on 8.2's side — a live join, no change needed there). |
| 7.2 (Machine User Auth, `done`) | Structural template only (D1); no shared code paths (machine-key dormancy and user dormancy are separate `security_alerts.alertType` values, separate worker files, separate settings columns). |
| 4.3 (Account Deactivation & Recovery, `done`) | This story's "deactivate a dormant user" action calls 4.3's existing `POST /users/:userId/deactivate` unchanged; this story's AC-25 confirms 4.3's audit events are queryable once 8.2 ships search. |
| 8.4 (Data Subject Erasure Request Handling, `backlog`) | Forward dependency: 8.4's erasure-execution flow calls this story's pseudonymize mechanism as its step 1 (its own epics.md AC text says so explicitly) — this story must keep the pseudonymize function callable internally (not only via HTTP), so 8.4 can invoke it in the same transaction as the rest of its erasure steps rather than making an internal HTTP call to itself (D10). |
| 9.4 (Platform Operator Audit Log, `backlog`) | Structurally separate `platform_audit_events` table; this story's access report/pseudonymization concern per-org data only, not platform-operator actions. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 8.3 | Rationale |
|---|---|---|
| epics.md: table is `organization_members` | Actual table is `org_memberships` (`packages/db/src/schema/org-memberships.ts`) | Same naming divergence 8.1's own D1 already established for `audit_events` → `audit_log_entries`; this story continues reading epics.md's table names as descriptive, not literal |
| epics.md AC-E8c: access report "formatted as CSV per AC-E8c" (columns `timestamp, actor_display_name, event_type, resource_id, resource_type, org_id, project_id, ip_address`) | Access-report CSV uses its **own** column set: `user_id, display_name, org_role, status, project_id, project_role, granted_at` (one row per user×project pair; users with zero project memberships get one row with empty project fields) — reusing only `toCsvRow()`'s RFC4180 quoting mechanics from 8.2's `csv.ts`, not AC-E8c's literal column names | AC-E8c's column list describes an audit-**event** export row (Story 8.2's shape); it has no `event_type`/`ip_address`/`timestamp`-of-event concept for a user/role/membership snapshot. Reusing the *mechanism* (quoting helper) while defining the report's own, structurally-appropriate columns is what "AC-E8c applies to both" (8.2's own cross-story note) can actually mean — it cannot mean the literal 8-column list applies verbatim, since that shape cannot represent a membership record |
| epics.md: `{ users: [{ userId, displayName, orgRole, projects: [{ projectId, role, grantedAt }] }], generatedAt, asOf }` | Kept exactly as specified for the JSON response shape (AC-1/AC-2), with `status` added per-user (needed to represent deactivated-but-not-removed users, D2) | epics.md's JSON shape is precise and implementable as-is; only the CSV shape needed reconciliation |
| epics.md: "a pg-boss daily job checks `organization_members.last_active_at`" | Job checks `org_memberships.lastActiveAt`, which this story must first wire a write-path for (D3) — epics.md assumes the column is already populated; it is not | epics.md was written assuming a column that exists on paper but has no writer; this story closes that gap rather than building a job against a column that will always read `NULL` |
| epics.md AC-E8d: re-pseudonymization "alias replaced with a new alias" | Re-pseudonymization is a no-op returning the existing alias (D8) | The shipped `prevent_pseudonym_reversal()` trigger makes the literal wording a guaranteed runtime exception; the no-op interpretation is the only one implementable against the current schema and is more consistent with FR44's "permanent" pseudonymization intent |

---

## Acceptance Criteria

### AC Quick Reference

| # | Area | Summary |
|---|---|---|
| 1 | Access report | Happy path, `asOf` = now (current-state fast path) |
| 2 | Access report | Happy path, `asOf` in the past (event-replay reconstruction) |
| 3 | Access report | CSV export format |
| 4 | Access report | Pagination |
| 5 | Access report | Validation (`asOf` malformed / future / before org creation) |
| 6 | Access report | Authorization: owner-only; tenant isolation |
| 7 | Access report | This endpoint's own calls are audited |
| 8 | Access report | Display name reflects pseudonymization, never raw email |
| 9 | Dormancy | `org_memberships.lastActiveAt` write-path fix |
| 10 | Dormancy | Daily job happy path — flags inactive users |
| 11 | Dormancy | Dedup via partial unique index |
| 12 | Dormancy | Configurable per-org threshold + settings endpoint |
| 13 | Dormancy | Never-active fallback; deactivated users excluded |
| 14 | Dormancy | Admin dismiss (reused generic endpoint) |
| 15 | Dormancy | Admin deactivate (reused existing endpoint) |
| 16 | Dormancy | Alert routing default (owner), FR71/epic AC reconciled |
| 17 | Pseudonymize | Happy path |
| 18 | Pseudonymize | Idempotent re-pseudonymization = no-op |
| 19 | Pseudonymize | HMAC integrity preserved on existing audit rows |
| 20 | Pseudonymize | Authorization: owner-only; tenant isolation |
| 21 | Pseudonymize | Own action audited |
| 22 | Pseudonymize | Cross-org display-name bleed — documented, tested behavior |
| 23 | Backfill | Re-run at story completion — clean case |
| 24 | Backfill | Dirty case blocks sign-off; machine-user scope confirmed sufficient |
| 25 | FR102 | Recovery & deactivation events queryable via standard audit search |
| 26 | Cross-cutting | Migration safety & RLS coverage |
| 27 | Cross-cutting | Route-audit CI coverage |
| 28 | Cross-cutting | Full integration test matrix |

---

### AC-1: Access Report — Happy Path, `asOf` = Now (Current-State Fast Path)

**Given** an org with 3 active users (`owner`, `admin`, `member`) where the `member` belongs to 2 projects with different roles and the `admin` belongs to 0 projects,
**when** the owner calls `POST /api/v1/org/audit/access-report` with `{}` (no `asOf`, defaults to current time),
**then** the response is `200` with `{ data: { users: [ { userId, displayName, orgRole: "owner", status: "active", projects: [] }, { userId, displayName, orgRole: "admin", status: "active", projects: [] }, { userId, displayName, orgRole: "member", status: "active", projects: [{ projectId, projectName, role, grantedAt }, { projectId, projectName, role, grantedAt }] } ], generatedAt, asOf, page: 1, limit: 20, total: 3, hasNext: false } }`; `generatedAt` is the request time, `asOf` echoes the resolved timestamp used.

**Edge case — org with only the initial owner, zero other members:** **given** a freshly created org, **when** the owner requests the report, **then** the response contains exactly one user (the owner) with `projects: []` — an org with no other members is a valid, non-error state, not a `404` or empty-report error.

### AC-2: Access Report — Happy Path, `asOf` in the Past (Event-Replay Reconstruction)

**Given** an org where: user A was granted `member` role on project P on 2026-01-01 (`project.invitation_accepted`), promoted to `admin` role on project P on 2026-03-01 (`project.member_role_changed`), and fully removed from the org on 2026-05-01 (`org.user_removed`, which hard-deletes their `org_memberships`/`project_memberships` rows per D2),
**when** the owner calls the endpoint with `{ asOf: "2026-04-01T00:00:00Z" }`,
**then** user A **appears** in the report with `orgRole` as it was at grant time, `projects: [{ projectId: P, role: "admin", grantedAt: "2026-03-01T..." }]` — reconstructed entirely from `audit_log_entries`, even though user A's current-state rows in `org_memberships`/`project_memberships` no longer exist.

**Edge case — `asOf` between grant and promotion:** **given** the same history, **when** `asOf: "2026-02-01T00:00:00Z"`, **then** user A appears with `projects: [{ projectId: P, role: "member", ... }]` (pre-promotion state) — confirms the replay picks the latest event **at or before** `asOf`, not the latest event overall.

**Edge case — `asOf` after removal:** **given** the same history, **when** `asOf: "2026-06-01T00:00:00Z"`, **then** user A does **not** appear in the report at all — matching what a report generated on that date would have shown, even though this is a retroactive query made after the fact.

### AC-3: Access Report — CSV Export Format

**Given** the same org as AC-1,
**when** the owner calls `POST /api/v1/org/audit/access-report` with `{ format: "csv" }`,
**then** the response `Content-Type` is `text/csv` and the body contains a header row `user_id,display_name,org_role,status,project_id,project_role,granted_at` followed by one data row per (user × project) pair, plus one row per user with zero project memberships (`project_id`/`project_role`/`granted_at` empty), RFC 4180 quoted via 8.2's `toCsvRow()` (D1/Architecture Conflict Resolution table).

**Edge case — display name containing a comma and embedded quotes:** **given** a user whose `user_identity_tokens.displayName` is `Chen, Alice "AC"` (still their un-pseudonymized email-derived name is unlikely to contain these, but a pseudonymized alias is machine-generated and safe — this scenario specifically exercises a pre-pseudonymization display name edge case, e.g. a future profile-name feature), **when** the CSV row is built, **then** the field renders as `"Chen, Alice ""AC"""` — identical quoting behavior to 8.2's own `toCsvRow()` unit tests, confirming this story's reuse is byte-compatible, not a re-implementation.

### AC-4: Access Report — Pagination

**Given** an org with 45 users,
**when** the owner calls the endpoint with `{ page: 2, limit: 20 }`,
**then** the response contains users 21-40, `total: 45`, `hasNext: true`; requesting `{ page: 3, limit: 20 }` returns users 41-45, `hasNext: false`.

**Edge case — `page` beyond available data:** **given** the same org, **when** `{ page: 100, limit: 20 }`, **then** the response is `200` with `users: []`, `total: 45`, `hasNext: false` — not a `404`, matching 8.2's search endpoint's pagination convention (no error for an empty page).

### AC-5: Access Report — Validation

**Given** any org,
**when** the owner calls the endpoint with a malformed `asOf` (e.g. `"not-a-date"`, or a bare date `"2026-01-01"` without time),
**then** the response is `422 { code: "validation_error" }`.

**Edge case — `asOf` in the future:** **given** the current time is `2026-07-05T12:00:00Z`, **when** `{ asOf: "2026-07-06T00:00:00Z" }`, **then** the response is `422 { code: "invalid_as_of", message: "asOf cannot be in the future" }`.

**Edge case — `asOf` before the org's `createdAt`:** **given** an org created on `2026-01-01T00:00:00Z`, **when** `{ asOf: "2025-12-01T00:00:00Z" }`, **then** the response is `422 { code: "invalid_as_of", message: "asOf predates this organization" }` — not a silently empty report, so a compliance officer cannot mistake "you asked about a time before this org existed" for "this org had zero access on that date."

### AC-6: Access Report — Authorization: Owner-Only, and Tenant Isolation

**Given** a user with `admin`, `member`, or `viewer` org role,
**when** they call `POST /api/v1/org/audit/access-report`,
**then** the response is `403` — matching the owner-only precedent already set by 8.1's verify endpoint and 8.2's search endpoint for this same class of compliance-sensitive data.

**Edge case — cross-org isolation:** **given** two orgs (Org A, Org B) each with their own users, **when** Org A's owner calls the endpoint, **then** the response contains only Org A's users — verified via `withTwoTestOrgs()`, matching 8.1/8.2's own cross-org isolation test pattern.

### AC-7: Access Report — This Endpoint's Own Calls Are Audited

**Given** an owner generates an access report,
**when** the request completes successfully,
**then** an `audit_log_entries` row is written with `eventType: 'audit.access_report_generated'`, `payload: { asOf, userCount, format }`, via the route's default `secureRoute` audit writer (`writeAuditEvent: true`) — matching 8.2's corrected precedent (its own AC-7 title is literally "Search — This Endpoint's Own Calls Are Audited"), not 8.1's originally-flagged gap of *not* auditing its own verify calls.

**Edge case — report generation fails after partial work:** **given** a transient DB error occurs while building the report, **when** the request fails, **then** no `audit.access_report_generated` row is written (same-transaction invariant, NFR-REL5) — the audit write and the report generation succeed or fail together.

### AC-8: Access Report — Display Name Reflects Pseudonymization, Never Raw Email

**Given** a user who was pseudonymized (this story's own AC-17) before an access report is generated,
**when** the report is generated for `asOf` = now,
**then** the user's `displayName` in the report is their pseudonymized alias (`user_<8chars>`) — resolved via `user_identity_tokens.displayName`, **not** `users.email` (D4).

**Edge case — regression guard against reusing `listOrgUsers()`'s convention:** a unit/integration test asserts that after pseudonymization, `GET /org/users` (the existing 4.2 endpoint, which **does** derive `displayName` from `users.email` per its own documented D3 convention) and this story's access report **diverge** — the former still shows the real email (expected, out of this story's scope to change), the latter shows the alias (required). This divergence is intentional and must be asserted, not "fixed" by changing `listOrgUsers()`.

---

### AC-9: Dormancy — `org_memberships.lastActiveAt` Write-Path Fix

**Given** a user with an active session making an authenticated request,
**when** the request completes,
**then** `org_memberships.lastActiveAt` for that `(orgId, userId)` is updated to the current time, via the new `touchOrgMembershipActivity()` (D3), debounced identically to `touchSessionActivity()` (same `env.SESSION_ACTIVITY_DEBOUNCE_SECONDS` window).

**Edge case — the touch must never fail the request:** **given** a simulated DB error inside `touchOrgMembershipActivity()`, **when** an authenticated request is made, **then** the request still succeeds (fail-open, matching `touchActivityWithoutBlocking`'s existing `try/catch` around `touchSessionActivity`) and a `warn`-level structured log entry is emitted.

### AC-10: Dormancy — Daily Job Happy Path

**Given** an org with `userDormancyThresholdDays = 90` and a user whose `org_memberships.lastActiveAt` is 95 days old,
**when** the daily `user:dormancy-check` pg-boss job runs (cron `0 9 * * *`, mirroring `machine-key:dormancy-check`'s cadence exactly),
**then** a `security_alerts` row is inserted: `{ orgId, alertType: 'user.dormant', severity: 'warning', payload: { userId, displayName, orgRole, lastActiveAt }, status: 'PENDING_DELIVERY' }`, and a notification is queued to the org's routing-resolved recipients (default `owner`, D12).

**Edge case — user exactly at the threshold boundary:** **given** `lastActiveAt` is exactly 90 days and 0 seconds old at job run time, **when** the job runs, **then** the user **is** flagged (`< now() - interval` uses `lastActiveAt` strictly older than the threshold at query time, matching the machine-key job's own `sql` predicate style — confirm the exact boundary semantics against `machine-key-dormancy-check.ts:104` at implementation time, which this story's query must mirror precisely, not reinterpret).

### AC-11: Dormancy — Dedup via Partial Unique Index

**Given** a user already has a non-dismissed `user.dormant` alert from a previous day's job run,
**when** the next day's job run evaluates the same user (still dormant),
**then** no second `security_alerts` row is inserted — the `INSERT ... ON CONFLICT ((payload->>'userId')) WHERE alert_type = 'user.dormant' AND status != 'dismissed' DO NOTHING` (D5's new partial unique index) makes the repeat insert a safe no-op, identical in structure to `machine-key-dormancy-check.ts:135-141`.

**Edge case — alert was dismissed, user still dormant next run:** **given** the prior alert has `status: 'dismissed'`, **when** the next day's job runs, **then** a **new** alert **is** inserted (the partial index's `WHERE status != 'dismissed'` clause means a dismissed row no longer blocks a new one) — an admin who dismissed a stale alert will be re-notified if the user remains dormant, rather than the alert being permanently suppressed.

### AC-12: Dormancy — Configurable Per-Org Threshold

**Given** an org owner or admin,
**when** they call `PATCH /api/v1/organizations/:orgId/user-dormancy-settings` with `{ userDormancyThresholdDays: 180 }`,
**then** the response is `200 { data: { orgId, userDormancyThresholdDays: 180 } }` and subsequent job runs for that org use 180 days — mirroring `organization-settings-routes.ts`'s existing `machine-key-settings` handler exactly (`minimumRole: 'admin'`, `requireMfa: true`, rate limit `10/60s`, manual audit write `eventType: 'organization.user_dormancy_settings_updated'`).

**Edge case — value outside the 30/60/90/180 enum:** **given** `{ userDormancyThresholdDays: 45 }`, **when** the request is made, **then** the response is `422` (CHECK constraint + Zod-level enum validation, matching the machine-key-settings route's own test for this exact scenario).

### AC-13: Dormancy — Never-Active Fallback and Exclusions

**Given** a user who registered but has never made an authenticated request since (`org_memberships.lastActiveAt IS NULL`),
**when** the dormancy job runs and their `org_memberships.createdAt` is older than the threshold,
**then** they are flagged as dormant using `createdAt` as the fallback signal — identical logic to `machine-key-dormancy-check.ts:101-109`'s `lastUsedAt`/`createdAt` OR-fallback.

**Edge case — deactivated users are excluded:** **given** a user with `org_memberships.status = 'deactivated'` whose `lastActiveAt` (frozen at deactivation time) is far older than the threshold, **when** the job runs, **then** they are **not** flagged — the job's query filters `status = 'active'` only (an already-deactivated account cannot be "dismissed or deactivated" a second time in any meaningful sense).

### AC-14: Dormancy — Admin Dismiss

**Given** a pending `user.dormant` alert,
**when** an owner or admin calls `POST /api/v1/security-alerts/:alertId/dismiss` with `{ reason: "Contractor on planned sabbatical, returns August" }` (the existing, unmodified generic endpoint, D6),
**then** the response is `200 { data: { id: alertId, status: "dismissed" } }`, and `security_alert.dismissed` is written to the audit log — no new code beyond the payload-schema registration (D6) makes this work.

**Edge case — empty reason:** **given** `{ reason: "" }`, **when** the dismiss is attempted, **then** the response is `422` — identical validation already enforced by the existing endpoint (`DismissAlertBodySchema`), requiring no new work here beyond confirming the existing test coverage extends to the `user.dormant` alert type.

### AC-15: Dormancy — Admin Deactivate

**Given** a dormant user with a pending alert,
**when** an admin calls the existing `POST /api/v1/org/users/:userId/deactivate` (Story 4.3, unmodified),
**then** the user's `org_memberships.status` becomes `deactivated`, all sessions/pending-sent-invitations are revoked, and `ORG_USER_DEACTIVATED` is audit-logged — exactly as 4.3 already implements it.

**Edge case — dismiss and deactivate are independent actions, not linked:** **given** a dormant user is deactivated **without** first dismissing their `user.dormant` alert, **when** the deactivation completes, **then** the alert row is left untouched (still `PENDING_DELIVERY`/`delivered`, dismissable independently) — deactivating does not implicitly dismiss the alert, and dismissing does not implicitly deactivate the account; each is a separate admin decision, matching epics.md's own "admins can dismiss... **or** deactivate" phrasing (alternatives, not a sequence).

### AC-16: Dormancy — Alert Routing Default

**Given** an org with no custom `org_notification_routing` entry for `user.dormant`,
**when** a dormancy alert is queued,
**then** it routes to the org's `owner` role by default (D12), using the existing `resolveRoutingRecipients()` mechanism — no new routing code.

**Edge case — org has configured `user.dormant` routing to `admin`:** **given** an org admin has configured per-alert-type routing (existing FR100 mechanism) to route `user.dormant` to `admin`, **when** the alert is queued, **then** it routes to all `admin`-role members instead — confirming no hardcoded routing exists in the new job (it calls the same shared routing resolver every other alert type uses).

---

### AC-17: Pseudonymize — Happy Path

**Given** an owner and a target user who is a member of the owner's org and has never been pseudonymized,
**when** the owner calls `POST /api/v1/org/users/:userId/pseudonymize`,
**then** every `user_identity_tokens` row for that `userId` (not just the "first created" one used for new audit writes — D8/AC-19) has `displayName` replaced with `user_<8 random alphanumeric chars>` and `pseudonymizedAt` set to the current time; the response is `200 { data: { userId, pseudonymized: true, pseudonymizedAt, alias } }`.

**Edge case — user has multiple `user_identity_tokens` rows:** **given** a user who (for any historical reason) has two `user_identity_tokens` rows, **when** pseudonymized, **then** **both** rows are updated to the same alias — confirming the endpoint does not silently leave a second, un-pseudonymized row that some older audit rows might still reference.

### AC-18: Pseudonymize — Idempotent Re-Pseudonymization (No-Op, per D8)

**Given** a user already pseudonymized (alias `user_ab12cd34`, `pseudonymizedAt: T1`),
**when** the owner calls the pseudonymize endpoint again,
**then** the response is `200 { data: { userId, pseudonymized: true, pseudonymizedAt: T1, alias: "user_ab12cd34" } }` — the **same** alias and timestamp, no `UPDATE` is issued, and no error occurs (satisfying AC-E8d's "without error," reinterpreted per D8's no-op resolution rather than its literal "new alias" wording).

**Edge case — confirms the DB trigger, not just application logic, prevents any drift:** an integration test directly attempts an `UPDATE user_identity_tokens SET display_name = 'something-else' WHERE id = ... AND pseudonymized_at IS NOT NULL` outside the application code path and asserts it raises `prevent_pseudonym_reversal()`'s exception — proving the immutability guarantee holds even against a hypothetical future code path that forgets to check `pseudonymizedAt` first, not only against this story's own correctly-written endpoint.

### AC-19: Pseudonymize — HMAC Integrity Preserved on Existing Audit Rows

**Given** a user with 10 existing `audit_log_entries` rows referencing their `actor_token_id`,
**when** they are pseudonymized,
**then** none of those 10 rows' `hmac`/`payload`/`keyVersion`/any other column changes (only `user_identity_tokens.displayName`/`pseudonymizedAt` change) — confirmed by re-running 8.1's `verifyAuditRange()` over those rows' time range before and after pseudonymization and asserting identical `passed`/`failed` results both times (PJ6's design: the token reference is immutable, only the display-name lookup table changes, per AC-E8d).

**Edge case — a NEW audit event written after pseudonymization, for an action the pseudonymized user performs:** **given** a pseudonymized user (whose account is not deactivated) subsequently performs an auditable action, **when** the new `audit_log_entries` row is written, **then** it uses the **same** `actor_token_id` as their pre-pseudonymization rows (via `firstActorTokenIdForUser()`, unchanged) — the pseudonymized user's past and future audit rows all resolve to the same alias when displayed, with no special-casing needed anywhere in the write path.

### AC-20: Pseudonymize — Authorization and Tenant Isolation

**Given** a user with `admin`, `member`, or `viewer` role,
**when** they call the pseudonymize endpoint,
**then** the response is `403` — owner-only, matching epics.md's explicit "(owner only)" and the same-class-of-action precedent as 8.1's verify endpoint.

**Edge case — target user is not a member of the caller's org:** **given** Org A's owner calls `POST /api/v1/org/users/:userIdInOrgB/pseudonymize` for a user who only belongs to Org B, **when** the request is made, **then** the response is `404` (not `403` — matching the existing non-leaking 404-for-cross-org-target convention already used by `organization-settings-routes.ts` and `org/routes.ts`'s deactivate handler) — the target's org membership is checked before any mutation.

### AC-21: Pseudonymize — Own Action Audited

**Given** an owner pseudonymizes a user,
**when** the request completes,
**then** an `audit_log_entries` row is written with a new `AuditEvent.USER_PSEUDONYMIZED` (`'user.pseudonymized'`) constant (added to `packages/shared/src/constants/audit-events.ts`), `payload: { targetUserId, tokensPseudonymized: <count> }` — **no PII (old display name, email) in the payload**, since `secure-route.ts`'s `FORBIDDEN_AUDIT_KEYS` sanitization does not automatically apply to manual `writeHumanAuditEntryOrFailClosed` calls (this story must exclude PII deliberately, not rely on automatic stripping).

**Edge case — re-pseudonymization (no-op case, AC-18) is still audited:** **given** a second pseudonymize call on an already-pseudonymized user, **when** the request completes, **then** a `user.pseudonymized` audit row is **still** written (with `payload.tokensPseudonymized: 0` to reflect that no row actually changed) — the action of *calling* pseudonymize on this user is itself an auditable compliance-relevant event, independent of whether it changed anything.

### AC-22: Pseudonymize — Cross-Org Display-Name Bleed (Documented, Tested Behavior, per D9)

**Given** a user who belongs to both Org A and Org B,
**when** Org A's owner pseudonymizes them,
**then** Org B's subsequent access reports and (once 8.2 ships) audit exports **also** show the pseudonymized alias for that user's historical rows — not just Org A's. This is asserted directly by an integration test (using `withTwoTestOrgs()` with the same underlying user added to both), with a code comment at the test site citing this AC and D9, so a future reader sees this as an intentional, tested, accepted trade-off rather than mistaking it for a bug to "fix" in isolation.

**Edge case — Org B's owner has no visibility into or control over the fact this happened:** **given** the same scenario, **when** Org B's owner later generates their own access report or (once available) an audit export, **there is no notification or flag anywhere in Org B indicating the display name changed due to another org's action** — this is the accepted trade-off's full scope, documented here rather than silently discovered as confusing behavior by an Org B owner during a future audit.

---

### AC-23: Backfill Check — Re-Run at Story Completion, Clean Case

**Given** this story's own integration test database, seeded with audit rows from a simulated multi-epic history (human-actor rows all correctly routed through `user_identity_tokens`),
**when** `checkAuditActorTokenCoverage()` (from Story 8.1, `packages/db/src/check-audit-actor-token-coverage.ts`) is invoked as part of this story's own test suite,
**then** it reports zero gaps — confirming this story's own new write paths (dormancy job, pseudonymize endpoint, access-report audit write) all correctly route through `actor_token_id`/`user_identity_tokens` and introduce no new coverage gaps.

**Edge case — this story's own new audit event types are covered too:** the test explicitly includes at least one `audit.access_report_generated` row and one `user.pseudonymized` row in the seeded dataset before asserting zero gaps — a developer must not assume "the backfill check passed" without having actually exercised this story's new event types through it.

### AC-24: Backfill Check — Dirty Case Blocks Sign-Off; Machine-User Scope Confirmed Sufficient

**Given** a deliberately corrupted test row (`actor_type = 'human'`, `actor_token_id = NULL`, inserted and rolled back within a transaction per 8.1's own AC-14 isolation requirement — never left in a shared test database),
**when** `checkAuditActorTokenCoverage()` runs,
**then** it reports the gap — and this story's own sign-off checklist (Dev Notes) states plainly: **if this check reports any real (non-test-fixture) gap against the actual pre-production database at any point before this story is marked `done`, that gap must be resolved first; this story does not ship with a known, unresolved backfill gap.**

**Edge case — machine-user rows are confirmed out of scope, not silently ignored (D11):** an explicit unit test asserts that a row with `actor_type = 'machine_user'` and `actor_token_id = NULL` is **not** flagged by `checkAuditActorTokenCoverage()` (which is correctly scoped to `actor_type = 'human'` only, per 8.1's own D3) — with a code comment citing this story's D11 and closing out 8.1's open forward-reference explicitly, rather than a future reader wondering again whether this is a gap.

### AC-25: FR102 — Recovery & Deactivation Events Queryable via Standard Audit Search

**Given** a user who was deactivated (Story 4.3, `ORG_USER_DEACTIVATED`) and another who went through account recovery (`ACCOUNT_RECOVERY_REQUESTED`/`ACCOUNT_RECOVERY_LINK_SENT`/`ACCOUNT_RECOVERY_COMPLETED`),
**when** an owner calls 8.2's `GET /api/v1/org/audit/events?eventType=org.user_deactivated` (once 8.2 is `done`, per D7's hard prerequisite — this story adds no new search capability, only an integration test confirming an already-satisfied requirement),
**then** the deactivation event is returned; the same holds for each recovery-flow event type — confirming FR102's "recorded... as privileged events... queryable via standard audit search" is satisfied entirely by Stories 4.3 (writes) + 8.2 (search), with this story contributing only the confirming test, not new production code.

**Edge case — this story does NOT fix the still-stubbed rotation-block check:** `checkActiveRotationsForUser()` (`apps/api/src/modules/org/deactivation.ts:18-24`) remains a permanent stub returning `{ blocked: false }` pending a real Epic 5 rotations-table check, per its own code comment — even though Epic 5's `rotations` table now exists (migration `0027`), that stub has not been revisited. **This is out of scope for this story** (FR102's "orphan handling" clause belongs to Story 4.3/Epic 5's tracked debt, not Story 8.3's FR44/FR69/FR71/FR102-recorded-events charter) — flagged here as an explicit, named non-goal so it is not silently rediscovered as "should Story 8.3 have fixed this?"

---

### AC-26: Migration Safety and RLS Coverage

**Given** this story's single new migration (D5: `organizations.user_dormancy_threshold_days` column + `idx_security_alerts_dormant_user` index),
**when** the migration runs against a fresh database,
**then** it applies cleanly, the new column has the correct default (`90`) and CHECK constraint, and `packages/db/src/__tests__/check-rls-coverage.test.ts` continues to pass unchanged — this story adds no new table, so no new RLS policy is needed; the new column lives on the already-RLS-covered `organizations` table and the new index lives on the already-RLS-covered `security_alerts` table.

**Edge case — existing orgs get the default threshold on migration:** **given** an existing org row created before this migration, **when** the migration runs, **then** its `userDormancyThresholdDays` becomes `90` (the `NOT NULL DEFAULT 90` applies retroactively to existing rows, matching how `machineKeyDormancyThresholdDays` was introduced in migration `0032`) — no backfill script needed.

### AC-27: Route-Audit CI Coverage

**Given** this story's three new routes (`POST /audit/access-report`, `PATCH /organizations/:orgId/user-dormancy-settings`, `POST /users/:userId/pseudonymize`),
**when** `apps/api/src/__tests__/route-audit.test.ts` runs,
**then** each route has an explicit classification entry in `apps/api/src/lib/route-exemptions.ts` (`action: 'mutation'` for the settings/pseudonymize routes; `action: 'sensitive-read'` for the access-report route, matching the classification already used for other compliance-data-reading GETs/POSTs per `route-exemptions.ts:308`/`:750`) — no bare, unclassified route reaches `main`.

### AC-28: Full Integration Test Matrix

**Given** this story's complete scope,
**when** the full test suite runs,
**then** it covers, at minimum: access-report happy path (now + historical), CSV format, pagination, all validation sub-cases, owner-only + cross-org isolation, own-call audit write, pseudonymization-reflected display name; dormancy job happy path, dedup, threshold configuration + validation, never-active fallback, deactivated-user exclusion, dismiss (reusing existing endpoint's tests, extended to this alert type), deactivate (reusing existing endpoint's tests), routing default + override; pseudonymize happy path, idempotent no-op (including the direct-DB-trigger assertion), HMAC-integrity-preserved verification, authorization + tenant isolation, own-action audit write (including the no-op-still-audited case), cross-org bleed; backfill check clean + dirty + machine-user-non-issue cases; FR102 search confirmation; migration/RLS/route-audit CI guards.

---

## Tasks / Subtasks

- [ ] Task 1: Fix `org_memberships.lastActiveAt` write path (AC: 9)
  - [ ] 1.1 Add `touchOrgMembershipActivity(orgId, userId)` to `apps/api/src/modules/auth/session-activity.ts`, own debounce map keyed `${orgId}:${userId}`, reusing `env.SESSION_ACTIVITY_DEBOUNCE_SECONDS`
  - [ ] 1.2 Call it from `apps/api/src/plugins/authenticate.ts`'s `touchActivityWithoutBlocking` (line ~142-151), alongside `touchSessionActivity`, same fail-open `try/catch`
  - [ ] 1.3 Unit test: activity touch updates `org_memberships.lastActiveAt`; debounce prevents redundant writes within the window; a thrown error inside the touch does not fail the request
- [ ] Task 2: Migration — dormancy threshold column + dedup index (AC: 12, 26)
  - [ ] 2.1 Confirm next-free migration index against `packages/db/src/migrations/meta/_journal.json` at implementation time (D5) — do not hardcode
  - [ ] 2.2 Add `userDormancyThresholdDays` to `packages/db/src/schema/organizations.ts` (mirrors `machineKeyDormancyThresholdDays` exactly, including the CHECK constraint)
  - [ ] 2.3 Add `idx_security_alerts_dormant_user` partial unique index to `packages/db/src/schema/security-alerts.ts` (mirrors `idx_security_alerts_dormant_key`)
  - [ ] 2.4 Generate and review the Drizzle migration SQL; confirm it matches the hand-written style of `0032_machine_key_rotation_dormancy_cacheable.sql`
- [ ] Task 3: Dormant-user detection job (AC: 10, 11, 13, 16)
  - [ ] 3.1 Create `apps/api/src/workers/user-dormancy-check.ts` (`runUserDormancyCheckJob`), structural copy of `machine-key-dormancy-check.ts`: `fetchAllOrgIds()` → `runOrgScopedJob()` per org → query `org_memberships` (status='active', lastActiveAt/createdAt threshold OR-logic per AC-13) → `INSERT ... ON CONFLICT DO NOTHING` against the new partial index → `createOrgAdminNotificationEntries` + `sendNotificationJobs`
  - [ ] 3.2 Register `'user:dormancy-check': { cron: '0 9 * * *' }` and its worker callback in `apps/api/src/main.ts` (mirrors lines ~143/~206-208 exactly)
  - [ ] 3.3 Add `userDormantPayloadSchema` to `apps/api/src/modules/org/schema.ts`; union into `securityAlertPayloadSchema`; register in `PAYLOAD_SCHEMA_BY_ALERT_TYPE` (`apps/api/src/modules/org/security-alerts.ts:29-33`)
  - [ ] 3.4 Unit/integration test: `user-dormancy-check.test.ts` mirroring `machine-key-dormancy-check.test.ts`'s structure
- [ ] Task 4: Dormancy threshold settings route (AC: 12)
  - [ ] 4.1 Add a second `secureRoute` registration to `apps/api/src/modules/org/organization-settings-routes.ts`: `PATCH /:orgId/user-dormancy-settings`, mirroring the existing `machine-key-settings` handler exactly (`minimumRole: 'admin'`, `requireMfa: true`, rate limit `10/60s`, manual audit write `eventType: 'organization.user_dormancy_settings_updated'`)
  - [ ] 4.2 Add `UserDormancySettingsBodySchema`/`ResponseSchema` to `apps/api/src/modules/org/organization-settings-schema.ts`
  - [ ] 4.3 Route-exemptions classification entry (AC-27)
- [ ] Task 5: Access-report endpoint (AC: 1, 2, 3, 4, 5, 6, 7, 8)
  - [ ] 5.1 Create `apps/api/src/modules/audit/access-report.ts` exporting the current-state query (D2 fast path) and the event-replay reconstruction (D2 historical path), both joining `user_identity_tokens` for `displayName` (D4, never `users.email`)
  - [ ] 5.2 Create `apps/api/src/modules/audit/access-report-schema.ts` (Zod request/response schemas, `asOf`/`page`/`limit`/`format`)
  - [ ] 5.3 Register `POST /audit/access-report` in `apps/api/src/modules/audit/routes.ts` (the file 8.1 creates — extend it, do not duplicate its registration, per 8.1/8.2's own D1/D2 precedent of extending one shared file), `allowedRoles: ['owner']`, `writeAuditEvent: true`, `eventType: 'audit.access_report_generated'`
  - [ ] 5.4 CSV formatting: flatten to one row per user×project pair using 8.2's `toCsvRow()` (`apps/api/src/modules/audit/csv.ts`) — if 8.2 has not landed by the time this task starts, this is a hard blocker per D7/Prerequisites, not a "write a local copy" workaround
  - [ ] 5.5 Add `AuditEvent.ACCESS_REPORT_GENERATED = 'audit.access_report_generated'` to `packages/shared/src/constants/audit-events.ts`
  - [ ] 5.6 Integration tests: `access-report.test.ts` covering AC-1 through AC-8
- [ ] Task 6: Pseudonymize endpoint (AC: 17, 18, 19, 20, 21, 22)
  - [ ] 6.1 Create `apps/api/src/modules/org/pseudonymize.ts` exporting a function callable both from the HTTP route and (per Epic Cross-Story Context, forward dependency to Story 8.4) internally within another transaction — return `{ alias, pseudonymizedAt, tokensPseudonymized }`
  - [ ] 6.2 Implement the no-op-on-already-pseudonymized behavior (D8) — check `pseudonymizedAt IS NOT NULL` **before** attempting any `UPDATE`, do not rely on catching the trigger's exception as control flow
  - [ ] 6.3 Register `POST /users/:userId/pseudonymize` in `apps/api/src/modules/org/routes.ts`, `allowedRoles: ['owner']`, `requireMfa: true`, rate limit `20/60s` (matches deactivate's sensitivity tier), manual audit write with `AuditEvent.USER_PSEUDONYMIZED`, payload excluding PII (AC-21)
  - [ ] 6.4 Add `AuditEvent.USER_PSEUDONYMIZED = 'user.pseudonymized'` to `packages/shared/src/constants/audit-events.ts`
  - [ ] 6.5 Integration tests: `pseudonymize.test.ts` covering AC-17 through AC-22, including the direct-DB-trigger assertion (AC-18's edge case) and the `withTwoTestOrgs()` cross-org-bleed assertion (AC-22)
- [ ] Task 7: Backfill check re-run and FR102 confirmation (AC: 23, 24, 25)
  - [ ] 7.1 Add an integration test in this story's own suite invoking `checkAuditActorTokenCoverage()` (from Story 8.1) against a seeded dataset including this story's new event types — clean case
  - [ ] 7.2 Add the dirty-case test (rolled-back transaction fixture, per 8.1's own AC-14 isolation requirement) and the machine-user-non-issue test (D11)
  - [ ] 7.3 Add an integration test confirming `GET /audit/events?eventType=...` (from Story 8.2) returns 4.3's existing deactivation/recovery event rows — no production code change, confirmation only
- [ ] Task 8: CI guards and OpenAPI (AC: 26, 27, 28)
  - [ ] 8.1 Confirm `check-rls-coverage.test.ts` passes unchanged (no new table)
  - [ ] 8.2 Add route-exemptions classification entries for all three new routes
  - [ ] 8.3 Run `pnpm generate-spec`; confirm all three new endpoints appear in `packages/shared/openapi.json`
  - [ ] 8.4 Run `make ci` end-to-end
  - [ ] 8.5 Raise the Epic 8 dedicated-UI-story gap at Epic 8 sprint planning (Product Surface Contract escalation, see above) before marking this story `done`

---

## Dev Notes

- **Do not start implementation until Story 8.1 and Story 8.2 are both `done`** (D7/Prerequisites). This story file can be reviewed and refined now, but `checkAuditActorTokenCoverage()`, `toCsvRow()`, `apps/api/src/modules/audit/routes.ts`, and `GET /audit/events` are all hard dependencies that do not exist in code yet.
- **The single biggest correctness risk in this story is treating the access report as a simple current-state query.** Re-read D2 before starting Task 5: `org_memberships`/`project_memberships` rows are hard-deleted on removal (`removeUserFromOrgMemberships`), so any `asOf` that isn't "now" *must* go through audit-event replay, or removed users will silently and incorrectly vanish from historical reports.
- **The second-biggest risk is reusing `listOrgUsers()`'s `displayName` convention.** It derives from `users.email`, which is correct for the existing 4.2 user-management screen but wrong for this story's access report and CSV export — both must resolve `displayName` via `user_identity_tokens` (D4), or pseudonymization becomes silently ineffective for this story's own primary compliance artifact.
- **Do not attempt to make AC-E8d's "new alias on re-pseudonymization" literally true.** The `prevent_pseudonym_reversal()` trigger (`0001_rls_and_triggers.sql:72-87`) will reject it at the database level. Implement the no-op interpretation (D8) and write the test that proves the trigger itself blocks the naive approach, so a future reader understands *why* re-pseudonymization is a no-op rather than assuming it's an oversight.
- **`user_identity_tokens` is platform-level, not org-scoped** (`user-identity-tokens.ts:4`). A user can have exactly one row per registration but can belong to `(org, user)` memberships in multiple orgs sharing that one row. Pseudonymization is therefore inherently cross-org in its effect — this is D9's accepted trade-off, not a bug to chase down.
- **`FORBIDDEN_AUDIT_KEYS` sanitization (`secure-route.ts`) only applies to the default `SecureRoute` audit writer, not manual `writeHumanAuditEntryOrFailClosed` calls.** Every manual audit payload this story writes (dormancy job, pseudonymize) must be reviewed by hand for PII before merging — do not assume automatic stripping protects you.
- **Reuse, don't duplicate, the dismiss endpoint.** It is tempting to write a `user.dormant`-specific dismiss route; resist this. The existing generic endpoint (D6) already handles it — this story's only touch point is a payload-schema registration.
- **Reuse, don't duplicate, the deactivate endpoint.** Same principle — Story 4.3's `POST /users/:userId/deactivate` is complete and correct; this story's job is to *lead an admin to it* (conceptually, via the dormancy alert), not reimplement any part of it.
- **`checkActiveRotationsForUser()`'s permanent stub (`deactivation.ts:18-24`) is explicitly out of this story's scope** (AC-25's edge case) — do not "helpfully" fix it while touching adjacent deactivation-related code; that is separate, differently-scoped debt.
- This story adds exactly **one** migration. If Task 2 seems to require more, stop and re-read D1/D5 — every other table this story touches already has every column it needs.

### Project Structure Notes

- New files: `apps/api/src/workers/user-dormancy-check.ts` (+ `.test.ts`), `apps/api/src/modules/audit/access-report.ts` (+ `.test.ts`), `apps/api/src/modules/audit/access-report-schema.ts`, `apps/api/src/modules/org/pseudonymize.ts` (+ `.test.ts`).
- Modified files: `packages/db/src/schema/organizations.ts` (new column), `packages/db/src/schema/security-alerts.ts` (new index), `packages/db/src/migrations/` (one new migration, number TBD per D5), `apps/api/src/modules/auth/session-activity.ts` (new function), `apps/api/src/plugins/authenticate.ts` (new call site), `apps/api/src/main.ts` (new job registration), `apps/api/src/modules/org/organization-settings-routes.ts` + `-schema.ts` (new route), `apps/api/src/modules/org/routes.ts` (new pseudonymize route), `apps/api/src/modules/org/schema.ts` (new payload schema), `apps/api/src/modules/org/security-alerts.ts` (new payload-schema registration), `apps/api/src/modules/audit/routes.ts` (extend — created by Story 8.1, not this story), `apps/api/src/lib/route-exemptions.ts` (3 new classification entries), `packages/shared/src/constants/audit-events.ts` (2 new constants).
- Alignment with unified project structure: matches the existing `modules/<feature>/{routes,schema,*.ts}` convention; matches the existing `workers/<job-name>.ts` + `main.ts` cron/registration convention (`machine-key-dormancy-check.ts`); matches the existing `organization-settings-routes.ts` multi-setting-in-one-file convention.
- No new tables; no new top-level modules; this story extends five existing modules (`audit`, `org`, `auth`, `workers`, `shared/constants`) rather than introducing a sixth.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-8.3` (lines 1932-1956)] — this story's literal AC text, FR44/FR69/FR71/FR102 coverage.
- [Source: `_bmad-output/planning-artifacts/epics.md` lines 1858-1871, 1902-1930] — Epic 8 preamble (PJ4/PJ5/PJ6, AC-E8a/b/c/d) and Story 8.2's full text (cross-org bleed flag, CSV helper origin).
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 863-931] — FR44, FR69, FR71 exact text (FR102 has no `prd.md` entry — epics.md line 102 is authoritative, a documented PRD/epics reconciliation gap noted, not fixed, by this story).
- [Source: `_bmad-output/planning-artifacts/ux-design-specification.md` lines 82-87] — Dana persona, "terminated-employee access is a frequent auditor question."
- [Source: `_bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md` and its `-adversarial-review.md`] — hard prerequisite; backfill check, `verifyAuditRange()`.
- [Source: `_bmad-output/implementation-artifacts/8-2-audit-log-search-export-and-external-forwarding.md` and its `-adversarial-review.md`] — hard prerequisite; `csv.ts`, `GET /audit/events`, the cross-org bleed flag explicitly carried to this story.
- [Source: `_bmad-output/implementation-artifacts/4-3-account-deactivation-and-recovery.md`] — deactivation/recovery event names and behavior this story's AC-15/AC-25 rely on unchanged.
- [Source: `packages/db/src/schema/{organizations,org-memberships,project-memberships,user-identity-tokens,audit-log-entries,security-alerts}.ts`] — exact shipped schema this story reads and extends.
- [Source: `packages/db/src/migrations/0001_rls_and_triggers.sql` lines 72-87] — `prevent_pseudonym_reversal()` trigger, the load-bearing fact behind D8.
- [Source: `apps/api/src/modules/org/user-management.ts`] — `listOrgUsers()`'s `displayName`-from-email convention (D4, why it must not be reused here), `removeUserFromOrgMemberships()`'s hard-delete behavior (D2).
- [Source: `apps/api/src/workers/machine-key-dormancy-check.ts`, `apps/api/src/modules/machine-users/dormancy-admin-actions.test.ts`, `apps/api/src/modules/org/organization-settings-routes.ts`] — Story 7.2's structural templates this story mirrors.
- [Source: `apps/api/src/modules/org/security-alerts.ts`, `security-alert-actions-routes.ts`, `packages/db/src/schema/security-alerts.ts`] — generic dismiss endpoint and dedup-index pattern this story reuses/extends.
- [Source: `apps/api/src/modules/auth/session-activity.ts`, `apps/api/src/plugins/authenticate.ts` lines 93-180] — activity-touch pattern this story extends (D3).
- [Source: `apps/api/src/modules/auth/service.ts` line 385] — `user_identity_tokens.displayName` initialized to email at registration.
- [Source: `packages/shared/src/constants/audit-events.ts`] — existing event catalog this story adds two entries to.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
