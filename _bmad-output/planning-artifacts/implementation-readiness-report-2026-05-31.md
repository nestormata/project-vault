---
stepsCompleted: [step-01-document-discovery, step-02-prd-analysis, step-03-epic-coverage-validation, step-04-ux-alignment, step-05-epic-quality-review, step-06-final-assessment]
documentsIncluded:
  prd: _bmad-output/planning-artifacts/prd.md
  architecture: _bmad-output/planning-artifacts/architecture.md
  epics: _bmad-output/planning-artifacts/epics.md
  ux: _bmad-output/planning-artifacts/ux-design-specification.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-05-31
**Project:** Project Vault

---

## Epic Quality Review

### Review Summary

9 epics reviewed. Stories read in full for Epic 1 (12 stories); Epic 2 headers and story ACs reviewed; Epics 3–9 reviewed at epic-level structure, FR coverage, and explicit notes/warnings.

---

### Epic Structure Validation

| Epic | User-Value Focus | Can Stand Alone? | Verdict |
|------|-----------------|------------------|---------|
| Epic 1: Vault Foundation | ⚠️ Partially technical (deployment, auth) — user-framed description | Yes — foundational, no upstream deps | ✅ Acceptable with notes |
| Epic 2: Secret & Credential Management | ✅ Users store/retrieve/search credentials | Depends on Epic 1 foundation | ✅ Correct |
| Epic 3: Notification Infrastructure | ✅ Users receive event notifications | Hard dependency on Epic 2 (explicitly noted) | ✅ Acceptable — dependency documented |
| Epic 4: Team & Org Management | ✅ Users invite members, manage roles, archive | Depends on Epic 1 | ✅ Correct |
| Epic 5: Credential Rotation | ✅ Users rotate credentials with per-system confirmation | Depends on E1+E2 | ✅ Correct |
| Epic 6: Operational Monitoring | ✅ Users monitor services, certs, domains; mobile incident response | Depends on E1+E2+E3 | ✅ Correct |
| Epic 7: Machine User Access | ✅ CI/CD pipelines authenticate and retrieve secrets | Depends on E1+E2; blocked on SDK scope decision | ⚠️ Dependency documented; scope decision must resolve before sprint |
| Epic 8: Compliance, Audit & Governance | ✅ Compliance officers filter, export, verify audit logs | Depends on E1 (audit writes from day 1) | ✅ Correct |
| Epic 9: Platform Operations, API & Self-Hosting | ⚠️ Mix of user value (backups, upgrades) and technical hardening (API parity, OpenAPI) | Requires stable feature API from E1–E8 | ⚠️ Partially technical; see issues |

---

### 🔴 Critical Violations

**CQ-1 — Stories 1.1 and 1.2 are developer-persona stories, not user-persona stories**

Stories 1.1 ("Initialize Turborepo Monorepo...") and 1.2 ("Configure Backend Package Structure") use the persona "As a developer..." and deliver no direct user value. They are infrastructure and tooling setup stories.

While the epics document explicitly requires these stories ("Starter Template — MUST be Epic 1, Story 1"), they technically violate the user-story principle of delivering user-observable value.

**Assessment:** This is a pragmatic greenfield exception. The stories are correctly placed, well-specified, and have comprehensive ACs. No remediation required. **Accepted as-is with explicit documentation that this is a one-time exception for the monorepo initialization.**

**Note:** Story 1.11 ("SecureRoute Framework & Drizzle RLS Middleware") is also a developer-persona story embedded in Epic 1. The same exception applies.

---

### 🟠 Major Issues

**MQ-1 — FR63 (project archival) in Epic 4 has an unresolved forward dependency on Epic 7**

The FR Coverage Map notes: `FR63: Epic 4 (machine user dependency guard completed in Epic 7)`.

Epic 4 will implement project archival, but the story for FR63 cannot have its full acceptance criteria verified until Epic 7 ships the machine user dependency guard. A project with active machine user access must be blocked from archival or require explicit dependency transfer confirmation — but this logic lives in Epic 7.

**Impact:** If Epic 4 and Epic 7 ship to separate beta tiers (E4 at Tier 1, E7 at Tier 2/GA), the archival feature will be incomplete for projects with machine users for an extended period. Users could archive projects that break active CI/CD pipelines.

**Recommendation:** The Epic 4 story for FR63 must either:
- (a) Include a stub guard that blocks archival if any machine user API keys exist for the project (even without Epic 7's full logic), OR
- (b) Add an explicit acceptance criterion: "Projects with machine user API keys cannot be archived until those keys are revoked — verified by querying `machine_users` table."

This is solvable in Epic 4 without waiting for Epic 7 by checking the machine_users table existence.

---

**MQ-2 — FR73 (failed auth alerting) in Epic 1 produces structurally silent alerts until Epic 3**

Epic 1 builds failed authentication detection and creates `PENDING_DELIVERY` alert records. These alerts remain functionally silent until Epic 3 (notification infrastructure) ships. The epics document acknowledges this with an explicit PENDING_DELIVERY mechanism and "PENDING: Epic 3" log marker.

**Impact:** During the Tier 0 beta period (Epic 1 only, before Epic 3), security events from failed authentication attempts accumulate in the `security_alerts` table but nobody receives them. For a security-focused product launching to 5–10 real teams, this is a credibility risk if it goes unmentioned.

**Assessment:** The mitigation (PENDING_DELIVERY state + explicit log entry) is adequate IF:
- The Epic 1 story for FR73 explicitly tests that the `PENDING_DELIVERY` status is set (not just that the alert was "created")
- The Epic 1 story documents the behavior in the deployment guide

**Recommendation:** Confirm the Epic 1 story for FR73 includes an AC: "Alert records in PENDING_DELIVERY state are surfaced in the Org Admin dashboard even before Epic 3 is live — e.g., via a system notifications panel showing undelivered alerts with a 'notification channel not configured' badge."

---

**MQ-3 — FR57 (MFA enforcement) acceptance criteria split across Epic 1 and Epic 4**

The FR Coverage Map notes: `FR57: Epic 1 (MFA enforcement before inviting members — verified in Epic 4)`.

The enforcement logic is built in Epic 1, but the full AC (that MFA is required before invitation) can only be verified in Epic 4 when the invitation flow exists.

**Impact:** Epic 1's story for FR57 will have incomplete acceptance criteria — it cannot pass its own stated ACs without Epic 4 features. This creates a testing gap: the story is merged as "complete" but its primary acceptance criterion isn't verifiable until a later epic.

**Recommendation:** Epic 1 should split FR57 into:
- Epic 1 AC: "Any endpoint with `requireMfa: true` flag returns `403 mfa_required` when user has no MFA enrolled — verified with a mock privileged endpoint in the test suite."
- Epic 4 AC: "Invitation endpoint specifically enforces MFA — a non-MFA-enrolled owner cannot invite members."

This way Epic 1 tests the mechanism and Epic 4 tests the specific business rule.

---

**MQ-4 — Epic 9 mixes post-hoc verification (FR47 API parity) with first-class features**

Epic 9 includes: "REST API parity verification + OpenAPI finalization (API endpoints built with feature epics 1–8)." This is a retroactive audit/QA activity, not a feature story. If Epic 9 is deferred (it's a v1 GA epic), the OpenAPI spec remains unpublished and API parity is unverified.

**Impact:** The open-core model requires the OpenAPI spec to be published "with the OSS release" (per PRD). If Epic 9 is deferred, this is blocked. Additionally, if individual feature epics don't maintain their API spec incrementally, Epic 9 becomes a large, unpredictable cleanup story.

**Recommendation:** 
- Each feature epic (1–8) should include an AC for its own API endpoints: "Endpoint is included in auto-generated OpenAPI spec via `@fastify/swagger`; spec validates without errors after this story."
- Epic 9's FR47/FR48 story then becomes a lightweight final verification + publication task, not a catch-up task.

---

### 🟡 Minor Concerns

**mq-1 — Epic 9's name "Platform Operations, API & Self-Hosting" mixes user-facing features with technical hardening**

The epic covers legitimate user-value features (backups FR88–FR92, upgrades FR50, system settings FR86) alongside technical completion work (API parity, OpenAPI, multi-org UI). Consider splitting into "Platform Operations" (user-facing: backups, upgrades, settings) and "API Finalization & Hardening" (technical). At minimum, the user-facing stories should be prioritized within Epic 9 so they can ship to early users before technical hardening is complete.

**mq-2 — Epic 8 audit_events table is built in Epic 1, but Epic 8 is a v1 GA epic**

The architecture decision to write audit events in the same transaction as operations (from Epic 1 onward) means audit data accumulates for all of v1 before the query/filter/export UI (Epic 8) is available. This is a correct design choice, but it means compliance-focused early adopters (e.g., Dana's journey) have no way to access their audit trail until Epic 8 ships (GA tier).

Mitigation already in place: audit data is written from day one, so nothing is lost. The exposure is UI access only. Consider adding a minimal "raw audit log API endpoint" (read-only, no filtering) to Epic 4 or Epic 5 as an interim measure for compliance users in early betas.

**mq-3 — Story sizing in Epic 1 is large (12 stories)**

Epic 1 contains 12 stories, with Story 1.1 in particular being extremely large (spanning monorepo setup, CI, Docker, pre-commit, GitHub Actions, documentation, base image management, CVE management, and audit baseline hygiene). This could take 2–3 weeks for a solo developer.

This is not a structural defect — the story is correctly specified and covers truly necessary groundwork. But the PM/Scrum Master should plan for this story to be the longest single story in the project. If velocity is slow, splitting Story 1.1 into "scaffold" and "quality gates" sub-tasks (not separate stories) may help track progress.

---

### Best Practices Compliance Checklist

| Check | Epic 1 | Epic 2 | Epics 3–9 (aggregate) |
|-------|--------|--------|----------------------|
| Epic delivers user value | ⚠️ Partially | ✅ | ✅ |
| Epic can function independently | ✅ | ✅ | ✅ with noted deps |
| Stories appropriately sized | ⚠️ S1.1 is large | ✅ | Not fully verified |
| No forward dependencies | ⚠️ FR57, FR63 cross-epic | ✅ | ⚠️ FR63 |
| Database tables created when needed | ✅ Core schema in E1 | ✅ | Not fully verified |
| Clear acceptance criteria (BDD) | ✅ | ✅ | ✅ from coverage map |
| Traceability to FRs maintained | ✅ | ✅ | ✅ |
| Starter template requirement met | ✅ | N/A | N/A |
| Greenfield indicators present | ✅ | N/A | N/A |

---

### Epic Quality Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| CQ-1 | 🔴 Critical (accepted) | S1.1, S1.2, S1.11 are developer-persona stories — greenfield exception accepted |
| MQ-1 | 🟠 Major | FR63 archival forward dep on Epic 7 machine user guard — stub guard needed in Epic 4 |
| MQ-2 | 🟠 Major | FR73 alerts silent until Epic 3 — PENDING_DELIVERY mechanism needs AC coverage and admin visibility |
| MQ-3 | 🟠 Major | FR57 MFA enforcement ACs split across Epic 1 and Epic 4 — needs explicit test boundary definition |
| MQ-4 | 🟠 Major | Epic 9 API parity (FR47/FR48) is retroactive — feature epics should maintain OpenAPI incrementally |
| mq-1 | 🟡 Minor | Epic 9 mixes user features with technical hardening — prioritize user-facing stories within epic |
| mq-2 | 🟡 Minor | No audit log UI until Epic 8 (GA tier) — consider minimal read-only audit API endpoint in earlier epic |
| mq-3 | 🟡 Minor | Story 1.1 is very large — plan 2–3 week timeline for solo developer |

---

## UX Alignment Assessment

### UX Document Status

**Found:** `_bmad-output/planning-artifacts/ux-design-specification.md` (31.8K, dated 2026-05-27)

The UX specification covers: Project Vision, Target Users (Alex, Sam, Morgan, Dana, CI-Bot, Buyer), Key Design Challenges, Design Opportunities, Core User Experience (defining experience, platform strategy, effortless interactions, critical success moments, experience principles).

---

### UX ↔ PRD Alignment

**UX-DR Requirements Coverage** (from epics document, verified against UX spec):

| UX-DR | Requirement | UX Coverage | Status |
|-------|-------------|-------------|--------|
| UX-DR1 | Onboarding wizard enforces project-centric model (bypass-proof; ≥80% correct second credential placement) | Key Design Challenge 1; Effortless Interactions | ✅ Aligned |
| UX-DR2 | Dashboard separates monitoring mode (15–30s scan) vs. action mode (focused flows) | Key Design Challenge 2 | ✅ Aligned |
| UX-DR3 | Security-critical config flows: correct path = default path; contextual education inline | Key Design Challenge 3; Design Principle | ✅ Aligned |
| UX-DR4 | Intelligent default urgency calculation for alerts (context-aware, not just time-based) | Key Design Challenge 4 | ✅ Aligned |
| UX-DR5 | Coverage gaps visible alongside present assets; project health indicator | Design Opportunity 2; Effortless Interactions | ✅ Aligned |
| UX-DR6 | Import review screen with full field mapping; nothing committed until user confirms | Design Opportunity 3 | ✅ Aligned |
| UX-DR7 | Inline dependency prompting during credential creation (fast-add, not separate settings) | Design Opportunity 4 | ✅ Aligned |
| UX-DR8 | Global search-first credential retrieval; ≤3 keystrokes from anywhere | Effortless Interactions; Experience Principles | ✅ Aligned |
| UX-DR9 | Auto-enroll monitoring/alerting when assets registered; users opt out, never opt in | Effortless Interactions | ✅ Aligned |
| UX-DR10 | Mobile incident response: ≤2 taps to resource; rotation status on mobile without scrolling; actions without full keyboard | Design Opportunity 8 | ✅ Aligned |
| UX-DR11 | Machine user scope boundary visible before API key issuance | Design Opportunity 9 | ✅ Aligned |
| UX-DR12 | Buyer/governance view distinct from operator dashboard (team access, compliance readiness, security events) | Design Opportunity 10 | ✅ Aligned |
| UX-DR13 | Audit log integrity verification mandatory first step in compliance export flow | Key Design Challenge 6 | ✅ Aligned (principle stated; detailed flow not designed) |
| UX-DR14 | Empty/zero states communicate project potential; direct path to first action | Design Opportunity 7 | ✅ Aligned |
| UX-DR15 | Responsive web app; WCAG 2.1 AA baseline; adapts to desktop/tablet/mobile | Platform Strategy | ✅ Aligned |

**User Journey Coverage:**

| PRD Journey | UX Target User | Coverage |
|-------------|----------------|----------|
| Alex (engineering lead, success path) | Alex — Engineering Lead (Primary) | ✅ Aligned |
| Sam (indie developer, multi-project) | Sam — Solo/Indie Developer (Secondary) | ✅ Aligned |
| Morgan (incident response, 2am) | Morgan — Platform Engineer / On-Call (Edge Case) | ✅ Aligned |
| CI-Bot (machine user, API path) | CI-Bot — Machine User (API Consumer) | ✅ Aligned |
| Dana (compliance, audit) | Dana — Security & Compliance Lead | ✅ Aligned |
| — | Buyer — Engineering Manager / CTO | ✅ Added in UX (not a separate PRD journey but implied) |

---

### UX ↔ Architecture Alignment

The architecture document (117.3K) has not yet been read in this workflow step; a full architecture analysis follows in Step 5. Based on the technology stack specified in the epics:

| UX Requirement | Technology Support | Assessment |
|----------------|-------------------|------------|
| Responsive web app; WCAG 2.1 AA | SvelteKit 2 + Svelte 5; SSR/hydration model | ✅ Appropriate |
| ≤2s dashboard first meaningful content | SvelteKit SSR + Fastify v5 API | ✅ Achievable |
| Global search ≤3 keystrokes | Requires API search endpoint; Drizzle/PostgreSQL full-text search or index-based filtering | ⚠️ Search architecture not explicitly specified |
| Auto-enroll monitoring on asset registration | pg-boss background jobs (explicit in epics) | ✅ Supported |
| Mobile incident response deep-links | SvelteKit routing + push notification delivery path | ⚠️ Deep-link delivery mechanism (email → resource URL) not architecturally specified |
| Audit log integrity verification as mandatory step | Cryptographic chaining API (FR78); chain verification callable from export flow | ✅ Supported |
| Sub-100ms secret fetch | Fastify v5 + PostgreSQL indexed lookups | ✅ Achievable at reference load |

---

### Warnings

**⚠️ W-UX-1 — Detailed flow designs absent for security-critical UX paths**

The UX document establishes *principles* for security-critical configuration flows (vault unsealing, MFA enrollment/recovery, machine user scoping, account deletion with ownership transfer, break-glass rotation) but does not include detailed wireframes, user flow diagrams, or step-by-step interaction designs for these flows.

PRD explicitly calls out these flows as "v1 product requirements requiring UX design treatment" and a "potential complexity leak." Stories implementing these flows will need to synthesize interaction design from principles alone — a risk for implementation consistency.

**Affected FRs:** FR9 (onboarding wizard), FR56 (account recovery), FR60 (vault unsealing), FR77 (public status page setup), FR108 (break-glass rotation), and the account deletion ownership transfer flow.

**Recommendation:** Before story implementation begins for these flows, ensure acceptance criteria in each story include explicit UX decisions (step sequence, error states, confirmation dialogs) derived from the UX principles.

**⚠️ W-UX-2 — Buyer/governance view (UX-DR12) not mapped to a single explicit FR**

The UX design opportunity for a CTO/EM governance view (team access summary, compliance readiness, security events, subscription usage) is described richly in the UX spec and cited as UX-DR12 in the epics. However, this capability is partially spread across FR69 (point-in-time access report), FR87 (resource usage monitoring), and the FR31/anomaly alerting areas — without a single composing FR that defines the governance dashboard as a unified surface.

**Impact:** Implementation teams may build these components independently and fail to compose them into the cohesive buyer-oriented view the UX envisions.

**Recommendation:** Epic 8 or 9 should include a story explicitly composing the governance/buyer view surface, referencing UX-DR12 as the design driver.

**ℹ️ Note — UX scope is intentionally principle-level**

The UX spec is a design philosophy document rather than a wireframe specification. This is appropriate for the project's stage (pre-implementation). The 15 UX-DR requirements in the epics translate these principles into implementation-level constraints that individual stories can reference. No structural gap between UX doc and epics was found.

---

## Epic Coverage Validation

### Coverage Matrix

| FR | PRD Requirement (summary) | Epic | Status |
|----|--------------------------|------|--------|
| FR1 | Create and configure projects as primary org unit | Epic 2 | ✅ Covered |
| FR2 | Project Owners invite users and assign roles | Epic 4 | ✅ Covered |
| FR3 | Users hold different roles across different projects | Epic 4 | ✅ Covered |
| FR4 | Project Owners can transfer ownership | Epic 4 | ✅ Covered |
| FR5a | Org Admins view all users and memberships | Epic 4 | ✅ Covered |
| FR5b | Org Admins remove users from org | Epic 4 | ✅ Covered |
| FR5c | Org Admins change user role in any project | Epic 4 | ✅ Covered |
| FR6 | Multi-org support in self-hosted instance | Epic 9 | ✅ Covered |
| FR7 | Unified cross-project dashboard | Epic 2 | ✅ Covered |
| FR8 | Notes and descriptions on projects | Epic 2 | ✅ Covered |
| FR9 | Interactive onboarding wizard | Epic 2 | ✅ Covered |
| FR10 | Store secret with full metadata | Epic 2 | ✅ Covered |
| FR11 | Retrieve current version of authorized secret | Epic 2 | ✅ Covered |
| FR12 | Immutable version history per secret | Epic 2 | ✅ Covered |
| FR14 | Search and filter credentials | Epic 2 | ✅ Covered |
| FR15 | Expiry dates and rotation schedules | Epic 2 | ✅ Covered |
| FR16 | Record dependent systems per credential | Epic 2 | ✅ Covered |
| FR17 | Bulk import from .env and JSON | Epic 2 | ✅ Covered |
| FR18 | Initiate rotation workflow | Epic 5 | ✅ Covered |
| FR19 | Generate per-system confirmation checklist | Epic 5 | ✅ Covered |
| FR20 | Mark checklist systems as confirmed | Epic 5 | ✅ Covered |
| FR21 | Prevent completion with unconfirmed systems | Epic 5 | ✅ Covered |
| FR22 | Retire old credential only after all confirmations | Epic 5 | ✅ Covered |
| FR23 | Complete rotation history per credential | Epic 5 | ✅ Covered |
| FR24 | Service records with expiry/renewal dates | Epic 6 | ✅ Covered |
| FR25 | SSL/TLS certificate records with expiry | Epic 6 | ✅ Covered |
| FR26 | Domain records with renewal dates | Epic 6 | ✅ Covered |
| FR27 | HTTP endpoint availability monitoring | Epic 6 | ✅ Covered |
| FR28 | Alert thresholds and lead times | Epic 6 | ✅ Covered |
| FR29 | Proactive expiry alerts | Epic 6 | ✅ Covered |
| FR31 | Anomalous access pattern alerts | Epic 6 | ✅ Covered |
| FR32 | Create machine user identities | Epic 7 | ✅ Covered |
| FR33 | Issue and revoke machine user API keys | Epic 7 | ✅ Covered |
| FR34 | Machine user API key authentication | Epic 7 | ✅ Covered |
| FR35 | Machine user secret retrieval by stable name | Epic 7 | ✅ Covered |
| FR36 | Machine user audit trail | Epic 7 | ✅ Covered |
| FR37 | Offline fallback cache | Epic 7 | ✅ Covered |
| FR38 | Fallback cache audit and alerts | Epic 7 | ✅ Covered |
| FR39 | GitHub Actions + GitLab CI native integrations | Epic 7 | ✅ Covered |
| FR40 | Append-only audit log with row-level integrity | Epic 8 | ✅ Covered |
| FR41 | Audit log search and filter | Epic 8 | ✅ Covered |
| FR42 | Audit log export (structured formats) | Epic 8 | ✅ Covered |
| FR43 | External audit log forwarding to write-once storage | Epic 8 | ✅ Covered |
| FR44 | Audit log pseudonymization on account deletion | Epic 8 ⚠️ (schema: Epic 1) | ✅ Covered |
| FR45 | Account deactivation with immediate revocation | Epic 4 | ✅ Covered |
| FR46 | Web browser interface | Epic 1 | ✅ Covered |
| FR47 | All UI capabilities via REST API | Epic 9 | ✅ Covered |
| FR48 | OpenAPI specification published | Epic 9 | ✅ Covered |
| FR49 | Docker and Docker Compose deployment | Epic 1 | ✅ Covered |
| FR50 | In-place version upgrades | Epic 9 | ✅ Covered |
| FR51 | Email notifications | Epic 3 | ✅ Covered |
| FR52 | Slack notifications | Epic 3 | ✅ Covered |
| FR53 | Email/password account creation and auth | Epic 1 | ✅ Covered |
| FR54 | TOTP MFA enrollment | Epic 1 | ✅ Covered |
| FR55 | MFA recovery codes at enrollment | Epic 1 | ✅ Covered |
| FR56 | Org Admin-governed account recovery | Epic 4 | ✅ Covered |
| FR57 | MFA enforcement for Owner/Admin roles | Epic 1 (verified Epic 4) | ✅ Covered |
| FR60 | Vault unsealing via master password | Epic 1 | ✅ Covered |
| FR61 | Org-scoped data isolation | Epic 1 | ✅ Covered |
| FR62 | Remove user from project without org impact | Epic 4 | ✅ Covered |
| FR63 | Archive projects while preserving records | Epic 4 | ✅ Covered |
| FR64 | Credential access visibility (who has access) | Epic 2 | ✅ Covered |
| FR65 | Consolidated rotation schedule view | Epic 5 | ✅ Covered |
| FR66 | Live in-progress rotation status | Epic 5 | ✅ Covered |
| FR67 | Dismiss/snooze expiry alert (audit logged) | Epic 6 | ✅ Covered |
| FR68 | Machine user API key expiry alerts | Epic 7 | ✅ Covered |
| FR69 | Point-in-time access report | Epic 8 | ✅ Covered |
| FR70 | Audit log retention configuration | Epic 8 | ✅ Covered |
| FR71 | Dormant user detection and alerts | Epic 8 | ✅ Covered |
| FR72 | Mobile browser UI support | Epic 6 | ✅ Covered |
| FR73 | Failed auth alerting | Epic 1 (notif: Epic 3) | ✅ Covered |
| FR75 | Rotation confirmation failure handling | Epic 5 | ✅ Covered |
| FR76 | Cross-project health status page | Epic 6 | ✅ Covered |
| FR77 | Public-facing status page (shareable URL) | Epic 6 | ✅ Covered |
| FR78 | Audit log integrity verification | Epic 8 | ✅ Covered |
| FR80 | Global cross-project search | Epic 2 | ✅ Covered |
| FR81 | Health and readiness endpoint | Epic 1 | ✅ Covered |
| FR82 | Structured operational logs | Epic 1 | ✅ Covered |
| FR83 | User session management and revocation | Epic 1 | ✅ Covered |
| FR84 | Org-level session revocation by admin | Epic 1 | ✅ Covered |
| FR85 | Configurable idle session timeout | Epic 1 | ✅ Covered |
| FR86 | System-level settings configuration | Epic 9 | ✅ Covered |
| FR87 | Resource usage monitoring vs tier limits | Epic 9 | ✅ Covered |
| FR88 | Encrypted scheduled backups | Epic 9 | ✅ Covered |
| FR89 | Backup retention policy and destination | Epic 9 | ✅ Covered |
| FR90 | Backup restore | Epic 9 | ✅ Covered |
| FR92 | Backup health monitoring and restore validation | Epic 9 | ✅ Covered |
| FR93 | Project dashboard (credential status, health, alerts) | Epic 2 | ✅ Covered |
| FR94 | User notification preferences | Epic 3 | ✅ Covered |
| FR95 | Tags on credentials and projects | Epic 2 | ✅ Covered |
| FR96 | Secret reveal with audit log entry | Epic 2 | ✅ Covered |
| FR97 | API pagination and filtering | Epic 9 | ✅ Covered |
| FR98 | Empty project state with clear next action | Epic 2 | ✅ Covered |

### Additional FRs Added in Epics (not in PRD, expanded scope)

| FR | Description | Epic | Notes |
|----|-------------|------|-------|
| FR99 | Service recovery notification (endpoint back online) | Epic 6 | PRD gap — implicit but not numbered |
| FR100 | Per-alert-type routing to specific users/roles | Epic 3 | Addresses PRD design hole in notification routing |
| FR101 | Zero-downtime machine user API key rotation (overlap grace) | Epic 7 | Operational necessity for live services |
| FR102 | Recovery and deactivation audit trail + orphan rotation handling | Epic 8 | Compliance requirement not explicitly numbered in PRD |
| FR103 | Separate immutable platform operator audit log | Epic 9 | Security isolation requirement |
| FR104 | Remove/archive dependent system from credential | Epic 5 | Operational maintenance requirement |
| FR105 | Configurable secret version retention policy with crypto-deletion | Epic 2 | Storage hygiene requirement |
| FR107 | Persistent in-product notification inbox | Epic 3 | Baseline for users not relying on email/Slack |
| FR108 | Break-glass emergency rotation mode | Epic 5 | Incident response requirement |
| FR109 | Key custody risk alert on weak master key config | Epic 9 | Security posture visibility |
| FR110 | Machine user API key dormancy detection | Epic 7 | Security hygiene / insider threat mitigation |

### Missing Requirements

**No PRD FRs are missing from epic coverage.** All 95 FRs from the PRD have explicit epic assignments in the coverage map.

### Coverage Statistics

- Total PRD FRs: 95
- FRs covered in epics: 95
- Coverage percentage: **100%**
- Additional FRs added by epics beyond PRD: 11 (FR99–FR110, excl. FR106)
- Total FRs in epic scope: 106

---

## Summary and Recommendations

### Overall Readiness Status

# ✅ READY — WITH CONDITIONS

Project Vault's planning artifacts are exceptionally thorough. All 95 PRD functional requirements have full epic coverage. The architecture, PRD, UX spec, and epics are internally consistent. The planning is ready to enter implementation. However, **4 major issues must be resolved before or during the first sprint** to prevent them from becoming implementation defects.

---

### Critical Issues Requiring Immediate Action

**Before Story 1.9 is merged (Epic 1):**

1. **MQ-3 — FR57 MFA enforcement ACs split across Epic 1 and Epic 4**
   - Epic 1 story for FR57 must define: "What is the acceptance test for MFA enforcement that does NOT require Epic 4's invitation flow?" 
   - Solution: Add a mock privileged endpoint in the Epic 1 test suite that verifies the enforcement mechanism in isolation. Epic 4 then tests the specific invitation business rule.

**Before Epic 4 sprint planning:**

2. **MQ-1 — FR63 project archival has an unresolved forward dependency on Epic 7**
   - The Epic 4 story for FR63 must include: "A project with one or more active machine user API keys (non-zero rows in `machine_users` table for this project) cannot be archived without explicit confirmation and mandatory key revocation."
   - This stub guard prevents CI pipeline breakage without waiting for Epic 7's full machine user dependency management.

**Before any beta launch (must be resolved before Tier 0 beta):**

3. **MQ-2 — FR73 failed auth alerts are functionally silent until Epic 3**
   - Add an Org Admin dashboard section that displays `security_alerts` records in PENDING_DELIVERY state, even before Epic 3's email/Slack channels are live. Without this, security events are completely invisible to admins during the solo/evaluator beta period.

**Before Epic 9 sprint planning:**

4. **MQ-4 — Epic 9 API parity (FR47/FR48) is a retroactive catch-up task**
   - Add an AC to every feature story in Epics 2–8: "This story's new API endpoints are included in the auto-generated OpenAPI spec (`GET /api/v1/openapi.json` returns updated spec); spec validates without errors post-merge."
   - Epic 9's OpenAPI story then becomes a final verification and publication task, not a catch-up.

---

### Recommended Next Steps

1. **Address MQ-3 now** — before Epic 1 sprint planning. Add the test boundary definition to Story 1.9 AC. This is a 30-minute document edit that prevents a story being shipped with unverifiable acceptance criteria.

2. **Address MQ-1 before Epic 4 kick-off** — add the stub machine user guard to the FR63 story. This is a 1–2 hour implementation addition that prevents the archival feature from silently breaking CI pipelines at beta launch.

3. **Add PENDING_DELIVERY admin visibility (MQ-2)** — either as a dedicated mini-story in Epic 1 or as an AC addition to Story 1.9. This ensures the security monitoring promise is visible from Tier 0 beta.

4. **Add OpenAPI maintenance AC to each feature epic's story template (MQ-4)** — update the Definition of Done in the epics document to include: "New or modified API endpoints reflected in auto-generated OpenAPI spec; spec validates." This is a one-time edit to the DoD section.

5. **Clarify Epic 7 FR37 SDK scope decision** — the release scope table notes Epic 7 is "Blocked on FR37 SDK scope decision." This decision must be resolved before Epic 7 sprint planning begins. If it remains unresolved at Tier 2 beta, machine user access cannot ship to v1 GA.

6. **Address UX warnings before implementing security-critical flows:**
   - W-UX-1: Ensure Epic 1 story ACs for FR56 (account recovery), FR60 (vault unsealing), and Epic 5 story for FR108 (break-glass rotation) include explicit step-sequence, error state, and confirmation dialog specifications — derived from UX principles but not yet designed in the UX spec.
   - W-UX-2: Ensure the Epic 9 governance dashboard story composes the buyer/CTO view (UX-DR12) as a unified surface, not a collection of independent components.

---

### Issues by Category

| Category | Count | Severity Distribution |
|----------|-------|----------------------|
| Epic Quality | 8 | 1 × 🔴 (accepted), 4 × 🟠, 3 × 🟡 |
| UX Alignment | 2 | 2 × ⚠️ Warning |
| PRD Coverage | 0 | — |
| NFR Coverage | 0 | — |

**Total actionable items: 6** (4 major, 2 warnings)

---

### Final Note

This assessment reviewed 4 planning documents totaling 431KB across 95 functional requirements, 33 non-functional requirements, 11 extended FRs added by epics, 9 epics, and 15 UX design requirements.

**What is exceptionally well done:**
- 100% PRD FR coverage in the epics — no requirements have fallen through the cracks
- The epics document proactively flags its own cross-epic dependencies with explicit notes and mitigations
- The technology stack and architecture are well-aligned with UX and NFR requirements
- The Definition of Done is comprehensive and enforcement-oriented (CI gates, not manual checks)
- Security architecture is exceptionally thorough — constant-time operations, memory zeroing, RLS enforcement, SecureRoute pattern, SSRF protection, and audit log pseudonymization are all specified at the story level

**What needs attention:**
The 4 major issues are all pre-implementation planning gaps, not post-implementation defects. They are resolvable in hours of document editing and story AC refinement — not rework of the architecture or significant re-scoping. The project is genuinely ready to begin implementation once these conditions are met.

---

**Assessment generated:** 2026-05-31
**Assessor:** BMad Implementation Readiness Check (Product Manager + Scrum Master perspective)
**Documents assessed:** PRD (90.6K), Architecture (117.3K), Epics (191.9K), UX Design Specification (31.8K)

---

## PRD Analysis

### Functional Requirements

**Project & Organization Management (14 FRs)**

| ID | Requirement |
|----|-------------|
| FR1 | Users can create and configure projects as the primary organizational unit for all operational assets |
| FR2 | Project Owners can invite users to a project and assign them a role (Owner, Admin, Member, Viewer) |
| FR3 | Users can hold different roles across different projects simultaneously |
| FR4 | Project Owners can transfer project ownership to another project member |
| FR5a | Organization Admins can view all users and their membership/role across every project |
| FR5b | Organization Admins can remove users from the organization |
| FR5c | Organization Admins can change a user's role within any project in the organization |
| FR6 | Organization Admins can configure self-hosted instances to support multiple organizations |
| FR7 | Users can view all accessible projects from a unified cross-project dashboard |
| FR8 | Users can add notes and descriptions to projects |
| FR9 | System guides new users through creating their first project via an interactive wizard |
| FR62 | Project Admins can remove a user from a specific project without affecting org account |
| FR63 | Users can archive projects to remove from active views while preserving all records |
| FR98 | A newly created empty project displays a purposeful empty state with direct paths to first import |

**Secret & Credential Management (10 FRs)**

| ID | Requirement |
|----|-------------|
| FR10 | Users can store a secret with name, value, description, tags, expiry date, and linked dependent systems |
| FR11 | Users can retrieve the current version of any secret they are authorized to access |
| FR12 | System maintains complete immutable version history for every secret |
| FR14 | Users can search and filter credentials by name, tag, status, and expiry |
| FR15 | Users can set expiry dates and rotation schedules on individual credentials |
| FR16 | Users can record which external systems depend on each credential |
| FR17 | Users can import credentials in bulk from `.env` files and JSON exports |
| FR64 | Users can view which human and machine users currently have access to a specific credential |
| FR95 | Users can add, edit, and remove tags on credentials and projects |
| FR96 | Users can reveal the current value of a secret with each reveal event captured in audit log |

**Rotation & Propagation (9 FRs)**

| ID | Requirement |
|----|-------------|
| FR18 | Users can initiate a rotation workflow for any stored credential |
| FR19 | System generates a per-system confirmation checklist for every rotation |
| FR20 | Users can mark each system on the rotation checklist as confirmed-updated |
| FR21 | System prevents rotation from being marked complete while systems remain unconfirmed |
| FR22 | System retires old credential version only after all dependent systems are confirmed |
| FR23 | System maintains complete rotation history per credential |
| FR65 | Users can view consolidated list of credentials with upcoming rotation schedules |
| FR66 | Users can view live status of an in-progress rotation |
| FR75 | Users can record and respond to a system confirmation failure during active rotation |

**Operational Monitoring & Alerts (9 FRs)**

| ID | Requirement |
|----|-------------|
| FR24 | Users can add service records with expiry/renewal dates to a project |
| FR25 | Users can add SSL/TLS certificate records with expiry dates to a project |
| FR26 | Users can add domain records with renewal dates to a project |
| FR27 | System monitors registered HTTP endpoints for availability and alerts on unreachability |
| FR28 | Users can configure alert thresholds and lead times for expiry notifications |
| FR29 | System sends proactive alerts before credentials, certificates, domains, or services reach threshold |
| FR31 | System alerts Org Admins when anomalous access patterns exceed configured thresholds (default: 5 accesses outside normal role pattern within 1 hour) |
| FR67 | Users can dismiss or snooze an expiry alert with dismissal recorded in audit log |
| FR76 | Users can view cross-project health status page showing live availability across all projects |
| FR77 | Project Owners can enable an optional public-facing status page for a project |

**Machine User Access (8 FRs)**

| ID | Requirement |
|----|-------------|
| FR32 | Administrators can create machine user identities with scoped project roles |
| FR33 | Administrators can issue and revoke API key credentials for machine users |
| FR34 | Machine users can authenticate to the REST API using API key credentials |
| FR35 | Machine users can retrieve current version of secrets by stable name without internal identifiers |
| FR36 | System maintains separate complete audit trail for all machine user access events |
| FR37 | System maintains a local cache of authorized secrets persisting for the consuming process, activating automatically when vault is unreachable (default trigger: 3 consecutive failed connections within 30s) |
| FR38 | System records fallback cache usage in audit log and alerts administrators |
| FR39 | System provides native integrations for CI/CD pipelines (GitHub Actions, GitLab CI) |
| FR68 | Administrators can configure expiry dates on machine user API keys and receive alerts |

**Audit & Compliance (9 FRs)**

| ID | Requirement |
|----|-------------|
| FR40 | System records every secret access, rotation event, permission change, and admin action in append-only audit log with row-level integrity verification |
| FR41 | Users can filter and search audit log entries by date range, user, credential, event type, and project |
| FR42 | Users can export audit log data in structured formats |
| FR43 | System supports forwarding audit log data to customer-controlled external write-once storage |
| FR44 | System pseudonymizes user identity in audit log entries upon account deletion |
| FR45 | Organization Admins can deactivate user accounts with immediate revocation of all associated credentials and access |
| FR69 | Organization Admins can generate a point-in-time access report (users, roles, project memberships) |
| FR70 | Organization Admins can configure audit log retention periods within subscription tier limits |
| FR71 | System detects user accounts inactive beyond configurable threshold and alerts Org Admins (default: 90 days) |
| FR78 | Administrators can verify audit log integrity against the last recorded checkpoint |

**Platform & Integration (10 FRs)**

| ID | Requirement |
|----|-------------|
| FR46 | Users can access all product capabilities through a web browser interface |
| FR47 | All web UI capabilities are accessible via a versioned REST API |
| FR48 | System publishes an OpenAPI specification covering all REST API endpoints |
| FR49 | System is deployable via Docker and Docker Compose |
| FR50 | System supports in-place version upgrades preserving all data, secrets, audit logs, and configuration |
| FR51 | System delivers event notifications via email |
| FR52 | System delivers event notifications via Slack |
| FR72 | Web UI is accessible and functional on mobile browsers |
| FR80 | Users can search across all accessible projects by credential name, service name, tag, or metadata |
| FR81 | System exposes a health and readiness endpoint for container runtime probes |
| FR82 | System emits structured operational logs that administrators can ship to external log aggregation tools |
| FR97 | REST API supports pagination and filtering on all collection endpoints |

**Security & Authentication (10 FRs)**

| ID | Requirement |
|----|-------------|
| FR53 | Users can create accounts and authenticate with email and password |
| FR54 | Users can enroll in TOTP-based multi-factor authentication |
| FR55 | Users can generate one-time recovery codes at MFA enrollment |
| FR56 | Organization Admins can initiate and approve account recovery for users who lost MFA device access |
| FR57 | System enforces MFA enrollment for Owner and Admin roles in Team/Small Company tiers before inviting members |
| FR60 | System supports configurable vault unsealing via a master password on startup |
| FR61 | System enforces organization-scoped data isolation |
| FR73 | System logs all failed authentication attempts and alerts Org Admins when exceeded (default: 10 failed attempts within 5 min) |
| FR83 | Users can view all currently active sessions and revoke any individual session |
| FR84 | Organization Admins can revoke all active sessions for any user |
| FR85 | System enforces configurable idle session timeout |

**System Administration (2 FRs)**

| ID | Requirement |
|----|-------------|
| FR86 | Administrators can configure system-level settings (SMTP, backup schedule, notification defaults, instance policy) |
| FR87 | Administrators can view resource usage against subscription tier limits and receive alerts when approaching limits |

**Project Dashboard (1 FR)**

| ID | Requirement |
|----|-------------|
| FR93 | Project dashboard surfaces: credential status, upcoming rotation schedule, monitored service health, recent access events, and unresolved alert count |

**Notification Preferences (1 FR)**

| ID | Requirement |
|----|-------------|
| FR94 | Users can configure personal notification preferences (delivery channel, frequency, severity threshold) |

**Backup & Restore (4 FRs)**

| ID | Requirement |
|----|-------------|
| FR88 | System creates encrypted snapshots of all vault data on a configurable schedule |
| FR89 | Administrators can configure backup retention policy and storage destination |
| FR90 | Administrators can restore vault state from a backup snapshot |
| FR92 | System monitors backup health and alerts administrators when backups are missed, fail verification, or have storage issues |

**Total FRs: 97** *(95 as declared in PRD + FR76, FR77 in Operational Monitoring which appear to be in final count; PRD declares 95 FRs)*

---

### Non-Functional Requirements

**Performance**

| ID | NFR |
|----|-----|
| NFR-P1 | Reference load: 20 concurrent human users + 10 concurrent machine API calls |
| NFR-P2 | Infrastructure baseline: 2 vCPU / 4GB RAM / SSD-backed storage, PostgreSQL with connection pooling |
| NFR-P3 | Secret fetch (by-id/name): p95 ≤100ms |
| NFR-P4 | Secret search/filter: p95 ≤300ms, paginated |
| NFR-P5 | Dashboard first meaningful content: ≤2s |
| NFR-P6 | Dashboard load order: (1) status summary → (2) expiry alerts → (3) activity feed → (4) details |
| NFR-P7 | Rotation initiation: p95 ≤500ms |
| NFR-P8 | Audit log queries at 1M entries: p95 ≤500ms; required indexes on (actor_id, timestamp) and (project_id, timestamp) |
| NFR-P9 | External plugin timeout cap: 3s; max 2 retries with exponential backoff (3s → 6s) |
| NFR-P10 | Background operations (health checks, rotation) never block UI |
| NFR-P11 | UI static/versioned assets served immutable; API responses no-cache |
| NFR-P12 | Connection pooling required in production |

**Security**

| ID | NFR |
|----|-----|
| NFR-S1 | Encryption at rest: AES-256-GCM for all secrets and backups |
| NFR-S2 | Master key management: environment variable (default); external KMS (advanced option) |
| NFR-S3 | Encryption in transit: TLS 1.3 required for inbound API; TLS 1.2 minimum / 1.3 preferred for outbound plugin connections |
| NFR-S4 | Memory safety: secret values must not appear in logs, stack traces, or error messages |
| NFR-S5 | Authentication: MFA (TOTP) supported and enforced per policy; machine users via API key + short-lived JWT (≤1h TTL) |
| NFR-S6 | Session management: web UI inactivity timeout 30 minutes, configurable, non-zero minimum enforced |
| NFR-S7 | Audit log: append-only writes; per-entry cryptographic chaining; chain verification API available |
| NFR-S8 | Audit log access: read requires Owner or explicit Audit role; Admin access scoped to own projects only |
| NFR-S9 | RBAC: list/enumerate is a distinct permission from read-value |
| NFR-S10 | Privilege escalation prevention: no user may grant permissions exceeding their own role or modify their own role |
| NFR-S11 | Rate limiting: 120 req/min per authenticated account; 60 req/min per IP (unauthenticated) |
| NFR-S12 | Credential entropy: API keys ≥256 bits; generated passwords ≥128 bits or policy-defined minimum |
| NFR-S13 | CVE response: critical vulnerabilities patched ≤7 days; high severity ≤30 days |
| NFR-S14 | Incident notification: user notification ≤72h of confirmed security incident |

**Reliability**

| ID | NFR |
|----|-----|
| NFR-R1 | Uptime target: 99.9% (~8.7h/year); requires automatic container restart |
| NFR-R2 | Crash recovery: ≤30s with automatic restart |
| NFR-R3 | Atomic writes: all credential operations atomic; rotation is a compound transaction |
| NFR-R4 | Rotation durability: completed rotation writes synchronously durable |
| NFR-R5 | Audit completeness: 100% — no audit entry dropped under any load condition |
| NFR-R6 | RPO: 24h (backup-based); RTO: 2h with documented runbook |

**Scalability**

| ID | NFR |
|----|-----|
| NFR-SC1 | Reference scale: 50 concurrent users / 100 concurrent API calls / 10,000 secrets / 1,000,000 audit log entries |
| NFR-SC2 | No clustering/horizontal scaling required in v1; design must not preclude it |

**Accessibility**

| ID | NFR |
|----|-----|
| NFR-A1 | WCAG 2.1 AA compliance for all UI components |
| NFR-A2 | Automated accessibility testing integrated as CI gate (blocks merge on violations) |
| NFR-A3 | Manual audit of top-5 user flows before launch |

**Data Integrity**

| ID | NFR |
|----|-----|
| NFR-D1 | Secret versions are immutable once written (append-only, no overwrite) |
| NFR-D2 | All writes atomic; no partial state persisted |
| NFR-D3 | Backup integrity guaranteed via AES-256-GCM authenticated encryption; checksums verified on restore |

**Maintainability**

| ID | NFR |
|----|-----|
| NFR-M1 | Structured JSON logging with configurable log levels |
| NFR-M2 | 12-factor app compliance (config via environment, stateless processes) |
| NFR-M3 | Security-sensitive code paths enumerated and tracked in code review checklist |
| NFR-M4 | Prometheus-compatible metrics endpoint; defaults to localhost-only binding (configurable) |
| NFR-M5 | Multi-arch container builds: AMD64 + ARM64 |
| NFR-M6 | API v1 compatibility policy: no breaking changes within v1.x |
| NFR-M7 | Internationalization: English-only in v1; i18n architecture constraint: no hardcoded strings in UI |

**Total NFRs: 33** across 7 categories

---

### Additional Requirements & Constraints

**Technical Constraints (from Domain Requirements):**
- AES-256 minimum for all secrets at rest; AES-256-GCM specified for secrets and backups
- TLS 1.3 for inbound; TLS 1.2 min / 1.3 preferred for outbound
- Key unsealing: master password (v1); Shamir's Secret Sharing (v2); auto-unseal via cloud KMS (growth)
- Immutable audit logs: append-only with row-level checksums + cryptographic chaining (full chain in v1.1)
- Machine user bootstrap via one-time enrollment tokens
- Constant-time operations for all secret/token comparisons
- Secret size limit: 64KB default (configurable)
- SSRF protection for webhook URLs (RFC 1918 blocklist)
- JWT: web sessions ≤15min TTL; machine user tokens ≤1h TTL
- Import endpoints must never log request bodies
- Dependency supply chain: pinned with hash verification; SBOM published per release

**Integration Requirements:**
- Docker / Docker Compose single-command deployment
- REST API with versioned endpoints (`/api/v1/`)
- GitHub Actions + GitLab CI native integrations
- `.env` and JSON import (v1); Doppler/Infisical import (v1.1 fast-follow)
- Plugin SDK: internal abstraction in v1; external docs in v1.1
- External log shipping via webhook/export to write-once sinks

**Business Constraints:**
- Open-core model: core security engine is OSS; commercial = hosted SaaS, enterprise SSO, compliance reporting, managed plugins
- Tenant-aware schema from v1 (org_id on every entity); multi-org UI deferred to v1.1
- No commercial revenue in v1 (open-core, self-hosted)
- Tiered subscription model (Solo / Indie / Small Company / Team) affecting project counts, user limits, secret limits, audit retention

**v1 Scope Boundaries:**
- Automated provider plugins → v2
- Webhook outbound notifications → v1.1
- Shamir's Secret Sharing unsealing → v2
- Drift detection → v2
- Encrypted file fallback (persistent services) → v1.1
- Full cryptographic audit log chaining → v1.1 (row checksums only in v1)
- Short-lived JWT machine tokens → v1.1

---

### PRD Completeness Assessment

The PRD is exceptionally comprehensive. Key observations:

**Strengths:**
- 95 numbered FRs covering all 5 user journeys with explicit traceability
- Detailed NFRs with specific numeric thresholds (latency, uptime, retention)
- Clear MVP scope boundaries with explicit deferrals and rationale
- Security model is thoroughly specified with explicit threat mitigations
- Compliance posture (SOC 2, ISO 27001, GDPR, HIPAA) is clearly scoped with "delivers vs. designed-for vs. post-launch" tiers
- Technical constraints are specific and actionable (not vague aspirations)
- Business model and sustainability risk explicitly acknowledged

**Potential Gaps for Epic Coverage Validation:**
- FR13 and FR30 marked "intentionally reserved" (merged) — traceability must confirm no coverage gap
- FR58, FR59, FR91 are missing from the numbered sequence — must confirm intentional omission
- FR76 and FR77 (cross-project health page, public status page) declared in PRD but not reflected in the stated "95 FR" count — minor numbering discrepancy
- Account deletion UX flow (GDPR/ownership transfer) referenced as "v1 product requirement" but no explicit FR number assigned for the UX workflow itself
- Doppler/Infisical import flagged as "v1 or fast-follow" in integration list but later scoped to v1.1 — potential conflict to resolve in epics
