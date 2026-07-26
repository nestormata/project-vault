# Story 14.3: Authenticate via a Registered External Provider Strategy

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an enterprise user whose organization uses SSO,
I want to log in to Project Vault through my organization's identity provider,
so that I don't need a separate password and my company's existing SSO/MFA policy applies.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | yes — `POST /api/v1/auth/sso/start/:providerName`, `POST /api/v1/auth/sso/callback/:providerName`, and `POST /api/v1/admin/external-identities` are real, callable endpoints once an extension registers an auth strategy |
| **Linked UI story** | `TBD` — **blocking note:** no story in the current sprint backlog builds an SSO login button/email-first routing UI. Story 14.4 (`14-4-route-login-to-sso-by-email-domain`, currently `backlog`) is the *next* story and owns the email-first routing screen that would actually surface this endpoint to a real end user; it is not yet implemented. Until 14.4 ships, an enterprise user cannot discover the SSO path from the login screen at all — this story only makes the backend flow *callable*, e.g. by a hand-built extension's own frontend or via direct API calls. Flag for Epic 14's G2 gate: do not let epic-14 move to `done` until 14.4 (or an equivalent UI story) closes this gap. |
| **Honest placeholder AC** | AC-11 below — a caller hitting the callback route with no strategy registered for `:providerName` gets a clear, generic `404`/`400`-class error, never a silent 200 or a crash; this is the honest "SSO not configured" state a future login screen would need to handle before routing here. |
| **Persona journey** | See below |

### Persona journey stub

**Alex-viewer (enterprise employee, org uses SSO via the founder's private extension), API-only journey — no UI in this story:**
1. Alex's org has an extension loaded (Story 14.2) whose manifest declares an `authStrategy` hook; at boot, this story's wiring appends it to `authStrategies` behind the always-present local strategy.
2. Alex's client (today: a hand-built test harness or the extension's own bundled frontend, since 14.4's login-screen routing UI doesn't exist yet) calls `POST /api/v1/auth/sso/start/:providerName`, receives a `state` value plus a short-TTL, single-use, `httpOnly` cookie, and uses `state` to build the redirect to the IdP (URL construction itself is the extension's/client's responsibility — see Dev Notes judgment call on the missing `getAuthorizationUrl`-style hook).
3. Alex authenticates with the IdP, which redirects back with the callback payload; the client `POST`s it to `/api/v1/auth/sso/callback/:providerName`.
4. If Alex has a linked `external_identities` row (created previously by an OrgAdmin via `POST /api/v1/admin/external-identities`, or auto-linked via a matching pending project invitation — see AC-8), Alex is logged in exactly like local login: same session cookies, same MFA-enrollment gate on subsequent OrgAdmin/Owner-only routes if applicable.
5. If Alex has never been linked, Alex sees a generic "link your account" rejection (never an auto-created account) and must ask their OrgAdmin to call the linking endpoint, or accept a pending project invitation under the same email first.
6. Expected UI outcome: **none yet** — this is the honest state until Story 14.4 (or a dedicated admin-UI story) ships the actual login-screen and account-linking screens. This story does not hide that gap.

## Acceptance Criteria

1. **Local strategy always occupies index 0, unconditionally.**
   **Given** the API boots,
   **when** `apps/api/src/modules/auth/strategies.ts` is loaded (module load time, before any extension bootstrap runs in `createApp()`),
   **then** `authStrategies[0]` is a stable, always-present local-strategy marker (`providerName: 'local'`) that no extension can override, remove, or reorder — even if an extension's `hooksFactory` runs before this module's own initialization in some future refactor, a unit test asserts `authStrategies[0].providerName === 'local'` remains true after any sequence of `registerAuthStrategy()` calls.
   **Edge case:** calling `registerAuthStrategy('local', anything)` (an extension attempting to claim the reserved `'local'` provider name) throws synchronously and does not mutate `authStrategies` — dedicated test.

2. **Extension auth strategy registers, append-only.**
   **Given** `loadExtension()` (Story 14.2) resolves with `status: 'loaded'` and `hooks.authStrategy` is present in the returned `ExtensionHooks`,
   **when** `apps/api/src/app.ts`'s `createApp()` calls the new wiring step after `loadExtension()` settles,
   **then** `registerAuthStrategy(manifest.name, hooks.authStrategy)` is called, appending `{ providerName: manifest.name, strategy: hooks.authStrategy }` to `authStrategies` at index 1 (never index 0), and this append happens exactly once per boot — a second call (e.g. accidental double-invocation) throws or no-ops rather than producing a duplicate entry (dedicated test; follow the idempotency-guard precedent from Story 14.2's loader).
   **Edge case — no `authStrategy` hook declared:** if `hooks.authStrategy` is `undefined` (extension only implements `notificationChannel`/`uiPanel`), `authStrategies` stays local-only (length 1) — no error, no-op — dedicated test.
   **Edge case — extension load failed or not configured:** `authStrategies` stays local-only (length 1) — dedicated test reusing Story 14.2's `load_failed`/`not_configured` fixtures.

3. **`POST /api/v1/auth/sso/start/:providerName` mints and stores server-side state.**
   **Given** a caller requests SSO initiation for a `providerName` that matches a registered non-local strategy,
   **when** the route handler runs,
   **then** it generates a cryptographically random `state` value (`crypto.randomBytes`, ≥256 bits, matching this codebase's existing token-generation helpers — see `tokens.ts`/`recovery-tokens.ts` patterns, do not hand-roll a weaker RNG), stores it server-side (new `sso_login_states` table or equivalent, keyed by a hash of the cookie value — never the raw state stored in plaintext queryable form, mirroring `refresh_tokens.tokenHash`/`recovery-tokens.ts`'s hashing precedent) with a 10-minute TTL and single-use semantics, and sets an `httpOnly; Secure; SameSite=Lax` cookie carrying the raw value — **`SameSite=Lax`, not `strict`**, because this cookie must survive the top-level cross-site redirect back from the IdP, unlike the existing `access-token`/`refresh-token` cookies which stay `SameSite=strict` (dedicated test asserting the cookie attributes differ intentionally from `setAuthCookies()`'s existing pattern).
   **Edge case — unknown `providerName`:** returns a generic `404`-class error (never leaking which provider names *are* valid) and does not mint state — dedicated test.
   **Edge case — `providerName === 'local'`:** returns the same generic `404`-class error as an unknown provider — local auth never goes through this route — dedicated test.

4. **Callback validates `state` before ever invoking `onAuthenticate()`.**
   **Given** `POST /api/v1/auth/sso/callback/:providerName` is called,
   **when** the request arrives,
   **then** the handler reads the state cookie, looks up the stored hash, and validates: exists, not expired (>10 min old), not already consumed, and matches the `:providerName` it was minted for — **all before** the registered strategy's `onAuthenticate()` is invoked. On any mismatch (missing cookie, expired, already-consumed, provider mismatch), the request is rejected with a generic auth error (e.g. `401 invalid_state`, never a detailed reason distinguishing *which* check failed — avoids giving an attacker a state-guessing oracle) and `onAuthenticate()` is proven, via a spy, to never have been called — dedicated test per sub-case (missing / expired / already-consumed / provider-mismatch), mirroring Story 14.1's "hooksFactory never invoked on rejection" test pattern.
   **And** on successful validation, the stored state row/hash is marked consumed (or deleted) in the same transaction that reads it, so a replayed callback with the same cookie is rejected on the second attempt — dedicated test (send the same valid callback twice, second attempt gets `401 invalid_state`).
   **And** the state lookup itself must not leak existence via timing: use the DB index lookup (not an application-level loop) for the hash match, and ensure the "missing"/"expired"/"consumed"/"provider-mismatch" branches all do comparable work before responding (no early-return shortcut that makes a nonexistent hash resolve measurably faster than an expired one) — dedicated test is not required to assert precise timing (flaky in CI), but the implementation must route all four rejection sub-cases through one shared "reject" code path rather than four independent early-returns, so future changes can't reintroduce a timing gap. [Security Audit Personas finding]

5. **Successful `onAuthenticate()` + matched `external_identities` row issues a session identical to local login.**
   **Given** `state` validates and the registered strategy's `onAuthenticate(credential)` resolves to `{ externalSubject, providerName, email?, displayName? }`,
   **when** the system looks up `external_identities` by `(org_id, providerName, externalSubject)` and finds a match,
   **then** it calls the same `createLoginSessionInTx()` / `issueSession()` path local login uses (same `sessions`/`refresh_tokens` rows, same JWT TTL/rotation, same cookie-setting helper) for that row's `user_id`, and if `user.mfaEnrolledAt` is set, follows the identical MFA-challenge branch `loginUser()` already takes (returns `MfaChallengeResult` instead of a full session) — **no SSO-specific MFA bypass exists.** A dedicated integration test proves an OrgAdmin/Owner user linked via `external_identities` who later calls an MFA-gated admin route without MFA enrolled gets the exact same `403` `requireMfaEnrollment()` rejection a local-auth OrgAdmin would — this guarantee is inherited "for free" from reusing the shared session path, not re-implemented, and the test exists to prove that inheritance actually holds.
   **Which org does the lookup use?** `external_identities.org_id` — a single `(providerName, externalSubject)` pair resolves to exactly one org via the unique constraint; the callback route itself is not org-scoped by URL/subdomain in this phase (single-tenant-per-instance assumption already implicit elsewhere in this codebase — flag if this proves wrong for a specific self-hosted multi-org deployment; out of scope to redesign here).

6. **`issueSession()` fails after `state` is already consumed — user can retry immediately.**
   **Given** the `external_identities` lookup succeeds but the subsequent session-issuing transaction then fails (e.g. simulate a transient DB error via test injection),
   **when** this happens,
   **then** the caller receives a clear "login failed, please try again" `5xx`/`503`-class error, and a fresh `POST /api/v1/auth/sso/start/:providerName` call immediately succeeds and mints a brand-new `state` — the already-consumed `state` from the failed attempt is never required again and there is no lockout. Dedicated test: mock `createLoginSessionInTx` to reject, assert the error response, then assert a subsequent `start` call succeeds normally.

7. **No matching `external_identities` row — no session, no auto-provisioning, explicit rejection.**
   **Given** `onAuthenticate()` resolves successfully but no `external_identities` row matches `(org_id, providerName, externalSubject)`,
   **when** this lookup misses,
   **then** **no session is issued** and the response is a distinct, clearly-typed "account not linked" result (e.g. `403 account_link_required`) — **never** a fallback that creates an `external_identities` row solely because `AuthResult.email` happens to match an existing `users.email`. A dedicated test asserts: given a user row with `email: "attacker@example.com"` already existing, and a forged/unlinked `AuthResult` asserting that same email but a novel `externalSubject`, the login is rejected with `account_link_required`, not silently linked or logged in — this is the core identity-binding-gap regression test epics.md calls out explicitly (see AC-9).
   **Which org does an unlinked lookup target?** Since there's no existing `external_identities` row to resolve an org from, the org is resolved from `:providerName` → the single registered strategy for that provider (this phase's origin-locked, single-extension model guarantees at most one non-local strategy exists — see Dev Notes judgment call on multi-org SSO deployments being out of scope here).

8. **First-time SSO login can resolve via a pending project invitation, matched by email.**
   **Given** no `external_identities` row matches, but a `project_invitations` row exists in some org with `email` (case-insensitive) equal to `AuthResult.email`, `acceptedAt IS NULL`, `revokedAt IS NULL`, and `expiresAt > now()`,
   **when** this lookup succeeds,
   **then**, inside one transaction: a new `users` row is provisioned (SSO-only account — `passwordHash` set to a non-usable sentinel, following this codebase's `AUTH_DUMMY_PASSWORD_HASH`-style precedent so local-login password checks can never succeed against it), an `org_memberships` row is created per the invitation's `roleToAssign`, one `external_identities` row is inserted binding `(orgId, providerName, externalSubject) → user.id`, the invitation's `acceptedAt` is set, an audit entry equivalent to `AuditEvent.PROJECT_INVITATION_ACCEPTED` plus a new `EXTERNAL_IDENTITY_LINKED` entry are both written, and a session is issued exactly as in AC-5.
   **Edge case — `AuthResult.email` is absent:** if the extension's `onAuthenticate()` result has no `email` field, this invitation-matching path is skipped entirely (cannot match by email) and the flow falls through to AC-7's rejection — dedicated test.
   **Edge case — multiple matching invitations across orgs:** if the same email has pending invitations in more than one org, reject with a generic error rather than guessing which org — this is an unspecified, low-probability edge case; dedicated test asserts no silent pick of the first match.
   **Edge case — concurrent double-provisioning race.** [Failure Mode Analysis finding] Two callback requests presenting different (or even the same, replayed-in-parallel) valid `state` values for the same `AuthResult.email`, arriving concurrently before either transaction commits, could both pass the "no `external_identities` match yet" check and both attempt to claim the same `project_invitations` row — the invitation-claiming update must be an atomic conditional write (`UPDATE project_invitations SET acceptedAt = now() WHERE id = ... AND acceptedAt IS NULL`, mirroring AC-4's atomic state-consumption guard) so only one of the two concurrent requests wins; the loser falls through to a "please retry" error, never a duplicate `users`/`external_identities` row. Dedicated test: fire two concurrent AC-8 flows against the same pending invitation, assert exactly one succeeds and exactly one `users` row is created.
   > **Judgment call, flagged for maintainer confirmation** — see Dev Notes. epics.md's literal text ("a pending invitation for that email") does not specify *which* invitation table or an email-only (tokenless) matching mechanism; this AC adopts `project_invitations` (the only existing invitation construct in this codebase) matched by email instead of its usual token-based acceptance flow, since the SSO caller has no invitation token to present. **Fallback if rejected in review:** delete this AC's implementation (Task 8 only) and require every first-time SSO login to go through AC-10's OrgAdmin-initiated linking endpoint instead — a small, isolated removal that does not affect AC-1 through AC-7, AC-9, or AC-11.
   > **Critical trust-boundary requirement, added via elicitation (Challenge from Critical Perspective):** this AC is only safe if `AuthResult.email` is guaranteed to be *verified* by the external IdP before it reaches this codebase — not merely asserted. Many real IdPs and hand-built `AuthStrategy` implementations can return an unverified or self-declared email. If an attacker can register any email at the external IdP without proof of ownership, and that IdP is wired in as this org's `authStrategy`, AC-8 becomes an account-takeover path: the attacker authenticates as "victim@example.com" at the IdP, and this system auto-provisions them straight into the victim's pending invitation. **Resolution:** treat `AuthResult` as carrying an implicit trust contract — the `email` field must only be populated by an `onAuthenticate()` implementation when the IdP itself verified that email (this is already the contract Story 14.1 published; this story does not change `AuthResult`'s shape, only makes explicit that AC-8 is unsafe to build without it). Add this as a documented precondition in this story's Dev Notes and the mock extension's (Task 10) README, and add a test proving the codebase's own behavior is correct *given* a verified email — verifying the extension's own trustworthiness is out of this story's scope (it belongs to whatever review process approves an extension for production use), but the risk itself must not go unstated.

9. **Registered strategy's `onAuthenticate()` throws or rejects — local login unaffected.**
   **Given** the one registered external strategy's `onAuthenticate()` throws synchronously or its returned promise rejects (network error to the IdP, malformed assertion, etc. — this phase's loader is origin-locked to a single extension per Story 14.2, so at most one external strategy can ever be registered alongside local; this AC is scoped to that reality, not a multi-strategy fallback scenario),
   **when** the dispatch layer in `strategies.ts` invokes it,
   **then** the error is caught, logged via `pino.error` (message/stack may be logged here — unlike Story 14.2's fixed-enum boot-log redaction, this is a per-request error path already covered by this codebase's existing request-error-logging conventions, not a new secret-redaction surface; confirm no credential material ends up in the log line), the caller receives a clear, generic SSO-specific error (e.g. `502 sso_provider_error`), and — proven by a dedicated test that calls `POST /api/v1/auth/login` (local) immediately afterward in the same test — **local login remains fully reachable and unaffected**, never a crashed process or a global lock.
   **Edge case — `onAuthenticate()` hangs instead of rejecting.** [Pre-mortem finding] An extension calling a real, slow, or unresponsive external IdP with no bounded wait would tie up the request handler indefinitely — a single misbehaving or attacked IdP could exhaust the API's request-handling capacity. The dispatch layer wraps `onAuthenticate()` in a fixed timeout (proposed: 10s, matching this codebase's existing outbound-call timeout conventions if one exists, otherwise document the chosen value here) and treats a timeout identically to a rejection (`502 sso_provider_error`, local login unaffected) — dedicated test using a never-resolving `onAuthenticate()` mock, asserting the callback request itself resolves within the timeout bound rather than hanging.

10. **Explicit OrgAdmin-initiated linking action.**
    **Given** an authenticated OrgAdmin calls `POST /api/v1/admin/external-identities` with `{ userId, providerName, externalSubject }` for a user in their own org,
    **when** the request is validated (`secureRoute()`, `allowedRoles: ['admin']`, `requireMfa: true`),
    **then** a new `external_identities` row is created binding `(orgId, providerName, externalSubject) → userId`, an `EXTERNAL_IDENTITY_LINKED` audit entry is written, and the response is `201` with the created row's public shape (no raw `externalSubject` echoed back beyond what was submitted — nothing secret to redact here, but follow this codebase's standard response-shape conventions).
    **Edge case — duplicate `(orgId, providerName, externalSubject)`:** the unique constraint rejects a second link attempt with `409 conflict`, not a silent overwrite or a 500 — dedicated test.
    **Edge case — `userId` not a member of the caller's org:** `403`/`404` (do not leak whether the `userId` exists in a different org) — dedicated test.
    **Edge case — non-admin caller:** `403` (owner, member, viewer) — dedicated test per role, matching Story 14.2's RBAC test pattern (`allowedRoles: ['admin']`, not `['owner', 'admin']`).

11. **Unknown/unregistered `:providerName` at the callback route — honest, generic rejection.**
    **Given** no strategy is registered for the `:providerName` in the callback URL (no extension loaded, extension loaded but declared no `authStrategy`, or a typo'd provider name),
    **when** `POST /api/v1/auth/sso/callback/:providerName` is called,
    **then** the response is a generic `404`-class error (not a 500, not a stack trace, not a hint about which provider names *are* valid) — this is the honest placeholder state referenced in the Product Surface Contract above; dedicated test covers both "no extension loaded at all" and "extension loaded but zero-length `authStrategies` beyond local."

12. **A loadable mock external-IdP extension exists for e2e coverage and manual QA — no real third-party IdP required to exercise this story.**
    **Given** this story introduces a real, network-facing external-auth flow that (per Dev Notes judgment call #1) leaves actual IdP-redirect construction to the extension/client, there is otherwise no way to exercise `start` → real IdP → `callback` end-to-end in CI or by hand without standing up a real third-party IdP account (Okta/Auth0/etc.) — which is out of scope and undesirable for automated tests,
    **when** a developer or CI needs to validate this story's full flow,
    **then** a self-contained, in-repo mock extension (implementing `AuthStrategy` per Story 14.1's contract) exists that simulates an external IdP entirely in-process — no outbound network calls, deterministic `onAuthenticate()` behavior driven by a test-controlled fixture user table — loadable via the same `EXTENSION_PATH` mechanism Story 14.2 established, and:
    - a Playwright e2e journey drives the full browser-visible slice of the flow (start → simulated IdP redirect → callback → authenticated session), asserting on cookies/redirect outcomes exactly as a real browser session would see them;
    - a documented, scripted manual-QA path (an npm script, e.g. `pnpm --filter @project-vault/api sso:qa`, or a short runbook in the story's Dev Notes) lets a human load the mock extension against a local dev API and click/curl through start → callback → linked-session and start → callback → `account_link_required` without hand-crafting requests from scratch each time.
    **Edge case:** the mock extension must be excluded from any production `EXTENSION_PATH` default/example config — dedicated check (grep/test) that no production env file or deploy manifest references the mock extension's package path.

## Tasks / Subtasks

- [ ] Task 1: `external_identities` migration + schema (AC: 5, 7, 8, 9, 10)
  - [ ] Write failing schema test asserting `external_identities` shape (`packages/db/src/schema/external-identities.test.ts` or co-located per this repo's existing schema-test convention, e.g. `sessions.ts`/`org-memberships.ts` neighbors)
  - [ ] Add `packages/db/src/schema/external-identities.ts`: `id uuid PK`, `org_id uuid` (org-scoped, RLS via `orgScoped()` helper — same as `audit-log-entries.ts`), `user_id uuid FK → users.id ON DELETE CASCADE`, `provider_name text NOT NULL`, `external_subject text NOT NULL`, `created_at timestamptz default now()`; unique index on `(org_id, provider_name, external_subject)`
  - [ ] New migration `packages/db/src/migrations/00XX_external_identities.sql` (next sequential number — check `meta/_journal.json` for the actual next-free slot given concurrent in-flight migrations from other stories; run `pnpm check-migration-compatibility` after writing)
  - [ ] Add RLS policy following the identical `NULLIF(current_setting(...))` org-scoping pattern used by all 19 existing policy-touching migrations (per the `1-15` RLS-flake-investigation story's own confirmation of this pattern's consistency)
- [ ] Task 2: `sso_login_states` migration + schema (AC: 3, 4)
  - [ ] Write failing schema test
  - [ ] Add `packages/db/src/schema/sso-login-states.ts`: `id uuid PK`, `state_hash text NOT NULL UNIQUE` (HMAC/SHA-256 of the raw cookie value, never the raw value — mirror `refresh_tokens.tokenHash` hashing precedent, see `tokens.ts`/`hashRefreshToken`), `provider_name text NOT NULL`, `expires_at timestamptz NOT NULL`, `consumed_at timestamptz`, `created_at timestamptz default now()` — **not** org-scoped (state exists before any org/user is known)
  - [ ] New migration; confirm `pnpm check-migration-compatibility` passes
  - [ ] Consider (and document the decision either way) a periodic cleanup job for expired rows — follow the existing `notification-dlq-cleanup`-style worker precedent if one is added, or explicitly defer as low-risk (small table, TTL-bounded) if not — do not leave this silently unconsidered
- [ ] Task 3: `authStrategies` list + `registerAuthStrategy()` (AC: 1, 2)
  - [ ] Write failing unit tests for `apps/api/src/modules/auth/strategies.ts` (new file + co-located `strategies.test.ts`): local strategy present at index 0 at module load; `registerAuthStrategy()` appends; rejects `providerName: 'local'`; append-only (no remove/replace API surface exists at all — don't just test it's unused, don't build one)
  - [ ] Implement `authStrategies: Array<{ providerName: string; strategy: AuthStrategy }>` module-level array seeded with the local marker at module load; `registerAuthStrategy(providerName: string, strategy: AuthStrategy): void`
  - [ ] Wire into `apps/api/src/app.ts`: after `loadExtension()` resolves inside `createApp()` (same call site Story 14.2 added), check `getExtensionStatus()`; if `status === 'loaded'` and `hooks.authStrategy` present, call `registerAuthStrategy(manifest.name, hooks.authStrategy)` — guard against double-invocation the same way Story 14.2's loader guards its own idempotency
- [ ] Task 4: SSO start route (AC: 3, 11)
  - [ ] Write failing integration tests: valid provider → `state` minted + cookie set with `SameSite=Lax`/`httpOnly`/`Secure` attributes explicitly asserted (distinct from `setAuthCookies()`'s `strict`); unknown provider → generic 404; `providerName: 'local'` → generic 404
  - [ ] Implement `POST /api/v1/auth/sso/start/:providerName` in a new `apps/api/src/modules/auth/sso-routes.ts`, using `secureRoute()`'s unauthenticated-route pattern (mirror `routes.ts`'s existing `/login`/`/register` — no `allowedRoles` since the caller isn't authenticated yet) with rate limiting (mirror the `max: 20, timeWindow` style already used for `/login`-adjacent routes in `routes.ts`)
- [ ] Task 5: SSO callback route — state validation before dispatch (AC: 4, 11)
  - [ ] Write failing tests per state-validation sub-case: missing cookie, expired, already-consumed, provider-mismatch — each asserts `onAuthenticate` (a test spy) is never called
  - [ ] Write failing test: unknown `:providerName` → 404, `onAuthenticate` never referenced (no strategy exists to call)
  - [ ] Implement state lookup/consumption (single transaction: read + mark consumed) in `sso-routes.ts`, called before any strategy dispatch
  - [ ] **[Red Team vs Blue Team finding]** Apply rate limiting to the callback route independently from `start` — although the 256-bit `state` value is not brute-forceable, an unauthenticated callback endpoint that (on a valid-looking request) triggers a real outbound `onAuthenticate()` call is itself a resource-exhaustion target (cheap for the attacker, expensive for the API/IdP); mirror the same `max/timeWindow` convention as `start`, dedicated test asserting the callback route is throttled independently
- [ ] Task 6: SSO callback route — dispatch, identity lookup, session issuance (AC: 5, 6, 7, 8, 9)
  - [ ] Write failing tests: successful match → session issued via the same `createLoginSessionInTx` path, cookies set identically to local login; MFA-enrolled linked user → `MfaChallengeResult` returned, not a full session (reuse `loginUser()`'s branch logic, do not duplicate it — extract a shared helper if `loginUser()`'s current shape doesn't already expose one cleanly)
  - [ ] Write failing test: `issueSession` failure after state consumed → clear retryable error, fresh `start` call succeeds
  - [ ] Write failing test: no match, no invitation → `403 account_link_required`, dedicated forged-`AuthResult`-with-matching-email regression test per AC-7
  - [ ] Write failing tests for AC-8 (invitation-based auto-link): happy path, missing-email skip, multi-org-conflict rejection, concurrent double-provisioning race (two parallel requests, exactly one wins)
  - [ ] Write failing test for AC-9: `onAuthenticate` throws → `502`-class error, immediately-following local `/login` call in the same test still succeeds
  - [ ] Implement the callback handler's post-state-validation logic: invoke `onAuthenticate(credential)`, `external_identities` lookup, invitation-fallback lookup, session issuance, error mapping — keep local login's route/handler in `routes.ts` completely untouched (only `strategies.ts`/`sso-routes.ts` are new)
- [ ] Task 7: Admin-initiated linking endpoint (AC: 10)
  - [ ] Write failing integration tests: happy path 201; duplicate → 409; cross-org userId → 403/404; non-admin roles → 403 (member, viewer, owner)
  - [ ] Implement `POST /api/v1/admin/external-identities` (new file, e.g. `apps/api/src/modules/auth/external-identity-routes.ts`, or co-located in `sso-routes.ts` if that reads more cohesively — judgment call, document the choice in Dev Notes/File List) using `secureRoute()` with `allowedRoles: ['admin']`, `requireMfa: true`, `writeAuditEvent` configured for the `EXTERNAL_IDENTITY_LINKED` event
  - [ ] Register the route at `ADMIN_PREFIX` in `app.ts`, mirroring Story 14.2's registration pattern
- [ ] Task 8: Audit events (AC: 4, 5, 7, 8, 9, 10)
  - [ ] Add `EXTERNAL_IDENTITY_LINKED: 'external_identity.linked'`, `SSO_LOGIN_SUCCEEDED: 'sso_login.succeeded'`, and `SSO_LOGIN_REJECTED: 'sso_login.rejected'` (payload includes a `reason` enum: `invalid_state`, `account_link_required`, `provider_error` — never free-text) to `packages/shared/src/constants/audit-events.ts`, test-first per that file's existing convention. **Not optional/judgment-call, per Security Audit Personas elicitation:** this is a security-critical auth surface — `LOGIN_FAILED` already gets mandatory audit coverage for local login per architecture.md, and SSO rejections (bad state, unlinked account, provider error) are exactly the events a security team needs to see in aggregate to detect an attack in progress; write `SSO_LOGIN_REJECTED` on every AC-4/AC-7/AC-9 rejection path, not just the success paths (AC-8/AC-10)
- [ ] Task 9: Route-audit, RLS, and CI conformance (AC: all)
  - [ ] Run `apps/api/src/__tests__/route-audit.test.ts` — confirm new routes register via `secureRoute()`/existing unauthenticated-route helpers and need no manual exemption (or add one with justification if the SSO start/callback routes are structurally unauthenticated in a way the audit doesn't already recognize — check `route-exemptions.ts` precedent)
  - [ ] Run `pnpm check-migration-compatibility` and `pnpm check-rls` against both new migrations
  - [ ] Full regression: `pnpm turbo typecheck lint test --filter=@project-vault/api --filter=@project-vault/db --filter=@project-vault/shared`
  - [ ] Confirm 80/80/80/80 coverage bar on all new files
- [ ] Task 10: Mock external-IdP extension fixture for e2e + manual QA (AC: 12)
  - [ ] Write failing unit test asserting the mock extension's `authStrategy.onAuthenticate()` resolves deterministically for a small fixed set of fixture identities (e.g. `linked-user@example.test` → matches a pre-seeded `external_identities` row; `unlinked-user@example.test` → no match; `invited-user@example.test` → matches a pre-seeded pending `project_invitations` row) and rejects for anything else
  - [ ] Implement the fixture extension as a standalone package/dir (proposed: `fixtures/mock-sso-extension/`, following Story 14.1/14.2's manifest + `hooksFactory` shape) that never makes an outbound network call — `onAuthenticate(credential)` just maps a test-provided `credential` string to a canned `AuthResult` via an in-memory lookup table, simulating "the IdP already authenticated this user and handed back an assertion"
  - [ ] Add a short `start`-side simulation helper (used only by tests/e2e/QA script, not production code) that stands in for "redirect to IdP and come back" by directly constructing the callback payload the mock `onAuthenticate()` expects — document clearly in the fixture's own README that this bypasses real redirect/assertion-verification mechanics and exists solely to exercise this codebase's `start`→`callback`→session-issuance plumbing
  - [ ] Write a Playwright e2e journey under `apps/web/e2e/journeys/` (mirror existing journey structure/conventions in that directory) that: loads the API with `EXTENSION_PATH` pointed at the mock extension, drives a full browser session through `start` → simulated callback → asserts the resulting session/cookie state for both the "linked user" and "unlinked user" fixture identities, and asserts the invitation-based auto-link path (AC-8) end-to-end for the "invited user" fixture identity
  - [ ] Add a documented manual-QA path: either an npm script (e.g. `pnpm --filter @project-vault/api sso:qa`) that boots the API with the mock extension loaded and prints ready-to-run `curl` commands/expected responses for each fixture identity, or an equivalent runbook section in this story's Dev Notes with copy-pasteable `curl` commands — either way, a human must be able to manually re-verify this story's flow end-to-end in under a few minutes without reading the implementation source first
  - [ ] Dedicated test/check asserting the mock extension's package path never appears in any production env file, deploy manifest, or default `EXTENSION_PATH` example (AC-12 edge case)

## Dev Notes

### Scope boundaries — what this story is NOT

- **No login-screen UI, no email-first domain routing.** That is Story 14.4's entire scope (`org_sso_domains` table, email-first login screen). This story does not create `org_sso_domains` — do not add it here even though architecture.md lists it under the same epic-wide "Security items" bullet; it belongs to 14.4's literal AC text, confirmed by re-reading epics.md Story 14.4 directly.
- **No `getAuthorizationUrl`/IdP-redirect-building hook.** The already-published `AuthStrategy` interface (Story 14.1, `packages/extension-api`) exports only `onAuthenticate(credential): Promise<AuthResult>` — there is no hook for constructing the actual redirect URL to the external IdP. epics.md's/architecture.md's "user initiates SSO login" prose implies a full authorization-redirect flow, but the locked contract this story must consume doesn't support it. **Resolution:** the `start` route (AC-3) only mints and stores `state`, returning it (and the cookie) to the caller — building the actual IdP authorization URL is the extension's/client's own responsibility, using its own out-of-band provider config (client ID, IdP base URL) that never flows through core. **Do not modify `packages/extension-api` in this story** to add a redirect-URL hook — that would be an API-surface change requiring its own version bump and story, matching Story 14.1/14.2's explicit "flag gaps, don't silently patch the package" precedent. Flag this gap in the PR description.
- **No sandboxing, no multi-extension fallback.** Per Story 14.2, the loader is origin-locked to a single extension; AC-9's "onAuthenticate throws" handling is scoped to that single-strategy reality, not a multi-provider retry/fallback chain.
- **No admin UI.** `POST /api/v1/admin/external-identities` is a real, callable API endpoint with no corresponding `(app)/admin/` page — same tracked-gap pattern as Story 14.2's status endpoint.
- **`capabilities[]` enforcement is still out of scope** (Story 14.2/architecture.md's stated deferral) — registering an `authStrategy` hook is not gated on the manifest having declared an `auth-provider` capability string in this phase; that's audit-only metadata, unchanged by this story.

### Open Questions / Judgment Calls (resolved here so implementation is unblocked)

Per AGENTS.md: "If requirements conflict, pause to reconcile the intended behavior instead of layering compatibility shims over an unclear contract." Real gaps between epics.md/architecture.md and the actual codebase/already-locked `packages/extension-api` contract, resolved below:

1. **No `getAuthorizationUrl` hook exists in the locked `AuthStrategy` interface.** See Scope Boundaries above — resolved by scoping the `start` route to state-minting only. If this is rejected in review as insufficient, the fallback is to treat this as a blocking gap requiring a Story 14.1 follow-up (a new `AuthStrategy.onAuthorizationRequest?(): Promise<{ redirectUrl: string }>` hook, versioned as a minor bump) rather than inventing an unversioned addition inside this story.
2. **"Pending invitation for that email" has no existing email-only (tokenless) lookup mechanism.** `project_invitations` is designed around token possession (`findInvitationByTokenHash`), not email-only matching — an SSO caller has no invitation token to present, only an IdP-asserted email. AC-8 adopts a new email-based lookup against `project_invitations` (case-insensitive, unaccepted/unrevoked/unexpired) as the closest existing construct, explicitly flagged here as a genuine judgment call requiring maintainer confirmation, with a documented, small, isolated fallback (delete Task 8/AC-8, require OrgAdmin-initiated linking for every first-time SSO login) if rejected.
3. **`org_id` resolution for an unlinked (AC-7) lookup.** Since there's no `external_identities` row yet, the org must come from the registered strategy itself (this phase's origin-locked single-extension model guarantees at most one non-local `authStrategies` entry, hence exactly one candidate org — resolved via whatever org context the extension's own manifest/config implies, e.g. the loaded extension is provisioned for exactly one org in this phase). If a future self-hosted deployment needs one extension to serve multiple orgs, this is a real limitation to revisit — not silently glossed over, flagged here.
4. **MFA enforcement for SSO-authenticated OrgAdmin/Owner is inherited, not re-implemented.** This codebase's actual `requireMfaEnrollment()` gate (`apps/api/src/lib/secure-route.ts` + `mfa-enforcement.ts`) is applied per-protected-route via `secureRoute({ security: { requireMfa: true } })`, not as a hard block inside `loginUser()` itself (which only branches on `user.mfaEnrolledAt` to decide an MFA *challenge*, not a `403`). architecture.md's "identical 403 MFA_ENROLLMENT_REQUIRED check applies" is satisfied automatically because SSO-issued sessions are indistinguishable from local-issued ones at the JWT/session level — AC-5's dedicated test proves this inheritance rather than assuming it.
5. **State cookie must diverge from `setAuthCookies()`'s `SameSite=strict` default.** `strict` would be dropped by the browser on the top-level cross-site redirect back from the IdP, breaking the entire flow — `Lax` is required specifically for this cookie, and this divergence is intentional, not an oversight to "fix" toward consistency with the access/refresh cookies.
6. **Where do the new routes live?** `sso-routes.ts` (start + callback) and `external-identity-routes.ts` (admin linking) are proposed as new files under `apps/api/src/modules/auth/`, alongside `strategies.ts` — not under `apps/api/src/extensions/` (that directory is Story 14.2's generic extension-loading subsystem, not auth-specific dispatch; conflating the two would blur the "extensions/ is general-purpose, modules/auth/ owns auth" boundary architecture.md draws). If code review prefers otherwise, this is a low-cost file-location change.
7. **AC-8's email-verification trust boundary is a precondition on the extension, not something this story can enforce in code.** See AC-8's flagged note above — this codebase already trusts `AuthResult.email` per Story 14.1's contract; this story surfaces (rather than silently assumes) that an extension asserting unverified emails turns AC-8 into an account-takeover vector, and documents it as an operational/extension-review concern, not a gap this story's code must close.

### Elicitation Record

Five advanced-elicitation methods were applied during story creation and integrated directly (per this project's zero-user-intervention story-creation convention):
1. **Security Audit Personas** → uniform-latency requirement across all AC-4 state-rejection branches; `SSO_LOGIN_REJECTED`/`SSO_LOGIN_SUCCEEDED` audit events made mandatory, not optional (Task 8).
2. **Pre-mortem Analysis** → bounded timeout around `onAuthenticate()` to prevent a hung external call from exhausting request capacity (AC-9 edge case).
3. **Failure Mode Analysis** → atomic conditional-write guard against concurrent double-provisioning on the AC-8 invitation-claim path.
4. **Red Team vs Blue Team** → independent rate limiting on the callback route (not just `start`), since it's an unauthenticated route that triggers real outbound work.
5. **Challenge from Critical Perspective** → surfaced AC-8's email-verification trust boundary as a documented, non-silent precondition rather than an implicit assumption.

### Architecture compliance (must follow exactly)

- **`authStrategies` invariant:** local strategy always index 0, list is append-only at boot, no runtime add/remove — the route handler code must be identical whether the list has 1 or 2 entries ("core never special-cases the extension"). [Source: architecture.md L385-386]
- **Identity binding — no auto-link-by-email, ever**, except via the explicitly-scoped AC-8 invitation path (which is itself an *explicit, auditable, consent-based* link — a pending invitation the org already created — not a silent email-match auto-link of an *existing unrelated* account). AC-7's forged-`AuthResult`-matching-an-existing-user test is the one that must never pass via auto-link. [Source: architecture.md L391-394]
- **CSRF/state validation is security-critical, not optional hardening** — server-generated, server-stored (hashed), short-TTL (10 min), single-use, `httpOnly; Secure; SameSite=Lax`, validated before `onAuthenticate()` runs. [Source: architecture.md L395, epics.md Story 14.3 AC]
- **Fixed callback route shape:** `POST /api/v1/auth/sso/callback/:providerName` — do not deviate from this exact path/method. [Source: architecture.md L396, epics.md Story 14.3 AC]
- **External strategies call the same `issueSession()`/session-creation path as local login** — same `sessions`/`refresh_tokens` rows, same JWT TTL/rotation. Do not build a parallel session mechanism. [Source: architecture.md L387]
- **RBAC role mapping:** "OrgAdmin" maps to this codebase's literal `'admin'` role string (confirmed precedent from Story 14.2's Dev Notes) — `POST /api/v1/admin/external-identities` uses `allowedRoles: ['admin']`, not `['owner', 'admin']`.
- **No bare Drizzle queries outside `withOrg()`/`withOrgReadScope()`/`withAdminAccess()`** — this ESLint-enforced rule applies to all new query code in this story, including the cross-org invitation-matching lookup in AC-8 (which, by necessity, cannot be `withOrg`-scoped to a single org up front since the target org is initially unknown — use `getDb()` directly only for the initial cross-org invitation search, then switch to `withOrg(org.id, ...)` for everything after the org is resolved; document this one necessary exception explicitly in the implementation, do not silently bare-query elsewhere).
- **Hashing convention for `state`:** never store the raw `state` value queryable in the DB — hash it the same way `refresh_tokens.tokenHash`/`recovery-tokens.ts` already do. [Source: apps/api/src/modules/auth/tokens.ts precedent]

### Testing standards summary

- **TDD red-green mandatory** (AGENTS.md) — write the failing test first for every task, confirm it fails for the expected reason, then implement.
- **RLS/tenant isolation:** dedicated test proving `external_identities` is org-scoped (a row in org A is invisible via `withOrg(orgB, ...)`) — follow `check-rls-coverage.test.ts`'s existing pattern for new org-scoped tables.
- **Session/auth lifecycle:** dedicated tests proving SSO-issued sessions are indistinguishable from local ones at the session/cookie/MFA-gate level (AC-5), and that a failed post-state-consumption session issuance doesn't lock the user out (AC-6).
- **Concurrency:** consider (and test, or explicitly document as accepted risk) a race between two callback requests presenting the same `state` cookie simultaneously — the single-use consumption must be atomic (e.g. `UPDATE ... WHERE consumed_at IS NULL RETURNING ...` or equivalent row-level guard, not read-then-write) so at most one wins.
- **Audit behaviour:** `EXTERNAL_IDENTITY_LINKED` audit entries for both AC-8 (invitation-based) and AC-10 (admin-initiated) paths — assert payload shape, actor type (`system` for AC-8's auto-link during a login request with no authenticated actor yet arguably reads oddly — treat the *newly created user* as the actor once the session exists, consistent with `registerUser()`'s own pattern of writing its audit entry using the just-created user's own `identityTokenId`).
- **Rate limiting:** SSO start/callback routes need rate limiting matching this codebase's `/login`-adjacent conventions (`routes.ts`'s `rateLimit: { max: N, timeWindow }` patterns) — an unauthenticated callback endpoint is exactly the kind of route abuse targets.
- **Negative-path coverage is not optional:** every state-validation sub-case (missing/expired/consumed/provider-mismatch), every AC-7/AC-8 edge case, and the AC-9 "local login unaffected" proof each need their own dedicated test, not a single generic failure test.
- Repo coverage bar: 80/80/80/80 (statements/branches/functions/lines).

### Project Structure Notes

New files (proposed, see Dev Notes judgment call #6 on placement):
- `packages/db/src/schema/external-identities.ts` (+ schema test) + migration
- `packages/db/src/schema/sso-login-states.ts` (+ schema test) + migration
- `apps/api/src/modules/auth/strategies.ts` (+ `strategies.test.ts`)
- `apps/api/src/modules/auth/sso-routes.ts` (+ `sso-routes.test.ts`) — start + callback
- `apps/api/src/modules/auth/external-identity-routes.ts` (+ test) — admin linking endpoint
- `fixtures/mock-sso-extension/` (+ its own README + unit test) — in-process mock IdP extension for e2e/manual QA (AC-12, Task 10); never referenced by production config
- `apps/web/e2e/journeys/sso-login.spec.ts` (or equivalent, matching existing journey file-naming convention) — Playwright e2e coverage for the mock-extension-driven flow
- A manual-QA script or Dev-Notes runbook addendum (exact form is an implementation-time judgment call — npm script vs. documented `curl` runbook, see Task 10)

Modified files:
- `apps/api/src/app.ts` — wire `registerAuthStrategy()` after `loadExtension()` resolves; register new routes at `ADMIN_PREFIX` (linking endpoint) and the public auth prefix (start/callback)
- `packages/shared/src/constants/audit-events.ts` (+ test) — add `EXTERNAL_IDENTITY_LINKED` (and any minimal SSO-login audit events, justified in Dev Notes if added)

No `packages/extension-api` changes — this story only consumes the already-published `AuthStrategy`/`AuthResult`/`ExtensionHooks` surface from Story 14.1. If implementation reveals the missing-redirect-hook gap (Dev Notes judgment call #1) genuinely blocks the story, stop and flag it rather than silently patching the package here.

No `apps/web` changes — see Product Surface Contract; the login UI is explicitly Story 14.4's scope, not silently dropped.

### Previous Story Intelligence (from 14-2)

- 14-2 established `apps/api/src/extensions/loader.ts`'s module-level state shape: `{ status, manifest?, hooks?, loadedAt? }`, exposed via `getExtensionStatus()`. This story reads that state (not the loader's internals) to find `hooks.authStrategy` — do not reach into loader internals directly, matching 14-2's own stated design intent ("small, focused accessors").
- 14-2 proved the "org-fanout for boot-time events with no natural org" pattern (`fetchAllOrgIds()` + `withOrg()` + per-org try/catch) for its audit writes — **not directly reusable here**, since this story's audit writes (AC-8, AC-10) always have a concrete, single resolved org by the time they write (unlike 14-2's genuinely org-less boot event). Do not import that fanout pattern by rote; it doesn't fit this story's shape.
- 14-2's idempotency-guard pattern (module-level state check before re-running side effects) is directly reusable for Task 3's "append-only, no duplicate registration" guarantee.
- 14-2 confirmed `apps/api/src/extensions/` is a distinct concern from `apps/api/src/plugins/` (rotation plugins) — this story adds a third, auth-specific concern (`modules/auth/strategies.ts`) that must not be confused with either.
- 14-2's RBAC judgment call (`allowedRoles: ['admin']`, not `['owner', 'admin']`, for "OrgAdmin only") is reused verbatim for this story's admin-linking endpoint.
- 14-2's git commit style (`feat(extensions): ...` scoped conventional-commit prefix) — this story should use `feat(auth): authenticate via a registered external provider strategy (14-3)` or similar, matching the `45d4d3b feat(extensions): load a configured extension at startup, fail-safe (14-2)` precedent.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 14.3: Authenticate via a Registered External Provider Strategy] — literal AC text (9 Given/When/Then blocks), this story's canonical requirement source
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 14: Extension Architecture & Pluggable Authentication] — epic framing, FR115 mapping, security-critical-not-optional-hardening callout, community-extensions-out-of-scope note
- [Source: _bmad-output/planning-artifacts/epics.md#Story 14.4: Route Login to SSO by Email Domain] — confirms `org_sso_domains`/email-first UI is 14.4's scope, not this story's
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security] (~L344-397) — MFA enforcement invariant, `registerAuthStrategy()` contract, identity-binding design (`external_identities` shape, no-auto-link-by-email rationale), CSRF/state-parameter design, callback route shape, email-first login screen note
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture] (~L1058-1059) — `external_identities`/`org_sso_domains` table summaries
- [Source: _bmad-output/implementation-artifacts/14-2-load-a-configured-extension-at-startup-fail-safe.md] — prior story; `getExtensionStatus()`/`ExtensionHooks` shape this story consumes, org-fanout audit pattern (not reused here, see Previous Story Intelligence), RBAC judgment call reused verbatim
- [Source: _bmad-output/implementation-artifacts/14-1-define-and-publish-the-extension-api-package.md] — `AuthStrategy`/`AuthResult` exact typed contract (`onAuthenticate(credential: string): Promise<AuthResult>`), confirms no redirect-URL hook exists
- Codebase (read directly during story creation): `apps/api/src/modules/auth/service.ts` (`loginUser`, `createLoginSessionInTx`, `RequestMeta`, `insertAuditEntry`), `apps/api/src/modules/auth/mfa-login.ts` (`createPendingMfaSession`, `MfaChallengeResult`), `apps/api/src/modules/auth/mfa-enforcement.ts`/`grace-period.ts` (actual MFA-gate mechanism — route-level, not login-time), `apps/api/src/modules/auth/tokens.ts` (`setAuthCookies`, cookie attribute conventions, token-hashing precedent), `apps/api/src/modules/auth/routes.ts` (rate-limit conventions, route registration patterns), `apps/api/src/lib/secure-route.ts` (`allowedRoles`, `requireMfa`, `writeAuditEvent`), `packages/db/src/schema/users.ts`, `packages/db/src/schema/org-memberships.ts` (status values: `active`/`deactivated` only — no `invited` status, informing AC-8's judgment call), `packages/db/src/schema/project-invitations.ts` (token-based invitation shape, informing AC-8's judgment call), `apps/api/src/modules/invitations/lookup.ts` (`findInvitationByTokenHash`, `claimInvitation` — existing token-based pattern, not directly reusable for email-only lookup), `packages/extension-api/src/hooks/auth-strategy.ts`, `packages/extension-api/src/register-extension.ts` (`ExtensionHooks` shape), `apps/api/src/extensions/loader.ts` (`getExtensionStatus()`), `packages/db/src/migrations/meta/_journal.json` (next migration number)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- TDD process: [Source: AGENTS.md#Development Story Implementation]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created

### File List
