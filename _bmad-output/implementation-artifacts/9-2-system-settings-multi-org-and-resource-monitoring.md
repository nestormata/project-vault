# Story 9.2: System Settings, Multi-Org & Resource Monitoring

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-06 — comprehensive developer guide for the second story of Epic 9 (Platform Operations, API & Self-Hosting): a runtime-configurable system settings API/store (SMTP, backup defaults, notification defaults, instance policy), platform-operator-driven multi-organization provisioning, resource-usage visibility against operator-configured instance limits, audit-log storage capacity monitoring with a maintenance-mode circuit breaker, and master-key custody risk alerting. This story is the SECOND story in Epic 9 and has a HARD PREREQUISITE on Story 9.1 landing first (or at minimum its schema/primitives being merged) — it reuses 9.1's `users.is_platform_operator` flag, `requirePlatformOperator()` preHandler, and `admin_alerts` table verbatim rather than reinventing them. As of this story's creation, Story 9.1 is `ready-for-dev`, not `done` — none of those primitives exist in the codebase yet. Read "Key Design Decisions & Open Questions" before writing any code — it resolves several genuine contradictions between epics.md's literal wording (written before Story 9.1 had concrete schema, and before any Epic 9 story had audited the actual Epic 1-8 codebase) and what has actually shipped. Getting D1 wrong means this story is unimplementable until 9.1 ships. Getting D2 wrong creates a privilege-escalation bug (an org admin able to hit instance-wide settings endpoints). Getting D5 wrong means `pg_total_relation_size` is queried against a table name (`audit_events`) that has never existed in this codebase. -->

## Story

As a **platform operator managing a self-hosted Project Vault instance**,
I want **a system settings UI/API for SMTP and notification configuration, the ability to provision additional organizations on the same instance, visibility into resource usage against instance-configured limits, and proactive alerting on audit-log storage pressure and master-key custody risk**,
so that **I can operate and scale the vault without direct database access, and get early warning before capacity or key-custody problems become incidents**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints only (`GET`/`PUT /api/v1/admin/settings`, `POST`/`GET /api/v1/admin/orgs`, `GET /api/v1/admin/resource-usage`) plus two background jobs (audit-storage monitor, key-custody check). There is no web screen in this story. FR86's literal text ("through the product UI") is **not satisfiable** by this story alone — see D9. |
| **Linked UI story** (if API-only) | `TBD` — **no story in `epics.md` (Epic 9's five stories, or any other epic) scopes a system-settings/multi-org/resource-usage admin web screen.** This is the same accepted-gap pattern Story 9.1 already flagged for backup/restore (Product Surface Contract G1); raise it again at Epic 9 sprint planning/retrospective before Epic 9 can reach `done` (G2). A future UI story should minimally surface: (a) a "System Settings" admin page (SMTP form with masked password, backup schedule display, instance policy fields), (b) an "Organizations" admin page (list + "create organization" form), (c) a "Resource Usage" dashboard (progress bars per limit with 80/90/95% color bands), and (d) an alert banner reading `admin_alerts` for `key_custody_risk`/`audit_storage_*`/`resource.*` conditions. |
| **Honest placeholder AC** (if UI deferred) | N/A — no SvelteKit route is stubbed in this story (a dead route with no linked follow-up story is worse than no route), matching Story 9.1's precedent exactly. |
| **Persona journey** | N/A — API-only; the "persona" is the platform operator running curl/scripts (or, later, the deferred UI) against the documented endpoints; see AC-1 through AC-30 for the exact request/response contracts they depend on. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** This story sits on top of several primitives Story 9.1 introduces but that do not exist in the codebase yet, plus it surfaces a genuine naming collision, a genuine table-name mismatch between `epics.md` and the shipped schema, and a genuine gap in the master-key lifecycle. Getting these wrong produces code that looks plausible but is either unimplementable (D1), insecure (D2), or silently monitors the wrong table (D5).

### D1 — Hard prerequisite on Story 9.1's platform-operator primitives (sequencing, not re-invention)

Story 9.2's own epics.md AC text opens with "**Given** the platform operator account exists (bootstrapped at vault init)" — this refers to Story 9.1's D1 resolution (`users.is_platform_operator`, bootstrapped on first registration), not anything Story 1.5/1.6 shipped on their own. As of this story's creation, `packages/db/src/schema/users.ts` has no `is_platform_operator` column, `apps/api/src/plugins/require-org-role.ts`'s sibling `requirePlatformOperator()` does not exist, and `packages/db/src/schema/admin-alerts.ts` does not exist.

**Resolution:** This story assumes Story 9.1 has landed (or is landing in the same PR sequence) and its primitives are available for reuse exactly as documented in `_bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md`'s D1/D3:
- `authContext.isPlatformOperator: boolean` on every request (populated from `users.is_platform_operator` at JWT-verification time).
- `requirePlatformOperator()` preHandler (`apps/api/src/plugins/require-org-role.ts` or sibling file).
- `admin_alerts` table (platform-level, `EXCLUDED_TABLES`-excluded, `alertType`/`severity`/`payload`/`status` shape) — this story's `key_custody_risk` and `resource.*`/`audit_storage.*` alerts are new rows in that **same** table, not a second competing platform-alert table (9.1's D3 explicitly reserves this).
- `SecureRoute`'s `requireOrgScope: false` opt-out flag (already present in `SecureRouteOptions.security` as of this story's creation — confirmed in `apps/api/src/lib/secure-route.ts`).

If a dev agent picks up this story before Story 9.1 has merged, **implement Story 9.1's Task 1 and Task 2 first** (platform-operator column/preHandler/AuthContext wiring and the `admin_alerts`/`backup_runs` migration) as a shared-foundation commit, then proceed with this story's own tasks — do not fork a second, incompatible platform-operator mechanism.

### D2 — `/api/v1/admin/*` naming collision: existing routes under this prefix are **org-scoped**, not platform-operator-scoped

`apps/api/src/modules/admin/routes.ts` already registers `POST /api/v1/admin/notifications/test` under `security: { allowedRoles: ['owner', 'admin'] }` — i.e. **org**-admin, gated by `requireOrgRole`/`allowedRoles`, fully org-scoped (`requireOrgScope` defaults to `true`). This story's new routes (`GET`/`PUT /admin/settings`, `POST`/`GET /admin/orgs`, `GET /admin/resource-usage`) are **instance-wide**, gated by `requirePlatformOperator()` with `requireOrgScope: false` (D1). Both route families share the `/api/v1/admin/` URL prefix but have **completely different, non-interchangeable authorization semantics** — a dev agent pattern-matching on "there's already an admin module, I'll copy its `security` block" produces a privilege-escalation bug: any org Owner/Admin (not just the platform operator) would be able to read/write instance-wide SMTP credentials, create organizations, and see cross-org resource usage.

**Resolution:**
1. Register this story's routes in a **new** module, `apps/api/src/modules/platform-admin/` (`settings-routes.ts`, `orgs-routes.ts`, `resource-usage-routes.ts`, `schema.ts`, `service.ts`) — do **not** add them to the existing `apps/api/src/modules/admin/` module, to keep the org-scoped and platform-scoped route families physically separate and reduce the chance of copy-paste privilege escalation.
2. Every new route in this story uses `security: { requireOrgScope: false, requireMfa: true }` plus the `requirePlatformOperator()` preHandler — **never** `allowedRoles`/`requireOrgRole` for these endpoints. **`requireMfa: true` is mandatory, not optional**: these routes are more sensitive than the existing org-scoped `POST /api/v1/admin/notifications/test`, which already requires MFA (`apps/api/src/modules/admin/routes.ts`) — shipping instance-wide SMTP-credential/org-provisioning endpoints with *weaker* auth than an existing lower-stakes endpoint would be a security regression, not a neutral omission. (This diverges from Story 9.1's backup routes only if those routes themselves lack `requireMfa` — if so, flag that as a gap in 9.1, not a precedent to copy here.)
3. Add a route-audit regression test (extends `apps/api/src/__tests__/route-audit.test.ts`'s existing style, or a new sibling `platform-admin-route-audit.test.ts`) asserting: every route whose URL matches `/^\/api\/v1\/admin\//` and lives in `modules/platform-admin/` has `requireOrgScope: false`, `requireMfa: true`, and no `allowedRoles` entry — and every route in `modules/admin/` (the pre-existing org-scoped module) is unaffected. This test is the load-bearing guard against a future refactor accidentally merging the two families or dropping the MFA requirement.
4. Document the distinction in a comment at the top of `modules/platform-admin/settings-routes.ts`: `// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/ (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).`

### D3 — System settings persistence: a new singleton `system_settings` table, env vars remain the fallback default (resolves deferred-work.md E3-1)

Today, SMTP configuration (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_SECURE`) is **entirely env-var-driven** (`apps/api/src/config/env.ts` lines ~480-501, consumed by `apps/api/src/workers/notification-email.ts`'s `getEmailTransport()`). `deferred-work.md`'s retro action item **E3-1** already closed this exact question: *"env-var SMTP config is the MVP path (Story 3.1 AC); Epic 9 (FR86) adds an admin system-settings UI on top without breaking the env-var fallback."* This story is that "admin system-settings" layer.

**Resolution:**
1. New platform-level (non-org-scoped, `EXCLUDED_TABLES`-excluded, `vault_state`-style singleton — `id smallint PRIMARY KEY DEFAULT 1` + `CHECK (id = 1)`) table `system_settings`:
   ```typescript
   // packages/db/src/schema/system-settings.ts
   export const systemSettings = pgTable('system_settings', {
     id: smallint('id').primaryKey().default(sql`1`),
     smtpHost: text('smtp_host'),
     smtpPort: integer('smtp_port'),
     smtpSecure: boolean('smtp_secure'),
     smtpUser: text('smtp_user'),
     smtpPassEncrypted: jsonb('smtp_pass_encrypted'), // EncryptedValue shape (D4) or NULL
     smtpFrom: text('smtp_from'),
     backupScheduleOverride: text('backup_schedule_override'),
     backupRetentionCountOverride: integer('backup_retention_count_override'),
     defaultSlackWebhookUrl: text('default_slack_webhook_url'),
     maxOrgs: integer('max_orgs').notNull().default(10),
     maxUsersPerOrg: integer('max_users_per_org').notNull().default(50),
     sessionIdleTimeoutMinutesOverride: integer('session_idle_timeout_minutes_override'),
     updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
     updatedByUserId: uuid('updated_by_user_id'),
   }, (t) => [check('system_settings_single_row', sql`${t.id} = 1`)])
   ```
   A single row is upserted (`INSERT ... ON CONFLICT (id) DO UPDATE`) on first `PUT`; `GET` returns defaults (all-null / instance-default values) if the row does not exist yet — **never** 404 (matches AC-8's "list backups" empty-collection-is-200 discipline from Story 9.1).
2. **Precedence rule (must be implemented in one place, `resolveEffectiveSettings()` in `modules/platform-admin/service.ts`, and reused everywhere settings are consumed):** for each field, if the `system_settings` row has a non-null value, use it; otherwise fall back to the corresponding env var (or its hardcoded default). This is additive and backward-compatible — an instance that never calls `PUT /admin/settings` behaves byte-for-byte as it does today (E3-1's explicit requirement).
3. `instancePolicy.maxOrgs`/`maxUsersPerOrg`/`sessionIdleTimeoutMinutes` have **no** pre-existing env var equivalent (there is no existing instance-policy concept in the codebase at all — confirmed by grep: no `tier`/`subscription` concept exists anywhere in `packages/`/`apps/`, only `payment-records.ts`/`service-endpoints.ts` use the word "tier" in unrelated comments). These are genuinely new instance-level knobs this story introduces; sensible v1 defaults are `maxOrgs: 10`, `maxUsersPerOrg: 50`, `sessionIdleTimeoutMinutes` falling back to whatever the existing idle-session-timeout mechanism (FR85, Story 1.7) already uses as its default. **`maxOrgs` and `maxUsersPerOrg` are intentionally *not* symmetric in v1:** `maxOrgs` is hard-enforced (AC-10, 422 rejection on the Nth+1 org) because org creation is exclusively platform-operator-initiated through this story's own new endpoint, making enforcement a single, easy chokepoint. `maxUsersPerOrg` is **alert-only in v1** (AC-13) — it is *not* enforced as a hard cap on the Nth+1 user joining an org, because doing so would require adding a rejection path to every existing org-join mechanism (project-invitation acceptance, `token-routes.ts`; the new `POST /admin/orgs` existing-user path) rather than a single new endpoint, which is a larger scope change than this story's boundary. This is a deliberate, documented v1 scope decision, not an oversight — a platform operator configuring `maxUsersPerOrg` should be told explicitly (via its field description in `GET /admin/settings`'s response schema/OpenAPI doc, e.g. `"maxUsersPerOrg (advisory only in v1 — alerts at 80/90/95%, does not block new members)"`) that it is advisory, so as not to create a false expectation of a hard cap. Hard enforcement of `maxUsersPerOrg` is flagged as a follow-up in Open Questions below.
4. **Do not conflate "subscription tier" (PRD's SaaS-v2/rate-limiting language, `prd.md` "Limits vary by subscription tier" under API Architecture) with this story's `instancePolicy`.** Self-hosted v1 has no billing/subscription concept — `instancePolicy` is an **operator-configured instance limit**, not a purchased tier. `GET /admin/resource-usage`'s `{ limit }` fields report against `instancePolicy`, never against a SaaS tier table (which does not exist in v1).

### D4 — SMTP password: encrypted at rest, masked in responses, and the transport cache must be invalidated on update

`packages/crypto/src/aes.ts`'s `encrypt()`/`decrypt()` (AES-256-GCM, `EncryptedValue` shape) is the codebase's existing generic at-rest encryption primitive, already used for credential secret values via `getPrimaryKey()` (`apps/api/src/modules/credentials/import-service.ts`). Reuse this exact pattern for `system_settings.smtp_pass_encrypted` — do **not** introduce a new HKDF `info` string (unlike Story 9.1's backup key, which needed key-lifecycle independence from `primaryKey`); SMTP password is a general secret value, same trust tier as a stored credential.

**Resolution:**
1. `PUT /api/v1/admin/settings` encrypts `smtp.password` with `encrypt(Buffer.from(password), getPrimaryKey())` before storing; `GET /api/v1/admin/settings` **never** decrypts it for the response — it returns `configured: true`/`false` only (epics.md's literal `[configured]` placeholder, AC-2).
2. **Critical bug this story must not introduce:** `apps/api/src/workers/notification-email.ts`'s `getEmailTransport()` lazily creates `nodemailer.createTransport(...)` **once** and caches it in a module-level `_transport` variable forever (there is currently no non-test way to invalidate it — only `resetEmailTransportForTesting()` exists, gated to test code). If `PUT /admin/settings` updates SMTP config but nothing invalidates this cache, the new settings silently never take effect until the process restarts — a subtle, hard-to-diagnose bug for the exact person (a platform operator troubleshooting SMTP) least likely to think to check the process's in-memory cache.
3. Add a production-safe `invalidateEmailTransport(): void` export (sets `_transport = undefined`, same effect as the existing test helper but intended for runtime use) to `notification-email.ts`, and call it at the end of every successful `PUT /admin/settings` request that touches any `smtp*` field (compare old vs. new values; skip the call if no SMTP field changed, to avoid unnecessarily dropping a healthy connection pool on unrelated updates like `maxOrgs`).

### D5 — Audit-log storage monitoring: `epics.md`'s literal table names do not exist; monitor the real table, document the gap for `platform_audit_events`

`epics.md:2055` (Story 9.2's literal AC text) says the daily job queries `pg_total_relation_size('audit_events')` and `pg_total_relation_size('platform_audit_events')`. Neither table exists under either name:
- The shipped append-only audit table (Story 8.1, `done`) is named **`audit_log_entries`**, not `audit_events` — `audit_events` has never existed in this codebase (confirmed: `grep -rn "audit_events" packages/db/src` returns nothing outside epics.md prose).
- `platform_audit_events` is Story 9.4's deliverable (still `backlog`, not yet written) — it does not exist yet either.

**Resolution:** Monitor `pg_total_relation_size('audit_log_entries')` (the real table) now. `platform_audit_events` monitoring is explicitly **out of scope for this story** and must be added by Story 9.4 when that table is created — flag this in that story's Dev Notes when 9.4 is written (mirrors Story 9.1's D8 forward-reference pattern exactly). Until Story 9.4 ships, `AUDIT_LOG_STORAGE_LIMIT_GB` monitoring covers 100% of the audit data that actually exists on the instance (there is no platform audit log yet to also monitor).

### D6 — `GET /api/v1/admin/orgs` (listing): an addition beyond epics.md's literal text, justified by write-without-read being unusable

`epics.md`'s literal Story 9.2 AC text only specifies `POST /api/v1/admin/orgs` (create). A write-only API for organization provisioning is operationally unusable — an operator (or the deferred UI, D-Product-Surface-Contract) has no way to see which organizations already exist, their slugs, or their creation dates, and `GET /admin/resource-usage`'s `usersPerOrg: [{ orgId, ... }]` array is meaningless without a way to resolve `orgId` back to an org name. **Resolution:** this story also ships `GET /api/v1/admin/orgs` (platform operator only, `requireOrgScope: false`) returning `[{ id, name, slug, createdAt, memberCount }]`. This is a deliberate, minimal, justified addition to epics.md's literal scope (same "extend, don't guess" discipline Story 9.1 applied to its D2/D6) — call this out in the PR description.

### D7 — Multi-org creation: who becomes the new org's owner, and how (a genuinely new flow — no existing "invite to org without a project" mechanism exists)

Today, the **only** way a user joins an org is (a) registering fresh, which always creates a brand-new org (`apps/api/src/modules/auth/service.ts`'s `resolveRegistrationOrg()`/`allocateOrganizationSlug()`), or (b) accepting a **project** invitation (Story 4.1, `project_invitations` — project-scoped, not org-scoped; org membership is a side effect of the first project invite a user accepts in that org). There is no existing "invite an org owner without a project" flow — `POST /api/v1/admin/orgs` needs one, since the platform operator is provisioning a brand-new org for someone who is not necessarily already a project member of anything.

**Resolution:**
1. `POST /api/v1/admin/orgs` body: `{ name: string, ownerEmail: string }`.
2. **Reuse `allocateOrganizationSlug(tx, slugify(name))`** from `apps/api/src/modules/auth/service.ts` verbatim (exported if not already) — do not re-implement slug collision retry logic.
3. **If `ownerEmail` matches an existing `users` row:** insert an `org_memberships` row `{ orgId: newOrg.id, userId: existingUser.id, role: 'owner', status: 'active' }` in the same transaction as the org insert. Response includes `ownerAccountAction: 'existing_user_added'`. **Correction: this is *not* the first place in the codebase a user can hold `org_memberships` rows in more than one org** — `apps/api/src/modules/invitations/token-routes.ts`'s existing project-invitation-acceptance path already inserts an org-scoped `org_memberships` row with no check that the accepting user has no other org membership, so a user accepting project invitations from two different orgs today already ends up multi-org. What *is* new here is that this story's flow is the first **platform-operator-initiated, deliberate** path to multi-org membership (as opposed to an incidental side effect of invitation acceptance) — this distinction does not reduce the risk below, it means the risk already exists in production today and this story is not creating a new class of bug, only a new, more visible way to trigger it. `AuthContext.orgId` (`apps/api/src/@types/fastify.d.ts`) is populated per-session/per-JWT from the org the user authenticated into, not "the" org — **this must be verified with an actual regression test (AC-23b below), not left as an implementation-time prose reminder**, since the underlying multi-org-membership case is already reachable in production and has apparently never been tested for cross-org leakage.
4. **If `ownerEmail` does not match any existing user:** create a new `users` row (`is_platform_operator: false`, a securely-random, permanently-unusable `password_hash` sentinel — same discipline as the existing dummy-password-hash pattern already validated in `apps/api/src/config/env.ts`'s `validateDummyPasswordHash`) plus the `org_memberships` owner row, then issue a "set your initial password" link reusing the **existing `account_recovery_tokens` mechanism** (Story 4.3) rather than inventing a second token table: insert an `account_recovery_tokens` row with `initiatedBy: 'admin'` (this value is already a valid enum member — no schema change needed for the enum itself; `initiator_org_id` = the platform operator's own current org context, or `NULL` if they have none), `expiresAt: now + 72h` (matches Story 4.1's invitation TTL for consistency), and email the link using the same delivery pipeline `POST /api/v1/auth/recovery/request` uses. The recipient completes it via the **existing, unmodified** `POST /api/v1/auth/recovery/:token/complete` endpoint (Story 4.3) — no new completion endpoint needed. Response includes `ownerAccountAction: 'invited_new_user'`.
5. This design deliberately reuses three existing mechanisms (`allocateOrganizationSlug`, `account_recovery_tokens`, the recovery-complete endpoint) instead of inventing a parallel "org invitation" system — flagged explicitly so a dev agent doesn't reinvent an `org_invitations` table that would duplicate `account_recovery_tokens`' exact purpose (a single-use, expiring, hashed token that lets an identified email address establish first-time or replacement account credentials).

### D8 — Master-key custody age trigger (FR109, AC-E9d "not rotated in 365 days"): no rotation-timestamp column exists; this story adds one, but rotation *execution* remains out of scope

`packages/db/src/schema/vault-state.ts` (Story 1.5, `done`) has `initializedAt` but no rotation-timestamp column — there is no automated or manual master-key rotation **execution** endpoint anywhere in the codebase today (FR101 is unrelated — it covers **machine user API key** rotation, Epic 7, not the vault master key; confirmed via `epics.md`'s FR-to-epic table and FR101's full text). Master-key rotation is currently scoped as a **documented, manual runbook procedure** ("new key file + re-encrypt sentinel") in Story 9.5 (`backlog`, docs-only, no code changes planned there either).

**Resolution:** This story adds `vault_state.key_rotated_at` (`timestamp with time zone`, nullable; migration backfills it to the existing `initialized_at` value for all pre-existing rows, so the column is never actually `NULL` in practice after migration) and the weekly custody-check job compares `now() - key_rotated_at` against `KEY_ROTATION_MAX_AGE_DAYS` (default 365). **This story does not add a rotation-execution endpoint** — until Story 9.5's manual procedure (or a future story) actually updates `key_rotated_at`, it will permanently equal the original `initialized_at`, meaning the age-based alert **will** fire for any instance older than 365 days regardless of whether an operator has manually rotated the key out-of-band (since there is no code path to record that fact yet). Document this explicitly in Dev Notes as an accepted v1 limitation — the alert is honest ("age since last *recorded* rotation, defaulting to init time") but cannot yet reflect a rotation performed via the undocumented-to-the-app manual procedure. Flag this as an open question for whichever story eventually ships master-key rotation execution.

### D9 — FR86's literal "through the product UI" is not met by this story; documented, not silently dropped

FR86's full text is "Administrators can configure system-level settings **through the product UI**." This story ships the API only (Product Surface Contract, above) — same accepted gap Story 9.1 already established for FR88-92 (backup/restore has no UI either). This is not a new problem this story introduces; it is the same, already-acknowledged Epic 9 pattern, restated here so it is not mistaken for an oversight specific to this story.

### D10 — Audit-storage maintenance mode (AC-17): instance-wide monitoring creates a cross-tenant blast radius; must not blind the audit trail on the exact events that matter most

`audit_log_entries` is a single shared table across every org on the instance (D5) — there is no per-org partitioning or quota. This means AC-17's 95%-utilization maintenance mode is triggered by **aggregate** storage pressure, and any single org (or a single compromised/scripted account within it) generating an unusually high volume of audited actions can push the **entire instance** into maintenance mode, silently suspending audit writes for every other org. This is a genuine tenant-isolation gap, not merely an operational capacity concern, and must not be treated as one implicitly.

**Resolution (v1 scope — full per-org quota/rate-limiting is out of scope for this story, flagged as a follow-up below):**
1. **Security-critical audit event types are never suppressed by maintenance mode, even at 100% utilization.** The interception point (AC-17) must classify event types before deciding to skip a write: MFA enrollment/recovery-code usage (`apps/api/src/modules/auth/mfa.ts`, `mfa-login.ts`), machine-user API-key rotation (`apps/api/src/modules/machine-users/rotation.ts`), and any other event type already written via a direct `writeHumanAuditEntry`/`writeMachineAuditEntry`/`writeSystemAuditEntry` call rather than through the `*OrFailClosed` wrappers, are **always written**, regardless of maintenance-mode state — these are exactly the events you most need intact during an anomaly (which storage pressure may itself be a symptom of). Only "routine" audit categories (e.g. credential-reveal, resource CRUD) are eligible for suspension. Maintain an explicit `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` allowlist (not a denylist) so any newly-added event type defaults to "suppressible" only if a developer consciously omits it from the allowlist — the safer default given this table's stakes is to require an explicit decision either way, reviewed at PR time.
2. **The daily `audit-storage:check` job (AC-15/16) also computes and stores a per-org breakdown of `audit_log_entries` row-count/byte growth since the previous check**, included in the `admin_alerts` payload for the 90%/95% tiers (`payload.topContributingOrgs: [{ orgId, bytesAdded, rowsAdded }]`, top 5 by growth). This does not prevent the cross-tenant DoS, but converts it from *silent and unattributable* to *immediately diagnosable* — an operator investigating a storage-pressure alert can identify the responsible org without ad hoc SQL.
3. **Explicitly out of scope for this story, flagged as an open question below:** per-org audit-write rate limiting or storage quotas. Full resolution of the underlying tenant-isolation gap requires either partitioning `audit_log_entries` by org with independent capacity tracking, or a per-org write-rate cap — both are a larger design change than this story's scope and should be scoped as a dedicated follow-up (candidate for Epic 9 retro or Story 9.4).

---

## Acceptance Criteria

### AC-1 — Platform operator authorization on all new endpoints, MFA required (D1, D2)

**Given** all six new endpoints (`GET`/`PUT /admin/settings`, `POST`/`GET /admin/orgs`, `GET /admin/resource-usage`) exist,
**When** any is called,
**Then** it requires `authContext.isPlatformOperator === true` (via `requirePlatformOperator()`), `requireOrgScope: false`, **and** `requireMfa: true` — never `allowedRoles`/`requireOrgRole`. **These are the most privileged routes in the codebase** (instance-wide SMTP credentials, org provisioning, cross-org resource visibility) — they must not be *less* protected than the existing org-scoped `POST /api/v1/admin/notifications/test`, which already sets `security: { requireMfa: true, ... }` (`apps/api/src/modules/admin/routes.ts`). A platform-operator session compromised or coerced without a second factor must not be sufficient on its own to read/write instance-wide state.

**Example (positive):** the platform operator's access token (from the instance's first-ever registration, per Story 9.1's bootstrap), issued from a session that has completed MFA, succeeds on every endpoint.

**Example (negative — org admin, not platform operator):**
```
GET /api/v1/admin/settings
Authorization: Bearer <org Owner's token, isPlatformOperator=false>
→ 403 { "code": "platform_operator_required", "message": "This endpoint requires platform operator privileges." }
```

**Example (negative — platform operator, MFA not completed for this session):**
```
PUT /api/v1/admin/settings
Authorization: Bearer <platform operator's token, isPlatformOperator=true, mfaVerified=false>
→ 403 { "code": "mfa_required", "message": "This endpoint requires a session with MFA verified." }
```

**Example (negative — unauthenticated):** any of the six endpoints with no `Authorization` header → `401 { "code": "access_token_missing", ... }`.

**Example (regression guard, D2):** the route-audit test asserts every route registered under `modules/platform-admin/` has both `requireOrgScope: false` and `requireMfa: true`, zero have an `allowedRoles` entry, and zero routes registered under the pre-existing `modules/admin/` (org-scoped) module were modified by this story.

---

### AC-2 — `GET /api/v1/admin/settings` returns current effective settings, SMTP password masked (D3, D4)

**Given** a mix of env-var-only and DB-overridden settings,
**When** the platform operator calls `GET /api/v1/admin/settings`,
**Then** the response reflects the **effective** (post-precedence, D3) values: `{ smtp: { host, port, user, from, configured: bool }, backup: { schedule, retentionCount, storageType }, notifications: { defaultSlackWebhook }, instancePolicy: { maxOrgs, maxUsersPerOrg, sessionIdleTimeoutMinutes } }`.

**Example (positive — nothing configured via API yet, pure env-var fallback):**
```
// env: SMTP_HOST=smtp.example.com, SMTP_PORT=587, SMTP_FROM=vault@example.com, no system_settings row
GET /api/v1/admin/settings
→ 200 {
  "smtp": { "host": "smtp.example.com", "port": 587, "user": null, "from": "vault@example.com", "configured": true },
  "backup": { "schedule": "0 3 * * *", "retentionCount": 7, "storageType": "filesystem" },
  "notifications": { "defaultSlackWebhook": null },
  "instancePolicy": { "maxOrgs": 10, "maxUsersPerOrg": 50, "sessionIdleTimeoutMinutes": 30 }
}
```

**Example (positive — DB override takes precedence):** after a prior `PUT` set `smtp.host = "smtp.override.com"`, the same `GET` now returns `"host": "smtp.override.com"` even though `SMTP_HOST` env var is still `smtp.example.com` (D3 precedence rule).

**Example (edge — SMTP never configured anywhere):**
```
GET /api/v1/admin/settings
→ 200 { "smtp": { "host": null, "port": null, "user": null, "from": null, "configured": false }, ... }
```
(Not an error — an honest, well-formed "not configured" response, consistent with Story 9.1's AC-15 "backup not configured" discipline.)

---

### AC-3 — `PUT /api/v1/admin/settings` partial update; SMTP password write-only semantics (D3, D4)

**Given** the platform operator calls `PUT /api/v1/admin/settings` with any subset of fields,
**When** the request is processed,
**Then** only the provided fields are updated (upsert into `system_settings`, unspecified fields retain their current effective value — they are **not** reset to env-var defaults by omission).

**Example (positive — partial update):**
```
PUT /api/v1/admin/settings
{ "instancePolicy": { "maxOrgs": 25 } }
→ 200 { "instancePolicy": { "maxOrgs": 25, "maxUsersPerOrg": 50, "sessionIdleTimeoutMinutes": 30 }, "smtp": { ...unchanged... }, ... }
```

**Example (positive — SMTP password is only updated when explicitly provided):**
```
PUT /api/v1/admin/settings
{ "smtp": { "host": "smtp.new.com", "password": "new-smtp-secret" } }
→ 200 { "smtp": { "host": "smtp.new.com", "configured": true, ... } }
```
Followed by:
```
PUT /api/v1/admin/settings
{ "smtp": { "host": "smtp.new.com", "port": 465 } }   // password field omitted entirely
→ 200 { "smtp": { "host": "smtp.new.com", "port": 465, "configured": true, ... } }
```
The stored encrypted password is **unchanged** — verified by a test that decrypts `system_settings.smtp_pass_encrypted` before and after the second `PUT` and asserts byte-identical ciphertext (proves the update path did not touch it).

**Example (negative — literal `"[configured]"` sentinel must not overwrite):** if a client naively echoes back the masked `GET` response's shape (a common client bug), e.g. `PUT { "smtp": { "password": "[configured]" } }`, the literal string `"[configured]"` is treated as **omitted**, not as a real password — a code comment and a regression test both assert this exact string is special-cased to prevent a client bug from bricking SMTP with a garbage literal password.

**Example (negative — validation error):**
```
PUT /api/v1/admin/settings
{ "smtp": { "port": 99999 } }
→ 400 { "code": "validation_error", "message": "smtp.port must be between 1 and 65535" }
```

**Example (negative — invalid instance policy):**
```
PUT /api/v1/admin/settings
{ "instancePolicy": { "maxOrgs": 0 } }
→ 400 { "code": "validation_error", "message": "instancePolicy.maxOrgs must be at least 1" }
```

---

### AC-4 — Settings precedence and env-var fallback preserved (D3, resolves deferred-work.md E3-1)

**Given** an instance that has **never** called `PUT /admin/settings`,
**When** any code path consumes SMTP/backup/notification config (`getEmailTransport()`, the backup scheduler, notification routing defaults),
**Then** behavior is byte-for-byte identical to the pre-this-story behavior — sourced entirely from env vars, with zero code-path changes required in `notification-email.ts`/`backup` beyond the one hook point (`resolveEffectiveSettings()`) added by this story.

**Example (positive — regression test):** an integration test starts the app with only env vars set (no `system_settings` row ever created), sends a test email, and asserts it is sent using the env-var SMTP config — proving D3's fallback is non-breaking.

**Example (edge — instance upgrades mid-life, then configures via API for the first time):** an existing instance running on `SMTP_HOST=old.example.com` for months calls `PUT /admin/settings { smtp: { host: "new.example.com" } }` for the first time — the `system_settings` row is created (previously did not exist), and the effective host immediately becomes `new.example.com` without a restart (D4's cache-invalidation requirement).

---

### AC-5 — SMTP password encrypted at rest, never returned in plaintext (D4)

**Given** `PUT /admin/settings` stores an SMTP password,
**When** the row is written,
**Then** `system_settings.smtp_pass_encrypted` contains an `EncryptedValue` (`{ version, iv, ciphertext, tag }`) produced by `encrypt(Buffer.from(password), getPrimaryKey())` — never the plaintext password.

**Example (positive):** a direct `SELECT smtp_pass_encrypted FROM system_settings` after a `PUT` shows a JSON object with hex `ciphertext`/`iv`/`tag` fields, not a recognizable password string.

**Example (negative — regression guard):** a test asserts `JSON.stringify(await db.select...)` does **not** contain the plaintext password substring anywhere in the raw row.

**Example (edge — vault sealed at settings-update time):** `getPrimaryKey()` throws while sealed (matches `getAuditKey()`/`getBackupKey()`'s existing "throws while sealed" contract) — `PUT /admin/settings` with an SMTP password field present while sealed returns `503 { "code": "vault_sealed", ... }` via the existing global sealed-vault guard (no new guard code needed, same as Story 9.1 AC-16's reuse of `vaultGuardEnabled: true`); fields with no encryption dependency (e.g. `instancePolicy`) are **still blocked** too, since the entire route is behind the global sealed guard — document this as an intentional simplification (an operator cannot partially configure an unsealed-only subset while sealed).

---

### AC-6 — SMTP transport cache invalidated on settings update (D4)

**Given** SMTP settings are changed via `PUT /admin/settings`,
**When** the update completes,
**Then** the next email send uses the new configuration, not a stale cached transport.

**Example (positive):**
```
PUT /api/v1/admin/settings { "smtp": { "host": "smtp.new-provider.com", "port": 587, "password": "new-pw" } }
→ 200 { ... }
```
A subsequent `POST /api/v1/admin/notifications/test` (the existing org-admin test-delivery endpoint, unmodified by this story) sends via `smtp.new-provider.com`, verified by asserting the test's mock transport factory was invoked with the new host.

**Example (negative — regression guard proving the bug D4 describes would otherwise exist):** a test stubs `invalidateEmailTransport()` to a no-op, changes SMTP settings, and asserts the old (now-stale) transport would have been used — this test exists specifically to prove the invalidation call is load-bearing, not a no-op wired in by accident.

**Example (edge — update that does not touch SMTP fields):** `PUT /admin/settings { "instancePolicy": { "maxOrgs": 20 } }` does **not** call `invalidateEmailTransport()` (verified via a spy) — avoids unnecessarily dropping a healthy SMTP connection pool for unrelated config changes.

---

### AC-7 — `system_settings` schema, migration, and RLS exclusion (D3)

**Given** this story's migration runs,
**When** `pnpm --filter @project-vault/db db:migrate` executes,
**Then** the `system_settings` table exists exactly as specified in D3, is added to `EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts` in the same migration, and the same migration also adds `vault_state.key_rotated_at` (D8) backfilled to `initialized_at`.

**Example (positive):** `pnpm --filter @project-vault/db check-rls` passes with zero gaps reported for `system_settings`.

**Example (negative — regression guard):** a test asserts `checkRlsCoverage()` throws `RlsCoverageGapError` if `system_settings` is removed from `EXCLUDED_TABLES` while the table still lacks an RLS policy (mirrors Story 9.1's AC-2 pattern exactly).

**Example (backward compatibility — D8 backfill):** on an instance with an existing `vault_state` row (`initialized_at: '2026-01-15T00:00:00Z'`), after migration `SELECT key_rotated_at FROM vault_state` returns `'2026-01-15T00:00:00Z'` (not `NULL`) — verified by an integration test seeding a pre-migration-shaped row and asserting the backfill.

---

### AC-8 — `POST /api/v1/admin/orgs` — create org for an existing user (D6, D7)

**Given** `ownerEmail` matches an existing `users` row,
**When** the platform operator calls `POST /api/v1/admin/orgs { "name": "Acme Subsidiary", "ownerEmail": "alice@example.com" }`,
**Then** a new `organizations` row is created (via `allocateOrganizationSlug`, D7) and `alice`'s user id is inserted into `org_memberships` for the new org with `role: 'owner'`, `status: 'active'`.

**Example (positive):**
```
POST /api/v1/admin/orgs
{ "name": "Acme Subsidiary", "ownerEmail": "alice@example.com" }
→ 201 {
  "id": "8b2c...", "name": "Acme Subsidiary", "slug": "acme-subsidiary",
  "ownerAccountAction": "existing_user_added", "ownerUserId": "<alice's existing id>"
}
```
`SELECT * FROM org_memberships WHERE user_id = '<alice's id>' AND org_id = '8b2c...'` → one row, `role='owner'`, confirming Alice now belongs to **two** orgs (her original + this new one) — multi-org membership was already reachable today via project-invitation acceptance (see D7 point 3's correction); this endpoint is a new, deliberate path to the same state, not a new category of state.

**Example (edge — duplicate org name, different slug):** creating a second org also named "Acme Subsidiary" succeeds with slug `acme-subsidiary-2` (reuses `allocateOrganizationSlug`'s existing collision-retry loop verbatim — org **names** are not required to be globally unique, only **slugs** are, matching the existing registration-flow behavior).

**Example (negative — ownerEmail is malformed):**
```
POST /api/v1/admin/orgs { "name": "X", "ownerEmail": "not-an-email" }
→ 400 { "code": "validation_error", "message": "ownerEmail must be a valid email address" }
```

---

### AC-9 — `POST /api/v1/admin/orgs` — create org for a brand-new owner email (D7)

**Given** `ownerEmail` does not match any existing `users` row,
**When** the platform operator calls `POST /api/v1/admin/orgs { "name": "New Customer Co", "ownerEmail": "bob@newcustomer.com" }`,
**Then** a new `users` row is created (`is_platform_operator: false`, unusable sentinel password hash) plus the owning `org_memberships` row, plus an `account_recovery_tokens` row (`initiatedBy: 'admin'`, `expiresAt: now + 72h`) is created and an email is sent to `bob@newcustomer.com` with the set-password link.

**Example (positive):**
```
POST /api/v1/admin/orgs
{ "name": "New Customer Co", "ownerEmail": "bob@newcustomer.com" }
→ 201 {
  "id": "9c3d...", "name": "New Customer Co", "slug": "new-customer-co",
  "ownerAccountAction": "invited_new_user", "ownerUserId": "<bob's new id>"
}
```
Bob receives an email with a link containing the plaintext recovery token; visiting `POST /api/v1/auth/recovery/<token>/complete` with `{ newPassword: "..." }` (Story 4.3's **existing, unmodified** endpoint) sets his password and he can now log in as owner of "New Customer Co".

**Example (edge — Bob never completes the link before it expires):** 73 hours later, `POST /api/v1/auth/recovery/<token>/complete` returns `410 { "code": "recovery_token_expired", ... }` (Story 4.3's existing behavior, unmodified) — the org and Bob's user row still exist (org creation is not rolled back by an unused invite expiring); a platform operator can re-trigger a fresh invite via a documented follow-up call (out of scope to build a dedicated "resend" endpoint in this story — note as an open question below).

**Example (negative — ownerEmail matches an existing but deactivated user, Story 4.3):** creating an org for a deactivated user's email returns `409 { "code": "owner_account_deactivated", "message": "The specified owner account is deactivated. Reactivate it first or choose a different owner." }` — do not silently reactivate a deactivated account as a side effect of unrelated org provisioning.

---

### AC-10 — `maxOrgs` instance policy enforcement (D3)

**Given** `instancePolicy.maxOrgs = 10` (default or configured) and 10 organizations already exist,
**When** `POST /api/v1/admin/orgs` is called for an 11th,
**Then** it is rejected.

**Example (positive — under limit):** 9 orgs exist; a 10th creation succeeds normally.

**Example (negative — at limit):**
```
POST /api/v1/admin/orgs { "name": "One Too Many", "ownerEmail": "x@example.com" }
→ 422 { "code": "org_limit_reached", "message": "This instance has reached its configured limit of 10 organizations. Increase instancePolicy.maxOrgs via PUT /admin/settings to provision more." }
```

**Example (edge — limit increased then retried):** the platform operator calls `PUT /admin/settings { "instancePolicy": { "maxOrgs": 20 } }`, then retries the same `POST /admin/orgs` — succeeds.

---

### AC-11 — `GET /api/v1/admin/orgs` — list organizations (D6)

**Given** organizations exist on the instance,
**When** the platform operator calls `GET /api/v1/admin/orgs`,
**Then** it returns `{ items: [{ id, name, slug, createdAt, memberCount }] }`, most-recently-created first.

**Example (positive):**
```
GET /api/v1/admin/orgs
→ 200 { "items": [
  { "id": "9c3d...", "name": "New Customer Co", "slug": "new-customer-co", "createdAt": "2026-07-06T...", "memberCount": 1 },
  { "id": "...", "name": "Acme Corp", "slug": "acme-corp", "createdAt": "2026-04-01T...", "memberCount": 12 }
] }
```

**Example (edge — single-org instance, the common case):**
```
GET /api/v1/admin/orgs
→ 200 { "items": [ { "id": "...", "name": "Acme Corp", "slug": "acme-corp", "createdAt": "...", "memberCount": 1 } ] }
```
(Never empty in practice — at least one org always exists once the platform operator has registered, per Story 9.1's D1/Story 1.6.)

---

### AC-12 — `GET /api/v1/admin/resource-usage` — happy path (D3)

**Given** organizations, users, secrets, and audit log entries exist,
**When** the platform operator calls `GET /api/v1/admin/resource-usage`,
**Then** it returns `{ orgs: { current, limit }, usersPerOrg: [{ orgId, current, limit }], secretsPerProject: [{ projectId, orgId, current }], auditLogEntries: { current, limit }, storageBytes: { current, limit }, auditLogStorage: { currentBytes, limitBytes, utilizationPct } }`.

**Example (positive):**
```
GET /api/v1/admin/resource-usage
→ 200 {
  "orgs": { "current": 2, "limit": 10 },
  "usersPerOrg": [
    { "orgId": "...", "current": 12, "limit": 50 },
    { "orgId": "...", "current": 1, "limit": 50 }
  ],
  "secretsPerProject": [ { "projectId": "...", "orgId": "...", "current": 847 } ],
  "auditLogEntries": { "current": 15302, "limit": null },
  "storageBytes": { "current": 48310120, "limit": null },
  "auditLogStorage": { "currentBytes": 12582912, "limitBytes": 53687091200, "utilizationPct": 0.02 }
}
```
`auditLogEntries.limit`/`storageBytes.limit` are `null` in v1 — no per-count row-limit is configured anywhere in `instancePolicy` (only the storage-**bytes** ceiling, `auditLogStorage`, is enforced/alerted on, per D5/AC-15) — document this as an honest `null`, not a fabricated number, matching AC-E2f's "no fake zeros/values" discipline.

**Example (edge — brand-new instance, one org, one user, no secrets yet):**
```
→ 200 { "orgs": { "current": 1, "limit": 10 }, "usersPerOrg": [ { "orgId": "...", "current": 1, "limit": 50 } ], "secretsPerProject": [], "auditLogEntries": { "current": 1, "limit": null }, ... }
```
(`auditLogEntries.current` is at least 1 — the platform-operator's own registration already wrote an audit entry.)

---

### AC-13 — Resource usage threshold alerts: per-org `usersPerOrg` (80/90/95%, advisory-only — D3)

**Note:** `maxUsersPerOrg` is alert-only in v1 (D3) — crossing 100% does **not** block new members from joining; only `maxOrgs` (AC-10) is a hard-enforced cap. This is intentional and documented, not a gap.

**Given** an org has `usersPerOrg.current / limit >= 0.80`,
**When** the resource-usage check runs (piggybacks on the existing hourly-cadence job family, or its own dedicated hourly job — implementer's choice, document which),
**Then** an alert fires to that **specific org's** admins/owners via the existing per-org `resolveRoutingRecipients(orgId, 'resource.users_near_limit', tx)` pipeline (Story 3.2) — add `'resource.users_near_limit'`/`'resource.secrets_near_limit'` to `NOTIFICATION_ALERT_TYPES` (`packages/shared/src/constants/notification-types.ts`).

**Example (positive — 80% threshold crossed):** org has 40/50 users (`maxUsersPerOrg: 50`). Alert delivered to that org's `owner`-routed recipients (default routing role) with payload `{ current: 40, limit: 50, thresholdPct: 80 }`.

**Example (edge — idempotent, does not re-fire every check):** the same org stays at 41-44/50 users for several days; the 80% alert fires exactly once (dedup via an `admin_alerts`-style episode key scoped to `(orgId, alertType, thresholdPct)`, same discipline as Story 9.1 AC-12's `backup.missed` idempotency) — a **new** alert fires only when a **higher** threshold (90%, then 95%) is newly crossed, or after the org drops back below a threshold and re-crosses it later.

**Example (negative/non-alerting case):** org has 30/50 users (60%) — no alert.

---

### AC-14 — Resource usage threshold alerts: instance-wide `orgs` count (80/90/95%)

**Given** the instance-wide `orgs.current / limit >= 0.80`,
**When** the check runs,
**Then** an `admin_alerts` row is created (`alertType: 'resource.orgs_near_limit'`, `severity` scaling with threshold: `'warning'` at 80/90%, `'critical'` at 95%) — there is no single "org" to route this to via per-org notification routing (it is instance-wide, same reasoning as Story 9.1's D7 for backup alerts), so it is recorded platform-side only in v1 (no email fan-out for this specific instance-wide metric — contrast with AC-19/AC-20's key-custody alert, which explicitly does fan out to org owners per AC-E9d's literal text).

**Example (positive):** 9/10 orgs exist (90%). `admin_alerts` row: `{ alertType: 'resource.orgs_near_limit', severity: 'warning', payload: { current: 9, limit: 10, thresholdPct: 90 }, status: 'active' }`.

**Example (edge — idempotency):** same dedup discipline as AC-13 — one row per newly-crossed threshold, not one per check tick.

---

### AC-15 — Audit log storage monitoring: daily job queries the real table (D5)

**Given** `AUDIT_LOG_STORAGE_LIMIT_GB=50` (default, configurable),
**When** the daily `audit-storage:check` pg-boss job runs,
**Then** it queries `pg_total_relation_size('audit_log_entries')` (the real table, D5 — **not** `audit_events`, which does not exist) and computes `utilizationPct = currentBytes / (limitGB * 1024^3)`.

**Example (positive — healthy):** `audit_log_entries` is 5GB of a 50GB limit (10%). No alert.

**Example (regression guard, D5):** a test asserts the job's SQL literal string contains `'audit_log_entries'`, not `'audit_events'` — guards against a future refactor accidentally "correcting" the code to match epics.md's literal (wrong) text.

---

### AC-16 — Audit log storage: tiered alerts at 80/90/95% (D5)

**Given** utilization crosses 80%, 90%, or 95%,
**When** the daily check runs,
**Then** an `admin_alerts` row (`alertType: 'audit_storage.warning'` at 80/90%, `'audit_storage.critical'` at 95%) is created (idempotent per threshold, same discipline as AC-13) and delivered to every org's `audit_storage.warning`/`audit_storage.critical`-routed recipients via the cross-org loop pattern (Story 9.1 D7 — audit storage is instance-wide, affecting every org's ability to write audit entries, so it fans out to every org unlike AC-14's `resource.orgs_near_limit`, which has no per-org relevance at all). Add `'audit_storage.warning'`/`'audit_storage.critical'` to `NOTIFICATION_ALERT_TYPES`.

**Example (positive — 90% crossed):** 45GB of 50GB. `admin_alerts` row + cross-org email/Slack/inbox delivery, payload `{ currentBytes: 48318382080, limitBytes: 53687091200, utilizationPct: 90 }`.

---

### AC-17 — Audit log storage: 95% maintenance mode suspends *routine* writes only; security-critical events always written; per-org attribution included (D5, D10)

**Given** utilization reaches ≥ 95%,
**When** the daily check detects this,
**Then** in addition to AC-16's critical alert, a maintenance-mode flag is activated: subsequent attempts to write a **routine** (non-security-critical, per D10's `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` allowlist) audit event to `audit_log_entries` (via `writeHumanAuditEntry`/`writeMachineAuditEntry`/`writeSystemAuditEntry`, `apps/api/src/modules/audit/*.ts`) are intercepted **before** the INSERT, the write is skipped, and a `WARN`-level structured operational log entry is emitted in its place (`OperationalEvent.AUDIT_WRITE_SUSPENDED`, payload includes the event type and org id that would have been written). **Events on the `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` allowlist (D10) — MFA enrollment/recovery-code usage, machine-key rotation, and any event type not explicitly marked suppressible — are always written, regardless of maintenance-mode state.** This is a deliberate trade-off (routine-write availability over completeness) that must be documented prominently, since it is the **one** place in the entire codebase where the otherwise-absolute "audit write failure fails the whole request closed" invariant (`SameTransactionAuditWriteError`, `audit-or-fail-closed.ts`) is intentionally suspended for routine events, not by failure but by design, to prevent a full storage outage from also taking down every audited write path in the product — while never suspending the events most likely to matter during an anomaly.

**Example (positive — maintenance mode active, a credential is revealed — routine event, suppressed):**
```
GET /api/v1/projects/:id/credentials/:credId/reveal   // while maintenance mode is active
→ 200 { ...secret value... }   // the reveal itself still succeeds
```
Operational log: `{ event: "audit.write_suspended", level: "warn", eventType: "credential.revealed", orgId: "...", reason: "audit_storage_maintenance_mode" }` — **no** `audit_log_entries` row is written for this reveal.

**Example (positive — maintenance mode active, MFA recovery code used — security-critical, NOT suppressed):**
```
POST /api/v1/auth/mfa/recover   // while maintenance mode is active
→ 200 { ... }
```
A real `audit_log_entries` row **is** written for this event (verified by a test asserting `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` membership bypasses the maintenance-mode check entirely) — the interception point checks event-type membership before the storage-pressure check, not after.

**Example (positive — 90%/95% alert includes per-org attribution, D10):**
```json
// admin_alerts row at 95%
{
  "alertType": "audit_storage.critical",
  "payload": {
    "currentBytes": 51000000000, "limitBytes": 53687091200, "utilizationPct": 95,
    "topContributingOrgs": [
      { "orgId": "8b2c...", "bytesAdded": 4200000000, "rowsAdded": 18400 },
      { "orgId": "9c3d...", "bytesAdded": 310000000, "rowsAdded": 900 }
    ]
  }
}
```
An operator can immediately see which org is responsible for the growth, without ad hoc SQL.

**Example (negative/edge — resuming normal operation):** the operator exports-and-prunes old audit entries (out of scope to build export tooling in this story — reuses Story 8.2's existing export mechanism), utilization drops back below 95%. The next daily check detects this and deactivates maintenance mode — subsequent routine audit writes resume normally, verified by a test asserting a write immediately after mode deactivation produces a real `audit_log_entries` row again.

**Example (edge — maintenance mode must not silently persist forever if the check job itself fails):** if the daily `audit-storage:check` job errors out (e.g., transient DB issue) while maintenance mode is active, mode remains active (fails safe — better to keep suspending non-critical audit writes than to guess) but the job failure itself is logged at `error` level so it surfaces in operational monitoring, distinct from the routine "still at 96%, staying in maintenance mode" no-op case.

---

### AC-18 — `GET /ready` reflects audit storage pressure and key custody risk via a new `warnings` field (D5, AC-E9d)

**Given** utilization is ≥ 95% (AC-17) or a key custody risk is active (AC-19/20),
**When** `GET /ready` is called,
**Then** the response includes an additive, optional `warnings: string[]` array alongside the existing `{ status: "ready" }` shape — never changing `status` away from `"ready"` for these two conditions specifically (they are warnings, not outages; contrast with the existing `"sealed"`/`"uninitialized"`/`"db"` reasons, which already return `503`).

**Example (positive — audit storage critical):**
```
GET /ready
→ 200 { "status": "ready", "warnings": ["audit_storage_critical"] }
```

**Example (positive — both conditions active simultaneously):**
```
GET /ready
→ 200 { "status": "ready", "warnings": ["audit_storage_critical", "key_custody_risk"] }
```

**Example (negative/regression — backward compatibility):** an existing monitoring integration that only checks `response.status === "ready"` (ignoring unknown fields, standard JSON client behavior) continues to work unmodified — a test asserts the healthy-instance response has **no** `warnings` key at all (not an empty array) to keep the payload minimal for the common case, matching the existing `{ status: "ready" }` exact shape when nothing is degraded.

---

### AC-19 — Key custody risk alert: trigger (a) file-based KMS + backup enabled (FR109, AC-E9d)

**Given** `vault_state.kms_type = 'file'` AND backup is configured (`BACKUP_STORAGE_PATH` or `BACKUP_S3_BUCKET` set, per Story 9.1's AC-14/15),
**When** the vault unseals (startup check) or the weekly `key-custody:check` pg-boss job runs,
**Then** a `key_custody_risk` `admin_alerts` row is created (idempotent — one active row per instance, not one per check) with a payload including a direct link/reference to KMS configuration docs, and delivered to **every org owner on the instance** (cross-org loop, Story 9.1 D7 pattern) per AC-E9d's literal "sent to all org owners and the platform operator audit log."

**Example (positive):**
```json
// admin_alerts row
{
  "alertType": "key_custody_risk",
  "severity": "warning",
  "payload": { "trigger": "file_kms_with_backup", "message": "Master key uses file-based custody while backups are enabled — a single compromised backup could expose the encryption key. Configure a KMS integration to mitigate.", "docsUrl": "https://docs.project-vault.example/kms" },
  "status": "active"
}
```
Every org owner (across every org on the instance) receives an email/Slack/inbox notification.

**Example (negative/non-alerting):** `kms_type = 'kms'` (or `'passphrase'`/`'envelope'` with backup disabled) — no alert.

**Example (edge — idempotency across restarts):** the vault seals and unseals three times in one day (e.g. three deploys); the startup check runs three times but only the **first** creates an `admin_alerts` row (checks for an existing `active` row of this type first, same discipline as Story 9.1 AC-12).

---

### AC-20 — Key custody risk alert: trigger (b) key age exceeds `KEY_ROTATION_MAX_AGE_DAYS` (FR109, D8)

**Given** `now() - vault_state.key_rotated_at > KEY_ROTATION_MAX_AGE_DAYS` (default 365, configurable),
**When** the weekly `key-custody:check` job runs,
**Then** a `key_custody_risk` `admin_alerts` row is created (`trigger: 'key_age_exceeded'` in payload, distinguishable from trigger (a)) and delivered identically to AC-19 (every org owner + platform-level record).

**Example (positive):** `key_rotated_at` is 400 days old, `KEY_ROTATION_MAX_AGE_DAYS=365`. Alert fires: `{ "trigger": "key_age_exceeded", "daysSinceRotation": 400, "maxAgeDays": 365 }`.

**Example (edge — both triggers active simultaneously):** file KMS + backup enabled **and** key is 400 days old — a single `admin_alerts` row's payload includes **both** trigger reasons (`triggers: ["file_kms_with_backup", "key_age_exceeded"]`) rather than two separate, redundant rows/notifications for what is conceptually "one custody-risk condition, two contributing reasons."

**Example (accepted limitation, D8 — must be documented, not hidden):** since no rotation-execution endpoint exists yet (D8), `key_rotated_at` never advances past the original `initialized_at` in this story's scope — meaning this alert **will** fire for any instance older than `KEY_ROTATION_MAX_AGE_DAYS` regardless of any out-of-band manual rotation an operator may have performed. A code comment at the job's implementation site references D8 and flags this for whichever future story ships rotation execution.

---

### AC-21 — Env var configuration and validation (D3, D5, D8)

**Given** the API starts up,
**When** `apps/api/src/config/env.ts` parses the environment,
**Then** it validates the new vars this story introduces: `AUDIT_LOG_STORAGE_LIMIT_GB` (`z.coerce.number().positive().default(50)`), `KEY_ROTATION_MAX_AGE_DAYS` (`z.coerce.number().int().positive().default(365)`).

**Example (positive):**
```
AUDIT_LOG_STORAGE_LIMIT_GB=50
KEY_ROTATION_MAX_AGE_DAYS=365
```
Startup succeeds; both weekly/daily schedules register under `onVaultUnsealed`, same pattern as every other pg-boss schedule in `main.ts`.

**Example (negative — invalid value):** `AUDIT_LOG_STORAGE_LIMIT_GB=-5` → startup fails fast with a Zod validation error, not a runtime crash the first time the daily job divides by a negative limit.

---

### AC-22 — Concurrency: simultaneous `PUT /admin/settings` requests do not corrupt the singleton row (D3)

**Given** two `PUT /admin/settings` requests with different, non-overlapping field sets fire concurrently,
**When** both are processed,
**Then** the `INSERT ... ON CONFLICT (id) DO UPDATE` upsert serializes correctly at the database level (row-level lock on the single `id=1` row) — no lost update where one request's fields silently overwrite the other's with stale values.

**Example (edge case):** request A sets `{ instancePolicy: { maxOrgs: 20 } }`, request B (fired within the same millisecond) sets `{ smtp: { host: "new.com" } }`. After both complete, `GET /admin/settings` shows **both** changes applied (`maxOrgs: 20` **and** `host: "new.com"`) — verified by an integration test firing both via `Promise.all` and asserting the final state reflects both writes, not just whichever transaction committed last with a full-row overwrite. Implementation note: the upsert must read-modify-write within a single transaction (`SELECT ... FOR UPDATE` then `UPDATE` with only the changed columns), not a blind `UPDATE system_settings SET *` that clobbers concurrent unrelated fields.

---

### AC-23 — Concurrency: two simultaneous `POST /admin/orgs` for the same new `ownerEmail` (D7)

**Given** two `POST /admin/orgs` requests both specify a brand-new (non-existent) `ownerEmail` and fire concurrently,
**When** both are processed,
**Then** exactly one new `users` row is created for that email (the `users.email` unique constraint, already in place, causes the second transaction's user-insert to fail with a unique-violation) — the losing request's transaction is caught and retried as "existing user found" (re-querying `users` by email inside the retry), so the org that "lost the race" for user creation still succeeds in being created with the now-existing user as owner, rather than the whole request failing outright.

**Example (edge case):** two `POST /admin/orgs` calls for `{ name: "Org A", ownerEmail: "race@example.com" }` and `{ name: "Org B", ownerEmail: "race@example.com" }` fire via `Promise.all`. Both return `201`; `SELECT COUNT(*) FROM users WHERE email = 'race@example.com'` = 1; both "Org A" and "Org B" exist with that single user as owner of both.

---

### AC-23b — Regression test: multi-org user session correctly scopes to only their JWT's org (D7 point 3, tenant isolation)

**Given** a user holds `org_memberships` rows in two different orgs (reachable today via project-invitation acceptance, and newly via `POST /admin/orgs`, D7 point 3),
**When** that user authenticates and receives a JWT scoped to org A (`AuthContext.orgId = orgA.id`),
**Then** every existing org-scoped endpoint that reads `AuthContext.orgId` must return **only** org A's data — none of org B's — even though the same `user_id` also holds a valid, active `org_memberships` row for org B.

**Example (positive — the case this test must catch if it regresses):** the multi-org user has 3 projects in org A and 5 projects in org B. Authenticating with an org-A-scoped JWT and calling `GET /api/v1/projects` returns exactly the 3 org-A projects — never all 8, never the 5 org-B projects.

**Example (negative — the bug this test exists to prevent):** any org-scoped query implemented as a bare `users` join (e.g. `SELECT ... FROM projects JOIN users ON ...` without an explicit `org_memberships`/`org_id` filter) would, for a multi-org user, return **cross-org data** — the test suite must include at least one query-level assertion per major org-scoped resource (projects, credentials, service endpoints) proving this cannot happen, not just an end-to-end happy-path check.

**Example (edge — switching org context via re-authentication):** the same user re-authenticates and selects org B (or receives an org-B-scoped JWT via whatever org-switching mechanism exists) — subsequent calls now return only org B's data, and a previously-issued org-A-scoped JWT (if still unexpired) continues to return only org A's data if reused; the two sessions never bleed into each other.

This AC exists because this story's `POST /admin/orgs` deliberately increases how often multi-org membership occurs, and no existing test previously covered this case (D7 point 3) despite it already being reachable via project invitations — shipping this endpoint without closing that gap would knowingly ship on top of an untested tenant-isolation assumption in a credential vault.

---

### AC-24 — Migration and backward compatibility: existing single-org instances are unaffected (D3, D6, D7)

**Given** an existing single-org deployment upgrading to this story's version,
**When** the migration runs,
**Then** no existing behavior changes for that org: `GET /admin/settings` returns env-var-sourced defaults (D3/AC-4), `GET /admin/orgs` returns the single pre-existing org, `GET /admin/resource-usage` reports `orgs: { current: 1, limit: 10 }`.

**Example (positive — zero-touch upgrade):** an instance with one org and 5 users upgrades; no manual migration steps are required beyond running the standard `db:migrate`; `system_settings` has no row until the operator first calls `PUT`.

**Example (negative — must NOT auto-create a `system_settings` row with guessed values):** the migration itself must not `INSERT` a `system_settings` row (the table starts empty; `GET` synthesizes defaults from env vars/hardcoded fallbacks per D3, it does not read a pre-populated row) — a test asserts `SELECT COUNT(*) FROM system_settings` = 0 immediately after migration on a fresh instance.

---

### AC-25 — Audit/logging: every new mutating action is captured

**Given** `PUT /admin/settings` or `POST /admin/orgs` executes,
**When** the action completes,
**Then** a structured operational log entry is emitted (D5/D6-style — this story's actions are instance-wide platform-operator actions, same classification Story 9.1's D6 applied to backup/restore: interim operational logging, **not** `audit_log_entries` [org-scoped, doesn't fit an instance-wide action] and **not yet** `platform_audit_events` [Story 9.4, not built]).

**Example (positive):**
```json
{ "event": "platform_admin.settings_updated", "level": "info", "operatorUserId": "...", "fieldsChanged": ["smtp.host", "instancePolicy.maxOrgs"], "timestamp": "..." }
{ "event": "platform_admin.org_created", "level": "info", "operatorUserId": "...", "newOrgId": "...", "ownerAccountAction": "invited_new_user", "timestamp": "..." }
```
New `OperationalEvent` constants: `PLATFORM_SETTINGS_UPDATED`, `PLATFORM_ORG_CREATED`, `AUDIT_WRITE_SUSPENDED` (AC-17), `AUDIT_STORAGE_MAINTENANCE_MODE_ENTERED`, `AUDIT_STORAGE_MAINTENANCE_MODE_EXITED`.

**And** this story's Dev Notes must state plainly (mirroring Story 9.1's D6/AC-18) that this is interim, non-tamper-evident, pending Story 9.4 — flag this cross-reference explicitly when 9.4 is written, same as Story 9.1 already does for its own actions.

---

### AC-26 — Sealed-vault guard applies to all new endpoints

**Given** the vault is sealed,
**When** any of the six new endpoints is called,
**Then** the existing global `vaultGuardEnabled: true` middleware returns `503` automatically — no route-specific guard code needed (Story 9.1's AC-16 precedent, reused verbatim).

**Example (positive):** `GET /api/v1/admin/settings` while sealed → `503 { "code": "sealed", ... }`.

**Example (regression guard):** the route-audit test confirms none of this story's six routes are added to any allow-list/exemption (they are not pre-auth bootstrap routes like `/vault/init`).

---

### AC-27 — Route classification and OpenAPI (D2)

**Given** this story's six new routes are registered,
**When** `pnpm --filter @project-vault/api generate-spec` runs,
**Then** the generated OpenAPI spec correctly documents all six under a distinct tag (e.g. `Platform Admin`, distinguishing from the existing org-scoped `Admin` tag on `/admin/notifications/test`) and `route-exemptions.ts`/`route-audit.test.ts` correctly classify them as authenticated, non-exempt, platform-operator-scoped.

**Example (positive):** `GET /api/v1/openapi.json` shows `POST /api/v1/admin/orgs` tagged `Platform Admin` with a `security` requirement distinct from `POST /api/v1/admin/notifications/test`'s `Admin` tag.

---

### AC-28 — Integration test coverage (explicit list — do not consider this story done without all of these)

**Given** the full feature set above,
**When** the integration test suite runs (`apps/api/src/modules/platform-admin/*.test.ts` and `apps/api/src/__tests__/`),
**Then** it covers, at minimum: (1) platform-operator authz on all six routes + org-admin 403 + unauthenticated 401 (AC-1); (2) settings GET effective-value precedence, env-only and DB-override cases (AC-2, AC-4); (3) settings PUT partial update, SMTP password write-only + `"[configured]"` sentinel guard + validation errors (AC-3); (4) SMTP password encrypted at rest, never plaintext in DB or response (AC-5); (5) SMTP transport cache invalidation on update, and non-invalidation on unrelated update (AC-6); (6) `system_settings`/`vault_state.key_rotated_at` migration + RLS-exclusion regression + backfill (AC-7); (7) org creation for existing user, multi-org membership (AC-8); (8) org creation for new user via recovery-token reuse, expired-token case, deactivated-owner rejection (AC-9); (9) `maxOrgs` enforcement + limit-increase retry (AC-10); (10) org listing, single-org and multi-org cases (AC-11); (11) resource-usage happy path + honest nulls (AC-12); (12) per-org and instance-wide threshold alerts + idempotency (AC-13, AC-14); (13) audit storage monitoring queries the real table name (AC-15, regression guard for D5); (14) tiered alerts + cross-org fan-out (AC-16); (15) 95% maintenance mode suspends writes + resumes + fail-safe on job error (AC-17); (16) `/ready` warnings field, additive and backward-compatible (AC-18); (17) key custody alert both triggers, combined-trigger payload, idempotency (AC-19, AC-20); (18) env var validation (AC-21); (19) concurrent settings PUT does not lose updates (AC-22); (20) concurrent org creation for the same new email (AC-23); (20b) multi-org user session scopes to only their JWT's org across projects/credentials/service-endpoints — query-level assertions, not just end-to-end (AC-23b); (21) migration backward compatibility, no auto-created settings row (AC-24); (22) operational log events emitted (AC-25); (23) sealed-vault 503 on all six routes (AC-26); (24) route classification/OpenAPI tagging (AC-27).

---

## Tasks / Subtasks

- [x] **Task 0 — Prerequisite check (D1)**
  - [x] Confirm Story 9.1's `users.is_platform_operator`, `requirePlatformOperator()`, `AuthContext.isPlatformOperator`, and `admin_alerts` table exist in the branch/codebase this story builds on; if not, implement Story 9.1's Task 1 + Task 2 first as a shared-foundation commit. (Confirmed present — Story 9.1 merged to main.)
- [x] **Task 1 — `system_settings` schema + `vault_state.key_rotated_at` (D3, D7, D8, AC-7)**
  - [x] `packages/db/src/schema/system-settings.ts`; export from `schema/index.ts`
  - [x] Migration: create `system_settings`; add to `EXCLUDED_TABLES`; add `vault_state.key_rotated_at` with backfill (migration `0040`, includes disable/enable of `vault_state`'s append-only trigger around the backfill — a real bug found while implementing: the trigger blocks the backfill UPDATE unconditionally, even for the superuser migration role)
  - [x] Export `allocateOrganizationSlug` from `apps/api/src/modules/auth/service.ts` if not already exported, for reuse (D7)
- [x] **Task 2 — Platform-admin route module (D2)**
  - [x] New module `apps/api/src/modules/platform-admin/` (`settings-routes.ts`, `orgs-routes.ts`, `resource-usage-routes.ts`, `service.ts`, `schema.ts`)
  - [x] Every route: `security: { requireOrgScope: false, requireMfa: true }` + `requirePlatformOperator: true`
  - [x] Route-audit regression test distinguishing this module from `modules/admin/`, asserting `requireMfa: true` on all five routes (D2) — see note below on the "six routes" text
- [x] **Task 3 — Settings service (D3, D4, AC-2 through AC-7)**
  - [x] `resolveEffectiveSettings()` — DB-override-then-env-fallback precedence, single implementation reused everywhere
  - [x] SMTP password encrypt/mask/`"[configured]"`-sentinel handling
  - [x] `invalidateEmailTransport()` in `notification-email.ts`; call from settings-update path when SMTP fields change
  - [x] Concurrency-safe upsert (advisory-lock + read-modify-write in one transaction, AC-22) — implemented as `pg_advisory_xact_lock` + full-row upsert rather than `SELECT ... FOR UPDATE`, since the singleton row may not exist yet on first PUT (`FOR UPDATE` cannot lock a nonexistent row); functionally equivalent serialization guarantee, verified by AC-22's concurrent-PUT integration test
- [x] **Task 4 — Multi-org provisioning (D6, D7, AC-8 through AC-11, AC-23)**
  - [x] `POST /admin/orgs`: existing-user-owner path and new-user-owner path (reuses `account_recovery_tokens` directly + existing, unmodified recovery-complete endpoint — not `sendAdminRecoveryLink()`, since that helper's 15-minute TTL and org-context assumptions don't fit this flow's 72h TTL / brand-new-org context; see Dev Notes)
  - [x] Deactivated-owner-email rejection (409) — interpreted as "every org_membership this user holds, instance-wide, is `deactivated`" (see Dev Notes open question)
  - [x] `maxOrgs` enforcement (422)
  - [x] `GET /admin/orgs` listing with `memberCount`
  - [x] Concurrent-same-new-email race handling (unique-violation catch + retry-as-existing-user) — required adding a SAVEPOINT (nested `tx.transaction()`) around both the slug-allocation retry loop and the user-insert race branch; see Dev Notes bug-fix writeup
  - [x] Cross-org data-isolation regression test for multi-org users across projects/credentials/service-endpoints (AC-23b)
- [x] **Task 5 — Resource usage endpoint and threshold alerts (AC-12 through AC-14)**
  - [x] `GET /admin/resource-usage` aggregation queries
  - [x] Hourly threshold-check job (dedicated `resource-usage:check`, documented choice): per-org `usersPerOrg` (org-routed alert) and instance-wide `orgs` (admin_alerts only)
  - [x] Add `'resource.users_near_limit'`/`'resource.secrets_near_limit'` to `NOTIFICATION_ALERT_TYPES`
  - [x] Episode-key idempotency helper (reusable across AC-13/14/16/19/20) — `apps/api/src/lib/threshold-alerts.ts`
- [x] **Task 6 — Audit log storage monitoring + maintenance mode (D5, D10, AC-15 through AC-18)**
  - [x] Daily `audit-storage:check` job — `pg_total_relation_size('audit_log_entries')` (real table name, D5)
  - [x] Per-org storage-growth breakdown (`topContributingOrgs`, D10) — approximated as rows written in the last 24h with an estimated average row-byte-size (documented approximation, not a fabricated number)
  - [x] Tiered alerts (80/90/95%) + cross-org fan-out; add `'audit_storage.warning'`/`'audit_storage.critical'` to `NOTIFICATION_ALERT_TYPES`
  - [x] `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` allowlist (D10) + maintenance-mode flag (the active `audit_storage.critical` admin_alerts row itself, no separate state table) + interception point in `writeHumanAuditEntry`/`writeMachineAuditEntry`/`writeSystemAuditEntry`
  - [x] `GET /ready` `warnings` array extension (additive, backward-compatible)
- [x] **Task 7 — Key custody risk alerting (D8, AC-19, AC-20)**
  - [x] Weekly `key-custody:check` job + startup check (`boss.send` with `singletonKey` on every `onVaultUnsealed`)
  - [x] Trigger (a): file KMS + backup enabled
  - [x] Trigger (b): `key_rotated_at` age exceeds `KEY_ROTATION_MAX_AGE_DAYS`
  - [x] Combined-trigger payload merging; cross-org fan-out to every org owner; `/ready` warning wiring
- [x] **Task 8 — Operational logging (AC-25)**
  - [x] New `OperationalEvent` constants; wire calls throughout settings/org/audit-storage/key-custody paths
- [x] **Task 9 — Env var validation (AC-21)**
  - [x] `AUDIT_LOG_STORAGE_LIMIT_GB`, `KEY_ROTATION_MAX_AGE_DAYS` in `apps/api/src/config/env.ts` (and `.env.example`)
- [x] **Task 10 — Scheduling** — registered `audit-storage:check` (daily, 04:00), `key-custody:check` (weekly, Monday 05:00 + startup singleton), `resource-usage:check` (hourly) under `onVaultUnsealed` in `apps/api/src/main.ts`
- [x] **Task 11 — OpenAPI spec** — ran `generate-spec`; committed updated `packages/shared/openapi.json`; added an explicit `tags: ['Platform Admin']` to each of the five new routes' schemas (no pre-existing route in this codebase set a `tags` field at all — this is additive, does not disturb any other route's untagged status) (AC-27)
- [x] **Task 12 — Integration tests (AC-28)** — implemented; one explicit deviation documented in Dev Notes (recovery-token 73h-expiry case relies on Story 4.3's own existing, unmodified-endpoint test coverage rather than a duplicate test here, since `POST /auth/recovery/:token/complete` is reused verbatim, not modified)

---

## Dev Notes

### Architecture Compliance

- Follows the sealed-route/opt-out-not-opt-in principle exactly as Story 9.1 established: all six new routes use `requireOrgScope: false` as an explicit named flag (architecture.md "Cross-cutting concern composition").
- Reuses Story 9.1's `admin_alerts` table for every new alert type this story introduces (`key_custody_risk`, `resource.orgs_near_limit`, `audit_storage.warning`/`.critical`) — do **not** create a second platform-alert table (explicitly reserved against in Story 9.1's D3).
- Reuses the existing per-org notification routing/delivery pipeline (Story 3.2) for every alert that has a natural org owner (per-org `usersPerOrg`, audit storage cross-org fan-out, key custody cross-org fan-out) — only truly instance-wide-with-no-org-relevance alerts (`resource.orgs_near_limit`) skip that pipeline and live in `admin_alerts` only.
- `getPrimaryKey()` + `packages/crypto/src/aes.ts`'s `encrypt()`/`decrypt()` is reused for SMTP password at rest — the same primitive already used for credential values (`import-service.ts`), not a new key-derivation domain (contrast with Story 9.1's `getBackupKey()`, which needed an independent key lifecycle for a different reason — backup files must remain decryptable independent of the primary key's own rotation cadence; SMTP password has no such requirement).

### Project Structure Notes

- New backend module: `apps/api/src/modules/platform-admin/` — deliberately **not** added to the pre-existing `apps/api/src/modules/admin/` (org-scoped) module, per D2.
- New workers: `apps/api/src/workers/audit-storage-check.ts`, `apps/api/src/workers/key-custody-check.ts` — one file per job type, matching every existing worker in that directory.
- New schema files: `packages/db/src/schema/system-settings.ts`; modification to the existing `packages/db/src/schema/vault-state.ts` (add `key_rotated_at`).
- No `apps/web` changes in this story (API-only surface — see Product Surface Contract).

### Testing Standards Summary

- Vitest across all packages; most of this story's logic is platform-level (not org-scoped) so most tests query `system_settings`/`admin_alerts`/`organizations` directly rather than using `withTestOrg()`, mirroring Story 9.1's testing approach exactly — except the per-org alert paths (AC-13, cross-org fan-out in AC-16/19/20), which do need `withTestOrg()`/multi-org test fixtures to verify fan-out across more than one org.
- `route-audit.test.ts` (or a sibling `platform-admin-route-audit.test.ts`) must pass with all six new routes correctly classified, and must assert the D2 separation between `modules/admin/` and `modules/platform-admin/`.
- `check-rls-coverage.ts` must pass with `system_settings` correctly excluded.

### Previous Story Intelligence (Story 9.1 — Encrypted Backup & Restore, `ready-for-dev`, not yet `done`)

- Story 9.1 is the **direct prerequisite** for this story (D1) — its `is_platform_operator`/`requirePlatformOperator()`/`admin_alerts` primitives are reused verbatim, not reinvented. If picking this story up before 9.1 has merged, implement 9.1's Task 1/Task 2 first.
- Story 9.1's D3 explicitly reserves `admin_alerts.alertType` for this story's `key_custody_risk` value (`// (9.2 adds 'key_custody_risk')` comment already present in its documented schema) — confirming this story's reuse plan was anticipated by 9.1's author.
- Story 9.1's D7 (cross-org notification loop for instance-wide alerts, since per-alert-type routing is org-scoped) is the exact pattern this story reuses for audit-storage and key-custody alerts (AC-16, AC-19, AC-20) — do not reinvent a different fan-out mechanism.
- Story 9.1's D6 (interim operational-logging audit trail pending Story 9.4) applies identically to this story's platform-operator actions (AC-25) — same limitation, same forward-reference discipline.
- Story 9.1's AC-16 (sealed-vault guard needs zero new route-specific code) applies identically here (AC-26).

### Git Intelligence (Recent Commits)

- No commit yet touches `packages/db/src/schema/system-settings.ts`, `apps/api/src/modules/platform-admin/`, or `vault_state.key_rotated_at` — greenfield within an otherwise mature codebase, same as Story 9.1's own greenfield note.
- `apps/api/src/modules/admin/routes.ts` (existing, org-scoped) is the file most likely to cause confusion (D2) — read it before writing this story's routes, specifically to understand what **not** to copy.
- `apps/api/src/modules/auth/service.ts`'s `allocateOrganizationSlug()`/`resolveRegistrationOrg()` (lines ~214-278) are the direct precedent for D7's org-creation logic — read this file before implementing `POST /admin/orgs`.
- `packages/db/src/schema/account-recovery-tokens.ts`'s `initiatedBy IN ('self','admin')` check already accepts `'admin'` — no schema change needed to reuse this table for D7's new-owner-invite flow.

### Cross-References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.2: System Settings, Multi-Org & Resource Monitoring] (lines ~2035-2063) — literal AC text this story's ACs are derived from, with D1-D9 documenting where this story's implementation deviates from or extends that literal text.
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 9: Platform Operations, API & Self-Hosting] (preamble, lines ~1989-2001) — FR coverage, AC-E9c (org provisioning mechanism), AC-E9d (key custody risk trigger conditions).
- [Source: _bmad-output/planning-artifacts/prd.md#Project & Organization Management] (FR6) and [#Tenant Model] (org-aware schema, tenant isolation) and [#System Administration] (FR86, FR87) and [#Security & Authentication] (master key architecture, lines ~516-518).
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — retro action item E3-1 (SMTP env-var-vs-system-settings resolution, directly informs D3).
- [Source: _bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md] — D1 (platform-operator primitive), D3 (`admin_alerts`/`backup_runs` tables, `key_custody_risk` reservation), D6/D7 (operational-logging + cross-org alert-routing patterns), AC-12/AC-16 (idempotent alert + sealed-guard precedents) — this story's single most load-bearing dependency.
- [Source: _bmad-output/implementation-artifacts/4-1-team-invitations-and-role-assignment.md] and [4-3-account-deactivation-and-recovery.md] — `account_recovery_tokens` mechanism reused by D7 for new-org-owner invites; invitation TTL precedent (72h).
- [Source: _bmad-output/planning-artifacts/architecture.md] — org-aware schema/RLS enforcement (lines ~69-70, 277-282), `check-rls-coverage.ts`/`EXCLUDED_TABLES` pattern, `SecureRoute`/`requireOrgScope` composition.
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules (G1-G4) applied above.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

### Open Questions (for Epic 9 sprint planning / retrospective — not blockers to `ready-for-dev`)

1. No story currently scopes a system-settings/multi-org/resource-usage admin web UI (Product Surface Contract gap — same pattern as Story 9.1 and Epic 8's stories; must be raised at Epic 9 retro per G2).
2. D7's "resend invite" gap: if a new-org-owner's `account_recovery_tokens` link expires unused, there is no dedicated "resend" endpoint in this story's scope — the platform operator's only documented workaround is to re-trigger `POST /api/v1/auth/recovery/request { email }` manually (the existing self-service recovery-request endpoint, which works for any user regardless of how their account was created). Confirm this workaround is sufficient or scope a dedicated resend endpoint in a future story.
3. D8's key-rotation-execution gap: no story yet ships a code path that updates `vault_state.key_rotated_at` — Story 9.5's manual runbook procedure is documentation-only. A future story must decide whether to (a) add a minimal admin endpoint that lets an operator record "I manually rotated the key" (updating the timestamp without automating rotation itself), or (b) leave the age-based alert permanently tied to `initialized_at` until true rotation automation ships.
4. AC-14's instance-wide `resource.orgs_near_limit` alert currently has no notification-delivery destination (admin_alerts row only, no email/Slack) since there is no "platform operator's own notification preferences" concept yet — confirm whether this is acceptable for v1 or whether a minimal "notify the platform operator's own email" delivery path should be added.
5. Story 9.4 (Platform Operator Audit Log, not yet written) must retroactively add `platform_audit_events` coverage for this story's actions (settings updates, org creation) — flag explicitly when 9.4 is created, and additionally extend its audit-log-storage monitoring to cover the `platform_audit_events` table once it exists (D5).
6. **`maxUsersPerOrg` hard enforcement (D3):** v1 ships this as alert-only. A future story should decide whether to add a hard-enforcement check to every org-join path (project-invitation acceptance, `POST /admin/orgs` existing-user path) once there's real-world signal on whether alert-only is sufficient operator control.
7. **Per-org audit-storage rate limiting / quotas (D10):** this story's maintenance-mode circuit breaker (AC-17) is instance-wide, so any single org's audit-write volume can push every other org into suspended (routine) audit writes. D10 mitigates this by (a) never suppressing security-critical event types and (b) attributing storage growth to specific orgs in the alert payload — but does not add actual per-org rate limits or quotas. Scope a dedicated follow-up story (candidate: Epic 9 retro, or bundled into Story 9.4) to evaluate per-org write-rate caps or `audit_log_entries` partitioning if this proves to be an actual operational problem.

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-5 (Claude Code)

### Debug Log References

- **Pre-existing bug found and fixed:** `allocateOrganizationSlug()` (`apps/api/src/modules/auth/service.ts`) retried its slug-collision insert in the *same* outer transaction with no SAVEPOINT — a Postgres unique-violation on attempt N aborts the entire transaction (`25P02`), so attempt N+1's otherwise-valid insert always failed too. This is latent in the original registration flow as well (any self-registration slug collision would have hit it), but no prior story's test forced two attempts within one transaction. Fixed by wrapping each attempt in `tx.transaction(savepointTx => ...)` (a real SAVEPOINT), same pattern already used a few lines below for the platform-operator bootstrap race. Surfaced by this story's own AC-8 "duplicate org name" edge case and AC-23 concurrent-creation test.
- **Same class of bug, second instance:** `createOrg()`'s new-user-insert branch had the identical problem — a `users.email` unique-violation (AC-23's deliberate race) aborted the outer transaction, so the "retry as existing user" fallback query in the `catch` block also failed with `25P02`. Fixed the same way (SAVEPOINT around the insert attempt).
- **Migration bug found and fixed:** `vault_state`'s append-only trigger (`0003_vault_state.sql`, Red Team hardening) blocks ALL `UPDATE`/`DELETE` unconditionally — including from the `postgres` superuser role running migration `0040`'s `key_rotated_at` backfill. There is no role-based bypass, only a test-only `app.vault_test_reset` GUC. Fixed by bracketing the backfill `UPDATE` with `ALTER TABLE vault_state DISABLE/ENABLE TRIGGER vault_state_no_update` inside the migration itself (a legitimate one-time schema-level exception, not reuse of the test-only GUC). This was masked in local dev because the test DB's `vault_state` was empty at migration time (0 rows matched); would have hard-failed against any real initialized instance.
- **Test-hygiene bug found and fixed mid-session:** an early version of `audit-storage-check.test.ts` left an active `audit_storage.critical` admin_alerts row (the maintenance-mode flag, D10/AC-17) in the shared test database with no cleanup. Since every `writeHumanAuditEntry`/`writeMachineAuditEntry`/`writeSystemAuditEntry` call across the *entire* codebase checks this flag, a full-suite run picked up the leftover row and silently suppressed routine audit writes in ~24 unrelated test files (rotation, search, etc.), producing ~68 spurious failures. Fixed with an explicit `afterAll` cleanup in that test file (and defensively in `key-custody-check.test.ts`/`resource-usage-check.test.ts` for the analogous, lower-risk case). Re-ran the full suite after the fix to confirm.
- **Test-hygiene bug found and fixed (unrelated to the above):** `maintenance-mode.test.ts`'s security-critical-event assertion originally called `writeHumanAuditEntry` with `actorTokenId: null` to prove the row is written during maintenance mode — this created a permanent (append-only, unrepairable) `check-audit-actor-token-coverage` gap in the shared DB. Fixed by using a real test user + identity token (`createTestUser` + `firstActorTokenIdForUser`) instead of `null`.

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide for Story 9.2 covering: a hard sequencing dependency on Story 9.1's not-yet-implemented platform-operator primitives (D1), a genuine `/admin` URL-prefix authorization-semantics collision with the existing org-scoped admin module that could otherwise become a privilege-escalation bug (D2), a new runtime-configurable system-settings store that must not break the existing env-var-only fallback per an already-closed retro action item (D3, D4), a genuine epics.md table-name mismatch that would have silently monitored a nonexistent table (D5), a justified addition of an org-listing endpoint beyond epics.md's literal write-only scope (D6), a wholly new multi-org owner-provisioning flow designed to reuse three existing mechanisms instead of inventing a competing invitation system (D7), and an honest accounting of the master-key-rotation-execution gap this story's custody-risk alerting depends on but does not itself close (D8).
- **AC count discrepancy:** AC-1's own text and Task 2 both say "six new endpoints" / "all six routes," but the concrete list given (`GET`/`PUT /admin/settings`, `POST`/`GET /admin/orgs`, `GET /admin/resource-usage`) is five routes, not six. Implemented exactly the five concretely specified; did not invent a sixth to match the prose count. Flagging for whoever reviews this story in case a sixth route was intended but never specified.
- **Deviation from the story's literal AC-3 status code:** AC-3's negative examples show `400` for validation errors. This codebase's existing, pervasive convention (every other route, via `parseBody`/`validationError`) uses `422` for validation errors, never `400`. Implemented `422` for consistency with the rest of the codebase (AGENTS.md's "reconcile contradictions rather than layering shims" guidance) rather than introducing the only `400`-returning validation path in the app. `org_limit_reached` correctly uses `422` per AC-10's own text, so this is isolated to the validation-error code specifically.
- **Deviation from AC-3/AC-22's literal implementation note:** "`SELECT ... FOR UPDATE`" is not used for the settings upsert, since the singleton row may not exist yet on the very first `PUT` (a nonexistent row cannot be locked). Used `pg_advisory_xact_lock` keyed on the row's constant identity instead — same serialization guarantee (all concurrent PUTs queue on the lock, each doing a full read-modify-write), verified by an integration test firing two concurrent PUTs with non-overlapping fields via `Promise.all` and asserting both land.
- D7's new-owner-invite flow reuses the `account_recovery_tokens` table/hashing/HMAC primitives (`generateRecoveryToken`/`hashRecoveryToken`) directly rather than calling the existing `sendAdminRecoveryLink()` helper, because that helper hardcodes a 15-minute TTL (Story 4.3's self-service/admin-reset use case) and expects the *initiator's* org as the email-delivery routing context — this story needs a 72h TTL (D7, matching Story 4.1's invitation TTL) and must route the email through the *new* org's notification context (the new owner has no other org membership yet). Did not modify `sendAdminRecoveryLink()` to add a TTL parameter, to avoid touching an already-tested, in-production code path for an unrelated story; instead built a small sibling helper (`issueNewOwnerRecoveryLink` in `platform-admin/service.ts`) reusing the same low-level primitives.
- D7's "deactivated owner" check (AC-9 negative case) is interpreted as: every `org_memberships` row this user holds, instance-wide, has `status = 'deactivated'` (i.e., no active membership anywhere). Deactivation in this codebase is per-org-membership, not a global user flag, so this is the closest honest reading of "an existing but deactivated user" — flagged as an interpretation, not a literal spec, since epics.md doesn't define a global deactivation concept.
- D10's `topContributingOrgs` byte-size figures are an approximation (`audit_log_entries`' current average row size × that org's row growth in the last 24h), not an exact per-row byte count (not tracked). Documented in code comments; matches AC-E2f's "no fake numbers" discipline by being a real, derived estimate rather than a fabricated placeholder.
- AC-27's OpenAPI "distinct tag" requirement required introducing `tags: [...]` on a Fastify route schema for the first time in this codebase — no other route (including Story 9.1's backup/restore routes, or the pre-existing `modules/admin/` routes) sets a `tags` field at all. Added it only to this story's five routes; did not retrofit tags onto any other existing route.
- Two genuine, pre-existing bugs in reused primitives were found and fixed during TDD (see Debug Log References): a missing-SAVEPOINT bug in `allocateOrganizationSlug()`'s slug-collision retry (and the analogous bug in this story's own new-user race-retry path), and a migration that would have failed against any real (non-empty) `vault_state` row due to the append-only trigger having no schema-migration bypass. Both are fixed at the root, not worked around locally.
- **Deferred, not implemented:** a dedicated unit test asserting the exact `AUDIT_LOG_STORAGE_LIMIT_GB`/`KEY_ROTATION_MAX_AGE_DAYS` env-var validation (rejects negative/non-numeric values) beyond the zod schema definition itself — the schema entries exist and are exercised indirectly (every integration test boots the app, which runs full env validation at startup), but no standalone `env.test.ts` case names these two vars explicitly. Low risk (the zod schema is a direct, simple `.positive()`/`.int().positive()` constraint matching the exact pattern of a dozen other env vars already covered by the same generic test style), flagged for a fast follow if desired.
- **Deferred, not implemented:** a log-capture assertion that `PLATFORM_SETTINGS_UPDATED`/`PLATFORM_ORG_CREATED` are actually emitted (the call sites exist and are exercised by every settings/org integration test, but no test captures and inspects the log line itself, unlike `health.test.ts`'s `createLogCaptureStream` pattern). Flagged for a fast follow.
- AC-9's "73 hours later, token expired" edge case is not independently re-tested here — `POST /api/v1/auth/recovery/:token/complete` is Story 4.3's existing, completely unmodified endpoint, and its expiry behavior is already covered by Story 4.3's own test suite. Re-testing it here would duplicate coverage of code this story does not touch.

### File List

**New files:**
- `packages/db/src/schema/system-settings.ts`
- `packages/db/src/schema/system-settings-schema.test.ts`
- `packages/db/src/migrations/0040_system_settings_and_key_rotation.sql`
- `apps/api/src/modules/platform-admin/schema.ts`
- `apps/api/src/modules/platform-admin/service.ts`
- `apps/api/src/modules/platform-admin/settings-routes.ts`
- `apps/api/src/modules/platform-admin/settings-routes.test.ts`
- `apps/api/src/modules/platform-admin/orgs-routes.ts`
- `apps/api/src/modules/platform-admin/orgs-routes.test.ts`
- `apps/api/src/modules/platform-admin/resource-usage-routes.ts`
- `apps/api/src/modules/platform-admin/resource-usage-routes.test.ts`
- `apps/api/src/modules/platform-admin/platform-admin-route-audit.test.ts`
- `apps/api/src/modules/platform-admin/sealed-guard.test.ts`
- `apps/api/src/modules/audit/maintenance-mode.ts`
- `apps/api/src/modules/audit/maintenance-mode.test.ts`
- `apps/api/src/workers/audit-storage-check.ts`
- `apps/api/src/workers/audit-storage-check.test.ts`
- `apps/api/src/workers/key-custody-check.ts`
- `apps/api/src/workers/key-custody-check.test.ts`
- `apps/api/src/workers/resource-usage-check.ts`
- `apps/api/src/workers/resource-usage-check.test.ts`
- `apps/api/src/lib/threshold-alerts.ts`
- `apps/api/src/lib/threshold-alerts.test.ts`
- `apps/api/src/__tests__/helpers/platform-operator-test-helpers.ts`
- `apps/api/src/__tests__/multi-org-session-isolation.test.ts`

**Modified files:**
- `packages/db/src/schema/vault-state.ts` (added `key_rotated_at` column)
- `packages/db/src/schema/index.ts` (export system-settings schema)
- `packages/db/src/check-rls-coverage.ts` (added `system_settings` to `EXCLUDED_TABLES`)
- `packages/db/src/migrations/meta/_journal.json` (0040 entry)
- `packages/shared/src/constants/notification-types.ts` (new alert types)
- `packages/shared/src/constants/operational-event-types.ts` (new operational events)
- `packages/shared/openapi.json` (regenerated)
- `apps/api/src/app.ts` (register three new platform-admin route modules)
- `apps/api/src/main.ts` (schedule `audit-storage:check`/`key-custody:check`/`resource-usage:check`)
- `apps/api/src/config/env.ts` (`AUDIT_LOG_STORAGE_LIMIT_GB`, `KEY_ROTATION_MAX_AGE_DAYS`)
- `.env.example`
- `apps/api/src/modules/auth/service.ts` (exported `allocateOrganizationSlug`/`isUniqueViolation`; fixed the SAVEPOINT bug in the slug-collision retry loop)
- `apps/api/src/modules/audit/human-entry.ts` (maintenance-mode interception point)
- `apps/api/src/modules/audit/machine-entry.ts` (maintenance-mode interception point, both writers)
- `apps/api/src/modules/admin/routes.ts` (updated for async `getEmailTransport()`/effective SMTP `from`)
- `apps/api/src/workers/notification-email.ts` (`getEmailTransport()` now async + settings-aware; added `invalidateEmailTransport()`)
- `apps/api/src/workers/notification-digest.ts` (updated for async `getEmailTransport()`/effective SMTP `from`)
- `apps/api/src/lib/route-exemptions.ts` (classifications for the five new routes + `workers/key-custody-check.ts`; also deduplicated pre-existing `'security-action'`/`'sensitive-read'` literals onto their already-defined-but-unused constants, fixing a jscpd/sonarjs violation this story's additions newly crossed the threshold for)
- `apps/api/src/routes/health.ts` / `apps/api/src/routes/health.test.ts` (`/ready` `warnings` field, AC-18)

## Change Log

- 2026-07-07 — Implemented Story 9.2 in full via TDD (red-green): `system_settings` schema/migration, `modules/platform-admin/` route family (settings, orgs, resource-usage), audit-storage maintenance-mode circuit breaker, key-custody risk alerting, per-org/instance-wide resource-usage threshold alerts, `/ready` warnings, scheduling, OpenAPI regen. Found and fixed two pre-existing SAVEPOINT bugs in `allocateOrganizationSlug()`/`createOrg()`'s race-retry paths, and a `vault_state` append-only-trigger migration bug. Status: ready-for-dev → review.
