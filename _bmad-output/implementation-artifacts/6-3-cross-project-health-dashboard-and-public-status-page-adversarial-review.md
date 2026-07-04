# Adversarial Review: Story 6.3 — Cross-Project Health Dashboard & Public Status Page

- **Date:** 2026-07-04
- **Reviewed file:** `_bmad-output/implementation-artifacts/6-3-cross-project-health-dashboard-and-public-status-page.md`
- **Reviewer:** bmad-review-adversarial-general

## Findings

- **`critical`** — Status/prerequisite contradiction: the story's front-matter declares `Status: ready-for-dev`, yet ADR-6.3-01 states this story has a "hard prerequisite" on Story 6.2, which "was still `backlog` at the time this story was written," and Task 0 explicitly instructs the dev to "stop and coordinate" if 6.2 is not done. A story cannot honestly be `ready-for-dev` while it documents, in its own architecture section, that it is blocked on an unstarted dependency. This should be `blocked`/`backlog` until 6.2 is confirmed `done`.

- **`critical`** — The public, unauthenticated `GET /api/v1/status-pages/:token` route (AC 12–14, Task 7) must read `status_pages`/`status_page_services` rows across *all* organizations (the caller has no session and is not scoped to any single org), but both tables are declared `orgScoped` with `ENABLE ROW LEVEL SECURITY` policies that (per every other table in this codebase, and per AC 5/10's own description of "RLS `org_id` scoping via `withOrg`") key off `current_setting('app.current_org_id')`. The story never explains how this specific query establishes (or deliberately bypasses) an org context under RLS. This is not a minor implementation detail — it's the central technical mechanism of the entire public-status-page feature, and left unresolved it will either block Task 7 outright or tempt a developer into an ad hoc RLS bypass (e.g., a superuser/no-RLS connection) that isn't reviewed anywhere in this story.

- **`high`** — ADR-6.3-02's `ServiceHealthStatus`/`getServiceHealthStatuses()` contract, and therefore ADR-6.3-03's entire "degraded" derivation (and ACs 1–3, 7), is speculative: it is an interface the story *hopes* Story 6.2 will expose, for a story that "does not exist in the codebase yet" as of this writing. If 6.2 ships without a per-service configurable `checkIntervalMinutes`, a different consecutive-failure threshold, or a differently-shaped status enum, every downstream AC in section A and B is invalidated. Marking this story implementation-ready today, contingent on guessing another team's unwritten contract correctly, is a real delivery risk understated by treating it as a "just update the call site" footnote.

- **`high`** — No sanitization/escaping requirement is specified anywhere for the user-supplied `displayName` field (AC 15, up to 100 chars) that ends up rendered on the public, unauthenticated status page (AC 12, Task 10). Given this review was explicitly asked to weigh injection/input-validation risk, and the field is operator-controlled text rendered to anonymous external viewers, the story should call out escaping/sanitization expectations explicitly rather than silently relying on SvelteKit's default auto-escaping.

- **`high`** — Persona/UI inconsistency: ADR-6.3-07 and ACs 8, 9, 11, 15, 16 all authorize "project owner **or** org owner" for status-page mutations, but Task 9 says the web UI section is "gated in the UI to project owners" only. An org owner who is not also a project owner would pass every backend authorization check but could be hidden from the management UI entirely, making a documented-valid caller unable to reach the feature through the product surface this story ships.

- **`medium`** — Rate-limit specification is inconsistent in rigor: AC 6 (`{max: 120, timeWindowMs: 60_000}`) and AC 13 (`{max: 60, timeWindowMs: 60_000}`) give exact, testable numbers, but Task 6's admin mutation routes (`POST`/`PUT`/`DELETE`/regenerate) only reference `WRITE_RATE_LIMIT` by name with no concrete value stated anywhere in this story's ACs — making it impossible to write an AC-traceable test for the mutation routes' rate limit the way ACs 6 and 13 allow for the read routes.

- **`medium`** — Zero enumeration/abuse visibility: the public status-page GET is explicitly never audit-logged (AC 14, 18, Known Scope Boundaries), and there is no alternate logging/metrics mechanism proposed for repeated-404 patterns against `/api/v1/status-pages/:token`. Given the review scope explicitly includes audit/logging gaps, a security-relevant endpoint with 256-bit tokens but literally zero visibility into probing/enumeration attempts is worth flagging even though brute-forcing the token itself is impractical.

- **`medium`** — Eligibility drift is unaddressed: AC 15/Task 6 validate that a referenced `serviceId` has a non-null `url` only at `PUT` time. If that service's `url` is later cleared (or the service is otherwise made ineligible) via a completely different endpoint (6.1's service CRUD), there is no described re-validation, cleanup job, or AC covering what the public page then shows for a now-disqualified-but-still-referenced service — it can reference a permanently-stale/never-checked entry indefinitely.

- **`medium`** — Ambiguous batching granularity in Task 3: "query all non-archived projects ... batch-call `getServiceHealthStatuses()`" doesn't specify whether this is one org-wide batched call or one call per project. Combined with the Known Scope Boundary's explicit acceptance of an unpaginated, unbounded-growth endpoint, an accidental per-project (N+1) implementation would compound the existing unbounded-scale risk this story already acknowledges but doesn't fully close off.

- **`medium`** — AC 11's documented concurrent-regenerate race (two `200`s, only the last-committed token valid) interacts unaddressed with AC 17's audit invariant: both concurrent calls will each write their own `STATUS_PAGE_TOKEN_REGENERATED` audit row inside their own successful transaction, producing two audit events for what is effectively one final winning state, with no guidance on how a reviewer should interpret that audit trail later.

- **`medium`** — Shared per-IP rate-limit bucket (AC 13) for the public endpoint is explicitly "not keyed by token," meaning any shared/NAT'd IP (corporate network, CGNAT mobile carrier) that happens to be monitoring multiple status pages can exhaust the 60 req/min ceiling and lock out unrelated legitimate viewers behind the same IP. The story frames this purely as a deliberate FR77-compliance choice and doesn't weigh it as an availability trade-off.

- **`medium`** — MFA requirement on enable/regenerate (AC 9) has no described fallback for a legitimate project owner who has not enrolled in MFA: the story gives no reference to an MFA self-enrollment flow, error remediation UX, or any AC covering "authorized-but-unenrolled" beyond "receives the standard MFA-required error" — effectively an availability gap for a subset of otherwise-authorized users with no described recovery path within this story's scope.

- **`low`** — Acknowledged-but-perpetuated technical debt: AC 17 explicitly calls the dual-listing of `AuditEvent` object + `AuditEventType` union "easy to silently under-cover" (missing either half is a type error only), yet the story does nothing to consolidate or derive one from the other — it just repeats the same fragile pattern a second time (after 6.1) rather than proposing a fix.

- **`low`** — No CORS/embeddability/caching guidance for the public status page endpoint despite it being explicitly designed for external sharing (e.g., whether it may be iframe-embedded on a stakeholder's own status page, or whether responses should be marked non-cacheable so a CDN/proxy doesn't serve stale status after a regenerate/disable).

- **`low`** — No handling described for viewers of a previously-shared link when a status page is disabled or its token regenerated: they silently receive the same generic `404` used for "never existed" (AC 12/16), with no distinction and no notification mechanism to the org admin about active external viewers being cut off — a real-world support-burden gap not scoped anywhere in this story.

- **`low`** — Continuing naming/domain-model debt: the "services" shown on both the internal health dashboard and the public status page are sourced from a table literally named `payment_records` (a 6.1 legacy), and this story doubles down on that mismatch rather than flagging it for eventual rename — increasing the gap between the domain language used in ACs/UI copy ("services") and the physical schema.

## Resolution Log (post-review fixes applied 2026-07-04)

All 16 findings were addressed directly in the story file. Summary of fixes:

1. **`critical` (status contradiction)** — Story header changed from `Status: ready-for-dev` to `Status: backlog (blocked on Story 6.2 ...)`; `sprint-status.yaml` reverted to `backlog` with an inline comment. The story is honestly gated until 6.2 ships.
2. **`critical` (RLS mechanism undefined)** — Added new **ADR-6.3-09**, grounded in the actual codebase precedent (`apps/api/src/modules/invitations/lookup.ts`'s `findInvitationByTokenHash()`, which already solves this exact problem for the RLS-protected `project_invitations` table via `getAdminDb()`). Specifies a `findStatusPageByTokenHash()` admin-connection point lookup, followed by `withOrg(orgId, ...)` for the `status_page_services` join, plus a required RLS-coverage-exception test. Task 7 updated to match.
3. **`high` (speculative ServiceHealthStatus contract)** — ADR-6.3-02 extended with an explicit delivery-risk paragraph: Task 0 must re-derive ADR-6.3-02/03 and ACs 1-3/7 if 6.2's actual shape differs materially, and must stop for re-planning rather than force-fit a mismatched contract.
4. **`high` (no sanitization/escaping requirement)** — AC 15 extended with an explicit injection example: `displayName` is stored verbatim but must render via Svelte's default auto-escaping only (never `{@html}`), with required test coverage in both the API round-trip test and a Task 10 component test.
5. **`high` (persona/UI inconsistency)** — Task 9 rewritten to gate the UI section on the same project-owner-or-org-owner condition as the backend (ADR-6.3-07), not project-owner alone.
6. **`medium` (rate-limit rigor gap)** — Added AC 10a stating the concrete `WRITE_RATE_LIMIT` value (`{max: 60, timeWindowMs: 60_000}`, sourced from `apps/api/src/modules/monitoring/routes.ts:95`) for the four mutation routes.
7. **`medium` (zero enumeration visibility)** — Added a Known Scope Boundary explicitly documenting reliance on standard Fastify access logs and explaining why dedicated abuse-metrics tooling is out of scope.
8. **`medium` (eligibility drift)** — Added a Known Scope Boundary specifying that a service missing from `getServiceHealthStatuses()`'s result map (e.g., `url` cleared post-PUT) must be reported as `status: 'down'`, not omitted; added corresponding test requirement to Task 11.
9. **`medium` (ambiguous batching granularity)** — Task 3 rewritten to mandate exactly one org-wide batched `getServiceHealthStatuses()` call, explicitly prohibiting a per-project N+1 pattern.
10. **`medium` (concurrent-regenerate audit double-write)** — Added an explicit AC 11 example stating two audit rows on a regenerate race is intentional and must not be suppressed/deduplicated.
11. **`medium` (shared per-IP rate-limit trade-off)** — Added an explicit "accepted availability trade-off" note to AC 13.
12. **`medium` (MFA fallback gap)** — Added an explicit note to AC 9 clarifying this is pre-existing `requireMfa` behavior, not a new gap, and out of scope to change.
13. **`low` (AuditEvent dual-listing debt)** — Added a Known Scope Boundary acknowledging the debt is continued, not fixed, and explaining why (cross-story refactor scope).
14. **`low` (no CORS/embeddability/caching guidance)** — Added a Known Scope Boundary + Task 7 requirement: `Cache-Control: no-store` on the public GET response; explicit no-op decision on CORS/frame-ancestors.
15. **`low` (no notification on link revocation)** — Added a Known Scope Boundary documenting the generic-404 behavior as intentional given no viewer identity exists to notify.
16. **`low` (payment_records naming debt)** — Added a Known Scope Boundary acknowledging the continued mismatch and scoping a rename as a separate tech-debt item.

Two pre-existing broken cross-references (`see AC 29`, `see AC 21` — this story only has ACs 1-20 plus the new 10a) were also corrected to their actual targets (AC 18, AC 16) while editing nearby text; these were not part of the original 16 findings but were caught in the course of this pass.

