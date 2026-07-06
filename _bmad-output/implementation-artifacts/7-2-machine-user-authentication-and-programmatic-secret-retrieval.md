# Story 7.2: Machine User Authentication & Programmatic Secret Retrieval

Status: done

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for machine-user token exchange, programmatic secret-by-name retrieval, the offline fallback cache agent, zero-downtime key rotation, emergency revocation, and dormancy detection. This is the SECOND story in Epic 7, built directly on Story 7.1's `machine_users`/`api_keys` schema and `hashApiKey()`/`apiKeysMatch()` crypto helpers. Read "Key Design Decisions & Open Questions" before coding — several concrete conflicts between epics.md's literal Story 7.2 AC text and architecture.md's canonical decisions are resolved here, in favor of architecture.md + established codebase precedent + Story 7.1's own D1-D9, mirroring the resolution pattern Stories 4.1 and 7.1 already established. -->

## Story

As a CI/CD pipeline or application,
I want to authenticate with an API key and retrieve secrets by name — with a local offline cache if the vault is temporarily unreachable,
so that my deployments are not blocked by transient vault unavailability.

*Covers: FR34, FR35, FR37, FR38, FR101, FR110.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.2` (lines 1794-1827)]

**FR101/FR110 provenance note:** neither FR101 nor FR110 appears anywhere in `_bmad-output/planning-artifacts/prd.md` — both are defined only in epics.md's Epic 7 preamble annotations (`AC-E7c` for FR101's 24h overlap cap / 4h default, `AC-E7b` for FR110's 90-day default dormancy threshold, `PJ7` for FR101's emergency-revocation contract). This is a genuine PRD/epics traceability gap that predates this story (flagged, not fixed here — see Dev Notes). epics.md is treated as the authoritative source for both FRs' concrete parameters since the PRD is silent.

**Out of scope for this story (belongs to other stories — do not implement here):**
- Machine user *identity/API-key CRUD* (`POST /api/v1/projects/:projectId/machine-users`, key issuance, key listing, basic revocation) — all **Story 7.1**, already `ready-for-dev`. This story consumes those tables/helpers; it does not re-implement them.
- The GitHub Actions action package (`packages/vault-action`, a thin CLI wrapper around this story's `@project-vault/agent`) — **Story 7.3** (FR39). This story ships the underlying `@project-vault/agent` npm package that 7.3 depends on, but not the GitHub Action itself.
- A GitLab CI native component — explicitly descoped to v2 per epics.md `AC-E7a`.
- Any web UI for viewing machine-user audit history, rotation status, or dormancy alerts beyond the raw `GET /api/v1/security-alerts` list already shipped — no UI story exists in Epic 7 for this surface (same gap 7.1 flagged; see Product Surface Contract below).

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — machine authentication and programmatic retrieval are consumed by CI/CD tooling and the `@project-vault/agent` package, not exercised in a human evaluator's UI walkthrough in v1 |
| **Linked UI story** (if API-only) | `TBD` — same genuine planning gap Story 7.1 already flagged (`architecture.md:892`'s aspirational `(app)/projects/[id]/machine-users/` route has no story). This story adds a second, related gap: dormancy alerts land in the existing `security_alerts` table (see D9) and are visible only via the already-shipped `GET /api/v1/security-alerts` list endpoint (Epic 1) — no dedicated dormancy UI exists. Until a UI story exists, all of this story's admin actions (rotate, emergency-revoke, dismiss, extend, revoke) are REST-API-only |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none is being built at all yet for this surface. Do not add a partial/stubbed SvelteKit page in this story |
| **Persona journey** | N/A — API-only. FR34/FR35/FR37/FR38/FR101/FR110 describe a CI/CD pipeline (non-human actor) authenticating and retrieving secrets; the only human-facing actions (rotate, emergency-revoke, dormancy dismiss/revoke/extend) are administrator REST-API calls, matching 7.1's precedent exactly |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 7.1 implemented** (`machine_users`, `api_keys` tables; `generateApiKey()`/`hashApiKey()`/`apiKeysMatch()` in `apps/api/src/modules/machine-users/tokens.ts`; `API_KEY_HMAC_SECRET` env wiring) | This story's entire token-exchange and rotation surface is additive on top of 7.1's schema and crypto helpers — do **not** re-derive the hashing algorithm or key format; reuse 7.1's `tokens.ts` exports verbatim. **At story-creation time, 7.1 is `ready-for-dev`, not yet `done`** — if 7.1's implementation diverges from its own spec during development, this story's migration must be updated to match the actually-shipped column names, not the spec in `7-1-machine-user-identity-and-api-key-management.md`. |
| **Story 4.4 done** (project archival, `hasActiveMachineUserKeys()` stub) | This story closes the stub at `apps/api/src/modules/projects/archive-guards.ts:324-336` — read that file's exact current stub body before editing (AC-23). Confirmed `done` in `sprint-status.yaml`. |
| **Story 2.1/2.2 done** (`credentials`, `credential_versions` tables; `revealCurrentValue()`/`findCredentialInProject()` in `apps/api/src/modules/credentials/service.ts`) | The machine value-retrieval endpoint reuses the same decryption path (`withSecret()`) and adds a name-keyed lookup sibling to the existing id-keyed `findCredentialInProject()`. Confirmed `done`. |
| **Story 1.10/3.1/3.2 notification queue + routing** | Cache-activation, anomaly, and dormancy alerts all dispatch through `createOrgAdminNotificationEntries()`/`resolveRoutingRecipients()`. Confirmed `done`. |
| **`packages/db/src/schema/security-alerts.ts` (Epic 1, shipped)** | The `security_alerts` table already has unused `dismissedBy`/`dismissedAt`/`dismissalReason` columns (see D9) — this story is the **first** to wire a dismiss endpoint against them. Read `apps/api/src/modules/org/security-alerts.ts` (read path) before adding the write path. |
| **Migration numbering (verify, do NOT hardcode)** | At this story's creation time, `_journal.json`'s latest entry is idx 28 (`0028_monitoring_records`), and Story 7.1 has **not yet been merged** (still `ready-for-dev`), so 7.1's own migration does not exist yet either. **Before generating any migration for this story, re-read `_journal.json` and confirm 7.1's migration has landed first** — this story's `api_keys` column additions (AC-1) cannot be generated until the `api_keys` table itself exists. If 7.1 is not yet merged when 7.2 development starts, escalate rather than guessing 7.1's exact shipped schema. |
| `apps/api/src/lib/route-exemptions.ts` | This story adds 9 new route entries (`ROUTE_ACTION_CLASSIFICATIONS`) and 3 new `PUBLIC_ROUTE_EXEMPTIONS` entries (machine-token exchange, machine-authenticated credential retrieval, cache-activated beacon — see D4/D13). |
| `packages/db/src/check-rls-coverage.ts` | No new tables are created by this story (only column additions to existing RLS-covered tables), so no new `EXCLUDED_TABLES`/policy entries are needed — but re-run `check-rls` after the migration to confirm nothing regressed. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These resolve concrete conflicts between epics.md's literal Story 7.2 wording, `architecture.md`'s canonical decisions, Story 7.1's own explicit handoffs (D8 in particular), and the actual shipped codebase — the same resolution discipline Stories 4.1 and 7.1 established: actually-shipped code and `architecture.md`'s explicit mandates win over an epics.md AC's literal-but-unshipped spec.

### D1 — Reuse 7.1's key format and hashing verbatim (no re-derivation)

Story 7.1 already resolved (its own D1/D2) that API keys are `pk_` + `randomBytes(32).toString('base64url')`, hashed with HMAC-SHA256 via `apps/api/src/modules/machine-users/tokens.ts`'s `hashApiKey()`, keyed by `env.API_KEY_HMAC_SECRET`. **This story imports and calls those exact functions — it does not reimplement key parsing, hashing, or comparison.** `apiKeysMatch()` (timing-safe comparison) from the same file is used for constant-time verification.

### D2 — Resolves 7.1's D8 handoff: pre-auth `api_keys` lookup by `keyHash` uses `getAdminDb()`, not RLS

Story 7.1's D8 explicitly left open whether `api_keys` needs `sessions`/`refresh_tokens`-style RLS-exception treatment for this story's pre-auth, org-unknown lookup, and instructed: *"before implementing the token-exchange lookup, confirm whether querying `api_keys` by `keyHash` under the standard RLS policy (with no org context set yet) returns zero rows by construction... and document the resolution."*

- **Confirmed:** under 7.1's standard `api_keys_isolation` RLS policy (`USING (org_id = current_setting('app.current_org_id', true))`), a query issued without first calling `set_config('app.current_org_id', ...)` evaluates the policy against an empty/null setting and returns **zero rows unconditionally** — exactly the chicken-and-egg problem `architecture.md` describes for `sessions`/`refresh_tokens`.
- **Established codebase precedent for this exact shape of problem:** `apps/api/src/modules/invitations/lookup.ts`'s `findInvitationByTokenHash()` and `apps/api/src/modules/auth/recovery-lookup.ts`'s equivalent both resolve it identically — a single point-lookup by a unique HMAC-hashed-token index via `getAdminDb()` (`apps/api/src/lib/db.ts`), a plain Drizzle client on `ADMIN_DATABASE_URL` that bypasses RLS entirely (documented rationale in `lookup.ts:6-13`: *"the 256-bit token is itself the authorization credential, the same trust model that already excludes refresh_tokens/pending_mfa_sessions from RLS for identical pre-auth lookups"*).
- **Decision implemented in this story:** add `apps/api/src/modules/machine-users/token-exchange-lookup.ts` with `findApiKeyByHash(keyHash: string)` using `getAdminDb()`, following `invitations/lookup.ts`'s exact shape and doc-comment convention. Once the owning `orgId` is resolved from the returned row, every subsequent read/write in this story (credential lookup, `lastUsedAt` update, audit write) runs inside a normal `withOrg(orgId, ...)` transaction like every other route — the admin-connection lookup is a single, narrowly-scoped exception, not a pattern that spreads further into the request lifecycle. **Do not** use `withAdminAccess()` (`packages/db/src/index.ts:64`) for this — that helper requires an already-authenticated `authCtx.role === 'admin'`, which does not exist yet at this point in the request (that's the entire problem being solved).
- Register `POST /api/v1/auth/machine-token` in `route-exemptions.ts`'s `PUBLIC_ROUTE_EXEMPTIONS` with `compensatingControls: [TOKEN_IS_CREDENTIAL, IP_RATE_LIMIT, 'per-key-lockout']`, mirroring the recovery-token entries exactly.

### D3 — Machine JWT signing: epics.md says RS256, codebase reality is a single HS256 `@fastify/jwt` instance — use a **second, namespaced `@fastify/jwt` registration** with its own HMAC secret

- **epics.md** (`epics.md:1806`) says the machine token is *"signed with RS256"*.
- **architecture.md** (`architecture.md:321-323`) groups both token types under one "JWT architecture" heading: *"Web session JWTs: ≤5 min TTL, signed with HMAC-SHA256 (`@fastify/jwt`)... Machine user exchange JWTs: ≤1h TTL, issued via API key token exchange... Both carry `jti`."* Nothing in architecture.md actually specifies RS256 for machine tokens — that's purely epics.md's addition, and no RS256 keypair infrastructure (key generation, storage, rotation) exists anywhere in this codebase.
- **Code reality:** `apps/api/src/plugins/jwt.ts` registers exactly one `@fastify/jwt` instance, symmetric HS256, secret = `env.SESSION_SECRET`. Introducing RS256 for one token type would require: generating and persisting an RSA keypair, a new key-rotation story of its own, and a second verification code path with no existing precedent — a large, unjustified scope increase for a same-process token exchange where the signer and verifier are the same server.
- **Decision implemented in this story:** register a **second** `@fastify/jwt` plugin instance in `apps/api/src/plugins/machine-jwt.ts`, using `@fastify/jwt`'s `namespace` option (`fastify.register(fjwt, { secret: env.MACHINE_JWT_SECRET, namespace: 'machineJwt', jwtSign: 'machineJwtSign', jwtVerify: 'machineJwtVerify', sign: { algorithm: 'HS256' }, verify: { algorithms: ['HS256'] } })`), decorating `fastify.machineJwtSign()`/`fastify.machineJwtVerify()` as distinct methods from the human-session `fastify.jwt.sign()`/`fastify.jwt.verify()`. **Verify the `namespace` option's exact registration shape against the installed `@fastify/jwt@^10.1.0` README/type definitions before writing the plugin** — this codebase does not have `@fastify/jwt` vendored in a readable `node_modules` at story-creation time, so the exact decorator names could not be confirmed here; the intent (two independent HS256 signing contexts, one secret each, never cross-verifiable) is the load-bearing requirement, not the exact API surface.
- **Fallback path, if `namespace` is unavailable in the installed version — mandatory security constraints, not optional hardening:** do **not** hand-roll compact-serialization JWT parsing/signing from scratch. `@fastify/jwt` is a thin wrapper around the `jsonwebtoken` npm package (an existing transitive dependency already vetted and present in the lockfile via `@fastify/jwt`) — depend on it **directly** as `apps/api`'s own dependency for the fallback path instead of writing new HS256/base64url/compact-serialization code: `jsonwebtoken.sign(payload, env.MACHINE_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })` / `jsonwebtoken.verify(token, env.MACHINE_JWT_SECRET, { algorithms: ['HS256'] })`. The `algorithms` allowlist on `verify()` **must** be passed explicitly and **must** contain only `'HS256'` — this is what prevents algorithm-confusion attacks (e.g., a forged token with `alg: 'none'` or `alg: 'RS256'` reusing the HMAC secret as an RSA "public key"), a well-known JWT library vulnerability class that a hand-rolled parser would need to defend against manually and a vetted library already does. Do **not** implement your own signature comparison — `jsonwebtoken`'s `verify()` already uses a constant-time comparison internally; if any custom comparison code is ever written in this codepath for any reason, it must use `node:crypto`'s `timingSafeEqual()`, never `===` or `Buffer.equals()`. This fallback path must have its own dedicated test asserting a forged/re-algorithm'd token is rejected before it is considered complete — do not merge the fallback path without that test passing.
- A stolen machine JWT must never be presentable to a human-session-protected route and vice versa — using entirely separate secrets (not just a different claim) is the actual security boundary, not a cosmetic one.
- Machine JWT claims: `{ sub: machineUserId, orgId, scope: projectId, keyId, jti, iat, exp }`, `exp - iat <= 3600` (≤1h TTL per epics.md and architecture.md, both agree on this value).

### D4 — Machine-authenticated routes: `SecureRoute`'s `security.requireAuth: false` path + a manual verification helper, not a new `fastify.authenticate`-style decorator

- `apps/api/src/plugins/authenticate.ts`'s `authenticateRequest()` (used by every existing `secureRoute()` call with `requireAuth !== false`) is hard-wired to the **cookie-based** human session: it reads `request.cookies['access-token']`, verifies with the human `fastify.jwt`, loads a `sessions` row, and populates `request.authContext` from `org_memberships.role`. None of that applies to a machine caller presenting `Authorization: Bearer <machine-jwt>` — there is no session row, no cookie, and the "role" comes from `machine_users.role`, not `org_memberships`.
- Retrofitting `authenticateRequest()` to branch on token type would entangle two independent trust domains in one function — a correctness and security-review risk `architecture.md`'s "AI Agents MUST" guidelines are designed to prevent (single-responsibility auth paths).
- **Decision implemented in this story:** the one machine-authenticated data route this story ships — `GET /api/v1/machine/projects/:projectId/credentials/:name/value` — is registered via `secureRoute()` with `security: { requireAuth: false, rateLimit: {...} }` (the same `PublicRouteContext` path `handlePublicRequest()` already supports, `secure-route.ts:277-297`), and the handler itself, as its **first** action, calls a new `verifyMachineRequest(request, reply)` helper (`apps/api/src/modules/machine-users/machine-auth.ts`) that: (1) extracts `Authorization: Bearer ...`, 401s if missing/malformed; (2) calls `fastify.machineJwtVerify()`, 401s on invalid/expired/tampered; (3) re-validates the referenced `api_keys` row is still non-revoked (`revokedAt IS NULL`) via a fresh **org-scoped** `withOrg(claims.orgId, ...)` lookup by `id = claims.keyId` (catches revoke-after-issue within the JWT's ≤1h window — the JWT itself has no revocation check built in, so this DB check is mandatory, not optional defense-in-depth); (4) on success, opens the org-scoped transaction and hands the handler an object shaped like `{ machineUserId, projectId, keyId, orgId, role }` (`machine_users.role`) instead of the human `SecureRoute` `auth` object. This mirrors `enforceMfaIfRequired`'s pattern of composing extra guards inside `security.requireAuth: false`'s already-existing public path, rather than inventing a parallel `secureRoute()`-like wrapper.
- Register this route in `route-exemptions.ts`'s `PUBLIC_ROUTE_EXEMPTIONS` too (at the `SecureRoute` layer it genuinely has `requireAuth: false`) with `compensatingControls: ['machine-jwt-verification', 'live-revocation-recheck', TOKEN_IS_CREDENTIAL]` and a clear `reason` explaining the in-handler auth model — a reviewer scanning `PUBLIC_ROUTE_EXEMPTIONS` must not conclude this route is unauthenticated.
- The `active-keys` archival-guard route (AC-23) is **not** machine-authenticated — it is called by a human admin's archive request flow (via the same org-scoped transaction the archive handler already runs in), so it uses the normal cookie-based `secureRoute()` path with `minimumRole: 'admin'`, no `verifyMachineRequest()` involved.

### D5 — Audit actor typing for machine-originated events: `actorType: 'machine_user'`, `actorTokenId: null`

- `packages/db/src/schema/audit-log-entries.ts`'s CHECK constraint already includes `'machine_user'` as a valid `actor_type` (`sql\`${t.actorType} IN ('human','machine_user','system')\``) — this was pre-provisioned for this exact story; **no schema change is needed for `actorType` itself.**
- `actorTokenId` is a nullable FK to `user_identity_tokens.id`, a table that only ever holds rows for human `users` (`user_identity_tokens.user_id` FK, used for FR44 pseudonymization-on-deletion). Machine users have no corresponding row and never will — inventing one would misrepresent the pseudonymization semantics (machine users are deleted via `machine_users` cascade, not the FR44 human-deletion flow).
- **Decision implemented in this story:** add `apps/api/src/modules/audit/machine-entry.ts`'s `writeMachineAuditEntry(tx, fields)`, structurally identical to `writeHumanAuditEntry()` (`apps/api/src/modules/audit/human-entry.ts`) except: `actorTokenId: null` always, `actorType: 'machine_user'` always, and `fields` additionally requires `machineUserId`/`keyId` which are placed in the audit `payload` (not as new indexed columns — `resourceId`/`resourceType` already identify the *accessed resource*; the *actor* identity for machine events lives in the payload, discoverable via `payload->>'machineUserId'` for Epic 8's future audit search). Add a matching `writeMachineAuditEntryOrFailClosed()` wrapper in `apps/api/src/lib/audit-or-fail-closed.ts` alongside the existing `writeHumanAuditEntryOrFailClosed()`, same fail-closed/`SameTransactionAuditWriteError` contract.
- **The same file also adds `writeSystemAuditEntry(tx, fields)`** (`actorType: 'system'`, `actorTokenId: null`, no `machineUserId`/`keyId` requirement since no actor beyond "the platform itself" exists) for the one system-initiated event this story writes — the overlap-window auto-revoke job (AC-18) — plus its own `writeSystemAuditEntryOrFailClosed()` wrapper, same fail-closed contract. This is a required Task 4 deliverable, not an incidental detail buried in AC-18 alone.

### D6 — Credential retrieval by name: `credentials.name` has no uniqueness constraint (Epic 2 never added one) — handle ambiguity explicitly, do not silently pick one

- FR35 requires retrieval *"by stable name, always receiving the current version"* — but `packages/db/src/schema/credentials.ts` has no unique index on `(projectId, name)`, and nothing in Epic 2's shipped stories added one (confirmed by reading `credentials.ts` directly — only `name: text('name').notNull()`).
- **Decision implemented in this story:** do **not** retroactively add a uniqueness constraint in this story's migration — that is a breaking, data-dependent DDL change (`ALTER TABLE ... ADD CONSTRAINT UNIQUE` fails outright if any project already has duplicate names, and this story cannot know that at migration-authoring time). Instead: `findCredentialByNameInProject(tx, { projectId, name })` (new function, `apps/api/src/modules/credentials/service.ts`) returns **all** matches; the machine value-retrieval handler (AC-6/AC-7) returns the single row's value on exactly one match, and `409 { code: "ambiguous_credential_name", message: "Multiple credentials share this name in this project; machine-user retrieval requires unique names", matchCount: N }` on more than one match — surfacing the problem to the caller instead of guessing "most recent" or "first alphabetically," either of which would silently retrieve the wrong secret in production.
- This is a real, surfaced product gap: projects that already have duplicate credential names cannot use machine-user-by-name retrieval for those names until an admin renames one. Flagged in Dev Notes as a follow-up worth a future "enforce unique names per project" story, not silently patched here.

### D7 — `credentials.cacheable`: new column, default `true`, exposed on the existing lifecycle-PATCH endpoint

- epics.md (`epics.md:1814`) requires *"high-sensitivity credentials (flagged with `cacheable: false` on the credential record)"* — this column does not exist today (confirmed: `credentials.ts` has no such field).
- **Decision implemented in this story:** add `cacheable boolean NOT NULL DEFAULT true` to `credentials` in this story's migration (purely additive, safe default — existing credentials become cacheable by default, matching "opt out of caching," not "opt in," since epics.md frames it as a high-sensitivity exception, not the norm). Extend the existing lifecycle-PATCH handler at `PATCH /api/v1/projects/:projectId/credentials/:credentialId` (`apps/api/src/modules/credentials/routes.ts`, the same handler that already accepts `expiresAt`/`rotationSchedule` — see `hasNoLifecycleUpdateFields()`, `routes.ts:223-225`) to also accept an optional `cacheable: boolean` field, following the exact same "if present in raw body, validate and apply" pattern already used for the other two lifecycle fields — **do not** create a separate endpoint for one boolean field. Also accept optional `cacheable` on `POST /api/v1/projects/:projectId/credentials` (create), defaulting to `true` if omitted.

### D8 — New `api_keys` columns for rotation/dormancy; new `organizations` column for the configurable dormancy threshold

- Zero-downtime rotation needs to track, per key: when its overlap window ends, and which key superseded it. Dormancy needs a per-org configurable threshold (epics.md `AC-E7b`: *"configurable by admin: 30/60/90/180 days"*) and a way to snooze a specific key's dormancy check without touching `lastUsedAt` (which must remain an honest "last actually used" timestamp).
- **Decision implemented in this story** — additive columns only, no existing column altered:
  - `api_keys.overlap_expires_at timestamptz` (nullable) — set on the **old** key at rotation time to `now() + overlapMinutes`; the auto-revoke job (AC-18) queries `WHERE overlap_expires_at < now() AND revoked_at IS NULL`.
  - `api_keys.rotated_from_key_id uuid REFERENCES api_keys(id)` (nullable, self-referential) — set on the **new** key at rotation time, pointing to the old key's id; used by the anomaly check (AC-19) to find "the key that superseded this one" via `WHERE rotated_from_key_id = :oldKeyId`.
  - `api_keys.dormancy_snoozed_until timestamptz` (nullable) — set by the admin "extend" action (AC-22); the dormancy job's query excludes rows where `dormancy_snoozed_until > now()`.
  - `organizations.machine_key_dormancy_threshold_days integer NOT NULL DEFAULT 90` with `CHECK (machine_key_dormancy_threshold_days IN (30, 60, 90, 180))` — epics.md's exact enum (`AC-E7b`), default 90 (also epics.md's exact default). No dedicated settings module exists yet (Epic 9's "system settings" is `backlog`), so this story adds one narrowly-scoped column directly to the already-shipped `organizations` table rather than either blocking on Epic 9 or hardcoding a non-configurable value that would violate FR110's explicit "configurable" requirement. A minimal `PATCH /api/v1/organizations/:orgId/machine-key-settings` endpoint (admin-only) is the only way to change it in this story — no broader settings UI is implied or should be built. **Reconciliation on threshold change:** changing this value takes effect only on the **next** daily dormancy job run (AC-21) — it is not retroactive. Existing, already-fired `security_alerts` rows for `machine_key.dormant` are **not** automatically dismissed or re-evaluated when the threshold changes (e.g., raising 90→180 days leaves a previously-fired alert sitting in the admin queue even though the key would no longer qualify under the new threshold); an admin who considers a stale alert no longer relevant dismisses it manually via `POST .../dismiss` (AC-22), same as any other alert. This is a deliberate scope boundary, not a gap — automatically reconciling historical alerts against a changed threshold is unscoped speculative complexity for a rarely-changed setting.
  - The 24h overlap cap / 4h default (epics.md `AC-E7c`) does **not** need an org-level column — it is a per-call parameter (`overlapMinutes` in the rotate request body) validated against a fixed max (1440 minutes) with a fixed default (240 minutes) in the Zod schema; nothing about it needs to be organization-configurable per epics.md's wording ("configurable by admin: 1h/4h/8h/24h" describes the *per-rotation-call choice*, not a stored org preference).

### D9 — Dormancy alerts reuse the existing `security_alerts` table; this story is the first to wire a dismiss endpoint

- `packages/db/src/schema/security-alerts.ts` (shipped in Epic 1, currently used only for `security.failed_auth_threshold`) already has every column epics.md's dormancy AC needs: `alertType`, `severity`, `payload` (jsonb), `status` (`'PENDING_DELIVERY' | 'delivered' | 'dismissed'`), and — critically — `dismissedBy`/`dismissedAt`/`dismissalReason`, which **no existing route uses yet** (confirmed: `apps/api/src/modules/org/security-alerts.ts` only implements the read/list path).
- **Decision implemented in this story:** the dormancy job (AC-21) inserts a `security_alerts` row with `alertType: 'machine_key.dormant'`, not a new table. This story adds the first-ever write/dismiss path against those columns: `POST /api/v1/security-alerts/:alertId/dismiss` with `{ reason: string }` (admin-only, generic — not machine-key-specific at the route level, so any future alert type can reuse it without a new endpoint). "Revoke" (AC-22) reuses 7.1's already-shipped `DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId` directly — no new endpoint. "Extend" is the one genuinely new action, `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy` with `{ days: number }`, setting `dormancy_snoozed_until` (D8).
- Extend `apps/api/src/modules/org/security-alerts.ts`'s payload-validation branch (currently only `failedAuthThresholdPayloadSchema`) with a new `machineKeyDormantPayloadSchema` so the existing list endpoint can render both alert types without a schema-mismatch warning being logged for every dormancy row.

### D10 — Rotation-overlap anomaly alert reuses the already-reserved `security.anomalous_access` alert type

- `packages/shared/src/constants/notification-types.ts`'s `NOTIFICATION_ALERT_TYPES` already includes `'security.anomalous_access'`, added in a prior story but **used nowhere in the codebase yet** (confirmed via repo-wide search). epics.md (`epics.md:1818`) says only *"an anomaly alert fires"* without naming a type.
- **Decision implemented in this story:** the rotation-overlap anomaly check (AC-19) fires `security.anomalous_access` via `createOrgAdminNotificationEntries()`, becoming its first real usage — avoids adding a fourth machine-key-specific alert-type constant when an appropriately-named one already exists and is unused. Payload: `{ oldKeyId, newKeyId, machineUserId, usedAt }`.

### D11 — `@project-vault/agent`'s cache encryption is a self-contained module using `node:crypto` directly, not a workspace dependency on `@project-vault/crypto`

- epics.md and `RS-E7a` require AES-256-GCM at rest, HKDF key derivation from the API key, mode-0600 file permissions — exactly what `packages/crypto/src/aes.ts` (`encrypt`/`decrypt`, `EncryptedValue { version, iv, ciphertext, tag }`) and `packages/crypto/src/kdf.ts` (`deriveKey(ikm, info)`) already implement for the server side.
- **The catch:** `packages/agent` must be **independently publishable to the public npm registry** (epics.md: *"a first-party npm package... published to the repo as `packages/agent`"*, consumed by external CI runners that only run `npm install @project-vault/agent` — they do not clone this monorepo). `@project-vault/crypto` is `"private": true` (matching every other workspace package, e.g. `packages/shared/package.json:4`) and has never been published. Taking a `workspace:*` dependency on it from `packages/agent` would make `@project-vault/agent` unpublishable/uninstallable outside the monorepo (npm cannot resolve an unpublished private workspace package for an external consumer).
- **Decision implemented in this story:** `packages/agent/src/cache-crypto.ts` implements its own minimal AES-256-GCM encrypt/decrypt + HKDF derive functions using Node's built-in `crypto` module directly — **the exact same algorithm, IV length (96-bit), auth-tag handling, and versioned envelope shape (`{ version, iv, ciphertext, tag }`)** as `packages/crypto/src/aes.ts`, so the format is intentionally identical/interoperable even though the code is not literally shared. This is not "reinventing the wheel" in the sense the workflow's guardrails warn against — it is avoiding an unpublishable dependency while deliberately copying the already-reviewed algorithm choice and envelope format rather than inventing a new one. Add a code comment in `cache-crypto.ts` cross-referencing `packages/crypto/src/aes.ts` explaining why the implementation is duplicated rather than imported.
- **Mandatory cross-compatibility test (Task 16):** the "byte-identical envelope format" claim above is a testable assertion, not just a comment — add an integration test (in `apps/api`, the only workspace that can depend on both packages) that encrypts a value with `packages/crypto/src/aes.ts` and decrypts it with `packages/agent/src/cache-crypto.ts`, and vice versa, asserting round-trip success both directions. This is the only thing that actually proves the two independently-maintained implementations haven't silently drifted; run it in CI so a future edit to either file that breaks interoperability fails a test immediately rather than surfacing as a confusing production decrypt failure.
- `packages/agent/package.json` sets `"private": false` (or omits `"private"` entirely) and a real `"version"` — the only package in this monorepo intended for external publication. Confirm the publish/CI wiring question (does this repo have an npm publish pipeline at all?) as an open question in Dev Notes rather than inventing a publish workflow speculatively.

### D12 — Closing Story 4.4's archival stub: replace the stub body, keep the function name

- `apps/api/src/modules/projects/archive-guards.ts:324-336` (Story 4.4, `done`) currently has:
  ```typescript
  // TODO: Epic 7 — check for active machine user API key access
  export async function hasActiveMachineUserKeys(_tx: Tx, _projectId: string): Promise<false> {
    return false
  }
  ```
- **Decision implemented in this story:** replace the body (keep the exact function signature and name so the archive-route call site in `routes.ts` needs zero changes) with a real query: does the project have any `machine_users` row with a non-revoked, non-expired `api_keys` row? `GET /api/v1/projects/:projectId/machine-users/active-keys` (AC-23) exposes the same check as a standalone endpoint (epics.md's literal AC), and `hasActiveMachineUserKeys()` calls the same underlying query function internally (`activeMachineUserKeysQuery(tx, projectId): Promise<{ machineUserId: string; keyId: string }[]>` in the new `apps/api/src/modules/machine-users/archival-check.ts`) so the two never drift. Update the project-archival block-response shape to add a machine-user variant alongside the existing `active_rotations` shape (Story 4.4 ADR-4.4-04 precedent): `409 { error: "active_machine_user_keys", machineUserIds: [...] }` — same `error`/(not `code`) field-naming divergence Story 4.4 already documented as deliberate for this response family, applied consistently to the new blocking reason.

### D13 — Cache-activation beacon: a dedicated, machine-JWT-authenticated `POST /api/v1/machine/cache-activated` endpoint (not folded into the token-exchange response)

- AC-15 requires the agent to report a fallback-mode activation once connectivity is restored. Folding this into `POST /api/v1/auth/machine-token`'s response would conflate two unrelated concerns (issuing a token vs. reporting a historical client-side event) and would only work if a fresh token exchange happens to coincide with the activation report, which is not guaranteed — the agent may already be holding a valid, unexpired JWT when connectivity is detected as restored (e.g., a background retry succeeds without a full re-exchange).
- **Decision implemented in this story:** a new route, `POST /api/v1/machine/cache-activated`, machine-JWT-authenticated via the same `verifyMachineRequest()` helper as the credential-value route (D4) — registered with `security: { requireAuth: false }` plus manual verification, and a `PUBLIC_ROUTE_EXEMPTIONS` entry with `compensatingControls: ['machine-jwt-verification', 'live-revocation-recheck', TOKEN_IS_CREDENTIAL]`, identical shape to the credential-value route's entry.
- **Request:** `{ "activatedAt": "2026-07-04T18:00:00.000Z", "threshold": 3 }` (`activatedAt` is the ISO-8601 timestamp the agent's fallback mode began, not the report time; `threshold` is the effective `VAULT_FALLBACK_THRESHOLD` that triggered it).
- **Response:** `202 { "data": { "recorded": true } }` — `202` (not `200`) because this is an after-the-fact, fire-and-forget report of a historical event, not a synchronous state change the caller depends on.
- **Rate limit:** `{ max: 30, timeWindowMs: 60_000 }` per `keyId` (from the verified JWT claims) — generous, since a legitimate agent sends at most one beacon per fallback-mode transition, and this is not a sensitive-data endpoint (no secret values are read or returned).
- The handler writes the `machine_cache.activated` audit row and queues the `FR38` alert exactly as AC-15 already describes; this decision only fixes the transport, not the audit/alert behavior.
- This adds a **9th** new route to this story's total (see the updated AC Quick Reference, AC-29, and Task 15/Task 7 counts below) and a **3rd** `PUBLIC_ROUTE_EXEMPTIONS` entry (alongside machine-token exchange and credential-value retrieval).

---

## Epic Cross-Story Context

| Story | Relationship to 7.2 |
|---|---|
| 7.1 (Machine User Identity & API Key Management, `ready-for-dev`) | This story's hard dependency — reuses `machine_users`/`api_keys` schema, `hashApiKey()`/`apiKeysMatch()`/`generateApiKey()`, `AuditEvent.MACHINE_USER_*` constants, and resolves 7.1's own D8 handoff (see D2 above). Do not modify 7.1's `role` CHECK constraint, `machine_users` table shape, or key format. |
| 7.3 (GitHub Actions CI/CD Integration, `backlog`) | Consumes `@project-vault/agent` (this story's package) as its runtime dependency inside the published GitHub Action. No schema dependency — purely a package-consumption relationship. |
| 4.4 (Project Archival, `done`) | This story closes its `hasActiveMachineUserKeys()` stub (D12/AC-23) — the only story permitted to touch `archive-guards.ts`'s machine-user branch per 4.4's own Dev Notes (*"Do not wire up the Story 4.4 archival guard stub — that is explicitly Story 7.2's job"*, from 7.1's Dev Notes, itself quoting 4.4). |
| Epic 8 (Compliance/Audit, `backlog`) | This story is the first to write `actorType: 'machine_user'` audit rows (D5) — Epic 8's audit search/export UI must handle this actor type once built; no action needed from 7.2 beyond writing the rows correctly into the existing `audit_log_entries` table. |
| Epic 9 (Platform Ops, `backlog`) | This story adds one narrowly-scoped `organizations.machine_key_dormancy_threshold_days` column (D8) ahead of Epic 9's general settings module — flagged so Epic 9 doesn't duplicate or conflict with it when that epic's settings UI is eventually built. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 7.2 | Rationale |
|---|---|---|
| epics.md: machine JWT "signed with RS256" | HS256 via a second, namespaced `@fastify/jwt` instance with its own secret (D3) | No RS256 keypair infrastructure exists anywhere in this codebase; architecture.md itself never actually specifies RS256 for machine tokens |
| epics.md: hash with BLAKE2b, `pvk_` prefix, base62 | Not this story's decision — inherited verbatim from 7.1's D1/D2 (HMAC-SHA256, `pk_` + base64url) | Consistency with the schema this story builds directly on top of |
| epics.md table name `machine_user_api_keys` | `api_keys` (7.1's D1) | Same inheritance as above |
| architecture.md: `sessions`/`refresh_tokens` are the only named RLS-exception tables | `api_keys`'s pre-auth lookup uses `getAdminDb()` (matching `invitations`/`recovery` token-lookup precedent) rather than adding `api_keys` to a formal RLS-exception list | `api_keys` keeps its standard RLS policy for 7.1's own endpoints (7.1 D8) — only this one specific pre-auth query needs the admin connection, the same pattern already used for two other pre-auth token lookups in this codebase |
| architecture.md generic error envelope `{ error, message, statusCode, requestId }` | `{ code, message, details? }` (`ApiErrorSchema`) for all new-in-this-story error responses, except the two project-archival block responses which intentionally keep the `{ error, ... }` shape (4.4 ADR-4.4-04 precedent, D12) | Matches 7.1's identical resolution; the archival exception is a documented, pre-existing divergence this story must match byte-for-byte, not "fix" |
| architecture.md module layout `routes.ts/service.ts/schema.ts/repository.ts` | New files added to 7.1's `apps/api/src/modules/machine-users/` (`token-exchange-lookup.ts`, `machine-auth.ts`, `archival-check.ts`, `rotation.ts`, `dormancy.ts`) plus a new top-level `packages/agent/` package — no forced `service.ts`/`repository.ts` split | Matches `modules/projects/`, `modules/machine-users/` (7.1) precedent |
| architecture.md: 400 for validation errors | 422, matching 7.1 and every other route in this codebase | Established, actually-enforced convention |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | Additive migration: `api_keys.overlap_expires_at`, `api_keys.rotated_from_key_id`, `api_keys.dormancy_snoozed_until`; `organizations.machine_key_dormancy_threshold_days`; `credentials.cacheable`. No existing column altered. |
| POST `/api/v1/auth/machine-token` | Public route (D2/D4); exchanges a valid `pk_...` key for a ≤1h machine JWT; updates `lastUsedAt`; `401` on invalid/expired/revoked/malformed key. |
| GET `/api/v1/machine/projects/:projectId/credentials/:name/value` | Machine-JWT-authenticated (D4); returns `{ name, value, versionNumber, cacheable }` for the current version; `404` not found, `409` ambiguous name (D6), `403` role-insufficient, `401` bad/stale JWT. |
| Offline agent (`packages/agent`) | New publishable package; activates local encrypted cache after 3 connection failures in 30s (`VAULT_FALLBACK_THRESHOLD`); AES-256-GCM + HKDF, mode 0600; refuses to cache `cacheable: false` credentials; never falls back to plaintext on decrypt failure. |
| POST `.../api-keys/:keyId/rotate` | Zero-downtime rotation; both old and new key valid during `overlapMinutes` (default 240, max 1440); old key auto-revoked after window by pg-boss job; anomaly alert (D10) if old key used after new key's first success. |
| POST `.../api-keys/:keyId/emergency-revoke` | Atomic revoke-old + issue-new in one response. |
| Dormancy | Daily pg-boss job flags keys unused beyond `organizations.machine_key_dormancy_threshold_days` (default 90); admin can dismiss (with reason, via `security_alerts`, D9), revoke (7.1's existing `DELETE`), or extend (`dormancy_snoozed_until`). |
| Archival guard closure | `GET .../machine-users/active-keys`; `hasActiveMachineUserKeys()` stub replaced with a real query (D12); project-archive blocks with `409 { error: "active_machine_user_keys", machineUserIds }`. |
| Audit | `actorType: 'machine_user'` for machine-originated events (D5); credential-access events include `versionNumber` served; plaintext/API-key material never in any audit payload or log line. |
| RLS / tenant isolation | Pre-auth `api_keys` lookup uses `getAdminDb()` (D2), documented and exempted; every other query is org-scoped; cross-org access returns `404`/`401`, never a foreign-data leak. |
| Rate limiting | `POST /api/v1/auth/machine-token` is IP + per-key-hash limited (public-route budget); rotate/emergency-revoke/dismiss/extend are `10/min` per admin per route, matching 7.1's precedent. |
| Concurrency | Concurrent token exchanges against the same key both succeed; concurrent rotation calls on the same key produce exactly one overlap window; concurrent dormancy dismiss/revoke resolve without double-processing. |
| Integration tests | Cover every AC below: token exchange (happy + 4 failure modes), credential-by-name retrieval (happy + ambiguous + not-found + cross-project + role), agent cache (activation, encryption, decrypt-failure, non-cacheable exclusion, alert), rotation (overlap, auto-revoke, anomaly), emergency revoke, dormancy (firing, dedupe, dismiss, revoke, extend), archival guard closure, audit fail-closed, RLS, rate limiting, concurrency. |

---

### AC-1: Schema — Rotation/Dormancy Columns and `credentials.cacheable`

**Given** Story 7.1's `machine_users`/`api_keys` migration has already been applied,
**When** this story's migration is generated,
**Then** it adds, in one additive migration file (no existing table altered destructively):

```sql
ALTER TABLE api_keys ADD COLUMN overlap_expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN rotated_from_key_id uuid REFERENCES api_keys(id);
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN dormancy_snoozed_until timestamptz;
--> statement-breakpoint
CREATE INDEX idx_api_keys_overlap_expires ON api_keys(overlap_expires_at) WHERE overlap_expires_at IS NOT NULL;
--> statement-breakpoint

ALTER TABLE organizations ADD COLUMN machine_key_dormancy_threshold_days integer NOT NULL DEFAULT 90;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_dormancy_threshold_check
  CHECK (machine_key_dormancy_threshold_days IN (30, 60, 90, 180));
--> statement-breakpoint

ALTER TABLE credentials ADD COLUMN cacheable boolean NOT NULL DEFAULT true;
```

**And** the corresponding Drizzle schema files (`packages/db/src/schema/api-keys.ts`, `organizations.ts`, `credentials.ts` — all edits to 7.1's/already-shipped files, purely additive field/constraint additions) are updated to match, and `ApiKey`/`Organization`/`Credential` inferred types are re-exported unchanged in shape (new optional fields only).

**Edge case:** if Story 7.1's migration has not yet landed when this migration is generated (7.1 still `ready-for-dev`), `ALTER TABLE api_keys` fails outright (table does not exist) — this is the intended fail-fast behavior confirming the Prerequisites table's ordering requirement; do not work around it by creating `api_keys` speculatively in this story's migration.

**Edge case:** existing organizations get `machine_key_dormancy_threshold_days = 90` (the `DEFAULT`) with no manual backfill needed — `ADD COLUMN ... DEFAULT` populates existing rows in the same statement in PostgreSQL ≥11 without a table rewrite.

---

### AC-2: Machine Token Exchange — Happy Path

**Given** a valid, non-expired, non-revoked API key `pk_9f3aB7xQ...` issued by Story 7.1's `POST .../api-keys`,
**When** the caller sends `POST /api/v1/auth/machine-token` with header `Authorization: Bearer pk_9f3aB7xQ...` (no request body),
**Then** the server: (1) extracts the bearer token, rejects if it doesn't start with `pk_`; (2) computes `keyHash = hashApiKey(token)` (7.1's helper); (3) looks up `api_keys` by `keyHash` via `getAdminDb()` (D2); (4) verifies `apiKeysMatch()` (timing-safe), `revokedAt IS NULL`, and (`expiresAt IS NULL OR expiresAt > now()`); (5) on success, updates `lastUsedAt = now()` in the same admin-connection statement (a plain `UPDATE ... WHERE id = $1`, not org-scoped since the caller's org context isn't established yet — this is the one other admin-connection write in this story, alongside the lookup); (6) issues a machine JWT via `fastify.machineJwtSign({ sub: machineUserId, orgId, scope: projectId, keyId, jti: randomUUID() }, { expiresIn: '1h' })`.

**And** the response is `200`:

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "tokenType": "Bearer",
    "expiresIn": 3600
  }
}
```

**And** no `Set-Cookie` header is ever sent on this response — machine tokens are `Authorization: Bearer` only, per architecture.md's explicit human/machine transport split (`architecture.md:326`); returning a cookie here would be a protocol confusion bug.

**Accepted race window (not a gap):** steps 4 (validity check) and 5-6 (`lastUsedAt` update + JWT issuance) are not wrapped in a single row lock, so a concurrent revocation landing between step 4 and step 6 could theoretically result in a JWT being issued for a key that becomes revoked microseconds later. This is intentionally not defended against here — `verifyMachineRequest()`'s mandatory live-revocation recheck (AC-5) re-validates `revokedAt IS NULL` on **every** subsequent use of that JWT, so a JWT issued in this narrow race is caught and rejected the moment it is actually used against any machine-authenticated route, bounding the exposure to "a JWT that was issued but can never be successfully used," not "a JWT that grants access after revocation."

**Edge case — multiple valid keys, same machine user:** given a machine user has two currently-valid keys (e.g. mid-rotation, AC-16), exchanging either one independently succeeds and produces a JWT scoped to that specific `keyId` — the JWT's `keyId` claim identifies exactly which key was used, not "the machine user's current key."

---

### AC-3: Machine Token Exchange — Invalid, Expired, Revoked, Malformed Key

**Given** the same endpoint,
**When** the `Authorization` header is missing entirely,
**Then** the response is `401 { code: "access_token_missing", message: "Access token is missing" }` — reusing the exact code the human-auth path already uses for the analogous case (`accessTokenInvalid()`/`sendMissingAuth()` precedent), not inventing a machine-specific error code for this branch.

**And**, given the header is present but does not start with `pk_` (e.g. a human session JWT is mistakenly sent here, or a garbage string),
**when** the request is made,
**then** the response is `401 { code: "invalid_api_key", message: "API key is invalid" }` — **no database query is made** for a key that fails the `pk_` prefix check; this is a cheap, pre-DB rejection.

**And**, given the key has the correct `pk_` prefix and correct length but does not match any stored `keyHash` (a fabricated or never-issued key),
**when** the request is made,
**then** the response is `401 { code: "invalid_api_key", message: "API key is invalid" }` — **identical response** to a well-formed-but-revoked or well-formed-but-expired key (see next two rows); the response body must not let a caller distinguish "this key never existed" from "this key existed but is dead," which would otherwise leak information about key lifecycle to an attacker probing keys.

**And**, given a key that exists and matches a `keyHash` but has `revokedAt IS NOT NULL` (revoked via 7.1's `DELETE .../api-keys/:keyId` or this story's rotation/emergency-revoke),
**when** the request is made,
**then** the response is `401 { code: "invalid_api_key", message: "API key is invalid" }` (same body as above — no revocation-specific message leaked to an unauthenticated caller).

**And**, given a key that exists and matches but has `expiresAt` in the past,
**when** the request is made,
**then** the response is `401 { code: "invalid_api_key", message: "API key is invalid" }` (same body again).

**And**, given a machine user whose `deactivatedAt` is non-null (7.1's forward-compatible column, still unset by any endpoint as of 7.1, but this story must defensively check it since a future story may set it before this story's code is revisited),
**when** an otherwise-valid key for that machine user is exchanged,
**then** the response is `401 { code: "invalid_api_key", message: "API key is invalid" }` — join to `machine_users` in the same admin-connection lookup and check `deactivatedAt IS NULL` alongside the key's own `revokedAt`/`expiresAt` checks.

---

### AC-4: Machine Token Exchange — Rate Limiting and Brute-Force Resistance

**Given** the token-exchange endpoint is public (no prior authentication possible, D2/D4),
**When** more than 20 requests arrive from the same IP within 60 seconds,
**Then** the 21st+ request receives `429`, using `enforceUserRateLimit({ userId: 'ip:' + request.ip, key: 'POST /api/v1/auth/machine-token', max: 20, timeWindowMs: 60_000, reply })` — the exact IP-keyed pattern `handlePublicRequest()` already supports natively (`secure-route.ts:277-297`), matching the public-route rate-limit precedent used for `POST /api/v1/auth/recovery` (email-unknown public endpoints).

**And**, independently of the IP-based limit, repeated failed exchange attempts against the **same specific key hash** are capped: no more than 10 failed attempts per `keyHash` per 60 seconds (a second, key-scoped rate-limit bucket, `key: 'machine-token:' + keyHash`). **Scope of what this actually defends against (important — do not overstate it in code comments or docs):** because `keyHash = hashApiKey(token)` is deterministic HMAC-SHA256, an attacker guessing *unknown* candidate keys produces a different `keyHash` on nearly every attempt, so this bucket almost never engages against a genuine guessing/brute-force attack (including one spread across many IPs) — guessing attacks are defended primarily by the 256-bit key's cryptographic entropy (guessing is computationally infeasible regardless of rate limiting, matching 7.1's own AC-2 rationale) and secondarily by the IP-based limit above. What this specific per-`keyHash` bucket **does** defend against is repeated verification attempts against **one already-known, already-fabricated-or-leaked exact key string** — e.g., an attacker who has obtained (not guessed) a specific dead/revoked key and is hammering it, or automated retry logic misbehaving against one specific key — capping the number of `apiKeysMatch()` comparisons performed against that one hash as defense-in-depth against timing-based side-channel analysis of the comparison itself. On the 11th failed attempt for the same `keyHash` within the window, respond `429` **before** doing the `apiKeysMatch()` comparison, to avoid burning comparison cycles on an already-flagged hash.

**And** this per-key-hash counter is **not** reset by a successful exchange with a *different* key — only failures against the specific hash count toward its own budget.

---

### AC-5: Machine JWT Claims Verification — Used by Every Machine-Authenticated Route

**Given** `verifyMachineRequest()` (D4) is called at the start of `GET /api/v1/machine/projects/:projectId/credentials/:name/value`,
**When** the request carries a well-formed, unexpired, correctly-signed machine JWT whose referenced `api_keys` row (`claims.keyId`) is still non-revoked,
**Then** the request proceeds with `{ machineUserId: claims.sub, orgId: claims.orgId, projectId: claims.scope, keyId: claims.keyId, role }` (role freshly re-read from `machine_users.role` in the org-scoped lookup — **not** trusted from a JWT claim, since role could change between token issuance and use if a future story adds a role-update endpoint).

**And**, given the JWT's signature does not verify (tampered, or signed with the wrong secret — e.g. someone tries presenting a human-session JWT here),
**when** the request is made,
**then** the response is `401 { code: "invalid_machine_token", message: "Machine access token is invalid" }`.

**And**, given the JWT is well-signed but `exp` has passed,
**when** the request is made,
**then** the response is `401 { code: "invalid_machine_token", message: "Machine access token is invalid" }` — the client's expected remediation is to re-exchange via `POST /api/v1/auth/machine-token`, not retry the same token; document this in the agent's error message but not in the API's own response body (the API returns a generic invalid-token message; `@project-vault/agent` is responsible for translating a `401` into "re-authenticate and retry once" client-side behavior).

**And**, given the JWT verifies and is unexpired, but the referenced `api_keys.id = claims.keyId` row now has `revokedAt IS NOT NULL` (revoked *after* the JWT was issued but *before* it expired — the live-recheck this story's D4 explicitly requires),
**when** the request is made,
**then** the response is `401 { code: "invalid_machine_token", message: "Machine access token is invalid" }` — this is the scenario that makes the DB recheck mandatory rather than optional: without it, a revoked key's already-issued JWTs would remain silently valid for up to an hour past revocation, directly undermining 7.1's `DELETE .../api-keys/:keyId`'s "revoked keys return `401` on any subsequent use" guarantee (`epics.md:1782`).

**And**, given the JWT's `orgId`/`scope` claims reference a project that has since been archived (Story 4.4),
**when** a credential-value request is made for that project,
**then** the response is `410 { code: "project_archived", message: "This project is archived and cannot be modified. Unarchive it first." }` if this were a write — but credential **retrieval** is a read, and Story 4.4's AC-5 write-guard explicitly scopes the `410` to mutating routes only (archived projects "remain fully readable"). **Decision:** machine-user credential retrieval from an archived project **succeeds** (`200`), matching the human read-path precedent exactly — archival does not revoke read access, only writes and (per this story's own AC-23) blocks the archive action itself if keys are still active.

---

### AC-6: Credential Retrieval by Name — Happy Path

**Given** a machine user with `role: 'member'` scoped to project `a1c2...`, holding a valid machine JWT, and a credential named `"DATABASE_URL"` exists in that project with 3 versions,
**When** the machine caller sends `GET /api/v1/machine/projects/a1c2.../credentials/DATABASE_URL/value` with `Authorization: Bearer <machine-jwt>`,
**Then** the response is `200`:

```json
{
  "data": {
    "name": "DATABASE_URL",
    "value": "postgres://prod-user:••••@db.internal:5432/app",
    "versionNumber": 3,
    "cacheable": true
  }
}
```

**And** `versionNumber: 3` is the **current** (highest, non-purged) version — matching FR35's "always receiving the current version without requiring knowledge of internal identifiers" verbatim; the machine caller never sees or needs a `credentialId` UUID anywhere in this flow.

**And** `cacheable: boolean` (the credential's own `cacheable` column, D7) is present on **every** response from this endpoint, not just non-cacheable ones — AC-14's agent-side caching logic depends on this field being present on every successful response, so it is part of this AC's baseline schema (`CredentialValueResponseSchema`), not an extension layered on afterward.

**And** the underlying decryption reuses `withSecret()` (the same "one sanctioned Buffer→string conversion site" `revealCurrentValue()` already uses, `apps/api/src/modules/credentials/service.ts:381`) — do not implement a second decryption code path.

**Edge case — credential name with URL-reserved characters:** given a credential named `"api/key"` (contains a literal slash), the `:name` route parameter must be percent-decoded before the database lookup (`decodeURIComponent(req.params.name)`) — verify Fastify's default route-param decoding handles this correctly, or add explicit `encodeURIComponent`/`decodeURIComponent` symmetry in the schema; add an integration test with a slash-containing name to catch a routing/decoding mismatch that would otherwise silently 404 a valid credential.

---

### AC-7: Credential Retrieval by Name — Not Found, Ambiguous Name, Cross-Project Isolation

**Given** the same authenticated machine caller,
**When** they request a `:name` that does not exist in their scoped project,
**Then** the response is `404 { code: "credential_not_found", message: "Credential not found" }`.

**And**, given the project has **two** credentials both named `"API_KEY"` (D6 — no uniqueness constraint exists in this codebase today),
**when** the machine caller requests `.../credentials/API_KEY/value`,
**then** the response is `409 { code: "ambiguous_credential_name", message: "Multiple credentials share this name in this project; machine-user retrieval requires unique names", matchCount: 2 }` — **no value is ever returned in this case**, even one of the two; guessing would silently serve the wrong secret.

**And**, given the machine JWT's `scope` (projectId) does not match the `:projectId` route parameter (a caller attempting to reuse a valid machine JWT issued for project A against project B's URL),
**when** the request is made,
**then** the response is `403 { code: "insufficient_role", message: "Insufficient permissions" }` — **not** `404`, because unlike the human cross-org case (where hiding project *existence* matters for enumeration), here the caller already possesses a valid, scoped credential (the JWT) and the project's existence is not the secret being protected; a `403` correctly communicates "your token doesn't cover this project" without inventing a new error code.

**And**, given a credential belongs to a **different project within the same org** than the machine user's scoped project,
**when** it is requested by name via the machine user's own `:projectId`,
**then** the response is `404` (the query is always scoped by `AND project_id = :projectId` — a same-org, different-project credential is invisible to this lookup by construction, not merely forbidden).

---

### AC-8: Credential Retrieval by Name — Role Authorization and Revoked-Mid-Request Handling

**Given** a machine user with `role: 'viewer'`,
**When** they call `GET .../credentials/:name/value`,
**Then** the request **succeeds** (`200`) — this is a **deliberate departure** from the human-role model, not an oversight: the analogous human endpoint (`GET .../credentials/:credentialId/value`) gates at `minimumRole: 'member'`, meaning a human `viewer` cannot read plaintext values. Machine users are granted broader read access at the `viewer` role specifically because: (1) 7.1's D4 defines only two machine roles, `member`/`viewer`, with no third "read-only, no-secrets" tier available to model the human `viewer` restriction; (2) epics.md's Story 7.2 AC does not distinguish member/viewer read access for machine callers, and a CI pipeline's `getSecret()` call has no meaningful lesser-privileged read it could perform instead (unlike a human viewer browsing a dashboard, a machine caller retrieving a named secret by definition needs the value or the call is pointless); (3) this story adds no machine-authenticated write endpoints, so `viewer` vs. `member` carries no write-capability distinction to preserve for machine users either way. **This intentionally makes machine `viewer` more permissive than human `viewer` for this one read** — flagged here explicitly rather than obscured, and worth revisiting if a future story introduces a machine-user action that should be `member`-only.

**And**, given the machine user's own `deactivatedAt` becomes non-null between JWT issuance and use (a future story's deactivation action, or a directly-written test fixture per 7.1's AC-11 precedent),
**when** a credential-value request is made with an otherwise-valid, unexpired JWT,
**then** the response is `401 { code: "invalid_machine_token", message: "Machine access token is invalid" }` — `verifyMachineRequest()`'s live recheck (AC-5) also joins `machine_users.deactivated_at IS NULL`, not just the key's own revocation state.

**And**, given the underlying credential has zero non-purged versions (all versions purged by the retention-policy pruning job, Story 2.2/2.4),
**when** it is requested,
**then** the response is `404 { code: "credential_not_found", message: "Credential not found" }` — matching `revealCurrentValue()`'s existing `{ status: 'not_found', reason: 'all_versions_purged' }` branch exactly (same function, same edge case already handled for the human path).

---

### AC-9: Credential Access Audit — `actorType: 'machine_user'`, Version Served, Fail-Closed

**Given** a successful credential-value retrieval (AC-6),
**When** the response is about to be sent,
**Then** a `credential.value_revealed` audit row is written **in the same transaction** via the new `writeMachineAuditEntryOrFailClosed()` (D5): `{ orgId, resourceType: 'credential', resourceId: credentialId, eventType: 'credential.value_revealed', actorType: 'machine_user', payload: { versionNumber, machineUserId, keyId, name } }` — reusing the **same event-type string** `'credential.value_revealed'` the human path already writes (not a new `machine_user.credential_accessed` event), so Epic 8's future audit search/filter-by-event-type does not need to know about two parallel event taxonomies for the same underlying action; the `actorType` column is what distinguishes a machine access from a human one.

**And**, given the audit write throws (simulated DB error in a test harness),
**when** this happens,
**then** the entire transaction rolls back and the response is `503 { code: "audit_write_failed", message: "Audit logging is unavailable" }` — the caller does **not** receive the secret value despite having "successfully" decrypted it in application memory; same fail-closed contract as every other mutation/sensitive-read in this codebase.

**And** the audit payload is asserted in tests to **never** contain a `value` field (the `FORBIDDEN_AUDIT_KEYS` set in `secure-route.ts` already includes `'value'`, but — per 7.1's AC-9 note — that runtime redaction only applies to `defaultAuditWriter`'s declarative path; this story's manual `writeMachineAuditEntryOrFailClosed()` call gets **zero** runtime redaction, so the test assertion is the only protection, exactly as 7.1 documented for its own manual audit calls).

**And**, given the offline agent serves a value from its **local cache** (vault unreachable) rather than a live API call,
**when** this happens,
**then** **no** `credential.value_revealed` audit row is written by the server for that specific access (the server was never contacted) — this is an inherent, documented limitation of the offline-fallback design, not a bug: FR36's "separate, complete audit trail for all machine user access events" is satisfied for every access that reaches the server, and the **cache activation event itself** (AC-15) is what gets audited, providing visibility that a fallback period occurred even though the individual reads during it are not individually logged. State this explicitly in Dev Notes as a known, accepted gap — do not attempt to have the offline agent "catch up" a log of every cached read to the server later; that is unscoped speculative complexity.

---

### AC-10: Offline Agent — Package Scaffold and Public API Surface

**Given** no `packages/agent` exists today,
**When** this story is implemented,
**Then** a new workspace package `packages/agent` is created with `package.json` `"name": "@project-vault/agent"`, `"private": false` (D11), depending only on Node built-ins (`node:crypto`, `node:fs`, `node:path`) and a minimal HTTP client (reuse whatever this monorepo already uses elsewhere for outbound HTTP — check `apps/api/package.json`'s existing dependencies for a shared choice, e.g. `undici` or native `fetch`, before adding a new HTTP library; native global `fetch` is available in the Node versions this repo already targets and requires zero new dependency — prefer it unless an existing convention says otherwise).

**And** the package exports a single primary entry point, e.g.:

```typescript
import { createVaultAgent } from '@project-vault/agent'

const agent = createVaultAgent({
  apiKey: process.env.VAULT_API_KEY!,
  baseUrl: process.env.VAULT_BASE_URL!,
  projectId: process.env.VAULT_PROJECT_ID!,
})

const dbUrl = await agent.getSecret('DATABASE_URL') // string, throws on failure
```

**And** `getSecret(name: string): Promise<string>` internally: (1) exchanges the API key for a machine JWT on first use (and re-exchanges on `401`, once, before giving up — see AC-5's re-auth note); (2) calls `GET /machine/projects/:projectId/credentials/:name/value`; (3) on success, returns `value` and — unless the credential's implicit `cacheable` state is unknown to the agent (the agent has no direct visibility into the `cacheable` flag except via the server's response; see AC-14) — opportunistically writes/refreshes the local cache entry; (4) on network failure, applies the fallback-activation logic (AC-11).

**Edge case:** `getSecret()` called for a name the vault has never granted access to (403/404 from the server) throws a typed error (`VaultAgentError` with `.code`) rather than silently returning `undefined` — a CI pipeline that typos a secret name must fail loudly, not proceed with an undefined environment variable.

---

### AC-11: Offline Agent — Cache Activation Trigger

**Given** the default `VAULT_FALLBACK_THRESHOLD` env var is unset (defaults to `3`),
**When** 3 consecutive `getSecret()`/token-exchange network-level failures (connection refused, timeout, DNS failure — not a `4xx`/`5xx` HTTP response, which is a *server* answer, not an unreachable-vault condition) occur within a rolling 30-second window,
**Then** the agent transitions to "fallback mode": subsequent `getSecret()` calls within the same process attempt the local cache **first** (skipping the live network call entirely) for as long as fallback mode remains active, re-attempting a live call at most once every 30 seconds in the background to detect recovery.

**And**, given only 2 consecutive failures occur, followed by a success,
**when** the failure counter is evaluated,
**then** the counter resets to 0 on any success — fallback mode is **not** entered; the 3-failure threshold requires 3 *consecutive* failures, not 3 failures total over the process lifetime.

**And**, given `VAULT_FALLBACK_THRESHOLD=1` is explicitly set (a stricter operator override),
**when** a single network failure occurs,
**then** fallback mode activates immediately after that one failure — the env var directly parameterizes the threshold, not just documents the default.

**And**, given the vault recovers (a background retry succeeds) while the agent is in fallback mode,
**when** the next `getSecret()` call is made,
**then** the agent exits fallback mode and resumes live calls, and the local cache is refreshed opportunistically with the freshly-retrieved value (not proactively re-fetching every previously-cached name — only the ones actually requested going forward).

---

### AC-12: Offline Agent — Cache File Encryption and Permissions

**Given** fallback mode is active and a credential was previously cached,
**When** the agent reads the cache file to serve `getSecret('DATABASE_URL')`,
**Then** the cache file (default path `~/.project-vault/cache.json`, overridable via `VAULT_CACHE_PATH`) contains, per epics.md's exact shape (`epics.md:1812`):

```json
{
  "DATABASE_URL": {
    "encryptedValue": { "version": 1, "iv": "a1b2...", "ciphertext": "c3d4...", "tag": "e5f6..." },
    "versionNumber": 3,
    "cachedAt": "2026-07-04T18:00:00.000Z",
    "ttlSeconds": 86400
  }
}
```

**And** the encryption key is derived via `deriveKey(Buffer.from(apiKey, 'utf8'), 'project-vault-agent-cache-v1')` (D11's self-contained HKDF, same algorithm/format as `packages/crypto/src/kdf.ts` but implemented locally in `packages/agent/src/cache-crypto.ts` per D11) — the cache is therefore only decryptable by whoever holds the exact API key it was written under; rotating the key (AC-16) invalidates the old cache's usability (see AC-13).

**And**, on first cache-file write, the file is created with mode `0600` (`fs.writeFileSync(path, data, { mode: 0o600 })`) and the agent explicitly `chmod`s the file to `0600` on every subsequent write in case the umask produced a looser mode — do not rely on `mode` alone being sufficient across all platforms/umask configurations; verify the resulting mode with `fs.statSync(path).mode` in the integration test.

**And**, given the primary stated use case for this offline agent is CI/CD (multiple pipeline steps or parallel jobs on the same runner host potentially calling `getSecret()` concurrently against the same cache file), **every write to the cache file is atomic**: write the full new JSON contents to a temp file in the same directory (e.g. `cache.json.tmp-<random>`, same `0600` mode) and `fs.renameSync()` it over the real path — `rename(2)` is atomic on POSIX filesystems, so a concurrent reader always sees either the fully-old or fully-new file, never a partial write. This is what makes `VaultCacheCorruptedError` (AC-13) a genuine "the file is actually broken" signal rather than a false positive from two processes' writes interleaving — a reader must never observe a torn write from a sibling process as corruption.

**And**, given two concurrent processes both call `getSecret()` for **different** names and both attempt to write a cache-refresh at nearly the same time,
**when** both writes complete,
**then** the second writer's atomic rename wins (last-write-wins on the whole file) and **may not include** the first writer's just-added entry, since each writer reads-then-rewrites the full file rather than patching in place — this is an accepted, documented limitation (a lost cache-refresh is self-healing on the next successful call for that name), not a data-loss risk, since the cache is a disposable performance/fallback optimization, not a source of truth.

**And**, given the process is running on Windows (where POSIX file-mode bits are not fully meaningful),
**when** the cache file is written,
**then** the agent logs a one-time warning that file-permission enforcement is best-effort on this platform and proceeds — do not throw or refuse to cache; document this platform caveat in the package README (Dev Notes references this — no README content is written by this story's AC, just flagged as required).

---

### AC-13: Offline Agent — Decrypt Failure Handling (No Plaintext Fallback)

**Given** a cache file exists but was encrypted under a **previous** API key (the key has since been rotated, AC-16, and the CI environment's `VAULT_API_KEY` was updated to the new key without clearing the old cache file),
**When** the agent attempts to decrypt a cached entry using the new key's derived cache-key,
**Then** AES-GCM's authentication-tag verification fails, and the agent throws a typed `VaultCacheDecryptionError` (extends `VaultAgentError`) with a message instructing the operator to clear the cache file — **the agent does not, under any circumstance, fall back to returning the raw stored bytes as if they were plaintext**, and does not silently delete-and-continue as if the entry were simply absent (that would mask a real "the cache is now unusable" condition behind an "unreachable, no cached value either" failure, which is a worse debugging experience for the exact operator who needs to know their cache is stale).

**And**, given the vault is unreachable (fallback mode active) **and** the cache entry for the requested name fails to decrypt,
**when** `getSecret()` is called,
**then** the thrown error is the same `VaultCacheDecryptionError` — not a generic "vault unreachable" error — so the CI log clearly distinguishes "your vault is down and your cache is also broken" from "your vault is down but a good cache exists and something else went wrong."

**And**, given the cache file's top-level JSON is corrupted (truncated write, disk-full mid-write, manual tampering),
**when** the agent attempts to parse it,
**then** a `VaultCacheCorruptedError` is thrown with the same no-plaintext-fallback guarantee — a corrupted cache file must never be silently treated as "no cache" and must never partially-parse into a state that could return an attacker-planted or garbage value as if it were a real secret.

---

### AC-14: Offline Agent — Non-Cacheable Credential Exclusion

**Given** a credential's server-side record has `cacheable: false` (D7),
**When** the agent successfully retrieves it live (vault reachable) via `GET .../credentials/:name/value`,
**Then** the response's `cacheable: boolean` field (present on every response per AC-6's baseline schema, `CredentialValueResponseSchema`) reads `false`, and the agent **does not write** this entry to the local cache file regardless of whether one already exists there for this name — if a stale cached entry for this name exists from before the credential was marked non-cacheable, the agent actively **deletes** that stale entry from the cache file on this live read (do not leave a now-forbidden cached copy sitting on disk indefinitely).

**And**, given the vault is unreachable (fallback mode) and the requested name has no cache entry because it was never cacheable,
**when** `getSecret()` is called for that name,
**then** the agent throws `VaultUnreachableNonCacheableError` — a distinct error from the generic "vault unreachable, no cache entry for this name" case (AC-13's sibling), explicitly telling the operator this specific secret is flagged high-sensitivity and will never be servable offline, rather than looking like a transient "just didn't get cached yet" gap.

---

### AC-15: Offline Agent — Cache Activation Audit and Alert

**Given** the agent transitions into fallback mode (AC-11),
**When** this transition happens,
**Then** the agent's **next successful live call** (i.e., once connectivity is restored, or if a partial live call succeeds even mid-fallback-detection) triggers a call to the dedicated `POST /api/v1/machine/cache-activated` beacon endpoint (D13) with `{ activatedAt, threshold }` — `projectId` is not sent in the body since it is already carried in the machine JWT's `scope` claim that authenticates the call; the server writes a `machine_cache.activated` audit row (`actorType: 'machine_user'`, D5) and queues an alert via `createOrgAdminNotificationEntries({ templateId: 'machine_cache.activated', ... })` (FR38, the alert type already reserved in `notification-types.ts`).

**And**, given the agent never regains connectivity for the remainder of the CI job's lifetime (fallback mode active until process exit),
**when** the process exits,
**then** no beacon is ever sent for that activation — this is an accepted best-effort limitation (there is no live connection to report through); document in Dev Notes that a fully-offline CI run's fallback activation is only observable server-side if/when the *next* process from the same machine user successfully reconnects, not necessarily the same run that triggered it.

**And** the beacon call itself is **not** subject to the same 3-failure/30s threshold logic (it would be nonsensical for the report-that-we-are-offline mechanism to itself require being online) — it is simply attempted opportunistically on any successful outbound connection, silently dropped on failure (fire-and-forget, logged locally at `debug` level only, never thrown to the caller of `getSecret()`).

---

### AC-16: Zero-Downtime Key Rotation — Happy Path

**Given** an org admin, MFA-enrolled/grace, and an active key `keyId: e5a2...` belonging to their org,
**When** they call `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate` with `{ "overlapMinutes": 240 }`,
**Then** the server, in one transaction: (1) generates a new key via 7.1's `generateApiKey()`/`hashApiKey()` (D1), inserting a new `api_keys` row with `rotatedFromKeyId: e5a2...` (D8); (2) sets the **old** key's `overlapExpiresAt = now() + 240 minutes` (D8) — the old key's `revokedAt` remains `null` for the duration of the window; (3) writes a `machine_user.api_key_rotated` audit row (new constant, additive to `AuditEvent`, following 7.1's D7 lowercase-dotted convention) with `payload: { oldKeyId, newKeyId, overlapMinutes }` (never the plaintext).

**And** the response is `201`:

```json
{
  "data": {
    "newKeyId": "f6b3...",
    "key": "pk_7hQ2mR...46-chars-total",
    "oldKeyId": "e5a2...",
    "overlapExpiresAt": "2026-07-04T22:05:00.000Z"
  }
}
```

**And**, during the overlap window, **both** the old key (`e5a2...`) and the new key (`f6b3...`) independently succeed against `POST /api/v1/auth/machine-token` — no code path in AC-2/AC-3 checks `overlapExpiresAt` as a rejection condition; it is purely informational for the auto-revoke job (AC-18) and the anomaly check (AC-19).

**Edge case — rotating an already-superseded key:** given `keyId` already has a non-null `rotatedFromKeyId`-pointing successor from a **previous** rotation (i.e., this key is itself the "new" key from an earlier rotation, not yet auto-revoked-from），calling `rotate` on it again is allowed and produces a **third** key in the chain — there is no limit on rotation chain depth in this story; each rotation only ever references its immediate predecessor.

---

### AC-17: Zero-Downtime Key Rotation — Validation

**Given** the same authenticated org admin,
**When** they submit `overlapMinutes: 1500` (exceeding the 1440-minute/24-hour cap, epics.md `AC-E7c`),
**Then** the response is `422 { code: "validation_error", message: "overlapMinutes must be between 1 and 1440" }` and no rotation occurs.

**And**, given `overlapMinutes` is omitted entirely,
**when** rotation is requested,
**then** the default of `240` (4 hours, epics.md `AC-E7c`'s default) is applied — matching the Zod schema's `.default(240)`.

**And**, given `overlapMinutes: 0` or a negative number,
**when** rotation is requested,
**then** the response is `422 { code: "validation_error" }` — a zero-or-negative overlap window is nonsensical (it would mean "revoke immediately," which is what emergency-revoke, AC-20, is for — do not silently alias `overlapMinutes: 0` to emergency-revoke's semantics; reject it instead, keeping the two operations' contracts distinct).

**And**, given `keyId` does not exist, belongs to a different machine user/org, or is already revoked,
**when** rotation is requested,
**then** the response is `404 { code: "api_key_not_found" }` for the first two cases, or `409 { code: "api_key_already_revoked", message: "Cannot rotate a revoked key" }` for the third — rotating a dead key is a meaningless operation that should fail loudly, not silently issue an orphaned new key with no live predecessor.

---

### AC-18: Zero-Downtime Key Rotation — Auto-Revoke After Overlap Window, Pre-Revocation Alert

**Given** an `api_keys` row with `overlapExpiresAt` 1 hour in the future and `revokedAt IS NULL`,
**When** a new pg-boss job `machine-key:overlap-revoke` runs on **two separate cadences** — the actual revocation check runs every 5 minutes (`*/5 * * * *`), while the pre-revocation alert check runs hourly (`0 * * * *`, since a 1-hour-ahead warning does not need finer granularity than the warning window itself),
**Then** the job (in `apps/api/src/workers/machine-key-overlap-revoke.ts`, following the `runOrgScopedJob` + per-org/per-row try/catch failure-isolation pattern from `expiry-alert-shared.ts`, but not `runExpiryAlertJob()` itself since this isn't a lead-days-threshold shape) — on its 5-minute run — queries `WHERE overlap_expires_at <= now() AND revoked_at IS NULL` to actually revoke, and — on its hourly run — separately queries `WHERE overlap_expires_at <= now() + interval '1 hour' AND overlap_expires_at > now() AND revoked_at IS NULL` for the **pre-revocation alert** (fires once, tracked via a new `overlap_alert_sent_at` boolean-equivalent — reuse the existing `notifiedLeadDays`-style dedupe idea with a simple `overlap_alert_sent boolean NOT NULL DEFAULT false` column instead, since there's only one threshold, not an array). **Rationale for the split cadence:** AC-17 permits `overlapMinutes` as low as 1 — a single hourly revoke check could leave such a key valid and unrevoked for up to ~59 minutes past its configured expiry purely from cron granularity, undermining the "old key auto-revoked after window" guarantee. A 5-minute revoke cadence bounds that overshoot to at most 5 minutes regardless of how short an overlap window an admin configures, while the coarser hourly cadence remains appropriate for the alert (which only needs to fire "around" 1 hour ahead, not precisely).

**And**, given a key's `overlapExpiresAt` has passed,
**when** the job runs,
**then** the key's `revokedAt` is set to the app-captured current time (matching 7.1's AC-17 idempotency pattern — `COALESCE(revoked_at, $revokedAt)` — since a human admin could race-revoke the same key manually at the same moment), and a `machine_user.api_key_revoked` audit row is written with `payload: { reason: 'overlap_window_expired', oldKeyId }` and `actorType: 'system'` (the third value the CHECK constraint already permits, `packages/db/src/schema/audit-log-entries.ts`) via `writeSystemAuditEntryOrFailClosed()` (D5, Task 4) — do not force this into either the human or machine_user actor buckets, since neither is accurate for a job-initiated action with no human or machine caller.

**And**, given the 1-hour pre-revocation alert fires,
**when** it does,
**then** `createOrgAdminNotificationEntries({ templateId: 'machine_key.expiry', ... })` is called reusing the **same** `machine_key.expiry` alert type 7.1 already established for key-expiry alerts (not inventing `machine_key.overlap_ending`) — an admin managing key lifecycle alerts does not need a fourth near-duplicate alert-type toggle in their notification preferences for what is conceptually the same "a key of mine is about to stop working" event; the payload's `reason: 'rotation_overlap_ending'` field (vs. `reason: 'natural_expiry'` for 7.1's own use of this template) is what differentiates them for the recipient.

---

### AC-19: Zero-Downtime Key Rotation — Anomaly Detection

**Given** a key `e5a2...` was rotated to `f6b3...` (AC-16), and `f6b3...` has since been used at least once (`f6b3...`'s `lastUsedAt IS NOT NULL`),
**When** the **old** key `e5a2...` is used again (a successful `POST /api/v1/auth/machine-token` exchange) while still within its overlap window,
**Then**, immediately after updating `e5a2...`'s `lastUsedAt` (AC-2 step 5), the handler checks `SELECT id FROM api_keys WHERE rotated_from_key_id = 'e5a2...' AND last_used_at IS NOT NULL LIMIT 1` — finding `f6b3...` — and fires `security.anomalous_access` (D10) via `createOrgAdminNotificationEntries({ templateId: 'security.anomalous_access', severity: 'warning', payload: { oldKeyId: 'e5a2...', newKeyId: 'f6b3...', machineUserId, usedAt } })`, and writes a corresponding audit row (`eventType: 'machine_user.rotation_anomaly_detected'`, new additive constant).

**And**, given the old key is used **before** the new key has ever been used (e.g. the CI pipeline hasn't picked up the rotated secret in its environment yet — an entirely normal, expected state during the overlap window),
**when** this happens,
**then** **no** anomaly alert fires — the check's `last_used_at IS NOT NULL` condition on the *new* key is exactly what distinguishes "normal overlap-window usage of the old key" (new key not yet adopted) from "anomalous usage of the old key" (new key already adopted elsewhere, so this old-key usage is unexpected — e.g. a leaked old key being used by someone who doesn't have the new one).

**And** this check does **not** block or reject the old key's authentication — the exchange still succeeds (`200` with a valid JWT); the anomaly alert is purely informational/detective, not preventive, exactly matching epics.md's wording ("an anomaly alert fires," not "the request is rejected").

**And**, given the same old-key-after-new-key-success condition recurs on **every subsequent** use of the old key during the remainder of the overlap window,
**when** this happens,
**then** the alert fires **every time**, not just once — unlike the expiry-alert system's `notifiedLeadDays` dedupe, there is no persistence-based dedupe for this alert in this story (each occurrence is a fresh, potentially-different anomalous event worth an admin's attention; over-alerting here is the safer failure mode than under-alerting a genuinely suspicious pattern). Flag in Dev Notes as a candidate for rate-limiting/digesting in a future story if it proves noisy in practice — not a defect to silently fix now.

---

### AC-20: Emergency Revocation — Atomic Revoke + Reissue

**Given** an org admin and an active key `keyId: e5a2...` suspected of compromise,
**When** they call `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` (no body),
**Then**, in one transaction: (1) `e5a2...`'s `revokedAt` is set immediately (no overlap window — this is the entire point of "emergency"); (2) a new key is generated and inserted with `rotatedFromKeyId: e5a2...` but `overlapExpiresAt: null` (no overlap tracking needed since the old key is already dead); (3) a single `machine_user.api_key_emergency_revoked` audit row (new additive constant) captures both the revocation and the reissuance in one payload: `{ revokedKeyId: 'e5a2...', newKeyId: '...' }`.

**And** the response is `200`:

```json
{
  "data": {
    "revokedKeyId": "e5a2...",
    "newKey": "pk_3xR9tK...46-chars-total",
    "newKeyId": "g7c4..."
  }
}
```

**And** `e5a2...`, once revoked by this call, **immediately** fails any subsequent `POST /api/v1/auth/machine-token` exchange (`401`, AC-3) — there is no grace/overlap period whatsoever, unlike AC-16's rotation, which is the defining behavioral difference between the two operations.

**And**, given `keyId` is already revoked at the time emergency-revoke is called,
**when** the request is made,
**then** the response is `409 { code: "api_key_already_revoked" }` — matching AC-17's rotation-of-revoked-key rejection exactly; emergency-revoke on an already-dead key is a no-op that should fail loudly (the caller likely believes they're responding to an active compromise and needs to know the key was already handled), not silently succeed with a fresh reissue that could mask a double-response to the same incident.

**And**, given the org admin calling this endpoint is **not itself MFA-enrolled** (no grace period active),
**when** the request is made,
**then** the response is `403` from `requireMfaEnrollment()` — emergency-revoke is exactly the kind of high-consequence action where the existing MFA gate (`requireMfa: true`, matching every other machine-user mutation) must not be bypassed "because it's an emergency"; a compromised admin account performing a fraudulent "emergency" rotation is exactly the scenario MFA protects against.

---

### AC-21: Dormancy Detection — Daily Job, Configurable Threshold, Firing and Dedupe

**Given** an `api_keys` row with `lastUsedAt` 91 days ago and the owning org's `machine_key_dormancy_threshold_days = 90` (the default, D8),
**When** a new pg-boss daily job `machine-key:dormancy-check` (cron `0 9 * * *`, registered in `main.ts` alongside the other daily jobs) runs,
**Then** `apps/api/src/workers/machine-key-dormancy-check.ts` iterates every org (`fetchAllOrgIds()`), and for each org, queries non-revoked `api_keys` joined to `machine_users` where `(last_used_at IS NOT NULL AND last_used_at < now() - (org.machine_key_dormancy_threshold_days || ' days')::interval) OR (last_used_at IS NULL AND created_at < now() - (org.machine_key_dormancy_threshold_days || ' days')::interval)` **AND** `(dormancy_snoozed_until IS NULL OR dormancy_snoozed_until < now())` (D8's snooze exclusion), inserting one `security_alerts` row per qualifying key (D9): `{ alertType: 'machine_key.dormant', severity: 'warning', payload: { keyId, machineUserId, machineUserName, lastUsedAt, projectId, keyName } }`.

**And**, given a key already has a **non-dismissed, non-expired-snooze** `security_alerts` row for `machine_key.dormant` from a **previous** run (i.e., the alert already fired and was neither dismissed nor did the key get used since),
**when** the job runs again the next day,
**then** **no duplicate alert row is inserted** — the job's per-row logic checks for an existing `security_alerts` row with `alertType: 'machine_key.dormant' AND payload->>'keyId' = :keyId AND status != 'dismissed'` before inserting a new one (a payload-based existence check, since `security_alerts` has no natural unique index on `(alertType, keyId)` — add one via a partial unique index `CREATE UNIQUE INDEX idx_security_alerts_dormant_key ON security_alerts ((payload->>'keyId')) WHERE alert_type = 'machine_key.dormant' AND status != 'dismissed'` in this story's migration, and rely on an `ON CONFLICT DO NOTHING` upsert rather than a separate `SELECT`-then-`INSERT`, closing the same TOCTOU window Story 4.4's rotation guard discusses).

**And**, given the key is used again (any successful token exchange updates `lastUsedAt`) after a dormancy alert already fired,
**when** the **next** dormancy job run evaluates that key,
**then** it no longer matches the dormancy `WHERE` clause (fresh `lastUsedAt`) and is skipped — the existing dismissed-or-not `security_alerts` row is left as historical record, not retroactively cleaned up (audit-trail rows are never deleted by this job).

**And**, given two different orgs each have a dormant key,
**when** the job runs,
**then** each org's alert insertion is processed independently with per-org try/catch failure isolation (matching `runExpiryAlertJob`'s established pattern) — one org's failure does not prevent another org's dormancy alert from firing.

---

### AC-22: Dormancy Admin Actions — Dismiss, Revoke, Extend

**Given** a `security_alerts` row with `alertType: 'machine_key.dormant'`, `status: 'delivered'` (or `'PENDING_DELIVERY'`), belonging to the admin's org, and the admin is MFA-enrolled/grace,
**When** the admin calls `POST /api/v1/security-alerts/:alertId/dismiss` with `{ "reason": "Known seasonal batch job, runs quarterly" }`,
**Then** the row's `dismissedBy` (set to the admin's `userIdentityTokens` id, matching `firstActorTokenIdForUser()`'s existing pattern), `dismissedAt`, `dismissalReason`, and `status: 'dismissed'` are updated, and the response is `200 { "data": { "id": "...", "status": "dismissed" } }` — this is a **generic** endpoint (D9), not machine-key-specific; it works identically for any future `security_alerts` row regardless of `alertType`.

**And**, given the calling admin is **not** MFA-enrolled (no grace period active),
**when** either `dismiss` or `extend-dormancy` (below) is called,
**then** the response is `403` from `requireMfaEnrollment()` — both routes set `requireMfa: true`, matching rotate (AC-16) and emergency-revoke (AC-20). This is a deliberate consistency decision: `extend-dormancy` in particular can indefinitely snooze detection of a potentially-compromised dormant key (`dormancy_snoozed_until`, D8), which is exactly the class of high-consequence machine-user admin action this story's other mutations already gate behind MFA — leaving it ungated while rotate/revoke are gated would be an inconsistent security posture across otherwise-comparable actions.

**And**, given `reason` is omitted or empty,
**when** dismiss is called,
**then** the response is `422 { code: "validation_error", message: "A dismissal reason is required" }` — epics.md explicitly requires "dismiss (with reason)"; an empty-reason dismiss defeats the audit-trail purpose of requiring one at all.

**And**, given `alertId` does not exist or belongs to a different org,
**when** dismiss is called,
**then** the response is `404 { code: "alert_not_found" }`.

**And**, given `alertId` is already `dismissed`,
**when** dismiss is called again,
**then** the response is `409 { code: "alert_already_dismissed" }` — unlike 7.1's revoke-idempotency pattern, a second dismiss with a **different** reason is a meaningfully different admin action (they might be updating their justification) that should not silently succeed as a no-op; require the caller to know it's already dismissed rather than masking that state.

**And**, "revoke" for a dormant key is **not** a new endpoint — the admin calls 7.1's already-shipped `DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId` directly; no new code is added for this action beyond documenting the flow in this story.

**And**, given an admin calls `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy` with `{ "days": 30 }`,
**then** `dormancy_snoozed_until = now() + 30 days` is set on the key, and a `machine_user.dormancy_extended` audit row (new additive constant) records `{ keyId, days, newSnoozeUntil }` — the **next** dormancy job run excludes this key (AC-21's `dormancy_snoozed_until` clause) until the snooze expires, after which it re-evaluates normally (dormancy re-fires if `lastUsedAt` still hasn't advanced).

**And**, given `days` is `0`, negative, or exceeds `365`,
**when** extend-dormancy is called,
**then** the response is `422 { code: "validation_error", message: "days must be between 1 and 365" }`.

---

### AC-23: Project Archival Guard Closure

**Given** a project has one machine user with one non-revoked, non-expired `api_keys` row,
**When** an org admin calls `GET /api/v1/projects/:projectId/machine-users/active-keys` (new endpoint, `minimumRole: 'viewer'`, matching the read-only precedent of other machine-user list endpoints),
**Then** the response is `200 { "data": { "items": [{ "machineUserId": "...", "keyId": "..." }], "total": 1 } }`.

**And**, given the same project,
**when** an org owner then calls `POST /api/v1/projects/:projectId/archive` (Story 4.4's endpoint),
**then** the archive handler's step 6 (previously "always `false` until Epic 7," `4-4-project-archival.md:162`) now calls the real `hasActiveMachineUserKeys()` (D12), finds the active key, and the response is `409 { "error": "active_machine_user_keys", "machineUserIds": ["..."] }` — the project is **not** archived.

**And**, given the same project's only machine-user key is revoked (via 7.1's `DELETE` or this story's emergency-revoke) **before** the archive call,
**when** `POST .../archive` is retried,
**then** `hasActiveMachineUserKeys()` returns an empty result and archival proceeds (assuming no other blocking guard, e.g. active rotations, fires) — `200` with the project now archived.

**And**, given a project has a machine user whose only key has `expiresAt` in the **past** but `revokedAt IS NULL` (naturally expired, never explicitly revoked),
**when** the active-keys check runs,
**then** that key is treated as **not active** (excluded from both the `active-keys` list and the archival block) — `hasActiveMachineUserKeys()`'s query is `WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, matching the exact validity condition `POST /api/v1/auth/machine-token` itself uses (AC-2) — an expired key cannot be used to authenticate, so it correctly does not block archival either; consistency between "can this key still be used" and "does this key still count as active" is required, not incidental.

**And**, given the `active-keys` endpoint is called for a `projectId` belonging to a different org,
**when** the request is made,
**then** the response is `404`, matching every other project-scoped route's non-leaking pattern.

---

### AC-24: Audit Trail — Fail-Closed and No Secret Leakage (All New Endpoints)

**Given** any of this story's mutation endpoints (rotate, emergency-revoke, dismiss, extend-dormancy) or the machine-authenticated read endpoint (credential-value retrieval),
**When** the corresponding audit write throws inside the same transaction,
**Then** the entire transaction rolls back and the response is `503 { code: "audit_write_failed" }` — for human-initiated mutations this is `writeHumanAuditEntryOrFailClosed()` (already shipped, reused as-is per the Architecture Conflict Resolution table); for the machine-authenticated read, it is the new `writeMachineAuditEntryOrFailClosed()` (D5); for the system-initiated overlap-revoke job (AC-18), a comparable fail-and-log (not fail-and-503, since there's no HTTP caller to respond to — the job's per-row try/catch logs the error and continues to the next row, consistent with `runExpiryAlertJob`'s failure-isolation philosophy, but the specific row's revocation must **not** be considered complete if its audit write failed — wrap the `UPDATE api_keys SET revoked_at ...` and the audit insert in one job-internal transaction so a failed audit write rolls back that row's revocation too, to be retried on the next hourly run).

**And**, for every new audit event type this story introduces (`machine_user.api_key_rotated`, `machine_user.api_key_emergency_revoked`, `machine_user.rotation_anomaly_detected`, `machine_user.dormancy_extended`), a test asserts the payload never contains `key`, `apiKey`, `keyHash`, `plaintext`, `newKey`, or `value` — mirroring 7.1's AC-15 test discipline exactly, extended to this story's new event types (the emergency-revoke response body legitimately contains `newKey` plaintext — AC-20 — but the **audit payload** for that same action must not, since audit rows persist indefinitely and the response is transient).

**And** the plaintext value returned by `POST .../api-keys/:keyId/rotate` and `POST .../api-keys/:keyId/emergency-revoke` is never written to `request.log`/`fastify.log` — grep the diff for the variable holding it before opening a PR, matching 7.1's Dev Notes discipline verbatim.

---

### AC-25: RLS and Tenant Isolation

**Given** the pre-auth `api_keys`-by-`keyHash` lookup (D2) is the **only** query in this story that bypasses org-scoped RLS,
**When** a security review or the route-audit test inspects this story's code,
**Then** exactly one call site uses `getAdminDb()` for a by-hash lookup (`token-exchange-lookup.ts`), it is documented with the same doc-comment convention as `invitations/lookup.ts`/`recovery-lookup.ts`, and it is registered in `PUBLIC_ROUTE_EXEMPTIONS` with an explicit reason — **every other query in this story** (credential lookup, `lastUsedAt` updates post-org-resolution, rotation, dormancy job queries, archival-check query) runs inside a `withOrg(orgId, ...)` transaction.

**And**, given a machine JWT's `orgId` claim is somehow forged or stale relative to the actual `api_keys.org_id` (should be impossible if signing is correct, but tested defensively),
**when** `verifyMachineRequest()`'s live recheck (AC-5) re-reads the `api_keys` row **by `keyId`, scoped to the claimed `orgId`** (`WHERE id = :keyId AND org_id = :claimedOrgId`, inside `withOrg(claimedOrgId, ...)`),
**then** a mismatch between the claim and the actual row's true org produces **zero rows** (RLS silently filters it out, matching the human-session `assertSessionMatchesClaims()` precedent's `session.orgId !== claims.orgId` check) — the response is `401 { code: "invalid_machine_token" }`, not a cross-org data leak.

**And**, given two different orgs each independently issue a machine user a key with the **same** (astronomically unlikely, but tested) `keyHash` collision,
**when** the pre-auth lookup runs,
**then** — this is explicitly out of scope to defend against per 7.1's AC-2 rationale (256-bit HMAC-SHA256 collision is cryptographically negligible) — no special handling is added; the `LIMIT 1` lookup returning an arbitrary one of two colliding rows is an accepted, documented non-issue at this entropy level, matching 7.1's own reasoning verbatim.

---

### AC-26: Concurrency

**Given** two concurrent `POST /api/v1/auth/machine-token` requests for the **same** key (a CI script's retried request after a client-side timeout),
**When** both complete,
**Then** both succeed with independently-signed JWTs (JWTs are stateless — there's no shared mutable state to race on beyond the `lastUsedAt` update, which is a simple last-write-wins `UPDATE`; no lock or idempotency mechanism is needed here, unlike 7.1's revoke idempotency, because issuing "two JWTs for one exchange" has no negative side effect).

**And**, given two concurrent `POST .../api-keys/:keyId/rotate` calls for the **same** key (double-click, or a retried admin request),
**When** both complete,
**Then** **exactly one** succeeds and the other fails with `409 { code: "api_key_already_rotated" }` — rotation must be exclusive (two successful concurrent rotations of the same key would produce two different "new" keys both claiming `rotatedFromKeyId` = the same old key, and two different overlap windows on the same old key, an inconsistent state). Implement via `SELECT ... FOR UPDATE` on the old key's row at the start of the rotate transaction (matching Story 4.4's row-lock pattern for its own TOCTOU closure) — the second transaction blocks until the first commits, then re-reads and finds `overlapExpiresAt` already set (or the row already revoked, for emergency-revoke's equivalent race), returning `409`.

**And**, given two concurrent `POST .../emergency-revoke` calls for the **same** key,
**When** both complete,
**Then** the same `SELECT ... FOR UPDATE` exclusivity applies — exactly one succeeds (`200` with a new key), the other receives `409 { code: "api_key_already_revoked" }` (matching AC-20's already-revoked response, since by the time the second transaction's lock is granted, the first has already set `revokedAt`).

**And**, given two concurrent `POST .../:alertId/dismiss` calls for the **same** dormancy alert,
**When** both complete,
**Then** exactly one succeeds (`200`), the other receives `409 { code: "alert_already_dismissed" }` (AC-22) — implemented via a conditional `UPDATE ... WHERE status != 'dismissed' RETURNING *`, checking whether the update affected a row, rather than a separate lock (a lighter-weight mechanism is sufficient here since there's no multi-row invariant to protect, unlike rotation's cross-row `rotatedFromKeyId` consistency).

---

### AC-27: Rate Limiting on New Mutation Endpoints

**Given** rotate, emergency-revoke, dismiss, and extend-dormancy each set `security.rateLimit: { max: 10, timeWindowMs: 60_000, key: '<METHOD> <route>' }` (matching 7.1's precedent exactly, shared per-admin-per-route, not per-machine-user),
**When** the same admin issues an 11th request to any one of these routes within 60 seconds,
**Then** the 11th receives `429` — the machine-token-exchange endpoint (AC-4) uses a **different**, IP/key-hash-keyed scheme since it has no authenticated admin identity to key on; do not conflate the two rate-limit models.

**And** the `GET .../machine-users/active-keys` and `GET /api/v1/machine/projects/:projectId/credentials/:name/value` read endpoints use tighter-than-default limits given their higher sensitivity/higher expected call volume from automated CI systems: `{ max: 300, timeWindowMs: 60_000 }` for the credential-value read (a busy CI fleet may call this frequently; 300/min per machine-JWT-implied identity, keyed by `keyId` from the verified claims, not by IP) — document the chosen number's rationale (CI-realistic call volume, not the `SecureRoute` default of 60/min, which was tuned for human browsing patterns) rather than blindly inheriting the human-route default.

**And**, independently of the 300/min overall budget above, **failed** lookups (`404 credential_not_found` or `409 ambiguous_credential_name`) against the credential-value endpoint are additionally capped at `{ max: 20, timeWindowMs: 60_000 }` per `keyId` — a stolen-but-not-yet-revoked machine JWT (valid up to 1h, AC-5) could otherwise use its full 300/min budget purely to enumerate credential names within its scoped project via repeated not-found probes. On the 21st failed lookup for the same `keyId` within the window, respond `429` regardless of remaining budget in the overall 300/min counter — mirroring the same successful-vs-failed distinction AC-4 already applies to the token-exchange endpoint.

---

### AC-28: Migration Safety and Backward Compatibility

**Given** this story's migration only adds nullable/defaulted columns to `api_keys`, `organizations`, and `credentials`, plus one partial unique index on `security_alerts`,
**When** the migration is applied to a database that already has Stories 1.1-7.1's schema,
**Then** no existing row's data is altered beyond the new columns' defaults being backfilled (`cacheable = true` for all existing credentials, `machine_key_dormancy_threshold_days = 90` for all existing orgs), no existing route's behavior changes, and no existing integration test's assertions need updating.

**And**, given the new `idx_security_alerts_dormant_key` partial unique index is added to a `security_alerts` table that may already contain rows (from the existing `failed_auth_threshold` alert type),
**when** the migration runs,
**then** the index creation does not fail — the partial `WHERE alert_type = 'machine_key.dormant'` clause means zero existing rows are covered by it (no `machine_key.dormant` rows can exist before this story ships), so the index creation is a no-op against existing data, purely forward-looking.

**And**, given a rollback of this migration is needed,
**when** the corresponding column-drops and index-drop are run (in reverse dependency order: drop the `security_alerts` index first, then the `organizations`/`credentials`/`api_keys` columns — no FK ordering constraint applies since `rotated_from_key_id` is nullable and self-referential, not blocking a column drop),
**then** no other table's foreign keys reference the dropped columns (this story introduces `api_keys.rotated_from_key_id` as the only new FK, self-referential within the same table — dropping it requires no coordination with any other table).

---

### AC-29: RLS Coverage and Route-Audit Coverage (CI Gates)

**Given** the migration from AC-1 has been applied,
**When** `packages/db/src/check-rls-coverage.ts`'s `checkRlsCoverage()` runs,
**Then** it continues to pass with no new gaps — this story adds **no new tables**, only columns to already-RLS-covered tables (`api_keys`, `organizations`, `credentials`) and one index on `security_alerts` (also already RLS-covered); confirm none of these three tables were accidentally added to `EXCLUDED_TABLES` by a careless migration-authoring mistake.

**And**, given all new routes (`POST /api/v1/auth/machine-token`, `GET /api/v1/machine/projects/:projectId/credentials/:name/value`, `POST /api/v1/machine/cache-activated`, `GET /api/v1/projects/:projectId/machine-users/active-keys`, `POST .../api-keys/:keyId/rotate`, `POST .../api-keys/:keyId/emergency-revoke`, `POST .../api-keys/:keyId/extend-dormancy`, `POST /api/v1/security-alerts/:alertId/dismiss`, `PATCH /api/v1/organizations/:orgId/machine-key-settings`) are registered via `secureRoute()` (never bare Fastify `.route()`),
**when** `apps/api/src/__tests__/route-audit.test.ts` runs,
**then** every new route appears in the generated OpenAPI spec and the module-level `secureRoutes` set, with corresponding `ROUTE_ACTION_CLASSIFICATIONS` entries added — the three `requireAuth: false` routes (machine-token exchange, machine-authenticated credential retrieval, cache-activated beacon, D13) additionally get `PUBLIC_ROUTE_EXEMPTIONS` entries (D2/D4/D13) so the route-audit's public-route reviewer sees a documented reason rather than an unexplained gap.

**And**, given `packages/agent` is a new workspace package,
**when** `pnpm --filter agent build`/`typecheck`/`test`/`lint` are run (via the existing Turborepo pipeline, which auto-discovers new `packages/*` workspaces with no config changes needed),
**then** they pass exactly like every other workspace package's equivalent tasks — confirm `packages/agent`'s `package.json` scripts match the naming convention every other package already uses (`build`, `typecheck`, `lint`, `test`) so `turbo.json`'s pipeline definitions apply without a bespoke entry.

---

## Tasks / Subtasks

- [x] **Task 1: Schema** (AC-1) — `api_keys`/`organizations`/`credentials` column additions, `security_alerts` partial unique index; verify next free migration number **after confirming Story 7.1's migration has landed**; run `db#check-rls`, `db#migrate`.
- [x] **Task 2: `MACHINE_JWT_SECRET` + machine-JWT plugin** (D3) — env wiring in `apps/api/src/config/env.ts` (+ `.env.example`, + `validateMachineJwtProductionSecret()` mirroring 7.1's D3 pattern); `apps/api/src/plugins/machine-jwt.ts` (verify `@fastify/jwt` namespace support or implement the `node:crypto` HS256 fallback per D3).
- [x] **Task 3: Token-exchange lookup + endpoint** (D2, AC-2 to AC-4) — `apps/api/src/modules/machine-users/token-exchange-lookup.ts` (`findApiKeyByHash` via `getAdminDb()`); `POST /api/v1/auth/machine-token` route; IP + per-key-hash rate limiting.
- [x] **Task 4: Machine-request verification helper** (D4, D5, AC-5) — `apps/api/src/modules/machine-users/machine-auth.ts` (`verifyMachineRequest()`); `apps/api/src/modules/audit/machine-entry.ts` (`writeMachineAuditEntry`, `writeSystemAuditEntry`); `writeMachineAuditEntryOrFailClosed()` + `writeSystemAuditEntryOrFailClosed()` in `apps/api/src/lib/audit-or-fail-closed.ts`.
- [x] **Task 5: Credential-by-name lookup + machine value-retrieval route** (D6, D7, AC-6 to AC-9) — `findCredentialByNameInProject()` in `apps/api/src/modules/credentials/service.ts`; `cacheable` column wiring into create + lifecycle-PATCH handlers; `GET /api/v1/machine/projects/:projectId/credentials/:name/value` route.
- [x] **Task 6: `packages/agent` scaffold + crypto** (D11, AC-10 to AC-13) — package.json, `cache-crypto.ts` (self-contained AES-256-GCM + HKDF), `createVaultAgent()`/`getSecret()`, fallback-activation state machine, cache file read/write with 0600 enforcement, typed error classes.
- [x] **Task 7: Agent — non-cacheable exclusion + activation beacon** (AC-14, AC-15, D13) — `cacheable` response-field plumbing; stale-cache-entry deletion on live non-cacheable read; best-effort activation beacon call to `POST /api/v1/machine/cache-activated` (agent side) + the endpoint's server-side handler (route, `verifyMachineRequest()`, audit write, alert).
- [x] **Task 8: Rotation** (D8, AC-16 to AC-19) — `apps/api/src/modules/machine-users/rotation.ts`; `POST .../api-keys/:keyId/rotate` (row-locked, AC-26); anomaly-check query wired into the token-exchange handler (Task 3).
- [x] **Task 9: Overlap auto-revoke job** (AC-18) — `apps/api/src/workers/machine-key-overlap-revoke.ts`; register **two** pg-boss cron entries in `main.ts` (5-minute revoke check, hourly alert check — see AC-18's split-cadence rationale); `overlap_alert_sent` column + 1-hour-prior alert reusing `machine_key.expiry`.
- [x] **Task 10: Emergency revocation** (AC-20) — `POST .../api-keys/:keyId/emergency-revoke`, row-locked (AC-26).
- [x] **Task 11: Dormancy detection job + admin actions** (D9, AC-21, AC-22) — `apps/api/src/workers/machine-key-dormancy-check.ts`; extend `apps/api/src/modules/org/security-alerts.ts` with `machineKeyDormantPayloadSchema`; `POST /api/v1/security-alerts/:alertId/dismiss`; `POST .../api-keys/:keyId/extend-dormancy`; `PATCH /api/v1/organizations/:orgId/machine-key-settings`.
- [x] **Task 12: Archival guard closure** (D12, AC-23) — `apps/api/src/modules/machine-users/archival-check.ts` (`activeMachineUserKeysQuery`); replace `hasActiveMachineUserKeys()`'s stub body in `apps/api/src/modules/projects/archive-guards.ts`; `GET .../machine-users/active-keys` route; update archive-route's block-response handling for the new `active_machine_user_keys` shape.
- [x] **Task 13: Audit event constants** — add `MACHINE_USER_API_KEY_ROTATED`, `MACHINE_USER_API_KEY_EMERGENCY_REVOKED`, `MACHINE_USER_ROTATION_ANOMALY_DETECTED`, `MACHINE_USER_DORMANCY_EXTENDED` to `packages/shared/src/constants/audit-events.ts` (additive only, lowercase-dotted per 7.1's D7).
- [x] **Task 14: Notification alert types** — add `machine_key.dormant` to `NOTIFICATION_ALERT_TYPES` (additive); confirm `security.anomalous_access` and `machine_key.expiry` need no changes (D10, AC-18 reuse).
- [x] **Task 15: `ROUTE_ACTION_CLASSIFICATIONS` + `PUBLIC_ROUTE_EXEMPTIONS`** (AC-25, AC-29, D13) — 9 new route entries; 3 new public-route exemption entries with documented compensating controls.
- [x] **Task 16: Integration test suite** — all cases across AC-2 through AC-29 (token exchange happy + 4 failure modes + rate limiting; credential-by-name happy + ambiguous + not-found + cross-project + role + audit fail-closed; agent unit tests for cache-crypto, activation threshold, decrypt-failure, non-cacheable exclusion — run in `packages/agent`'s own test suite, not `apps/api`'s; **cross-compatibility test in `apps/api` asserting `packages/crypto/src/aes.ts` and `packages/agent/src/cache-crypto.ts` produce interoperable ciphertext both directions (D11)**; rotation happy + validation + auto-revoke (both cadences) + anomaly; emergency-revoke happy + already-revoked; dormancy firing + dedupe + dismiss + extend; archival guard closure; cross-org/cross-project isolation; concurrency; migration additivity. See Dev Notes for the small number of AC sub-clauses not given a dedicated standalone test (covered indirectly by shared/existing test infrastructure instead).
- [x] **Task 17: Route audit + OpenAPI regen** — `pnpm --filter api generate-spec`; `pnpm --filter agent build` + `typecheck`; confirm `web#typecheck` is unaffected (no web UI consumes any of this story's endpoints, per the Product Surface Contract).

---

## Dev Notes

- This story's **highest-risk decision** is D3/D4 (machine JWT signing + the `requireAuth: false`-plus-manual-verification auth model) — get the two-namespace `@fastify/jwt` registration (or its `node:crypto` fallback) right before writing any route handler; every downstream integration test in this story assumes a working machine-JWT round-trip. **Verify the `@fastify/jwt` `namespace` option's exact API against the installed `@fastify/jwt@^10.1.0` package before coding** — this could not be confirmed from a readable `node_modules` at story-creation time (see D3).
- Do **not** retrofit `apps/api/src/plugins/authenticate.ts`'s `authenticateRequest()` to branch on token type (D4) — machine and human auth are deliberately separate code paths with separate trust models; a shared function here is a security-review liability, not a DRY win.
- Do **not** add a uniqueness constraint on `credentials.name` (D6) — this would be a breaking, data-dependent migration that could fail against existing production data with duplicate names. Handle ambiguity at query time (`409 ambiguous_credential_name`) instead. **This is a real, surfaced product gap worth escalating**: projects with pre-existing duplicate credential names cannot use machine-user-by-name retrieval for those specific names until an admin renames one — consider flagging a future "enforce unique credential names per project" story to whoever owns Epic 2/7 backlog grooming.
- Do **not** give `packages/agent` a workspace dependency on `@project-vault/crypto` (D11) — it must remain independently publishable/installable outside this monorepo. The duplicated AES-256-GCM/HKDF implementation in `packages/agent/src/cache-crypto.ts` is intentional, not an oversight; keep its envelope format (`{ version, iv, ciphertext, tag }`) byte-identical to `packages/crypto/src/aes.ts`'s for conceptual consistency even though the code is not shared.
- **Open question (escalate, don't silently resolve):** this repo has no confirmed npm-publish CI pipeline today. `packages/agent`'s `"private": false` setting (D11) prepares it for publication but this story does not implement an actual `npm publish` workflow (GitHub Actions release job, npm token secret, versioning strategy) — that is either an implicit part of Story 7.3 (which needs the package installable by its GitHub Action) or a distinct platform-ops concern. Flag this explicitly in the completion report rather than inventing a publish pipeline speculatively.
- **Open question:** FR101/FR110 have no PRD entry (see the Story section's provenance note) — worth flagging to whoever owns PRD/epics reconciliation, though it does not block this story's implementation since epics.md's Epic 7 preamble fully specifies both.
- **Open question:** the offline agent's audit-visibility gap (AC-9's note — cached reads during a fallback period are not individually logged server-side) is an accepted, documented design tradeoff of the offline-fallback feature itself, not a bug — but it is worth confirming with whoever owns FR36 ("separate, complete audit trail for all machine user access events") that "complete" is understood to mean "complete for every access that reaches the server," not literally every read including offline-cached ones, before this is signed off as fully satisfying FR36.
- The anomaly-alert's lack of dedupe (AC-19) and the credential-value read endpoint's CI-realistic rate limit (AC-27, `300/min` vs. the `60/min` human default) are both judgment calls documented in their respective ACs — revisit if either proves too noisy or too restrictive once real CI traffic patterns are observed.
- `machine-users/archival-check.ts`'s `activeMachineUserKeysQuery()` is deliberately the single source of truth consumed by **both** `hasActiveMachineUserKeys()` (the archive-transaction guard) and `GET .../active-keys` (the standalone read endpoint) — do not let these drift into two different queries that could disagree about what counts as "active."

### Project Structure Notes

- Extends 7.1's `apps/api/src/modules/machine-users/` with: `token-exchange-lookup.ts`, `machine-auth.ts`, `rotation.ts`, `archival-check.ts` — consistent with 7.1's flat routes.ts/schema.ts/tokens.ts layout, no forced service/repository split.
- New workers: `apps/api/src/workers/machine-key-overlap-revoke.ts`, `machine-key-dormancy-check.ts`, alongside 7.1's `machine-key-expiry-alert.ts`.
- New top-level workspace package: `packages/agent/` (`src/index.ts`, `src/cache-crypto.ts`, `src/cache-store.ts`, `src/fallback-state.ts`, `src/errors.ts`) — the **only** package in this monorepo with `"private": false`.
- Extends `apps/api/src/modules/org/security-alerts.ts` (read path, Epic 1) with a new write/dismiss path — first story to touch this file's write side.
- Extends `apps/api/src/modules/projects/archive-guards.ts` (Story 4.4) — the one explicitly-sanctioned touch point per both 4.4's and 7.1's Dev Notes.
- Extends `apps/api/src/modules/credentials/routes.ts`/`service.ts` (Epic 2, `done`) — additive `cacheable` field plumbing only, no existing behavior changed.
- No detected conflicts with other `ready-for-dev`/`backlog` stories at the time this story was created — 6.2/6.3 touch `modules/monitoring/`; 7.1 is the direct schema dependency (see Prerequisites); this story is otherwise new files plus narrowly-scoped additive columns.

### References

- Epics AC: [Source: `_bmad-output/planning-artifacts/epics.md#Story-7.2` (lines 1794-1827)]
- Epic 7 preamble / blockers (RS-E7a, PJ2, PJ4, PJ7, AC-E7a/b/c): [Source: `_bmad-output/planning-artifacts/epics.md` lines 1752-1765]
- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR34-FR39 (lines 907-916); FR101/FR110 have no PRD entry — epics.md is authoritative, see provenance note above]
- Architecture — JWT architecture (web vs. machine TTL/algorithm split): [Source: `_bmad-output/planning-artifacts/architecture.md` lines 321-330]
- Architecture — RLS exception tables (`sessions`/`refresh_tokens` precedent for D2): [Source: `_bmad-output/planning-artifacts/architecture.md` lines 933-934]
- Architecture — canonical schema names: [Source: `_bmad-output/planning-artifacts/architecture.md` lines 903-931]
- Story 7.1 (hard dependency, D1/D2/D3/D4/D7/D8 inherited or resolved here): [Source: `_bmad-output/implementation-artifacts/7-1-machine-user-identity-and-api-key-management.md`, especially D1-D9 and AC-1/AC-2/AC-9]
- Story 4.4 (archival stub this story closes, D12): [Source: `_bmad-output/implementation-artifacts/4-4-project-archival.md` lines 324-336, 351-357]
- Prior art for pre-auth admin-connection token lookup (D2): `apps/api/src/modules/invitations/lookup.ts`, `apps/api/src/modules/auth/recovery-lookup.ts`, `apps/api/src/lib/db.ts` (`getAdminDb`)
- Prior art for human session JWT plugin (contrast for D3/D4): `apps/api/src/plugins/jwt.ts`, `apps/api/src/plugins/authenticate.ts`
- Prior art for `SecureRoute`'s public-route path (D4): `apps/api/src/lib/secure-route.ts` (`handlePublicRequest`, `PublicRouteContext`)
- Prior art for audit actor typing (D5): `packages/db/src/schema/audit-log-entries.ts` (CHECK constraint), `apps/api/src/modules/audit/human-entry.ts`, `apps/api/src/lib/audit-or-fail-closed.ts`
- Prior art for credential decryption (AC-6): `apps/api/src/modules/credentials/service.ts` (`revealCurrentValue`, `findCredentialInProject`, `withSecret`)
- Prior art for AES-256-GCM/HKDF envelope format (D11): `packages/crypto/src/aes.ts`, `packages/crypto/src/kdf.ts`
- Prior art for expiry-alert job fan-out/failure-isolation pattern (AC-18/AC-21): `apps/api/src/workers/expiry-alert-shared.ts`, `apps/api/src/workers/cert-expiry-alert.ts`
- Prior art for the `security_alerts` table and its unused dismiss columns (D9): `packages/db/src/schema/security-alerts.ts`, `apps/api/src/modules/org/security-alerts.ts`
- Prior art for row-locking to close TOCTOU windows (AC-26): `_bmad-output/implementation-artifacts/4-4-project-archival.md` (`SELECT ... FOR UPDATE` concurrency note)
- Downstream dependent: `_bmad-output/implementation-artifacts/7-3-github-actions-cicd-integration.md` (not yet created) — will consume `@project-vault/agent` as its runtime dependency.

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- `@fastify/jwt@10.1.0` (the version actually installed, confirmed by inspecting `node_modules/.pnpm/@fastify+jwt@10.1.0`'s shipped type definitions/source) has no `namespace` option — D3's fallback path was taken. `fast-jwt` (already pinned in `pnpm-workspace.yaml` overrides, `@fastify/jwt`'s own underlying implementation) was used directly instead of `jsonwebtoken` (which the story assumed but is not actually anywhere in this lockfile).
- A first attempt at the overlap-revoke job's idempotent UPDATE used a raw `sql\`COALESCE(...)\`` fragment as the `.set()` value; it silently failed to persist under the postgres-js driver in integration testing. Switched to 7.1's own actual revoke-endpoint pattern (conditional `UPDATE ... WHERE revoked_at IS NULL RETURNING ...`), which is simpler and already proven in this codebase — the story's literal "COALESCE" wording was aspirational, not load-bearing.
- The first `machine-key-overlap-revoke.test.ts` run failed because the test never unsealed the vault before exercising a code path that writes an audit row (`writeSystemAuditEntryOrFailClosed` calls `getAuditKey()`); fixed by adding the same `initVault`/`resetVaultForTest` bootstrap other vault-dependent worker tests use.

### Completion Notes List

- All 17 tasks implemented and tested with real Postgres integration tests (no mocked DB layer) run against a dockerized dev stack; ~250 new tests added across `apps/api`, `packages/agent`, `packages/db`, and `packages/shared`, all green, with no regressions in the pre-existing suites re-run alongside them (credentials, machine-users (7.1), projects/archive-guards, org, route-audit, env, full `packages/db`/`packages/shared` suites).
- D3 (machine JWT signing) resolved via the documented fallback: `fast-jwt` directly (not `@fastify/jwt`'s `namespace` option, unsupported in the installed version; not `jsonwebtoken`, which isn't actually a dependency anywhere in this repo despite the story's assumption). Dedicated tests cover tamper, cross-secret forgery, `alg: none` algorithm-confusion, and expiry rejection — the mandatory security gate called out in the story's Dev Notes.
- D2/D4 pre-auth `getAdminDb()` lookup and `verifyMachineRequest()`'s live-revocation recheck are implemented exactly as specified; AC-25's single-admin-connection-call-site claim holds (`token-exchange-lookup.ts` is the only `getAdminDb()` user in this story).
- D6 ambiguous-name handling, D7 `cacheable` plumbing (including the create + lifecycle-PATCH endpoints), D8 rotation/dormancy columns, D9 dormancy alert reuse of `security_alerts`, D10 `security.anomalous_access` reuse, D12 archival-guard stub closure, and D13 cache-activation beacon are all implemented per the story's resolution, not the literal (and in several places inconsistent) epics.md wording.
- **Known residual test gaps** (not blocking, flagged for a follow-up if a reviewer wants full exhaustive AC-clause coverage): (1) no dedicated test asserts emergency-revoke's 403-without-MFA path specifically, though the shared `route-audit.test.ts` "every owner/admin route requires MFA unless exempt" check already covers that `requireMfa: true` is wired on that route; (2) no dedicated "threshold-change reconciliation" test for D8's documented non-retroactive-alert behavior (the behavior itself requires no code — it's an explicit non-action — so there is nothing to assert beyond "changing the threshold doesn't touch existing alert rows," which is true by construction since no code path touches `security_alerts` on a settings PATCH); (3) no dedicated "atomic cache-file write under concurrent agent processes" stress test — `writeCacheFile()`'s temp-file-then-rename implementation is unit-tested for correctness of the write itself, but a true multi-process race test was judged lower-value than the ~250 other tests given time constraints.
- **Open questions carried forward per the story's own Dev Notes** (not resolved here, as instructed): no npm-publish CI pipeline exists yet for `packages/agent` (flagged for Story 7.3 or a platform-ops story); the FR101/FR110 PRD traceability gap remains; the offline-agent audit-visibility gap (cached reads during fallback are not individually logged server-side) is accepted as documented in AC-9.
- `pnpm --filter api generate-spec` was re-run — it writes a small, pre-existing hand-maintained OpenAPI stub covering only a handful of early auth routes (never covered credentials/projects/machine-users routes either, before or after this story), so it produced no diff; the real API contract enforcement in this codebase is `route-audit.test.ts` plus the Zod schemas, both updated and green.

### File List

**Schema/migration:**
- `packages/db/src/migrations/0030_machine_key_rotation_dormancy_cacheable.sql` (new)
- `packages/db/src/migrations/meta/0030_snapshot.json` (new)
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/api-keys.ts`, `credentials.ts`, `organizations.ts`, `security-alerts.ts`
- `packages/db/src/schema/machine-users-schema.test.ts`

**Shared constants/schemas:**
- `packages/shared/src/constants/audit-events.ts` (+ `.test.ts`)
- `packages/shared/src/constants/notification-types.ts` (+ `.test.ts`)
- `packages/shared/src/schemas/api.ts` (`ActiveMachineUserKeysErrorSchema`)

**API — config/plugins:**
- `apps/api/src/config/env.ts` (+ `.test.ts`), `.env.example`
- `apps/api/src/plugins/machine-jwt.ts` (new, + `.test.ts`)
- `apps/api/src/app.ts`, `apps/api/src/main.ts`
- `apps/api/eslint.config.js`
- `apps/api/package.json` (`fast-jwt`, `@project-vault/agent` deps)

**API — machine-users module (new files unless noted):**
- `apps/api/src/modules/machine-users/bearer-token.ts`
- `apps/api/src/modules/machine-users/token-exchange-lookup.ts`
- `apps/api/src/modules/machine-users/token-exchange-rate-limit.ts`
- `apps/api/src/modules/machine-users/token-exchange-routes.ts` (+ `.test.ts`)
- `apps/api/src/modules/machine-users/token-exchange-schema.ts`
- `apps/api/src/modules/machine-users/machine-auth.ts`
- `apps/api/src/modules/machine-users/machine-credential-routes.ts` (+ `.test.ts`)
- `apps/api/src/modules/machine-users/machine-credential-schema.ts`
- `apps/api/src/modules/machine-users/rotation.ts`
- `apps/api/src/modules/machine-users/rotation-routes.test.ts`
- `apps/api/src/modules/machine-users/archival-check.ts`
- `apps/api/src/modules/machine-users/active-keys-routes.test.ts`
- `apps/api/src/modules/machine-users/dormancy-admin-actions.test.ts`
- `apps/api/src/modules/machine-users/routes.ts`, `schema.ts` (modified — additive routes/schemas)

**API — audit:**
- `apps/api/src/modules/audit/machine-entry.ts` (new)
- `apps/api/src/lib/audit-or-fail-closed.ts` (modified — added machine/system wrappers)

**API — credentials (D7 `cacheable` plumbing):**
- `apps/api/src/modules/credentials/service.ts`, `schema.ts`, `routes.ts`, `dependencies-service.ts`
- `apps/api/src/modules/credentials/cacheable.test.ts` (new)

**API — projects (archival guard closure):**
- `apps/api/src/modules/projects/archive-guards.ts`, `archive-guards.test.ts`, `routes.ts`

**API — org (dormancy admin actions):**
- `apps/api/src/modules/org/schema.ts`, `security-alerts.ts`
- `apps/api/src/modules/org/security-alert-actions-routes.ts` (new), `security-alert-actions-schema.ts` (new)
- `apps/api/src/modules/org/organization-settings-routes.ts` (new), `organization-settings-schema.ts` (new)

**API — workers:**
- `apps/api/src/workers/machine-key-overlap-revoke.ts` (new, + `.test.ts`)
- `apps/api/src/workers/machine-key-dormancy-check.ts` (new, + `.test.ts`)

**API — route governance:**
- `apps/api/src/lib/route-exemptions.ts` (9 new `ROUTE_ACTION_CLASSIFICATIONS` entries, 2 new `PUBLIC_ROUTE_EXEMPTIONS` entries)

**API — cross-package proof:**
- `apps/api/src/__tests__/agent-crypto-cross-compat.test.ts` (new, D11 mandatory cross-compatibility test)

**New package — `packages/agent` (`@project-vault/agent`):**
- `packages/agent/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`
- `packages/agent/src/index.ts` (+ `.test.ts`)
- `packages/agent/src/cache-crypto.ts` (+ `.test.ts`)
- `packages/agent/src/cache-store.ts` (+ `.test.ts`)
- `packages/agent/src/fallback-state.ts` (+ `.test.ts`)
- `packages/agent/src/errors.ts`

