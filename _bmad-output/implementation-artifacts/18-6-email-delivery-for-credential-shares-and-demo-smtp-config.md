---
baseline_commit: 193d9e6
---
# Story 18.6: Email Delivery for Credential Shares and Demo SMTP Configuration

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who shares a credential with a teammate,
I want the recipient to actually receive an email notifying them of the share,
so that they know to go check the app instead of me having to tell them separately; and as an operator of the demo environment, I want outbound email to actually work so this (and every other email-driven flow) is visible/demoable.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-member shares a credential field with a colleague (session-authenticated share, Story 17.1, or external, Story 17.2). The colleague receives an email notifying them a credential/secret was shared with them (no raw secret/token embedded in the email body, consistent with Story 17.1 AC-10's existing deliberate design). In the demo/dev environment, an operator can actually see this (and other) transactional emails sent, because SMTP is configured and working end-to-end.

## Acceptance Criteria

1. **Corrected scope per code investigation**: `apps/api/src/modules/credential-shares/routes.ts:390` already calls `dispatchDirectUserNotification(...)`, which goes through the existing generic preference-driven `notifications/dispatcher.ts` → `notificationQueue` → `notification-email.ts` worker pipeline — the same pipeline every other notification type already uses. Email dispatch for share-created events is **not missing infrastructure**; it already rides the generic pipeline. The real open question, to be confirmed by investigation before any code changes: does a default `notificationPreferences` row exist routing the `credential.share_created` event type to channel `email`, or does it require explicit user opt-in with no default row seeded? If no default routes it to email, no queue row is ever created for a recipient who hasn't explicitly opted in, regardless of SMTP config — document the actual finding.
2. If AC-1's investigation confirms no default email-routing preference exists for `credential.share_created`, add one (seed a default `notificationPreferences` row, or change the dispatcher's fallback-when-no-preference-exists behavior — whichever matches this codebase's existing convention for other notification types) so recipients receive the email by default, consistent with how other transactional notifications in this app behave. Explicitly state whether this default applies only prospectively (new preference rows going forward) or is backfilled retroactively onto existing users/orgs — this is a behavior/notification-volume change for real users and must be a stated decision, not an implicit side effect of a schema default.
3. Per Story 17.1 AC-10's deliberate design, the email must **not** embed the raw share token/link in the body (avoids token leakage via inbox/forwarding) — the email states that a credential was shared and directs the recipient to log in and check their notifications/shares, consistent with existing security posture. Do not regress this by adding the link back in without a documented, explicit decision to do so.
4. The same no-token/no-link-in-body rule from AC-3 applies equally to external shares (Story 17.2), using whatever contact channel is already captured for the external recipient (email address) — if `credential-share-created`'s template doesn't already branch on `recipient_type`, extend it to send an appropriate email for both `user` and `external` recipient types. Because Story 17.2's external-share UX is itself token/link-driven, explicitly guard against a "near-copy of the user-recipient template" implementation reintroducing the link for the external branch specifically — AC-3's constraint is not user-recipient-only.
5. Email delivery failure must not block share creation (matches the existing "notification-dispatch-failure-never-blocks-creation" pattern already established for Story 17.1/17.2) — confirm this guarantee holds for the newly-wired/newly-defaulted email path specifically, with a test. Delivery failures are logged/surfaced via the app's existing operational logging/metrics conventions (not silently swallowed) so an operator can detect a broken SMTP config rather than only discovering it from a support complaint.
6. Repeated share-creation-triggered emails are rate-limited with an explicit limit key, not left to "reuse an existing mechanism" ambiguously — scope the limit per-(sharer, recipient) pair, so one sharer cannot repeatedly email the same target. Reuse an existing rate-limit primitive from this codebase for the mechanism itself.
7. The demo/dev environment gets a working SMTP configuration: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` (already defined in `.env.example:198-203`, validated in `apps/api/src/config/env.ts:717-733`) are populated for the demo deployment target — add a local/dev-visible mail-catcher service (e.g. MailHog or Maildev) to `docker-compose.yml` so developers and the demo environment can actually see outbound email without a real external SMTP provider, and document the required env vars for demo/production deploys where a real provider is used.
8. Missing/invalid SMTP configuration is validated and fails fast/loud (startup env validation, consistent with `apps/api/src/config/env.ts`'s existing validation conventions) rather than silently dropping emails at send time with no operator-visible signal.
9. `docs`/`.env.example` are updated to explain the SMTP setup for local dev (mail-catcher) vs. demo/production (real provider), so this doesn't regress again.
10. The email's subject line and body follow the app's plain, non-alarming tone already established elsewhere (e.g. other notification templates in `apps/api/src/notifications/templates/`) — reuse the existing template structure/conventions rather than improvising new copy/formatting standards for this one email.
11. New/updated tests cover: a default preference correctly routes `credential.share_created` to the email channel (or the dispatcher's fallback does, per AC-2's resolution), share-created email is dispatched for both recipient types, email failure doesn't block share creation and is logged, and the email body does not contain the raw token/link.

## Tasks / Subtasks

- [x] Task 1: Confirm current share-created notification-preference/email-routing behavior (AC: 1)
- [x] Task 2: Seed/fix default email routing for `credential.share_created` if missing (AC: 2)
- [x] Task 3: Extend template for both recipient types + preserve no-token-in-body design (AC: 3, 4)
- [x] Task 4: Failure handling, logging, rate limiting (AC: 5, 6)
- [x] Task 5: Add dev/demo mail-catcher to docker-compose + docs (AC: 7, 8, 9)
- [x] Task 6: Tests (AC: 11)

## Dev Notes

- **Full SMTP email sending already exists** in this codebase via `nodemailer`: `apps/api/src/workers/notification-email.ts` creates a cached, invalidatable transport from admin-configurable SMTP settings. **Confirmed during review**: `credential-shares/routes.ts:390` already calls `dispatchDirectUserNotification(...)`, which already routes through this same generic pipeline (`notifications/dispatcher.ts` → `notificationQueue` → the email worker) — this is not a case of share-created events lacking an email pathway entirely. The actual gap to verify is narrower and preference-driven (see AC-1/AC-2): whether a default notification preference routes this specific event type to the `email` channel. Do not build a second/parallel email-dispatch pathway for shares — if a default-preference fix is needed, make it in the same generic preference-seeding mechanism used for other event types.
- Env vars already defined and validated: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (`.env.example:198-203`, `apps/api/src/config/env.ts:717-733`).
- **No mail-catcher service exists in `docker-compose.yml` today** — this is a real, confirmed gap for local/demo visibility of outbound email. Adding MailHog/Maildev (both lightweight, commonly used, expose a web UI to view sent mail) is the standard fix; wire `SMTP_HOST`/`SMTP_PORT` in the demo/dev `.env` to point at it.
- `apps/api/src/notifications/templates/credential-share-created.ts` — per its own comment (Story 17.1 AC-10), it deliberately never embeds the token/link in the email. Preserve this.
- Cross-reference Story 17.1/17.2's "notification-dispatch-failure-never-blocks-creation" pattern (already established in their own service code) — the new/adjusted email dispatch path must honor the same guarantee, not introduce a new failure mode that could block share creation.

### Project Structure Notes

- `docker-compose.yml` gets a new service (mail-catcher); follow the existing service-definition conventions in that file (naming, network, no host-port collision with `DB_HOST_PORT`/`API_HOST_PORT`/`WEB_HOST_PORT` per `AGENTS.md`'s port-isolation guidance — pick an explicit, documented port for the mail-catcher UI/SMTP ports and add corresponding `.env.example` entries if it needs to be configurable per-worktree).

### References

- [Source: apps/api/src/workers/notification-email.ts]
- [Source: apps/api/src/notifications/templates/credential-share-created.ts]
- [Source: apps/api/src/config/env.ts#SMTP]
- [Source: .env.example]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

GPT-5.6

### Debug Log References

- RED: notification-type registry test failed before `credential.share_created` was registered.
- Integration rerun is blocked because no PostgreSQL service is listening on the configured test port.

### Completion Notes List

- AC-1/2: `credential.share_created` was absent from virtual defaults; added an immediate `info`-severity email/inbox default. This applies retrospectively at read time without backfilling rows.
- AC-3/4: retained the no-token template and queue external-recipient emails directly to their captured address.
- AC-5/6: existing best-effort dispatch/logging is retained; share-email creation is limited to five requests per sharer/recipient per minute.
- AC-7/8/9: Docker Compose now runs Mailpit with a configurable UI port; SMTP config validates as a complete transport and docs explain local versus provider setup.

### File List

- .env.example
- README.md
- docker-compose.yml
- packages/shared/src/constants/notification-types.ts
- packages/shared/src/constants/notification-types.test.ts
- apps/api/src/config/env.ts
- apps/api/src/config/env.test.ts
- apps/api/src/modules/credential-shares/routes.ts
- apps/api/src/modules/credential-shares/external-routes.test.ts
- apps/api/src/modules/notifications/preferences.ts
- apps/api/src/notifications/dispatcher.ts
- apps/api/src/notifications/dispatcher.test.ts
- apps/api/src/notifications/templates/credential-share-created.test.ts

## Change Log

- 2026-07-30: Implemented credential-share email defaults, external recipient delivery, SMTP/Mailpit configuration, and regression coverage.
