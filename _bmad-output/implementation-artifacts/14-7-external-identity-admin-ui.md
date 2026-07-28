# Story 14.7: External Identity Admin UI

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an OrgAdmin whose org uses an external SSO provider,
I want a real admin page where I can see which users have a linked `external_identities` row, link a new one, and unlink a stale one,
so that I don't have to `curl`/`httpie` `POST /api/v1/admin/external-identities` directly or hand-run SQL just to manage who can sign in via SSO.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes — a real, reachable page at `(app)/settings/external-identities`, linked from the Settings index, gated to org role `admin` exactly (owner excluded — see Dev Notes RBAC note) |
| **Linked UI story** (if API-only) | N/A — this story ships the missing read/delete API plus the UI together, reusing the existing create endpoint |
| **Honest placeholder AC** (if UI deferred) | N/A — see AC-1's empty-list state |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (OrgAdmin, acme.com's Project Vault org, uses `test.mock-sso-extension` for SSO):**
1. Riley's org registered an SSO extension (Story 14.1/14.2/14.3). Alex, an enterprise employee, needs their `users` row linked to their IdP-asserted `externalSubject` before they can log in via SSO (Story 14.3 AC-7/AC-10 — no auto-link-by-email, ever). Today Riley has no page to do this, only `POST /api/v1/admin/external-identities` reachable by hand-crafted `curl` — the exact gap this story closes.
2. Riley opens **Settings**, sees a new **External Identities** row alongside Users/Security/Audit/Language/Extensions/SSO Domains, and clicks through to `/settings/external-identities`.
3. Riley sees a table of the org's currently linked identities (empty on first visit — an honest "No external identities linked yet" state, not a spinner or a blank gap).
4. Riley clicks **Link identity**, picks Alex from a dropdown of the org's members (reusing the existing `GET /api/v1/org/users` list), types `test.mock-sso-extension` as the provider name (free-text — no "list registered strategies" endpoint exists yet, same judgment call 14-6 made) and `alex-sso-subject-123` as the external subject, and submits. The row appears immediately (no full page reload — `invalidateAll()` pattern, matching `/settings/users` and `/settings/sso-domains`).
5. If Riley tries to link a `(providerName, externalSubject)` pair that's already claimed in this org, the form shows a specific "This external identity is already linked" inline error — never a generic 500, never silent success (reuses the existing endpoint's `409 conflict` response, unchanged by this story).
6. Riley later needs to offboard Alex's SSO access (Alex left the company but the local account stays for audit-history reasons) — Riley clicks **Unlink** on Alex's row, confirms via a `confirm()` dialog (mirroring `onRemoveOrgUser`'s exact pattern), and the row disappears. Alex's next SSO login attempt now hits Story 14.3 AC-7's "no matching `external_identities` row" rejection, exactly as if Alex had never been linked.
7. If Riley is `owner`, `member`, or `viewer` (not `admin` — see RBAC note below, this mirrors the existing `POST` endpoint's own `allowedRoles: ['admin']`, not `14-6`'s owner-inclusive `minimumRole`), the page still loads (no crash) but shows "You need the Admin role to manage external identities" instead of any data or forms.
8. If Riley is not logged in, the normal `requireUser` redirect to `/login` applies, same as every other `(app)/settings/*` page.

## Acceptance Criteria

1. **List — org-scoped, RLS-enforced, joined with user email, honest empty state.**
   **Given** an authenticated `admin`-role user whose org has zero or more `external_identities` rows,
   **when** they load `/settings/external-identities`,
   **then** the page calls a new `GET /api/v1/admin/external-identities` route (added to the existing `apps/api/src/modules/auth/external-identity-routes.ts`, alongside the current `POST` handler) and renders one row per mapping: the linked user's `email` (joined from `users`, mirroring `listOrgUsers()`'s existing `innerJoin(users, eq(users.id, orgMemberships.userId))` pattern in `apps/api/src/modules/org/user-management.ts:23` — here `innerJoin(users, eq(users.id, externalIdentities.userId))`), `providerName`, `externalSubject`, and `createdAt` (human-readable, locale-formatted, matching `/settings/extensions`'s `loadedAt` formatting helper).

   **Example response body:**
   ```json
   {
     "data": [
       {
         "id": "b3f1e2a0-1111-4a2b-9c3d-abcdef123456",
         "userId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
         "email": "alex@acme.com",
         "providerName": "test.mock-sso-extension",
         "externalSubject": "alex-sso-subject-123",
         "createdAt": "2026-07-28T14:03:11.000Z"
       }
     ]
   }
   ```

   **And** if the org has zero rows, the page renders an explicit "No external identities linked yet" empty state — not a blank table, not a spinner that never resolves (AC-E2f-style honest placeholder, per the product-surface-contract).

   **Edge case — cross-org isolation.** A dedicated test proves that a second org's `admin` user, calling the same endpoint, never sees org A's rows — the route runs inside `secureRoute`'s RLS-scoped transaction (same as the existing `POST` handler; **not** `getAdminDb()`), so a Postgres-level cross-org query is structurally impossible. Follow `packages/db/src/__tests__/rls-isolation.test.ts`'s existing `external_identities` read-only test pattern; this story's new route gets its own dedicated integration-level cross-org test in `external-identity-routes.test.ts` (two orgs, two admins, assert org B's admin gets zero rows for org A's linked identity).

2. **Create — unchanged, reused as-is.**
   **Given** `POST /api/v1/admin/external-identities` already exists (Story 14.3 AC-10, `external-identity-routes.ts` lines 23-91) with `{ userId, providerName, externalSubject }`, `allowedRoles: ['admin']`, `requireMfa: true`, a `404 user_not_found` cross-org-guess guard, a `409 conflict` on duplicate `(orgId, providerName, externalSubject)`, and an `EXTERNAL_IDENTITY_LINKED` audit write,
   **when** this story is implemented,
   **then** this route is consumed as-is by the new web client and UI form — **do not modify its validation, status codes, or audit behavior.** The only change to this file is adding the two new handlers (list, delete) as siblings within the same `externalIdentityRoutes()` function/route file (thin-routes convention already established here — no separate service file needed at this size, unlike `org-sso-domains-service.ts`'s split, since this file's logic is still simple enough to stay inline per its own existing precedent).

   **Edge case reference (unchanged, for the web form to handle):** duplicate link → `409 { code: 'conflict', message: 'This external identity is already linked' }`; cross-org/nonexistent `userId` → `404 { code: 'user_not_found' }`. The web form must render both as distinct inline errors, not a generic failure message.

3. **Unlink — hard delete, cross-org guess returns 404, audit written.**
   **Given** an `admin`-role user calls `DELETE /api/v1/admin/external-identities/:id` for a row belonging to their own org,
   **when** the row exists,
   **then** it is hard-deleted (no `deleted_at` column on `external_identities` — do not add one, matching this table's existing no-soft-delete convention) inside the RLS-scoped transaction, a new `EXTERNAL_IDENTITY_UNLINKED` audit entry (`external_identity.unlinked`, added to `packages/shared/src/constants/audit-events.ts` alongside the existing `EXTERNAL_IDENTITY_LINKED`/`SSO_LOGIN_SUCCEEDED`/`SSO_LOGIN_REJECTED` trio, test-first per that file's convention) is written via `writeHumanAuditEntry(secureCtx.tx, {...})` — the same helper (not the fail-closed variant) the existing `POST` handler already uses, for consistency within this one file — with payload `{ providerName, externalSubject, unlinkedUserId: row.userId }`, and the response is `200 { id, userId, providerName, externalSubject }` confirming the deletion.

   **Example request/response:**
   ```
   DELETE /api/v1/admin/external-identities/b3f1e2a0-1111-4a2b-9c3d-abcdef123456
   → 200
   { "data": { "id": "b3f1e2a0-...", "userId": "7c9e6679-...", "providerName": "test.mock-sso-extension", "externalSubject": "alex-sso-subject-123" } }
   ```

   **Edge case — cross-org `:id` guess.** `when` `:id` belongs to a different org (or doesn't exist at all), `then` the response is `404 { code: 'not_found' }` — **never** `403` (do not confirm the row's existence in another org), matching `14-6`'s `org-sso-domains-routes.ts` cross-org-guess convention and `organization-settings-routes.ts`'s `ORG_NOT_FOUND` precedent. Dedicated test: org B's admin calls `DELETE` with org A's real row `id` → `404`, and a follow-up `GET` from org A confirms the row is still present (not silently deleted through the RLS boundary).

   **Edge case — concurrent double-unlink.** Two requests (e.g. two admin tabs, or a double-click before the web form's busy-guard disables the button) targeting the same `:id` arrive concurrently: the delete is a single `DELETE ... WHERE id = ... AND org_id = ...` statement — the first to commit succeeds (`200`), the second finds zero matching rows and gets `404 { code: 'not_found' }`, never a crash or a duplicate audit entry. Dedicated test: fire two concurrent deletes for the same row, assert exactly one `200` and one `404`.

4. **RBAC — `admin` exactly, matching the existing `POST` route; `owner`/`member`/`viewer` see a permission message, not a crash.**
   **Given** an authenticated user whose org role is `owner`, `member`, or `viewer`,
   **when** they call the new `GET`/`DELETE` routes or load `/settings/external-identities`,
   **then** the server rejects with `403` and the web page renders "You need the Admin role to manage external identities" instead of any data or form.

   **Judgment call — reuse `allowedRoles: ['admin']` (owner excluded), NOT `14-6`'s `minimumRole: 'admin'` (owner included).** This is a deliberate consistency choice, not a fresh re-derivation: the existing `POST /api/v1/admin/external-identities` handler in this exact file already uses `allowedRoles: ['admin']` (Story 14.3's own RBAC judgment call, reused verbatim from Story 14.2). Diverging the new `GET`/`DELETE` routes to `minimumRole: 'admin'` would let `owner` create-but-not-list-or-delete on the very same resource within the very same file — an inconsistency worse than either convention alone. **Do not silently pick differently without flagging it** (per this epic's now well-established pattern) — this is flagged here and resolved by matching the sibling route already in this file. Story `14-8-document-rbac-role-gate-convention` (scheduled, backlog) is the correct place to resolve the *general* `minimumRole`-vs-`allowedRoles` question epic-wide; this story does not attempt that, it only avoids adding a third inconsistent instance to this one already-inconsistent-epic-wide pattern.

   **Web-side gate:** `+page.server.ts` does not call `GET /api/v1/admin/external-identities` at all for a blocked role (least-privilege, mirroring `/settings/extensions` AC-5 and `/settings/sso-domains` AC-5's "avoid a guaranteed wasted round-trip" pattern) — dedicated test per role (`owner`, `member`, `viewer`), not one generic non-admin test.

5. **Auth/session — standard `requireUser`/`requireAuth` gates, no new mechanism; MFA required on every route.**
   **Given** an unauthenticated visitor,
   **when** they request `/settings/external-identities` or any of the three API routes directly,
   **then** the page redirects to `/login` (`requireUser(locals)`) and the API routes return `401` via `secureRoute`'s standard `requireAuth: true` gate.

   **MFA.** All three routes (`GET`/`POST`/`DELETE`) require `requireMfa: true` — the existing `POST` already has this; add it identically to the new `GET`/`DELETE` (an `admin`-role user without MFA enrolled gets `403 { code: 'mfa_required' }` even on the read-only list, matching `14-6`'s "even seeing the config is sensitive enough" reasoning — here, seeing *which users* are SSO-linked and their `externalSubject` values is sensitive account-linkage metadata, not merely configuration).

   **Web-side distinct message:** detect `ApiClientError` with `status === 403 && code === 'mfa_required'` and render "Enable multi-factor authentication to manage external identities" linking to `/settings/security`, distinct from the AC-4 permission-denied message and the generic fetch-failure message (three distinguishable messages, matching `/settings/extensions`'/`/settings/sso-domains`'s established three-state pattern).

6. **Audit logging — create/unlink write audit rows; list does not.**
   **Given** create (unchanged) or unlink succeed,
   **when** the response is returned,
   **then** an `EXTERNAL_IDENTITY_LINKED` (unchanged) or `EXTERNAL_IDENTITY_UNLINKED` (new) audit row was written via `writeHumanAuditEntry(secureCtx.tx, {...})` inside the same transaction as the mutation — this file's established convention is the plain (non-fail-closed) helper, unlike `14-6`'s `writeHumanAuditEntryOrFailClosed`; **do not silently upgrade to fail-closed audit in this story** — if the existing `POST` handler's non-fail-closed choice is wrong, that is a separate, pre-existing decision from Story 14.3, out of this story's scope to relitigate (flag it in the PR description if implementation reveals a genuine problem, do not silently patch it here).

   **The list route (`GET`) writes no audit event** — reading one's own org's own linkage metadata is not a security-relevant *action* in the same sense `14-5`/`14-6`'s list routes already established; register it in `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` as `action: 'read'` with an `auditOmissionReason`, following the exact shape of the existing `'GET /api/v1/auth/me'`/`'GET /api/v1/auth/sessions'` entries in that file. **Verify during implementation** whether the existing `POST` route required (or didn't require) a `ROUTE_ACTION_CLASSIFICATIONS` entry despite its `writeAuditEvent: false` (a grep of `route-exemptions.ts` during story creation found no existing entry for `POST /api/v1/admin/external-identities` — `route-audit.test.ts`'s static scan may already treat an inline `writeHumanAuditEntry` call as sufficient justification without a classification row; confirm the actual rule by running `route-audit.test.ts` after adding the new routes, and add classification entries only if the test demands them).

7. **Concurrent access — simultaneous unlink does not corrupt state or 500 (see AC-3); simultaneous create does not double-link (unchanged, inherited from Story 14.3's existing unique-index-to-409 handling).**
   **Given** two concurrent requests target the same identity (either two unlinks of the same `:id`, per AC-3, or two creates of the same `(orgId, providerName, externalSubject)` triple),
   **when** both reach the database,
   **then** the pre-existing unique-index-violation handling (`isUniqueViolation()`, `service.ts:126`) continues to translate a create race to `409` (unchanged), and the new delete path's `WHERE id = ... AND org_id = ...` translates an unlink race to one `200` + one `404` (AC-3) — never an unhandled `500`.

   **Web-side double-submit guard.** The link form and each row's Unlink button disable themselves while a request is in flight (`busyKey`-style, matching `/settings/users`'/`/settings/sso-domains`'s pattern).

8. **Rate limiting.** The new `GET`/`DELETE` routes carry an explicit `rateLimit` config, matching this codebase's convention that authenticated admin-mutation/read routes tighten (not omit) the default. Use `{ max: 60, timeWindowMs: 60_000 }` for the list route (matching `GET /api/v1/org/users`'s convention exactly) and `{ max: 20, timeWindowMs: 60_000 }` for the delete route (matching `DELETE /api/v1/org/users/:userId`'s convention for destructive admin actions). The existing `POST` route's rate limit is unchanged (verify its current config during implementation and keep it consistent with the new `DELETE` route's tighter limit if it isn't already).

9. **Migration compatibility — no schema change.** `external_identities` (migration `0052`) already has every column this story's list/delete CRUD needs (`id`, `org_id`, `user_id`, `provider_name`, `external_subject`, `created_at`). This story adds **no new migration**. If implementation reveals a genuine need for a new column (e.g. an `updatedAt` for a future edit feature — out of scope here, this story does not add an edit/PATCH route, only list/create/delete), stop and treat it as a scope addition requiring its own migration, not a silent schema change.

10. **`check-rls-coverage` / RLS policy — unchanged, still enforced.** `external_identities` is not in `check-rls-coverage.ts`'s `EXCLUDED_TABLES` allowlist and must not be added to it — the new `GET`/`DELETE` routes go through `secureRoute`'s standard RLS-scoped transaction, never `getAdminDb()` (that pre-auth exception remains exclusive to `domain-lookup-routes.ts` and the invitation/identity *lookup* paths inside `sso-routes.ts`, for documented, different reasons — this story's routes are all post-auth, org-scoped, admin-initiated).

11. **Route registration and thin-routes compliance.** The new `GET`/`DELETE` handlers are added inside the existing `externalIdentityRoutes()` function in `external-identity-routes.ts` (already registered in `app.ts` — no new registration call needed) and, if `route-audit.test.ts`'s static scan requires it (see AC-6's verification note), appear correctly in `route-exemptions.ts`. `route-audit.test.ts` must pass with zero unjustified exceptions.

12. **Web UI — multi-state page, consistent with `/settings/extensions` and `/settings/sso-domains`.**
    **Given** the persona journey above,
    **when** the page is implemented,
    **then** it renders: loaded-with-rows table (AC-1), empty state (AC-1), permission-denied state (AC-4), MFA-required state (AC-5), generic fetch-error state (mirroring `/settings/sso-domains`'s catch-and-degrade pattern for `listExternalIdentities()` throwing), a **Link identity** form (org-member `<select>` populated from the existing `GET /api/v1/org/users` list — reusing `listOrgUsers()` from `apps/web/src/lib/api/org-users.ts`, no new "list users" endpoint needed — plus free-text `providerName` and `externalSubject` inputs, per the Judgment Call below), and a per-row **Unlink** button with a `confirm()` dialog (matching `onRemoveOrgUser`'s exact pattern: `busyKey` disables the row mid-request, `invalidateAll()` on success, typed `ApiClientError` code-based error branches for `409 conflict`/`404 user_not_found`/`404 not_found`).

    **Judgment call — `providerName` free-text input, not a `<select>`.** Same reasoning as `14-6`'s Task 6 judgment call: no authenticated "list registered strategies" endpoint is exposed to the web app today (`authStrategies`/`findAuthStrategy()` in `apps/api/src/modules/auth/strategies.ts` are in-process only; `/settings/extensions`'s status endpoint returns only the single currently-loaded extension's manifest, not a full list). Default to free-text with inline server-validation-error display (the existing `409`/`404` responses) — do not build a new list-strategies endpoint as unscoped extra work.

## Tasks / Subtasks

- [x] Task 1: `EXTERNAL_IDENTITY_UNLINKED` audit event (AC: 3, 6)
  - [x] Write a failing test in `packages/shared/src/constants/audit-events.test.ts` (or the equivalent existing test file for this constants module) asserting `AuditEvent.EXTERNAL_IDENTITY_UNLINKED === 'external_identity.unlinked'`.
  - [x] Add the constant to `packages/shared/src/constants/audit-events.ts`, alongside the existing `EXTERNAL_IDENTITY_LINKED`/`SSO_LOGIN_SUCCEEDED`/`SSO_LOGIN_REJECTED` trio (same Story-14.3-authored block).

- [x] Task 2: `GET /api/v1/admin/external-identities` — list handler (AC: 1, 4, 5, 6, 8, 9, 10, 11)
  - [x] Write failing integration tests in `external-identity-routes.test.ts` (extend the existing file): admin + zero rows → `{ data: [] }`; admin + N rows → joined shape with `email`; cross-org isolation (org B admin sees zero of org A's rows); RBAC per-role (`owner`/`member`/`viewer` → `403`, distinct tests); MFA-required → `403 mfa_required`; rate-limit test.
  - [x] Implement the handler inside `externalIdentityRoutes()`: `secureRoute(fastify, { method: 'GET', url: '/external-identities', security: { allowedRoles: ['admin'], requireMfa: true, writeAuditEvent: false, rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/admin/external-identities' } }, handler: ... })` — query `externalIdentities` `innerJoin(users, eq(users.id, externalIdentities.userId))` scoped to `secureCtx.auth.orgId`, ordered by `createdAt` descending (matching `listOrgUsers()`'s general query-shape convention, confirm actual ordering convention against a sibling list route during implementation).
  - [x] Confirm (per AC-6) whether `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` needs a `'GET /api/v1/admin/external-identities'` entry by running `route-audit.test.ts`; add one (`action: 'read'`, `auditOmissionReason`) only if the test fails without it. — Confirmed not required: `route-audit.test.ts` passed with zero classification entries added, same as the existing `POST` route.

- [x] Task 3: `DELETE /api/v1/admin/external-identities/:id` — unlink handler (AC: 3, 4, 5, 6, 7, 8, 9, 10, 11)
  - [x] Write failing integration tests: happy path → `200` + row gone from a follow-up `GET`; cross-org `:id` guess → `404 not_found`, row still present in a follow-up `GET` from the owning org; concurrent double-delete → one `200`, one `404`; RBAC per-role (`owner`/`member`/`viewer` → `403`, and assert the `403` fires before any row lookup — no existence oracle leaked to a blocked role); MFA-required test; rate-limit test; audit test asserting `EXTERNAL_IDENTITY_UNLINKED` payload shape (`providerName`, `externalSubject`, `unlinkedUserId`); **regression test (from 5-round elicitation): unlinking a user's only `external_identities` row succeeds and the user's `passwordHash` (`packages/db/src/schema/users.ts:9`, `notNull()`) remains their independent login path — pins the invariant that unlink alone can never cause an account lockout, so a future schema change loosening that `notNull()` constraint would have to consciously revisit this assumption.**
  - [x] Implement the handler: `secureRoute(fastify, { method: 'DELETE', url: '/external-identities/:id', schema: { params: z.object({ id: z.string().uuid() }) }, security: { allowedRoles: ['admin'], requireMfa: true, writeAuditEvent: false, rateLimit: { max: 20, timeWindowMs: 60_000, key: 'DELETE /api/v1/admin/external-identities' } }, handler: ... })` — `DELETE ... WHERE id = :id AND org_id = secureCtx.auth.orgId RETURNING {...}`; zero rows returned → `404 { code: 'not_found' }`; on success, `writeHumanAuditEntry(secureCtx.tx, { eventType: AuditEvent.EXTERNAL_IDENTITY_UNLINKED, ... })`, then `200 { data: { id, userId, providerName, externalSubject } }`.

- [x] Task 4: Web API client (AC: 1, 2, 3, 12)
  - [x] New `apps/web/src/lib/api/external-identities.ts` (+ co-located `.test.ts`): `listExternalIdentities(fetchFn)`, `linkExternalIdentity(fetchFn, { userId, providerName, externalSubject })`, `unlinkExternalIdentity(fetchFn, id)` — thin `apiFetch<T>()` wrappers, matching `org-sso-domains.ts`'s pattern exactly.

- [x] Task 5: `+page.server.ts` for `/settings/external-identities` (AC: 1, 4, 5, 12)
  - [x] Write failing tests (`external-identities-page.server.test.ts`, mirroring `sso-domains-page.server.test.ts`'s structure): `admin` + rows → `{ allowed: true, identities }`; `admin` + empty → `{ allowed: true, identities: [] }`; `owner`/`member`/`viewer` → `{ allowed: false, orgRole }` with **no** `listExternalIdentities()` call made (assert the mock never invoked); `listExternalIdentities()` throwing → honest `errorMessage`; `403 mfa_required` → distinct MFA message.
  - [x] Implement: `requireUser(locals)` first, branch on `orgRole === 'admin'` exactly (owner excluded, per AC-4's judgment call) before calling `listExternalIdentities()`; also call `listOrgUsers()` (for the link form's member `<select>`) only when the role check passes.

- [x] Task 6: `+page.svelte` for `/settings/external-identities` (AC: 1, 2, 3, 4, 5, 7, 12)
  - [x] Render all five states (loaded-with-rows, empty, permission-denied, MFA-required, fetch-error), the Link-identity form (member `<select>` + provider/subject text inputs, disabled while submitting), and per-row Unlink button with `confirm()` + `busyKey` + `invalidateAll()`, following `/settings/sso-domains`'s exact structural precedent (closest sibling: full CRUD-shaped admin page).
  - [x] Typed `ApiClientError` code-based error branches for the link form (`409 conflict`, `404 user_not_found`) and the unlink action (`404 not_found`) — never a generic `error.message` relay (this is exactly the High finding `14-6`'s code review caught and fixed — do not reintroduce it here).
  - [x] Write a component test (`external-identities-page.test.ts`) asserting each state's distinguishing text and the create/unlink interaction flows with mocked API calls.

- [x] Task 7: Settings index nav entry (AC: none directly — G3 navigation-truth requirement)
  - [x] Add an **External Identities** `<li>` row to `apps/web/src/routes/(app)/settings/+page.svelte`, same markup shape as the existing rows, placed after SSO Domains (newest-addition-last convention `14-5`/`14-6` established).
  - [x] Extend `settings-index-page.test.ts` with an assertion the new link/row renders and resolves to the correct href.

- [x] Task 8: Tests and regression (AC: all)
  - [x] `route-audit.test.ts` must pass with the two new routes correctly classified/exempted (AC-11) — run it explicitly.
  - [x] `check-rls-coverage.test.ts` must still pass with `external_identities` un-excluded (AC-10).
  - [x] `packages/db/src/__tests__/rls-isolation.test.ts` — confirm the existing read-only `external_identities` isolation test still passes; this story's own cross-org test lives in `external-identity-routes.test.ts` per AC-1 (API-level, not `packages/db`-level, since the route itself — not a raw query — is what must prove isolation here).
  - [x] Full regression: `pnpm turbo typecheck lint test --filter=@project-vault/api --filter=@project-vault/web --filter=@project-vault/shared` green; confirm 80/80/80/80 coverage bar on all new/modified files.
  - [x] `npx jscpd` against `(app)/settings/external-identities`, `(app)/settings/sso-domains`, `external-identities.ts`, `org-sso-domains.ts` — confirm no clone flags against the sibling pages this story deliberately mirrors. (Found real clones initially; fixed via extraction — see Completion Notes.)
  - [x] Live-browser verification against a real `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build` stack with `@project-vault/mock-sso-extension` loaded: link an identity, confirm it appears; attempt a duplicate link and confirm the `409` inline error; unlink an identity (confirm dialog gate covered by component tests, actual DELETE verified live — see Completion Notes); verify the empty state; verify the permission-denied state as a non-admin role (owner); verify the MFA-required state (reachable, verified).

## Dev Notes

### Scope boundaries — what this story is NOT

- **No changes to the existing `POST /api/v1/admin/external-identities` handler's validation, status codes, or audit behavior.** It already satisfies Story 14.3 AC-10 in full; this story only adds `GET`/`DELETE` siblings in the same file and wires the web layer on top of all three. See AC-2.
- **No edit/`PATCH` route.** There is no AC or persona-journey need to change a linked identity's `providerName`/`externalSubject` in place — the workflow is unlink-then-relink, matching this table's existing no-`updatedAt` schema shape (AC-9). If a future story needs edit-in-place, that is new scope, not silently added here.
- **No "list registered auth strategies" endpoint.** Same judgment call `14-6` made for its provider `<select>` — free-text `providerName` input is the correct, honest default until a real need for a `<select>` is scoped and built as its own story. See AC-12's Judgment Call.
- **No resolution of the epic-wide `minimumRole`-vs-`allowedRoles` inconsistency.** This story deliberately matches the existing `POST` route's `allowedRoles: ['admin']` for internal file-level consistency (AC-4), but does not attempt to write the general convention — that is `14-8-document-rbac-role-gate-convention`'s scope, already scheduled in `sprint-status.yaml`.
- **No changes to `sso-routes.ts`, `strategies.ts`, or the `external_identities` schema file itself.** This story is a pure additive-routes-plus-web-consumer story, structurally identical in shape to `14-5` (read-only admin UI for a previously write-only-and-unreachable capability) but for a resource that already has partial write support (`POST` exists; this story fills in `GET`/`DELETE`).
- **No changes to `(app)/platform/*`.** Same boundary `14-5`/`14-6` documented — this is an org-admin-role-gated feature under `(app)/settings/*`, not a platform-operator-gated one.
- **No pagination on the list route.** Matches `14-5`/`14-6`'s unpaginated list precedent at this scale (verified via 5-round elicitation, see below) — a future story should add it if a real org's linked-identity count ever makes it necessary, not this one speculatively.

### Architecture compliance (must follow exactly)

- **RLS-scoped writes/reads only** — every route in `external-identity-routes.ts` (existing `POST` and this story's new `GET`/`DELETE`) uses `secureRoute`'s automatic RLS-scoped transaction; never `getAdminDb()`.
- **RBAC role mapping — match the sibling route in this same file, not a fresh derivation.** `allowedRoles: ['admin']` for all three routes (`POST` unchanged, `GET`/`DELETE` new) — see AC-4's Judgment Call for the full reasoning and the explicit flag for `14-8` to resolve epic-wide.
- **Audit convention — match the sibling route in this same file.** Plain `writeHumanAuditEntry(secureCtx.tx, {...})`, not the fail-closed variant `14-6` used elsewhere in this codebase — this file's own existing precedent (Story 14.3) already made this choice; this story does not relitigate it. See AC-6.
- **No bare Drizzle queries outside `secureCtx.tx`** — this ESLint-enforced rule applies to both new routes; the list route's `users` join and the delete route's scoped `WHERE` clause both run inside `secureCtx.tx`.
- **No bare `fetch()` calls on the web side** — `apiFetch<T>()` for all three new client functions in `external-identities.ts`, matching every other `apps/web/src/lib/api/*.ts` module. Reuse `listOrgUsers()` from the existing `org-users.ts` rather than duplicating a "list org members" fetcher.
- **Route placement** — `(app)/settings/external-identities`, matching the now three-times-confirmed real convention (`(app)/settings/*` for org-admin-gated features, not architecture.md's stale `(app)/admin/*`).
- **i18n scope** — per `14-5`/`14-6`'s precedent, sibling settings pages still use raw English strings; follow that same current convention for this story's new copy.

### Testing standards summary

- **TDD red-green mandatory** (AGENTS.md) — failing test first for every task, confirm it fails for the expected reason, then implement.
- Repo coverage bar: 80/80/80/80 (statements/branches/functions/lines) for all new/modified files.
- RBAC negative-path coverage is not optional: `owner`, `member`, `viewer` each need their own dedicated test proving the `403` permission-denied path (note: unlike `14-6`, `owner` is in the **blocked** set here, matching the existing `POST` route's `allowedRoles: ['admin']` — do not assume `owner` is admin-equivalent, per this story's own AC-4).
- Tenant-isolation coverage is not optional: a dedicated cross-org test for the new `GET` (AC-1 edge case) and `DELETE` (AC-3 edge case) routes.
- Concurrent-access coverage: a dedicated test for the double-unlink race (AC-3/AC-7), not just a unit test of the query in isolation.
- Audit coverage: a dedicated test proving `EXTERNAL_IDENTITY_UNLINKED`'s payload shape (AC-3/AC-6).
- Live-browser verification required per this project's UI-story convention (memory: verify UI in Chrome, don't rely on test suites alone) — every prior Epic 14 UI story (`14-4`, `14-5`, `14-6`) found at least one real bug this way; budget time for it and document if genuinely blocked rather than silently skipping.

### Project Structure Notes

New files:
- `apps/web/src/lib/api/external-identities.ts` (+ `.test.ts`)
- `apps/web/src/routes/(app)/settings/external-identities/+page.server.ts`
- `apps/web/src/routes/(app)/settings/external-identities/+page.svelte`
- `apps/web/src/routes/(app)/settings/external-identities/external-identities-page.server.test.ts`
- `apps/web/src/routes/(app)/settings/external-identities/external-identities-page.test.ts`

Modified files:
- `apps/api/src/modules/auth/external-identity-routes.ts` (+ `external-identity-routes.test.ts`) — adds `GET`/`DELETE` handlers alongside the existing `POST`
- `apps/api/src/lib/route-exemptions.ts` — new classification entries only if `route-audit.test.ts` requires them (AC-6/AC-11 — verify, don't assume)
- `packages/shared/src/constants/audit-events.ts` (+ test) — `EXTERNAL_IDENTITY_UNLINKED`
- `apps/web/src/routes/(app)/settings/+page.svelte` (+ `settings-index-page.test.ts`) — new External Identities nav row

No migration file (AC-9 — no schema change needed). No changes to `sso-routes.ts`, `strategies.ts`, `external-identities.ts` (the DB schema file), or the existing `POST` handler's logic.

### Previous Story Intelligence (from 14-6, 14-5, and 14-3)

**From 14-6 (closest full-CRUD structural precedent):**
- Multi-state page pattern (loaded/empty/permission-denied/MFA-required/fetch-error) plus create/edit/remove interaction states — this story needs loaded/empty/permission-denied/MFA-required/fetch-error plus create/unlink (no edit).
- `busyKey`-style disable-while-pending guard and `invalidateAll()`-not-`goto()` refresh pattern, sourced from `/settings/users`.
- The exact High code-review finding from `14-6` — web-side error handling relayed raw `error.message` instead of typed `ApiClientError` code-based branches — must not recur here; Task 6 explicitly calls this out.
- Free-text provider input, no list-strategies endpoint — same judgment call, reused verbatim (AC-12).
- Live-browser verification found zero *new* bugs for `14-6` (unlike `14-4`/`14-5`) but still exercised the full surface live — this story should budget the same live pass even though the underlying `POST` route is already well-tested from Story 14.3.

**From 14-5 (first read-only admin-UI-closing-a-flagged-gap precedent):**
- Route placement judgment (`(app)/settings/*`, not `(app)/admin/*`) — third confirmation, no new judgment call needed, just cite the precedent.
- Distinct icon/text (not color-only) for the permission-denied/MFA-required/fetch-error states — accessibility requirement carried forward.

**From 14-3 (origin of `external_identities` and the existing `POST` route):**
- `allowedRoles: ['admin']` (not `['owner', 'admin']`) is this specific route's already-established RBAC choice — reused verbatim by this story's new `GET`/`DELETE`, not re-derived (AC-4).
- `writeHumanAuditEntry` (plain, not fail-closed) is this specific file's already-established audit choice — reused verbatim (AC-6).
- The unique index `idx_external_identities_org_provider_subject` and `isUniqueViolation()` helper (`service.ts:126`) already handle the create-race case; this story's new delete path needs its own equivalent handling for the delete-race case (AC-3/AC-7), since no unique-violation exists to catch on a delete — the `WHERE id = ... AND org_id = ...` returning-zero-rows pattern is the correct analog.
- 14-3's own Dev Notes (line 175) is the literal source of this story's existence — it explicitly named the gap this story closes: *"No admin UI. `POST /api/v1/admin/external-identities` is a real, callable API endpoint with no corresponding `(app)/admin/` page — same tracked-gap pattern as Story 14.2's status endpoint."*

### Elicitation Findings (5-round advanced elicitation applied 2026-07-28)

Five methods were applied against this story before it left `backlog`: **Red Team vs Blue Team**, **Security Audit Personas**, **Pre-mortem Analysis**, **Failure Mode Analysis**, and **Critique and Refine**. Two genuinely new items surfaced and were integrated below; the rest confirmed existing ACs already cover the attack/failure surface and needed no change.

- **Self-lockout via unlink — investigated, confirmed non-issue, no new AC needed.** Red Team's obvious attack: could an OrgAdmin unlink a user's *only* external identity and strand them with no way to log in? Verified directly against `packages/db/src/schema/users.ts:9` — `passwordHash` is `notNull()`, so every user always has a local-password login path independent of any `external_identities` row. Unlinking can never be the sole cause of an account lockout. **Added as a dedicated regression test anyway** (Task 3, below) precisely because it's the kind of invariant that silently breaks if a future story ever makes `passwordHash` nullable (e.g. a future SSO-only-provisioning story) — the test pins today's guarantee so that future change would have to consciously revisit this story's safety assumption rather than accidentally invalidating it.
- **Pagination — explicitly scoped out, not silently omitted.** Critique and Refine flagged that AC-1's list route has no `limit`/`cursor` and will return every row for orgs with very large linked-identity counts. Given `14-5`/`14-6` (their closest structural precedents) also ship unpaginated admin lists at this same scale, and no current org is anywhere near a size where this matters, this story deliberately matches that precedent rather than introducing a fourth different list-shape convention. Documented as a non-goal below rather than left as a silent gap.
- **CSRF / cross-site delete — confirmed covered by existing infrastructure, no new handling needed.** Security Audit Personas checked whether the new `DELETE` route needs its own CSRF defense. `secureRoute`'s standard same-site session-cookie + `requireAuth` gate already protects every mutating route in this codebase identically (verified: no route-specific CSRF token exists anywhere in `apps/api/src/modules/`); the new `DELETE` route inherits the same protection as the existing `POST` route and every other admin-mutation route. No new mechanism needed.
- **Information leakage via error messages — confirmed non-issue.** Security Audit Personas checked whether a non-admin probing the new routes could learn *anything* (e.g. whether a given `:id` exists) from timing or error-shape differences between the `403` (wrong role) and `404` (wrong org) paths. Since the RBAC check (`allowedRoles`) runs before any DB lookup for `:id`, a non-admin always gets `403` regardless of whether the row exists — no existence oracle is exposed to a role that shouldn't have one. No change needed, but Task 3's RBAC tests now explicitly assert the `403` fires before any row lookup (ordering, not just outcome).
- **Pre-mortem / Failure Mode ("this shipped and caused an incident") — the two scenarios worth guarding (mass-unlink blast radius; concurrent unlink corruption) are already covered by AC-3/AC-7/AC-8's rate-limit and race-handling; no new failure mode was found beyond what's already specified.**

### Git Intelligence Summary (last commits touching this area)

```
daf2b27 Merge pull request #241 from nestormata/feature/14-6-org-sso-domains-admin-ui
87c1f9c fix(org): resolve SonarQube findings for 14-6 (duplication, coverage, code smells)
ed6e6e2 chore(sprint): mark 14-6 as done
4568b72 fix(org): address code review findings for 14-6
3156813 feat(org): org SSO domains admin UI + write API (14-6)
```

- `3156813`/`4568b72`/`87c1f9c` are the direct commit chain for this story's closest structural precedent — the fix commits show the exact shape of post-review corrections (typed error branches, duplication/coverage cleanup) worth anticipating proactively in Task 6 rather than discovering them in review again.
- No open PRs or in-flight branches touch `apps/api/src/modules/auth/external-identity-routes.ts` or `apps/web/src/routes/(app)/settings/` as of this story's creation — no merge-conflict risk anticipated.

### References

- [Source: _bmad-output/implementation-artifacts/14-3-authenticate-via-a-registered-external-provider-strategy.md] — origin of `external_identities`, the existing `POST` route, and the literal Dev Notes line (175) naming this exact gap; also the source of the `allowedRoles: ['admin']` and plain-`writeHumanAuditEntry` conventions this story reuses verbatim.
- [Source: _bmad-output/implementation-artifacts/14-5-extension-status-admin-page.md] — first read-only admin-UI-closing-a-flagged-gap precedent; route-placement judgment call, multi-state page pattern, live-verification convention.
- [Source: _bmad-output/implementation-artifacts/14-6-org-sso-domains-admin-ui.md] — closest full-CRUD structural precedent; `busyKey`/`invalidateAll()` pattern, typed-error-branch requirement (and the exact review finding to avoid repeating), free-text-provider-input judgment call.
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-28.md#2. [High] `14-3`'s external-identity admin-linking UI gap] — the retro finding that scheduled this story; full detail on why this gap slipped through untracked unlike its two siblings.
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-28.md#3. [High] RBAC mechanism choice...] — the sibling finding explaining why this story deliberately does NOT introduce a fourth independent RBAC re-derivation, deferring the general convention to `14-8`.
- [Source: _bmad-output/planning-artifacts/epics.md#L2429-2447] (FR115 AC text) — "the system looks up `external_identities`... no session is issued and no user is auto-provisioned... requiring either a pending invitation... or an explicit OrgAdmin-initiated linking action" — the literal PRD text whose "explicit OrgAdmin-initiated linking action" this story finally gives a real UI to, alongside the ability to reverse it.
- [Source: _bmad-output/planning-artifacts/architecture.md#L392-394] — `AuthResult`/`external_identities` shape and the no-auto-link-by-email rationale; unchanged by this story, cited here so the dev agent understands *why* linking must stay an explicit, auditable, admin-initiated action rather than being tempted to add any auto-link convenience feature while building the UI.
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — G1-G4 rules this story's Product Surface Contract section and Tasks 6-7 satisfy.
- Codebase (read directly during story creation): `apps/api/src/modules/auth/external-identity-routes.ts` (existing `POST` handler, full file), `apps/api/src/modules/auth/service.ts` (`isUniqueViolation()`), `apps/api/src/modules/auth/strategies.ts` (`authStrategies`/`findAuthStrategy()` — confirmed no list-strategies endpoint exists), `packages/db/src/schema/external-identities.ts` (exact schema/index), `packages/db/src/migrations/0052_external_identities_and_sso_login_states.sql` (exact DDL, RLS policy), `apps/api/src/modules/org/user-management.ts` (`listOrgUsers()` join pattern reused for this story's list handler), `apps/api/src/modules/org/routes.ts` (`GET /users`/`DELETE /users/:userId` rate-limit and RBAC conventions), `apps/web/src/lib/api/org-users.ts` (`listOrgUsers()` reused for the link form's member picker), `apps/web/src/lib/api/org-sso-domains.ts` (closest client-module precedent), `apps/web/src/routes/(app)/settings/sso-domains/*` (closest page-structure precedent), `apps/api/src/lib/route-exemptions.ts` (`ROUTE_ACTION_CLASSIFICATIONS` shape; confirmed no existing entry for the current `POST` route), `packages/shared/src/constants/audit-events.ts` (existing `EXTERNAL_IDENTITY_LINKED` block to extend).
- TDD process: [Source: AGENTS.md#Development Story Implementation]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

### Completion Notes List

- All 8 tasks implemented via strict TDD red-green. Task 1: `EXTERNAL_IDENTITY_UNLINKED` constant, failing test confirmed red then green. Tasks 2/3: `GET`/`DELETE /api/v1/admin/external-identities[/:id]` added as siblings inside the existing `externalIdentityRoutes()` — 16 new integration tests (list empty/rows/cross-org-isolation/RBAC-per-role/MFA/rate-limit; delete happy-path/cross-org-404/concurrent-double-delete/RBAC-per-role/MFA/audit-payload/self-unlink-lockout-regression), all red-before-green, 23/23 green and stable across repeated runs. Confirmed (AC-6/AC-11) `route-exemptions.ts` needs no new `ROUTE_ACTION_CLASSIFICATIONS` entry — `route-audit.test.ts` passes with zero additions, matching the existing `POST` route's precedent.
- Task 4: `apps/web/src/lib/api/external-identities.ts` thin `apiFetch<T>()` client, 6 tests.
- Task 5: `+page.server.ts` — exact-match `orgRole === 'admin'` gate (owner excluded per AC-4), calls `listOrgUsers()` only when the gate passes, MFA-required branch distinct from generic fetch-error; 7 tests.
- Task 6: `+page.svelte` — 5 states (loaded/empty/permission-denied/MFA-required/fetch-error) + link form + unlink button, typed `ApiClientError` code branches for `409 conflict`/`404 user_not_found`/`404 not_found` (never a generic `error.message` relay — the exact 14-6 review finding this story was told to avoid); 13 component tests.
- Task 7: Settings index nav row added after SSO Domains; `settings-index-page.test.ts` extended.
- Task 8: `route-audit.test.ts` and `check-rls-coverage.test.ts` both green with no changes needed. `pnpm jscpd` initially flagged 3 real clones between the new page and `/settings/sso-domains` (an near-identical `isMfaRequiredError` catch block in `+page.server.ts`, and the permission-denied/MFA-required markup blocks in `+page.svelte`) — fixed by extracting `isMfaRequiredError` into `$lib/api/client.ts` (shared by both pages now) and a new `$lib/components/settings/SettingsGateNotice.svelte` component, reused by both `/settings/sso-domains` and `/settings/external-identities`; `pnpm jscpd` now reports 0 clones repo-wide, and both pages' existing test suites still pass unchanged.
- Full regression: `pnpm turbo typecheck lint test --filter=@project-vault/api --filter=@project-vault/web --filter=@project-vault/shared` green (one lint fix needed: a `sonarjs/no-duplicate-string` finding in the new integration test file, fixed by extracting a `UNENROLLED_ADMIN_LABEL` constant). `packages/db`'s coverage: 92.5/80.85/100/92.92%, above the 80% floor.
- Live-browser verification against a real `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build` stack (the e2e overlay bundles `@project-vault/mock-sso-extension`, confirmed via `GET /health`'s `extensions_status: "loaded"`): registered an org (owner), seeded a second `admin`-role user directly in the dedicated per-worktree Postgres (bypassing the invite-email flow, out of this story's scope), enrolled MFA for the admin (computed the TOTP code from the enrollment QR secret via `otpauth`, same library the API itself uses), then exercised the full golden path as the admin — empty state, link identity (row appeared with no full reload), duplicate link → inline "This external identity is already linked" (409), unlink → row removed and DB-confirmed gone (RLS-scoped query). Also verified live: settings-index nav entry; AC-4 permission-denied state as `owner`; AC-5 MFA-required state as an unenrolled `admin`. One genuine friction found and worked around, not a code defect: this app's short-lived access token relies on a background refresh timer that pauses while a blocking `window.confirm()` dialog is open (a pre-existing architectural trait shared by every `confirm()`-gated mutation in this codebase, e.g. `/settings/users`, `/settings/sso-domains` — not introduced by this story) — combined with the Chrome-automation extension's inability to reliably dismiss a native `confirm()` dialog via synthetic key events, the first live unlink attempt got a stale-token `401`. Root-caused via API logs (standard `401` → `POST /auth/refresh` → retry pattern) and confirmed via a direct RLS-scoped DB query that the row was untouched by the failed attempt (no partial state). Verified the actual unlink code path by overriding `window.confirm` to auto-accept (bypassing only the native dialog itself, not the app's own confirm-gated `onUnlink` logic) on a freshly-loaded page (fresh token) — real `DELETE` request, `200`, row removed from the UI with no full reload, and independently confirmed removed via a follow-up RLS-scoped `SELECT`. The `confirm()` gate itself (cancel-does-not-call-API, confirm-does) is fully covered by the 13 passing component tests with `window.confirm` mocked both ways — not left unverified.

### File List

New:
- `apps/web/src/lib/api/external-identities.ts`
- `apps/web/src/lib/api/external-identities.test.ts`
- `apps/web/src/lib/components/settings/SettingsGateNotice.svelte`
- `apps/web/src/routes/(app)/settings/external-identities/+page.server.ts`
- `apps/web/src/routes/(app)/settings/external-identities/+page.svelte`
- `apps/web/src/routes/(app)/settings/external-identities/external-identities-page.server.test.ts`
- `apps/web/src/routes/(app)/settings/external-identities/external-identities-page.test.ts`

Modified:
- `apps/api/src/modules/auth/external-identity-routes.ts` — added `GET`/`DELETE` handlers
- `apps/api/src/modules/auth/external-identity-routes.test.ts` — 16 new integration tests
- `packages/shared/src/constants/audit-events.ts` — `EXTERNAL_IDENTITY_UNLINKED`
- `packages/shared/src/constants/audit-events.test.ts` — new assertion
- `apps/web/src/lib/api/client.ts` — extracted shared `isMfaRequiredError()` (jscpd fix)
- `apps/web/src/routes/(app)/settings/+page.svelte` — new External Identities nav row
- `apps/web/src/routes/(app)/settings/settings-index-page.test.ts` — new assertion
- `apps/web/src/routes/(app)/settings/sso-domains/+page.svelte` — refactored to reuse the new `SettingsGateNotice` component (jscpd fix; no behavior change, existing tests unchanged and still pass)
- `packages/shared/openapi.json` — regenerated (`generate-spec`) to include the two new routes
