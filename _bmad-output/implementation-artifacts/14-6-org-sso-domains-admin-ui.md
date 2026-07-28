# Story 14.6: Org SSO Domains Admin UI + Write API

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an OrgAdmin whose org uses SSO,
I want a real admin page where I can create, edit, and remove `org_sso_domains` mappings (which email domain routes to which SSO provider),
so that I don't have to ask an operator to hand-run SQL every time we onboard a new domain, fix a typo, or offboard a provider.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes — a real, reachable page at `(app)/settings/sso-domains`, linked from the Settings index, gated to org role `admin` (see Dev Notes RBAC judgment call) |
| **Linked UI story** (if API-only) | N/A — this story ships both the write API and its UI together |
| **Honest placeholder AC** (if UI deferred) | N/A — see AC-2's empty-list state |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (OrgAdmin, acme.com's Project Vault org):**
1. Riley's org registered an SSO extension (Story 14.1/14.2) and wants `acme.com` email addresses routed into it. Today Riley has to ask an operator to hand-run SQL against `org_sso_domains` — the exact gap this story closes.
2. Riley opens **Settings**, sees a new **SSO Domains** row alongside Users/Security/Audit/Language/Extensions, and clicks through to `/settings/sso-domains`.
3. Riley sees a table of the org's current domain-to-provider mappings (empty on first visit — an honest "No SSO domains configured yet" state, not a spinner or a blank gap).
4. Riley clicks **Add domain**, types `acme.com` and picks `test.mock-sso-extension` from a list of currently-registered providers (Story 14.3's `authStrategies`), and submits. The row appears immediately (no full page reload — `invalidateAll()` pattern, matching `/settings/users`).
5. If Riley mistypes a domain that's already publicly-shared (`gmail.com`) or already claimed by another org, the form shows a specific, honest error inline — never a generic 500, never silent success.
6. Riley edits an existing row's provider (e.g. the org migrated to a different SSO extension) via an inline edit control, and removes a stale row via a **Remove** button with a confirm dialog, mirroring `/settings/users`'s `onRemoveOrgUser` confirm pattern.
7. If Riley is `owner`, `member`, or `viewer` (not `admin` — see RBAC judgment call in Dev Notes), the page still loads (no crash) but shows "You need the Admin role to manage SSO domains" instead of any data or forms.
8. If Riley is not logged in, the normal `requireUser` redirect to `/login` applies, same as every other `(app)/settings/*` page.

## Acceptance Criteria

1. **List — org-scoped, RLS-enforced, honest empty state.**
   **Given** an authenticated `admin`-role user whose org has zero or more `org_sso_domains` rows,
   **when** they load `/settings/sso-domains`,
   **then** the page calls `GET /api/v1/org/sso-domains` (new authenticated, org-scoped route — **not** `getAdminDb()`; unlike the pre-auth `domain-lookup-routes.ts`, this route runs inside `secureRoute`'s standard RLS-scoped transaction, so a Postgres-level cross-org query is structurally impossible, not just filtered client-side) and renders one row per mapping (`domain`, `providerName`, `createdAt`).

   **And** if the org has zero rows, the page renders an explicit "No SSO domains configured yet" empty state — not a blank table, not a spinner that never resolves.

   **Edge case — cross-org isolation.** A dedicated test proves that a second org's `admin` user, calling the same endpoint, never sees org A's rows, using this repo's standard `withOrg(orgB, ...)` / RLS-isolation test pattern (`packages/db/src/__tests__/rls-isolation.test.ts`'s existing `org_sso_domains` test is read-only against seed data; this story adds a write-path isolation test alongside it).

2. **Create — validated, provider-checked, public-domain-blocked.**
   **Given** an `admin`-role user submits a new mapping via `POST /api/v1/org/sso-domains` with `{ domain, providerName }`,
   **when** the request is well-formed,
   **then** the server: (a) normalizes `domain` to lowercase **and strips a single trailing FQDN dot if present** (`gmail.com.` is a valid absolute hostname for `gmail.com` and must not bypass the blocklist via this variant — normalize before every check below, matching the existing `org-sso-domains.ts` schema comment's documented convention), (b) rejects a domain that fails a strict hostname-label format check (no `@`, no leading/trailing dot post-normalization, no wildcard, no whitespace) with `422 { code: 'invalid_domain_format' }`, (c) rejects a domain on the built-in public-email-domain blocklist (`gmail.com`, `googlemail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `live.com`, `icloud.com`, `me.com`, `aol.com`, `protonmail.com`, `mail.com` — see Dev Notes) with `422 { code: 'public_domain_blocked' }` naming the specific reason, closing the operational hazard `org-sso-domains.ts`'s schema comment explicitly flagged as unguarded, (d) rejects a `providerName` that is not currently present in the live `authStrategies` list (via `findAuthStrategy()`) with `422 { code: 'provider_not_registered' }` — **this is a deliberate asymmetry from the pre-auth `domain-lookup-routes.ts`, which fails open/silent on an unregistered provider; this admin-facing write path fails loud and specific, because the caller is a trusted authenticated admin who benefits from honest feedback, not an anonymous pre-auth caller who must never learn about org SSO configuration state** (document this asymmetry explicitly in code comments to prevent a future reviewer "fixing" it into silent fail-open), (e) if `findAuthStrategy()` itself throws (e.g. the extension runtime is unloaded/crashed, distinct from "ran fine, provider just isn't registered") the route returns `503 { code: 'provider_check_unavailable' }`, **not** a `422` and **not** an unhandled `500` — a transient infra failure must not be presented to the admin as "you typed the wrong provider name," and (f) on success, inserts the row inside the request's RLS-scoped transaction (`org_id` set implicitly by RLS policy defaults / explicit `auth.orgId`, matching `organization-settings-routes.ts`'s pattern) and returns `201` with the created row.

   **Edge case — global uniqueness conflict, no cross-org disclosure.** **Given** `domain` is already claimed by *any* org (the unique index is global, per `org-sso-domains.ts`'s Task 1.1 comment — "one org per domain"), **when** a second org's admin tries to claim it, **then** the response is `409 { code: 'domain_already_mapped' }` with a generic "This domain is already mapped to an organization" message — **never** naming which org owns it (an authenticated admin from org B must not learn org A's identity or any metadata via this error path; this mirrors the pre-auth lookup route's AC-9a non-disclosure principle, just for a different caller).

   **Error-code contract.** All four codes above (`invalid_domain_format`, `public_domain_blocked`, `provider_not_registered`, `provider_check_unavailable`, `domain_already_mapped`) are part of this story's response contract, not just prose — Task 6's web-side "typed `ApiClientError` code-based error branches" bind to these exact strings; add them to `packages/shared/src/schemas/auth.ts`'s response schema or an adjacent constants export so both API and web import the same literal values instead of each hand-typing a copy.

3. **Edit — same validation rules as create, applies to an existing row.**
   **Given** an `admin`-role user submits `PATCH /api/v1/org/sso-domains/:id` with a new `domain` and/or `providerName`,
   **when** the row's `:id` belongs to the caller's own org (cross-org `:id` guess **must** 404, not 403 — do not confirm existence of another org's row, mirroring this codebase's existing cross-org-guess convention in `organization-settings-routes.ts`'s `ORG_NOT_FOUND` pattern),
   **then** the same domain-format, public-domain-blocklist, provider-registration, provider-check-availability, and global-uniqueness checks from AC-2 apply identically (same error codes, same status codes), and the response is `200` with the updated row.

   **Edge case.** Editing a row's `domain` to a value already claimed by a *different* row (including one belonging to the same org, though the unique index makes same-org self-collision impossible by construction) returns the same `409 { code: 'domain_already_mapped' }` as AC-2's create conflict, not a different message.

4. **Remove — hard delete, matches this table's existing no-soft-delete convention.**
   **Given** an `admin`-role user calls `DELETE /api/v1/org/sso-domains/:id` for a row in their own org,
   **when** the row exists,
   **then** it is hard-deleted (no `deleted_at`/soft-delete column exists on `org_sso_domains` — do not add one; this matches `organizations`/org-membership removal's existing hard-delete convention in `apps/api/src/modules/org/user-management.ts`) and the response is `200` with `{ id }` confirming the deletion. A cross-org `:id` guess returns `404`, same as AC-3.

   **Edge case — in-flight login race is out of scope but must not crash.** If a user is mid-login (has already resolved SSO via the pre-auth `domain-lookup-routes.ts`) when an admin deletes that domain's mapping in a concurrent request, the in-flight login's subsequent `/sso/start`/`/sso/callback` calls are unaffected by this story (they don't re-check `org_sso_domains`) — this AC only requires the delete itself not to throw or corrupt state; no new distributed-lock or in-flight-login-blocking mechanism is in scope.

5. **RBAC — admin manages, all other authenticated roles see a permission message, not a crash.**
   **Given** an authenticated user whose org role is `owner`, `member`, or `viewer`,
   **when** they call any of the four routes above or load `/settings/sso-domains`,
   **then** the server rejects with `403` (API) and the page renders "You need the Admin role to manage SSO domains" (web) instead of any data or form — **do not** call the list endpoint at all for a blocked role on the web side (mirror `/settings/extensions`'s AC-5 least-privilege pattern: avoid a guaranteed wasted round-trip).

   **Judgment call — `minimumRole: 'admin'` (rank-based, includes `owner`), not the extensions-status page's exact-match `allowedRoles: ['admin']`.** Story 14.2's extensions-status route deliberately excluded `owner` (documented Dev Notes RBAC call, specific to that route). This story instead follows `organization-settings-routes.ts`'s pattern (org-level configuration mutation, where `owner` naturally outranks `admin`) — use `secureRoute`'s `minimumRole: 'admin'` rank check, which admits both `admin` and `owner`. This is a deliberate divergence from 14-5's precedent; flag it in code review if this reading of the two precedents is wrong, but do not silently pick one without documenting the choice (same "resolve now, flag for review" pattern 14-2/14-4/14-5 all used).

6. **Auth/session — standard `requireUser`/`requireAuth` gates, no new mechanism.**
   **Given** an unauthenticated visitor,
   **when** they request `/settings/sso-domains` or any of the four API routes directly,
   **then** the page redirects to `/login` (`requireUser(locals)`, identical to every other `(app)/settings/*` page) and the API routes return `401` via `secureRoute`'s standard `requireAuth: true` gate — no bespoke auth mechanism.

   **MFA.** All four mutation-adjacent routes (list/create/update/delete) require `requireMfa: true`, matching the `DELETE /api/v1/org/users/:userId` precedent for admin-mutation routes in `apps/api/src/modules/org/routes.ts` — an `admin`-role user who hasn't enrolled in MFA gets `403 { code: 'mfa_required' }` on every route including the read-only list, since even seeing the org's SSO domain configuration is sensitive enough to warrant the same gate as the mutations (deliberately stricter than `/settings/extensions`'s read-only status page, which has no MFA requirement inherited from Story 14.2 — this story's routes are new and can set their own bar; MFA-gating the list too keeps all four routes' auth requirements uniform and simple to reason about, rather than only gating the three mutating ones).

7. **Audit logging — every mutation writes a fail-closed audit row; the list route does not.**
   **Given** create/edit/remove succeed,
   **when** the response is returned,
   **then** an audit row was written **in the same transaction** via `writeHumanAuditEntryOrFailClosed(secureCtx.tx, {...})` (the `apps/api/src/lib/audit-or-fail-closed.js` helper `organization-settings-routes.ts`/`org/routes.ts` both use) — set `security.writeAuditEvent: false` on these three routes and call the helper inline (route-audit.test.ts's `assertAuditedActionOptOutsAreJustified` check statically requires this literal call to appear). Event types: `org_sso_domain.created` / `org_sso_domain.updated` / `org_sso_domain.deleted` (grep `apps/api/src/modules/org/routes.ts` and `organization-settings-routes.ts` during implementation for this codebase's exact live naming convention for `eventType` strings before finalizing these three — match the established pattern precisely, don't invent a new one). Payload must include, at minimum, the mapping's `id`, `domain`, and `providerName` (post-change values for create/update; pre-delete values for delete) plus whatever actor/org fields `writeHumanAuditEntryOrFailClosed`'s existing call sites in `organization-settings-routes.ts`/`org/routes.ts` already populate automatically from `secureCtx` — do not under-populate relative to those sibling calls.

   **Fail-closed proof.** A dedicated test proves that if the audit write itself throws, the whole transaction (including the mutation) rolls back and the client receives `503 audit_write_failed` — not a partial success where the row is created/edited/deleted but unaudited. Mirror the existing fail-closed test pattern already covering other `secureRoute` mutation routes in this codebase.

   **The list route (`GET`) writes no audit event** — a read of SSO domain configuration by the org's own admin is not a security-relevant *action* in the same sense the pre-auth lookup route's AC-6 already established for a different reason (there, it's because the disclosure is minimal; here, it's because it's the org's own admin reading their own org's own config) — register it in `ROUTE_ACTION_CLASSIFICATIONS` as `action: 'read'` with an `auditOmissionReason`, not `'sensitive-read'`.

8. **Concurrent access — simultaneous create/edit does not corrupt state or 500.**
   **Given** two concurrent requests attempt to create the same `domain` (e.g. two admins in different orgs racing, or a double-submit from the same admin before AC-11-style debounce),
   **when** both reach the database,
   **then** the unique-index constraint violation is caught and translated to the `409` from AC-2's edge case — **never** an unhandled `500` or a raw Postgres constraint-violation message leaking to the client. Add a dedicated test simulating two concurrent inserts (or an inline `try/catch` around the specific Postgres unique-violation error code, matching this codebase's existing constraint-violation-handling convention — grep other `secureRoute` mutation handlers for the precedent before inventing a new error-code check).

   **Web-side double-submit guard.** The create/edit forms disable their submit control while a request is in flight, matching `/settings/users`'s `busyKey` pattern — prevents a double-click from firing two concurrent creates for the same domain from the same admin.

9. **Rate limiting.** All four routes are authenticated (not public) but still carry an explicit `rateLimit` config, matching this codebase's convention that authenticated admin-mutation routes tighten (not omit) the default `{ max: 60, timeWindowMs: 60_000 }` — use `{ max: 20, timeWindowMs: 60_000 }` for create/update/delete (matching `DELETE /api/v1/org/users/:userId`'s convention for destructive admin actions) and the default (or a slightly higher explicit `{ max: 60, ... }`) for the list route.

10. **Migration compatibility — no schema change required.** `org_sso_domains` (migration `0053`) already has every column this story's CRUD needs (`id`, `org_id`, `domain`, `provider_name`, `created_at`). This story adds **no new migration** — confirm during implementation that no `updated_at` column is needed for the edit path (the response can simply return the row's current `createdAt` unchanged; there is no "last edited at" requirement in any AC above) and that the existing hard-delete convention (no `deleted_at`) is sufficient (AC-4). If implementation reveals a genuine need for a new column, stop and treat it as a scope addition requiring its own migration (next sequential number after `0057`, per `packages/db/src/migrations/meta/_journal.json`), not a silent schema change.

11. **`check-rls-coverage` / RLS policy — unchanged, still enforced.** `org_sso_domains` is not in `check-rls-coverage.ts`'s `EXCLUDED_TABLES` allowlist today and must not be added to it by this story — every new route in this story goes through `secureRoute`'s standard RLS-scoped transaction (`setRlsOrgContext`), never `getAdminDb()` (that remains exclusively the pre-auth `domain-lookup-routes.ts`'s pattern, for a documented, different reason).

12. **Route registration and thin-routes compliance.** All four new routes are registered via `secureRoute()` in a new sibling file (not inline DB logic in the routes file itself — see Dev Notes file structure) and appear in `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` (never `PUBLIC_ROUTE_EXEMPTIONS` — none of these routes are unauthenticated). `route-audit.test.ts` must pass with zero new exceptions.

## Tasks / Subtasks

- [ ] Task 1: Shared request/response schemas (AC: 1, 2, 3, 4)
  - [ ] Add `CreateOrgSsoDomainRequestSchema`, `UpdateOrgSsoDomainRequestSchema`, `OrgSsoDomainResponseSchema`, `OrgSsoDomainListResponseSchema`, `OrgSsoDomainParamsSchema` to `packages/shared/src/schemas/auth.ts`, co-located with the existing `DomainLookupRequestSchema`/`DomainLookupResponseSchema` (same feature area), following that file's `.meta({ id: '...' })` + paired `z.infer` type-export convention.
  - [ ] Domain field: `z.string().min(1).max(253)` plus a `.refine()` for the strict hostname-label format (no `@`, no leading/trailing `.` post-normalization, no whitespace, no wildcard `*`) — write this as a small named helper (e.g. `isValidDomainLabel()`) reusable by both the schema refine and the service-layer normalization, not duplicated logic. Normalization (lowercase + strip one trailing FQDN dot) must run **before** this refine and before the blocklist check (AC-2).
  - [ ] Add a shared error-code constant export (e.g. `ORG_SSO_DOMAIN_ERROR_CODES`) covering `invalid_domain_format`, `public_domain_blocked`, `provider_not_registered`, `provider_check_unavailable`, `domain_already_mapped` — imported by both the API route layer (Task 3) and the web client's error-branch logic (Task 6), so the literal strings live in exactly one place (AC-2/AC-3's error-code contract).

- [ ] Task 2: Service-layer helper — validation, public-domain blocklist, CRUD (AC: 1, 2, 3, 4, 8, 10, 11)
  - [ ] New `apps/api/src/modules/auth/org-sso-domains-service.ts` (sibling to `domain-lookup-routes.ts`, keeps `routes.ts`-equivalent thin per AC-12): `listOrgSsoDomains(tx, orgId)`, `createOrgSsoDomain(tx, orgId, {domain, providerName})`, `updateOrgSsoDomain(tx, orgId, id, {domain?, providerName?})`, `deleteOrgSsoDomain(tx, orgId, id)`.
  - [ ] Public-domain blocklist as a `const PUBLIC_EMAIL_DOMAINS = new Set([...])` (see AC-2 list) with a code comment noting it is a best-effort, non-exhaustive guard against the operational hazard `org-sso-domains.ts`'s schema comment flagged — not a claimed-complete security control.
  - [ ] Provider-registration check via `findAuthStrategy()` (reuse from `./strategies.js`, same import `domain-lookup-routes.ts` already uses) — wrap the call in `try/catch`: a thrown error (extension runtime unavailable) maps to `provider_check_unavailable`/`503`, distinct from a clean "not found" result mapping to `provider_not_registered`/`422` (AC-2 failure-mode requirement — do not conflate the two).
  - [ ] Catch Postgres unique-violation errors (grep this codebase's existing constraint-violation handling convention first) and translate to a typed "conflict" result (`domain_already_mapped`) the route layer turns into `409` — never let a raw DB error reach the client (AC-2/AC-8).
  - [ ] All queries scoped through the caller's `secureCtx.tx` (RLS-scoped) — no `getAdminDb()` anywhere in this file.

- [ ] Task 3: API routes (AC: 1, 2, 3, 4, 5, 6, 7, 9, 12)
  - [ ] New `apps/api/src/modules/auth/org-sso-domains-routes.ts`: `GET /api/v1/org/sso-domains`, `POST /api/v1/org/sso-domains`, `PATCH /api/v1/org/sso-domains/:id`, `DELETE /api/v1/org/sso-domains/:id`, each a thin `secureRoute()` call delegating to Task 2's service functions — mirror `organization-settings-routes.ts`'s and `org/routes.ts`'s thin-handler shape exactly.
  - [ ] `security: { minimumRole: 'admin', requireMfa: true, writeAuditEvent: false, rateLimit: {...} }` per AC-5/AC-6/AC-9 (list route: `writeAuditEvent` can stay default/omitted since it's non-mutating — confirm `secureRoute`'s default only auto-audits mutating methods).
  - [ ] Inline `writeHumanAuditEntryOrFailClosed(secureCtx.tx, {...})` calls on create/update/delete, event types per AC-7 (verify exact naming convention against existing calls before finalizing).
  - [ ] Register in `apps/api/src/app.ts` alongside `domainLookupRoutes`.
  - [ ] Add all four routes to `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` (list: `action: 'read'` + `auditOmissionReason`; create/update/delete: `action: 'mutation'` or `'security-action'` — given the SSO-hijack operational hazard this table's schema comment already documents, lean `'security-action'` for create/update, consistent with how this codebase classifies other security-config mutations; confirm against an existing `'security-action'` example during implementation).
  - [ ] Regenerate `packages/shared/openapi.json` (`api:generate-spec` task).

- [ ] Task 4: Web API client (AC: 1, 2, 3, 4)
  - [ ] New `apps/web/src/lib/api/org-sso-domains.ts` (+ `.test.ts`): `listOrgSsoDomains(fetchFn)`, `createOrgSsoDomain(fetchFn, {domain, providerName})`, `updateOrgSsoDomain(fetchFn, id, {domain?, providerName?})`, `deleteOrgSsoDomain(fetchFn, id)` — thin `apiFetch<T>()` wrappers, matching `org-users.ts`'s pattern exactly (see `removeOrgUser()` precedent).

- [ ] Task 5: `+page.server.ts` for `/settings/sso-domains` (AC: 1, 5, 6)
  - [ ] `requireUser(locals)` first, then branch on `orgRole`: `admin`/`owner` → call `listOrgSsoDomains()`, return `{ allowed: true, domains }`; else → `{ allowed: false, orgRole }` with **no** list call (AC-5 least-privilege, mirror `/settings/extensions`'s Task 3 pattern).
  - [ ] Handle `listOrgSsoDomains()` throwing (network/API failure) with an honest `errorMessage`, mirroring `/settings/audit`'s and `/settings/extensions`'s catch-and-degrade pattern — page must not crash to a raw SvelteKit error page.
  - [ ] Detect `ApiClientError` with `status === 403 && code === 'mfa_required'` and surface a distinct "Enable multi-factor authentication to manage SSO domains" message (per AC-6), linking to `/settings/security`, matching `/settings/extensions`'s equivalent case.

- [ ] Task 6: `+page.svelte` for `/settings/sso-domains` (AC: 1, 2, 3, 4, 5, 8)
  - [ ] Table of existing mappings (domain, provider, created date) + empty state (AC-1) + permission-denied state (AC-5) + MFA-required state (AC-6) + fetch-error state, following `/settings/extensions`'s multi-state conditional-rendering pattern and `/settings/users`'s table-with-row-actions structure.
  - [ ] "Add domain" form (domain text input + provider `<select>` populated from... **note:** there is currently no authenticated "list registered auth strategies" endpoint exposed to the web app — check whether one exists (`/settings/extensions`'s status endpoint returns only the *currently-loaded* single extension's manifest, not a full strategies list) before assuming a `<select>`; if none exists, a plain text input for `providerName` with inline validation-error display from the `422` response is an acceptable, honest fallback for this story — do not invent a new "list strategies" endpoint as unscoped extra work; document whichever choice is made as a judgment call.
  - [ ] Edit control per row (inline form or modal, implementation-time judgment call — follow existing `/settings/users` row-action patterns for consistency) and Remove button with `confirm()` dialog, matching `onRemoveOrgUser`'s exact pattern (`busyKey` disables the row's buttons mid-request, `invalidateAll()` on success, typed `ApiClientError` code-based error branches).
  - [ ] Client-side domain-format hint text (not a substitute for the server-side check) to reduce round-trips for obviously malformed input.

- [ ] Task 7: Settings index nav entry (AC: none directly — G3 navigation-truth requirement)
  - [ ] Add an **SSO Domains** `<li>` row to `apps/web/src/routes/(app)/settings/+page.svelte`, same markup shape as the existing rows, placed after Extensions (newest-addition-last convention 14-5 established).
  - [ ] Extend `settings-index-page.test.ts` with an assertion the new link/row renders and resolves to the correct href.

- [ ] Task 8: Tests (AC: all)
  - [ ] API: schema validation tests (domain format, trailing-FQDN-dot normalization, blocklist, provider-registration, each with its exact error `code` asserted) for create/update; a dedicated `findAuthStrategy()`-throws test asserting `503 { code: 'provider_check_unavailable' }` distinct from the `422 { code: 'provider_not_registered' }` not-found case; RBAC tests for `admin`/`owner` (allowed) vs. `member`/`viewer` (blocked) per AC-5's judgment call; MFA-required test; RLS cross-org isolation test for the new write paths (AC-1 edge case); global-uniqueness `409 { code: 'domain_already_mapped' }` test with no cross-org disclosure (AC-2/AC-3 edge cases); concurrent-create race test (AC-8); audit fail-closed test (AC-7) asserting the written payload's shape; rate-limit test.
  - [ ] Web: `org-sso-domains.test.ts` (client module); `sso-domains-page.server.test.ts` (load-function RBAC/error branches, mirroring `extensions-page.server.test.ts`'s structure); `sso-domains-page.test.ts` (component render states: list, empty, permission-denied, MFA-required, fetch-error, plus create/edit/remove interaction tests with mocked API calls).
  - [ ] `route-audit.test.ts` must pass with the four new routes correctly classified (AC-12) — run it explicitly, don't just rely on the full suite catching it.
  - [ ] `check-rls-coverage.test.ts` must still pass with `org_sso_domains` un-excluded (AC-11).
  - [ ] Full regression: `make ci` (or `pnpm turbo typecheck lint test` across `apps/api`, `apps/web`, `packages/db`, `packages/shared`) green.
  - [ ] Live-browser verification against a real `make docker-up` stack (this project's UI-story convention — see memory: verify UI in Chrome, don't rely on test suites alone): create a mapping, confirm it appears; attempt a public-domain mapping and confirm the specific error renders; edit a mapping; remove a mapping with the confirm dialog; verify the permission-denied state as a non-admin role; verify the MFA-required state if reachable in the dev stack.

## Dev Notes

### Judgment calls this story must resolve during implementation (flag, don't silently pick)

1. **RBAC: `minimumRole: 'admin'` (includes `owner`) vs. 14-5's exact-match `allowedRoles: ['admin']` (excludes `owner`).** See AC-5. This story follows `organization-settings-routes.ts`'s org-settings-mutation pattern rather than the extensions-status page's deliberately narrower, route-specific exclusion. If review disagrees, this is a one-line change (`minimumRole` → `allowedRoles: ['admin']`), not a structural rework.
2. **Provider `<select>` vs. free-text input** in the create/edit form (Task 6) — depends on whether an authenticated "list registered strategies" endpoint already exists or is worth adding. Default to free-text + server-validated error if no such endpoint exists; do not build a new list-strategies endpoint as unscoped work without flagging it first.
3. **Audit `eventType` string naming** (`org_sso_domain.created` etc., AC-7) — verbatim strings must match this codebase's live convention; grep existing calls before finalizing, don't invent a divergent format.
4. **`'mutation'` vs. `'security-action'` classification** in `route-exemptions.ts` (Task 3) for create/update — lean `'security-action'` given the domain-hijack hazard, but confirm against an existing precedent in the same file before finalizing.

### Public-domain blocklist — scope and limits

The blocklist (AC-2) is a **best-effort UX/safety guard**, not a claimed-complete security boundary — it closes the specific operational hazard `org-sso-domains.ts`'s schema comment already flagged (an operator/admin accidentally mapping a shared public domain and silently breaking local login for everyone on that domain across every org), but it is not exhaustive (many regional/corporate-adjacent free-mail providers exist beyond the ~11-entry starter list in AC-2). Do not over-promise in UI copy ("blocks all public domains") — phrase it as "this domain is on our list of shared public email providers and can't be mapped."

### Scope boundaries — what this story is NOT

- **No changes to the pre-auth `domain-lookup-routes.ts` route itself** — its fail-open, `getAdminDb()`-based, provider-existence-tolerant behavior is correct and unchanged by this story; this story adds a *separate*, authenticated, org-scoped, stricter-validation set of routes for the admin-management path. Do not merge or refactor the two into one file/route.
- **No new "list registered strategies" endpoint** unless Task 6's judgment call (see above) determines it's needed and the user/reviewer explicitly signs off — default to the free-text fallback.
- **No `updated_at`/`deleted_at` schema changes** (AC-10) unless implementation proves a genuine need — if so, stop and treat as a scope addition, not a silent migration.
- **No changes to `(app)/platform/*`** — same boundary 14-5 documented: this is an org-admin-role-gated feature (`(app)/settings/*`), not a platform-operator-gated one.

### Architecture compliance (must follow exactly)

- **RLS-scoped writes only** — every new route uses `secureRoute`'s automatic `setRlsOrgContext(tx, auth.orgId)` transaction; never `getAdminDb()` (that stays exclusive to the pre-auth lookup route, for a documented, different reason — see AC-11).
- **Fail-closed audit** — `writeHumanAuditEntryOrFailClosed` inside the same transaction as the mutation (AC-7); if it throws, the whole transaction rolls back.
- **Route placement** — `(app)/settings/sso-domains`, not `(app)/admin/`, matching the now-established real convention (`architecture.md`'s `(app)/admin/` references are stale/superseded, confirmed again by 14-5's own judgment call and unchanged since).
- **Thin routes file, logic in a sibling service file** (route-audit's static-scan requirement, AC-12) — `org-sso-domains-routes.ts` (thin) + `org-sso-domains-service.ts` (logic), mirroring `org/routes.ts` + `org/user-management.ts`.
- **No bare `fetch()` calls on the web side** — `apiFetch<T>()` for all four new client functions, matching every other `apps/web/src/lib/api/*.ts` module.
- **i18n scope** — per 14-5's precedent, sibling settings pages (`/settings/audit`, `/settings/users`, `/settings/extensions`) still use raw English strings; follow that same current convention for this story's new copy.

### Testing standards summary

- **TDD red-green mandatory** (AGENTS.md) — failing test first for every task, confirm it fails for the expected reason, then implement.
- Repo coverage bar: 80/80/80/80 (statements/branches/functions/lines) for all new files.
- RBAC negative-path coverage is not optional: `owner` (allowed, per this story's judgment call), `member`, `viewer` (blocked) each need their own dedicated test — do not collapse into one generic "non-admin" test, per the established convention from 14-2/14-5.
- Tenant-isolation coverage is not optional: a dedicated cross-org test for the new write paths, alongside the existing read-only RLS test for this table.
- Concurrent-access coverage: a dedicated test for the create-race → `409` path (AC-8), not just a unit test of the validation logic in isolation.
- Audit fail-closed coverage: a dedicated test proving a thrown audit write rolls back the mutation (AC-7).
- Live-browser verification required per this project's UI-story convention (memory: verify UI in Chrome, don't rely on test suites alone).

### Project Structure Notes

New files:
- `apps/api/src/modules/auth/org-sso-domains-service.ts` (+ test)
- `apps/api/src/modules/auth/org-sso-domains-routes.ts` (+ test)
- `apps/web/src/lib/api/org-sso-domains.ts` (+ test)
- `apps/web/src/routes/(app)/settings/sso-domains/+page.server.ts`
- `apps/web/src/routes/(app)/settings/sso-domains/+page.svelte`
- `apps/web/src/routes/(app)/settings/sso-domains/sso-domains-page.server.test.ts`
- `apps/web/src/routes/(app)/settings/sso-domains/sso-domains-page.test.ts`

Modified files:
- `packages/shared/src/schemas/auth.ts` (+ test if one exists) — new request/response schemas
- `packages/shared/openapi.json` (regenerated)
- `apps/api/src/app.ts` — register `orgSsoDomainsRoutes`
- `apps/api/src/lib/route-exemptions.ts` — four new `ROUTE_ACTION_CLASSIFICATIONS` entries
- `apps/web/src/routes/(app)/settings/+page.svelte` (+ `settings-index-page.test.ts`) — new SSO Domains nav row

No migration file — see AC-10. No changes to `domain-lookup-routes.ts`, `strategies.ts` (read-only `findAuthStrategy()` reuse), or `org-sso-domains.ts` schema file itself (its existing doc comment already anticipated and described this story).

### References

- [Source: _bmad-output/implementation-artifacts/14-5-extension-status-admin-page.md] — closest structural precedent (admin UI + API for a previously-unreachable capability); this story's own Product Surface Contract, multi-state page pattern, RBAC-judgment-call documentation style, and live-verification requirement all follow 14-5's shape, adapted from read-only to full CRUD.
- [Source: _bmad-output/implementation-artifacts/14-4-route-login-to-sso-by-email-domain.md] — origin of `org_sso_domains`'s schema/migration/RLS; its Dev Notes explicitly flagged "no admin UI exists yet... same situation Story 14.2 had" as the gap this story closes; its "public-email-domain hazard" pre-mortem note (schema file comment) is the direct source of this story's AC-2 blocklist requirement.
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-27.md] Finding 2 — the closure retro that discovered this untracked gap and scheduled this story.
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] row 100 — tracks this exact gap from 14.4 through this story's scheduling.
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Architecture] (~L1061) — one-line `org_sso_domains` purpose description; no CRUD/admin-UI-specific architecture guidance beyond that (confirmed during story creation — the `(app)/admin/` route table entries are stale/superseded, per 14-5's precedent).
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — G1-G4 rules this story exists to satisfy.
- Codebase (read directly during story creation): `packages/db/src/schema/org-sso-domains.ts` (schema + operational-hazard comment), `apps/api/src/modules/auth/domain-lookup-routes.ts` (pre-auth read path, `extractDomain()`, `findAuthStrategy()` usage), `apps/api/src/modules/org/routes.ts` + `user-management.ts` (thin-route + sibling-helper CRUD pattern, `writeHumanAuditEntryOrFailClosed` usage, rate-limit conventions), `apps/api/src/modules/org/organization-settings-routes.ts` + `organization-settings-schema.ts` (org-settings PATCH pattern, cross-org-guess `404` convention, `minimumRole` usage), `apps/api/src/lib/secure-route.ts` (full `SecureRouteRegistrationOptions` shape, default rate limit, audit-write transaction semantics), `apps/api/src/lib/route-exemptions.ts` (`ROUTE_ACTION_CLASSIFICATIONS` shape), `apps/api/src/__tests__/route-audit.test.ts` (thin-routes static scan), `packages/db/src/check-rls-coverage.ts` (`EXCLUDED_TABLES` — confirmed `org_sso_domains` stays out of it), `packages/db/src/migrations/meta/_journal.json` (confirmed last migration `0057`, none needed for this story), `packages/shared/src/schemas/auth.ts` (existing `DomainLookupRequestSchema`/`DomainLookupResponseSchema` convention), `apps/web/src/routes/(app)/settings/users/+page.server.ts` + `+page.svelte` + `apps/web/src/lib/api/org-users.ts` (client-fetch-mutation + confirm-dialog + `busyKey` + `invalidateAll()` pattern), `apps/web/src/routes/(app)/settings/extensions/*` (multi-state page structure, MFA-required error branch).
- TDD process: [Source: AGENTS.md#Development Story Implementation]

### Previous Story Intelligence (from 14-5 and 14-4)

**From 14-5 (closest structural precedent — read-only admin UI closing a flagged Product Surface Contract gap):**
- Route placement judgment: `(app)/settings/*`, not architecture.md's stale `(app)/admin/*` — reaffirmed again by this story, third time this exact judgment call has been made (14-5, now 14-6).
- Multi-state page pattern (loaded/empty/error/permission-denied/MFA-required) with distinct, non-color-only-differentiated copy for each state — this story adds two more states (create-conflict, validation-error) on top of 14-5's five.
- `busyKey`-style disable-while-pending guard and `invalidateAll()`-not-`goto()` refresh pattern — sourced here from `/settings/users` instead (14-5 didn't need it, being read-only; this story does, being full CRUD).
- Live-browser verification is not optional for UI stories in this project and has found real bugs in every prior Epic 14 UI story (14-4, 14-5) that unit/component tests alone missed — budget time for it, and document if genuinely blocked (as 14-5 partially was) rather than silently skipping.
- 14-5's own coverage numbers (100/100/100/100 and 100/93.75/100/100) show the 80/80/80/80 bar is comfortably achievable for a story this size when TDD is followed strictly.

**From 14-4 (origin of `org_sso_domains` itself):**
- The schema file's own doc comment is unusually detailed and already anticipates this exact story ("future admin-UI story's job") — read it in full before writing Task 2's service layer; it documents the normalize-on-write decision, the global-uniqueness assumption, and the public-domain hazard this story's AC-2 exists to close.
- `getAdminDb()` is a deliberate, narrow pre-auth exception for the *lookup* route only — this story's routes are authenticated and must not reuse that pattern (AC-11 explicitly guards against copying it by habit).
- 14-4's rate-limit and `bodyLimit` conventions for a new auth-module route are the direct template this story's routes should match (adjusted for authenticated-not-public per AC-9).

### Git Intelligence Summary (last 5 commits)

```
bba048c fix(sprint): sync 15-2 story file Status header with sprint-status.yaml
d17fbe2 chore(sprint): mark 15-2 as done
a2ef5e3 chore(sprint): epic-14 closure retro — flip epic-14 done, schedule 14-6 (#237)
d949172 feat(org): configure organization default locale for new users (15-2) (#236)
88b739b feat(rotation): same-value confirm, dependency field scoping, per-field values (13-5) (#235)
```

- `a2ef5e3` is the literal retro commit that scheduled this story — direct provenance.
- `d949172` (Story 15.2) is the most recent example of a new org-admin-scoped PATCH settings route + sibling schema file + inline fail-closed audit write (`organization-settings-routes.ts`/`organization-settings-schema.ts`) — structurally the closest recent template for this story's create/update routes, even though 15.2 shipped a single PATCH rather than full CRUD.
- No open PRs or in-flight branches touch `apps/api/src/modules/auth/` or `packages/db/src/schema/org-sso-domains.ts` as of this story's creation — no merge-conflict risk anticipated from concurrent work.

### Project Context Reference

- `AGENTS.md` — TDD red-green mandatory for all implementation; consult before starting Task 1.
- `_bmad-output/implementation-artifacts/product-surface-contract.md` — G1-G4 rules this story's Product Surface Contract section and Tasks 6-7 satisfy.
- Project memory (this session's operator context, not committed to the repo): `ADMIN_DATABASE_URL port trap` — `getAdminDb()` defaults to port 5432 independently of `DATABASE_URL`; irrelevant to this story's own routes (which deliberately avoid `getAdminDb()`) but worth knowing if debugging the *existing* `domain-lookup-routes.ts` alongside this work. `Verify UI in Chrome` — for this UI-relevant story, drive the running app in Chrome per Task 8's live-verification subtask, don't rely on the test suite alone. `Story file Status header must sync with sprint-status.yaml` — keep this story's `Status:` header and its `sprint-status.yaml` entry in lockstep at every transition.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via `bmad-create-story`.

### Debug Log References

### Completion Notes List

- Story created via `my-epic-retro` → `bmad-create-story` for backlog entry `14-6-org-sso-domains-admin-ui`, scheduled by the Epic 14 closure retrospective (`epic-14-retro-2026-07-27.md`, Finding 2) to close an untracked capability gap of the same shape 14-2→14-5 closed.
- Ultimate context engine analysis completed - comprehensive developer guide created.

### File List

## Change Log

- 2026-07-27: Story created via `bmad-create-story`, status set to `ready-for-dev`.
- 2026-07-27: 5-round advanced elicitation applied (Security Audit Personas, Red Team vs Blue Team, Failure Mode Analysis, Pre-mortem Analysis, Architecture Decision Records). Integrated: (1) trailing-FQDN-dot normalization before format/blocklist checks, closing a blocklist-bypass gap; (2) a machine-readable error-code contract (`invalid_domain_format`/`public_domain_blocked`/`provider_not_registered`/`provider_check_unavailable`/`domain_already_mapped`) backing the web client's typed error branches, which previously had no codes to bind to; (3) explicit `provider_check_unavailable`/`503` handling for `findAuthStrategy()` throwing, distinct from a clean not-registered result, closing a failure-mode gap where a transient extension-runtime outage would have been misreported as admin input error; (4) explicit audit-payload field requirements. Pre-mortem Analysis and ADR passes surfaced no additional changes — existing rate-limit/concurrency handling already sufficient.
