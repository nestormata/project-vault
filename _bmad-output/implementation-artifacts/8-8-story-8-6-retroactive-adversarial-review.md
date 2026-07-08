# Story 8.8: Story 8.6 Retroactive Adversarial Review

Status: ready-for-dev

<!-- Story derived from epic-9-retro-2026-07-08.md Finding 3 / Action Item A9-5, which itself
     confirms that epic-8-retro-2026-07-07.md's Action Item A8-2 (assigned to Dana, QA) was never
     completed. This is a RETROACTIVE ADVERSARIAL REVIEW story: its deliverable is a written,
     severity-tagged findings document reviewing Story 8-6's ALREADY-SHIPPED, ALREADY-`done` code
     (not new feature work). Story 8-6 itself is not reopened or re-implemented by this story
     except to fix Critical/High findings this review surfaces (see AC-15). -->

## Story

As the project's QA/engineering process (standing in for Dana, QA, per A8-2's original assignment),
I want a real, methodologically-rigorous adversarial review of Story 8-6's shipped API-key
revocation, machine-user deactivation, and dormancy-alert-action code — not a restated promise to
do one — producing a written, severity-tagged findings artifact,
so that the project's own Team Agreement (every story touching destructive/irreversible state
changes gets a formal adversarial review, adopted Epic 4/5, referred to below as **TA-1**) is
actually honored for Story 8-6, closing the obligation A8-2 created and Finding 3 confirmed was
still open.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — this story's deliverable is a review document (`_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening-adversarial-review.md`), an internal QA artifact with no new user-facing surface. |
| **Evaluator-visible** | no — nothing new is shippable/demoable from this story alone. If AC-15 triggers a Critical/High fix, that fix lands inside Story 8-6's *existing* `both` surface (machine-user web UI + API) and is evaluator-visible only in the sense that a pre-existing bug is corrected, not that a new capability appears. |
| **Linked UI story** (if API-only) | N/A — `none` scope, not `api`. |
| **Honest placeholder AC** | N/A — no UI is deferred by this story. |
| **Persona journey** | N/A — this is an internal process/QA story with no new persona-facing flow. If AC-15 produces a UI fix (e.g. harmonizing a confirmation-dialog inconsistency), the *existing* Org Admin machine-user-management persona journey documented in `8-6-epic-7-completion-machine-user-web-ui-and-hardening.md`'s own Product Surface Contract continues to apply unchanged. |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 8-6 `done` | This story reviews 8-6's shipped code as it exists on `main` today. Do not start this review against an in-flight or hypothetical version of 8-6. |
| `epic-8-retro-2026-07-07.md` read | Source of A8-2 — the original commitment ("real retroactive review, not a waiver," owned by Dana/QA) this story exists to fulfill. Finding 3 (line 96) and Action Items (A8-2, line 118) are the exact citations. |
| `epic-9-retro-2026-07-08.md` read | Source of Finding 3 / A9-5 — confirms A8-2 was still unbuilt as of 2026-07-08 and formally schedules this story. Finding 3 (line 206-209) is the direct citation. |
| `deferred-work.md` reviewed | No open deferral row references this gap outside the two retro docs above — confirmed by grep; no additional cross-reference needed. |
| Familiarity with the project's adversarial-review format | Read at least one existing `*-adversarial-review.md` file before starting — `7-1-machine-user-identity-and-api-key-management-adversarial-review.md` is the most directly relevant sibling (same module, same author-team era) and is cited throughout this story as the format precedent. |

---

## Retro Traceability Matrix

| Finding | Source | AC |
|---|---|---|
| Story 8.6 shipped destructive-state changes without the adversarial review TA-1 requires | `epic-8-retro-2026-07-07.md` Finding 3 (line 96-98); `epic-9-retro-2026-07-08.md` Finding 3 (line 206-209) | AC-1, AC-2 |
| TA-1's confirmation-before-destructive-action requirement was never independently verified against the shipped UI/API, only self-reported in 8-6's own Dev Agent Record | `8-6-*.md` Completion Notes (AC-2/AC-3/AC-5); this story's own code reading (see AC-4 through AC-7) | AC-4, AC-5, AC-6, AC-7 |
| No adversarial review ever checked authz/RLS/tenant isolation on 8-6's new/reused destructive endpoints | Absence of any `8-6-*-adversarial-review.md` file | AC-8 |
| No adversarial review ever checked concurrency/race conditions on 8-6's destructive actions (only sequential idempotency tests exist for some) | `deactivation-routes.test.ts:131-133` (sequential-only idempotent test); `dormancy-admin-actions.test.ts` (no concurrency test at all) | AC-9, AC-10, AC-11, AC-12 |
| No adversarial review ever checked audit/logging coverage for 8-6's three destructive-action families | Absence of any `8-6-*-adversarial-review.md` file | AC-13 |
| A8-2 said "real retroactive review, not a waiver" — this story must not become a waiver either | `epic-8-retro-2026-07-07.md` line 98, 118 | AC-14 |
| Prior epics' adversarial reviews produced a written, severity-tagged artifact with concrete file/line citations — this review must match that bar, not a lower one just because it's retroactive | Every sibling `*-adversarial-review.md` file in this directory | AC-1, AC-16 |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| Scope & method | Review the 6 shipped destructive-action code paths (not all of 8-6) using the project's adversarial-review rigor, against **shipped code**, not story prose. |
| TA-1 confirmation-step audit | Independently verify (not just re-read 8-6's self-report) that every destructive action has a real confirmation step, for both UI entry points where more than one exists. |
| AuthZ/RLS/tenant isolation | Verify cross-org isolation holds for all 6 actions, including the case where RLS alone (no explicit `org_id` filter in the query) is the only defense. |
| Concurrency/races | Verify double-revoke, double-deactivate, double-rotate/emergency-revoke, and concurrent dormancy-alert-action races are handled correctly — with real concurrent tests, not just sequential idempotency tests. |
| Audit coverage | Verify every one of the 6 actions writes a correct, fail-closed audit entry with an accurate payload. |
| Gap vs. promise | Explicitly state whether this review closes A8-2/Finding 3 in full, or only partially — no silent scope-narrowing. |
| Findings triage | Every finding gets a severity tag; Critical/High get fixed now (TDD) or explicitly deferred to a new tracked backlog story — never silently accepted. |
| Output artifact | A real, filed `.md` findings document, in the same format as sibling adversarial reviews, is non-negotiable for this story reaching `done`. |

---

## Scope Definition — The 6 Reviewed Code Paths

This review's mandatory scope is **exactly** these 6 destructive/state-changing actions Story 8-6 shipped (do not expand to 8-6's read-only endpoints (AC-1/AC-7/AC-8/AC-12 list/detail views) or its non-destructive hardening ACs (AC-6/AC-7/AC-8/AC-9/AC-10 offline-cache, rate-limiting, branch-protection, Marketplace issue, cache-crypto docs) — those were never the subject of A8-2/Finding 3 and re-reviewing them here would be scope creep the reviewer must resist):

| # | Action | Route | Handler file:lines |
|---|---|---|---|
| 1 | Revoke an API key | `DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId` | `apps/api/src/modules/machine-users/routes.ts:502-577` |
| 2 | Rotate an API key | `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate` | `apps/api/src/modules/machine-users/routes.ts:579-647`, delegates to `apps/api/src/modules/machine-users/rotation.ts:69-89` |
| 3 | Emergency-revoke an API key | `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` | `apps/api/src/modules/machine-users/routes.ts:649-701`, delegates to `apps/api/src/modules/machine-users/rotation.ts:97-116` |
| 4 | Deactivate a machine user | `POST /api/v1/machine-users/:machineUserId/deactivate` | `apps/api/src/modules/machine-users/routes.ts:328-392` |
| 5 | Dismiss a dormancy alert | `POST /api/v1/security-alerts/:alertId/dismiss` | `apps/api/src/modules/org/security-alert-actions-routes.ts:22-79` |
| 6 | Extend a key's dormancy snooze | `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy` | `apps/api/src/modules/machine-users/routes.ts:703-760` |

Corresponding web UI entry points (also in scope — TA-1 is a UI+API concern, not API-only):

| Action | Web entry point(s) | File |
|---|---|---|
| Revoke | (a) Machine-user detail page, `ConfirmDeleteButton` → `onRevoke()` | `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte:75-84, ~344-348` |
| Revoke | (b) Notifications inbox, dormancy-alert section, `revokeDormantKey` form action + inline `window.confirm()` | `apps/web/src/routes/(app)/notifications/+page.svelte:107-129`; server action `apps/web/src/routes/(app)/notifications/+page.server.ts:152-162` |
| Rotate | Machine-user detail page, `ConfirmDeleteButton` → `onRotate()` | `+page.svelte:88-101, ~332-337` (same file as above) |
| Emergency-revoke | Machine-user detail page, `ConfirmDeleteButton` → `onEmergencyRevoke()` | `+page.svelte:102-115, ~338-343` |
| Deactivate | Machine-user detail page, `ConfirmDeleteButton` → `onDeactivate()` | `+page.svelte:116-127, ~204-209` |
| Dismiss dormancy alert | Notifications inbox, `DismissDormancyAlertForm.svelte` (typed reason, no modal) | `apps/web/src/lib/components/notifications/DismissDormancyAlertForm.svelte`; server action `+page.server.ts:123-134` |
| Extend dormancy | Notifications inbox, inline number input + submit (no confirmation of any kind) | `apps/web/src/routes/(app)/notifications/+page.svelte:83-105`; server action `+page.server.ts:136-150` |

---

### AC-1: Review Method — Shipped Code, Not Story Prose, Using Adversarial Rigor

**Given** every prior Epic 4-9 adversarial review in this repo (e.g. `7-1-machine-user-identity-and-api-key-management-adversarial-review.md`) reviewed a story's **prose/ACs before or during implementation**, and this review is fundamentally different because Story 8-6 already shipped and is `done`,

**When** conducting this review,

**Then** the reviewer must read and adversarially analyze the **actual shipped code** at the file:line citations in the Scope Definition table above (routes, handlers, `rotation.ts`, web `+page.svelte`/`+page.server.ts` files, and their existing test files) — not merely re-read 8-6's own AC text or Completion Notes and restate what they already claim.

**And** the reviewer must use the same rigor/format as the project's `bmad-review-adversarial-general` skill (or `bmad-code-review` skill's adversarial-hunter lens) — every finding needs a severity tag (`[CRITICAL]`/`[HIGH]`/`[MEDIUM]`/`[LOW]`) and a concrete file:line citation, matching every sibling `*-adversarial-review.md` file's format.

**Positive example:** A finding reads: `**[HIGH]** The \`revokeDormantKey\` SvelteKit action (\`apps/web/src/routes/(app)/notifications/+page.server.ts:152-162\`) never receives or checks the confirmation the client-side \`window.confirm()\` at \`+page.svelte:110-122\` shows — a scripted/replayed POST to \`?/revokeDormantKey\` bypasses confirmation entirely, unlike \`ConfirmDeleteButton\`'s pattern which is also purely client-side but at least gates the actual API call, not just a form re-post.` — this cites real files/lines and states a concrete, verifiable claim.

**Negative example (reject this kind of finding):** `**[HIGH]** The confirmation step might not be robust enough.` — no file citation, no concrete mechanism named, indistinguishable from a guess. Findings written this way must be rewritten with a citation or dropped.

---

### AC-2: Scope Discipline — Review Exactly the 6 Actions, Not All of 8-6

**Given** the Scope Definition table above lists exactly 6 destructive actions plus their UI entry points,

**When** the review is conducted,

**Then** it must cover all 6 actions and both UI entry points for revoke — no fewer.

**And** it must explicitly state, in the output artifact's own Scope section, that 8-6's other ACs (AC-1, AC-6 through AC-10 — machine-user list/create/detail, offline-cache concurrency, rate-limiting, branch protection, Marketplace issue, cache-crypto docs) are **out of scope for this review** because they are not the destructive/irreversible actions TA-1 and Finding 3 are about — citing this story's own Scope Definition section as the reason, so a future reader doesn't mistake this review as a full re-review of Story 8-6.

**Positive example:** The output artifact's header includes a line: `Scope: API-key revoke/rotate/emergency-revoke, machine-user deactivate, dormancy-alert dismiss/extend-dormancy only (per Story 8-8's Scope Definition). Story 8-6's AC-1, AC-6–AC-10 are explicitly out of scope for this review.`

**Negative example (scope creep to avoid):** The reviewer spends effort re-auditing the offline-cache concurrency test (AC-6 of 8-6, already covered by its own dedicated multi-process test) and reports findings on it — this is wasted effort outside A8-2's actual promise and dilutes focus on the real gap.

---

### AC-3: Output Artifact — File, Name, and Required Structure

**Given** every prior story-level adversarial review in this repo is a standalone `.md` file named `{reviewed-story-key}-adversarial-review.md` in `_bmad-output/implementation-artifacts/`,

**When** this story completes its review,

**Then** it must create `_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening-adversarial-review.md` (named after the story **being reviewed**, i.e. 8-6, matching the exact filename `epic-9-retro-2026-07-08.md` line 208 already predicts is missing — not named after this story, 8-8).

**And** the file must contain, at minimum: a header (Date, Reviewed files/scope, Reviewer, explicit note that this is a *retroactive* review per A8-2/Finding 3), a `## Findings` section with one bullet per finding (severity tag + file:line citation + concrete description, matching AC-1's format), and a closing section stating the overall verdict (does this review satisfy A8-2/Finding 3 in full — see AC-14).

**Positive example:** The file opens with:
```markdown
# Adversarial Review — Story 8.6: Machine User Web UI & Hardening (Retroactive)

- **Date:** <today's date>
- **Reviewed scope:** API-key revoke/rotate/emergency-revoke, machine-user deactivate,
  dormancy-alert dismiss/extend-dormancy (see Story 8-8's Scope Definition table)
- **Reviewer:** <agent/human running this story>
- **Context:** Retroactive review per epic-8-retro-2026-07-07.md A8-2 and
  epic-9-retro-2026-07-08.md Finding 3 — Story 8-6 shipped and was marked `done`
  (2026-07-07) without this review ever being performed.
```

**Negative example (fails this AC):** Findings are only reported in the story's own Dev Agent Record / chat output with no standalone `.md` file ever committed to `_bmad-output/implementation-artifacts/` — this repeats exactly the failure mode this story exists to fix (a review that was "confirmed" verbally/in a retro transcript but never produced a durable artifact).

---

### AC-4: TA-1 Audit — API-Key Revoke (Both UI Entry Points)

**Given** revoke is reachable from two independent UI surfaces (machine-user detail page via `ConfirmDeleteButton`, and the notifications inbox's dormancy-alert section via a raw `window.confirm()` inside a SvelteKit form action),

**When** reviewing this action,

**Then** the reviewer must independently verify (by reading the actual component code, not trusting 8-6's Completion Notes) that **both** entry points block the underlying `DELETE .../api-keys/:keyId` call unless the user affirmatively confirms, and must explicitly compare the two confirmation mechanisms (`ConfirmDeleteButton` component vs. inline `window.confirm()`) for consistency — flagging any material difference in strength or bypassability as a finding (see AC-1's positive example above, which is exactly this comparison).

**And** the reviewer must check whether the server-side action (`+page.server.ts:152-162`) enforces confirmation independently of the client, or relies entirely on client-side JS — and flag as a finding (severity at reviewer's judgment, but not silently omitted) if it relies entirely on the client.

**Positive example (what "passes"):** If the reviewer determines both paths are equally robust and the client-only nature of both confirmations is an accepted, project-wide pattern (true of `ConfirmDeleteButton` elsewhere in this app, e.g. project archival), the finding can be `[LOW]` or even omitted with an explicit note: "Both entry points are client-confirmation-only, consistent with this app's existing accepted pattern (e.g. project archival) — not a new gap introduced by 8-6."

**Negative example (what must be flagged, not waived):** If the reviewer finds that the notifications-inbox path's `revokeDormantKey` server action has **no** server-side re-validation of any kind (not even a required form field beyond the IDs) while the machine-user-detail path's underlying API call is identical — this asymmetry itself is not automatically a finding (both ultimately hit the same API endpoint with the same server-side authz), but the reviewer must still explicitly document this equivalence-in-fact rather than silently assuming it without checking.

---

### AC-5: TA-1 Audit — Rotate and Emergency-Revoke

**Given** rotate and emergency-revoke are each reachable only from the machine-user detail page via `ConfirmDeleteButton` (`+page.svelte:332-343`), with distinct `confirmLabel`s ("Confirm rotate?" / "Confirm emergency revoke?"),

**When** reviewing these two actions,

**Then** the reviewer must verify both confirmation labels clearly communicate the action's actual irreversibility/consequence (e.g. that emergency-revoke immediately invalidates the old key with **no** overlap window, unlike rotate) — and flag as a finding if either label is generic/misleading relative to the two actions' materially different blast radius.

**And** the reviewer must verify the newly-issued plaintext key (returned by both actions) is displayed via the same reveal-once UI pattern AC-2 of 8-6 established (`revealedKey` state, `+page.svelte:91-92, 105-106`) with no code path that could re-display or re-fetch it later.

**Positive example:** Both `confirmLabel`s are distinct strings ("Confirm rotate?" vs "Confirm emergency revoke?") — reviewer confirms this is intentional differentiation, not a copy-paste artifact, by checking the labels are not byte-identical (they are not, per `+page.svelte:334, 340`).

**Negative example (a real finding to look for):** If the "Confirm rotate?" label doesn't mention the overlap window at all, an admin could reasonably believe rotate is as immediately destructive as emergency-revoke (or vice versa), leading to either over-caution or under-caution on the wrong action — flag as `[LOW]`/`[MEDIUM]` UX-clarity finding if the labels are this generic (verify against actual shipped copy, not assumed).

---

### AC-6: TA-1 Audit — Machine-User Deactivation

**Given** deactivation is reachable only from the machine-user detail page via `ConfirmDeleteButton` (`+page.svelte:204-209`, `confirmLabel="Confirm deactivate?"`), and the API endpoint (`routes.ts:328-392`) is idempotent (claim-via-conditional-`UPDATE`, second call returns `200` with the original timestamp, no second audit write),

**When** reviewing this action,

**Then** the reviewer must verify the UI confirmation step exists and gates the real `deactivateMachineUser()` API call (not just a local state flip), and must verify the "Deactivated" badge (`+page.svelte:150-153`) renders correctly and is not spoofable by a stale client read (i.e., the badge derives from `data.machineUser.deactivatedAt`, refetched via the page's own `load` function, not held in component-local state that could go stale after the action completes).

**And** the reviewer must verify deactivation's irreversibility is accurately communicated — there is no "reactivate" endpoint anywhere in the API (confirm by searching `routes.ts` and `schema.ts` for any un-set of `deactivatedAt`) — and that the confirmation copy doesn't imply reversibility it doesn't have.

**Positive example:** Reviewer confirms via grep that no `reactivate`/`undeactivate` route exists anywhere in `apps/api/src/modules/machine-users/`, and that "Confirm deactivate?" doesn't say anything like "you can undo this later" — consistent, no finding needed here.

**Negative example (a real finding to look for):** If `isDeactivated` (`+page.svelte:19`) is derived from `data.machineUser?.deactivatedAt` but the surrounding action handler (`onDeactivate()`, `+page.svelte:116-127`) doesn't trigger a data reload/invalidation after a successful call, the badge could fail to update until a manual page refresh — an admin might believe the deactivate action silently failed and re-click it. Verify whether SvelteKit's `invalidateAll()`/`goto()` or an equivalent reload is called after `onDeactivate()` succeeds; if not, flag as `[MEDIUM]`.

---

### AC-7: TA-1 Audit — Dormancy-Alert Actions (Dismiss and Extend)

**Given** dismiss (`DismissDormancyAlertForm.svelte`, requires a typed "reason" but has **no** modal/`confirm()` step) and extend-dormancy (`+page.svelte:83-105`, a bare number input + submit button with **no** confirmation of any kind) are the two dormancy-alert actions with weaker UI friction than revoke/rotate/emergency-revoke/deactivate,

**When** reviewing these two actions,

**Then** the reviewer must explicitly determine, for **each** of dismiss and extend-dormancy separately, whether it meets TA-1's "destructive/irreversible state change" bar — and record that determination with reasoning in the output artifact, rather than silently assuming "weaker UI friction = not in scope" or "these are less severe so they don't need analysis."

**And** for dismiss specifically: the reviewer must note that there is no "undismiss" endpoint (verify via `security-alert-actions-routes.ts` and the alerts schema) — meaning dismiss **is** irreversible on the alert record even though it doesn't touch a credential — and must state explicitly whether this irreversibility, combined with only a typed-reason requirement (no "are you sure?" step), is an acceptable gap or a finding.

**Positive example of a correct determination:** `[MEDIUM] Dismiss (security-alert-actions-routes.ts:22-79) is an irreversible state change (no undismiss endpoint exists) gated only by a required free-text "reason" field (DismissDormancyAlertForm.svelte:15-21), not an explicit confirm-dialog — weaker than every other action in this story's scope. Given the low blast radius (dismissing a dormancy alert doesn't affect the underlying key's security posture, unlike revoke/deactivate), this is accepted as intentionally lighter-weight, but is recorded here rather than silently assumed.`

**Negative example (fails this AC):** The output artifact's Findings section has zero mention of dismiss or extend-dormancy at all — this is exactly the "silently skip the less-destructive-looking ones" failure this AC exists to prevent, even if the eventual conclusion is "no finding needed."

---

### AC-8: AuthZ / RLS / Tenant Isolation

**Given** all 6 actions rely on Postgres RLS (`machine_users_isolation`/`api_keys_isolation` policies, `packages/db/src/migrations/0029_machine_users_and_api_keys.sql:59-65`, both `USING (org_id = current_setting('app.current_org_id', true)::uuid)` with no explicit `WITH CHECK`) as their **only** tenant-isolation mechanism — none of the 6 route handlers add an explicit `org_id` filter in their own `WHERE` clauses (confirmed: `routes.ts:502-577, 579-647, 649-701, 328-392, 703-760` and `security-alert-actions-routes.ts:22-79` all filter only by `machineUserId`/`keyId`/`alertId`, never by `org_id` directly),

**When** reviewing authz/tenant isolation,

**Then** the reviewer must verify (by reading `secure-route.ts`'s RLS-context-setting path, e.g. around `SecureRouteContext`/`secureRoute()` at `apps/api/src/lib/secure-route.ts:42, 537`) that every one of the 6 routes genuinely executes inside an RLS-scoped transaction with `app.current_org_id` set before the query runs — not just assume it because sibling routes do.

**And** the reviewer must verify role-gating is correct and consistent: the 4 machine-users-module actions require `minimumRole: 'admin'` + `requireMfa: true` (`routes.ts`), while the 2 security-alert actions require `allowedRoles: ['owner', 'admin']` + `requireMfa: true` (`security-alert-actions-routes.ts:37-39`) — flag if this `minimumRole` vs `allowedRoles` inconsistency (different authorization primitives for functionally-equivalent "admin-only destructive action" gates) creates any actual behavioral gap (e.g. does `minimumRole: 'admin'` implicitly include `owner`? verify against the shared authz helper, don't assume).

**Positive example:** Reviewer traces `secure-route.ts` and confirms every one of the 6 routes is registered via `secureRoute()` (not a bespoke unguarded handler), and that `minimumRole: 'admin'` is verified elsewhere in this codebase's authz tests to include `owner` (role hierarchy) — no finding, cite the verifying test file.

**Negative example (a real finding to look for):** If any of the 6 routes' `WHERE` clause could theoretically match a row from a different org **if** the RLS session variable were ever unset or misconfigured (e.g. a future refactor moves a query outside `secureCtx.tx` into a plain pool connection) — this is exactly the "RLS-only, no defense-in-depth" pattern flagged as a `[LOW]`/`[MEDIUM]` finding in 7.1's own adversarial review for a different table; if the reviewer confirms the same pattern holds unchanged for `machine_users`/`api_keys`, note it explicitly as a carried-forward, not-yet-fixed observation (do not re-litigate whether to fix it now — that's Epic 7's accepted debt — but do confirm it still applies to these 6 specific routes and hasn't regressed further).

---

### AC-9: Concurrency — Double-Revoke Race

**Given** the revoke handler (`routes.ts:502-577`) uses a conditional `UPDATE ... WHERE revoked_at IS NULL` (no explicit row lock) with the stated design intent that "Postgres blocks the second UPDATE behind the first's row lock... the loser's WHERE simply matches 0 rows" (comment at `routes.ts:531-536`),

**When** reviewing concurrency,

**Then** the reviewer must verify this claim is actually covered by a **real concurrent test** (two simultaneous requests via `Promise.all` or equivalent against a running instance/transaction, not two sequential calls) — check `routes.test.ts` for whether such a test exists; if only a sequential "call revoke twice, expect 200 then still-200" test exists, this is a coverage gap to flag, even though the code's own claimed mechanism is sound.

**And** the reviewer must verify only **one** audit entry (`machine_user.api_key_revoked`) is ever written even if two concurrent revoke requests race — tracing the `if (claimed) { ...audit... } else { ...re-read, no audit... }` branch (`routes.ts:551-573`) to confirm the loser's branch genuinely never calls `writeHumanAuditEntryOrFailClosed`.

**Positive example:** Reviewer finds (or writes, if this story's Findings Triage step requires it per AC-15) a test that fires two concurrent `DELETE` requests for the same `keyId` and asserts: both return `200`, exactly one audit row exists, `revokedAt` is identical in both responses. Cites the test file:line once it exists.

**Negative example (a real finding to look for):** If no such concurrent test exists anywhere in `apps/api/src/modules/machine-users/*.test.ts` (grep for `Promise.all` in `routes.test.ts` first — confirmed present in that file already for *some* scenario, but verify it specifically covers **this** revoke endpoint, not just rotation), this is a `[MEDIUM]` finding: the code's own concurrency-safety comment is unverified by any executable test.

---

### AC-10: Concurrency — Double-Deactivate Race

**Given** `deactivation-routes.test.ts:131-133` has a test titled "is idempotent: a second deactivate call still returns 200... and does not double-audit" that is confirmed (via this story's own pre-review code reading) to call deactivate **sequentially twice**, not concurrently,

**When** reviewing this action's concurrency safety,

**Then** the reviewer must explicitly flag the absence of a true concurrent (`Promise.all`-style) double-deactivate test as a finding — this is a **known, pre-identified gap**, not something the reviewer needs to discover from scratch, but the reviewer must still verify it's real (confirm no other test file covers it) and assess whether the underlying code (`routes.ts:360-365`'s conditional `UPDATE ... WHERE deactivated_at IS NULL`) would actually handle a true race correctly by the same reasoning as AC-9's revoke analysis.

**And** if the reviewer's code analysis concludes the underlying mechanism is sound (same conditional-UPDATE pattern as revoke), the finding's severity should reflect "missing test coverage for an otherwise-sound mechanism" (likely `[MEDIUM]`) rather than "broken behavior" (`[HIGH]`/`[CRITICAL]`) — severity must match actual risk, not just presence of a gap.

**Positive example:** Finding reads: `[MEDIUM] deactivation-routes.test.ts:131-133's idempotency test is sequential-only (two awaited calls, not Promise.all). The underlying conditional-UPDATE pattern (routes.ts:360-365) mirrors revoke's (routes.ts:538-548) and rotation's row-locked pattern is not used here, but the WHERE-clause-narrows-to-zero-rows mechanism should still be race-safe by the same reasoning applied in this review's revoke analysis (AC-9). No concurrent test exists to prove it. Recommend adding one (see AC-15).`

**Negative example (fails this AC):** The review simply repeats "deactivation has an idempotent test" from 8-6's own Completion Notes without independently checking whether that test is sequential or concurrent — this is exactly the "trusting the self-report instead of reading the code" failure AC-1 exists to prevent.

---

### AC-11: Concurrency — Rotate / Emergency-Revoke Race (Row-Locked Path)

**Given** rotate and emergency-revoke both call `lockApiKeyForUpdate()` (`rotation.ts:18-29`), which uses `SELECT ... FOR UPDATE` specifically because Story 7.2 AC-26 identified a TOCTOU window between concurrent rotate/emergency-revoke calls on the same key,

**When** reviewing this pair,

**Then** the reviewer must verify (a) whether an existing concurrent test actually exercises "two simultaneous rotate calls on the same key" and "one rotate + one emergency-revoke racing on the same key" (a cross-action race, not just same-action) — grep `rotation-routes.test.ts` for `Promise.all` (confirmed present) and read what scenario it covers, not just that the string appears.

**And** the reviewer must verify the row-lock is acquired **before** the `oldKey.revokedAt !== null` / `oldKey.overlapExpiresAt !== null` checks (`routes.ts:612-614, 678-679`) — if the lock were acquired after those checks, the TOCTOU window Story 7.2 closed would reopen. Confirm via `lockAndRejectIfRevoked()` (`routes.ts:74-89`) that locking happens first.

**Positive example:** Reviewer confirms `lockAndRejectIfRevoked()` calls `lockApiKeyForUpdate()` (which does the `FOR UPDATE` select) before returning the row for the caller's own-state checks — order is correct, cite the exact lines, no finding.

**Negative example (a real finding to look for):** If `rotation-routes.test.ts`'s existing `Promise.all` test only covers two concurrent **rotate** calls but never a **rotate racing against an emergency-revoke** on the same key (a cross-action combination that shares the same lock but different downstream logic), flag this specific combination's absence as a `[MEDIUM]` test-coverage finding — do not assume "some concurrency test exists" is equivalent to "the specific cross-action race is covered."

---

### AC-12: Concurrency — Dormancy-Alert Actions (Dismiss, Extend, Revoke-via-Dormancy-Alert)

**Given** `dormancy-admin-actions.test.ts` (confirmed via this story's own pre-review search) contains **no** concurrency test of any kind, and dismiss/extend/revoke-via-dormancy-alert can each independently race against themselves or each other (e.g. one admin dismisses an alert while another simultaneously tries to revoke the key it's about) — the dormancy-alert action's revoke path additionally races against the machine-user-detail-page revoke path (both hit the identical `DELETE .../api-keys/:keyId` endpoint, already covered by AC-9),

**When** reviewing this group,

**Then** the reviewer must check: (a) can the same alert be dismissed twice concurrently, and if so does it double-write an audit entry (trace `dismissSecurityAlertByToken()`'s `already_dismissed` branch, `security-alert-actions-routes.ts:61-64`, for whether it's reachable only after a genuine state check or via a race); (b) can `extend-dormancy` be called concurrently with a `revoke` on the same key, and if so what is the correct/expected outcome (extend a key that's mid-revoke — is this a meaningful business state, or a genuine bug risk)?

**Positive example:** Reviewer confirms `dismissSecurityAlertByToken()` uses a conditional-UPDATE-style claim check (verify the actual implementation in `security-alerts.ts`, don't assume) that mirrors the same-transaction-race-safe pattern used elsewhere, and states so with a citation.

**Negative example (a real finding to look for):** If `extend-dormancy`'s handler (`routes.ts:703-760`) performs an unconditional `UPDATE apiKeys SET dormancySnoozedUntil = ...` with no check on `revokedAt`, a key that was just revoked by a concurrent request could have its dormancy snooze extended after revocation — a meaningless-but-not-obviously-broken state that should at minimum be flagged as `[LOW]`/`[MEDIUM]` (does it cause any real harm, e.g. does a revoked-but-snoozed key ever get treated as "still active" anywhere downstream? — trace before assigning severity).

---

### AC-13: Audit/Logging Coverage — All 6 Actions

**Given** 4 of the 6 actions call `writeHumanAuditEntryOrFailClosed()` (`audit-or-fail-closed.ts:48-70`, fail-closed via `SameTransactionAuditWriteError` → transaction rollback → `503`) with `AuditEvent.*` constants from `packages/shared/src/constants/audit-events.ts`, while the dismiss handler (`security-alert-actions-routes.ts:70`) uses the **literal string** `'security_alert.dismissed'` instead of the existing `AuditEvent.SECURITY_ALERT_DISMISSED` constant (`audit-events.ts:67`),

**When** reviewing audit coverage,

**Then** the reviewer must confirm, for each of the 6 actions, that: an audit entry is written on success, the write is fail-closed (a DB error during the audit write rolls back the whole mutation, not just logs and continues), the payload doesn't leak secrets (no plaintext key ever appears in any of the 6 actions' audit payloads — verify each payload literal, e.g. `routes.ts:376, 559, 629-633, 693`, `security-alert-actions-routes.ts:72`, `routes.ts:748-751`), and the event-type string matches the corresponding `AuditEvent.*` constant.

**And** the reviewer must flag the `security_alert.dismissed` literal-string-vs-constant inconsistency found above as a finding — it's a real, concrete, low-risk-but-real drift from this codebase's own established convention (every other event type in this scope uses the constant).

**Positive example:** `[LOW] security-alert-actions-routes.ts:70 writes eventType: 'security_alert.dismissed' as a literal string instead of AuditEvent.SECURITY_ALERT_DISMISSED (audit-events.ts:67), which already exists and matches the same value. No functional bug today, but risks silent drift if the constant's value is ever intentionally changed without a corresponding grep-and-replace of this literal.`

**Negative example (fails this AC):** Reviewer confirms "audit events exist for revoke/rotate/emergency-revoke/deactivate" (true) and stops there, never checking the 2 security-alert-actions endpoints (dismiss, and — note — extend-dormancy is in `machine-users/routes.ts`, not `security-alert-actions-routes.ts`, so don't conflate the two files) or never comparing literal strings against constants — this AC requires checking **all 6**, not just the 4 in the machine-users module.

---

### AC-14: Explicit Statement — Does This Review Close A8-2/Finding 3?

**Given** A8-2 was explicitly described as "real retroactive review, not a waiver" (`epic-8-retro-2026-07-07.md` line 98), and this story exists specifically because a prior promise to do this work was not honored,

**When** the review is complete,

**Then** the output artifact must contain an explicit closing statement answering: "Does this review fully discharge A8-2 (epic-8-retro-2026-07-07.md) and Finding 3 (epic-9-retro-2026-07-08.md)?" — either "Yes, in full" or "Partially — the following is still open: [specifics]" — never left ambiguous or unaddressed.

**And** if any Critical/High finding from AC-4 through AC-13 is deferred rather than fixed in this story (see AC-15), the closing statement must name the specific new backlog story key tracking it, so the obligation chain (A8-2 → Finding 3 → this review → any new deferred story) stays traceable and doesn't repeat the exact "confirmed but never actually tracked" failure this story exists to fix.

**Positive example:** `## Verdict: A8-2 / Finding 3 status\n\nThis review fully discharges A8-2 and Finding 3's TA-1 confirmation, authz/RLS, concurrency, and audit-coverage requirements for all 6 in-scope actions. 2 Medium and 1 Low finding were fixed directly in this story (see File List). 1 Medium finding (cross-action rotate/emergency-revoke concurrent test gap, AC-11) is deferred — tracked as new backlog story \`8-9-machine-user-concurrency-test-hardening\` — because it requires new test infrastructure beyond this story's scope, not because it's being waived.`

**Negative example (fails this AC):** The artifact ends after the Findings list with no verdict section at all, leaving a reader to infer for themselves whether the obligation is now closed — this is the ambiguity this AC exists to eliminate.

---

### AC-15: Findings Triage — Fix Now (TDD) vs. Track as New Backlog Story

**Given** this repository's `AGENTS.md` mandates TDD red-green for any story behavior change, and this project's established pattern (per every sibling adversarial review) is that Critical/High findings get fixed before a story can be considered complete, while Medium/Low findings may be accepted or deferred with a named tracking item,

**When** the review produces findings,

**Then** every `[CRITICAL]` or `[HIGH]` finding must be either: (a) fixed in this story, following TDD red-green (write/update a failing test that proves the gap first, confirm it fails for the expected reason, implement the minimal fix, confirm the test passes, re-run the full affected test suite), with the fix and its test cited in this story's own File List; or (b) explicitly justified as non-blocking with a named reason (e.g., "requires a schema change out of scope for a review story") **and** filed as a new backlog entry in `sprint-status.yaml` — never silently left as prose in the review artifact with no tracking key.

**And** every `[MEDIUM]`/`[LOW]` finding must be recorded in the artifact; the developer may fix opportunistically (also via TDD if it changes behavior) or leave it, but must state which choice was made and why, avoiding the "flagged 4 times, tracked never" pattern multiple retro documents in this repo (epic-5 through epic-9) explicitly warn against repeating.

**Positive example (Critical/High, fixed):** Suppose AC-9's review finds a genuine double-audit bug on concurrent revoke (not just a missing test — an actual defect). The developer writes `apps/api/src/modules/machine-users/routes.test.ts`'s new concurrent-revoke test first, runs it, confirms it fails with two audit rows instead of one, then fixes the race in `routes.ts`, re-runs, confirms one audit row, then runs the full `machine-users` module suite green. File List cites both the new test and the fix.

**Negative example (fails this AC):** A `[HIGH]` finding is written up in the artifact with a suggested fix described in prose, but no code change is made and no new `sprint-status.yaml` entry exists anywhere — the finding is now "documented" but functionally identical to the original A8-2 failure mode (a promise with no tracked artifact).

---

### AC-16: Definition of Done — Artifact Exists, Not Just "A Process Was Designed"

**Given** the risk that this story could be completed by writing a *methodology* for how one *would* review 8-6, without ever actually performing the review,

**When** this story is marked `done`,

**Then** the following must all be independently true and verifiable by inspecting the repo (not by trusting this story's own Completion Notes, per the same principle AC-1 applies to 8-6's Completion Notes): `_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening-adversarial-review.md` exists, is non-empty, and contains at least one finding per AC-4 through AC-13's review area (even if some areas conclude "no finding" — that conclusion must be stated, not omitted, per AC-7's positive/negative example pattern); every `[CRITICAL]`/`[HIGH]` finding is either fixed (with a corresponding test in the diff) or has a real `sprint-status.yaml` backlog key; the AC-14 verdict section exists and is unambiguous; `sprint-status.yaml`'s `8-8-story-8-6-retroactive-adversarial-review` entry is updated to `done` with a comment citing the resulting artifact file and verdict.

**Positive example:** A reviewer (human or agent) with no prior context can open the artifact file alone and answer "was Story 8-6's destructive-action code actually reviewed, and is TA-1 now satisfied for it?" without needing to read this story file or any retro document.

**Negative example (fails this AC, story must NOT be marked `done`):** The story's Dev Agent Record says "reviewed 8-6 per the story's ACs, no significant findings" but no `.md` artifact file exists in `_bmad-output/implementation-artifacts/` — this is the exact non-outcome A8-2 already produced once; this story existing at all is the direct consequence of that failure mode, so repeating it here would be a second, compounded instance of the same process failure inside the very story meant to fix it.

---

## Tasks / Subtasks

- [ ] **Task 1: Read all required context** (Prerequisites) — 8-6's story file, both retro docs, one sibling adversarial-review file for format precedent.
- [ ] **Task 2: Review revoke (both UI entry points) against TA-1** (AC-4)
- [ ] **Task 3: Review rotate and emergency-revoke against TA-1** (AC-5)
- [ ] **Task 4: Review machine-user deactivation against TA-1** (AC-6)
- [ ] **Task 5: Review dormancy-alert dismiss and extend-dormancy against TA-1** (AC-7)
- [ ] **Task 6: Review authz/RLS/tenant isolation across all 6 actions** (AC-8)
- [ ] **Task 7: Review concurrency — double-revoke** (AC-9)
- [ ] **Task 8: Review concurrency — double-deactivate** (AC-10)
- [ ] **Task 9: Review concurrency — rotate/emergency-revoke cross-action race** (AC-11)
- [ ] **Task 10: Review concurrency — dormancy-alert actions** (AC-12)
- [ ] **Task 11: Review audit/logging coverage across all 6 actions** (AC-13)
- [ ] **Task 12: Write the findings artifact** (`8-6-epic-7-completion-machine-user-web-ui-and-hardening-adversarial-review.md`) with severity tags, citations, and the AC-14 verdict section (AC-1, AC-2, AC-3, AC-14)
- [ ] **Task 13: Triage findings — fix Critical/High via TDD, or file new backlog entries** (AC-15)
- [ ] **Task 14: Update `sprint-status.yaml`** — mark `8-8-story-8-6-retroactive-adversarial-review` `done` with a comment citing the artifact and verdict; add any new backlog stories from Task 13 (AC-16)
- [ ] **Task 15: Full regression** — if Task 13 touched any code, run the affected module's full test suite plus `make ci` before considering this story complete.

---

## Dev Notes

### Project Structure Notes

- This story writes **one new file**: `_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening-adversarial-review.md`. It does not create a story file for itself beyond this one (already created).
- If Task 13 requires code fixes, they land in the **existing** files listed in the Scope Definition table (`apps/api/src/modules/machine-users/routes.ts`, `rotation.ts`, `apps/api/src/modules/org/security-alert-actions-routes.ts`, and/or the corresponding `apps/web` files/tests) — do not create parallel/duplicate modules.
- Do not touch any file outside the Scope Definition table's 6 actions (e.g. do not modify AC-1/AC-6–AC-10 code from 8-6) — this mirrors 8-6's own "no other Epic 7/8/9 story's scope is touched" discipline.

### Key Patterns to Follow

- **Adversarial-review format:** match `7-1-machine-user-identity-and-api-key-management-adversarial-review.md`'s structure exactly (header fields, `## Findings` with severity-tagged bullets, file:line citations inline).
- **TDD for any fix (AC-15):** failing test first, confirm it fails for the expected reason, minimal fix, green re-run — per `AGENTS.md`'s standing rule for this repo.
- **Conditional-UPDATE-as-race-guard:** the pattern already used by revoke/deactivate (`WHERE x IS NULL`, check `RETURNING` for whether *this* call claimed the row) is this codebase's established idiom for race-safe idempotent mutations — reuse it exactly if a concurrency fix is needed; do not introduce a new locking primitive without strong justification.
- **Row-lock-for-cross-action races:** `lockApiKeyForUpdate()`'s `SELECT ... FOR UPDATE` (`rotation.ts:18-29`) is the established idiom when two *different* mutation types can race on the same row (rotate vs. emergency-revoke) — the conditional-UPDATE idiom above is sufficient only for same-action races.

### Anti-Patterns (Do Not)

- Do NOT write a review that only re-summarizes 8-6's own Completion Notes — every finding must trace to this story's own reading of the shipped code (AC-1).
- Do NOT expand scope to 8-6's non-destructive ACs (AC-2).
- Do NOT leave the artifact undelivered in favor of only reporting findings in chat/Dev Agent Record (AC-3, AC-16).
- Do NOT silently omit dismiss/extend-dormancy from the review because they look "less destructive" than revoke/deactivate (AC-7).
- Do NOT mark any Critical/High finding "accepted" without either a fix or a real `sprint-status.yaml` backlog key (AC-15).
- Do NOT mark this story `done` without the artifact file existing on disk (AC-16).

### References

- `_bmad-output/implementation-artifacts/8-6-epic-7-completion-machine-user-web-ui-and-hardening.md` — the story being reviewed; source of the 6 actions' original AC text (AC-2 through AC-5) and Completion Notes (do not trust the Completion Notes without independent verification, per AC-1).
- `_bmad-output/implementation-artifacts/epic-8-retro-2026-07-07.md` — Finding 3 (line 96-98), A8-2 (line 98, 118, 158) — the original commitment this story fulfills.
- `_bmad-output/implementation-artifacts/epic-9-retro-2026-07-08.md` — Finding 3 (line 206-209), A9-5 (line 253) — confirms A8-2 was still open and schedules this story.
- `_bmad-output/implementation-artifacts/7-1-machine-user-identity-and-api-key-management-adversarial-review.md` — format precedent for the output artifact.
- `_bmad-output/implementation-artifacts/product-surface-contract.md` — Product Surface Contract rules cited above.
- `apps/api/src/modules/machine-users/routes.ts`, `rotation.ts` — 4 of the 6 reviewed API handlers.
- `apps/api/src/modules/org/security-alert-actions-routes.ts` — dismiss handler (1 of the 6).
- `apps/api/src/lib/audit-or-fail-closed.ts` — fail-closed audit-write contract all 6 actions rely on.
- `apps/api/src/lib/secure-route.ts` — RLS-context/authz framework all 6 routes are registered through.
- `packages/db/src/migrations/0029_machine_users_and_api_keys.sql` — RLS policies for `machine_users`/`api_keys` (lines 52-65).
- `packages/shared/src/constants/audit-events.ts` — `AuditEvent.*` constants (lines 67-76).
- `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte` — machine-user detail page UI (4 of the 6 actions' primary UI entry point).
- `apps/web/src/routes/(app)/notifications/+page.svelte`, `+page.server.ts` — dormancy-alert UI entry points (dismiss, extend, revoke-via-dormancy-alert).
- `apps/web/src/lib/components/notifications/DismissDormancyAlertForm.svelte` — dismiss UI component.
- `apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte` — shared confirmation-dialog component used by 4 of the 6 actions' primary UI path.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
