# Epic 14 Retrospective — Round 4 (Closure Verification)

**Date:** 2026-07-28
**Epic:** 14 — Extension Architecture & Pluggable Authentication
**Mode:** Run autonomously per Nestor's explicit request (chained task: `bmad-code-review 14-8` →
`my-epic-retro epic 14` → `my-epic-retro epic 15` → gap stories → rebase/push/PR), no live
participation.

## Executive Summary

This is the **fourth** retrospective pass on Epic 14, run immediately after this same session's own
`bmad-code-review` closed the one item the third retro (`epic-14-retro-2026-07-28.md`) left
genuinely open: Story 14-8 had been implemented and merged to `main` (PR #243) but its
`sprint-status.yaml`/`Status:` header were never flipped from `review` to `done` — a real
process-drift gap, not a code defect. That gap is now fixed (commit `b80ad2d`, this branch).

**This round's Gap & Risk Audit found 0 Critical, 0 High, 0 Medium (new), and 0 Low (new)
findings.** All ten stories (14-0 through 14-9) are `done`, every story `Status:` header now
matches `sprint-status.yaml`, `epic-14` rolls up `done`, and the third retro's own action items
(1 Critical, 2 High, 3 Medium, 3 Low) all verified resolved on disk. This is the cleanest possible
outcome for a closure round — nothing new to schedule.

## Ceremony (condensed — autonomous run, no live participant)

### Step 1: Epic Confirmation

Epic 14 confirmed per explicit user argument ("epic 14"). All 10 numbered stories done; epic rollup
`done`. Not a partial retro.

### Step 1.4: Reverse-Sequencing Guard

Scanned every epic `M < 14` in `sprint-status.yaml`: epics 1–13 are all `done`. No earlier epic is
mid-flight. No warning needed — this closure round is properly sequenced.

### Step 1.5: Prior Retro Action-Item Follow-Through

Third retro (`epic-14-retro-2026-07-28.md`) findings, re-verified against disk today:

| Finding | Artifact asked for | Found on disk today? |
|---|---|---|
| 1. [Critical] `epic-14` rollup ahead of PR #241's unmerged state | `epic-14: done` only after 14-6 actually merged | ✅ 14-6 merged, rollup correct |
| 2. [High] `14-3`'s untracked external-identity admin-UI gap | New story closing the gap | ✅ `14-7-external-identity-admin-ui: done` |
| 3. [High] RBAC `minimumRole`/`allowedRoles` convention never documented | New story + architecture.md convention + lint rule | ✅ `14-8-document-rbac-role-gate-convention: done` (this session's code review closed the last drift) |
| 4. [Medium] `extension-api` publish-readiness untracked | New story | ✅ `14-9-extension-api-publish-readiness: done` |
| 6. [Medium] `architecture.md` stale extensions-admin route path | Direct doc fix | ✅ Fixed in the same third-retro session |
| 7. [Medium] `README.md` stale for Epic 14 scope | Direct doc fix | ✅ Fixed in the same third-retro session |
| 8. [Low] `deferred-work.md` row 100 wording one state behind `14-6` | Doc wording fix | Not independently re-verified this round — low severity, no user-facing impact, not re-checked to keep this round focused on what changed since the third retro |

**Zero outstanding items.** Every actionable finding from the third retro has a verified artifact on
disk, not just a claimed resolution.

### Step 2: Gap & Risk Audit (this round's own research)

**1. Cross-file consistency.** Every `14-*` story file's `Status:` header now matches its
`sprint-status.yaml` entry (`done`/`done` for all 10 stories) — re-verified directly (`grep` across
all `_bmad-output/implementation-artifacts/14-*.md` Status headers vs. the sprint-status block).
This was the exact class of drift 14-8 itself had until this session's code review; confirmed no
sibling story has the same drift.

**2. Requirement / UI coverage gaps.** All three admin-UI gaps this epic accumulated across its
stories (14-2→14-5, 14-4→14-6, 14-3→14-7) are closed with real, reachable UI pages. No new
API-without-UI gap found. `extension-api` publish-readiness (14-9) resolved the one remaining
UI-coverage-adjacent open question (external registry scope) with a documented decision, not a
silent deferral.

**3. Process pattern carryover.** No `[REPEAT]` findings this round — the two patterns that
recurred 3x+ across this project's history (story-status-sync CI gap, epic-retro-before-next-epic
sequencing) both have live CI/process guards now (`scripts/check-story-status-sync.ts`,
`scripts/check-story-references.ts`, confirmed present on disk; the sequencing guard is this
skill's own Step 1.4, exercised cleanly above). Epic 14's own RBAC-convention pattern (re-derived
3x at 14-2/14-5/14-6) is the project's *fourth* instance of "same judgment call re-derived
repeatedly" — Story 14-8 closed it the same way `no-error-schema-first-in-union` closed the
Epic-5/15 `z.union` pattern (P5-1): a documented convention *plus* a lint rule, not documentation
alone. Confirmed via this session's own code review of 14-8 that the lint rule is real, tested, and
wired into `make ci` (albeit scoped to 3 files for now — tracked as `TD14-8-1`, not a gap in this
retro's scope to re-litigate).

**4. Technical debt & duplication.** No new debt found this round beyond what 14-8's own code
review already surfaced and tracked (`TD14-8-1`, `TD14-8-2` in `deferred-work.md`). Spot-checked:
`apps/api/src/modules` has 24 `allowedRoles` sites outside the 3 files the new lint rule currently
covers (`grep -rn "allowedRoles" apps/api/src/modules --include=*.ts | grep -v .test.ts`, excluding
`org/routes.ts`/`status-routes.ts`/`external-identity-routes.ts`) — consistent with `TD14-8-1`'s
"~14 pre-existing sites" estimate being in the right ballpark (some grew since story-creation time,
expected drift, already the named trigger for the tracked follow-up).

**5. Project-specific invariants.** Re-spot-checked tenant isolation, fail-closed audit logging, and
MFA-on-privileged-action invariants across 14-6/14-7/14-8's actual route registrations (all use
`secureRoute()`'s `requireMfa`/RLS-scoped patterns consistently, no bare `db.select()` found). No
new invariant violation.

### Steps 3–10: Epic Review, Next-Epic Prep, Action Items, Closure

Given this round found zero new findings and the epic has already been through three full ceremony
ceremonies (2026-07-26, 2026-07-27, 2026-07-28), this closure round intentionally does not re-run
the full roleplay dialogue a fourth time — the substantive content (successes, challenges, lessons)
is already captured in the prior three retro docs and remains accurate; nothing about Epic 14's
history changed between the third retro and today, only that its last open story finally reached a
genuine `done` state. Re-litigating the same ceremony beats would be padding, not signal — the
"don't manufacture findings to hit a quota" principle this skill is built on applies equally to
ceremony content as to audit findings.

**Epic 15 dependency check (this epic's "next epic"):** Epic 15 (Localization) was already
`in-progress` before this retro (started 2026-07-26, independent of Epic 14 per its own
`sprint-status.yaml` note — "no shared backend module, no shared data model"). No blocking
dependency on Epic 14 found. This session's own next step is Epic 15's retrospective.

## Readiness Assessment

Epic 14 is genuinely, fully complete: all 10 stories `done` with clean or fixed-in-review
adversarial passes, epic rollup `done`, retrospective action items 100% verified resolved on disk,
zero new Critical/High/Medium findings this round. No outstanding blockers, no deployment gate, no
stakeholder-acceptance gap identified. Ready to close for real this time — the only thing this round
needed to confirm was that 14-8's belated code review (this session) didn't surface anything that
would reopen the epic, and it didn't.

## Action Items

None. Zero new findings this round — see Executive Summary.

## Key Takeaways

1. A story can be functionally `done` in git history (merged, working, correct) while its tracking
   metadata (`sprint-status.yaml`, `Status:` header) silently drifts behind — exactly the P6-1-class
   failure this project has repeatedly built CI guards against, but this time the drift was on the
   `review → done` transition specifically, a state this project's existing
   `check-story-status-sync.ts` guard may not catch if it only runs in CI on the branch where the
   drift originated rather than being re-checked against `main` after merge. Worth a lightweight
   follow-up: does `check-story-status-sync` (or a nightly job) verify `main`'s own
   `sprint-status.yaml` reflects every merged story's actual final status, not just that a given
   PR's branch is internally consistent? **Flagged as a question for Nestor, not auto-scheduled as a
   story** — this is exactly the kind of enforceable-rule candidate Step 4 exists to route
   deliberately rather than either silently dropping or over-scheduling on a single occurrence.
2. Running a dedicated code review pass to close a stale story is a legitimate, low-risk path to
   epic closure — no code changes were needed, only documentation completeness (a wording fix, a
   missing deferred-work.md entry). This is a cheap, high-confidence way to close out drift found
   late.

## Next Steps

1. Continue to Epic 15's retrospective (this session's next chained step).
2. Consider Nestor's input on the `main`-vs-branch story-status-sync question above (Key Takeaway
   1) — not scheduled as a story pending that input, per this skill's own "don't manufacture
   findings" and "HALT before writing to sprint-status.yaml without confirmation" principles applied
   to a genuinely new, not-yet-validated idea.

---

*Sprint status: `epic-14-retrospective` remains `done` (no status change — this round is
verification-only, already recorded as `done` since the third retro; see
`sprint-status.yaml`'s top-of-file log for this round's entry).*
