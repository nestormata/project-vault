# Story 17.1: Share a Credential with an Organization Member

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a project member with reveal access to a credential,
I want to share that credential's current value — or a specific field of a multi-field secret — with another organization member via a bounded-duration, single-use-or-time-boxed link,
so that I can hand off a secret to a teammate without exposing it outside the product, without giving them permanent reveal access, and with a full record of who saw it and when.

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

**Morgan (project member)** opens a credential detail page for a credential they can reveal, clicks **Share**, picks an existing org member as the recipient (typeahead limited to members of the credential's org — no free-text email in this story, that's 17.2's external-recipient path), sets an expiry (or accepts the default), optionally toggles "single view only," and clicks **Create share link**. Morgan sees the generated link once (masked/copy-once affordance) and a confirmation that the recipient will be notified in-app.

**Riley (the recipient, a different org member)** gets a notification ("Morgan shared a credential with you") and opens the link while logged in. Riley sees a consent/reveal screen (not the raw value immediately) naming the credential, the sharer, and the field (if scoped), clicks to reveal, and sees the value. If the share was single-use, a second open of the same link shows "This share has already been viewed" instead of the value. If the share is time-boxed and the window has passed, Riley sees "This share has expired."

Morgan can see all their outstanding and past shares for a credential in a new **Shares** tab on the credential detail page (who, when, expiry, viewed/revoked/expired) and can revoke any still-active share from there.

## Acceptance Criteria

1. **Share creation eligibility (reuse today's reveal gate).** A user can create a share for a credential (or a specific field of a multi-field secret) only if their effective project role for that credential's project would pass today's existing reveal-permission check (`rejectIfInsufficientProjectRoleForReveal(..., kind: 'reveal')` in `apps/api/src/modules/credentials/routes.ts` — effective role >= `member`). This story does not introduce a parallel or looser permission check; sharing a value must never be possible for a caller who could not reveal it directly. Denied attempts return the same `403 INSUFFICIENT_PROJECT_ROLE` shape reveal already uses.

2. **Recipient must be an existing org member.** The share-creation endpoint accepts `recipientUserId` (not a free-text email — external-recipient sharing is Story 17.2's scope). The recipient must belong to the same org as the credential (looked up via existing org-membership data, same convention as `apps/api/src/modules/org/routes.ts` member listing) and must not be the sharer themselves (self-share is rejected with a clear `400` — sharing with yourself has no purpose and no product action requires it). Recipient must not be a deactivated org user (Story 4-3's deactivation state) — the endpoint rejects with `400 recipient_inactive` in that case (deactivation is checked at share-creation time; if a recipient is deactivated *after* a share is created but before it's viewed, AC-8 below still requires the access route to re-check and refuse the view, not just rely on the creation-time check).

3. **Field scoping reuses the existing `field_key` model.** An optional `fieldKey` may be supplied on share creation, scoped exactly like `credential_dependencies.field_key` (Story 13.4) and `rotations.target_fields`: `NULL` means "whole-credential value," a non-null value must match one of the credential's currently-defined template field keys (Story 13.2's field model) at creation time. If the field is later renamed or removed (Story 13.2 semantics), the share auto-expires rather than pointing at a stale/missing field — same principle the epic's Round 3 finding applied to Story 17.2, equally true here since 17.1 also allows field-scoped shares. (Full systematic enforcement of this auto-expiry across all access paths is completed by Story 17.3's "Expiry Enforcement" scope; this story's minimum bar is: the access-time read in AC-8 must check the field still exists and treat a missing field as expired, not throw a 500 or silently reveal `null`.)

4. **Bounded duration, configurable single-use or time-boxed.** At creation, the sharer sets an `expiresAt` (required, must be in the future, server enforces a maximum window — default and cap are a judgment call for the dev agent to document in the Dev Agent Record, informed by the sensitivity of secret material; recommend defaulting to 24h with a 7-day cap absent other product guidance) and a `singleUse` boolean (default `true`). A `singleUse: true` share is valid for exactly one successful reveal by the recipient; a `singleUse: false` share remains viewable (by the same recipient, still gated by AC-8's checks) until `expiresAt`, with every view recorded (AC-9) even though only the first sets `firstViewedAt`.

5. **Revocation.** The sharer (and any org admin — reuse the existing admin-can-manage-project-scoped-resources convention rather than inventing a new one) can revoke an `active` share at any time before it is consumed (single-use, already viewed) or has expired. Revoking a share that is already `viewed`/`expired`/`revoked`/`superseded` is a no-op that returns the share's current state, not an error — this avoids a confusing race where a sharer's revoke click and a recipient's view land within the same request window.

6. **New `credential_shares` table (migration 0059).** Create the table exactly as specified in `sprint-change-proposal-2026-07-24.md` §4.3: `id uuid PK, org_id, credential_id FK, field_key text nullable, shared_by user_id FK, recipient_type text CHECK IN ('user','external'), recipient_user_id uuid FK nullable, recipient_email text nullable, token_hash text NOT NULL, created_at, expires_at NOT NULL, revoked_at nullable, superseded_at nullable, first_viewed_at nullable, view_count int DEFAULT 0, status text CHECK IN ('active','viewed','revoked','expired','superseded')`. This story only ever writes `recipient_type = 'user'` rows with `recipient_user_id` set and `recipient_email` null — the `external`/`recipient_email` half of the table exists now (so 17.2 doesn't need a second migration touching the same table) but is unused and unreachable from this story's routes. RLS: `org_id`-scoped like every other table (standard policy, no exception needed — unlike 17.2's external bearer-token path, this story's access route is always an authenticated session request, so no RLS carve-out is required here).

7. **Tokenized link, but session-bound.** Per FR122, the share is still delivered as a tokenized link (a random token is generated at creation, only its hash — `token_hash` — is ever persisted, mirroring how the codebase already treats other bearer secrets such as session/refresh tokens). Unlike Story 17.2's external path, this story's link is opened by an **authenticated** recipient: the access route requires (a) a valid, unexpired, unconsumed token matching `token_hash`, **and** (b) the current session's `userId` equals the share's `recipient_user_id`. A mismatch on (b) — e.g. Riley forwards the link to someone else, or the wrong org member is logged in — is a `403`, not a `404` (the share's existence is not being hidden from a logged-in org member the way it would be from an anonymous party; this differs from 17.2's external-link threat model on purpose and should be called out as such in code comments to prevent someone "fixing" it to match 17.2 later).

8. **Reveal is two-step, never on first request.** The link's first GET returns share metadata only (credential name, sharer, field if scoped, expiry) — never the value — requiring an explicit second action (button click / distinct endpoint) to actually reveal, exactly like Story 17.2's Round 1 finding requires for external links. This story adopts the same two-step pattern even though the member-to-member threat model doesn't include link-unfurling crawlers, so the two epic stories share one UX/API shape rather than diverging for no product reason. The reveal-step response sets `Cache-Control: no-store`.

9. **Full audit trail (FR124).** Three new `AuditEvent` entries are added to `packages/shared/src/constants/audit-events.ts` following the existing dotted-lowercase convention: `CREDENTIAL_SHARE_CREATED: 'credential.share_created'`, `CREDENTIAL_SHARE_VIEWED: 'credential.share_viewed'`, `CREDENTIAL_SHARE_REVOKED: 'credential.share_revoked'`. Every creation, every successful reveal-step view (not just the first), and every revocation writes an audit entry via `writeHumanAuditEntryOrFailClosed` in the same transaction as the state change (fail-closed: if the audit write fails, the share creation/view/revoke must roll back — same guarantee the codebase already applies elsewhere, e.g. Story 16-2's theme selection). `(Expiry` as its own recorded event, and the `superseded` transition on rotation-promote, are Story 17.3's scope — not built here; this story's `expires_at` check at access time is a live/lazy check only, not a separate audited transition.)

10. **Recipient notification.** On share creation, the recipient is notified in-app via `dispatchDirectUserNotification` (`apps/api/src/notifications/dispatcher.ts`) using a new notification template (e.g. "A credential was shared with you") — reuse the existing per-user notification-preference/channel machinery rather than a new delivery path. This is a direct-to-recipient notification, not FR100's org-wide alert routing (that pattern stays reserved for org-admin-facing security alerts elsewhere in the codebase).

11. **Shares tab on credential detail (web UI).** A new **Shares** tab/section on `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/` lists shares the current user created for that credential (who it was shared with, created/expiry/viewed/revoked timestamps, current status) and offers a **Revoke** action on active shares, mirroring the existing rotation-history list/detail pattern for layout conventions (no existing generic "credential activity" component to extend — this is new UI, confirmed via codebase search). The **Share** creation flow (recipient typeahead scoped to org members, expiry picker, single-use toggle, one-time link display) is reachable from the credential detail page.

12. **Recipient reveal page (web UI).** A new authenticated route renders the two-step consent screen (AC-8) and the post-reveal value display for a share link, reusing the existing masked-value/reveal-button visual pattern already used for normal credential reveal (do not build a second bespoke reveal component).

13. **Route classification & RBAC.** All new `/api/v1` routes are registered via `secureRoute()`, classified in `ROUTE_ACTION_CLASSIFICATIONS` (`apps/api/src/lib/route-exemptions.ts`) — share creation and revocation as `security-action`, the metadata-GET and reveal-step as `sensitive-read` — and declare `minimumRole: 'member'` (not `allowedRoles`, per the Story 14-8 documented convention) for the project-scoped creation/revocation routes. `requireMfa` follows the existing rule (required only for `admin`/`owner`-gated routes); since this story's routes are member-level, no new MFA requirement is introduced, and this is a deliberate scope decision to document in the Dev Agent Record, not an oversight — if Nestor wants share-creation to require step-up MFA regardless of role given the sensitivity, that's a explicit follow-up, not silently added here.

14. **Atomic single-use claim (race-safety).** The reveal-step consumption of a `singleUse: true` share must be a single atomic conditional write — e.g. `UPDATE credential_shares SET status='viewed', view_count=view_count+1, first_viewed_at=COALESCE(first_viewed_at, now()) WHERE id=$1 AND status='active' RETURNING *` — never a read-then-branch-then-write sequence. Two concurrent reveal requests for the same single-use share must not both succeed; the loser gets the same "already viewed" response a genuinely-later request would get. (Surfaced by Security Audit Personas elicitation: a naive read-check-write implementation has a TOCTOU window under concurrent requests, the same class of race this codebase already guards against elsewhere via advisory locks / conditional updates, e.g. rotation's promote/retire idempotency.)

15. **Sharer deactivation implicitly revokes their outstanding shares.** When an org user is deactivated (Story 4-3's deactivation flow), any `active` share they created is transitioned to `revoked` as part of that same deactivation transaction, writing `CREDENTIAL_SHARE_REVOKED` with a reason distinguishing it from a manual revoke. This mirrors the epic's own security-review finding F6 (applied to Story 17.2's external shares) — the same reasoning applies here: a deactivated user should not have live outstanding grants of secret access sitting unrevoked. (Surfaced by Pre-mortem Analysis: an employee is deactivated mid-offboarding while several of their active shares are still viewable by recipients, and nothing in the original AC set closes that window.)

16. **Org-membership and active-status are re-checked at reveal time, not only at creation time.** If the recipient is removed from the org, or deactivated, between share creation and the reveal-step request, the reveal-step must re-validate and reject (same `403`/`400` shape as AC-2's creation-time check) rather than trusting a stale creation-time check. (Surfaced by Failure Mode Analysis: the TOCTOU window between creation and view is unbounded for non-single-use, time-boxed shares that may sit unviewed for the full expiry window.)

17. **Referrer-Policy on token-bearing pages.** Both the share-metadata page and the reveal-step page set `Referrer-Policy: no-referrer` and must not embed any third-party-loaded resource that could leak the URL (which carries the raw token) via its own outbound request. This is the same defense the epic's dedicated security review (F1) required for Story 17.2's external links; it applies equally here because browser Referer leakage of a bearer token in a URL is independent of whether the viewer is authenticated. (Surfaced by Architecture Decision Records elicitation, deciding the link-delivery shape stays consistent with 17.2 — see Dev Notes ADR below.)

18. **Notification failure never blocks share creation.** `dispatchDirectUserNotification` (AC-10) is a best-effort side effect of a successful share creation, not a precondition or a rollback trigger — if notification dispatch throws or the queue write fails, the share is still created and returned to the sharer (whose one-time link display is the guaranteed fallback distribution path), with a warning-level log entry, not a `5xx` to the sharer. (Surfaced by Failure Mode Analysis: coupling share creation to notification delivery would make an unrelated notification-infra outage block a security-sensitive but otherwise-healthy operation.)

19. **`token_hash` uniqueness and archival guard extension.** `credential_shares.token_hash` has a unique index (defense against an implementation ever colliding two live tokens, however astronomically unlikely by construction). Archiving a credential or its parent project while it has any `active` share is blocked or requires explicit confirmation, extending the existing project-archival dependency guard — which the epic's own Round 3 finding already generalized to cover "`staged` rotations and active shares" as a class, not just Story 17.2's not-yet-built shares. (Surfaced by Challenge from Critical Perspective: the original AC set silently assumed archival-guard coverage would arrive with 17.2/17.3, but the guard's generalization already exists in the approved proposal and there is no reason this story's own shares should be the ones left uncovered.)

## Tasks / Subtasks

- [x] Task 1: Database layer (AC: 6)
  - [x] 1.1 Add `packages/db/src/schema/credential-shares.ts` per AC-6's exact column/check-constraint spec, `orgScoped` helper, indexes on `(credential_id, status)` and `(recipient_user_id, status)` for the "my shares" / recipient-notification lookups
  - [x] 1.2 Migration `0059_credential_shares.sql` (drizzle-kit generate), additive-only, RLS policy matching the standard `orgScoped` pattern
  - [x] 1.3 Unit/integration coverage: constraint checks (recipient_type, status enums), org-scoping via RLS test suite pattern used elsewhere

- [x] Task 2: Audit events + notification template (AC: 9, 10)
  - [x] 2.1 Add `CREDENTIAL_SHARE_CREATED` / `CREDENTIAL_SHARE_VIEWED` / `CREDENTIAL_SHARE_REVOKED` to `packages/shared/src/constants/audit-events.ts`
  - [x] 2.2 Add a new notification template for "credential shared with you" following the existing `NotificationTemplate` shape used by `dispatchDirectUserNotification` callers

- [x] Task 3: Share creation + eligibility (AC: 1, 2, 3, 4, 18, 19)
  - [x] 3.1 `apps/api/src/modules/credential-shares/service.ts` — creation logic: reveal-gate reuse, recipient org-membership + active-status check, field_key validation against current template fields, expiry bounds, token generation (hash-only persisted, `token_hash` unique index), `singleUse` handling
  - [x] 3.2 `apps/api/src/modules/credential-shares/routes.ts` — `POST` create route, `secureRoute()`, classification, `minimumRole: 'member'`
  - [x] 3.3 Notification dispatch wrapped so failure never blocks/rolls back share creation (AC-18) — best-effort, warning-level log on failure
  - [x] 3.4 Extend the project/credential archival guard to block or require confirmation when `active` shares exist (AC-19)
  - [x] 3.5 Integration tests: happy path, insufficient-role denial (matches reveal's 403 shape), self-share rejection, deactivated-recipient rejection, invalid/removed field_key rejection, expiry-bound validation, notification-failure-does-not-block-creation, token_hash-unique-constraint, archival-blocked-with-active-share

- [x] Task 4: Recipient access (metadata + two-step reveal) (AC: 3 [field-missing-at-access], 7, 8, 9, 14, 16, 17)
  - [x] 4.1 `GET` share-metadata route: token+session-identity check (AC-7), returns metadata only, no audit event on metadata-only GET (only the actual reveal step is audited as a "view" per AC-9), `Referrer-Policy: no-referrer` (AC-17)
  - [x] 4.2 `POST` reveal-step route: atomic conditional-update claim for single-use consumption (AC-14), re-checks org-membership/active-status at reveal time (AC-16), increments `view_count`, sets `first_viewed_at`, checks field still exists (else treat as expired), `Cache-Control: no-store` + `Referrer-Policy: no-referrer`, writes `CREDENTIAL_SHARE_VIEWED`
  - [x] 4.3 Integration tests: session-mismatch 403, expired-at-access, single-use-already-consumed, concurrent-double-reveal-race (only one succeeds), recipient-deactivated-between-creation-and-view, field-removed-since-creation, `Cache-Control`/`Referrer-Policy` header assertions

- [x] Task 5: Revocation + shares listing (AC: 5, 11, 15)
  - [x] 5.1 `POST` revoke route (sharer or org admin), idempotent no-op semantics per AC-5
  - [x] 5.2 `GET` list-shares-for-credential route (used by the Shares tab)
  - [x] 5.3 Hook into Story 4-3's deactivation flow: auto-revoke the deactivated user's `active` shares in the same transaction, write `CREDENTIAL_SHARE_REVOKED` with a distinguishing reason (AC-15)
  - [x] 5.4 Integration tests: revoke-by-sharer, revoke-by-admin, revoke-by-unrelated-member denied, double-revoke no-op, deactivation-triggers-auto-revoke

- [x] Task 6: Route classification & RBAC wiring (AC: 13)
  - [x] 6.1 Register all new routes in `ROUTE_ACTION_CLASSIFICATIONS` and any `DIRECT_DB_ACCESS_CLASSIFICATIONS` needed
  - [x] 6.2 Confirm `route-audit.test.ts` passes with the new module

- [x] Task 7: Web UI — Shares tab + creation flow (AC: 11)
  - [x] 7.1 Shares tab/list component on credential detail page
  - [x] 7.2 Share-creation form (recipient typeahead scoped to org members, expiry picker, single-use toggle, one-time link display)
  - [x] 7.3 Revoke action wired to the revoke route

- [x] Task 8: Web UI — recipient reveal page (AC: 12)
  - [x] 8.1 New authenticated route rendering the two-step consent → reveal flow
  - [x] 8.2 Expired/consumed/mismatched-session states rendered honestly (no generic error page)

- [x] Task 9: openapi.json regeneration + contract tests
  - [x] 9.1 Regenerate `packages/shared/openapi.json` for all new routes including full 401/403/400/404/410 response documentation (this project's contract-parity CI gate has bitten Story 16-2 for exactly this omission — see Previous Story Intelligence below)

## Dev Notes

- **Reveal-gate reuse is the load-bearing security requirement of this story.** `rejectIfInsufficientProjectRoleForReveal` in `apps/api/src/modules/credentials/routes.ts` is the exact function normal reveal uses today (effective project role >= `member`). Share-creation eligibility must call this same function (or delegate to the same `effectiveProjectRole`/`roleRank` primitives) — do not write a second, parallel permission check that could drift out of sync with reveal's rules over time.
- **`field_key` modeling precedent:** `packages/db/src/schema/credential-dependencies.ts` (`fieldKey: text('field_key')`, nullable, no FK/CHECK) and `packages/db/src/schema/rotations.ts` (`targetFields: text('target_fields').array()`) are the two existing field-scoping patterns in this codebase. `credential_shares.field_key` should mirror `credential_dependencies`'s single-nullable-text-column shape, not the array shape (a share always targets at most one field or the whole credential).
- **Migration number:** latest on disk is `0058_users_selected_theme_name.sql` — this story is `0059`. Re-check for a newer number immediately before generating in case a concurrent worktree session claimed it first (this project has hit migration-number collisions between concurrent stories before, e.g. the 0043/0044/0045 three-way coordination noted in Story 3-5/3-6's sprint-status history).
- **Audit write pattern:** use `writeHumanAuditEntryOrFailClosed(secureCtx.tx, {...})` from `apps/api/src/lib/audit-or-fail-closed.js`, opting the route's `secureRoute()` wrapper out of its generic automatic audit write (`security: { writeAuditEvent: false }`) exactly as `apps/api/src/modules/rotation/routes.ts` does. `route-audit.test.ts`'s `assertAuditedActionOptOutsAreJustified()` requires this opt-out to be paired with an explicit same-transaction audit call — do not opt out without adding the explicit call, or CI will fail.
- **Route file structure:** default to one `routes.ts` per module with sibling `service.ts` (business logic/DB) — the split-file pattern (`selection-routes.ts`) Story 16-2 used is the exception, not the norm; follow `apps/api/src/modules/credentials/` or `apps/api/src/modules/rotation/`'s structure (`routes.ts` + `service.ts` + `db-helpers.ts` as needed), not theming's.
- **RBAC convention (Story 14-8):** use `minimumRole: 'member'` for a contiguous role threshold, not `allowedRoles: [...]`. `allowedRoles` is reserved for non-contiguous sets and is enforced by ESLint rule `no-contiguous-allowed-roles` — using it here for a plain "member or above" gate would trip that rule.
- **`route-audit.test.ts` enforcement mechanism** (not a literal "routes.ts must be thin" rule as informally described elsewhere in this project's memory, but functionally similar in effect): every `secureRoute()`-registered route must appear in `ROUTE_ACTION_CLASSIFICATIONS` with an `action` (`read` / `sensitive-read` / `mutation` / `security-action`) and audit metadata; any direct DB import inside `routes.ts` (rather than delegated to `service.ts`) must be separately justified in `DIRECT_DB_ACCESS_CLASSIFICATIONS`. Keep DB/business logic in `service.ts` to avoid needing that extra justification.
- **17.1 vs 17.2 threat model, explicitly:** this story's access route always requires an authenticated session belonging to the named recipient (AC-7) — there is no anonymous/bearer-only access path in this story, and no RLS exception is needed for `credential_shares` here (contrast with 17.2, which will need a documented RLS exception for its external unauthenticated token-bearer path, "same category... already precedented by `sessions`/`refresh_tokens`" per the epic's architecture note). Do not build 17.2's external-access RLS carve-out as part of this story — it's out of scope and premature.
- **Table is shared with 17.2 but this story only populates the `'user'` half.** `recipient_type = 'external'` and `recipient_email` are schema-ready but unreachable from this story's code paths; do not build any external-recipient UI/API surface here.
- **Expiry enforcement scope boundary:** this story's access-time check ("is `expires_at` in the past? treat as expired") is intentionally the minimum lazy check needed for AC-3/AC-8 to behave correctly, not a background job, not a dedicated `CREDENTIAL_SHARE_EXPIRED` audit event, and not the rotation-supersede interaction. All three of those are explicitly Story 17.3's scope ("Share History, Expiry Enforcement & Rotation-Recommended Nudge") — do not build them ahead of that story; note them as intentionally deferred in the Dev Agent Record rather than silently skipping them.
- **No existing "credential history"/generic activity-log UI exists to extend.** Confirmed via codebase search — the only precedent is the rotation-history list/detail route pair (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/` and its `[rotationId]/` detail page). Model the Shares tab's layout on that pattern for visual/structural consistency, but it is new code, not an extension of an existing shared component.
- **ADR — link-delivery shape (from Architecture Decision Records elicitation):** considered (A) a raw bearer token embedded in the notification/link URL, opened via `GET /shares/access/:token`, vs. (B) a pure in-app "Shares" inbox keyed by an opaque non-secret share id, with no bearer token ever appearing in a URL, since the recipient is always an authenticated org member in this story (unlike 17.2). **Decision: (A), with the Referrer-Policy/no-third-party-resource mitigations of AC-17**, because the epic's schema (`token_hash`) and FR122's "via a tokenized link" wording are shared with Story 17.2, and diverging 17.1's delivery shape from 17.2's would mean two different link/consent UX patterns in the same feature area for no product benefit — the marginal leak-surface reduction of (B) is judged not worth that inconsistency, especially since (A) already gets the header/no-third-party-resource mitigations regardless.
- **Race-safety pattern:** AC-14's atomic conditional update is the same category of fix Story 5-6 already applied to promote/retire idempotency (an `UPDATE ... WHERE status = '<expected>' RETURNING`, not a separate advisory lock) — prefer that lighter-weight pattern here too rather than introducing a new locking primitive, since the write is a single-row conditional transition, not a multi-row transaction like rotation promote/retire.
- **`prd.md`/`epics.md` do not yet contain Epic 17 / FR122-125 text.** The only source of truth for this epic today is `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md` §4.1/§4.2/§4.3 (approved 2026-07-24) plus the dedicated security review `_bmad-output/planning-artifacts/epic-17-external-share-token-security-review-2026-07-27.md` (whose F1-F4 findings are scoped to 17.2's external/token path per that document's own framing and the sprint-status log — re-verify at dev time whether any of F1-F4 also bind 17.1's session-authenticated path, but they were written against the unauthenticated external-link threat model this story does not have). Applying the doc-sync fix (adding FR122-125/Epic 17 text to `prd.md`/`epics.md`) is out of scope for this story unless it becomes a blocking review finding.

### Project Structure Notes

- New backend module: `apps/api/src/modules/credential-shares/` (`routes.ts`, `service.ts`), following the `credentials`/`rotation` module convention, not the `theming` split-file convention.
- New DB schema file: `packages/db/src/schema/credential-shares.ts`; migration `packages/db/src/migrations/0059_credential_shares.sql` (verify number is still free at dev time).
- New web routes: a Shares tab/section within the existing credential detail page tree, plus one new authenticated recipient-facing route for opening a share link (path TBD by the dev agent, follow existing `(app)/...` route-group conventions — this is not a public/unauthenticated route despite being "a link," per AC-7).
- No conflicts detected with in-flight work in other epics — Epic 16 (theming) and Epic 13 (field_key model, a dependency not a conflict) are independent of this module.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md#4.1-4.3, #7 Round 1/2/3/4] — FR122-125, `credential_shares` schema, all elicitation findings this story's ACs incorporate
- [Source: _bmad-output/planning-artifacts/epic-17-external-share-token-security-review-2026-07-27.md] — dedicated security review gating Epic 17 story creation (F1-F4 primarily bind Story 17.2's external path; re-verify applicability at dev time)
- [Source: apps/api/src/modules/credentials/routes.ts#rejectIfInsufficientProjectRoleForReveal] — reveal-permission gate reused by AC-1
- [Source: packages/db/src/schema/credential-dependencies.ts, packages/db/src/schema/rotations.ts] — `field_key`/`target_fields` precedent for AC-3
- [Source: apps/api/src/modules/rotation/routes.ts] — `writeHumanAuditEntryOrFailClosed` + `security: { writeAuditEvent: false }` opt-out pattern for AC-9
- [Source: apps/api/src/lib/route-exemptions.ts] — `ROUTE_ACTION_CLASSIFICATIONS`, `DIRECT_DB_ACCESS_CLASSIFICATIONS` for AC-13/Task 6
- [Source: _bmad-output/planning-artifacts/architecture.md#Story-14-8-RBAC-convention] — `minimumRole` vs `allowedRoles` convention for AC-13
- [Source: apps/api/src/notifications/dispatcher.ts#dispatchDirectUserNotification] — recipient notification for AC-10
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Previous Story Intelligence

- Story 16-2 (most recently `done`, immediately preceding this story's creation) hit a CI failure specifically because new routes' non-200 responses (401/422/400) were left undocumented in `packages/shared/openapi.json`, breaking the contract-parity test — fixed by explicitly adding every real error-response schema before regenerating. Task 9 above exists to prevent this story from repeating that same mistake: document 401/403/400/404/410 for every new route up front, not just the happy-path 200/201.
- Story 16-2 also established the precedent of opting a route out of `secureRoute()`'s generic audit write via `security: { writeAuditEvent: false }` when the audit payload needs handler-computed data the generic mechanism can't see — directly applicable here since share creation/view/revoke all need custom payload shapes (share id, recipient, field_key, etc.).
- Story 13.4 (field_key-scoped rotation checklist filtering) is the most recent story to have worked with `field_key` semantics end-to-end and confirmed the "NULL = whole-credential" convention holds across the codebase — no additional field_key precedent-hunting should be needed beyond what's already cited in Dev Notes above.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via `/bmad-dev-story`.

### Debug Log References

- Migration number re-verified immediately before use: `0059` was still free (0058 was the latest on disk); journal entry added by hand (`packages/db/src/migrations/meta/_journal.json`) since `drizzle-kit generate` failed in this worktree with a pre-existing, unrelated snapshot-chain collision (`0031_snapshot.json` / `0032_snapshot.json`, present before this story started). `guarded-migrate.ts` reads only the journal + `.sql` files (not drizzle-kit snapshots), so this does not affect migration application — confirmed by a full `make docker-up` run applying `0059_credential_shares` cleanly alongside 0000–0058.
- `pnpm generate-spec` + `packages/api-contract-tests` run twice: first pass caught a missing `422` on `POST .../shares` (Fastify's own body-schema validation on a missing body returns 422, not one of the 400/401/403/404/410 set originally documented) — exactly the Story 16-2 contract-parity trap called out in Previous Story Intelligence. Fixed by adding `422: ApiErrorSchema` and regenerating.
- `route-audit.test.ts`'s per-file prefix-resolution logic maps one imported route-registrar file to exactly one `app.ts` prefix; registering `credentialSharesRoutes` (prefix `/api/v1/projects`) and `credentialShareAccessRoutes` (prefix `/api/v1/shares`) from the same source file collapsed both prefixes into one and mis-scoped the shares routes. Fixed by splitting the recipient-facing access routes into their own file (`access-routes.ts`), each file registered with its own prefix.

### Completion Notes List

- **Judgment call (AC-4 defaults):** share expiry defaults to 24h, capped at 7 days (`SHARE_DEFAULT_TTL_MS` / `SHARE_MAX_TTL_MS` in `apps/api/src/modules/credential-shares/schema.ts`) — the story's own recommended default, adopted as-is absent other product guidance. The web UI's create form exposes an "expires in (hours)" input (1–168) rather than a default+cap the user cannot see.
- **Schema reconciliation (flagged, not silently guessed):** AC-6's literal `credential_shares` column list (per `sprint-change-proposal-2026-07-24.md` §4.3) does not include a single-use/multi-view flag, but AC-4 requires the reveal-step to behave differently for `singleUse: true` vs `false` shares. Added a `single_use boolean NOT NULL DEFAULT true` column as a necessary, additive extension to the literal spec — documented inline in `packages/db/src/schema/credential-shares.ts` and the migration SQL, not silently inferred from `status` alone.
- **Deliberate scope decision (token hashing secret):** `token_hash` is computed via HMAC-SHA256 using the existing `INVITATION_TOKEN_HMAC_SECRET` with a `credential_share:` domain-separation prefix, rather than introducing a new dedicated `CREDENTIAL_SHARE_TOKEN_HMAC_SECRET` env var and its full production-validation/docker-compose/`.env.example` surface (the precedent every other bearer-token type in this codebase follows). This keeps the story's scope bounded; if Nestor wants a fully independent secret for defense-in-depth, that's a follow-up, not an oversight.
- **Deliberate scope decision (no step-up MFA on share creation, AC-13):** `requireMfa` is not set on the share-creation/revocation routes — they are `minimumRole: 'member'`, and this codebase's convention only requires MFA for `admin`/`owner`-gated routes. Flagged per AC-13's own text as an explicit decision, not an oversight.
- **F1-F4 applicability (epic security review) re-verified at dev time:** the dedicated `epic-17-external-share-token-security-review-2026-07-27.md` findings are written against Story 17.2's unauthenticated external-link threat model. This story's access route always requires an authenticated session belonging to the named recipient (AC-7), so those findings do not directly bind this story's implementation; AC-17's Referrer-Policy requirement (independently applicable regardless of auth) is implemented on both the metadata-GET and reveal-step routes.
- **Deferred to Story 17.3 (per Dev Notes' explicit scope boundary):** no dedicated `CREDENTIAL_SHARE_EXPIRED` audit event, no background expiry-sweep job, and no rotation-supersede interaction. This story's expiry handling is the minimum lazy/live check AC-3/AC-8 require (checked at access time, transitions `active` → `expired` on the read that discovers it past-due).
- **Web UI scope:** the Shares tab is a new section on the existing credential detail page (no separate list route exists for rotations either — same convention). The recipient reveal page lives at `/shares/[token]` under the authenticated `(app)` route group (AC-7 — not a public/unauthenticated route despite being "a link").
- All 19 ACs implemented and covered by integration/unit tests except: no dedicated HTTP-level integration test asserts the *project-archive* route's new `active_shares` 409 (the underlying `findBlockingShareIds` guard is covered directly by 4 new unit tests in `archive-guards.test.ts`, mirroring the existing untested-at-HTTP-level pattern for the rotation/machine-key blocking guards in that same file).
- Full test run (affected modules): `apps/api` credential-shares/org/projects/rotation/route-audit suites — 416 tests passed. `packages/api-contract-tests` — 420 tests passed. `apps/web` full suite — 1766 tests passed. `pnpm generate-spec` produces a diff-free-on-rerun `packages/shared/openapi.json`.

### File List

**New files:**
- `packages/db/src/schema/credential-shares.ts`
- `packages/db/src/migrations/0059_credential_shares.sql`
- `apps/api/src/modules/credential-shares/schema.ts`
- `apps/api/src/modules/credential-shares/service.ts`
- `apps/api/src/modules/credential-shares/routes.ts`
- `apps/api/src/modules/credential-shares/access-routes.ts`
- `apps/api/src/modules/credential-shares/routes.test.ts`
- `apps/api/src/notifications/templates/credential-share-created.ts`
- `apps/web/src/lib/api/credential-shares.ts`
- `apps/web/src/routes/(app)/shares/[token]/+page.server.ts`
- `apps/web/src/routes/(app)/shares/[token]/+page.svelte`
- `apps/web/src/routes/(app)/shares/[token]/share-access-page.server.test.ts`
- `apps/web/src/routes/(app)/shares/[token]/share-access-page.test.ts`

**Modified files:**
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/shared/src/constants/audit-events.ts`
- `packages/shared/src/schemas/api.ts`
- `packages/shared/openapi.json`
- `apps/api/src/app.ts`
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/modules/credentials/routes.ts` (exported `rejectIfInsufficientProjectRoleForReveal`, `rejectIfProjectNotVisible`)
- `apps/api/src/modules/org/routes.ts` (AC-15 deactivation hook)
- `apps/api/src/modules/org/schema.ts` (`revokedShareCount` on deactivate response)
- `apps/api/src/modules/org/deactivation.routes.test.ts` (new AC-15 test)
- `apps/api/src/modules/projects/archive-guards.ts` (AC-19 `findBlockingShareIds`)
- `apps/api/src/modules/projects/archive-guards.test.ts` (new AC-19 tests)
- `apps/api/src/modules/projects/routes.ts` (AC-19 archive-route wiring)
- `apps/api/src/notifications/templates/index.ts` (registered new template)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts` (Shares tab data)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (Shares tab UI)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.server.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts`

## Change Log

- 2026-07-28: Implemented via `bmad-dev-story`, TDD red-green throughout (new backend module, migration, web UI). All 9 tasks/34 subtasks complete, all 19 ACs implemented. Status: `ready-for-dev` → `review`; sprint-status.yaml synced in the same change (P3).
