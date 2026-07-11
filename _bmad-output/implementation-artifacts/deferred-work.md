# Deferred Work

Tracked gaps: work intentionally deferred, not yet implemented, or needing follow-up.  
**Product Surface Contract:** API-only items here must have a linked story before parent stories/epics close — see `_bmad-output/implementation-artifacts/product-surface-contract.md`.

**Full reconciliation pass, 2026-07-09:** every "Open"/unresolved item in this document was checked
against the actual current code and `sprint-status.yaml` (many referenced epics that have since
shipped `done`). Stale entries whose underlying gap was already closed by later work are marked
resolved in place. Every item still genuinely open with no previously-stated reason to skip it was
scheduled into one of five new backlog stories (`3-5-credential-expiry-notification-delivery`,
`2-9-credential-project-web-ui-completeness`, `10-1-playwright-e2e-test-automation`,
`4-5-fine-grained-permissions-and-project-rbac`, `1-13-infra-and-process-hardening` — all
`ready-for-dev` in `sprint-status.yaml`, each created + adversarially reviewed in its own worktree
following the same pattern as `9-8`). Doc-only drift (architecture.md naming, a couple of stale
epics.md notes, the retention-purge runbook gap) was fixed directly in this same pass rather than
opening a story. Items with an already-stated acceptance rationale (e.g. explicit "Deferred:
\<reason\>" code-review notes, Epic 6 retro's TD6-1/TD6-2/TD6-3, `withOrgReadScope` design debt) were
left as-is — see each item for its specific rationale.

---

## Deferred from: Epic 1 retrospective (2026-06-30)

Retro commitments **D1–D2, P1–P5** implemented 2026-06-30:

| ID | Item | Status |
|----|------|--------|
| D1 | Operator quickstart (`docs/operator-quickstart.md`) | ✅ Done |
| D2 | `scripts/operator-bootstrap.sh` + `make bootstrap` | ✅ Done |
| P1 | MFA policy matrix | ✅ Done |
| P2 | AC-E1c updated in `epics.md` (Option A) | ✅ Done |
| P3 | `mfa-journey.integration.test.ts` | ✅ Done |
| P4 | Story 4.1 stub + FR57 journey AC | ✅ Stub |
| P5 | Mandatory adversarial review in code-review step-02 | ✅ Done |

### Open (Epic 1 retro)

| ID | Item | Owner | Target |
|----|------|-------|--------|
| D4 | `migrate` service rebuilds full API builder on every cold `docker compose up` | Dev | **Scheduled 2026-07-09** as `1-13-infra-and-process-hardening` (backlog, `sprint-status.yaml`) |
| D5 | Full production operator runbook | Tech Writer / Ops | ✅ Done — `docs/runbook.md` (Story 9.5, done 2026-07-07) |

**D4:** One-shot `migrate` uses `apps/api/Dockerfile` `builder` target — slow first boot. Dev path: `make bootstrap` avoids full stack rebuild when only DB is needed.

---

## Deferred from: Epic 2 closure retrospective (2026-06-30)

Epic 2 is `done` (Stories 2.0–2.8). Items below are **not** blockers for Epic 3 notification infrastructure unless noted.

### Open retro action items

| ID | Item | Owner | Target |
|----|------|-------|--------|
| P4 | Epic 1 retrospective or documented waiver | Nestor | ✅ Done — `epic-1-retro-2026-06-30.md` |
| E3-1 | SMTP config split: Story 3.1 env vars vs AC-E3a Epic 9 system settings | Architect / PO | ✅ Closed (Story 3.4) — env-var SMTP config is the MVP path (Story 3.1 AC); Epic 9 (`FR86`) adds an admin system-settings UI on top without breaking the env-var fallback |
| E3-2 | FR73 `PENDING_DELIVERY` → `notification_queue` integration test | Dev | ✅ Resolved 2026-07-09 by `3-5-credential-expiry-notification-delivery` — `notification-backfill.test.ts` now asserts queue-row dispatch (`boss.send('notification/deliver', ...)`), a direct `deliverNotification()` terminal-delivery path, and the `boss.isStarted() === false` negative case |
| D1 | Reconcile `architecture.md`: `secrets` tables/endpoints → `credentials` naming | Tech Writer | ✅ Done 2026-07-09 — direct doc reconciliation (this pass); see `architecture.md`'s Naming Patterns / Canonical Schema Entity Names / API Endpoint Naming / Value Revelation Endpoint sections |
| D2 | Operator runbook: `CREDENTIAL_RETENTION_DRY_RUN` → destructive purge rollout | Dev / Ops | ✅ Done 2026-07-09 — `docs/runbook.md` § "Credential Version Retention" (this pass) |

### Partial epic acceptance criteria (honest zeros until later epics)

| AC / area | Status | Blocked by | Notes |
|-----------|--------|------------|-------|
| AC-E2d — projects with overdue rotations | ✅ Resolved — real `count`/`items` via `computeUpcomingRotations` | — | Landed with Epic 5's rotation work; this row was stale (never updated after Epic 5 shipped) |
| AC-E2d — unresolved alert count on org dashboard | ✅ Live (Story 3.4) — real `security_alerts` count | — | Was hardcoded `0`; resolved by AC-10 |
| Project dashboard — `upcomingRotations`, `monitoredServiceHealth` | ✅ Resolved — real data via `computeUpcomingRotations` / `getBatchedProjectServiceHealthStats` (`apps/api/src/modules/projects/dashboard-stats.ts`) | — | This row was stale; both fields have been wired to real data since Epic 5/6 shipped |
| Project dashboard — `recentAccessEvents` | ✅ Resolved — real `audit_log_entries` data via `getRecentAccessEventsForProject` (`apps/api/src/modules/projects/recent-access-events.ts`); "Recent activity" section added to `+page.svelte` | — | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Project dashboard — `DashboardPlaceholderGrid` renders unconditionally, even on a fully-populated project dashboard, with stale "Story 2.1" copy | ✅ Resolved — `hasCredentials`/`hasServices` props now gate the Credentials/Services cards; stale "Story 2.1" Coverage-gaps copy replaced | — | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Project dashboard — `suggestedActions` partial completion | ✅ Resolved — `buildProjectDashboard` now returns a targeted single-category suggestion (`add_service` or `add_credential`+`import_credentials`) for partially-covered projects, and `[]` for fully-covered ones | — | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Credential expiry **notifications** | ✅ Resolved — daily pg-boss worker + dispatcher/preferences/queue delivery landed in Story 3.5 | — | 2026-07-09: `credential/expiry-alert` now reuses the shipped expiry-alert shared runner and existing `notification_queue`/dispatcher path end-to-end; follow-up gaps moved to the Story 3.5 section below instead of leaving this as an honest-zero |

### Web UI gaps — API exists, web incomplete (Epic 2 surface)

| Capability | API story | Web status | Suggested follow-up |
|------------|-----------|------------|---------------------|
| Tag filter on credential list | 2.3 | ✅ Resolved — `tags` filter added to the credential list query params + filter form UI | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Project tag management (FR95) | 2.3 | ✅ Resolved — `tags` on `GET /projects`, `updateProjectTags` client + edit-tags control on `/projects` | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Credential lifecycle PATCH (`expiresAt`, `rotationSchedule`) | 2.4 | ✅ Resolved — Lifecycle edit form added to the credential detail page | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Dependent systems (list/create/archive) | 2.4 | ✅ Resolved — "Dependent systems" list/add/archive UI added to the credential detail page | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Add credential version (new value) | 2.2 | ✅ Resolved — "Add new version" form added to the credential detail page's Secret value section | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Onboarding Step — "Invite your team" | 2.6 | ✅ Resolved — link now deep-links to the project-scoped `/projects/{id}/members` page (falls back to plain text when no project exists) | Landed 2026-07-09 in `2-9-credential-project-web-ui-completeness` |
| Playwright E2E suite | — | Not implemented (2.8 out of scope) | **✅ Resolved 2026-07-10** in `10-1-playwright-e2e-test-automation` — 22 ACs across infrastructure (`apps/web/e2e/`, `playwright.config.ts`, `make e2e`, nightly.yml's `e2e` job) and 4 selected critical journeys (register→onboard→credential→reveal; invite→accept→role-gating; MFA enrollment→login challenge; rotation initiate→checklist→complete). A 5th+ journey and multi-browser coverage remain a natural follow-up (see that story's Dev Notes). |
| Rotation workflow (initiate, checklist confirm/fail/retry/complete, break-glass) | 5.1/5.2/5.3 | API-only — no dedicated web story exists (unlike Epic 2's API+web pairing); 5.1's Product Surface Contract flagged this decision as due before `epic-5-retrospective` | **Resolved 2026-07-05 (Epic 5 retro):** scheduled as `5-4-rotation-workflow-web-ui` (backlog, `sprint-status.yaml`) rather than deferred indefinitely — `epic-5` held `in-progress` until it lands |
| Epic 5 retro risk/gap/contradiction/technical-debt audit (12 findings: self-attestation, reveal-regression safety net, break-glass idempotency, NULL `initiatedBy`, malformed cron handling, unbounded dashboard scan, missing `org_id` index, background-job audit-failure handling, missing CAS on `abandon`, ambiguous audit payload, missing rollback tests, missing version IDs on `rotation.completed`) | 5.2/5.3 adversarial reviews (medium/low findings left "not blocking") | Documented in `epic-5-retro-2026-07-05.md`'s Significant Discovery Alert | **Tracked as Story 5.5** (`5-5-epic-5-completion-rotation-hardening-and-technical-debt.md`, `ready-for-dev`) — AC-2 through AC-13 |
| Monitored-asset management (services/certificates/domains CRUD) | 6.1 | API-only — no dedicated web story exists; 6.1's Product Surface Contract flagged this as due before `epic-6-retrospective`; `dashboard-copy.ts`'s `add_service` label still says "available in Epic 6" though the epic shipped without it | **Resolved 2026-07-06 (Epic 6 retro):** scheduled as `6-4-epic-6-completion-monitored-asset-management-ui-and-technical-debt` (backlog, `sprint-status.yaml`) — `epic-6` held `in-progress` until it lands |
| Machine-user management (create/list machine users, issue/list/revoke API keys, rotation, dormancy alerts) | 7.1/7.2 | API-only — no dedicated web story exists anywhere in `epics.md` (Epic 7, 8, or 9); both 7.1's and 7.2's Product Surface Contract sections flagged this as "a genuine planning gap" and said it should be escalated, but neither was turned into a tracked entry until the Epic 7 retro | **Resolved — shipped as `8-6-epic-7-completion-machine-user-web-ui-and-hardening`** (done 2026-07-07); retroactive adversarial review shipped as `8-8-story-8-6-retroactive-adversarial-review` (done 2026-07-08); `epic-7` flipped to `done` 2026-07-09 |
| Audit/compliance management (audit log search/filter/export/forwarding/retention config, point-in-time access-report UI, dormant-user alert admin actions, erasure-request review→confirm→execute flow) | 8.1/8.2/8.3/8.4 | API-only — no dedicated web story exists anywhere in `epics.md`; all four stories' Product Surface Contract sections flagged this identically and each deferred resolution to "Epic 8 sprint planning/retrospective," but it sat untracked through all four stories until the Epic 8 retro | **Resolved — shipped as `8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt`** (done 2026-07-08); `epic-8` flipped to `done` 2026-07-09 |
| Platform operations admin UI (backup/restore admin screen, system settings SMTP/policy/schedule UI, version-upgrade trigger/API-docs browser within app shell, Platform Operator Audit Log distinct from per-org log per PJ9, resource-usage dashboard with threshold indicators) | 9.1/9.2/9.3/9.4/9.6 | API-only — all five stories' Product Surface Contract sections flagged this identically and each deferred resolution to "Epic 9 sprint planning/retrospective" (same 4-times-recurrent pattern as Epics 5/6/7/8 — see `epic-9-retro-2026-07-08.md` Finding 1, [REPEAT 4x]); no deferred-work.md row existed until the Epic 9 retro | **Resolved — shipped as `9-7-epic-9-completion-platform-operations-web-ui`** |

### Shell placeholders (future epics — tracked, not silent)

| Route | Current state | Epic |
|-------|---------------|------|
| `/alerts` | ✅ Resolved (Story 3.4) — server redirects (308) to `/notifications`, the canonical inbox route from Story 3.3; placeholder page deleted | — |
| `/health` | ✅ Resolved (Story 6.3) — real cross-project health dashboard; removed from `placeholder-copy.ts` (this row was stale — the removal already happened, the doc was never updated) | — |
| `/settings` | ✅ Resolved (Story 9.7) — real settings hub linking to notifications/users/security/audit; removed from `placeholder-copy.ts` (this row was stale) | — |

**Stale copy:** `apps/web/src/lib/components/shell/placeholder-copy.ts` — `projects` blurb still references "Story 2.1"; `credentials` key unused by routes (gateway page is real). **Scheduled 2026-07-09** as `1-13-infra-and-process-hardening` (backlog, `sprint-status.yaml`).

### Operations & production

- **`CREDENTIAL_RETENTION_DRY_RUN`:** Production defaults to dry-run; operators must explicitly enable destructive version purge after verification (`apps/api/src/workers/prune-credential-versions.ts`). No runbook yet (D2).
- **Retention worker:** Rotation-in-progress version exemption enforced; operator rollout procedure not documented.

### Planning document reconciliation

| Document | Drift | Resolution |
|----------|-------|------------|
| `architecture.md` | `secrets` table names, `idx_secrets_*`, POST reveal patterns | D1 — align to `credentials` / `GET .../value` |
| `epics.md` | Story 2.0 MFA deferral note stale (1.12 shipped) | Periodic epic doc reconciliation |
| `epics.md` | Beta cuts FR9/FR17/FR80 marked deferrable but implemented | Document as scope expansion, not bug |
| `epics.md` | `audit_events` table name (~23 references, Epic 8 section) vs. shipped `audit_log_entries` — deliberate, reconciled decision (Story 7.1 D9, Story 8.1 D1: "shipped code wins"), never logged here (Epic 8 retro, A8-5) | Periodic epic doc reconciliation |

### Security & permissions (cross-epic — explicit deferrals)

| Item | Deferred to | Source |
|------|-------------|--------|
| Fine-grained `read:secret_value` vs `read:secret_metadata` (NFR-SEC9) | Epic 4+ | Story 2.2 ADR — role-based + audit is v1. **Epics 4-9 are all now `done` and this was never picked up — scheduled 2026-07-09** as `4-5-fine-grained-permissions-and-project-rbac` (backlog, `sprint-status.yaml`) |
| Per-project membership RBAC (all org members see all projects) | Story 4.1 | Story 2.1 ADR-2.1-01. **Story 4.1 shipped without this (it only added org-level invitations/roles) — scheduled 2026-07-09** as `4-5-fine-grained-permissions-and-project-rbac` |
| Tag case normalization (`Prod` ≠ `prod`) | v2 polish | Story 2.3 ADR-2.3-01. **Scheduled 2026-07-09** as `1-13-infra-and-process-hardening` (backlog, `sprint-status.yaml`) |
| `withOrgReadScope()` vs `withOrg()` distinction | Later story | Story 1.4 deferred-work. **Reviewed 2026-07-09:** the function itself no longer exists under that name (`withOrgScope` is now a plain alias for `withOrg`, `apps/api/src/lib/api-contracts.ts`); no story has ever specified what a differentiated read-scope should actually *do* differently from a write scope. Left as accepted, unscheduled design debt — implementing a distinction with no concrete behavioral requirement would be speculative. Revisit only if a future story defines a concrete read-vs-write authorization difference. |

### Process guardrails baked (2026-06-30) — remaining adoption

| ID | Status |
|----|--------|
| G1–G4 Product Surface Contract | ✅ Templates/workflows updated |
| E3-P1 Surface contracts on 3.1–3.3 | ✅ Added to story files |
| E3-P2 Epic 3 not `done` without 3.3 inbox | ✅ Enforced — 3.3 shipped the inbox |
| E3-P3 Resolve E3-1 before 3.1 | ✅ Resolved (Story 3.4, see E3-1 row above) |

---

## Epic 3 closure (Story 3.4, 2026-06-30)

Epic 3 (`epic-3`) is gated `done` only after Story 3.4 merges and its G2 preconditions checklist
passes — see Story 3.4 AC-15. Story 3.4 closed the remaining Epic 3 product-surface gaps: `/alerts`
route truth, dashboard alert-count truth, MFA recovery alert wiring, and the settings test-notification
UI. Two items remain intentionally open past Epic 3 closure, tracked below.

### Open (Epic 3 closure, Story 3.4 AC-16 — out of scope)

| Item | Deferred to |
|------|-------------|
| Credential expiry notification pg-boss jobs (columns exist from Story 2.4) | ✅ Resolved 2026-07-09 by `3-5-credential-expiry-notification-delivery` (`credential/expiry-alert`, migration `0045_credential_expiry_alerts.sql`, worker registration, and full alert-routing tests) |
| `notification_queue` failed status / DLQ cleanup | ✅ Resolved 2026-07-09 by `3-5-credential-expiry-notification-delivery` (`NOTIFICATION_MAX_ATTEMPTS`, `markNotificationFailed`, `notification/dlq-cleanup`, and catchup/DLQ tests) |
| Dispatcher batch preference lookup (N+1 query per recipient) | ✅ Resolved 2026-07-09 by `3-5-credential-expiry-notification-delivery` (`getPreferencesBatch` + dispatcher regression coverage; old `TODO` removed) |

---

## Follow-up from: story-3.5 credential expiry notification delivery (2026-07-09)

- Per-credential `alertLeadDays` are now present in the schema and consumed by the worker, but they
  still are **not configurable through the credentials API/web surface** — Story 3.5 deliberately
  shipped the delivery path with the default `[30, 7, 1]` thresholds only. Future story: add
  PATCH/create surface parity with the other monitored-asset types.
- `expiry-alert-shared.ts` still has the **pre-existing concurrent overlap race** shared by all five
  expiry-alert workers: two overlapping runs can both read the same row before either commit updates
  `notifiedLeadDays`, so the same threshold can fire twice. Story 3.5 documented and tested around
  this inherited limitation but intentionally did not add row-level locking in the shared runner.

---

## Deferred from: code review of story-3.4 (2026-06-30)

- `activeOrgForUser()` (`apps/api/src/modules/auth/mfa.ts`, unchanged by 3.4) iterates all orgs with no `ORDER BY` and returns the first with an active membership — for a user active in two orgs, which org's preferences/notification apply is non-deterministic. Pre-existing since Story 1.x's login flow; not introduced or worsened by 3.4's MFA notification wiring, which reuses this helper as-is.
- `patchPreferences()`'s `channel: 'none'` handling (Story 3.2) deletes stored override rows rather than persisting a suppression state, so a user selecting "None" for `security.mfa_recovery_used` / `security.mfa_recovery_codes_regenerated` in the personal preferences table (newly exposed by 3.4 AC-6) reverts to the default `email`+`inbox` channels on the next event instead of truly opting out. 3.4 exposes these types per AC-6's explicit "personal channel control" instruction; the underlying preference-persistence gap is pre-existing Story 3.2 scope.

---

## Deferred from: code review of story-1.12 (2026-06-27)

- Repeated `POST /auth/login` calls reset a pending MFA challenge's `attempt_count` to 0 (delete-then-recreate in `createPendingMfaSession`), so the per-token `MFA_LOGIN_MAX_ATTEMPTS` cap can be bypassed by re-challenging between attempt batches. Deferred: documented two-layer design (ADR-1.12-09) — the Story 1.9 cross-token threshold worker still bounds sustained brute-forcing across all tokens for an account; only the local real-time cap is bypassable.
- `apps/api/src/modules/auth/mfa-login.test.ts` lives outside `__tests__/` and isn't named `*.integration.test.ts`, deviating from AC-1's specified path, despite functionally being a real-DB integration suite.
- TOTP regex in `mfaVerifyLoginBodySchema` permits internal whitespace between digits — matches the pre-existing Story 1.8 enrollment-verification pattern, not unique to this story.
- `writeAuditEntry()` on the verify-login success path has no try/catch (unlike the failure path), so an audit-insert failure rolls back the whole login transaction as an unhandled 500 — consistent with how unexpected tx errors are handled elsewhere in the auth module.
- `attemptedEmailForUser()` falls back to a synthetic email on a rare deleted-user race mid-flow — same fallback pattern as Story 1.9's `mfa.ts`.
- `MFA_PENDING_SESSION_TTL_SECONDS` cross-field guard allows exact equality with zero slack for Postgres-vs-Node clock skew; defaults have a 5x margin.
- Oversized body / wrong content-type on `/mfa/verify-login` produces Fastify's framework-level 413/415 instead of the documented `401/422/429` response schema — systemic pattern likely shared by every `bodyLimit`-configured route in this codebase.
- AC-12's threshold-integration test (N invalid TOTP submissions crossing `FAILED_AUTH_THRESHOLD_COUNT` → `PENDING_DELIVERY` alert) isn't present in the new test file; lower priority since the underlying worker is already covered by Story 1.9's suite.

## Deferred from: code review of story-1.3 (2026-06-24)

- `apps/api/src/lib/cors.test.ts` only covers one disallowed-origin case; no test for a missing `Origin` header or substring/case-sensitivity allow-list bypass variants (e.g. `http://localhost:5173.evil.com`).
- CORS rejection in `apps/api/src/app.ts` returns HTTP 500 instead of a proper 4xx; behavior is correctly tested as-is per AC #14, but the underlying error-handling design is arguably a defect for a future story to fix.
- No `.dockerignore` exists despite multi-arch and image-size-sensitive Docker builds.
- AC #14's illustrative code block in the story file still shows `403`, but the shipped test asserts `500` per the AC's own "assert actual behavior" instruction — minor spec-hygiene drift.

## Deferred from: code review of story-1.4 (2026-06-24)

- `check-rls-coverage.ts` infers "org-scoped" purely from a column literally named `org_id` — brittle naming-convention heuristic with no positive table registry. Deferred: this is how AC-10 is explicitly specified; changing it is a spec-level decision beyond this story.
- `withOrgReadScope()` is functionally identical to `withOrg()` — no real read/write distinction despite the name. Deferred: explicitly acknowledged in Story 1.4's own Dev Notes as "differentiated in a later story."
- `GRANT CREATE ON DATABASE project_vault TO vault_app` is a broad, database-wide grant added for pg-boss's schema bootstrap rather than scoped to a dedicated schema. Deferred: already documented and user-approved as a scope deviation in the Story 1.4 Dev Agent Record.
- `docker-compose.yml`'s `migrate` service rebuilds the full `api` builder stage on every cold start just to run one migration command. Deferred: pre-existing tradeoff from the documented scope deviation; an optimization, not a defect.
- `getDb()` singleton in `packages/db/src/index.ts` has no recovery path if the underlying connection pool dies. Deferred: pre-existing connection-management architecture beyond Story 1.4's scope; broader resilience work is a future concern.

## Deferred from: code review of story-1.9 (2026-06-27)

- `FAILED_AUTH_RETENTION_HOURS` and `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS` have no cross-validation in `apps/api/src/config/env.ts`; a misconfigured deployment (retention shorter than the detection window) could prune attempts before the threshold worker counts them. Deferred: env-config robustness gap, not unique to this story.
- `loadMfaEnforcementStatus()` (`apps/api/src/modules/auth/mfa-enforcement.ts`) does two sequential, non-parallelized DB round-trips on every MFA-gated request with no request-scoped caching. Deferred: performance optimization, not required by any AC.
- Failed-auth recording defaults a missing client IP to `0.0.0.0` (`apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/mfa.ts`), which could cluster unrelated failures under one fake IP for threshold purposes. Deferred: pre-existing convention reused from Story 1.6/1.7's `getClientIp()` fallback, not introduced by this diff.

## Deferred from: code review of story-1.5 (2026-06-25)

- `GRANT` on `vault_state` omits `UPDATE`, making the `vault_state_no_update` trigger currently unreachable (Postgres blocks UPDATE at the grant layer first). Deferred: harmless defense-in-depth redundancy matching the `audit_log_entries` REVOKE-based pattern from Story 1.4, not a functional bug.
- CHECK-constraint violation on `vault_state` insert (e.g. malformed `kms_type`) is not mapped to a typed `AppError`. Deferred: currently unreachable since Zod validates `kmsType` before `initVault()` is ever called.
- Several "zero key material on throw" gaps in `deriveIkmForInit`/`initVault` lack `try/finally` (envelope-half buffers, `ikm`, sentinel). Deferred: unreachable today given pre-validated buffer lengths; cheap defensive hardening worth adding if the surrounding code changes.
- `parseEnvelopeEnvHalf` throws a plain `Error` (not `AppError`) if `VAULT_ENVELOPE_KEY_HALF` becomes malformed after startup, surfacing as a generic 500. Deferred: direct consequence of the already-disclosed live-`process.env`-read deviation documented in this story's Dev Agent Record.
- `app.ts`'s global error handler treats `statusCode === 0` as a valid numeric status (`reply.status(0)` would be called). Deferred: no known code path produces this today; a `>= 100` guard would close the theoretical gap.
- Dockerfile's argon2 native-build toolchain has no automated post-rebuild smoke test in CI (only manually verified via a one-off `docker run` check this session). Deferred: manual verification done; automating it is a nice-to-have for a future CI hardening pass.

## Deferred from: Epic 4 retrospective (2026-07-02) — closed 2026-07-03

Epic 4 (`epic-4`) stories 4.1–4.4 are `done` in sprint-status. The retro below flagged 7 items; verifying each against **current shipped code** (2026-07-03) found 3 were already fixed (the adversarial-review/deferred-work docs were stale) and fixed the remaining 3 directly rather than opening a dedicated closure story:

| ID | Item | Resolution |
|----|------|--------|
| CP4-1 | MFA re-enrollment during account recovery (4.3 AC-15) doesn't regenerate `mfa_recovery_codes` | ✅ Already fixed in code — `promoteStagedEnrollmentAndReissueCodes()` in `auth/recovery.ts` regenerates codes |
| CP4-2 | `POST /org/users/:userId/recovery/send-link` (4.3 AC-10) has no admin-hierarchy guard | ✅ Already fixed in code — `org/routes.ts` calls `isUsableTarget(...)` with the peer-or-higher guard |
| CP4-3 | 4.3's shipped `checkActiveRotationsForUser` stub returns `{ code, message }`; 4.4 requires `{ error, rotationIds }` (ADR-4.4-04) | ✅ Fixed 2026-07-03 — `ActiveRotationsErrorSchema` moved to `@project-vault/shared`; `org/routes.ts` deactivate handler now returns the same shape as 4.4's archive route |
| CP4-4 | Sync all four Epic 4 story files' `Status:` header with sprint-status (`done`) | ✅ Fixed 2026-07-03 |
| CP4-5 | Add `.env.example` entry for `RECOVERY_TOKEN_HMAC_SECRET` | ✅ Already documented in `.env.example` |
| P4-1 | Extract shared `resolveProjectRole()` helper — inline pattern duplicated across 4.1, 4.2 (×2), 4.4 | ✅ Fixed 2026-07-03 — `getProjectMembershipRole()` already existed and was already used by `org/routes.ts`; `projects/routes.ts`'s `callerProjectRole()` now delegates to it too |
| P4-3 | Decide whether 4.1 and 4.4 get a retroactive adversarial review | Open — process decision, not code; see retro Team Agreements |

Full detail + verification notes: `_bmad-output/implementation-artifacts/epic-4-retro-2026-07-02.md` (see Addendum).

---

## Deferred from: Epic 6 retrospective (2026-07-06)

Epic 6 (`epic-6`) stories 6.1-6.3 are `done`, but the epic itself stays `in-progress` in
`sprint-status.yaml` pending a closure story — same pattern as Epic 2 (2.8), Epic 3 (3.4), and
Epic 5 (5.5).

| ID | Item | Resolution |
|----|------|--------|
| A6-1 | Story 6.1's own Product Surface Contract flagged no web UI story exists for services/certificates/domains management ("flag it at Epic 6 retro time so a UI story gets added before epic-6: done") — never converted to a backlog item until this retro | Scheduled as `6-4-epic-6-completion-monitored-asset-management-ui-and-technical-debt` (`sprint-status.yaml`, `backlog`) — `epic-6` held `in-progress` until it lands |
| A6-2 | `apps/web/src/lib/components/dashboard/dashboard-copy.ts`'s `add_service` label ("Add first service - available in Epic 6") is now a false claim — Epic 6 shipped without delivering this UI | Rolled into `6-4`'s AC list |
| A6-3 | Story-file `Status:` headers out of sync with `sprint-status.yaml` (`done` in sprint-status, `review` in the story file) for 6-1, 6-2, 7-1, 7-2, 7-3, 8-1 — same defect class as Epic 4's CP4-4 | ✅ Fixed directly 2026-07-06 (headers now read `done`) |

### Open (Epic 6 retro)

| ID | Item | Owner | Target |
|----|------|-------|--------|
| P6-1 | ✅ **Resolved** — `scripts/check-story-status-sync.ts` (commit `dc42f4a`, already wired into `make ci`) now automatically catches this drift; discovered already-shipped during `1-13-infra-and-process-hardening`'s 2026-07-09 story creation (this row itself was stale — never updated after the check landed). Story `1-13` Group P adds hardening on top of the existing check (named regression fixtures for the CP4-4/A6-3/5th-recurrence historical incidents, plus a dogfooding AC), not the check itself. | — | Done |
| TD6-1 | `payment_records` physical table name vs. "services" domain language used everywhere else (UI, ACs, dashboard) | Dev | Rename follow-up, not yet scheduled |
| TD6-2 | `AuditEvent` object + type-union dual-listing pattern reproduced a 3rd time (6.1, 6.2, 6.3) without consolidation | Dev | Derive union from object (`keyof typeof`) |
| TD6-3 | Public status page (6.3): no enumeration/abuse visibility beyond access logs, shared (non-token-keyed) per-IP rate limit, no CORS/embeddability guidance | Dev | v1-accepted trade-off; revisit if status pages become externally load-bearing |

Full detail: `_bmad-output/implementation-artifacts/epic-6-retro-2026-07-06.md`.

---

## Deferred from: Story 4.4 (Project Archival, 2026-07-02)

- ~~**ADR-4.4-02 seam removal (blocker for FR63 sign-off):** `findBlockingRotationIds` in `apps/api/src/modules/projects/archive-guards.ts` degrades to "no block" via a `to_regclass('public.rotations')` table-existence check because Story 5.1 (rotation table) had not shipped when 4.4 was implemented.~~ — **Resolved.** Retired in Story 6.1 (commit `830730e`, during that story's CI fixes) — no `rotationsTableExists` helper remains in the codebase. Confirmed via git history during Story 5.5's implementation and re-confirmed in the Epic 5 retro recheck (2026-07-06); `deferred-work.md` had not been updated to reflect this until now (the D5-1 action item from the 2026-07-05 retro).
- **Epic 7 machine-user stub:** `hasActiveMachineUserKeys` in `archive-guards.ts` is a permanent stub (`// TODO: Epic 7`) returning `false` until Epic 7 Story 7.1 ships `GET /api/v1/projects/:projectId/machine-users/active-keys`. Replace the stub body with a real check once available.
- ~~**Story 5.1 rotation-creation handler must close the archive/commit TOCTOU race:**~~ — **Resolved 2026-07-05** (Story 5.5, AC-1): `initiateRotation` now takes a `FOR UPDATE` lock on the parent `projects` row before any checklist/version writes, returning a new `project_archived` outcome mapped to `410`. Verified deterministic (never both succeed, never both fail) since 4.4's archive path already takes the identical lock at the top of its own transaction — the two operations fully serialize on that one row.
- **AC-5 write-guard coverage is complete for all currently-shipped mutation routes** (2.1/2.2/2.3/2.4/4.1/4.2 are all `done`), so no routes were left un-guarded pending a later story. If a future story adds a new mutating route nested under a project (e.g. a standalone credential-delete endpoint per AC-5's scope note), it MUST add the `isProjectArchived`/`rejectIfProjectArchived` guard and a 410 test in that story's own PR.
- **No standalone `POST /api/v1/projects/:projectId/members` (add member) route exists.** Story 4.2 shipped membership growth only via the invitation-accept path (`POST /api/v1/invitations/:token/accept`), which IS guarded (410 on an archived project). AC-5's table entry for a direct add-member route is therefore not applicable in the current implementation; revisit if a future story adds one.
- **ADR-4.4-05 authorization-path audit trail:** org owners may archive/unarchive any project without holding a `project_memberships` row. The audit row currently does not distinguish "acted as project owner" vs. "acted via org-owner override" (SecureRoute's `writeHumanAuditEntryOrFailClosed` payload is `{}`  for archive/unarchive). Recoverable today only via the structured `project.archive_denied`-style warn logs on the *denial* path, not on the success path. A follow-up could add `authorizedVia: 'project_owner' | 'org_owner'` to the audit payload.
- ~~**4.3/4.4 active-rotation block shape divergence**~~ — **Resolved 2026-07-03** (Epic 4 retro closure): `ActiveRotationsErrorSchema` moved to `@project-vault/shared`; `org/routes.ts`'s deactivate handler now returns `{ error: 'active_rotations', rotationIds }`, matching 4.4's archive route exactly.

---

## Deferred from: Epic 9 retrospective (2026-07-08) — Story 9.7

### Technical debt tracked, not fixed (Story 9.7 D8 / AC-T2)

**TD9-2 — `writePlatformAuditEntryOrFailClosed` maintenance-mode bypass scope too broad**

9.4's `writePlatformAuditEntryOrFailClosed` (`apps/api/src/lib/audit-or-fail-closed.ts`) activates the maintenance-mode bypass and queues a pending entry on *any* write failure that occurs during an active maintenance window — not narrowly on "audit storage unavailable." A genuine application bug (e.g. a malformed payload that causes a DB constraint violation, or an unexpected schema error) during a maintenance window is silently queued into `platform_audit_pending_entries` rather than surfacing as a defect, because the bypass catches the exception before it can propagate. This was flagged as a high-severity adversarial-review finding on Story 9.4 (see `epic-9-retro-2026-07-08.md` Finding 6 / TD9-2 / Action Item A9-6).

**Decision:** Story 9.7 takes the deferred-work.md path rather than fixing this in-place, because narrowing the bypass is a backend audit-logging behavior change unrelated to 9.7's UI scope (see D8). The fix is: narrow the `catch` clause to only trigger maintenance-mode queue logic when the error is a storage-unavailability error (e.g. a connection-refused or disk-full Postgres error class), not any arbitrary write exception.

**Target:** ✅ Resolved 2026-07-10 by `9-8-platform-admin-mfa-gaps-and-audit-bypass-hardening` — the bypass now classifies and queues only vault-sealed, Postgres storage-unavailability, and socket-level connectivity failures; constraint violations and other application errors fail closed. Source: `9-7-epic-9-completion-platform-operations-web-ui` (AC-T2), `epic-9-retro-2026-07-08.md` Finding 6/TD9-2/A9-6.

### New finding, tracked 2026-07-09 (not in the original Epic 9 retro — found via direct code inspection)

**MFA-unenrolled platform operator hits a dead-end on `/platform/settings` and `/platform/settings/orgs`**

Story 9.7's own pre-implementation adversarial review (`9-7-epic-9-completion-platform-operations-web-ui-adversarial-review.md`, Findings 2/3, critical/high) flagged that `GET /settings` and `GET /orgs` require MFA (`requireMfa: true`) even though AC-G4 assumed only the mutating (`PUT`/`POST`) routes did. Direct inspection of the shipped code on 2026-07-09 confirms this was never reconciled: `settings-routes.ts`/`orgs-routes.ts` still set `requireMfa: true` on the `GET` handlers, and `apps/web/src/routes/(app)/platform/settings/+page.server.ts` / `.../platform/settings/orgs/+page.server.ts` catch any load failure into a generic `errorMessage` string rendered as a plain error banner — unlike the mutation paths (`handleSave`), which use `MfaAwareErrorAlert` with an "Enable MFA" link. An MFA-unenrolled platform operator (a realistic scenario, since the first registered user on the instance is auto-flagged platform operator) gets a dead-end generic error on page load instead of a working page with an enrollment prompt. `/platform/settings/resource-usage` and `/platform/audit` likely have the same defect (their backing `GET` routes are also `requireMfa: true` per the story's own endpoint inventory) — needs verification during story creation.

**Target:** ✅ Resolved 2026-07-10 by `9-8-platform-admin-mfa-gaps-and-audit-bypass-hardening` — all four platform page-load errors now use the shared MFA-aware alert, and read-only `GET /platform/maintenance-mode` is reachable without MFA while retaining platform-operator authorization.

---

## Deferred from: code review of story-3-4-epic-3-completion-notification-surface-truth-mfa-alerts-and-doc-reconciliation (2026-07-09)

- **`dispatchDirectUserNotification` uses a Slack denylist instead of an allowlist.** (`apps/api/src/notifications/dispatcher.ts`) Excludes `channel === 'slack'` rather than enumerating the allowed channels (`email`/`inbox`). Any future channel type added to the preferences schema would be dispatched by default through this direct-user self-alert path unless someone remembers to also exclude it here. Not a current bug — no other channel types exist yet — but the safer design is an allowlist. Fix when a new channel type is next added.
- **AC-7a's "after transaction commits" wiring is unmet for `regenerateRecoveryCodes`.** (`apps/api/src/modules/auth/mfa.ts`) Disclosed and accepted trade-off per the story's own Dev Agent Record: dispatch happens inside the still-open `secureCtx.tx` rather than post-commit, because pg-boss's built-in retry/backoff absorbs the narrow race and the story's explicit line-level wiring instruction took precedence over the general outbox-pattern rule. `recoverWithCode()` is unaffected (it owns its own transaction and dispatches genuinely post-commit).
- **AC-5's admin-vs-member test coverage is indirect.** (`apps/web/src/routes/(app)/settings/notifications/notification-settings-model.test.ts`) Tests the pure `isAdminRole()` function rather than exercising `load()`/the rendered template directly. Matches this codebase's existing convention of testing SvelteKit route logic via colocated pure-function modules — same convention already accepted in this story's prior review round.
- **`NODE_ENV=test` rate-limit bypass has broad blast radius.** (`apps/api/src/lib/route-helpers.ts`, `isRateLimitEnforced()`) A misconfigured non-test environment reachable by real traffic that sets `NODE_ENV=test` would silently lose brute-force protection on `authRoutes`/`vaultRoutes`. **Decision:** not a Story 3.4 fix — routed to new backlog story `3-6-rate-limit-env-gating-and-mfa-preference-opt-out-hardening` (scheduled 2026-07-09, `sprint-status.yaml`).
- **MFA alert "None" opt-out is silently ineffective.** (`patchPreferences()`, Story 3.2) Deletes stored override rows instead of persisting a suppression state, so selecting "None" for an alert type reverts to default `email`+`inbox` delivery on the next event — a pre-existing bug, but Story 3.4 is what first exposes it to users via the two new MFA recovery alert types. **Decision:** confirmed not covered by Story 3.5 (its AC-W6 example only assumes the existing preference-override mechanism works correctly); routed to new backlog story `3-6-rate-limit-env-gating-and-mfa-preference-opt-out-hardening` (scheduled 2026-07-09, `sprint-status.yaml`).

---

## Deferred from: code review of 2-9-credential-project-web-ui-completeness (2026-07-10)

- **`getRecentAccessEventsForProject` filters via `resource_id IN (credential ids)`** rather than indexed `audit_log_entries.project_id` (always NULL for credential events today). Documented AC-A1 design decision — populate `project_id` on write in a future story, then switch the query.

---

## Deferred from: code review of 10-2-apps-web-branch-coverage-hardening (2026-07-10)

- **Failed notification actions still decrement local unread state.** The custom `enhance` callbacks in `apps/web/src/routes/(app)/notifications/+page.svelte` call `decrementUnread` without checking the action result, so a 4xx/5xx response can make the local count disagree with the server. Runtime behavior change; outside Story 10.2's test-only scope.
- **Notification query values are not validated.** `apps/web/src/routes/(app)/notifications/+page.server.ts` forwards non-numeric/unsafe pages and unknown statuses to the inbox API. Runtime contract change; outside Story 10.2's test-only scope.
- **Status-page clipboard failures are unhandled.** A rejected `navigator.clipboard.writeText` promise has no user-visible fallback in the status-page management component. Runtime UX change; outside Story 10.2's test-only scope.
- **Invitation revoke failures escape without UI handling.** `onRevoke` in the members page resets its busy state in `finally` but has no `catch`, leaving API rejection as an unhandled promise with no visible error. Runtime UX change; outside Story 10.2's test-only scope.

---

## Deferred from: code review of 10-3-apps-web-complete-source-branch-coverage-buffer (2026-07-11)

- **AC-D1's mutation-testing rigor was concentrated on two security-sensitive paths (`LoginForm.svelte`, credential detail lifecycle-override) rather than exhaustively applied per-test across all ~75 new characterization-test files.** Signed off 2026-07-11 (Nestor) as accepted technical debt — a proportionality judgment call given the volume of characterization tests added, not a literal read of AC-D1. No further action required.

---

## Deferred from: code review of 11-1-branding-visual-identity (2026-07-11)

- Logo+wordmark markup duplicated verbatim between `AppShell.svelte` and `(auth)/+layout.svelte` with no shared `<BrandLogo>`/`<BrandMark>` component — future logo/size/link changes require editing both call sites manually.
- `bg-brand-600`/`hover:bg-brand-700` button classes repeated verbatim across `LoginForm.svelte`, `RegisterForm.svelte`, `recovery/+page.svelte`, and `recovery/[token]/+page.svelte` instead of a shared Button component — a future rebrand means repeating this mechanical class sweep again.
- Auth-shell logo image (`(auth)/+layout.svelte`) is not a clickable link to `/dashboard`, unlike the `AppShell.svelte` header wordmark — minor click-affordance inconsistency between the two brand-mark locations.
- `PrimaryNav.svelte`'s active-tab pill (`bg-brand-600`) has no `hover:` state, while every other CTA recolored in this story gained `hover:bg-brand-700`.
- Primary-CTA `bg-slate-950` styling remains on surfaces outside the 3 target surfaces named in Story 11.1 (e.g. `FormSubmitRow.svelte`, `VaultGate.svelte`, `VaultUnsealForm.svelte`, `OnboardingStep3.svelte`, `AccessNotice.svelte`, `PageAlertBanner.svelte`) — explicitly Out of Scope for 11.1, but worth a follow-up story if a full brand rollout is desired (leaving the app visually split between violet header/auth and near-black CTAs elsewhere).
- No test assertions cover the new logo `<img>` markup or `brand-600`/`brand-700` classes in `AppShell.test.ts`, `PrimaryNav.test.ts`, `LoginForm.test.ts`, `RegisterForm.test.ts`, or the `(auth)` page tests — a future accidental revert of the brand recolor or logo removal would pass the full suite silently.

---

## Deferred from: code review of 6-5-monitored-asset-creation-permission-check-fix (2026-07-11)

- **GET-by-id returns 404 for an archived project while PATCH/DELETE on the same route return 410** — `apps/api/src/modules/monitoring/routes.ts`'s new `makeGetByIdHandler` mirrors the pre-existing `makeListHandler`'s `requireProjectInOrg` convention, which already diverged from PATCH/DELETE's `rejectIfProjectArchived` at the list-GET level before this diff. Extends an existing GET-vs-mutation inconsistency to item scope; normalizing archived-project handling across the whole monitoring module is out of scope for this story.
- **New GET-by-id routes expose an extra `project_not_found` 404 branch that PATCH/DELETE never had on the same URL shape** — same root cause as above, already true of list-GET before this diff.
- **`route-audit.test.ts`'s classification gate is a static/AST check, not a runtime verification that a route handler actually performs only reads** — pre-existing tooling limitation, not introduced by this diff.
- **New GET routes reuse `MONITORING_LIST_READ_OMISSION_REASON` (written for bulk list reads) to justify not auditing single-record reads too, without re-deriving the rationale** — each entry sets `reviewer: SECURITY_OWNER`, routing the judgment call to the project's existing security-review process.
- **`services` asset type is modeled as `PaymentRecord` under the hood** (`findPaymentRecordInProject`, `PaymentRecordResponseSchema`) in `apps/api/src/modules/monitoring/routes.ts` — pre-existing naming confusion predating this diff.
- **`makeGetByIdHandler`'s generic `Params extends { projectId: string }` doesn't statically tie `paramsSchema` to the specific `:id` param declared on the route it's registered against** — a copy-paste mismatch would be caught by the existing parametrized `RESOURCES` route tests at CI time, providing a practical safety net without a compile-time guarantee.
- **New `.server.test.ts` files for the 4 "new" routes assert only `load()`'s return shape, not that `canManageMonitoredAssets(orgRole)` actually gates the rendered form end-to-end** — matches this codebase's established test convention exactly (`credentials-new-page.server.test.ts` does the same); not a regression introduced by this diff.
>>>>>>> 9dbb46a (fix(6-5): apply code-review findings, complete live verification, log deferred items)
