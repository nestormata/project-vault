# Story 8.6: Epic 7 Completion — Machine User Web UI & Hardening

Status: ready-for-dev

<!-- Story derived from epic-7-retro-2026-07-06.md's Significant Discovery Alert + Action Items. Bundles the machine-user
     management web UI gap (flagged as "a genuine planning gap" in both 7.1 and 7.2, never scheduled until this retro)
     with the retro's other still-open security/technical-debt findings, following the exact precedent
     `8-5-rotation-web-ui-hardening` set the same day for Epic 5's carried-forward adversarial-review findings — Epic 8
     ("Compliance, Audit & Governance") is the shared cross-epic hardening bucket for findings that don't warrant
     reopening a `done` epic's own story sequence. `epic-7` stays `in-progress` until this story lands (G2 gate). -->

## Story

As an org admin who provisions and manages machine users (CI/CD service identities) for Project Vault,
I want a web UI for creating/managing machine users and their API keys, plus the security/reliability gaps Epic 7's retrospective surfaced closed,
so that machine-user administration is no longer a curl-only feature, and Epic 7 can close without carrying documented-but-unfixed debt into Epic 9.

*Source: `_bmad-output/implementation-artifacts/epic-7-retro-2026-07-06.md` (Significant Discovery Alert + Action Items), `_bmad-output/implementation-artifacts/deferred-work.md` ("Web UI gaps" table), and the three Epic 7 adversarial reviews (7.1, 7.2, 7.3).*

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — AC-1 through AC-4 add a `web` surface on top of Epic 7's existing `api`-only endpoints; AC-5 through AC-11 are `api`/ops hardening with no UI component. |
| **Evaluator-visible** | yes, for AC-1–AC-4 (an org admin can now manage machine users through the dashboard, not just via curl) |
| **Linked UI story** (if API-only) | N/A for AC-1–AC-4 — this story **is** the linked UI story that closes 7.1's/7.2's "TBD" gap. AC-5–AC-11 remain API-only/ops by nature (no user-facing surface to build). |
| **Honest placeholder AC** | N/A — no placeholder is being shipped; this story either implements the real UI or (per AC-1's scope note) explicitly does not build a given sub-view, with the gap named, not faked. |
| **Persona journey** | Org admin: Projects → a project's Machine Users tab → create a machine user → issue an API key (shown once) → later, rotate/revoke/emergency-revoke a key, and review/dismiss dormancy alerts from the existing Notifications/Security Alerts inbox. |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Stories 7.1, 7.2 done | This story only builds a web client against endpoints 7.1/7.2 already shipped (`/api/v1/projects/:projectId/machine-users`, `/api/v1/machine-users/:id/api-keys`, rotate/emergency-revoke, dormancy admin actions, `active-keys`) — no new backend endpoint is required for AC-1–AC-4. |
| Story 7.3 done | AC-9 (Marketplace-publish tracking) and AC-6 (offline-cache race) both touch artifacts 7.3 shipped (`packages/vault-action`, `packages/agent`). |
| Epic 7 retrospective (`epic-7-retro-2026-07-06.md`) reviewed | Every AC below traces to a specific finding in that document — read it first for the "why," this story is the "what." |
| Existing security-alerts inbox (Epic 1, extended by 7.2 D9) | AC-4 reuses `GET /api/v1/security-alerts` + the existing alerts UI rather than building a new dormancy-specific view. |

---

## Retro Traceability Matrix

| Finding | Source | AC |
|---|---|---|
| No web UI exists anywhere for machine-user/API-key management | 7.1/7.2 Product Surface Contract ("TBD" gap); `epic-7-retro-2026-07-06.md` Executive Summary #4 | AC-1, AC-2 |
| No web UI for rotation/emergency-revoke/dormancy admin actions | 7.2 Product Surface Contract; retro Significant Discovery Alert | AC-3, AC-4 |
| No machine-user deactivation/removal path exists anywhere in Epic 7 | 7.1 adversarial review (medium); retro Technical Debt section | AC-5 |
| Offline-cache concurrent-write race is untested | 7.2 adversarial review (high); retro Security Risks section | AC-6 |
| No rate limiting/anomaly detection on failed credential-name lookups (JWT-scoped enumeration) | 7.2 adversarial review (medium); retro Security Risks section | AC-7 |
| `main` has no branch protection; mutable `vault-action` `v1` tag has no enforced review gate | 7.3 D7 (mandatory mitigation, never verified); retro N7-4 | AC-8 |
| Story 7.3 AC-15's named-owner + tracked-issue requirement for GitHub Marketplace publish is admittedly unmet | 7.3 Completion Notes; retro N7-3 | AC-9 |
| Triplicated AES-256-GCM/HKDF cache-crypto (`packages/crypto`, `packages/agent`, `packages/vault-action/dist`) with no cross-release sync mechanism | 7.2 D11, 7.3 Dev Notes; retro Technical Debt section | AC-10 |
| Dormancy-threshold changes have no reconciliation of already-fired alerts | 7.2 adversarial review (medium); retro Technical Debt section | AC-11 |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| Machine-user web UI | A project's Machine Users tab: list/create/detail, matching the existing credential-detail-page navigation pattern. |
| API-key web UI | Issue (plaintext shown once, copy-to-clipboard, never re-fetchable), list (metadata only), revoke, rotate, emergency-revoke — all from the machine-user detail view. |
| Dormancy UI | Dormancy alerts render in the existing Security Alerts inbox with dismiss/extend/revoke actions wired to 7.2's existing endpoints — no new inbox is built. |
| Deactivation | A real `machine_users.deactivatedAt`-setting endpoint + UI action, closing 7.1's forward-compatible-but-unused column. |
| Security hardening | Offline-cache concurrent-write race gets a real test (and a fix if the test finds a live bug); credential-by-name lookup gets a failed-attempt rate limit. |
| Ops/process | `main` branch protection verified/configured; Marketplace-publish tracked issue filed with a named owner. |
| Technical debt | Cache-crypto triplication gets a documented, checked synchronization process (not a full de-duplication); dormancy-threshold change is documented as intentionally non-retroactive in the UI copy itself. |

---

### AC-1: Machine Users Tab — List, Create, Detail

**Given** a project's detail page already has tabs for credentials/dependents/rotation history (Epic 2/5 precedent),
**When** this story lands,
**Then** add a **Machine Users** tab showing: a list of the project's machine users (name, role, key count, created date — `GET /api/v1/projects/:projectId/machine-users`), a **Create machine user** action (`POST` same endpoint) showing the `scopeBoundary` block from the creation response before any key exists (matching 7.1 AC-3's UX-DR11 requirement, which today is honored by the API but invisible to any human), and a detail view per machine user (`GET /api/v1/machine-users/:id`) showing its scope boundary, role, and key list.

**And** empty state (zero machine users) shows an honest empty-state message with the create action, not a fabricated example.

**And** role-gating matches the API: create/issue-key/revoke-key/rotate/emergency-revoke actions are visible only to org admin/owner (`minimumRole: 'admin'`); viewer/member roles see the list/detail views read-only, matching every other admin-gated action already in the web app (e.g. project archive).

**And** cross-org/not-found behavior surfaces as a standard 404 empty state, not a raw API error dump — matching the existing credential-detail-page error-handling pattern.

---

### AC-2: API Key Issuance — Plaintext-Once Display, List, Revoke

**Given** 7.1's `POST /api/v1/machine-users/:id/api-keys` returns the plaintext key exactly once,
**When** an admin issues a key from the Machine Users detail view,
**Then** the plaintext key is displayed in a modal/panel with a copy-to-clipboard action and an explicit, permanent warning that it will never be shown again — mirroring how credential-reveal-once UX already works elsewhere in this app (do not invent a new "reveal" pattern; reuse the existing one if a suitable component exists).

**And** the key list (`GET .../api-keys`) shows metadata only (name, expiry, last-used, revoked status) — never re-displays plaintext, matching the API's own no-leak guarantee.

**And** a revoke action calls `DELETE .../api-keys/:keyId` with a confirmation step (irreversible action, matching the existing confirm-before-destructive-action pattern used for project archival).

---

### AC-3: Rotation and Emergency Revocation UI

**Given** 7.2 already ships `POST .../api-keys/:keyId/rotate` (zero-downtime, configurable overlap window) and `POST .../api-keys/:keyId/emergency-revoke` (atomic revoke-old + issue-new),
**When** this story lands,
**Then** add both actions to the key-detail view: **Rotate** (with an overlap-window input, default 240 minutes, capped at 1440 per the API's own validation) and **Emergency revoke** (immediate, no overlap window, returns and displays the new plaintext key exactly once per AC-2's pattern).

**And** both actions require the same confirmation-step pattern as AC-2's revoke, given their irreversibility/security sensitivity.

---

### AC-4: Dormancy Alerts in the Existing Security Alerts Inbox

**Given** 7.2's dormancy job already writes `machine_key.dormant` rows into the existing `security_alerts` table, visible today only via the already-shipped `GET /api/v1/security-alerts` list endpoint with no dismiss/extend UI,
**When** this story lands,
**Then** the existing Security Alerts / Notifications inbox surface renders `machine_key.dormant` alerts with their payload (machine user, key, last-used date) and wires the existing **Dismiss** (`POST .../security-alerts/:id/dismiss`), **Extend** (`POST .../api-keys/:keyId/extend-dormancy`), and **Revoke** (7.1's existing revoke endpoint) actions — do not build a separate, dedicated dormancy page; extend the inbox surface that already exists for every other alert type.

**And** the org's dormancy threshold (`organizations.machine_key_dormancy_threshold_days`, 30/60/90/180) is exposed as a simple admin-only setting (`PATCH /api/v1/organizations/:orgId/machine-key-settings`) somewhere reachable from org settings — a single select input is sufficient; do not build a broader settings page around it.

**And** the setting's help text explicitly states the change is **not retroactive** — already-fired alerts are not reconciled or auto-dismissed when the threshold changes (per 7.2 D8's documented, deliberate scope boundary) — so a user changing this setting isn't surprised by stale alerts still sitting in the queue (closes AC-11 below via documentation, not new reconciliation logic).

---

### AC-5: Machine-User Deactivation

**Given** `machine_users.deactivatedAt` has existed since 7.1 with no endpoint ever setting it, and the only way to neutralize a mistakenly-created or wrong-project machine user today is to revoke its keys one at a time while the machine-user record itself remains active forever,
**When** this story lands,
**Then** add `POST /api/v1/machine-users/:id/deactivate` (`minimumRole: 'admin'`, `requireMfa: true`, matching 7.1's other mutation gates) that sets `deactivatedAt = now()`, is idempotent on an already-deactivated machine user (still `200`), and writes a `machine_user.deactivated` audit event (new lowercase-dotted constant, additive to `packages/shared/src/constants/audit-events.ts`, following 7.1's D7 naming convention).

**And** a deactivated machine user's existing keys remain individually revocable but new key issuance against it is rejected (`409 machine_user_deactivated` — 7.1's AC-11 branch, which was previously untestable-by-design and can now be exercised end-to-end through the real API).

**And** the web UI (AC-1's detail view) surfaces a **Deactivate** action with the same confirmation-step pattern as AC-2/AC-3, and a deactivated machine user renders with a clear "Deactivated" badge rather than looking indistinguishable from an active one.

**And** integration tests cover: idempotent double-deactivate, key-issuance rejection post-deactivation (now via the real endpoint, not a fixture-set column), and audit-write fail-closed behavior matching every other mutation in this module.

---

### AC-6: Offline-Cache Concurrent-Write Race — Test and Fix if Needed

**Given** 7.2's adversarial review (high) flagged that `packages/agent`'s shared cache file (`~/.project-vault/cache.json`) has no documented protection against multiple concurrent CI processes on the same host calling `getSecret()` and writing to the file simultaneously, and the story's own Completion Notes admit this was never stress-tested "given time constraints,"
**When** this story lands,
**Then** add a genuine multi-process concurrency test (spawn N concurrent Node processes/workers against the same cache file, each calling the real `writeCacheFile()`/read path) and assert: no crash, no `VaultCacheCorruptedError` under legitimate concurrent access, and the temp-file-then-rename write pattern (already implemented) actually provides atomicity under real concurrent load, not just single-process unit coverage.

**And** if the test surfaces a real corruption/crash under concurrency, fix the underlying `cache-store.ts` write path (e.g. a per-process advisory file lock, or a unique-temp-file-then-atomic-rename-per-writer scheme) rather than only asserting the bug exists.

---

### AC-7: Rate Limiting on Failed Credential-By-Name Lookups

**Given** 7.2's adversarial review (medium) noted that `GET /api/v1/machine/projects/:projectId/credentials/:name/value` has no separate throttle distinguishing failed (404/409) from successful lookups, meaning a stolen-but-not-yet-revoked machine JWT can enumerate credential names within its scoped project at the endpoint's normal throughput (300/min per 7.2 AC-27), unlike the explicit failed-attempt throttle the key-exchange endpoint has (7.2 AC-4),
**When** this story lands,
**Then** add a failed-lookup-scoped rate limit on this endpoint (e.g. N failed `404`/`409` responses per `keyId` per window) that does not affect legitimate repeated successful reads, following the same per-key-scoped-bucket pattern 7.2 AC-4 already established for the key-exchange endpoint.

**And** a test asserts repeated failed name lookups against the same machine JWT trip the limiter while successful lookups do not count against it.

---

### AC-8: Verify/Configure Branch Protection on `main`

**Given** 7.3's D7 states branch protection with required review on `main` (specifically gating the `vault-action-release.yml` workflow that can force-move the mutable `vault-action-v1` tag) is a **mandatory** operational mitigation, not optional hardening — and this retro confirmed via the GitHub API that `main` currently has **no branch protection at all**,
**When** this story lands,
**Then** configure branch protection on `main` (required PR review before merge, at minimum) — this is a repo-settings change, not application code; document the configuration performed (or, if repo-admin access is unavailable to whoever implements this story, escalate explicitly rather than silently marking this AC done without verifying the setting).

**And** re-verify via `gh api repos/:owner/:repo/branches/main/protection` that protection is actually active before closing this AC — do not rely on "I clicked the button" without confirming the API reflects it.

---

### AC-9: File the Marketplace-Publish Tracked Issue

**Given** Story 7.3's own AC-15 requires the manual GitHub Marketplace publish follow-up to be recorded with a **named owner** and a **linked tracked issue**, and its Completion Notes explicitly state this was never done ("no access to create a real GitHub issue... nor a specific named individual"),
**When** this story lands,
**Then** file a GitHub issue in this repository titled `Publish vault-action v1.0.0 to GitHub Marketplace`, assign it to a named individual holding `project-vault` GitHub-org-owner permissions, and reference the issue number in this story's Completion Notes — closing the loop 7.3 explicitly left open.

**And** if implementing this AC without a named owner available, do not silently skip it — flag it the same way 7.3 did, rather than repeating the same unresolved-and-untracked pattern this story exists to fix.

---

### AC-10: Document a Cache-Crypto Cross-Release Synchronization Check

**Given** the AES-256-GCM/HKDF cache-crypto implementation is intentionally duplicated (not imported) across three independently-versioned artifacts — `packages/crypto/src/aes.ts` (server), `packages/agent/src/cache-crypto.ts`, and `packages/vault-action`'s bundled `dist/index.js` — with no automated mechanism tying a future security fix in one to a mandatory rebuild of the other two (the existing cross-compatibility test, `apps/api/src/__tests__/agent-crypto-cross-compat.test.ts`, only proves the two source implementations are interoperable *today*, not that a future edit to one is propagated),
**When** this story lands,
**Then** add a code comment (or a lightweight checked-in checklist, e.g. in `CONTRIBUTING.md` or a `packages/agent/SECURITY.md`) at each of the three locations, cross-referencing the other two by path, stating explicitly: "a security-relevant change here requires (1) re-running the cross-compat test, (2) rebuilding `packages/vault-action/dist/`, (3) a `vault-action` re-tag/release." This is a documentation/process control, not new automation — do not attempt to build a build-graph dependency-change-detector for this story; that is a larger investment than this AC's scope.

**And** verify the existing cross-compat test (`agent-crypto-cross-compat.test.ts`) still passes as a baseline before considering this AC complete.

---

## Tasks / Subtasks

- [ ] **Task 1: Machine Users tab (list/create/detail)** (AC-1)
- [ ] **Task 2: API key issuance/list/revoke UI** (AC-2)
- [ ] **Task 3: Rotation + emergency-revoke UI** (AC-3)
- [ ] **Task 4: Dormancy alerts in the existing Security Alerts inbox + dormancy-threshold setting** (AC-4)
- [ ] **Task 5: Machine-user deactivation endpoint + UI action** (AC-5)
  - [ ] `POST /api/v1/machine-users/:id/deactivate` + audit event + `409` on key-issuance-after-deactivation
  - [ ] Web UI action + "Deactivated" badge
- [ ] **Task 6: Offline-cache concurrency test (+ fix if needed)** (AC-6)
- [ ] **Task 7: Failed-lookup rate limit on machine credential-by-name endpoint** (AC-7)
- [ ] **Task 8: Verify/configure `main` branch protection** (AC-8)
- [ ] **Task 9: File Marketplace-publish tracked issue with named owner** (AC-9)
- [ ] **Task 10: Document cache-crypto cross-release sync check** (AC-10)
- [ ] **Task 11: Full regression** — `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm jscpd` (0 clones), full `apps/api`/`apps/web`/`packages/db`/`packages/shared`/`packages/agent`/`packages/vault-action` test suites, `pnpm --filter @project-vault/db check-rls`, `make ci`

---

## Dev Notes

### Project Structure Notes

- **Web:** new route(s) under a project's detail page (`apps/web/src/routes/(app)/projects/[id]/machine-users/`), matching the aspirational route `architecture.md:892` already named — this story is what finally builds it. Extend the existing Security Alerts / Notifications inbox component for AC-4 rather than creating a new page.
- **API:** one new endpoint (`POST /api/v1/machine-users/:id/deactivate`, AC-5) plus a new rate-limit bucket (AC-7) — both additive to `apps/api/src/modules/machine-users/`. No new schema/migration is required for AC-1–AC-4, AC-6, AC-7 (all consume already-shipped 7.1/7.2 endpoints/tables); AC-5 needs no new column either (`deactivatedAt` already exists, per 7.1 AC-1).
- **No other Epic 7/8/9 story's scope is touched.** Do not fold 8-5's rotation-web-ui-hardening findings into this story or vice versa — they are independent closure stories bundling independent epics' findings.

### Key Code Patterns to Follow

- **Plaintext-once display (AC-2):** check whether an existing "reveal secret once" UI component/pattern exists in `apps/web` (credential creation flow) before building a new one — reuse it if the shape fits.
- **Confirmation-before-destructive-action (AC-2/AC-3/AC-5):** reuse whatever confirmation-dialog pattern project archival already uses — do not invent a second one.
- **Rate limiting (AC-7):** reuse `enforceUserRateLimit`'s per-key-scoped-bucket pattern exactly as 7.2 AC-4 already established for the key-exchange endpoint — do not invent a new limiter shape.
- **Audit events (AC-5):** lowercase-dotted, additive-only, following 7.1's D7 convention (`machine_user.deactivated`).

### Anti-Patterns (Do Not)

- Do NOT build a new dormancy-specific inbox page for AC-4 — extend the existing Security Alerts surface.
- Do NOT attempt to de-duplicate the triplicated cache-crypto implementations for AC-10 — that is a larger refactor than this story scopes; a documented process check is the deliverable, not a code consolidation.
- Do NOT build automatic reconciliation of stale dormancy alerts on threshold change for AC-4/AC-11 — this is an accepted, documented design trade-off (7.2 D8); the fix here is UI copy, not new logic.
- Do NOT mark AC-8 or AC-9 "done" without independently re-verifying the actual state (branch-protection API response; a real, linked GitHub issue number) — this story exists partly *because* a prior story's self-reported completion wasn't independently verified (see `epic-7-retro-2026-07-06.md`, N7-2).

### References

- `_bmad-output/implementation-artifacts/epic-7-retro-2026-07-06.md` — source retro for every AC in this story.
- `_bmad-output/implementation-artifacts/7-1-machine-user-identity-and-api-key-management.md` — machine-user/API-key schema and endpoints this UI consumes.
- `_bmad-output/implementation-artifacts/7-2-machine-user-authentication-and-programmatic-secret-retrieval.md` — rotation/dormancy/emergency-revoke endpoints; D8 (dormancy threshold non-retroactivity), D9 (security_alerts reuse), D11 (cache-crypto duplication rationale).
- `_bmad-output/implementation-artifacts/7-3-github-actions-cicd-integration.md` — D7 (branch-protection mitigation, Marketplace-publish requirement).
- `_bmad-output/implementation-artifacts/5-5-epic-5-completion-rotation-hardening-and-technical-debt.md` — sibling closure-story precedent this story's structure mirrors.
- `_bmad-output/implementation-artifacts/8-5-rotation-web-ui-hardening.md` (if created) — sibling Epic 8 cross-epic-hardening-bucket entry, same pattern, different epic's findings.
