# Story 14.8: Document RBAC Role-Gate Convention

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer implementing or reviewing any `secureRoute()` registration,
I want a single documented convention for choosing `minimumRole` vs. `allowedRoles` (and a consistent ordering rule when `allowedRoles` is the right choice),
so that the same judgment call epic 14 re-derived three times (14-2, 14-5, 14-6) never has to be re-derived again, and `org/routes.ts`'s existing inconsistent `allowedRoles` ordering stops looking like an unreviewed accident.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — documentation + internal refactor only; no new route, no new UI, no behavior change |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — see rationale below |

### Persona journey stub

N/A. This story adds a convention to `architecture.md` and reorders arguments within existing
`security: { allowedRoles: [...] }` calls in `apps/api/src/modules/org/routes.ts`. It does not add,
remove, or change any route's authorization *outcome* (who is let in), any endpoint, or any UI. There
is no persona-visible behavior to journey-map. If any AC in this story is found to change which roles
can call a route, that is a bug per AC-6 (regression guard), not an intended surface change.

## Acceptance Criteria

1. **`architecture.md` documents a single RBAC role-gate convention**, added to the "Enforcement
   Guidelines" subsection of "Implementation Patterns & Consistency Rules" (alongside the existing
   "All AI Agents MUST" / "Anti-Patterns" bullet lists, `architecture.md` lines ~971-1024), stating:
   - `secureRoute`'s `roleRank` hierarchy is `owner (3) > admin (2) > member (1) > viewer (0)`
     (`apps/api/src/lib/secure-route.ts` `roleRank()`).
   - **Default to `minimumRole: '<role>'`** for any "this role or any higher rank" gate — the
     overwhelming majority of authorization checks in this codebase (e.g. "admin or owner may do
     X" is `minimumRole: 'admin'`, not `allowedRoles: ['admin', 'owner']`). `minimumRole` is
     self-documenting (one value, not an enumerable set to keep in sync with the hierarchy) and
     structurally immune to the ordering inconsistency this story fixes — there is nothing to
     order.
   - **Reserve `allowedRoles` for a genuinely non-contiguous set** — i.e. only when the set of
     permitted roles is *not* expressible as "rank ≥ N" (an explicit hierarchy exception). The
     concrete precedent already in this codebase: `apps/api/src/extensions/status-routes.ts`
     deliberately uses `allowedRoles: ['admin']` to *exclude* `owner` from viewing extension
     status, even though `owner` outranks `admin` — a real, documented business rule that
     `minimumRole` cannot express. Any new `allowedRoles` usage must carry an inline comment
     explaining which rank is being excluded/included non-contiguously and why (matching
     `status-routes.ts`'s existing comment as the reference example) — an `allowedRoles` array
     that turns out to be contiguous-from-the-top (e.g. `['owner', 'admin']`, `['owner', 'admin',
     'member', 'viewer']`) with no such comment is a convention violation and should be
     `minimumRole` instead.
   - **When `allowedRoles` is the right choice, list roles in descending rank order** (`owner`,
     `admin`, `member`, `viewer` — whichever subset applies, in that relative order) purely for
     human scanability and diff-review consistency. `Array.prototype.includes` does not care about
     order — this is a readability rule, not a functional one — but a mixed-order codebase (see
     AC-2) reads as unreviewed and makes real anomalies harder to spot.
   - **Decision matrix** (suggested literal table for `architecture.md`, so a developer can scan
     rather than parse prose):

     | Question | `minimumRole: '<role>'` | `allowedRoles: [...]` |
     |---|---|---|
     | Is the permitted set "this rank or higher"? | Yes → use this | No — see next column |
     | Is the permitted set non-contiguous (excludes a higher rank while allowing a lower one)? | N/A — not expressible | Yes → use this, with a required inline comment |
     | Does the set change if a new role is inserted into the hierarchy? | No — automatically correct | Yes — must be manually revisited |
     | Ordering requirement | None (single value) | Descending rank order, enforced by lint (AC-7) |

   - One worked example of each case, using real file:line references from this codebase (see
     Dev Notes § References for the exact lines to cite: `org/routes.ts` for `minimumRole`,
     `extensions/status-routes.ts` for the legitimate `allowedRoles` exception).
   - **Alternatives considered and rejected** (ADR-style trade-off framing, so the convention reads
     as a reasoned decision, not just an assertion): (a) *always require `allowedRoles`, never
     `minimumRole`* — rejected because it forces every "N-or-higher" gate to enumerate and
     hand-maintain a set against the hierarchy, which is exactly the drift this story exists to
     fix, just moved to every call site instead of one; (b) *always require `minimumRole`, ban
     `allowedRoles` entirely* — rejected because `status-routes.ts`'s owner-exclusion is a real,
     currently-shipping business rule with no `minimumRole`-expressible equivalent; banning
     `allowedRoles` would force a workaround (e.g. a post-hoc `if (role === 'owner') deny`) that's
     strictly worse than the mechanism this codebase already has; (c) *the chosen rule* (default to
     `minimumRole`, `allowedRoles` only for documented non-contiguous exceptions) — keeps the
     common case self-documenting while preserving an explicit, comment-required escape hatch for
     the genuine exception case.
   - A one-line note that a standalone ADR file was considered and rejected: this codebase's
     existing ADR convention is inline `// ADR-<epic>.<story>-<seq>:` comments at the decision
     site (see `ADR-6.2-04`, `ADR-4.4-05`, etc. throughout `apps/api/src`), not standalone ADR
     documents — no standalone ADR files exist anywhere in this repo. This story's new rule should
     tag the `org/routes.ts` retrofit (AC-2) with a new `ADR-14.8-01` comment at one of the
     touched sites, consistent with that existing pattern, rather than introducing a new
     documentation format.

2. **Retrofit `apps/api/src/modules/org/routes.ts`'s inconsistent `allowedRoles` ordering** to match
   AC-1's descending-rank-order rule — and *only* the ordering, per the retro finding's literal
   scope (`sprint-status.yaml` `14-8` entry / `epic-14-retro-2026-07-28.md` Finding 3: "retrofit
   `org/routes.ts`'s existing inconsistent ordering"). Concretely, as of this story's creation:
   - Line 166, route `DELETE /users/:userId/sessions` (method/url declared at lines 154-155):
     `allowedRoles: ['admin', 'owner']` → `allowedRoles: ['owner', 'admin']`.
   - Line 218, route `POST /users/:userId/deactivate` (method/url declared at lines 206-207):
     `allowedRoles: ['admin', 'owner']` → `allowedRoles: ['owner', 'admin']`.
   - Line 341, route `POST /users/:userId/recovery/send-link` (method/url declared at lines
     330-331): `allowedRoles: ['admin', 'owner']` → `allowedRoles: ['owner', 'admin']`.
   - Lines 97 and 122 (`allowedRoles: ['owner', 'admin']`) and line 699 (`allowedRoles: ['owner']`)
     are already compliant — leave untouched.
   - The three `minimumRole: 'admin'` sites in this file (lines 411, 439, 579) are **out of scope**
     for this AC — they already use the preferred mechanism per AC-1 and need no change. Do not
     convert them to `allowedRoles` or vice versa; do not "improve" them beyond what AC-1's
     convention already endorses. (Line numbers are approximate as of story creation — locate by
     `grep -n "allowedRoles" apps/api/src/modules/org/routes.ts` at dev time and confirm the exact
     set before editing, since other stories may have touched this file in the interim.)

3. **Concrete positive example verified against real code**: after AC-2's retrofit, every
   `allowedRoles` array in `apps/api/src/modules/org/routes.ts` is in descending rank order, and
   `grep -n "allowedRoles" apps/api/src/modules/org/routes.ts` shows no remaining `['admin',
   'owner']` (wrong order) occurrences — only `['owner', 'admin']` or `['owner']`.

4. **Edge case — legitimate non-contiguous `allowedRoles` is not touched or "fixed."**
   `apps/api/src/extensions/status-routes.ts`'s `allowedRoles: ['admin']` (owner deliberately
   excluded) and `apps/api/src/modules/auth/external-identity-routes.ts`'s `allowedRoles:
   ['admin']` (same judgment call, reused per its own comment) are **not** in scope for this
   story's retrofit — they are each single-element arrays (no ordering question applies) and are
   the canonical *correct* use of `allowedRoles` this story's new convention documents. Do not
   convert them to `minimumRole: 'admin'` — that would silently admit `owner`, changing real
   authorization behavior, which this story must not do anywhere (see AC-6).

5. **Edge case — scope boundary is `org/routes.ts` only, not a repo-wide sweep.** Other files
   identified during story creation with `allowedRoles` arrays not in descending order do **not**
   exist as of this writing outside `org/routes.ts` (verified: `notifications/routes.ts`,
   `users/routes.ts`, `audit/routes.ts` all already use either single-role or already-descending
   arrays — see Dev Notes § References for the full grep output this claim is based on). If dev
   time discovers a new inconsistent site elsewhere introduced by a story that merged after this
   one was written, do **not** silently expand this story's scope to fix it — flag it in Dev Notes
   / Completion Notes as a new candidate for `deferred-work.md`, the same "flag, don't silently
   fix or silently skip" pattern this epic's retros have repeatedly called out (see Dev Notes §
   Previous Story Intelligence).

6. **Regression guard — zero behavior change.** `allowedRoles.includes(auth.orgRole)`
   (`secure-route.ts` `hasSufficientRole()`) is order-independent, so reordering array *elements*
   cannot change which roles are authorized — but this must be proven, not assumed:
   - `apps/api/src/__tests__/route-audit.test.ts` passes unchanged (no route added/removed/renamed).
   - Every existing RBAC-focused integration test in `apps/api/src/modules/org/*.test.ts` covering
     the five retrofitted-or-verified routes (AC-2's three changed routes — `DELETE
     /users/:userId/sessions`, `POST /users/:userId/deactivate`, `POST
     /users/:userId/recovery/send-link` — plus the two AC-2 already-compliant `['owner', 'admin']`
     routes, `GET /security-alerts` at line 97 and `POST
     /security-alerts/:securityAlertId/dismiss` at line 122) still passes unchanged, proving
     `owner` and `admin` are both still authorized and `member`/`viewer` are both still rejected,
     for each of those routes, exactly as before the reorder.
   - `make ci` passes fully green with no new test additions required for this AC beyond confirming
     the above still hold (this story does not need *new* RBAC test cases — the existing per-role
     coverage from 14-6/prior stories already exercises these routes; a new test is only needed if
     that coverage turns out to have a gap, which should be flagged, not silently patched over).

7. **Enforce the convention with a lint rule, not just documentation.** This project has already
   hit "the same convention re-derived N times, never enforced" exactly once before — Epic 5/14's
   `z.union` error-schema-ordering house rule (P5-1), raised three times across two epics before
   Epic 15's retro finally added `packages/eslint-config/rules/no-error-schema-first-in-union.js`
   to stop a fourth recurrence (see Epic 15 retro's Post-Ceremony Addendum). This story's own
   trigger (Finding 3) is the identical failure shape — re-derived at 14-2, 14-5, 14-6 — so writing
   the rule down in `architecture.md` alone would repeat P5-1's first three (unenforced) rounds
   instead of learning from its eventual fix. Add a new custom ESLint rule,
   `packages/eslint-config/rules/no-contiguous-allowed-roles.js` (mirroring
   `no-error-schema-first-in-union.js`'s structure: an AST rule matching `allowedRoles: [...]`
   array literals inside a `security` object), that flags any `allowedRoles` array whose elements
   are contiguous from the top of the rank hierarchy (`owner`, `admin`, `member`, `viewer` —
   i.e. expressible as `minimumRole`) with no adjacent explanatory comment, per AC-1's convention.
   Wire it into `packages/eslint-config/index.js` alongside the existing rule. Add a rule unit test
   (mirroring `no-error-schema-first-in-union.test.js`) covering: a contiguous array with no comment
   (flagged), a contiguous array with an explanatory comment (allowed — matches
   `status-routes.ts`'s pattern, which itself is single-element and therefore not contiguous, so
   this needs a synthetic multi-element example in the test, not a reference to real non-contiguous
   code), and a genuinely non-contiguous array (allowed, no comment needed since order can't be
   "wrong" when the set itself is the exception). This AC is the difference between this story
   *documenting* the convention and this story *closing* the gap Finding 3 actually describes.

## Tasks / Subtasks

- [ ] Task 1 — Write the architecture.md convention (AC-1)
  - [ ] Subtask 1.1: Read the current "Enforcement Guidelines" subsection (`architecture.md`
    ~lines 971-1024) to match its existing bullet style and voice exactly (short, imperative,
    file:line-cited where possible — see e.g. the existing MFA-enforcement bullet at line 1021).
  - [ ] Subtask 1.2: Add the new convention as bullets in "All AI Agents MUST" (the `minimumRole`
    default rule) and "Anti-Patterns" (the "contiguous `allowedRoles` with no exception comment"
    anti-pattern), plus a short standalone paragraph or sub-list with the two worked examples
    (`org/routes.ts` `minimumRole` site, `extensions/status-routes.ts` `allowedRoles` exception).
  - [ ] Subtask 1.3: Add the one-line "why not a standalone ADR file" note (AC-1's last bullet).
- [ ] Task 2 — Retrofit `org/routes.ts` ordering (AC-2, AC-3)
  - [ ] Subtask 2.1: `grep -n "allowedRoles" apps/api/src/modules/org/routes.ts` to confirm the
    current exact set of sites and line numbers (this story's line numbers were captured at story
    creation and may have shifted).
  - [ ] Subtask 2.2: Reorder each `['admin', 'owner']` occurrence to `['owner', 'admin']`. No other
    change to those route registrations.
  - [ ] Subtask 2.3: Add one `// ADR-14.8-01: ...` comment (per AC-1's last bullet) at one
    representative retrofitted site (or at the top of the file's `security` usage, dev's choice),
    pointing back to the new `architecture.md` convention section, matching the existing
    `ADR-<epic>.<story>-<seq>` inline-comment style used elsewhere in this codebase.
- [ ] Task 3 — Confirm scope boundaries (AC-4, AC-5)
  - [ ] Subtask 3.1: Re-run the repo-wide `allowedRoles`/`minimumRole` grep (see Dev Notes §
    References) at dev time to confirm no new inconsistent site landed in another file since story
    creation; if one is found, document it in Completion Notes as a candidate for
    `deferred-work.md` rather than fixing it in this story.
  - [ ] Subtask 3.2: Confirm `extensions/status-routes.ts` and `auth/external-identity-routes.ts`
    are left untouched.
- [ ] Task 4 — Prove zero behavior change (AC-6)
  - [ ] Subtask 4.1: Run the existing `apps/api/src/modules/org/*.test.ts` suite and
    `route-audit.test.ts`; confirm all green with no new failures and no test file needing an
    update to keep passing (a test needing an update to still pass would itself indicate a
    behavior change, which is not the goal of this story).
  - [ ] Subtask 4.2: Run `make ci` fully green before marking this story `review`.
- [ ] Task 5 — Add lint enforcement (AC-7)
  - [ ] Subtask 5.1: Read `packages/eslint-config/rules/no-error-schema-first-in-union.js` and its
    test file as the structural template (plain AST visitor, no external deps, house-rule comment
    at the top citing the retro finding).
  - [ ] Subtask 5.2: Write `packages/eslint-config/rules/no-contiguous-allowed-roles.js` per AC-7.
  - [ ] Subtask 5.3: Wire it into `packages/eslint-config/index.js` next to the existing rule
    (`apiEnforcement` ruleset or equivalent), set to `error`.
  - [ ] Subtask 5.4: Write `no-contiguous-allowed-roles.test.js` with the three cases from AC-7;
    add it to `packages/eslint-config/vitest.config.ts`'s coverage `include` list alongside the
    existing rule test.
  - [ ] Subtask 5.5: Run the new rule repo-wide (`pnpm lint` or targeted eslint invocation) to
    confirm it does not flag any of AC-2's post-retrofit `org/routes.ts` sites or the AC-4 legitimate
    exceptions — a false positive here would mean the rule's predicate is wrong, not that the code
    needs changing.

## Dev Notes

- This is a **documentation + pure-reorder refactor** story — the smallest-blast-radius kind of
  story in this project's recent history (compare to 16-1's CSS-injection fix or 14-6's full CRUD
  build). Resist the temptation to "clean up" adjacent code while in `org/routes.ts` — scope is
  exactly AC-1 through AC-6, nothing more.
- **Do not convert any `minimumRole` site to `allowedRoles` or vice versa anywhere in this story.**
  The retro finding's literal scope is documenting the convention plus fixing `org/routes.ts`'s
  *ordering* — not auditing/converting every RBAC site in the codebase (there are ~140+ other
  `minimumRole`/`allowedRoles` sites across `rotation/`, `credentials/`, `monitoring/`,
  `machine-users/`, `projects/`, `notifications/`, `audit/`, `invitations/`, etc. — all out of
  scope). If a future retro or story wants a full-codebase conversion pass, that is separate,
  larger work with its own risk profile (each conversion is a potential behavior change unless
  carefully audited) — flag it as a candidate rather than doing it here.
- **`secure-route.ts`'s actual mechanism** (`hasSufficientRole()`, lines ~211-219): if `allowedRoles`
  is set and non-empty, it wins outright (`allowedRoles.includes(auth.orgRole)`) and `minimumRole`
  is not even consulted; otherwise `minimumRole` (default `'viewer'`) is compared via `roleRank()`.
  This confirms the two mechanisms are mutually exclusive per-route (not layered), so the
  convention's job is purely "which one to reach for," not how they interact.
- **Full grep evidence this story's ACs are based on** (repo-wide,
  `grep -rn "allowedRoles\|minimumRole" apps/api/src --include=*.ts | grep -v .test.ts`, run at
  story-creation time): confirms `org/routes.ts` is the only file with a demonstrable
  `allowedRoles` ordering inconsistency (`['owner','admin']` at 97/122 vs. `['admin','owner']` at
  166/218/341). Other files with multi-role `allowedRoles` arrays
  (`notifications/routes.ts:35,40,243`, `users/routes.ts:34,78`) already use a single consistent
  order (`['owner', 'admin', 'member', 'viewer']`); `credentials/routes.ts:654,768,1565` and
  `theming/routes.ts:35` already use `['owner', 'admin']` consistently; `audit/routes.ts`'s six
  `allowedRoles: ['owner']` sites are single-element. Re-verify this at dev time (Task 3.1) since
  other in-flight stories could have touched these files since this story was written.
- **Scope re-verified during elicitation (Critical Perspective pass, 2026-07-28)**: independently
  re-ran the repo-wide `allowedRoles` grep against `main` at commit `daf2b27`. Confirms every site
  outside `org/routes.ts` — including two not enumerated in the original grep evidence above,
  `org/security-alert-actions-routes.ts:39` and `modules/admin/routes.ts:31` (both already
  `['owner', 'admin']`, already compliant) — is either single-element or already in descending
  order. The "org/routes.ts only" scope boundary holds; no under-scoping found. This is a snapshot,
  not a guarantee — Task 3.1's dev-time re-grep is still required.

### Previous Story Intelligence (14-6)

- 14-6's Dev Notes (`14-6-org-sso-domains-admin-ui.md` lines 76, 161) are the direct trigger for
  this story: it explicitly flagged its `minimumRole: 'admin'` choice as diverging from 14-5's
  `allowedRoles: ['admin']` precedent, and said *"do not silently pick one without documenting the
  choice"* — this story is that documentation finally landing. Do not re-relitigate 14-6's own
  choice (it stays `minimumRole: 'admin'`, unaffected by this story) — this story's job is the
  *convention going forward* plus `org/routes.ts`'s specific ordering bug, not re-opening settled
  per-route decisions from prior stories.
- 14-6's own retro pattern ("resolve now, flag for review" rather than blocking on an open
  question) is the model to follow here too: AC-1's convention is opinionated and actionable, not a
  request for the user to pick between options.
- Process pattern from 14-6 (and 16-1 before it): `make ci` must be fully green before `review`;
  rebase onto `main` before starting work in case a concurrent story has touched `org/routes.ts`
  since this file was written (verified clean on `main` as of commit `daf2b27` at story-creation
  time).

### Git Intelligence Summary

Recent commits on `main` (most recent first): `daf2b27` (merge PR #241, 14-6 done), `87c1f9c`
(SonarQube cleanup for 14-6), `ed6e6e2` (sprint: mark 14-6 done), `4568b72` (code review fixes for
14-6), `3156813` (feat: 14-6 CRUD + admin UI implementation). Pattern: implementation commit, then a
separate code-review-fixes commit, then a separate SonarQube-cleanup commit, each with its own
sprint-status update — this story's scope is small enough that a single implementation commit plus,
if code review finds anything, one fixes commit should suffice; a separate SonarQube-cleanup commit
is unlikely to be needed given the tiny diff surface (one doc section, ~3 array reorders).

### Project Structure Notes

- Touches: `_bmad-output/planning-artifacts/architecture.md` (new convention content),
  `apps/api/src/modules/org/routes.ts` (ordering + one ADR comment),
  `packages/eslint-config/rules/no-contiguous-allowed-roles.js` (new, AC-7),
  `packages/eslint-config/rules/no-contiguous-allowed-roles.test.js` (new, AC-7),
  `packages/eslint-config/index.js` (wire-in), `packages/eslint-config/vitest.config.ts`
  (coverage include).
- Alignment with unified project structure: fully aligned — mirrors the existing
  `no-error-schema-first-in-union` rule's file layout exactly.
- No conflicts detected between this story's scope and any in-flight or backlog story (14-7,
  14-9 touch different files: external-identity admin UI and `packages/extension-api`
  respectively).
- **Failure-mode note for AC-7 (Failure Mode Analysis pass, added during elicitation):** the new
  rule's biggest risk is a false positive that fails `pnpm lint`/`make ci` repo-wide on a site this
  story didn't intend to touch (there are ~140+ other `allowedRoles`/`minimumRole` sites outside
  `org/routes.ts` per Dev Notes' grep evidence — any one of them being a *legitimate* non-contiguous
  exception without a comment, e.g. a single-element array like `status-routes.ts`'s, would break
  the build if the rule's predicate is too broad). Concretely: the rule must treat single-element
  `allowedRoles` arrays as never-contiguous (there's nothing to be "contiguous" relative to), must
  correctly resolve the 4-value rank order (`owner > admin > member > viewer`) rather than
  assuming array length implies position, and must not attempt to flag `allowedRoles` values that
  aren't array literals (spread expressions, identifiers referencing a shared constant) — bail out
  (return, don't report) on those rather than crashing or false-flagging, exactly as
  `no-error-schema-first-in-union.js` already bails on non-`ArrayExpression` arguments. Subtask 5.5
  (repo-wide dry run before wiring `error` severity) exists specifically to catch this before it
  becomes a CI-breaking surprise for an unrelated in-flight story.

### References

- [Source: apps/api/src/lib/secure-route.ts#roleRank and hasSufficientRole (~lines 200-219)] —
  the exact mechanism this convention documents.
- [Source: apps/api/src/modules/org/routes.ts#lines 97,122,166,218,341,699 (allowedRoles),
  411,439,579 (minimumRole)] — the inconsistency being retrofitted.
- [Source: apps/api/src/extensions/status-routes.ts#lines 38-42] — the canonical legitimate
  `allowedRoles` exception (owner deliberately excluded), with its existing explanatory comment.
- [Source: apps/api/src/modules/auth/external-identity-routes.ts#lines 16-20] — 14-2's judgment
  call reused verbatim, citing the same rationale.
- [Source: _bmad-output/planning-artifacts/architecture.md#Enforcement Guidelines, ~lines 971-1024]
  — insertion point for the new convention; matches existing bullet style/voice.
- [Source: _bmad-output/implementation-artifacts/epic-14-retro-2026-07-28.md#Finding 3] — full
  root-cause narrative and literal scope ("retrofit org/routes.ts's existing inconsistent
  ordering") this story is faithful to.
- [Source: _bmad-output/implementation-artifacts/14-6-org-sso-domains-admin-ui.md#Dev Notes lines
  76, 161, 279] — the judgment call that triggered this story.
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml#14-8 entry, line 243] —
  authoritative backlog description this story file was created from.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
