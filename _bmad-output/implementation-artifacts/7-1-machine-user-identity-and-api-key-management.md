# Story 7.1: Machine User Identity & API Key Management

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for creating project-scoped machine user identities and issuing/revoking their API keys. This is the FIRST story in Epic 7 and the schema/crypto foundation Stories 7.2 (machine authentication + programmatic retrieval) and 7.3 (GitHub Actions integration) build on. Read "Key Design Decisions & Open Questions" before coding — this story resolves several concrete conflicts between epics.md's literal Story 7.1 AC text and architecture.md's canonical technical decisions, always in favor of architecture.md + established codebase precedent, mirroring the resolution pattern Story 4.1 set for Epic 4. -->

## Story

As an administrator provisioning programmatic access,
I want to create machine user identities with scoped project roles and issue API keys with expiry dates,
so that CI/CD pipelines and applications can access secrets without using human user credentials.

*Covers: FR32, FR33, FR36, FR68.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.1` (lines 1766-1791)]

**Out of scope for this story (belongs to later stories — do not implement here):**
- Machine user *authentication* (`POST /api/v1/auth/machine-token`), programmatic secret retrieval, offline fallback cache, zero-downtime key rotation, emergency revocation, and dormancy detection — all **Story 7.2** (FR34, FR35, FR37, FR38, FR101, FR110).
- `GET /api/v1/projects/:projectId/machine-users/active-keys` (the project-archival guard stub from Story 4.4) — explicitly assigned to **Story 7.2** in epics.md (`epics.md:1824`). Story 4.4 already ships a permanent stub (`hasActiveMachineUserKeys()` returning `false`, comment `// TODO: Epic 7 — check for active machine user API key access`, `4-4-project-archival.md:324-336`) that this story must **not** touch — the `machine_users`/`api_keys` tables this story creates are exactly what that stub will eventually query, but wiring it up is 7.2's job.
- The GitHub Actions action package (`packages/vault-action`) — **Story 7.3** (FR39).

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — machine users are provisioned and consumed by CI/CD tooling, not exercised in a human evaluator's UI walkthrough in v1 |
| **Linked UI story** (if API-only) | `TBD` — **blocking note:** no story in Epic 7 (7.1/7.2/7.3) or any other epic currently scopes a web UI for machine-user management, despite `architecture.md`'s Requirements-to-Structure mapping listing an aspirational frontend route `(app)/projects/[id]/machine-users/` (`architecture.md:892`). This is a genuine planning gap, not a decision this story can resolve — flagged as an open question below and in the completion report. Until a UI story exists, org admins manage machine users exclusively via the REST API (curl / `pnpm --filter api generate-spec` published OpenAPI doc) |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none is being built at all yet for this surface. Do not add a partial/stubbed SvelteKit page in this story — that would create dead route code with no linked follow-up story to finish it |
| **Persona journey** | N/A — API-only, no evaluator-visible UI in this story. Rationale: FR32/FR33/FR36/FR68 describe an administrator calling a REST API to provision programmatic access for pipelines; there is no human end-user journey through a web surface for this story's scope |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These resolve concrete conflicts between epics.md's literal Story 7.1 wording, `architecture.md`'s canonical decisions, and the actual shipped codebase. This mirrors the resolution pattern established in Story 4.1 (`4-1-team-invitations-and-role-assignment.md`, "Key Design Decisions & Open Questions" / "Architecture Conflict Resolution" sections) — actually-shipped code and `architecture.md`'s explicit "AI Agents MUST" / "Anti-Patterns" lists win over an epics.md AC's literal-but-unshipped spec.

### D1 — API key hashing algorithm: epics.md says BLAKE2b, architecture.md says HMAC-SHA256 — **use HMAC-SHA256**

- **epics.md** (`epics.md:1780,1806`) specifies: 256-bit `node:crypto.randomBytes(32)`, base62-encoded (44 chars), prefixed `pvk_`; hashed with **BLAKE2b**, stored in a table called `machine_user_api_keys`.
- **architecture.md** (`architecture.md:604-607,802-809,916,1200`) is unambiguous and repeated in multiple independent sections: *"API keys / tokens (HMAC-SHA256): fast, sufficient for 256-bit entropy, no brute-force surface"*; `architecture.md:869` lists **"Argon2id for API key / token hashing"** as an explicitly **forbidden anti-pattern** (HMAC-SHA256 is required instead); the canonical table name is `api_keys` with an explicit `hmac_key_version integer NOT NULL DEFAULT 1` column "required for HMAC secret rotation" (`architecture.md:537,916`).
- **Code reality:** every existing high-entropy token in this codebase (`refresh_tokens.token_hash`, `pending_mfa_sessions`, account-recovery tokens) uses the exact same pattern — `createHmac('sha256', <per-purpose-env-secret>).update(token).digest('hex')` + `timingSafeEqual()` — implemented in `apps/api/src/modules/auth/tokens.ts:46-67` (`generateRefreshToken`/`hashRefreshToken`/`refreshTokensMatch`) and validated per-secret in `apps/api/src/config/env.ts` (see D3). **No BLAKE2b usage exists anywhere in this codebase.** Introducing a second, different hashing primitive for one table would violate the "no bare crypto primitive drift" spirit of `architecture.md`'s Enforcement Guidelines and create an inconsistent security review surface.
- **Decision implemented in this story:** API keys are hashed with **HMAC-SHA256**, following the exact `auth/tokens.ts` pattern (new file `apps/api/src/modules/machine-users/tokens.ts` with `generateApiKey()`, `hashApiKey()`, `apiKeysMatch()`). The table is named `api_keys` (architecture-canonical), not `machine_user_api_keys`. A `hmacKeyVersion integer NOT NULL DEFAULT 1` column is included per architecture's explicit mandate even though epics.md never mentions it — this is a real requirement for future HMAC secret rotation, not optional polish.

### D2 — API key format: epics.md says `pvk_` + base62, architecture.md says `pk_` + base64url — **use `pk_` + base64url**

- Same conflict category as D1, and the **exact same resolution Story 4.1 already made** for its invitation token (`4-1-team-invitations-and-role-assignment.md` D6): *"reuse the exact `randomBytes(32).toString('base64url')` ... pattern, not a hand-rolled base62 encoder. Entropy target (256-bit) is met either way ... keeps one crypto helper pattern in the codebase instead of two."*
- **Decision implemented in this story:** `generateApiKey()` returns `` `pk_${randomBytes(32).toString('base64url')}` `` (architecture-canonical prefix, `architecture.md:604-607`; 46 chars total — `pk_` is 3 chars + unpadded base64url of 32 bytes is 43 chars). Do not implement a base62 encoder.

### D3 — New per-purpose HMAC secret: `API_KEY_HMAC_SECRET`

- Following the exact pattern of `REFRESH_TOKEN_HMAC_SECRET` / `MFA_PENDING_SESSION_HMAC_SECRET` / `INVITATION_TOKEN_HMAC_SECRET` / `RECOVERY_TOKEN_HMAC_SECRET` in `apps/api/src/config/env.ts` (lines 1-115+), add:
  - `API_KEY_HMAC_SECRET` to the env schema (required in production; a dev default constant `DEV_API_KEY_HMAC_SECRET = 'g'.repeat(64)` alongside the existing `DEV_*_HMAC_SECRET` constants at the top of `env.ts`).
  - A `validateApiKeyProductionSecret(env, ctx)` function mirroring `validatePendingMfaProductionSecret` (`env.ts:83-107`): required in production, must differ from every other HMAC/session secret already in production use, must not match `PLACEHOLDER_SECRET_PATTERN` (`/change-me|dev-only|placeholder/i`).
  - Wire the new validator into whichever `superRefine`/`ProductionEnv` aggregation currently chains `validateTotpReplayProductionSecret` / `validatePendingMfaProductionSecret` (read the end of `env.ts` to find the exact call site before editing).
  - Add `API_KEY_HMAC_SECRET=` to `.env.example` near the other `*_HMAC_SECRET` entries.
- **This is a required architectural item, not optional** — `architecture.md:841` ("Use per-environment `apiKeyHmacSecret` — config validation rejects defaults in prod") is in the "All AI Agents MUST" list.

### D4 — Where does `role` (member/viewer) live: a new column on `machine_users`, or reuse `project_memberships`?

- **architecture.md**'s canonical entity table (`architecture.md:923`) has one line: *"Project members | `project_memberships` | User/machine-user ↔ project + role"* — implying machine users might share the existing `project_memberships` table.
- **Code reality:** `project_memberships` (`packages/db/src/schema/project-memberships.ts`) has a composite PK `(projectId, userId)` with `userId` as a **`NOT NULL` FK to `users(id)` ON DELETE CASCADE**. This table is already shipped and load-bearing for Stories 2.1, 4.1, 4.2, 4.3, 4.4 (ownership transfer, member listing, invitation acceptance, archival guards all query it directly). Retrofitting a nullable `machineUserId` alongside a nullable `userId` (with a CHECK that exactly one is set) would require touching every one of those five stories' query sites and risk regressions in already-`done` epics — a large, unjustified blast radius for a single architecture-doc table aside versus...
- **epics.md's Story 7.1 AC is concrete and unambiguous** (`epics.md:1777-1778`): the `machine_users` insert payload is `{ name, role: "member"|"viewer", description? }` and the resulting record has `role` as a direct column, scoped to exactly one `projectId` per machine user (the endpoint itself is `POST /api/v1/projects/:projectId/machine-users` — project-nested, not org-wide).
- **Decision implemented in this story:** `role` is a **direct column on `machine_users`**, restricted by a CHECK constraint to `('member','viewer')` only (no `'owner'`/`'admin'` — machine identities never get project-admin rights; matches epics.md's literal enum and is the safer default). `machine_users` does **not** insert into `project_memberships` and `project_memberships` is **not modified** by this story. Each machine user belongs to exactly one project (`projectId` NOT NULL FK), matching the epics' project-nested creation endpoint. If a future story needs a machine user with access to multiple projects, that is an explicit schema change for that story to make, not something to speculatively build here.

### D5 — Who may create/manage machine users: org role vs. project role gate

- epics.md's precondition is *"Given an org admin is authenticated with MFA enrolled"* (`epics.md:1776`). Read literally this could mean either the caller's **org-wide** role or their role **within the target project**.
- **Code reality:** `SecureRoute`'s `security.minimumRole` / `allowedRoles` check exclusively against `request.authContext.orgRole` (`apps/api/src/lib/secure-route.ts:190-195`, `hasSufficientRole`), which is populated at authentication time from **`org_memberships.role`** (`apps/api/src/plugins/authenticate.ts:121-140`, `loadOrgRole`) — a single org-wide value, **not** looked up per-project. This is exactly how `POST /api/v1/projects/:projectId/archive` and other admin-only project-scoped mutations are gated today (`minimumRole: 'admin'` with a comment *"org-level floor"* — `apps/api/src/modules/projects/routes.ts:831`).
- **Decision implemented in this story:** gate all machine-user/API-key mutation routes with `security: { minimumRole: 'admin', requireMfa: true }` — org-wide admin-or-owner role, MFA-enrolled (grace period respected, same as every other `requireMfa: true` route; there is **no** entry in `mfa-policy-matrix.md` for machine users, unlike Story 4.1's invite gate, so there is no basis for inventing a stricter grace-period-ignoring check here — do not copy 4.1's `requireMfaEnrollmentStrict()` pattern without a matrix entry justifying it). This matches epics.md's literal "org admin" wording exactly and needs no new authorization primitive.

### D6 — Expiry alert job: reuse the existing shared expiry-alert runner instead of hand-rolling a new one

- `apps/api/src/workers/expiry-alert-shared.ts` already implements exactly the firing/dedupe/failure-isolation logic epics.md's AC describes for `machine_key.expiry` (`epics.md:1784`: *"a pg-boss daily job checks `machine_user_api_keys` for keys expiring within `alertLeadDays` (default: `[14, 3]`)"*) — this is used identically by `cert-expiry-alert.ts`, `domain-expiry-alert.ts`, and `payment-expiry-alert.ts`, all driven by an `alertLeadDays`/`notifiedLeadDays` jsonb-array pair on the row (see `cert-records.ts:20-27`).
- **Decision implemented in this story:** `api_keys` gets its own `alertLeadDays jsonb NOT NULL DEFAULT '[14, 3]'::jsonb` and `notifiedLeadDays jsonb NOT NULL DEFAULT '[]'::jsonb` columns (matching the `certRecords`/`paymentRecords`/`domainRecords` precedent exactly), and a new `apps/api/src/workers/machine-key-expiry-alert.ts` calls `runExpiryAlertJob<Row>()` with a joined query (see AC-14) rather than duplicating the fetch/fire/dedupe loop. **Do not write a bespoke expiry-alert loop for this table** — that would be exactly the "reinventing wheels" mistake this workflow is designed to prevent.
- `machine_key.expiry` and `machine_cache.activated` are **already present** in `packages/shared/src/constants/notification-types.ts`'s `NOTIFICATION_ALERT_TYPES` array (lines 10, 12) — added in anticipation of Epic 7. No changes are needed there. `machine_cache.activated` is Story 7.2's concern (offline cache activation) — do not use it in this story.
- No new email/Slack template is required: `certificate.expiry`/`domain.expiry`/`payment.expiry` all render via the **generic fallback renderer** in `apps/api/src/notifications/templates/index.ts:95-106` (no bespoke entry in `EMAIL_RENDERERS`). Follow the same precedent for `machine_key.expiry` — do not add a bespoke template file unless product feedback later asks for one.

### D7 — Audit event naming: lowercase-dotted `machine_user.*` family, not architecture.md's `MACHINE_USER_CREATED` constant literal

- `architecture.md:558-561` shows illustrative `AuditEvent` constants in `UPPER_SNAKE_CASE` (`MACHINE_USER_CREATED`, `API_KEY_ISSUED`, `API_KEY_REVOKED`).
- **Code reality:** `packages/shared/src/constants/audit-events.ts` has already diverged from that illustrative style for every feature shipped since Epic 2 — the actual convention is lowercase, dot-namespaced, `{noun}.{verb}` (`project.created`, `credential.value_revealed`, `project.invitation_accepted`, `org.user_deactivated`). This is the exact same divergence Story 4.1 documented and resolved the same way (`4-1-team-invitations-and-role-assignment.md`, Architecture Conflict Resolution table, row 1).
- **Decision implemented in this story:** add three new constants to `AuditEvent` (and the corresponding `AuditEventType` union) in `packages/shared/src/constants/audit-events.ts`:
  ```typescript
  MACHINE_USER_CREATED: 'machine_user.created',
  MACHINE_USER_API_KEY_ISSUED: 'machine_user.api_key_issued',
  MACHINE_USER_API_KEY_REVOKED: 'machine_user.api_key_revoked',
  ```
  (Purely additive — do not rename or touch any existing entry.)

### D8 — `api_keys` RLS: standard org-scoped policy now, explicit "RLS-exception" flag for 7.2 to resolve

- Story 7.2's machine-token exchange endpoint (`POST /api/v1/auth/machine-token`) must look up an `api_keys` row by `keyHash` **alone** — before it knows which org the caller belongs to (that's the entire point of authenticating with an opaque key). `architecture.md` documents exactly this chicken-and-egg problem for `sessions`/`refresh_tokens` and explicitly carves them out as "RLS exception tables," accessed only via `withAdminAccess()` rather than the normal org-scoped RLS session context.
- **Decision implemented in this story:** `api_keys` still gets the standard org-scoped `api_keys_isolation` RLS policy in AC-2 — every read/write this story implements (list, issue, revoke) always has an authenticated caller with a known `orgId`, so the standard policy is correct for 7.1's own endpoints. **This story explicitly does not resolve** whether the table needs `sessions`/`refresh_tokens`-style RLS-exception treatment for 7.2's pre-auth hash lookup — that decision belongs to 7.2, which owns the endpoint that needs it, and must read this section before writing its lookup query. Flagged here so it is a known, named handoff rather than a decision 7.2 discovers cold.
- **Action for 7.2:** before implementing the token-exchange lookup, confirm whether querying `api_keys` by `keyHash` under the standard RLS policy (with no org context set yet) returns zero rows by construction (in which case 7.2 needs `withAdminAccess()` or an equivalent bypass for that one query), and document the resolution in 7.2's own Key Design Decisions section.

### D9 — Audit table naming: epics.md says `audit_events`, actual shipped table is `audit_log_entries` — **use `audit_log_entries`**

- epics.md's Epic 7 preamble (PJ4) mandates that machine-user audit events land in a shared table named `audit_events`. The actual, already-shipped table every other epic writes to is `audit_log_entries` (`packages/db/src/schema/audit-log-entries.ts:8`).
- This is the same category of epics.md-vs-reality conflict as D1/D2/D7 (hashing algorithm, key format, event-name casing), resolved the same way: established, actually-enforced code wins over an epics.md literal that was never implemented under that name.
- **Decision implemented in this story:** all three new audit events (`machine_user.created`, `machine_user.api_key_issued`, `machine_user.api_key_revoked`) are written to the existing `audit_log_entries` table via `writeHumanAuditEntryOrFailClosed`, exactly like every other epic's audit events. No new table is created; `audit_events` as a table name does not exist anywhere in this codebase and this story does not introduce it.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 2.1 done** (`projects` table, org/project scoping conventions) | Machine users are project-scoped (`POST /api/v1/projects/:projectId/machine-users`); reuses the same `orgScoped()` + `projects` FK pattern. Confirmed `done` in `sprint-status.yaml`. |
| **Story 1.9/1.11/1.12 MFA + SecureRoute stack** | `requireMfa: true` gate reuses the existing (non-strict) `requireMfaEnrollment()` — no new primitive. Confirmed `done`. |
| **Story 3.1/3.2 notification queue + per-alert-type routing** | The expiry-alert job dispatches through `createOrgAdminNotificationEntries()` / `resolveRoutingRecipients()`, keyed on the already-reserved `machine_key.expiry` alert type. Confirmed `done`. |
| **Story 6.1 expiry-alert pattern** (`cert-expiry-alert.ts`/`expiry-alert-shared.ts`) | This story's expiry job is a thin config object passed to the same shared runner — read `apps/api/src/workers/cert-expiry-alert.ts` first as the template. Confirmed `done`. |
| **Migration numbering (verify, do NOT hardcode)** | Latest migration at story-creation time is `0028_monitoring_records.sql` (`packages/db/src/migrations/meta/_journal.json`, idx 28). **Before generating any migration, re-read `_journal.json` and use the next free number** — another story may land first. |
| `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS` | This story adds six new route entries (create, list, detail, issue-key, list-keys, revoke-key) covered by `route-audit.test.ts`. |
| `packages/db/src/check-rls-coverage.ts` | New org-scoped tables (`machine_users`, `api_keys`) must get RLS policies in the same migration or `check-rls` fails CI — do **not** add them to `EXCLUDED_TABLES`. |

---

## Epic Cross-Story Context

| Story | Relationship to 7.1 |
|---|---|
| 7.2 (Machine User Authentication & Programmatic Secret Retrieval, `backlog`) | Consumes `machine_users`/`api_keys` created here: the machine-token exchange endpoint (`POST /api/v1/auth/machine-token`) hashes an incoming `pk_...` key with **this story's `hashApiKey()`/`apiKeysMatch()`** and looks up `api_keys` by `keyHash`. **Must read D8 before implementing that lookup** — this story leaves open whether `api_keys` needs `sessions`/`refresh_tokens`-style RLS-exception treatment for a pre-auth, org-unknown lookup; 7.2 owns that decision. 7.2 also implements zero-downtime rotation, emergency revoke, dormancy detection, and the offline cache — none of that is built here. 7.2 also completes the Story 4.4 archival stub (`GET .../machine-users/active-keys`) against the tables this story creates. |
| 7.3 (GitHub Actions CI/CD Integration, `backlog`) | The published action authenticates using a `pk_...` key issued by this story's `POST .../api-keys` endpoint, via 7.2's token exchange. No direct schema/code dependency on 7.1 beyond the key format. |
| 4.4 (Project Archival, `done`) | Ships a permanent stub `hasActiveMachineUserKeys()` returning `false` with `// TODO: Epic 7 — check for active machine user API key access` (`4-4-project-archival.md:324-336`). This story does **not** wire that stub up — 7.2 does. Do not touch `apps/api/src/modules/projects/archival-guards.ts` (or wherever that stub lives — confirm exact path before starting) in this story. |
| 6.1 (Service/Certificate/Domain Record Management, `done`) | Source of the `alertLeadDays`/`notifiedLeadDays` jsonb-array expiry-alert pattern (D6) and `expiry-alert-shared.ts` this story's pg-boss job reuses verbatim. |
| Epic 8 (Compliance/Audit, `backlog`) | PJ4 (`epics.md:1760`): machine user audit events must land in the **same** `audit_log_entries` table as every other epic (already true here — `writeHumanAuditEntryOrFailClosed` writes to `audit_log_entries`, the single shared table; `actorType` stays `'human'` for this story since the actor is always the human admin performing the mutation — `actorType: 'machine_user'` only appears once 7.2 ships machine-authenticated secret reads). No new table is created for audit; Epic 8 builds query/export UI on top of the same table this story writes to. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 7.1 | Rationale |
|---|---|---|
| epics.md: hash with BLAKE2b, table `machine_user_api_keys` | HMAC-SHA256, table `api_keys` (see D1) | architecture.md is explicit and repeated; matches every existing token in the codebase; BLAKE2b appears nowhere else |
| epics.md: `pvk_` prefix + base62 encoding | `pk_` prefix + `randomBytes(32).toString('base64url')` (see D2) | architecture.md canonical format; identical resolution to Story 4.1's invitation-token conflict |
| architecture.md: illustrative `AuditEvent` constants in `UPPER_SNAKE_CASE` | Lowercase dotted `machine_user.*` family, added to the already-shipped `audit-events.ts` convention (see D7) | Matches every audit event shipped since Epic 2; identical resolution to Story 4.1 |
| architecture.md generic error envelope `{ error, message, statusCode, requestId }` | Use `{ code, message, details? }` — matches `ApiErrorSchema` (`packages/shared/src/schemas/api.ts:37-43`) and every route in `modules/projects/routes.ts` | `ApiErrorSchema` is the actually-enforced, actually-typed contract; the architecture doc's example predates it (same resolution as Story 4.1) |
| architecture.md module layout `routes.ts/service.ts/schema.ts/repository.ts` | New `modules/machine-users/{routes.ts, schema.ts, tokens.ts}` — no forced `service.ts`/`repository.ts` split | Matches `modules/projects/`, `modules/invitations/` precedent; inventing an unused 4-file layout adds inconsistency, not clarity |
| architecture.md: "Project members `project_memberships` — User/machine-user ↔ project + role" | `role` is a direct column on the new `machine_users` table; `project_memberships` is untouched (see D4) | Avoids a high-risk schema change to a table load-bearing for 5 already-`done` stories; epics.md's concrete AC is unambiguous and lower-risk |
| architecture.md: 400 for validation errors | 422, matching every route in this codebase (`ProjectCreateResponseSchema`/`ApiErrorSchema` 422 responses throughout `modules/projects/routes.ts`, `modules/credentials/routes.ts`) | Established, actually-enforced convention |
| architecture.md: `sessions`/`refresh_tokens` are carved out as RLS-exception tables for pre-auth lookups | `api_keys` keeps the standard org-scoped RLS policy in this story; whether it also needs RLS-exception treatment for 7.2's by-hash lookup is an explicit open handoff, not resolved here (see D8) | 7.1 has no pre-auth lookup of its own; inventing a bypass for a query this story doesn't implement would be speculative |
| epics.md (PJ4): shared audit table named `audit_events` | `audit_log_entries` (already-shipped table every other epic writes to) (see D9) | Same resolution pattern as D1/D2/D7 — established code over an unimplemented epics.md literal |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | New migration: `machine_users` table (project-scoped, `role` CHECK `('member','viewer')`) + `api_keys` table (org-scoped via `machineUserId` FK, `keyHash`, `hmacKeyVersion`, `alertLeadDays`/`notifiedLeadDays`). Both get RLS policies in the same migration. |
| POST `/api/v1/projects/:projectId/machine-users` | `minimumRole: 'admin'`, `requireMfa: true`. Creates a machine user; response includes an explicit `{ canAccess, cannotAccess }` scope-boundary block (UX-DR11) before any key exists. `422` on invalid role/name; `404` on cross-org or archived-but-nonexistent project. |
| GET `/api/v1/projects/:projectId/machine-users` | `minimumRole: 'viewer'`. Lists machine users in the project; empty array if none; org-isolated. |
| GET `/api/v1/machine-users/:machineUserId` | `minimumRole: 'viewer'`. Single machine-user detail (flat route, org-scoped lookup); `404` cross-org/not-found. |
| POST `/api/v1/machine-users/:machineUserId/api-keys` | `minimumRole: 'admin'`, `requireMfa: true`. Generates a `pk_...` key (256-bit, base64url), returns plaintext **once**, persists only the HMAC-SHA256 hash + `hmacKeyVersion`. `422` on past `expiresAt`; `404` on cross-org/not-found machine user. |
| GET `/api/v1/machine-users/:machineUserId/api-keys` | `minimumRole: 'viewer'`. Lists key metadata only — never `keyHash` or plaintext. |
| DELETE `/api/v1/machine-users/:machineUserId/api-keys/:keyId` | `minimumRole: 'admin'`, `requireMfa: true`. Sets `revokedAt`; idempotent on an already-revoked key (still `200`); `404` on not-found/cross-org. |
| Expiry alert | Daily pg-boss job `machine-key:expiry-alert` (cron `0 8 * * *`), reusing `runExpiryAlertJob()`; default lead days `[14, 3]`; alert type `machine_key.expiry`. |
| Audit | `machine_user.created`, `machine_user.api_key_issued`, `machine_user.api_key_revoked` — same-transaction, fail-closed via `writeHumanAuditEntryOrFailClosed`. Plaintext key is never included in any audit payload. |
| RLS / tenant isolation | `machine_users`/`api_keys` covered by `check-rls-coverage`; cross-org access to any endpoint returns `404`, never `403` (no resource-existence leak) or `200` with foreign data. |
| Rate limiting | Sensitive mutations (create, issue key, revoke key) rate-limited at `10/min` per admin **per route** (shared across every machine user that admin manages, not a separate budget per machine user), matching the `POST .../archive` precedent. |
| Concurrency | Two simultaneous key-issue calls both succeed with distinct keys; two simultaneous revoke calls on the same key both return `200` and the key ends up revoked exactly once (no double-audit-write race). |
| Migration safety | Purely additive migration; no existing table is altered; `EXCLUDED_TABLES` in `check-rls-coverage.ts` is untouched. |
| Integration tests | Cover every AC below: creation + scope boundary, validation errors, authz (org-role + MFA), tenant isolation, key issuance (plaintext-once), key listing (no hash leak), revocation (+ idempotent double-revoke), expiry-alert firing + dedupe + org isolation, audit-write-fails-closed, rate limiting, concurrent issuance/revocation, RLS coverage, route-audit coverage. |

---

### AC-1: Schema — `machine_users` Table

**Given** no machine-user infrastructure exists today,
**When** Story 7.1 is implemented,
**Then** a new Drizzle schema file `packages/db/src/schema/machine-users.ts` defines:

```typescript
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const machineUsers = pgTable(
  'machine_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    role: text('role').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('idx_machine_users_project').on(t.projectId),
    orgIdx: index('idx_machine_users_org').on(t.orgId),
    roleCheck: check('machine_users_role_check', sql`${t.role} IN ('member','viewer')`),
    nameLenCheck: check(
      'machine_users_name_len_check',
      sql`char_length(${t.name}) BETWEEN 1 AND 128`
    ),
  })
)

export type MachineUser = typeof machineUsers.$inferSelect
export type NewMachineUser = typeof machineUsers.$inferInsert
```

**And** `deactivatedAt` is included per epics.md's literal field list (`epics.md:1778`) but **no endpoint in this story sets it** — there is no machine-user deactivation AC in epics.md's Story 7.1 text. This is intentional forward schema compatibility, not a gap to silently fill; flagged as an open question in the completion report rather than inventing a deactivation endpoint with no spec backing.

**And** add `export * from './machine-users.js'` to `packages/db/src/schema/index.ts`.

**Edge case:** a `POST` with `role: "owner"` or `role: "admin"` must be rejected at the Zod layer (`422`) before ever reaching the database — the CHECK constraint is a defense-in-depth backstop, not the primary validation path (see AC-4).

---

### AC-2: Schema — `api_keys` Table

**Given** `machine_users` exists (AC-1),
**When** the same migration is generated,
**Then** `packages/db/src/schema/api-keys.ts` defines:

```typescript
import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { machineUsers } from './machine-users.js'

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    machineUserId: uuid('machine_user_id')
      .notNull()
      .references(() => machineUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    hmacKeyVersion: integer('hmac_key_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Default [14, 3] per epics.md AC (epics.md:1784). See expiry-alert-shared.ts / D6.
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[14, 3]'::jsonb`)
      .$type<number[]>(),
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    machineUserIdx: index('idx_api_keys_machine_user').on(t.machineUserId),
    orgIdx: index('idx_api_keys_org').on(t.orgId),
    keyHashIdx: index('idx_api_keys_key_hash').on(t.keyHash),
    nameLenCheck: check('api_keys_name_len_check', sql`char_length(${t.name}) BETWEEN 1 AND 128`),
  })
)

export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
```

**And** `keyHash` is **not** unique-indexed with a plain B-tree unique constraint at the DB level in a way that would let a timing side-channel on the constraint violation leak a byte-by-byte guess — HMAC-SHA256 output is 256-bit, collision risk is negligible, and lookup is by exact hash equality via `WHERE key_hash = $1` (constant-cost query, not a security-relevant timing path since the caller does not learn *which* row/no-row distinction useful for guessing — this is a non-issue at 256-bit entropy; noted only so the developer doesn't over-engineer a constant-time DB lookup that isn't necessary here). Use a plain (non-unique) index for query performance; the extremely rare hash collision across all orgs would only ever matter if two literal 256-bit values collided, which is cryptographically negligible.

**And** ships in the **same migration file** as `machine_users` (AC-1), with both tables' `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` statements, following the exact block-per-table pattern in `packages/db/src/migrations/0028_monitoring_records.sql`:

```sql
ALTER TABLE machine_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- WITH CHECK defaults to USING for command-less ALL policies (see 0013_projects.sql /
-- 0014_credentials.sql precedent) — omission here is intentional, not a gap.
CREATE POLICY machine_users_isolation
  ON machine_users
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY api_keys_isolation
  ON api_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

**Note on `api_keys`' RLS scope:** the policy above governs this story's own endpoints (list/issue/revoke), which always run with an authenticated caller's `orgId` already set. It does **not** address Story 7.2's pre-auth by-`keyHash` lookup — that is an explicit open handoff, see D8.

**Edge case:** if the migration is generated without both `ENABLE ROW LEVEL SECURITY` statements, `packages/db/src/check-rls-coverage.ts`'s `checkRlsCoverage()` must fail CI (`db#check-rls` Turborepo task) — verify this locally by running the check-rls script against a freshly migrated test database before opening a PR; do not add `machine_users`/`api_keys` to `EXCLUDED_TABLES`.

---

### AC-3: Create Machine User — Happy Path + Scope Boundary Response

**Given** an org admin (`orgRole: 'admin'` or `'owner'`) is authenticated, MFA-enrolled (or within an active grace period — D5), and `projectId` belongs to their org,
**When** they call `POST /api/v1/projects/:projectId/machine-users` with body `{ "name": "ci-deploy-bot", "role": "member", "description": "GitHub Actions deploy pipeline" }`,
**Then** the response is `201`:

```json
{
  "data": {
    "id": "b3f1...-uuid",
    "projectId": "a1c2...-uuid",
    "name": "ci-deploy-bot",
    "description": "GitHub Actions deploy pipeline",
    "role": "member",
    "createdBy": "c4d2...-uuid",
    "createdAt": "2026-07-04T18:00:00.000Z",
    "deactivatedAt": null,
    "scopeBoundary": {
      "canAccess": ["credentials in project a1c2...-uuid (ci-deploy-bot's assigned project)"],
      "cannotAccess": ["other projects", "org settings", "audit logs"]
    }
  }
}
```

**And** the `scopeBoundary` block is shown **before any API key exists for this machine user** — it is part of the creation response itself, not a separate call (UX-DR11, `epics.md:1778`).

**And** a `machine_user.created` audit row is written in the **same transaction** as the insert, via `writeHumanAuditEntryOrFailClosed(secureCtx.tx, { resourceType: 'machine_user', resourceId: newMachineUser.id, eventType: AuditEvent.MACHINE_USER_CREATED, payload: { name, role, description }, ... })` — matching the `POST /api/v1/projects` pattern (`modules/projects/routes.ts:303-320`) exactly, since the resource id doesn't exist until after the insert (`security: { writeAuditEvent: false }` in the route config, manual call in the handler). Include `description` in the payload even though there is no update endpoint to change it later — the audit row should reflect the actual submitted payload in full, not an arbitrary subset.

---

### AC-4: Create Machine User — Validation Errors

**Given** the same authenticated org admin,
**When** they submit any of the following invalid bodies,
**Then** the API returns `422` with `ApiErrorSchema` (`{ code, message, details? }`), and **no row is inserted**:

| Invalid input | `code` |
|---|---|
| `role: "admin"` or `role: "owner"` | `validation_error` (role must be `"member"` or `"viewer"`) |
| `role: "not-a-role"` | `validation_error` |
| `name: ""` (empty string) | `validation_error` |
| `name` omitted | `validation_error` |
| `name` longer than 128 chars | `validation_error` |
| `description` longer than the max length enforced by `credentials.ts`'s description field | `validation_error` (read `credentials.ts`'s schema for the exact character cap and reuse it verbatim — do not hardcode a guessed number in this story or its tests) |

**And** a duplicate `name` within the same project is **allowed** (epics.md does not specify uniqueness, and human-readable labels for CI bots commonly repeat across environments, e.g. two `"staging-deploy"` bots in different projects) — do not add a uniqueness constraint that isn't specified.

---

### AC-5: Create Machine User — Authorization Failures (Org Role + MFA)

**Given** a caller who is authenticated but not an org admin/owner (`orgRole: 'member'` or `'viewer'`),
**When** they call `POST /api/v1/projects/:projectId/machine-users`,
**Then** the response is `403 { code: "insufficient_role", message: "Insufficient permissions" }` and no row is created, no audit event is written (the `SecureRoute` role check runs before the transaction opens).

**And**, given an org admin whose account has never enrolled MFA and has no active grace period,
**when** they call the same endpoint,
**then** the response is `403` from `requireMfaEnrollment()` (standard `mfa_required`-shaped error — confirm exact `code` value by reading `apps/api/src/modules/auth/mfa-enforcement.ts` before hardcoding a test assertion) and no row is created.

**And**, given an org admin **within an active MFA grace period** (no `mfa_enrolled_at`, but `gracePeriodActive: true`),
**when** they call the same endpoint,
**then** the request **succeeds** (`201`) — per D5, this story deliberately does not implement a strict grace-period-ignoring check, unlike Story 4.1's invite gate, because no policy document calls for one here. If a future security review decides machine-user creation needs the strict variant, that is a follow-up story, not a silent addition here.

---

### AC-6: Create Machine User — Tenant Isolation

**Given** an org admin authenticated for Org A,
**When** they call `POST /api/v1/projects/:projectId/machine-users` with a `projectId` belonging to Org B,
**Then** the response is `404 { code: "project_not_found" }` (never `403`, which would leak that the project exists in another org) — RLS on the `projects` table combined with the org-scoped lookup means the row is simply invisible in this transaction's context, not explicitly forbidden.

**And** the same `404` behavior applies to a `projectId` that does not exist at all — the response is indistinguishable between "exists in another org" and "does not exist anywhere," which is the correct non-leaking behavior (same pattern as every other project-nested creation route in this codebase).

---

### AC-7: List Machine Users in a Project

**Given** an org member/viewer/admin/owner authenticated for the project's org,
**When** they call `GET /api/v1/projects/:projectId/machine-users`,
**Then** the response is `200 { "data": { "items": [...], "total": N } }`, each item shaped like AC-3's creation response minus `scopeBoundary` (recomputing the boundary text for a list view adds no value; it belongs on creation and detail views only).

**And**, given a project with zero machine users,
**when** the same request is made,
**then** the response is `200 { "data": { "items": [], "total": 0 } }` — never a `404` (an empty project is a valid state, not a missing one, matching `GET /api/v1/projects/:projectId/credentials`'s empty-list precedent).

**And**, given a `projectId` belonging to a different org,
**when** the same request is made,
**then** the response is `404`, matching AC-6's isolation behavior.

**And** this endpoint accepts `page`/`limit` query params via the existing `parsePagination`/`paginationOffset` helpers (`apps/api/src/lib/pagination.ts`), the same pattern `GET /api/v1/projects/:projectId/credentials` already uses — do not build a bespoke pagination scheme. Cap the offset with a `MAX_MACHINE_USER_LIST_OFFSET` constant in `packages/shared/src/schemas/machine-users.ts`, mirroring `MAX_CREDENTIAL_LIST_OFFSET`'s precedent (`modules/credentials/schema.ts:74`).

---

### AC-8: Get Single Machine User Detail

**Given** an org member+ authenticated for the machine user's org,
**When** they call `GET /api/v1/machine-users/:machineUserId` (flat route — machine users are addressed by ID directly once created, matching the flat-by-id pattern used for sub-resource actions elsewhere in this API),
**Then** the response is `200 { "data": { ...same shape as AC-3's creation response, including scopeBoundary... } }`.

**And**, given a `machineUserId` that does not exist, or exists but belongs to a different org,
**when** the same request is made,
**then** the response is `404 { code: "machine_user_not_found" }` in both cases (no existence leak, same reasoning as AC-6).

---

### AC-9: Issue API Key — Happy Path (Plaintext Once, Hash-Only Storage)

**Given** an org admin, MFA-enrolled/grace, and an existing machine user in their org,
**When** they call `POST /api/v1/machine-users/:machineUserId/api-keys` with `{ "name": "prod-deploy-key", "expiresAt": "2027-01-01T00:00:00.000Z" }`,
**Then** the server generates `plaintextKey = pk_ + randomBytes(32).toString('base64url')` (D2), computes `keyHash = createHmac('sha256', env.API_KEY_HMAC_SECRET).update(plaintextKey).digest('hex')` (D1/D3), and inserts an `api_keys` row with `keyHash`, `hmacKeyVersion: 1`, `expiresAt`, `lastUsedAt: null`, `revokedAt: null`, default `alertLeadDays: [14, 3]`.

**And** the response is `201`:

```json
{
  "data": {
    "id": "e5a2...-uuid",
    "machineUserId": "b3f1...-uuid",
    "name": "prod-deploy-key",
    "key": "pk_9f3aB7xQ...46-chars-total-no-padding",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "createdAt": "2026-07-04T18:05:00.000Z"
  }
}
```

**And** `plaintextKey` (the `key` field above) is returned in this **one** response and **never persisted anywhere** — not in the database, not in application logs (`request.log`/`fastify.log` calls in this handler must never include the raw key). **Important:** the `FORBIDDEN_AUDIT_KEYS`/`sanitizeAuditPayload` redaction in `secure-route.ts` only runs inside `defaultAuditWriter`, which is used exclusively by the *declarative* `security.writeAuditEvent` config path. This route (like AC-3/AC-13) uses the **manual** `writeHumanAuditEntryOrFailClosed` call instead (`security: { writeAuditEvent: false }`), and that call chain applies **zero** redaction — there is no runtime safety net on this code path at all. Correctness depends entirely on the handler never placing the plaintext into any object that reaches a logger or the manually-constructed audit payload; AC-15's test assertion is the **only** protection, not a backstop on top of an existing one.

**And** a `machine_user.api_key_issued` audit row is written same-transaction (manual `writeHumanAuditEntryOrFailClosed` call, `writeAuditEvent: false` in the route config, same reasoning as AC-3 — the key id doesn't exist until after insert), with `payload: { name, expiresAt }` — **never** `keyHash` or the plaintext.

---

### AC-10: Issue API Key — Expiry Validation

**Given** the same authenticated org admin,
**When** they submit `expiresAt` as a past ISO 8601 timestamp (e.g. `"2020-01-01T00:00:00.000Z"`),
**Then** the response is `422 { code: "validation_error" }` and no key is created.

**And**, given `expiresAt` is omitted entirely,
**when** the key is issued,
**then** the key is created with `expiresAt: null` (never expires) — epics.md's schema explicitly makes `expiresAt` optional (`epics.md:1780`: `{ name, expiresAt? }`), so a non-expiring key is a valid, intentional state, not an error.

**And**, given `expiresAt` is a syntactically invalid date string (e.g. `"not-a-date"`),
**when** the key is issued,
**then** the response is `422 { code: "validation_error" }`.

**And**, given the request body's `name` field is empty, omitted, or longer than 128 chars (matching `api_keys`' `nameLenCheck` constraint, AC-2),
**when** the key-issue endpoint is called,
**then** the response is `422 { code: "validation_error" }` and no key row is inserted — mirroring AC-4's machine-user-name validation exactly; do not skip this validation just because it's a different table's `name` column. Task 10's integration-test list must include this case explicitly.

---

### AC-11: Issue API Key — Not Found / Cross-Org / Deactivated Machine User

**Given** a `machineUserId` that does not exist, or belongs to a different org,
**When** `POST /api/v1/machine-users/:machineUserId/api-keys` is called,
**Then** the response is `404 { code: "machine_user_not_found" }`, matching AC-6/AC-8's non-leaking pattern.

**And**, given a machine user whose `deactivatedAt` is **not null** (reserved for a future story per AC-1 — but the column exists now, so this guard is cheap to add and prevents a real footgun if a later story sets it without this endpoint knowing about it),
**when** a key-issue request is made,
**then** the response is `409 { code: "machine_user_deactivated" }` — issuing new credentials for a deactivated identity would be a security-relevant gap even though nothing in this story sets `deactivatedAt` yet.

**Test note:** since no endpoint in this story sets `deactivatedAt`, this branch cannot be exercised end-to-end through the API alone — the integration test must set up its fixture by writing `deactivatedAt` directly via a DB/repository call before issuing the request, not by first calling a (nonexistent) deactivation endpoint. This is expected: the branch is forward-compatible dead code today, activated once a future story adds a deactivation endpoint.

---

### AC-12: List API Keys — Metadata Only, No Secret Leakage

**Given** a machine user with two keys (one active, one revoked),
**When** an org member+ calls `GET /api/v1/machine-users/:machineUserId/api-keys`,
**Then** the response is `200`:

```json
{
  "data": {
    "items": [
      { "id": "e5a2...", "name": "prod-deploy-key", "expiresAt": "2027-01-01T00:00:00.000Z", "lastUsedAt": null, "createdAt": "2026-07-04T18:05:00.000Z", "isRevoked": false },
      { "id": "f6b3...", "name": "old-key", "expiresAt": null, "lastUsedAt": "2026-06-01T00:00:00.000Z", "createdAt": "2026-05-01T00:00:00.000Z", "isRevoked": true }
    ],
    "total": 2
  }
}
```

**And** the response schema (`packages/shared/src/schemas/machine-users.ts` — new file) **structurally excludes** `keyHash` and any plaintext field — verify this with a Zod `.strict()`-style schema or an explicit field allowlist in the mapping function, not just "the query happens not to select it," so a future refactor can't accidentally widen the `SELECT`.

**And** `isRevoked` is computed as `revokedAt !== null` in the response mapper, never a separately-stored boolean that could drift from `revokedAt`.

**And** this endpoint accepts `page`/`limit` query params via the same `parsePagination`/`paginationOffset` helpers and `MAX_MACHINE_USER_LIST_OFFSET` cap as AC-7 — CI/CD-heavy orgs that mint many short-lived keys (see AC-17's key-rotation-overlap scenario) can accumulate enough rows that an unbounded list response becomes a latent scalability problem.

---

### AC-13: Revoke API Key — Happy Path + Idempotency

**Given** an org admin and an active (non-revoked) key belonging to their org,
**When** they call `DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId`,
**Then** the server captures the current time **application-side** (`const revokedAt = new Date()` — not SQL `now()`, see AC-17 for why this matters) and sets `revokedAt` to that value, returning `200 { "data": { "id": "e5a2...", "revokedAt": "2026-07-04T18:10:00.000Z" } }`, with a `machine_user.api_key_revoked` audit row written same-transaction (this route **does** have `keyId` in its params, so it may use the declarative `security.writeAuditEvent: { eventType: AuditEvent.MACHINE_USER_API_KEY_REVOKED, resourceType: 'api_key', resourceIdFromParams: 'keyId' }` form — or the manual call for consistency with AC-3/AC-9; pick whichever the surrounding module ends up using consistently and document the choice in Dev Notes).

**And**, given the same key is revoked a **second** time (double-click, retried request, or two concurrent callers — see AC-17),
**when** `DELETE` is called again,
**then** the response is still `200` with the **original** `revokedAt` timestamp unchanged (idempotent — `revokedAt = COALESCE(revoked_at, $revokedAt)` semantics with the app-captured timestamp bound as a parameter, not an overwrite), and **no second audit row is written** for the redundant call (only the state transition that actually changed `revokedAt` from null writes an audit event; detect "already revoked" before deciding whether to audit-write — see AC-17 for the exact comparison).

**Note on enforcement scope:** this story sets `revokedAt` and exposes it via `GET .../api-keys` (`isRevoked: true`). It does **not** implement the actual `401` rejection of a revoked key on use — that check lives in Story 7.2's `POST /api/v1/auth/machine-token` (which doesn't exist yet). Do not write an integration test asserting a `401` from an authentication endpoint that this story doesn't build; test only that the DB state (`revokedAt`) and the list-endpoint's `isRevoked` flag update correctly.

**And**, given a `keyId` that does not exist or belongs to a different machine user/org,
**when** `DELETE` is called,
**then** the response is `404 { code: "api_key_not_found" }`.

---

### AC-14: Expiry Alert Job — pg-boss Daily Firing, Dedupe, Org Isolation

**Given** an `api_keys` row with `expiresAt` 14 days from now and `notifiedLeadDays: []`,
**When** the `machine-key:expiry-alert` pg-boss job runs (cron `0 8 * * *`, registered in `apps/api/src/main.ts` alongside `cert:expiry-alert`/`domain:expiry-alert`/`payment:expiry-alert`),
**Then** `apps/api/src/workers/machine-key-expiry-alert.ts`'s `runMachineKeyExpiryAlertJob(boss, logger)` calls the shared `runExpiryAlertJob<Row>()` from `expiry-alert-shared.ts` with a `fetchRows` implementation that **joins** `apiKeys` to `machineUsers` (the row type needs a `projectId`, which lives on `machine_users`, not `api_keys` — see D6):

```typescript
fetchRows: (orgId) =>
  runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
    tx
      .select({
        id: apiKeys.id,
        projectId: machineUsers.projectId,
        alertLeadDays: apiKeys.alertLeadDays,
        notifiedLeadDays: apiKeys.notifiedLeadDays,
        name: apiKeys.name,
        expiresAt: apiKeys.expiresAt,
        machineUserName: machineUsers.name,
      })
      .from(apiKeys)
      .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
      .where(
        and(eq(apiKeys.orgId, orgId), isNotNull(apiKeys.expiresAt), isNull(apiKeys.revokedAt))
      )
  ),
```

**And** a notification-queue entry is created via `createOrgAdminNotificationEntries({ orgId, tx, template: { templateId: 'machine_key.expiry', severity: ..., payload: { keyId: row.id, keyName: row.name, machineUserName: row.machineUserName, projectId: row.projectId, expiresAt, ...baseExpiryPayload(ctx) } } })`, routed to FR100-configured recipients per the already-shipped alert-routing system — **no new routing/preference code needed** (`machine_key.expiry` is already in `NOTIFICATION_ALERT_TYPES`).

**And**, given the same row was already notified at the `14`-day threshold (`notifiedLeadDays: [14]`),
**when** the job runs again the next day (`daysRemaining: 13`),
**then** no duplicate alert fires for the `14` threshold (only `3` remains eligible), matching `computeExpiryAlertFirings()`'s existing dedupe logic verbatim — **no new dedupe logic is written for this story**.

**And**, given two different orgs each have an expiring key,
**when** the job runs,
**then** each org's alert is processed independently via `fetchAllOrgIds()` + per-org `try/catch` (existing failure-isolation loop in `runExpiryAlertJob`) — a fetch/processing failure for Org A's rows must not prevent Org B's alert from firing, and must not throw an unhandled rejection that crashes the job.

**And** a **revoked** key (`revokedAt IS NOT NULL`) is excluded from the query (`isNull(apiKeys.revokedAt)` filter above) — a revoked key's owner should not receive an "expiring soon" alert for a credential that is already dead.

---

### AC-15: Audit Trail — Same-Transaction, Fail-Closed

**Given** any of the three mutation endpoints (create machine user, issue key, revoke key),
**When** the audit-log write inside the same transaction throws (e.g. a simulated DB error in a test harness),
**Then** `writeHumanAuditEntryOrFailClosed` rewraps the error as `SameTransactionAuditWriteError`, `SecureRoute` catches it and returns `503 { code: "audit_write_failed" }`, and the **entire transaction rolls back** — the machine user/key is **not** created/revoked despite the handler logic having "succeeded" before the audit write. This is the same fail-closed contract every other mutation in this codebase already relies on (`secure-route.ts:419-430`); no new test harness pattern is needed — reuse whatever mechanism Story 4.1/4.4's integration tests use to simulate an audit-write failure (grep for `SameTransactionAuditWriteError` usage in existing `*.integration.test.ts` files).

**And** every audit payload for these three event types is asserted in tests to **not** contain a `key`, `apiKey`, `keyHash`, `plaintext`, or `value` field — a regression here (e.g. an incautious future refactor that spreads the full request body into the audit payload) must fail a test. Per AC-9: `FORBIDDEN_AUDIT_KEYS`'s runtime redaction does **not** apply to this story's manual `writeHumanAuditEntryOrFailClosed` call sites — this test is the only protection these payloads have, not a second layer on top of an existing one.

---

### AC-16: Rate Limiting on Sensitive Mutations

**Given** the three mutation endpoints (create machine user, issue key, revoke key) each set `security.rateLimit: { max: 10, timeWindowMs: 60_000, key: '<METHOD> <route>' }` — matching the exact precedent of `POST /api/v1/projects/:projectId/archive` (`modules/projects/routes.ts:833-837`),
**When** the same admin issues an 11th key-creation request within 60 seconds,
**Then** the 11th request receives `429` (standard `@fastify/rate-limit` response via `enforceUserRateLimit`, keyed per-admin-per-route — confirm the exact 429 body shape by reading `apps/api/src/lib/route-helpers.ts`'s `enforceUserRateLimit` before hardcoding a test assertion). **Note the scope carefully:** the key is `<admin> + <route template>`, not `<admin> + <machineUserId>` — the budget is shared across every machine user that admin manages. An admin issuing keys for several machine users in quick succession can exhaust the shared 10/min budget and be blocked from issuing a key for an unrelated machine user for up to 60 seconds; this matches the existing `POST .../archive` precedent and is not a defect to fix in this story, but do not write a test asserting per-machine-user isolation of the rate limit — there is none.

**And** the read endpoints (list/get) use the `SecureRoute` default (`{ max: 60, timeWindowMs: 60_000 }`) — no bespoke tightening, consistent with every other read-only route in this codebase. Confirm the default's exact scoping (per-admin vs. per-IP vs. global) by reading `SecureRoute`'s default rate-limit configuration before hardcoding a test assumption — do not assume it matches the write-path's per-admin-per-route scoping without checking.

---

### AC-17: Concurrency — Simultaneous Key Issuance and Revocation

**Given** two concurrent `POST /api/v1/machine-users/:machineUserId/api-keys` requests for the **same** machine user (e.g. a CI script retried due to a client-side timeout, or two admins racing),
**When** both complete,
**Then** **both** succeed with `201` and **two distinct** `api_keys` rows exist, each with its own unique `keyHash` — there is no uniqueness constraint or lock preventing multiple active keys per machine user (this is intentional; overlap during key rotation is exactly the use case Story 7.2 builds on top of, and nothing in 7.1 should preclude having 2+ simultaneously valid keys for one identity).

**And**, given two concurrent `DELETE .../api-keys/:keyId` requests for the **same** key (double-click, or a retried request after a dropped response),
**when** both complete,
**then** both return `200`, `revokedAt` is set exactly once (to whichever request's transaction commits first). **Capture the timestamp application-side before running the query** (`const revokedAt = new Date()`) and pass it as a bound parameter rather than calling SQL `now()` inline: `UPDATE ... SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 RETURNING revoked_at`, with `$2` = the app-captured `revokedAt`. This is required for the idempotency check to work at all — comparing `RETURNING`'s `revokedAt` against SQL-generated `now()` is meaningless, since `now()` is evaluated fresh inside each transaction and can never equal a prior transaction's value by construction. With an app-captured, parameter-bound timestamp: if the `RETURNING` value equals what this transaction passed in, this transaction's write won the race and it should audit-write; if it doesn't match, another transaction already set `revokedAt` first and this call must **not** write a second audit row. (An equally valid alternative: a `SELECT ... FOR UPDATE` read before the `UPDATE`, checking whether `revokedAt` was already non-null.) This mirrors the idempotency requirement in AC-13.

---

### AC-18: RLS Coverage and Route-Audit Coverage (CI Gates)

**Given** the migration from AC-1/AC-2 has been applied to a test database,
**When** `packages/db/src/check-rls-coverage.ts`'s `checkRlsCoverage()` runs (the `db#check-rls` Turborepo task, required before `db#migrate` per `architecture.md:880`),
**Then** it passes with no gaps reported for `machine_users` or `api_keys` — both appear in `pg_policies` because their migration includes the `CREATE POLICY` statements from AC-2.

**And**, given all six new routes are registered via `secureRoute()` (never bare Fastify `.route()` calls),
**when** `apps/api/src/__tests__/route-audit.test.ts` runs,
**then** every new route path appears in the generated OpenAPI spec **and** in the module-level `secureRoutes` set — add the six corresponding entries to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts` (three `mutation`/`security-action` entries with `auditEvent`/`sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed'`, three `read` entries with `auditOmissionReason`, following the exact shape of the existing `credentials`/`projects` entries in that file).

---

### AC-19: Migration Safety and Backward Compatibility

**Given** this story's migration only **adds** two new tables and does not `ALTER` any existing table,
**When** the migration is applied to a database that already has Stories 1.1-6.3's schema,
**Then** no existing table's data or constraints are affected, no existing route's behavior changes, and no existing integration test's assertions need updating — this is a purely additive change, matching the "additive-only, no data migration" pattern of every prior schema-introducing story in this repo (e.g. `project_invitations` in Story 4.1).

**And**, given a rollback of this migration is ever needed (e.g. a bad deploy),
**when** the corresponding `DROP TABLE api_keys; DROP TABLE machine_users;` (in that FK-dependency order) is run,
**then** no other table's foreign keys reference `machine_users`/`api_keys` in this story (7.2/7.3 will add such references later, at which point *their* migrations become responsible for handling rollback ordering) — this story's rollback is self-contained.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema** (AC-1, AC-2)
  - [ ] `packages/db/src/schema/machine-users.ts` — new table
  - [ ] `packages/db/src/schema/api-keys.ts` — new table
  - [ ] Add both to `packages/db/src/schema/index.ts`
  - [ ] Verify next migration number in `_journal.json`, generate migration (DDL + RLS policies in one file), run `db#check-rls`, run `db#migrate`
- [ ] **Task 2: Env + token helpers** (D1-D3, AC-9)
  - [ ] `API_KEY_HMAC_SECRET` env wiring in `apps/api/src/config/env.ts` (+ `.env.example`)
  - [ ] `apps/api/src/modules/machine-users/tokens.ts` — `generateApiKey()`, `hashApiKey()`, `apiKeysMatch()`, mirroring `auth/tokens.ts`
- [ ] **Task 3: Audit event constants** (D7) — add `MACHINE_USER_CREATED`, `MACHINE_USER_API_KEY_ISSUED`, `MACHINE_USER_API_KEY_REVOKED` to `packages/shared/src/constants/audit-events.ts` (additive only)
- [ ] **Task 4: Shared response schemas** — `packages/shared/src/schemas/machine-users.ts` (create/list/detail/key-issue/key-list response shapes, explicitly excluding `keyHash`/plaintext from any read schema; `MAX_MACHINE_USER_LIST_OFFSET` constant per AC-7/AC-12)
- [ ] **Task 5: Machine user routes** (AC-3 to AC-8) — `apps/api/src/modules/machine-users/routes.ts`, `schema.ts`; wire into `apps/api/src/app.ts`; add `ROUTE_ACTION_CLASSIFICATIONS` entries
- [ ] **Task 6: API key routes** (AC-9 to AC-13, AC-16, AC-17) — issue/list/revoke handlers in the same module
- [ ] **Task 7: Expiry alert job** (AC-14, D6) — `apps/api/src/workers/machine-key-expiry-alert.ts` calling `runExpiryAlertJob()`; register cron schedule + worker in `apps/api/src/main.ts` alongside the other three expiry-alert jobs
- [ ] **Task 8: Audit wiring** (AC-15) — manual `writeHumanAuditEntryOrFailClosed` calls at each mutation's insert/update site; verify payload never includes secret material
- [ ] **Task 9: RLS + route-audit CI gates** (AC-18) — confirm `check-rls-coverage` passes; confirm `route-audit.test.ts` passes with new `ROUTE_ACTION_CLASSIFICATIONS` entries
- [ ] **Task 10: Integration test suite** — all cases across AC-3 through AC-19 (creation + scope boundary, validation, authz, tenant isolation, list/detail + pagination, key issuance + plaintext-once + hash-only storage + key-name validation (AC-10), key listing no-leak, revocation + idempotency (app-captured-timestamp comparison, AC-13/AC-17), deactivated-machine-user key-issue rejection (fixture-set `deactivatedAt` directly, AC-11), expiry-alert firing/dedupe/org-isolation, audit fail-closed + payload sanitization (no runtime redaction safety net, AC-9/AC-15), rate limiting (shared per-admin-per-route budget, not per-machine-user), concurrency, migration additivity)
- [ ] **Task 11: Route audit + OpenAPI regen** — `pnpm --filter api generate-spec`, confirm `web#typecheck` picks up new types (even with no web UI consuming them yet, per the Product Surface Contract's `TBD` note)

---

## Dev Notes

- This story's **highest-risk decision** is D1/D2 (hashing algorithm + key format) — get this right before writing any route handler, since every downstream 7.2 integration test will assume `pk_` + HMAC-SHA256. Do not implement epics.md's literal BLAKE2b/`pvk_`/base62 spec; the Architecture Conflict Resolution table above is the source of truth.
- Do **not** touch `project_memberships` (D4) — machine users get their own `role` column. If you find yourself writing a migration that alters `project_memberships`, stop and re-read D4.
- Do **not** hand-roll a new expiry-alert loop (D6) — `runExpiryAlertJob()` in `apps/api/src/workers/expiry-alert-shared.ts` already does firing/dedupe/failure-isolation; your job file should be ~40 lines, matching `cert-expiry-alert.ts`'s shape almost exactly.
- Do **not** implement `requireMfaEnrollmentStrict()`-style grace-period-ignoring checks (D5) — there is no policy-matrix entry justifying it for machine users, unlike Story 4.1's invite gate.
- Do **not** wire up the Story 4.4 archival guard stub (`hasActiveMachineUserKeys()`) — that is explicitly Story 7.2's job per epics.md.
- Do **not** build any SvelteKit page for machine-user management — the Product Surface Contract's `TBD` note documents this as a genuine planning gap, not something to silently patch over with an unscoped UI addition.
- The plaintext API key must never reach `request.log`/`fastify.log`, the audit payload, or any response other than the single `201` from the issue-key endpoint. Grep your own diff for the variable holding the plaintext before opening a PR to confirm it doesn't escape that one response path.
- `alertLeadDays`/`notifiedLeadDays` on `api_keys` intentionally mirror `cert_records`/`domain_records`/`payment_records` exactly (same jsonb-array shape, same default-pair rationale referenced in those files' comments) so that `expiry-alert-shared.ts`'s generic types apply with zero adaptation.
- `keyHash`'s non-unique index (AC-2) is a conscious choice, not an oversight: at 256-bit HMAC-SHA256 entropy a genuine collision is cryptographically negligible, so no DB-level uniqueness backstop is added. This is framed the same way as AC-1's `role` CHECK constraint — a defense-in-depth backstop is nice-to-have but not load-bearing here, since the primary guarantee (crypto correctness) doesn't depend on it.
- No route in this codebase hard-deletes a `projects` row today (only archival, Story 4.4) — so the `ON DELETE CASCADE` from `projects` to `machine_users`/`api_keys` is currently unreachable in practice, not an active audit gap. If a future story adds project hard-deletion, that story is responsible for deciding whether the cascade needs its own audit trail entry (e.g. "N machine users and M keys were also removed") — out of scope here.
- The missing machine-user web UI (Product Surface Contract, above) is a genuine planning gap, not something this story can fix. If it isn't picked up by the time 7.2/7.3 ship, machine-user management will be a permanently curl-only admin feature — worth escalating to whoever owns Epic 7/8 sprint planning rather than letting it go unnoticed.

### Project Structure Notes

- New module: `apps/api/src/modules/machine-users/` (`routes.ts`, `schema.ts`, `tokens.ts`) — consistent with `modules/projects/`, `modules/invitations/` precedent (routes.ts + schema.ts, no forced service/repository split — see Architecture Conflict Resolution table).
- New worker: `apps/api/src/workers/machine-key-expiry-alert.ts`, alongside `cert-expiry-alert.ts`/`domain-expiry-alert.ts`/`payment-expiry-alert.ts`.
- New shared schema: `packages/shared/src/schemas/machine-users.ts`.
- No detected conflicts with other `ready-for-dev`/`backlog` stories at the time this story was created — 6.2/6.3 touch `modules/monitoring/`; this story is entirely new files plus purely additive entries in `audit-events.ts`, `notification-types.ts` (no change needed, already present), and `route-exemptions.ts`.

### References

- Epics AC: [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.1` (lines 1766-1791)]
- Epic 7 preamble / blockers (RS-E7a, PJ2, PJ4, PJ7, AC-E7a/b/c): [Source: `_bmad-output/planning-artifacts/epics.md` lines 1752-1765 — note RS-E7a/PJ2/PJ7/AC-E7a/b/c are all Story 7.2/7.3 scope, not 7.1; included here only so the developer understands why 7.1 is deliberately narrow]
- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR32-FR39, FR68 (lines 909-917)]
- Architecture — API key format, token hashing, canonical schema names: [Source: `_bmad-output/planning-artifacts/architecture.md` lines 604-607, 802-809, 869, 903-931, 1182]
- Architecture — RLS coverage enforcement: [Source: `_bmad-output/planning-artifacts/architecture.md` line 880]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]
- Story 4.4 archival stub this story's tables will eventually satisfy (Story 7.2, not here): [Source: `_bmad-output/implementation-artifacts/4-4-project-archival.md` lines 324-336]
- Prior art for token/HMAC pattern: `apps/api/src/modules/auth/tokens.ts`, `apps/api/src/config/env.ts` (HMAC secret validation blocks)
- Prior art for SecureRoute usage + org-admin-gated mutation + rate limiting: `apps/api/src/modules/projects/routes.ts` (`POST .../archive`, lines 820-838)
- Prior art for expiry-alert jobs: `apps/api/src/workers/cert-expiry-alert.ts`, `apps/api/src/workers/expiry-alert-shared.ts`, `packages/db/src/schema/cert-records.ts`
- Prior art for same-transaction audit on a create endpoint (no resourceId in params): `apps/api/src/modules/projects/routes.ts` lines 303-320, `apps/api/src/lib/audit-or-fail-closed.ts`
- Prior art for RLS migration pattern (DDL + policy in one file): `packages/db/src/migrations/0028_monitoring_records.sql`
- Downstream dependents: `_bmad-output/implementation-artifacts/7-2-machine-user-authentication-and-programmatic-secret-retrieval.md` (not yet created) and `_bmad-output/implementation-artifacts/7-3-github-actions-cicd-integration.md` (not yet created) — both will need to re-read this story's D1-D7 decisions before implementation.

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

### Completion Notes List

### File List
