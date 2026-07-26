# Story 14.4: Route Login to SSO by Email Domain

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user at a company that uses SSO,
I want the login screen to automatically offer SSO once I enter my work email,
so that I don't have to know in advance whether my org uses SSO or hunt for a separate button.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Alex** works at Acme Corp, whose OrgAdmin registered `test.mock-sso-extension` and mapped
`acme.com` → that provider in `org_sso_domains` (see Dev Notes — no admin UI exists to create this
mapping yet; it is seeded directly, same as Story 14.3's `sso-qa.ts` script).

1. Alex opens `/login`. Only an email field + "Continue" button are shown (no password field yet).
2. Alex types `alex@acme.com` and clicks Continue.
3. The client calls the new domain-lookup endpoint; it resolves to `test.mock-sso-extension`.
4. The screen swaps to an SSO step (no password field ever rendered) prompting Alex to authenticate
   via that provider (see Dev Notes judgment call on the concrete SSO-step UI, since no hosted
   external-IdP-redirect mechanism exists in this codebase yet — Story 14.3 shipped a
   credential-string exchange model, not a browser redirect).
5. On success, Alex lands on `/dashboard` (or `nextPath`), same as a local-login session.

**Morgan** works at a company with no SSO mapping: enters `morgan@example.com`, clicks Continue,
the password field renders normally, login proceeds exactly as it does today.

**Riley** is a Project Vault user whose org has no SSO extension registered at all: the login
screen never calls the domain-lookup endpoint (see AC-4) — behaves identically to pre-Epic-14 code.

## Acceptance Criteria

1. **Given** an org has registered an SSO strategy and configured an `org_sso_domains` entry
   mapping `"acme.com"` to that strategy's `providerName`, **when** a user on the login screen
   enters an email ending in `@acme.com` and continues, **then** the client resolves the domain via
   a new server endpoint and is routed into that provider's SSO flow (per Story 14.3's
   start/callback contract) — no password field is ever shown for that email.
   - 1a. Domain match is case-insensitive (`Acme.COM` matches a stored `acme.com` row) and matches
     only the full domain label after `@`, never a substring (`notacme.com` must NOT match `acme.com`).
   - 1b. If the org's `org_sso_domains` row references a `providerName` that is not currently
     present in the in-memory `authStrategies` list (e.g. the extension failed to load, or was
     unloaded since the mapping was created), the lookup must fail open to the password field
     (never a hung state, never a 500) — same invariant as AC-3.
   - 1c. Subdomains do not match a parent-domain mapping (`mail.acme.com` does NOT match a stored
     `acme.com` row) unless a row for `mail.acme.com` itself exists — no implicit wildcard behavior.

2. **Given** a user enters an email whose domain has no `org_sso_domains` mapping, **when** the
   lookup completes, **then** the password field renders and local login proceeds normally (exact
   existing `LoginForm` behavior, unchanged).
   - 2a. An email with no `@` or a malformed domain portion is treated as "no mapping" (fails open
     to the password field), not a 422/500 — the endpoint must not assume a validated email shape.

3. **Given** the `org_sso_domains` lookup itself fails (e.g. a transient DB error), **when** this
   happens during login, **then** the login screen fails open to the password field — same
   fail-safe philosophy as the extension loader (Story 14.2) — never a hung or broken login screen.
   - 3a. A network-level failure of the domain-lookup fetch call itself (not just a server-side DB
     error) must also fail open client-side — the web layer cannot assume the server always answers.
   - 3b. The endpoint itself must never throw an unhandled 500 on a DB error; it returns a
     structured "no mapping" response (or the client interprets any non-2xx as fail-open) so the
     failure mode is identical whether the DB error happens server-side or the request never
     completes.

4. **Given** an org has no SSO extension registered at all, **when** any user logs in, **then** the
   login screen never attempts an SSO domain lookup — only local email/password is shown, matching
   the "core never special-cases the extension" invariant: with zero extensions installed, this
   code path behaves exactly as it does today.
   - 4a. This is a statement about the *codebase's default state* (no `org_sso_domains` rows,
     `authStrategies` is local-only): the domain-lookup endpoint and the two-step UI flow always
     exist and always run (per AC-1/AC-2), but every lookup fails open to the password field in this
     state, producing behavior indistinguishable from pre-Epic-14 code. Do not special-case "no
     extensions" in the UI or route logic — this is naturally implied by an empty/no-op lookup, not
     a separate code path.

5. **RLS / tenant isolation.** `org_sso_domains` is an org-scoped table (like `external_identities`)
   with the same RLS policy pattern. Dedicated test proving a row in org A is invisible via
   `withOrg(orgB, ...)`. The pre-auth domain-lookup route itself has no resolvable org/session
   context (the caller isn't authenticated yet) — it must use `getAdminDb()` for this one lookup,
   the same documented exception Story 14.3 established for `external_identities`/
   `project_invitations` pre-auth lookups (see that story's Completion Notes judgment call #3) —
   RLS still protects all other org-scoped access paths to this table.

6. **Audit / operational logging.** The domain-lookup endpoint writes **no** audit event — like
   Story 14.3's `/sso/start` route, a domain-lookup response carries no security-relevant outcome
   (it doesn't reveal user existence, only whether a domain has SSO configured, which is
   organization-level and not secret). Confirm this matches `/sso/start`'s existing "no audit row by
   design" precedent — do not invent a new audit event type for this endpoint. A structured
   operational log line (info level, no PII beyond the domain) is acceptable for observability but
   not required by this story.

7. **Auth/session lifecycle.** The full user-facing flow (email → SSO step → provider credential
   exchange → session) must produce a session indistinguishable from local login at the
   cookie/session/MFA-gate level — this story adds no new session-issuing code, it only adds the
   client-side routing into Story 14.3's existing `start`/`callback` calls, so this AC is primarily
   a regression check: confirm the existing MFA-enforcement invariant (AC-5/AC-9 of Story 14.3)
   still holds when reached via this new UI path, via an e2e or component-level test exercising the
   full two-step form.

8. **Concurrency.** Two rapid domain-lookup requests for different emails while the user is mid-typing
   (e.g. user changes their mind, types a second email before the first lookup resolves) must not
   let a stale, slower first response overwrite the UI state set by a later, faster second response
   ("out-of-order response" race) — the component must key its state update to the request that
   matches the *current* input value, or cancel/ignore stale responses.

9. **Rate limiting.** The new domain-lookup endpoint is public/unauthenticated and must be
   rate-limited per this codebase's existing public-route convention (matching `/login`'s and
   `/sso/start`'s `rateLimit: { max, timeWindowMs }` shape) — an unauthenticated endpoint that
   triggers a DB query per call is a resource-exhaustion target even though it leaks no
   user-existence information. It must also carry a request-body size limit matching `/login`'s
   `bodyLimit: 4096` convention (`routes.ts`) — an unauthenticated route accepting a body must never
   skip this.
   - 9a. The response body must **never** include the org's id or name — only
     `{ ssoRequired, providerName? }`. Confirming "domain X maps to some org's SSO" is an accepted,
     minimal disclosure (matches epics.md's design intent); confirming *which* org, or any other org
     metadata, is not, and is a distinct information-disclosure risk this AC exists to foreclose.
   - 9b. Response shape must be structurally identical on hit vs. miss (same JSON keys either way,
     only values differ) — this story does **not** require constant-time DB-query latency (unlike
     Story 14.3's state-validation timing-side-channel fix, which protected a genuine
     credential/session oracle); this endpoint only ever discloses org-level SSO configuration, not
     a specific account's existence, so latency-based confirmation is an accepted, documented
     non-goal, not a silently-missed hardening item.

10. **Migration compatibility.** The `org_sso_domains` migration must run cleanly against the
    existing dev/CI Postgres alongside all prior migrations (0001–0052) with zero data loss; the
    table starts empty (no backfill needed — no prior story ever wrote to it). Idempotency is
    N/A (pure `CREATE TABLE`, no data-mutating step) but `check-migration-compatibility` and
    `check-rls` must both pass.

11. **Double-submit guard.** The "Continue" button (and, separately, the SSO step's own submit
    action) must be disabled/no-op while a request is in flight — a double-click or rapid re-submit
    must not fire two concurrent domain-lookup calls (which, combined with AC-8's race, could apply
    a stale result) or two concurrent `/sso/start` calls (each mints a fresh, single-use state
    cookie per Story 14.3 — two in flight is wasteful, not unsafe, but still worth a single
    disabled-while-pending guard consistent with `LoginForm`'s existing `isSubmitting` pattern).

---

## Tasks / Subtasks

- [ ] **Task 1 — `org_sso_domains` schema + migration** (AC: 1, 5, 10)
  - [ ] 1.1 Add `packages/db/src/schema/org-sso-domains.ts`: `id` (uuid pk), `org_id` (uuid FK →
    `organizations.id`, cascade delete), `domain` (text, store lowercased/normalized — decide
    normalize-on-write vs. normalize-on-read, document the choice), `provider_name` (text),
    `created_at`. Unique index on `domain` alone (a domain can only route to one org/provider —
    confirm this against epics.md's singular-mapping framing; if ambiguous, treat "one org per
    domain" as the safe default and document as a judgment call).
  - [ ] 1.2 Schema test following `external-identities.test.ts`'s pattern (RLS-inclusion assertion:
    `EXCLUDED_TABLES.has('org_sso_domains')` must be `false`, unlike `sso_login_states`).
  - [ ] 1.3 Migration (next sequential number — check `packages/db/src/migrations/meta/_journal.json`
    for the actual next-free slot; 0052 is the last one landed as of this story's creation).
    Enable RLS with the standard `NULLIF(current_setting('app.current_org_id', true), '')::uuid`
    policy, matching `external_identities`'s pattern exactly.
  - [ ] 1.4 Export from `packages/db/src/schema/index.ts`.

- [ ] **Task 2 — Domain-lookup endpoint** (AC: 1, 2, 3, 5, 6, 9)
  - [ ] 2.1 New route, e.g. `POST /api/v1/auth/sso/domain-lookup` (or a name consistent with the
    `sso-routes.ts` file's existing `/start`, `/callback` naming — pick one and register alongside
    them), accepting `{ email: string }`, returning `{ ssoRequired: boolean, providerName?: string }`.
    Never a 4xx/5xx for a malformed/no-mapping case — always 200 with `ssoRequired: false` unless
    the request body itself fails schema validation.
  - [ ] 2.2 Extract the domain from the email server-side (after `@`, lowercased) — do not trust a
    client-supplied domain field, only the email.
  - [ ] 2.3 Query `org_sso_domains` via `getAdminDb()` (pre-auth exception, AC-5) by exact
    normalized domain match.
  - [ ] 2.4 Cross-check the matched row's `provider_name` against the live `authStrategies` list
    (`findAuthStrategy()` from `strategies.ts`) — if not currently registered, respond
    `{ ssoRequired: false }` (AC-1b fail-open).
  - [ ] 2.5 Wrap the DB call in a try/catch; any error resolves to `{ ssoRequired: false }`, never
    a 500 (AC-3b).
  - [ ] 2.6 Register the route with `requireAuth: false`, `writeAuditEvent: false`,
    `bodyLimit: 4096` (matching `/login`'s convention), and a rate-limit config matching
    `/sso/start`'s (`{ max: 20, timeWindowMs: 15 * 60 * 1000 }` or reuse that exact constant if
    extracted).
  - [ ] 2.6a Response body is exactly `{ ssoRequired: boolean, providerName?: string }` — never the
    org id/name (AC-9a). Structurally identical shape on hit vs. miss (AC-9b).
  - [ ] 2.7 Add the new route to `apps/api/src/lib/route-exemptions.ts` (`PUBLIC_ROUTE_EXEMPTIONS`
    + `ROUTE_ACTION_CLASSIFICATIONS`) — `route-audit.test.ts` will fail otherwise, per Story 14.3's
    own precedent.
  - [ ] 2.8 OpenAPI schema for the new route; regenerate `openapi.json`.

- [ ] **Task 3 — Two-step web login form** (AC: 1, 2, 3, 4, 7, 8)
  - [ ] 3.1 Restructure `LoginForm.svelte` (or extract a new `EmailStep`/`SsoStep` sub-component —
    implementation-time judgment call) into: Step A (email only + Continue), Step B (either the
    existing password field, unchanged, OR a new SSO credential-exchange step).
  - [ ] 3.2 On Continue, call the new domain-lookup endpoint via a new `apps/web/src/lib/api/auth.ts`
    function (e.g. `lookupSsoDomain(fetch, email)`), matching this file's existing
    `apiFetch`/error-handling conventions.
  - [ ] 3.3 Any non-2xx, thrown, or network-level failure from that call must resolve to showing
    the password field (AC-3, AC-3a) — never block the user or show a raw error for this step.
  - [ ] 3.4 Guard against the out-of-order-response race (AC-8): key the async lookup to the email
    value at call time, and ignore/discard the response if the current input has since changed.
  - [ ] 3.5 If `ssoRequired`, render an SSO step that: calls `POST /sso/start/:providerName`, then
    collects whatever credential the flow needs and calls `POST /sso/callback/:providerName`,
    reusing the exact request/response contract Story 14.3's backend already ships (see Dev Notes —
    no hosted external-IdP-redirect page exists yet; a generic credential-input UI is the pragmatic,
    buildable-today choice, not a design regression).
  - [ ] 3.6 On SSO success, follow the same post-login navigation as local login (`getCurrentUser()`
    + `goto(nextPath)` — reuse `LoginForm`'s existing `nextPath` prop, do not invent a second
    redirect mechanism).
  - [ ] 3.7 Provide a "use a different email" / back affordance from the SSO step to Step A (so a
    user who fat-fingered their email isn't stuck).
  - [ ] 3.8 Update `apps/web/src/routes/(auth)/login/+page.svelte` only if the top-level page
    contract changes (props/messages) — the page itself likely needs no changes beyond what
    `LoginForm` already receives.
  - [ ] 3.9 Disable the "Continue" button (and the SSO step's own submit control) while its
    request is in flight, matching `LoginForm`'s existing `isSubmitting` guard pattern — prevents
    double-fired domain-lookup or `/sso/start` calls on a double-click/rapid re-submit (AC-11).

- [ ] **Task 4 — Tests** (AC: all)
  - [ ] 4.1 API: `org_sso_domains` schema test, RLS isolation test, domain-lookup route unit tests
    covering every AC-1/1a/1b/1c/2/2a/3a/3b sub-case, rate-limit test.
  - [ ] 4.2 Web: `LoginForm.test.ts` extended (or a new component test file) covering the two-step
    flow, fail-open paths (3, 3a), the out-of-order race (8), and SSO-step happy path.
  - [ ] 4.3 e2e: extend or add to `apps/web/e2e/journeys/j6-sso-login.spec.ts` (or a new journey
    file) to drive the actual login screen end-to-end using the mock SSO extension fixture
    (`test.mock-sso-extension`), seeding an `org_sso_domains` row for a fixture domain — this closes
    the gap that j6's own header comment explicitly left open ("Story 14.4 owns that").
  - [ ] 4.4 Manually verify in a running Docker stack via Chrome: type an SSO-mapped email → SSO
    step appears, no password field; type a non-mapped email → password field renders; simulate a
    lookup failure (e.g. stop the DB briefly or use dev tools to block the request) → password
    field still renders.

## Dev Notes

- **`org_sso_domains` does not exist yet.** Story 14.3 shipped `external_identities` and
  `sso_login_states` only (migration 0052) — it explicitly deferred `org_sso_domains` to this story
  (see that story's References: "confirms `org_sso_domains`/email-first UI is 14.4's scope, not
  this story's"). This story owns the table's schema, migration, and RLS from scratch.
- **No admin UI exists to create `org_sso_domains` rows.** No story in epics.md builds a
  management UI for this table — same situation Story 14.2 had for `VAULT_EXTENSIONS_PACKAGE`
  (env-var only, no admin UI). For this story, rows are seeded directly (ops/manual SQL, or extend
  `apps/api/src/scripts/sso-qa.ts` if convenient for e2e/manual QA) — **do not** build a
  create/edit UI for this table; that is out of scope and should be flagged as a gap for a future
  story if the user wants one, not silently built or silently ignored.
- **Public-email-domain hazard (pre-mortem finding, no admin UI to guard against it yet).**
  Because there is no admin UI or validation layer for this table yet, nothing today stops an
  operator from mistakenly (or an OrgAdmin from maliciously, if this ever becomes self-service)
  mapping a shared public email domain — `gmail.com`, `outlook.com`, etc. — to an org's SSO
  strategy. Since the unique index is on `domain` alone (one org per domain, Task 1.1), that single
  bad row would silently force *every* user across *every* org whose email happens to end in that
  domain into one org's SSO flow, breaking local login for everyone else who shares it. This
  story does not need to build domain-ownership verification (that's a future admin-UI story's
  job), but must not make the failure silent: add a code comment on the migration/schema noting
  this operational hazard explicitly, so the eventual admin-UI story inherits the warning instead
  of rediscovering it.
- **No hosted external-IdP-redirect mechanism exists in this codebase.** Story 14.3's
  `AuthStrategy.onAuthenticate(credential: string)` contract is a synchronous credential-string
  exchange (see `packages/extension-api/src/hooks/auth-strategy.ts`), not a browser redirect to an
  external login page — the mock extension (`fixtures/mock-sso-extension`) simply maps a fixed
  credential string to a canned `AuthResult`. epics.md's AC language ("redirected into that org's
  SSO flow") should be read against this existing contract, not a literal OAuth/SAML redirect that
  doesn't exist yet. The pragmatic, buildable-now interpretation: the "SSO flow" is a UI step that
  calls `POST /start` then `POST /callback` with a credential the user supplies in-page — a real
  future OIDC/SAML extension would need a new Extension API hook (e.g. an `authorizationUrl`/
  redirect capability) to support a true hosted-IdP redirect, which is explicitly **not** in this
  story's scope. Flag this gap in Completion Notes rather than silently inventing a redirect
  mechanism the backend doesn't support.
- **`UIPanel` hook exists but is unwired.** `packages/extension-api/src/hooks/ui-panel.ts` defines
  a `UIPanel` hook type, but no consumer in `apps/web` renders extension-supplied HTML anywhere
  (confirmed via search — 14.2 only wired extension *status*, not UI panels). Do not attempt to use
  `UIPanel` for the SSO step's UI in this story; that would be new, unscoped integration work.
- **Fail-open is the dominant theme across every AC.** Every failure mode (DB error, no mapping,
  malformed email, unregistered provider, network failure) must converge on "show the password
  field" — mirrors the Story 14.2 extension-loader fail-safe philosophy and Story 14.3's own
  "local login remains fully reachable regardless of the external strategy's failure state"
  invariant. Do not let any lookup failure produce a stuck, hung, or broken login screen.
- **RLS/pre-auth tension, resolved per existing precedent.** `org_sso_domains` is genuinely
  org-scoped data (an OrgAdmin manages their own org's domain mappings) so it keeps RLS enabled —
  but the *lookup* itself happens before any org/session context exists, so that one call goes
  through `getAdminDb()`, exactly like Story 14.3's `external_identities`/`project_invitations`
  pre-auth lookups. Do not disable RLS on this table to work around the pre-auth problem (that was
  the correct call for `sso_login_states`, which truly has no org concept even after auth — it does
  not apply here).
- **TDD red-green mandatory** (AGENTS.md) — write the failing test first for every task, confirm it
  fails for the expected reason, then implement.
- **Testing standards:** repo coverage bar 80/80/80/80 (statements/branches/functions/lines).
  `apps/web` component tests use the existing `@testing-library/svelte`-style conventions already
  present in `LoginForm.test.ts`/`MfaLoginForm.test.ts` — follow those, do not introduce a new
  testing approach for this story.
- **Domain matching must be exact-label, not substring.** `acme.com` must not match
  `notacme.com` or `acme.company.com` — compare the full string after `@`, lowercased, not a
  `.includes()`/regex substring check (AC-1a/1c). Decide and document whether normalization
  happens on write (recommended — keeps the lookup a trivial indexed equality query) or on read.

### Project Structure Notes

New files (proposed):
- `packages/db/src/schema/org-sso-domains.ts` (+ schema test) + migration
- `apps/web/e2e/journeys/j6-sso-login.spec.ts` extended, or a new journey file for the UI-driven path
- Possibly a new `apps/web/src/lib/components/auth/SsoLoginStep.svelte` (or similar) if `LoginForm.svelte`
  becomes unwieldy as a single file — implementation-time judgment call, follow existing component
  granularity in `apps/web/src/lib/components/auth/`

Modified files:
- `apps/api/src/modules/auth/sso-routes.ts` (or a new `domain-lookup-routes.ts` alongside it) — new
  domain-lookup route
- `apps/api/src/lib/route-exemptions.ts` — new public-route + action-classification entry
- `apps/web/src/lib/api/auth.ts` (+ test) — new `lookupSsoDomain()` client function
- `apps/web/src/lib/components/auth/LoginForm.svelte` (+ test) — two-step flow
- `apps/web/src/lib/components/auth/form-model.ts` (+ test) — any new pure helper functions for the
  two-step flow (e.g. domain extraction, if done client-side for display purposes only — the
  server remains the source of truth per Task 2.2)
- `packages/db/src/schema/index.ts` (export new schema)
- `packages/db/src/check-rls-coverage.ts` — **not** expected to need a new exclusion entry, since
  `org_sso_domains` keeps RLS enabled (unlike `sso_login_states`); confirm during implementation.

No `packages/extension-api` changes — this story consumes the already-published `AuthStrategy`
surface (`findAuthStrategy()`) read-only; it does not add a redirect/hosted-UI hook (see Dev Notes).

### Previous Story Intelligence (from 14-3)

- 14-3's `getAdminDb()` pre-auth-lookup exception (judgment call #3) is the direct precedent for
  this story's domain-lookup query — reuse the pattern, don't re-derive it.
- 14-3's `findAuthStrategy(providerName)` (in `strategies.ts`) is the exact function this story's
  route must call to cross-check a stored `provider_name` against what's actually registered
  (AC-1b) — do not duplicate `authStrategies` traversal logic.
- 14-3's rate-limit conventions (`rateLimit: { max: 20, timeWindowMs: 15 * 60 * 1000 }`,
  independent keys per route) are the direct template for this story's new endpoint (AC-9).
- 14-3 registered its two new public routes in `route-exemptions.ts`'s `PUBLIC_ROUTE_EXEMPTIONS` +
  `ROUTE_ACTION_CLASSIFICATIONS` — `route-audit.test.ts` will fail on this story's new route until
  the same is done (Task 2.7).
- 14-3's own Dev Notes flagged "no `apps/web` changes — the login UI is explicitly Story 14.4's
  scope, not silently dropped" — this story is the fulfillment of that flag; `j6-sso-login.spec.ts`'s
  header comment says the same thing from the e2e side and should be revisited/extended here
  (Task 4.3), not left as a permanent placeholder.
- 14-3's git commit style (`feat(auth): ... (14-3)`) — follow the same convention:
  `feat(auth): route login to sso by email domain (14-4)`.
- 14-3's Completion Notes judgment-call format (numbered list, each with rationale) is the
  established convention for documenting this story's own judgment calls (the redirect-mechanism
  gap, the domain-uniqueness assumption, etc.) — follow it.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 14.4: Route Login to SSO by Email Domain] — literal AC text (4 Given/When/Then blocks), this story's canonical requirement source
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 14: Extension Architecture & Pluggable Authentication] — epic framing, security-critical-not-optional-hardening callout (email-first login screen with domain-based SSO routing)
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security] (~L386-397) — "core never special-cases the extension" invariant, email-first login screen note, `org_sso_domains` lookup description
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture] (~L1058-1061) — `external_identities`/`org_sso_domains` table summaries
- [Source: _bmad-output/implementation-artifacts/14-3-authenticate-via-a-registered-external-provider-strategy.md] — prior story; `authStrategies`/`findAuthStrategy()`, `getAdminDb()` pre-auth exception, rate-limit conventions, `route-exemptions.ts` precedent, explicit "UI is 14.4's scope" flag
- [Source: apps/web/e2e/journeys/j6-sso-login.spec.ts] (header comment) — confirms no login-screen UI exists yet and explicitly defers it to this story
- Codebase (read directly during story creation): `apps/api/src/modules/auth/sso-routes.ts` (`handleStart`/`handleCallback`, rate-limit shape, `secureRoute` usage), `apps/api/src/modules/auth/strategies.ts` (`authStrategies`, `findAuthStrategy`), `apps/api/src/modules/auth/routes.ts` (`/login` route pattern, `normalizeEmailBodyForRoute`), `apps/api/src/lib/route-exemptions.ts` (public-route registration pattern), `packages/db/src/schema/external-identities.ts` (org-scoped RLS schema pattern to mirror), `packages/db/src/migrations/0052_external_identities_and_sso_login_states.sql` (RLS policy SQL pattern), `packages/db/src/migrations/meta/_journal.json` (next migration number), `packages/extension-api/src/hooks/auth-strategy.ts` and `ui-panel.ts` (confirms credential-string model, confirms `UIPanel` unwired), `apps/web/src/routes/(auth)/login/+page.svelte`, `apps/web/src/lib/components/auth/LoginForm.svelte`, `form-model.ts`, `MfaLoginForm.svelte` (existing two-step-after-MFA-challenge pattern to model the new SSO step on), `apps/web/src/lib/api/auth.ts` and `client.ts` (`apiFetch`, `ApiClientError` conventions)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- TDD process: [Source: AGENTS.md#Development Story Implementation]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
