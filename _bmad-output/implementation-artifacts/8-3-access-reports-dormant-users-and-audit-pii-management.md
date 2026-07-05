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
| **Linked UI story** (if API-only) | `TBD` — this is the third consecutive Epic 8 story to hit this same underlying gap ("no story anywhere scopes a dedicated audit-log web UI," first flagged by 8.1/8.2). This story's own epics.md AC text happens to spell it out slightly more explicitly ("displayed as a paginated UI table"), but the substance of the gap — no Epic 8 audit/compliance UI exists yet — is identical across all three stories; this is a continuation of the same accepted trade-off, not a categorically new kind of problem. Building that UI is a non-trivial SvelteKit undertaking (new route, new data-table component, role-gated nav entry) that is out of scope for this story to absorb silently — this story delivers the correct, fully-tested API surface the UI will consume. **Tracked as a follow-up, not a completion gate:** Task 8.5 below records raising a dedicated Epic 8 UI story (covering the access-report table, the dormant-alert admin actions, and — from 8.2 — search/export) at Epic 8 sprint planning as a reminder/follow-up action. It is **not** a blocking gate on this story's own `done` status — a cross-team scheduling dependency (getting on a sprint-planning agenda) must not stall this story's own, independently completable implementation. Epic-8-level UI completeness is tracked separately, at the epic level, not enforced story-by-story. |
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

1. **Fast path (`asOf` omitted from the request entirely):** query `org_memberships` + `project_memberships` directly (current state is correct by definition for "now"). This is a new query, not a reuse of `listOrgUsers()` (`apps/api/src/modules/org/user-management.ts:14-52`) — see D4 for why that function's `displayName` convention must **not** be reused here. **Precise fast-path condition (resolves finding-8 ambiguity):** the fast path applies **only** when the `asOf` key is absent from the request body — never based on comparing a supplied value to the current instant. Any request that includes an explicit `asOf` value — even one a client computed to equal "right now" — always takes the historical/replay path below. This removes any equality/tolerance judgment call from the implementation: presence-or-absence of the field is the only branch condition, so there is no flaky boundary between AC-1 and AC-2.
2. **Historical path (`asOf` is present in the request, at any valid timestamp, past or equal to "now"):** reconstruct via **audit-event replay**. For each `(orgId, userId, projectId)` triple, scan `audit_log_entries` rows with `orgId` matching and `eventType` in the membership-mutation set below, ordered by `createdAt ASC`, up to and including `asOf`; the last event before/at `asOf` per triple determines whether access existed and at what role at that instant:
   - `user.registered` (`AuditEvent.USER_REGISTERED`, written by `registerUser()` in `apps/api/src/modules/auth/service.ts:394` whenever the registration has **no** invitation — i.e., the org-creating founding owner) → **org-membership-creation event**, `orgRole: "owner"`, effective from this event's `createdAt` onward. Confirmed via `insertRegistrationMemberships()` (`auth/service.ts:280-294`): a founder's `org_memberships` row is inserted with `role: 'owner'` in the same transaction as this audit write. This event carries no `resourceId`; the subject user is identified via the row's own `actorTokenId` (the identity token just created for this same user in the same transaction — actor and subject are the same person for a self-registration event), joined to `user_identity_tokens.userId`. **This is the fix for the critical gap where the founding owner had no replay-visible creation event**: without this event type in the replay set, every org's first owner — the single most common user in every org — could vanish from historical reports at any `asOf`.
   - `project.invitation_accepted` (`AuditEvent.PROJECT_INVITATION_ACCEPTED`) → **also an org-membership-creation event** when the accepting user had no prior `org_memberships` row in this org (org role always granted as `'member'` on first accept, never the invited project role — confirmed at both emission sites below), in addition to being a project-membership grant. Two confirmed emission sites, with two different payload shapes (grep-verified, not "to be confirmed at implementation time"):
     - `apps/api/src/modules/invitations/token-routes.ts:174-182` (an already-authenticated existing user accepting an invitation): `resourceId: invitation.id`, `actorUserId: secureCtx.auth.userId` (the accepting user, resolved to `actorTokenId` via `firstActorTokenIdForUser()`), `payload: { projectId: invitation.projectId }` — **no `role` field in the payload**.
     - `apps/api/src/modules/auth/service.ts:390-398` (a brand-new user registering via an invitation link): no `resourceId` at all (the shared `insertAuditEntry()` helper this call site uses does not accept one), `actorTokenId` = the identity token created for this same new user in this transaction, `payload: { emailDomain, projectId }` — also **no `role` field**.
     - **Because neither emission site's payload carries the granted project role, the replay algorithm must resolve `role` by joining to `project_invitations.roleToAssign`** (`packages/db/src/schema/project-invitations.ts` — confirmed this table is never hard-deleted, only cascade-deleted with its parent org/project, so historical rows remain joinable indefinitely): when `resourceId` is present (the `token-routes.ts` shape), join directly on `project_invitations.id = resourceId`; when `resourceId` is absent (the `auth/service.ts` registration shape), join on the unique `(orgId, projectId, email)` combination, resolving `email` via the subject user's `users.email` (itself reached via `actorTokenId → user_identity_tokens.userId → users.id`) — at most one live/claimed invitation exists per `(orgId, projectId, email)` at a time, since `claimInvitation()` requires `acceptedAt IS NULL` before claiming.
   - `project.member_role_changed` (`apps/api/src/modules/org/routes.ts:638-650`, confirmed: `resourceId: params.userId`, `payload: { projectId, oldRole, newRole }`) → role changes to `payload.newRole` from this event's `createdAt` onward, for the `(orgId, resourceId, payload.projectId)` triple.
   - `project.member_removed` (`apps/api/src/modules/projects/routes.ts:694-702`, confirmed: `resourceId: params.userId`, `payload: { projectId, removedRole }`) → membership ends at this event's `createdAt`, for the `(orgId, resourceId, payload.projectId)` triple.
   - `project.ownership_transferred` (`apps/api/src/modules/projects/routes.ts:796-804`, confirmed: `resourceId: params.projectId`, `payload: { previousOwnerId, newOwnerId }`) → **derives exactly two state transitions from this one event, as follows** (resolving the previously-unspecified replay mechanics): (a) for the `(orgId, previousOwnerId, resourceId)` triple, role changes to `"admin"` from this event's `createdAt` onward (matching the handler's own demotion `UPDATE ... SET role = 'admin'` immediately preceding the audit write); (b) for the `(orgId, newOwnerId, resourceId)` triple, role changes to `"owner"` from this event's `createdAt` onward (matching the handler's own promotion `UPDATE ... SET role = 'owner'`). Both transitions read from the same single event row; no removal-side/grant-side ambiguity remains — this event never ends a membership (AC-E4c requires the new owner already be an accepted project member before transfer), it only changes role for two already-existing triples.
   - `org.user_removed` (`apps/api/src/modules/org/routes.ts:527-535`, confirmed: `resourceId: params.userId`, `payload: { removedProjectCount }`) → **all** of that user's project memberships in the org end at this event's `createdAt` (cascading removal), and the user drops out of the report entirely for any `asOf` at or after this timestamp.
   - `org.user_deactivated` (`apps/api/src/modules/org/routes.ts:291-299`, confirmed: `resourceId: params.userId`, `payload: { revokedSessionCount, revokedInvitationCount }`) → user's `status` becomes `deactivated` at this event's `createdAt` (they remain **in** the report — deactivated ≠ removed — with `status: "deactivated"`, per epics.md's own report shape including a status-bearing field).
   - **Org-level role is treated as immutable after initial grant** (confirmed: `apps/api/src/modules/org/routes.ts` has exactly one `update(orgMemberships)` call site, and it only ever changes `status`, never `role` — there is no org-role-change endpoint anywhere in this codebase). So a user's `orgRole` in a historical report is simply whatever it was at the org-membership-creation event (`user.registered` for the founding owner, `project.invitation_accepted` for everyone else — see above); no replay needed for that one field.
   - **Deterministic ordering (resolves finding-9 pagination-stability gap):** both the fast path and the historical path return the user list sorted by `userId ASC` (a stable, collision-free tiebreaker requiring no secondary key, since `userId` is a UUID primary key) — applied identically regardless of which path served the request, so page 2/page 3 of a paginated request are guaranteed consistent and non-overlapping even though the historical path assembles its result set via in-memory replay rather than a single ordered SQL query.
3. **Both paths resolve `displayName` via `user_identity_tokens.displayName`, never `users.email`** (D4) — **always the current-state value of `displayName`, regardless of `asOf`; see D4/AC-2/AC-8 for why this is intentional, not a bug.** Both paths return the exact same response shape (see AC-1/AC-2), so the caller cannot tell which path served the request except via response latency.

**Validation boundary:** `asOf` must not be before the org's `createdAt` (nothing to report — reject, don't silently return empty, per AC-5) and must not be in the future (reject — a report about access that hasn't happened yet is meaningless).

**Indexing and performance for the historical replay path (resolves finding-10):** the replay query's access pattern is `WHERE org_id = ? AND event_type IN (...) AND created_at <= ?`, ordered by `created_at`. This is already well-served by the existing `idx_audit_log_entries_org_created` composite index (`packages/db/src/schema/audit-log-entries.ts`, `ON (org_id, created_at DESC)`) — an equality filter on the leading column plus a range condition on the second is exactly what a B-tree composite index is built for (scanning it in ascending order is the same cost as descending), with `event_type` applied as a residual filter over the already-narrow, org-scoped row set. **No new index is required for this story.** Execution-time expectation: for a mature org with on the order of 10^5 cumulative audit rows and low hundreds of users/projects, replay is expected to complete within the same low-hundreds-of-milliseconds budget as this story's other secure-route handlers — well within `secureRoute()`'s existing request-level timeout, so no new timeout/backpressure mechanism is introduced by this story. If a future story's profiling reveals unacceptable latency at materially larger audit-history scale, the recommended follow-up is a periodic materialized snapshot of per-`(org, user, project)` last-known-state (out of this story's scope), not a new index on this already-covered access pattern.

### D3 — `org_memberships.lastActiveAt` is a real, already-migrated column that no code path currently writes — this story must add the write path

Confirmed by exhaustive grep: `org_memberships.lastActiveAt` (`packages/db/src/schema/org-memberships.ts:16`) has **zero writers** anywhere in `apps/api/src`. Only `sessions.lastActiveAt` (a different table) is actively maintained, via `touchSessionActivity()` (`apps/api/src/modules/auth/session-activity.ts`), called from `apps/api/src/plugins/authenticate.ts:172` (`touchActivityWithoutBlocking`) on every authenticated request. Without a fix, the dormant-user job would see every user's `lastActiveAt` as permanently `NULL`, making the feature non-functional for anyone who has ever been active (it would only ever flag users by their `createdAt` fallback, never by genuine inactivity).

**Resolution:** add a sibling function `touchOrgMembershipActivity(orgId, userId)` to `session-activity.ts`, using its own debounce map (keyed by `${orgId}:${userId}`, reusing `env.SESSION_ACTIVITY_DEBOUNCE_SECONDS` — do not add a new env var), called from `authenticate.ts`'s existing `touchActivityWithoutBlocking` alongside (not instead of) `touchSessionActivity`. `session.orgId` and `session.userId` are already in scope at that call site (`authenticate.ts:172`, confirmed by reading the file — no plumbing needed to get the IDs there).

**Independent fail-open isolation (resolves finding-11):** confirmed by reading `authenticate.ts:142-151`, `touchActivityWithoutBlocking` today wraps its single `touchSessionActivity(sessionId)` call in one `try/catch` that logs a `warn`-level `session.activity_touch_failed` on failure. When `touchOrgMembershipActivity(orgId, userId)` is added, it must be wrapped in its **own, separate** `try/catch` inside `touchActivityWithoutBlocking` — not folded into the existing `try` block — so that an exception thrown by one touch call can never prevent the other from running (e.g., a transient failure writing `org_memberships.lastActiveAt` must not suppress the `sessions.lastActiveAt` write, and vice versa). Each catch block logs its own distinct `warn`-level event (`session.activity_touch_failed` / `org_membership.activity_touch_failed`) so the two failure modes remain distinguishable in logs.

**Known, accepted limitation — per-process debounce (resolves finding-18):** `touchOrgMembershipActivity`'s debounce map is in-memory and per-process, exactly like the existing `touchSessionActivity`'s (`session-activity.ts:6`, `lastActivityWrite`). In a horizontally-scaled deployment with multiple API instances behind a load balancer, the debounce window is enforced only per-instance, not globally — a user whose requests are load-balanced across N instances could cause up to N writes within one nominal debounce window instead of one. This is an accepted, already-existing characteristic this story's new sibling function simply inherits, not a new regression to fix here; a global (e.g., Redis-backed) debounce would be a separate, cross-cutting piece of work affecting both functions equally, out of this story's scope.

### D4 — Access report and CSV export must resolve `displayName` via `user_identity_tokens`, not `users.email` — do not reuse `listOrgUsers()`'s convention

`listOrgUsers()` (`apps/api/src/modules/org/user-management.ts:44-51`, powering the existing org user-management list) derives `displayName` from `users.email` directly, with an explicit comment: `// D3: no dedicated profile column; derive from email.` That convention **predates pseudonymization** and is correct for its own screen, but is the exact wrong choice here: `user_identity_tokens.displayName` is initialized to the user's email at registration (`apps/api/src/modules/auth/service.ts:385`, `values({ userId: user.id, displayName: email })`) and **only diverges from `users.email` once pseudonymized** (this story's own new endpoint, AC-16 onward). An access report — the compliance artifact this story exists to produce — that silently reads `users.email` instead would keep leaking a pseudonymized user's real email in every report generated after pseudonymization, defeating FR44 entirely. **The access-report query, in both D2 code paths, must join through `user_identity_tokens` (by `userId`, using the same "first created wins" ordering `firstActorTokenIdForUser()` already uses) for `displayName` — never `users.email`.**

**Pseudonymization is always current-state, deliberately, even for historical reports (resolves finding-2's AC-2/D4 contradiction):** pseudonymization is intentionally **irreversible** (`prevent_pseudonym_reversal()`, D8) — the entire point is that a pseudonymized user's real name/email must never be recoverable or re-displayed again, in any report, past or present. If the historical path resolved `displayName` from some point-in-time snapshot instead of the current `user_identity_tokens` row, a report for a past `asOf` generated *after* a pseudonymize call would show the user's **real name** for a period before pseudonymization existed — which is exactly the outcome pseudonymization exists to prevent. So "both paths resolve `displayName` via the current-state `user_identity_tokens` row, regardless of `asOf`" (D2 item 3) is not an oversight or a contradiction to fix — it is the correct, deliberate behavior. **AC-2 is reworded accordingly** (see below): its "matches what a report generated on that date would have shown" guarantee is scoped to **access grants and roles only** (who had access, with what role, at that point in time) — it explicitly does **not** extend to `displayName`/PII resolution, which is always current-state by design, independent of `asOf`, for both code paths. AC-2 now includes an explicit test case: generate a historical report for a past `asOf` immediately after pseudonymizing the subject user, and confirm the report shows the alias — never the real name — even though the real name was actually in effect as of that past `asOf`.

### D5 — One new migration: `organizations.user_dormancy_threshold_days` column + a partial unique index on `security_alerts`; no new tables

Mirrors Story 7.2's `machineKeyDormancyThresholdDays` exactly (`packages/db/src/schema/organizations.ts:12-15`, `CHECK ... IN (30, 60, 90, 180)`) and Story 7.2's `idx_security_alerts_dormant_key` dedup index (`packages/db/src/schema/security-alerts.ts:34-36`). New column: `userDormancyThresholdDays integer NOT NULL DEFAULT 90 CHECK (... IN (30, 60, 90, 180))`. New index: `idx_security_alerts_dormant_user UNIQUE ON (payload->>'userId') WHERE alert_type = 'user.dormant' AND status != 'dismissed'`.

**Migration numbering is not yet knowable and must not be hardcoded.** As of this story's creation, the latest committed migration is `0033_break_glass_and_stale_recovery.sql` (confirmed via `packages/db/src/migrations/meta/_journal.json`, `idx: 33`). Stories 8.1 and 8.2 are both unmerged (`ready-for-dev`, not `done` — see D7/Prerequisites) and each plans its own migration(s); **check `_journal.json` again at implementation time** and claim whatever index is actually next-free once 8.1 and 8.2 have landed. Do not assume "0034" — that is only correct if no other migration lands first.

**Dev Note — re-verify numbering immediately before creating the file, not just "at implementation time" in the abstract (resolves finding-12):** because Story 8.1 and Story 8.2 may land in either order, in parallel, or with additional migrations of their own beyond what's currently anticipated, the implementer must re-read `_journal.json`'s last entry **as the very last step before running `drizzle-kit generate` / hand-authoring the migration file** (i.e., after rebasing/merging onto the latest `main`, not merely once at the start of this story's implementation). Do not trust a migration index number written earlier in a feature branch or in this story's own text — treat `0034` (or whatever this note assumes) as illustrative only. If two branches land migrations with the same claimed index number, CI's migration-numbering check (or, absent one, a manual `_journal.json` diff review at merge time) must catch the collision before merge.

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

**Decision: accepted, not fixed, in this story — but not accepted without a safeguard (resolves finding-5/finding-6).** Building an org-scoped display-name mechanism would mean either (a) one `user_identity_tokens` row per `(org, user)` pair — a schema change touching Story 1.6's identity model and every existing audit row's join, far beyond this story's charter — or (b) a per-org display-name override table layered on top, adding complexity for a scenario (a user simultaneously active in multiple orgs, one of which erases them) that is a real but narrow edge case. This story does not build either of those. It instead adds three concrete, cheap safeguards to the pseudonymize endpoint so the blast radius is visible and deliberate at the moment of action, rather than a silent side effect an Org B owner only discovers later:

1. **Blast-radius lookup before executing:** before performing the pseudonymize `UPDATE`, the handler queries `SELECT DISTINCT org_id FROM org_memberships WHERE user_id = :targetUserId AND org_id != :callerOrgId` to count how many *other* orgs share this user's `user_identity_tokens` row. This count (and the list of other org IDs) is returned to the caller as part of the confirmation requirement below and is recorded in the audit log (item 3).
2. **Explicit re-confirmation input, given the action is irreversible:** the request body must include a `confirmUserId` field that the caller must set to the exact target `userId` being pseudonymized (mirroring the common "re-type the identifier to confirm a destructive action" pattern) — a request without a matching `confirmUserId` is rejected `422` before any mutation, regardless of the blast-radius count. This is a deliberate extra step beyond ordinary owner-only authorization (AC-17/AC-20 unchanged for authorization), specifically because `prevent_pseudonym_reversal()` makes this action permanent and, per this D9 decision, cross-org in effect.
3. **Audit payload records the blast radius, not just the target (resolves finding-15, same fix as finding-5/6's item 3):** AC-21's audit payload is extended from `{ targetUserId, tokensPseudonymized }` to `{ targetUserId, tokensPseudonymized, otherAffectedOrgCount, otherAffectedOrgIds }` — still no PII, only org IDs and a count — so that a future investigation (in Org A, which took the action, since Org B has no visibility into Org A's audit log) can answer "how many other orgs were affected by this specific call" without re-deriving it from scratch.

This story documents the underlying behavior plainly (AC-22) rather than silently shipping it as an unstated side effect, and requires the pseudonymize endpoint's response and the access-report's Dev Notes to say so explicitly, so a future reader — including the eventual UI story (Product Surface Contract note above) — designs around a known fact instead of rediscovering a surprise. If cross-org isolation of PII becomes a hard compliance requirement later, that is new-story-sized work (schema change), not a fix to bolt on here — but requiring deliberate, informed confirmation and an audit breadcrumb is squarely within this story's charter and is added accordingly.

### D10 — FR44's "upon account deletion" vs. this story's on-demand endpoint: a stated scope boundary, not a silent gap

PRD FR44 (`prd.md:927`) says pseudonymization happens "upon account deletion." This story's actual endpoint, `POST /users/:userId/pseudonymize`, is **on-demand, owner-triggered, and not tied to any deletion flow** — there is no account-deletion flow in this codebase yet (Story 8.4, `data-subject-erasure-request-handling`, is `backlog` and is where deletion will live; its own epics.md AC text literally says step 1 of erasure execution is "pseudonymized (**Story 8.3 mechanism**)"). **This story ships the mechanism; Story 8.4 is what will call it as part of a deletion flow.** State this explicitly rather than trying to retrofit an account-deletion trigger into this story that doesn't otherwise exist.

### D11 — Backfill check's human-only scope is correct and complete, closing 8.1's forward-reference

8.1's own story text defers an open question to "Story 7.1/7.2 or Story 8.3": whether the backfill/coverage check (scoped to `actor_type = 'human'` rows only) needs an analogous check for `actor_type = 'machine_user'` rows. It does not. Machine-user audit rows are written via `apps/api/src/modules/audit/machine-entry.ts`, which — by design, confirmed by reading the file — always sets `actorTokenId: null` for machine-user rows; machine users are identified through the separate `machine_users` table (Story 7.1), never through `user_identity_tokens`. There is no gap to backfill: a `null` `actor_token_id` on a `machine_user`-typed row is the permanent, intended state, not an omission. AC-24 makes this an explicit, tested assertion rather than leaving the question open a second time.

### D12 — Alert-audience wording reconciled: FR71 ("Organization Admins") vs. epics.md's Story 8.3 AC ("org owners")

FR71 (`prd.md:931`) says dormant-user alerts go to "Organization Admins" (the PRD's general term for the admin persona, covering both the `admin` and `owner` roles). Epics.md's own Story 8.3 AC text narrows this to "alerts to org owners."

**Revised decision (resolves finding-16 — the PRD, not the epic AC's narrower phrasing, is the source of truth when the two conflict):** FR71 is the PRD-level requirement; epics.md's "org owners" wording is a narrower restatement written into one story's AC text, not a separate, deliberate product decision to notify owners only. Defaulting to owner-only — as this story's D12 originally specified — would mean any org that does not proactively reconfigure routing never notifies its admins of a dormant-user compliance alert at all, which is a materially narrower default than FR71 actually calls for. This story now defaults `user.dormant`'s **recipient set** (absent a per-org override) to **both** the `owner` and `admin` roles, satisfying FR71's broader "Organization Admins" wording literally, with an org able to narrow it back to `owner`-only via the existing per-alert-type `org_notification_routing` override mechanism (FR100) if it prefers the epics.md AC's narrower default.

**Implementation note — this is a small, targeted addition, not a new routing mechanism:** `resolveRoutingRecipients()` (`apps/api/src/modules/notifications/routing.ts:74-115`) resolves a *single* target role (an explicit per-org override if one exists, else the shared `DEFAULT_ROUTING_ROLE` constant = `'owner'`, per `packages/shared/src/constants/notification-types.ts:37`) and calls `getMembersWithRole()` with an *exact* role match — `'admin'` never implicitly includes `'owner'`-role members. Changing the shared `DEFAULT_ROUTING_ROLE` constant would silently widen every other alert type's default too (wrong — every other Epic 8 alert type's owner-only default is intentional and unaffected by this finding). Instead, this story adds a small, alert-type-scoped default: when no `org_notification_routing` override exists for `user.dormant` specifically, the dormancy job resolves recipients as the **union** of `getMembersWithRole(orgId, 'owner', tx)` and `getMembersWithRole(orgId, 'admin', tx)` (deduplicated by `userId`) rather than calling the single-role `resolveRoutingRecipients()` path unmodified. If an org has configured an explicit override (either `owner` or `admin`) for `user.dormant`, that override is honored exactly as today (single role, no union) — the union-of-both-roles behavior applies only to the *unconfigured* default case. This keeps every other alert type's behavior byte-identical and confines the FR71 reconciliation to the one alert type it concerns.

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
| 1 | Access report | Happy path, `asOf` omitted (current-state fast path) |
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
| 16 | Dormancy | Alert routing default (owner **and** admin), FR71/epic AC reconciled |
| 17 | Pseudonymize | Happy path |
| 17a | Pseudonymize | Blast-radius disclosure and explicit re-confirmation required (irreversible, cross-org action) |
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

### AC-1: Access Report — Happy Path, `asOf` Omitted (Current-State Fast Path)

**Given** an org with 3 active users (`owner`, `admin`, `member`) where the `member` belongs to 2 projects with different roles and the `admin` belongs to 0 projects,
**when** the owner calls `POST /api/v1/org/audit/access-report` with `{}` (the `asOf` key is absent from the request body entirely — see D2 item 1 for why this, and only this, is the fast-path condition),
**then** the response is `200` with `{ data: { users: [ { userId, displayName, orgRole: "owner", status: "active", projects: [] }, { userId, displayName, orgRole: "admin", status: "active", projects: [] }, { userId, displayName, orgRole: "member", status: "active", projects: [{ projectId, projectName, role, grantedAt }, { projectId, projectName, role, grantedAt }] } ], generatedAt, asOf, page: 1, limit: 20, total: 3, hasNext: false } }`; `generatedAt` is the request time, `asOf` echoes the resolved (current) timestamp used. The `users` array is sorted `userId ASC` (D2 — deterministic across both paths).

**Edge case — org with only the initial owner, zero other members:** **given** a freshly created org, **when** the owner requests the report, **then** the response contains exactly one user (the owner) with `projects: []` — an org with no other members is a valid, non-error state, not a `404` or empty-report error.

**Edge case — an explicit `asOf` equal to the current instant is NOT the fast path:** **given** the same org, **when** the owner calls the endpoint with `{ asOf: "<the current ISO timestamp>" }` (a client-computed "now"), **then** the request takes the **historical/replay** path (AC-2), not the fast path — the fast path applies only when `asOf` is omitted from the request, never based on comparing a supplied value to the current instant (resolves the previously-undefined fast/historical boundary).

### AC-2: Access Report — Happy Path, `asOf` in the Past (Event-Replay Reconstruction)

**Given** an org where: user A was granted `member` role on project P on 2026-01-01 (`project.invitation_accepted`), promoted to `admin` role on project P on 2026-03-01 (`project.member_role_changed`), and fully removed from the org on 2026-05-01 (`org.user_removed`, which hard-deletes their `org_memberships`/`project_memberships` rows per D2),
**when** the owner calls the endpoint with `{ asOf: "2026-04-01T00:00:00Z" }`,
**then** user A **appears** in the report with `orgRole` as it was at grant time, `projects: [{ projectId: P, role: "admin", grantedAt: "2026-03-01T..." }]` — reconstructed entirely from `audit_log_entries`, even though user A's current-state rows in `org_memberships`/`project_memberships` no longer exist. **Scope of "historically accurate" (resolves finding-2):** this guarantee covers **access grants and roles only** — who had access, and with what role, as of `asOf`. It does **not** extend to `displayName`/PII, which is always resolved from the current-state `user_identity_tokens` row regardless of `asOf` (D4) — see the new edge case below and AC-8.

**Edge case — `asOf` between grant and promotion:** **given** the same history, **when** `asOf: "2026-02-01T00:00:00Z"`, **then** user A appears with `projects: [{ projectId: P, role: "member", ... }]` (pre-promotion state) — confirms the replay picks the latest event **at or before** `asOf`, not the latest event overall.

**Edge case — `asOf` after removal:** **given** the same history, **when** `asOf: "2026-06-01T00:00:00Z"`, **then** user A does **not** appear in the report at all — matching what a report generated on that date would have shown *for access/roles*, even though this is a retroactive query made after the fact.

**Edge case — historical `asOf` generated immediately after a pseudonymize call (resolves finding-2's critical gap):** **given** user A's history above, and **given** user A is pseudonymized (AC-17) at time T2 (after 2026-05-01's removal is irrelevant here — use a still-active user B instead, granted access on 2026-01-01 and never removed), **when**, immediately after pseudonymizing user B at T2, the owner requests a historical report for `{ asOf: "2026-01-15T00:00:00Z" }` (a date before T2, when user B's real name was actually in effect), **then** the report shows user B's **pseudonymized alias**, not their real historical display name — confirming that PII resolution is always current-state, even for a past `asOf`, and that this is intentional (D4), not a bug. A code comment at the test site cites this AC and D4.

### AC-3: Access Report — CSV Export Format

**Given** the same org as AC-1,
**when** the owner calls `POST /api/v1/org/audit/access-report` with `{ format: "csv" }`,
**then** the response `Content-Type` is `text/csv` and the body contains a header row `user_id,display_name,org_role,status,project_id,project_role,granted_at` followed by one data row per (user × project) pair, plus one row per user with zero project memberships (`project_id`/`project_role`/`granted_at` empty), RFC 4180 quoted via 8.2's `toCsvRow()` (D1/Architecture Conflict Resolution table).

**Defensive-coding test, not a current-functionality regression guard (resolves finding-17 — reworded framing/label, behavior unchanged):** **given** a user whose `user_identity_tokens.displayName` is `Chen, Alice "AC"` (this exact value is **not reachable by any display name the shipped system currently produces** — today's `displayName` is either email-derived at registration or a machine-generated `user_<8chars>` pseudonymization alias, neither of which can contain a comma or a quote character; this scenario exists to defend against a **future** profile-name feature that would let a user set an arbitrary display name), **when** the CSV row is built, **then** the field renders as `"Chen, Alice ""AC"""` — identical quoting behavior to 8.2's own `toCsvRow()` unit tests, confirming this story's reuse is byte-compatible, not a re-implementation. This test is kept (defensive coverage of `toCsvRow()`'s reuse is cheap and worth having) but is explicitly **not** asserting a regression against any display name this story's own code paths can currently produce.

### AC-4: Access Report — Pagination

**Given** an org with 45 users,
**when** the owner calls the endpoint with `{ page: 2, limit: 20 }`,
**then** the response contains users 21-40 **sorted by `userId ASC`** (D2's deterministic ordering, applied identically to both the fast and historical paths — resolves finding-9's unspecified sort-key gap), `total: 45`, `hasNext: true`; requesting `{ page: 3, limit: 20 }` returns users 41-45 in the same stable order, `hasNext: false`; the same 45-user set paginated twice in a row (fast path) or reconstructed via replay twice in a row (historical path) returns byte-identical page contents both times.

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

**Edge case — the two activity touches fail independently (resolves finding-11):** **given** a simulated DB error inside `touchOrgMembershipActivity()` **only** (`touchSessionActivity()` succeeds normally), **when** an authenticated request is made, **then** `sessions.lastActiveAt` **is still updated** (the `org_memberships.lastActiveAt` failure does not suppress it) and the request still succeeds; symmetrically, **given** a simulated DB error inside `touchSessionActivity()` only, **when** an authenticated request is made, **then** `org_memberships.lastActiveAt` **is still updated**. This confirms the two touches are wrapped in independent `try/catch` blocks (D3), not one shared block where an earlier failure could silently prevent the later touch from running.

### AC-10: Dormancy — Daily Job Happy Path

**Given** an org with `userDormancyThresholdDays = 90` and a user whose `org_memberships.lastActiveAt` is 95 days old,
**when** the daily `user:dormancy-check` pg-boss job runs (cron `0 9 * * *`, mirroring `machine-key:dormancy-check`'s cadence exactly),
**then** a `security_alerts` row is inserted: `{ orgId, alertType: 'user.dormant', severity: 'warning', payload: { userId, displayName, orgRole, lastActiveAt }, status: 'PENDING_DELIVERY' }`, and a notification is queued to the org's routing-resolved recipients (default `owner` **and** `admin`, D12).

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
**then** it routes to **both** the org's `owner`-role and `admin`-role members by default (revised per D12 — resolves finding-16's FR71-vs-epics.md conflict in favor of FR71's broader "Organization Admins" wording), via a small alert-type-scoped extension to the routing resolution (D12's implementation note) — not a change to any other alert type's default.

**Edge case — org has configured `user.dormant` routing to `owner` only:** **given** an org admin has configured per-alert-type routing (existing FR100 mechanism) to route `user.dormant` to `owner` explicitly, **when** the alert is queued, **then** it routes to `owner`-role members only — confirming an org can opt back into the epics.md AC's narrower default if it prefers, and that an explicit override always takes precedence over the broadened default.

**Edge case — org has configured `user.dormant` routing to `admin`:** **given** an org admin has configured per-alert-type routing to route `user.dormant` to `admin` explicitly, **when** the alert is queued, **then** it routes to `admin`-role members only (not also `owner`) — confirming an explicit single-role override is honored exactly as today, and the owner+admin union applies only to the unconfigured default case, not to explicit overrides.

---

### AC-17: Pseudonymize — Happy Path

**Given** an owner and a target user who is a member of the owner's org and has never been pseudonymized,
**when** the owner calls `POST /api/v1/org/users/:userId/pseudonymize` with `{ confirmUserId: "<the target userId>" }` (the required re-confirmation input — see AC-17a),
**then** every `user_identity_tokens` row for that `userId` (not just the "first created" one used for new audit writes — D8/AC-19) has `displayName` replaced with `user_<8 random alphanumeric chars>` and `pseudonymizedAt` set to the current time; the response is `200 { data: { userId, pseudonymized: true, pseudonymizedAt, alias, otherAffectedOrgCount } }`.

**Edge case — user has multiple `user_identity_tokens` rows:** **given** a user who (for any historical reason) has two `user_identity_tokens` rows, **when** pseudonymized, **then** **both** rows are updated to the same alias — confirming the endpoint does not silently leave a second, un-pseudonymized row that some older audit rows might still reference.

### AC-17a: Pseudonymize — Blast-Radius Disclosure and Explicit Re-Confirmation Required (resolves finding-5/finding-6)

**Given** a target user who belongs to 2 other orgs besides the caller's org,
**when** the owner calls `POST /api/v1/org/users/:userId/pseudonymize` with a body that omits `confirmUserId` (or sets it to a value other than the exact target `userId`),
**then** the response is `422 { code: "confirmation_required", message: "confirmUserId must match the target user to confirm this irreversible action" }` and **no mutation occurs** — the blast-radius lookup (D9) still runs first so the count can be surfaced, but the confirmation check gates the actual `UPDATE`.

**Edge case — successful call surfaces the blast radius:** **given** the same target user (2 other orgs) and a correctly-set `confirmUserId`, **when** the pseudonymize call succeeds, **then** the response includes `otherAffectedOrgCount: 2` (AC-17), so the calling owner is explicitly informed, at the moment of the irreversible action, that this change will also affect 2 other orgs' historical reports/exports — not left to discover this later via D9/AC-22.

**Edge case — target user belongs only to the caller's org:** **given** a target user with no other org memberships, **when** pseudonymized (with correct `confirmUserId`), **then** `otherAffectedOrgCount: 0` — the confirmation input is still required regardless of blast radius (the action is irreversible even for a single-org user), but the response makes clear no cross-org effect occurred.

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
**then** an `audit_log_entries` row is written with a new `AuditEvent.USER_PSEUDONYMIZED` (`'user.pseudonymized'`) constant (added to `packages/shared/src/constants/audit-events.ts`), `payload: { targetUserId, tokensPseudonymized: <count>, otherAffectedOrgCount: <count>, otherAffectedOrgIds: [<org id>, ...] }` (extended from the original `{ targetUserId, tokensPseudonymized }` shape — resolves finding-5/6/15's gap: the audit record now captures the D9 cross-org blast radius, not just the target and row count) — **no PII (old display name, email) in the payload**, only org IDs and counts, since `secure-route.ts`'s `FORBIDDEN_AUDIT_KEYS` sanitization does not automatically apply to manual `writeHumanAuditEntryOrFailClosed` calls (this story must exclude PII deliberately, not rely on automatic stripping).

**Edge case — re-pseudonymization (no-op case, AC-18) is still audited:** **given** a second pseudonymize call on an already-pseudonymized user, **when** the request completes, **then** a `user.pseudonymized` audit row is **still** written (with `payload.tokensPseudonymized: 0` to reflect that no row actually changed, and `otherAffectedOrgCount`/`otherAffectedOrgIds` still populated from the current blast-radius lookup) — the action of *calling* pseudonymize on this user is itself an auditable compliance-relevant event, independent of whether it changed anything.

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
**then** each route has an explicit classification entry in `apps/api/src/lib/route-exemptions.ts` (`action: 'mutation'` for the settings/pseudonymize routes; `action: 'sensitive-read'` for the access-report route) — no bare, unclassified route reaches `main`.

**Rationale for `POST /audit/access-report`'s `sensitive-read` classification (resolves finding-13's ambiguity):** this route is a `POST`, and it performs a mandatory `audit_log_entries` INSERT on every successful call (AC-7) — at first glance it could look like it belongs in `mutation` (since it writes) or plain `read` (since its primary purpose is reading data). The correct bucket is `sensitive-read`, confirmed by the two existing precedents in `route-exemptions.ts` that share this exact profile — a read of sensitive/compliance data that has a same-transaction audit write as a side effect, not a state-mutating action on the resource itself: `GET /api/v1/projects/:projectId/credentials/:credentialId/value` (`route-exemptions.ts:307-311`, `action: 'sensitive-read'`, `auditEvent: 'credential.value_revealed'`, `sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed'`) and `GET /api/v1/machine/projects/:projectId/credentials/:name/value` (`route-exemptions.ts:749-754`, same classification). `sensitive-read` is defined by *what the route does to the resource* (reads it, and that read is itself the sensitive/auditable event) — not by HTTP method; this route uses `POST` only because the request needs a body (`asOf`/`page`/`limit`/`format`), the same reason 8.2's search endpoint is a `POST` despite being conceptually a read. `action: 'sensitive-read'` with `auditEvent: 'audit.access_report_generated'` and `sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed'` (or the route's `secureRoute`-managed writer) is therefore the correct, precedented entry.

### AC-28: Full Integration Test Matrix

**Given** this story's complete scope,
**when** the full test suite runs,
**then** it covers, at minimum: access-report happy path (`asOf` omitted vs. explicit-and-equal-to-now, AC-1), historical replay (including the founding-owner-visible-via-`user.registered` case and the pseudonymize-then-historical-`asOf` case, AC-2), CSV format (including the defensive future-profile-name case, AC-3), pagination with deterministic `userId ASC` ordering (AC-4), all validation sub-cases, owner-only + cross-org isolation, own-call audit write, pseudonymization-reflected display name; dormancy job happy path, dedup, threshold configuration + validation, never-active fallback, deactivated-user exclusion, dismiss (reusing existing endpoint's tests, extended to this alert type), deactivate (reusing existing endpoint's tests), routing default (owner+admin union) + explicit override (AC-16); pseudonymize happy path including the blast-radius confirmation gate (AC-17a), idempotent no-op (including the direct-DB-trigger assertion), the internal-callability test with no `SecureRouteContext` (Task 6.6, forward dependency to Story 8.4), HMAC-integrity-preserved verification, authorization + tenant isolation, own-action audit write including cross-org blast-radius fields (including the no-op-still-audited case), cross-org bleed; the two activity-touch functions' independent fail-open behavior (AC-9); backfill check clean + dirty + machine-user-non-issue cases; FR102 search confirmation; migration/RLS/route-audit CI guards.

---

## Tasks / Subtasks

- [ ] Task 1: Fix `org_memberships.lastActiveAt` write path (AC: 9)
  - [ ] 1.1 Add `touchOrgMembershipActivity(orgId, userId)` to `apps/api/src/modules/auth/session-activity.ts`, own debounce map keyed `${orgId}:${userId}`, reusing `env.SESSION_ACTIVITY_DEBOUNCE_SECONDS`
  - [ ] 1.2 Call it from `apps/api/src/plugins/authenticate.ts`'s `touchActivityWithoutBlocking` (line ~142-151), alongside `touchSessionActivity` — **in its own, separate `try/catch` block, not folded into the existing one** (D3/finding-11), so a failure in either touch cannot suppress the other; each catch logs its own distinct `warn`-level event
  - [ ] 1.3 Unit test: activity touch updates `org_memberships.lastActiveAt`; debounce prevents redundant writes within the window; a thrown error inside the touch does not fail the request; a thrown error inside *either* touch does not prevent the *other* touch from succeeding (AC-9's independence edge case)
- [ ] Task 2: Migration — dormancy threshold column + dedup index (AC: 12, 26)
  - [ ] 2.1 Confirm next-free migration index against `packages/db/src/migrations/meta/_journal.json` at implementation time (D5) — do not hardcode
  - [ ] 2.2 Add `userDormancyThresholdDays` to `packages/db/src/schema/organizations.ts` (mirrors `machineKeyDormancyThresholdDays` exactly, including the CHECK constraint)
  - [ ] 2.3 Add `idx_security_alerts_dormant_user` partial unique index to `packages/db/src/schema/security-alerts.ts` (mirrors `idx_security_alerts_dormant_key`)
  - [ ] 2.4 Generate and review the Drizzle migration SQL; confirm it matches the hand-written style of `0032_machine_key_rotation_dormancy_cacheable.sql`
- [ ] Task 3: Dormant-user detection job (AC: 10, 11, 13, 16)
  - [ ] 3.1 Create `apps/api/src/workers/user-dormancy-check.ts` (`runUserDormancyCheckJob`), structural copy of `machine-key-dormancy-check.ts`: `fetchAllOrgIds()` → `runOrgScopedJob()` per org → query `org_memberships` (status='active', lastActiveAt/createdAt threshold OR-logic per AC-13) → `INSERT ... ON CONFLICT DO NOTHING` against the new partial index → `createOrgAdminNotificationEntries` + `sendNotificationJobs`. **Per D12/AC-16 (finding-16 fix):** when no `org_notification_routing` override exists for `user.dormant`, resolve recipients as the union of `getMembersWithRole(orgId, 'owner', tx)` and `getMembersWithRole(orgId, 'admin', tx)` (deduplicated by `userId`) instead of the single-role default every other alert type uses; if an explicit override exists, honor it unchanged (single role, no union).
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
- [ ] Task 6: Pseudonymize endpoint (AC: 17, 17a, 18, 19, 20, 21, 22)
  - [ ] 6.1 Create `apps/api/src/modules/org/pseudonymize.ts` exporting a function callable both from the HTTP route and (per Epic Cross-Story Context, forward dependency to Story 8.4) internally within another transaction, **taking a plain `tx` and the already-validated target/actor IDs as parameters — no dependency on `SecureRouteContext`/`ctx.auth`** — return `{ alias, pseudonymizedAt, tokensPseudonymized, otherAffectedOrgCount, otherAffectedOrgIds }`
  - [ ] 6.2 Implement the no-op-on-already-pseudonymized behavior (D8) — check `pseudonymizedAt IS NOT NULL` **before** attempting any `UPDATE`, do not rely on catching the trigger's exception as control flow
  - [ ] 6.3 Implement the blast-radius lookup (D9/AC-17a): `SELECT DISTINCT org_id FROM org_memberships WHERE user_id = :targetUserId AND org_id != :callerOrgId`, run before the confirmation check so the count is available even on the rejection path
  - [ ] 6.4 Add `PseudonymizeBodySchema` (`{ confirmUserId: string }`) and `PseudonymizeResponseSchema` to `apps/api/src/modules/org/schema.ts`; register `POST /users/:userId/pseudonymize` in `apps/api/src/modules/org/routes.ts`, `allowedRoles: ['owner']`, `requireMfa: true`, rate limit `20/60s` (matches deactivate's sensitivity tier); validate `confirmUserId === params.userId` (422 `confirmation_required` otherwise, AC-17a) **before** invoking the pseudonymize function; manual audit write with `AuditEvent.USER_PSEUDONYMIZED`, payload excluding PII but including `otherAffectedOrgCount`/`otherAffectedOrgIds` (AC-21)
  - [ ] 6.5 Add `AuditEvent.USER_PSEUDONYMIZED = 'user.pseudonymized'` to `packages/shared/src/constants/audit-events.ts`
  - [ ] 6.6 Integration tests: `pseudonymize.test.ts` covering AC-17 through AC-22, including the direct-DB-trigger assertion (AC-18's edge case), the `withTwoTestOrgs()` cross-org-bleed assertion (AC-22), and the AC-17a confirmation-gate cases
  - [ ] 6.7 **Internal-callability test (resolves finding-7's coverage gap):** a dedicated test that calls the Task 6.1 function directly — inside an already-open transaction, passing only a `tx` and plain IDs, **without constructing a `SecureRouteContext` or any `ctx.auth`** — and asserts it pseudonymizes correctly and returns the same `{ alias, pseudonymizedAt, tokensPseudonymized, otherAffectedOrgCount, otherAffectedOrgIds }` shape as the HTTP path. This exercises the exact interface Task 6.1 promises to Story 8.4 (which will call this function from within its own erasure-flow transaction, not via HTTP), closing the gap where that stated interface requirement previously had zero corresponding test coverage.
- [ ] Task 7: Backfill check re-run and FR102 confirmation (AC: 23, 24, 25)
  - [ ] 7.1 Add an integration test in this story's own suite invoking `checkAuditActorTokenCoverage()` (from Story 8.1) against a seeded dataset including this story's new event types — clean case
  - [ ] 7.2 Add the dirty-case test (rolled-back transaction fixture, per 8.1's own AC-14 isolation requirement) and the machine-user-non-issue test (D11)
  - [ ] 7.3 Add an integration test confirming `GET /audit/events?eventType=...` (from Story 8.2) returns 4.3's existing deactivation/recovery event rows — no production code change, confirmation only
- [ ] Task 8: CI guards and OpenAPI (AC: 26, 27, 28)
  - [ ] 8.1 Confirm `check-rls-coverage.test.ts` passes unchanged (no new table)
  - [ ] 8.2 Add route-exemptions classification entries for all three new routes
  - [ ] 8.3 Run `pnpm generate-spec`; confirm all three new endpoints appear in `packages/shared/openapi.json`
  - [ ] 8.4 Run `make ci` end-to-end
  - [ ] 8.5 **Follow-up reminder, not a completion gate for this story (resolves finding-14):** raise the Epic 8 dedicated-UI-story gap (access-report table, dormant-alert admin actions, 8.2 search/export) at the next Epic 8 sprint planning session. This is tracked as a cross-team process action item; it does **not** block this story's own `done` status, and this story's implementation, tests, and sign-off proceed independently of whether/when that sprint-planning conversation happens.

---

## Dev Notes

- **Do not start implementation until Story 8.1 and Story 8.2 are both `done`** (D7/Prerequisites). This story file can be reviewed and refined now, but `checkAuditActorTokenCoverage()`, `toCsvRow()`, `apps/api/src/modules/audit/routes.ts`, and `GET /audit/events` are all hard dependencies that do not exist in code yet.
- **The single biggest correctness risk in this story is treating the access report as a simple current-state query.** Re-read D2 before starting Task 5: `org_memberships`/`project_memberships` rows are hard-deleted on removal (`removeUserFromOrgMemberships`), so any `asOf` that isn't "now" *must* go through audit-event replay, or removed users will silently and incorrectly vanish from historical reports.
- **The second-biggest risk is reusing `listOrgUsers()`'s `displayName` convention.** It derives from `users.email`, which is correct for the existing 4.2 user-management screen but wrong for this story's access report and CSV export — both must resolve `displayName` via `user_identity_tokens` (D4), or pseudonymization becomes silently ineffective for this story's own primary compliance artifact.
- **Do not attempt to make AC-E8d's "new alias on re-pseudonymization" literally true.** The `prevent_pseudonym_reversal()` trigger (`0001_rls_and_triggers.sql:72-87`) will reject it at the database level. Implement the no-op interpretation (D8) and write the test that proves the trigger itself blocks the naive approach, so a future reader understands *why* re-pseudonymization is a no-op rather than assuming it's an oversight.
- **`user_identity_tokens` is platform-level, not org-scoped** (`user-identity-tokens.ts:4`). A user can have exactly one row per registration but can belong to `(org, user)` memberships in multiple orgs sharing that one row. Pseudonymization is therefore inherently cross-org in its effect — this is D9's accepted trade-off, not a bug to chase down.
- **`FORBIDDEN_AUDIT_KEYS` sanitization (`secure-route.ts`) only applies to the default `SecureRoute` audit writer, not manual `writeHumanAuditEntryOrFailClosed` calls.** Every manual audit payload this story writes (dormancy job, pseudonymize) must be reviewed by hand for PII before merging — do not assume automatic stripping protects you. This includes the new `otherAffectedOrgCount`/`otherAffectedOrgIds` fields (D9/AC-21): org IDs are not PII and are fine to include, but resist the temptation to also log the other orgs' names or any member info while you're in there.
- **Pseudonymization's blast-radius confirmation (AC-17a) must reject before mutating, not after.** Run the `confirmUserId` check before calling into `pseudonymize.ts`'s core logic (Task 6.1) — the blast-radius lookup (Task 6.3) may run first (its count is needed either way), but no `UPDATE` may occur until the confirmation check passes.
- **Reuse, don't duplicate, the dismiss endpoint.** It is tempting to write a `user.dormant`-specific dismiss route; resist this. The existing generic endpoint (D6) already handles it — this story's only touch point is a payload-schema registration.
- **Reuse, don't duplicate, the deactivate endpoint.** Same principle — Story 4.3's `POST /users/:userId/deactivate` is complete and correct; this story's job is to *lead an admin to it* (conceptually, via the dormancy alert), not reimplement any part of it.
- **`checkActiveRotationsForUser()`'s permanent stub (`deactivation.ts:18-24`) is explicitly out of this story's scope** (AC-25's edge case) — do not "helpfully" fix it while touching adjacent deactivation-related code; that is separate, differently-scoped debt.
- This story adds exactly **one** migration. If Task 2 seems to require more, stop and re-read D1/D5 — every other table this story touches already has every column it needs.

### Project Structure Notes

- New files: `apps/api/src/workers/user-dormancy-check.ts` (+ `.test.ts`), `apps/api/src/modules/audit/access-report.ts` (+ `.test.ts`), `apps/api/src/modules/audit/access-report-schema.ts`, `apps/api/src/modules/org/pseudonymize.ts` (+ `.test.ts`).
- Modified files: `packages/db/src/schema/organizations.ts` (new column), `packages/db/src/schema/security-alerts.ts` (new index), `packages/db/src/migrations/` (one new migration, number TBD per D5), `apps/api/src/modules/auth/session-activity.ts` (new function), `apps/api/src/plugins/authenticate.ts` (new call site, independent try/catch per D3/finding-11), `apps/api/src/main.ts` (new job registration), `apps/api/src/modules/org/organization-settings-routes.ts` + `-schema.ts` (new route), `apps/api/src/modules/org/routes.ts` (new pseudonymize route), `apps/api/src/modules/org/schema.ts` (new dormancy payload schema + new `PseudonymizeBodySchema`/`ResponseSchema`), `apps/api/src/modules/org/security-alerts.ts` (new payload-schema registration), `apps/api/src/modules/notifications/routing.ts` (small alert-type-scoped default-recipient-set extension for `user.dormant`, per D12/finding-16), `apps/api/src/modules/audit/routes.ts` (extend — created by Story 8.1, not this story), `apps/api/src/lib/route-exemptions.ts` (3 new classification entries), `packages/shared/src/constants/audit-events.ts` (2 new constants).
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
- [Source: `apps/api/src/modules/auth/service.ts` line 385, and lines 280-409 (`insertRegistrationMemberships`, `registerUser`, `insertAuditEntry`)] — `user_identity_tokens.displayName` initialized to email at registration; confirmed `USER_REGISTERED`-vs-`PROJECT_INVITATION_ACCEPTED` event branching and payload shapes behind D2's founding-owner replay fix (finding-1) and the registration-flow invitation-accept payload shape (finding-3).
- [Source: `apps/api/src/modules/invitations/token-routes.ts` lines 120-211] — confirmed `project.invitation_accepted` payload/`resourceId` shape for the existing-user-accepts-invitation path (D2, finding-3).
- [Source: `apps/api/src/modules/projects/routes.ts` lines 660-704, 720-814] — confirmed `project.member_removed` and `project.ownership_transferred` payload/`resourceId` shapes (D2, finding-4).
- [Source: `apps/api/src/modules/org/routes.ts` lines 260-303, 480-539, 600-657] — confirmed `org.user_deactivated`, `org.user_removed`, `project.member_role_changed` payload/`resourceId` shapes (D2).
- [Source: `packages/db/src/schema/project-invitations.ts`, `packages/db/src/schema/audit-log-entries.ts`] — confirmed `project_invitations` rows are never hard-deleted (D2's role-resolution join, finding-3) and the existing `idx_audit_log_entries_org_created` composite index covers the replay access pattern (D2, finding-10).
- [Source: `apps/api/src/lib/route-exemptions.ts` lines 307-311, 749-754] — confirmed `sensitive-read` precedent for a read-with-mandatory-audit-write route (AC-27, finding-13).
- [Source: `apps/api/src/modules/notifications/routing.ts`, `packages/shared/src/constants/notification-types.ts` line 37] — confirmed `resolveRoutingRecipients()`'s single-role, exact-match resolution and the shared `DEFAULT_ROUTING_ROLE` constant, behind D12's targeted owner+admin union for `user.dormant` (finding-16).
- [Source: `apps/api/src/plugins/authenticate.ts` lines 142-151] — confirmed `touchActivityWithoutBlocking`'s current single `try/catch` shape, behind D3's independent-try/catch fix (finding-11).
- [Source: `packages/db/src/schema/user-identity-tokens.ts`] — confirmed `user_identity_tokens` is keyed by nullable `userId`, behind D9's blast-radius lookup query (finding-5/6).
- [Source: `packages/shared/src/constants/audit-events.ts`] — existing event catalog this story adds two entries to.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
