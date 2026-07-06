# Deferred Work

Tracked gaps: work intentionally deferred, not yet implemented, or needing follow-up.  
**Product Surface Contract:** API-only items here must have a linked story before parent stories/epics close — see `_bmad-output/implementation-artifacts/product-surface-contract.md`.

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
| D4 | `migrate` service rebuilds full API builder on every cold `docker compose up` | Dev | Slim migrate image or cache strategy |
| D5 | Full production operator runbook | Tech Writer / Ops | Epic 9 Story 9.5 |

**D4:** One-shot `migrate` uses `apps/api/Dockerfile` `builder` target — slow first boot. Dev path: `make bootstrap` avoids full stack rebuild when only DB is needed.

---

## Deferred from: Epic 2 closure retrospective (2026-06-30)

Epic 2 is `done` (Stories 2.0–2.8). Items below are **not** blockers for Epic 3 notification infrastructure unless noted.

### Open retro action items

| ID | Item | Owner | Target |
|----|------|-------|--------|
| P4 | Epic 1 retrospective or documented waiver | Nestor | ✅ Done — `epic-1-retro-2026-06-30.md` |
| E3-1 | SMTP config split: Story 3.1 env vars vs AC-E3a Epic 9 system settings | Architect / PO | ✅ Closed (Story 3.4) — env-var SMTP config is the MVP path (Story 3.1 AC); Epic 9 (`FR86`) adds an admin system-settings UI on top without breaking the env-var fallback |
| E3-2 | FR73 `PENDING_DELIVERY` → `notification_queue` integration test | Dev | Story 3.1 AC |
| D1 | Reconcile `architecture.md`: `secrets` tables/endpoints → `credentials` naming | Tech Writer | Planning doc |
| D2 | Operator runbook: `CREDENTIAL_RETENTION_DRY_RUN` → destructive purge rollout | Dev / Ops | `specs/` |

### Partial epic acceptance criteria (honest zeros until later epics)

| AC / area | Status | Blocked by | Notes |
|-----------|--------|------------|-------|
| AC-E2d — projects with overdue rotations | Schema slot exists; `count: 0`, `items: []` | Epic 5 | `GET /api/v1/dashboard` credential/expiry slice shipped in 2.8 |
| AC-E2d — unresolved alert count on org dashboard | ✅ Live (Story 3.4) — real `security_alerts` count | — | Was hardcoded `0`; resolved by AC-10 |
| Project dashboard — `upcomingRotations`, `recentAccessEvents`, `monitoredServiceHealth` | Empty arrays / placeholder grid on web | Epic 5, 8, 6 | `DashboardPlaceholderGrid` on `/dashboard` |
| Project dashboard — `suggestedActions` partial completion | Empty when `isEmpty: false` | Epic 6 | Smarter suggestions need monitoring data (Story 2.1 deferral) |
| Credential expiry **notifications** | Columns exist (2.2/2.4); no delivery | Epic 3+ | Backend ready; alerting jobs not wired |

### Web UI gaps — API exists, web incomplete (Epic 2 surface)

| Capability | API story | Web status | Suggested follow-up |
|------------|-----------|------------|---------------------|
| Tag filter on credential list | 2.3 | List has `q` + `status` only; no `tags` query param in UI | Polish story or Epic 2.x follow-up |
| Project tag management (FR95) | 2.3 | API only | Web UI story |
| Credential lifecycle PATCH (`expiresAt`, `rotationSchedule`) | 2.4 | Create-only on web; no edit form | Web edit story |
| Dependent systems (list/create/archive) | 2.4 | Not on credential detail page (2.8 noted optional read-only) | Epic 5 prep UI or 2.x follow-up |
| Add credential version (new value) | 2.2 | Reveal + history read-only; no "new version" action | Web story |
| Onboarding Step — "Invite your team" | 2.6 | Links to settings placeholder | Epic 4 invitations |
| Playwright E2E suite | — | Not implemented (2.8 out of scope) | Test automation epic / CI hardening |
| Rotation workflow (initiate, checklist confirm/fail/retry/complete, break-glass) | 5.1/5.2/5.3 | API-only — no dedicated web story exists (unlike Epic 2's API+web pairing); 5.1's Product Surface Contract flagged this decision as due before `epic-5-retrospective` | **Resolved 2026-07-05 (Epic 5 retro):** scheduled as `5-4-rotation-workflow-web-ui` (backlog, `sprint-status.yaml`) rather than deferred indefinitely — `epic-5` held `in-progress` until it lands |
| Epic 5 retro risk/gap/contradiction/technical-debt audit (12 findings: self-attestation, reveal-regression safety net, break-glass idempotency, NULL `initiatedBy`, malformed cron handling, unbounded dashboard scan, missing `org_id` index, background-job audit-failure handling, missing CAS on `abandon`, ambiguous audit payload, missing rollback tests, missing version IDs on `rotation.completed`) | 5.2/5.3 adversarial reviews (medium/low findings left "not blocking") | Documented in `epic-5-retro-2026-07-05.md`'s Significant Discovery Alert | **Tracked as Story 5.5** (`5-5-epic-5-completion-rotation-hardening-and-technical-debt.md`, `ready-for-dev`) — AC-2 through AC-13 |
| Monitored-asset management (services/certificates/domains CRUD) | 6.1 | API-only — no dedicated web story exists; 6.1's Product Surface Contract flagged this as due before `epic-6-retrospective`; `dashboard-copy.ts`'s `add_service` label still says "available in Epic 6" though the epic shipped without it | **Resolved 2026-07-06 (Epic 6 retro):** scheduled as `6-4-epic-6-completion-monitored-asset-management-ui-and-technical-debt` (backlog, `sprint-status.yaml`) — `epic-6` held `in-progress` until it lands |

### Shell placeholders (future epics — tracked, not silent)

| Route | Current state | Epic |
|-------|---------------|------|
| `/alerts` | ✅ Resolved (Story 3.4) — server redirects (308) to `/notifications`, the canonical inbox route from Story 3.3; placeholder page deleted | — |
| `/health` | `PlaceholderSection` — "Epic 6" | 6.x monitoring |
| `/settings` | `PlaceholderSection` — "MVP shell" | 3.2 partial (`/settings/notifications` in 3.2 story); full settings Epic 9 |

**Stale copy:** `apps/web/src/lib/components/shell/placeholder-copy.ts` — `projects` blurb still references "Story 2.1"; `credentials` key unused by routes (gateway page is real). Hygiene cleanup deferred.

### Operations & production

- **`CREDENTIAL_RETENTION_DRY_RUN`:** Production defaults to dry-run; operators must explicitly enable destructive version purge after verification (`apps/api/src/workers/prune-credential-versions.ts`). No runbook yet (D2).
- **Retention worker:** Rotation-in-progress version exemption enforced; operator rollout procedure not documented.

### Planning document reconciliation

| Document | Drift | Resolution |
|----------|-------|------------|
| `architecture.md` | `secrets` table names, `idx_secrets_*`, POST reveal patterns | D1 — align to `credentials` / `GET .../value` |
| `epics.md` | Story 2.0 MFA deferral note stale (1.12 shipped) | Periodic epic doc reconciliation |
| `epics.md` | Beta cuts FR9/FR17/FR80 marked deferrable but implemented | Document as scope expansion, not bug |

### Security & permissions (cross-epic — explicit deferrals)

| Item | Deferred to | Source |
|------|-------------|--------|
| Fine-grained `read:secret_value` vs `read:secret_metadata` (NFR-SEC9) | Epic 4+ | Story 2.2 ADR — role-based + audit is v1 |
| Per-project membership RBAC (all org members see all projects) | Story 4.1 | Story 2.1 ADR-2.1-01 |
| Tag case normalization (`Prod` ≠ `prod`) | v2 polish | Story 2.3 ADR-2.3-01 |
| `withOrgReadScope()` vs `withOrg()` distinction | Later story | Story 1.4 deferred-work |

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
| Credential expiry notification pg-boss jobs (columns exist from Story 2.4) | Future story / Epic 3.x |
| `notification_queue` failed status / DLQ cleanup | Future story |
| Dispatcher batch preference lookup (N+1 query per recipient) | Performance follow-up — `TODO` left in `dispatcher.ts` |

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
| P6-1 | No automated check catches story-file `Status:` header vs `sprint-status.yaml` drift — this is the 2nd time (Epic 4, now Epic 6/7/8) it's been caught only by a manual retro sweep | Dev | CI check / `make` target |
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
