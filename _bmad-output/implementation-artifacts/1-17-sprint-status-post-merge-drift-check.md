# Story 1.17: Sprint-Status Post-Merge Drift Check

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- Ad-hoc, tooling-driven story with no epics.md backlog entry — same pattern as 1-13, 1-15, and
     1-16. Split out of 1-16's original scope item (b) during the epic-16 retrospective
     (epic-16-retro-2026-07-28.md, Finding 1) because it needs git/PR merge-history context that
     1-16's static working-tree scan (scripts/check-sprint-status-rollup.ts) cannot see. Slotted
     into epic-1 because it is a direct sibling of 1-16 (same drift-class family: sprint-status.yaml
     tracking metadata disagreeing with reality) and epic-1 is already reopened and held open for
     it. -->

## Story

As a scrum master / developer relying on `sprint-status.yaml` as the single source of truth for
what has actually shipped,
I want an automated, post-merge check that catches a story whose PR merged to `main` while its
tracked status in `sprint-status.yaml` never advanced to `done`,
so that the "PR merged, but the `review` → `done` transition was a separate commit that never
happened" drift class (the exact failure that hit Story 14.8 — see Background below) gets caught
automatically within a day, instead of surviving silently until the next manual epic retrospective
stumbles onto it.

## Background / Discovery Context

Split out of **1-16-sprint-status-drift-ci-guard** (done) during the epic-16 retrospective
(`epic-16-retro-2026-07-28.md`, Finding 1, `[REPEAT 3x]`). 1-16 built
`scripts/check-sprint-status-rollup.ts`, a pre-merge `make ci` guard that catches an `epic-N`
rollup key stuck non-`done` while all of `epic-N`'s own stories and its retrospective are already
`done` — a **static scan over the current working tree**, run on a feature branch before it merges.

1-16's own story description explicitly deferred this story's scope:

> Scope item (b) (verifying a merged PR's target-branch `sprint-status.yaml` reflects the story's
> actual post-merge status) needs git/PR context this static scan doesn't have and is split out as
> 1-17 below rather than bundled — a nightly/post-merge job is a materially different mechanism
> than a pre-merge `make ci` check, and bundling both under one story is exactly the kind of scope
> ambiguity that let this sit in backlog.

**The concrete incident this exists to catch (Story 14.8):** 14.8's `sprint-status.yaml` entry
stayed at `review` for a day *after* its branch had already merged to `main` via PR #243. Nothing
re-checks `main`'s own `sprint-status.yaml` after a merge lands to confirm it reflects the story's
real final state — the `review` → `done` flip was supposed to be a distinct, later commit (per this
project's Path C flow: C1 commits the implementation at `review`, C4 flips to `done` and commits
again, C5 pushes, C6 opens the PR against the *already-`done`-committed* branch). If that C4 commit
is ever skipped, forgotten, or the PR is merged before it lands, `main` ends up with a merged,
working feature whose tracking entry never says so — invisible to `1-16`'s guard (which only checks
`epic-N` rollup keys against their child stories, not each story's own status), and invisible to
`check-story-status-sync.ts` (which only compares the story *file's* `Status:` header against
`sprint-status.yaml` — both can agree with each other and still be wrong about whether the PR
merged).

**Why this needs git/PR history, not just a file scan:** a scan of `main`'s current
`sprint-status.yaml` alone cannot tell you "this story's PR already merged" — it can only tell you
the story's *tracked* status. The signal that a PR merged lives in git's commit history: this
project's PRs are merged via GitHub's default merge-commit strategy (verify below), which leaves a
commit whose message follows the pattern `Merge pull request #<N> from <owner>/<branch>`. Confirmed
against this repo's own `main` history:

```
392e0e4 Merge pull request #253 from nestormata/feature/17-2-share-a-credential-with-an-external-recipient-via-secure-link
```

Combined with this project's own branch-naming convention (`pick-story`'s `feature/<story-slug>`,
see B2/C0 in `.claude/skills/pick-story/SKILL.md`), a merge commit's source branch tells you exactly
which story slug just landed on `main`. Cross-referencing that against `development_status` in the
`sprint-status.yaml` committed at that same point in history (or at `HEAD`, for stories whose merge
is not yet superseded by a later status change) is the missing signal.

**No GitHub API / `gh` CLI needed.** The merge-commit message alone contains the PR number and
source branch — this check never needs to call the GitHub API, so there is no token, auth, or rate
limit concern anywhere in this story. It is a pure `git log` scan, same spirit as
`scripts/check-extension-api-version-skew.ts`'s `git show <ref>:<path>` approach (see that script
for this repo's established pattern of shelling out to `git` via `execFileSync` from a pure,
unit-testable function).

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — internal repo-tooling/CI story, no user-facing surface. Rationale: this check runs entirely inside GitHub Actions and Slack notification, never rendered to a Vault end user. |

## Acceptance Criteria

1. **AC-1 (core detection):** A new pure, DB-free, unit-testable function
   `scanPostMergeStatusDrift(rootDir)` in `scripts/check-post-merge-status-drift.ts` scans `git log`
   on the checked-out branch for merge commits matching the pattern
   `Merge pull request #<N> from <anything>/feature/<slug>`, extracts `<slug>`, and — for every
   extracted `<slug>` that is also a key in `sprint-status.yaml`'s `development_status` block at
   `HEAD` — flags it as drift if its current status is **not** `done`.
   - **Happy path:** `main`'s git log contains
     `Merge pull request #253 from nestormata/feature/17-2-share-a-credential-with-an-external-recipient-via-secure-link`,
     and `development_status['17-2-share-a-credential-with-an-external-recipient-via-secure-link']`
     is `done` at `HEAD` → no drift reported for that story.
   - **Edge/failure case:** git log contains a merge commit for `feature/14-8-<slug>`, but
     `development_status['14-8-<slug>']` is `review` (not `done`) at `HEAD` → drift reported, citing
     the story key, its current status, the PR number, and the merge commit SHA (the exact 14.8
     incident this story exists to catch).

2. **AC-2 (dedup):** If more than one merge commit in history references the same story slug (e.g.
   a revert immediately followed by a re-merge of the same branch name), the story is reported **at
   most once** in the drift list, keyed by story slug — not once per matching commit.
   - **Positive example:** two merge commits both reference `feature/9-3-foo` (one reverted, one
     re-landed); `9-3-foo`'s tracked status is still `review` → exactly one drift entry for
     `9-3-foo` in the result array, not two.
   - **Edge case:** same scenario, but the story's tracked status IS `done` → zero drift entries
     (not one "no-drift" placeholder entry — the function returns `[]` for that key entirely).

3. **AC-3 (branch-pattern scoping):** Merge commits whose source branch does **not** match
   `feature/<slug>` (e.g. `chore/epic-16-retro`, `fix/some-hotfix`, `retro/epics-1-5-14-2026-07-26`)
   are ignored entirely — never considered as candidate story slugs, regardless of what their
   messages contain.
   - **Positive example:** `Merge pull request #250 from nestormata/chore/epic-16-retro` in the log
     → contributes zero drift candidates, even if a key named `epic-16-retro` happened to exist in
     `development_status` (it doesn't, but the scoping must not accidentally match retro-branch
     names).
   - **Edge case:** a merge commit's branch name is `feature/` with an **empty** slug (malformed,
     should never happen in practice but must not crash the scanner) → skipped safely, no exception
     thrown, not reported as drift.
   - **Edge case (slug-collision safety):** the capture group matches the **full remainder** of the
     subject line after `feature/`, anchored to end-of-string — so `feature/1-1-foo` can never
     partially match a longer sibling slug like `1-11-foobar`. No additional collision-guard logic
     is needed; this falls out of the regex anchor alone. (Verified during story elicitation: no
     two story keys in this repo's current `sprint-status.yaml` share a prefix relationship that
     could otherwise be ambiguous.)

4. **AC-4 (untracked-key skip — matches existing guard precedent):** A story slug extracted from a
   merge commit that is **not** a key in the current `development_status` block (e.g. the key was
   later renamed, or the story was deleted from tracking) is **not** flagged as drift. This mirrors
   `scripts/check-story-status-sync.ts`'s existing "not a tracked story key... skip" precedent —
   silently skipped, not an error, not a warning.
   - **Positive example:** merge commit references `feature/2-1-old-slug-name`, but
     `development_status` was later edited to rename that key to `2-1-new-slug-name` → no drift
     reported for either the old or the new key from this signal alone.
   - **Edge case:** `development_status` block is missing/unparseable at `HEAD` (e.g. corrupted
     YAML, matching `check-sprint-status-rollup.ts`'s and `check-story-status-sync.ts`'s existing
     `loadSprintStatuses` → `null` → empty-result fallback pattern) → function returns `[]`, does
     **not** throw, does **not** fail the job with a confusing stack trace.

5. **AC-5 (git history depth guard — operational logging):** The scanning function documents (via a
   code comment, not a runtime check — see Dev Notes on why a runtime check isn't feasible) that it
   requires **full git history** (`fetch-depth: 0`), not the shallow default GitHub Actions checkout
   uses. The GitHub Actions workflow step (AC-6) explicitly sets `fetch-depth: 0` on its checkout,
   with a comment explaining why (a shallow clone would silently under-report drift by missing older
   merge commits, producing a false-negative "all clear" rather than a false alarm — the more
   dangerous failure direction for a drift detector).
   - **Positive example:** workflow YAML's `actions/checkout@v7` step includes
     `with: { fetch-depth: 0 }`.
   - **Edge case:** if `fetch-depth: 0` is ever accidentally removed in a future edit, the job does
     not crash — it just silently scans a truncated history and may miss older drift. This is
     called out explicitly in a code comment beside the checkout step so a future editor doesn't
     drop it without noticing the consequence (this is a documentation/comment requirement, not a
     new automated guard — do not build a meta-check for this in this story; that would be
     unbounded scope creep for a one-line config risk).

6. **AC-6 (GitHub Actions wiring — new workflow, NOT `make ci`):** A new workflow file
   `.github/workflows/post-merge-status-drift.yml` triggers `on: push: branches: [main]` (i.e. runs
   immediately after every merge to `main` — this project's only path onto `main` is a merged PR,
   per `pick-story`'s C5/C6). It checks out with `fetch-depth: 0` (AC-5), runs
   `pnpm check-post-merge-status-drift`, and on failure posts to Slack via
   `slackapi/slack-github-action@v3`, mirroring `.github/workflows/nightly.yml`'s existing
   `notify-failure` job pattern **exactly** (same `SLACK_WEBHOOK_URL` env-then-`if` guard so a
   missing webhook secret doesn't itself fail the job; same payload shape/style). This check is
   **explicitly not added** to `Makefile`'s `ci` target or `.github/workflows/ci.yml` — unlike
   1-16's rollup check, this one only makes sense running against `main`'s own post-merge history,
   never against a pre-merge feature branch (a feature branch's own history won't yet contain the
   merge commit for its own not-yet-merged PR).
   - **Positive example:** a PR merges to `main` → the new workflow fires automatically within
     GitHub Actions' normal push-triggered latency (seconds, not the nightly cron's up-to-24h
     latency) → passes silently (matching `check-sprint-status-rollup`'s stdout-only-on-success
     convention) when there is no drift.
   - **Edge case:** the workflow run itself fails for an unrelated infra reason (e.g. `pnpm install`
     network flake) → the Slack notify step still fires (it's gated on `if: failure()` at the job
     level, not specifically on the drift check's own exit code), same as `nightly.yml`'s existing
     behavior — do not try to distinguish "drift found" from "job infra failure" in the
     notification; that distinction is visible by clicking through to the run, per the existing
     `nightly.yml` convention already accepted in this repo.

7. **AC-7 (package.json wiring):** `package.json`'s `scripts` block gains
   `"check-post-merge-status-drift": "tsx scripts/check-post-merge-status-drift.ts"`, following the
   exact convention of the neighboring `check-story-status-sync` / `check-sprint-status-rollup`
   entries (same directory, same `tsx` invocation style, alphabetically placed near them).

8. **AC-8 (merge-strategy precondition — critical, found via pre-mortem elicitation):** This
   detector's entire signal depends on every PR merge to `main` producing a
   `Merge pull request #<N> from <owner>/<branch>` commit message. **Verified during story
   elicitation that this is currently NOT guaranteed**: `gh api repos/nestormata/project-vault`
   shows `allow_squash_merge: true` and `allow_rebase_merge: true` are both enabled alongside
   `allow_merge_commit: true`, and this repo's own git history contains real squash-merged PRs with
   no merge commit at all (e.g. `4f9f8c2 feat(credentials): control field visibility and reveal
   sensitive fields (13-3) (#227)` — a single commit ending in `(#227)`, GitHub's squash-merge
   signature, not a merge commit). A squash- or rebase-merged story PR is **invisible** to this
   scanner — a false negative, silently reporting "all clear" for a story that actually has the
   14.8 drift. This task **must** include, as a one-time repository configuration change (via
   GitHub's repo Settings → General → Pull Requests, or `gh api -X PATCH
   repos/<owner>/<repo> -f allow_squash_merge=false -f allow_rebase_merge=false`): disable squash
   merge and rebase merge, leaving **only** "Create a merge commit" enabled. This does not
   retroactively fix historical squash-merged entries (none currently show drift regardless — see
   AC-4's untracked-key skip, and Task 3.3's real-repo smoke test) but guarantees the precondition
   holds for every merge going forward. If the implementer lacks repository admin permissions to
   change this setting, they must surface it explicitly to the user as a manual follow-up rather
   than silently shipping a detector whose core assumption is unenforced.
   - **Why not also parse squash-merge commit messages as a fallback:** squash-merge commit
     subjects contain only the PR title (e.g. `... (13-3) (#227)`), not the source branch name —
     there is no reliable, convention-guaranteed place to find the `feature/<slug>` string in a
     squash commit. Attempting to regex-match an inline `(<epic>-<story>)` token in arbitrary commit
     messages is unreliable (many non-story commits, e.g. retro/chore commits, also end in
     `(#N)` without any bracketed story reference — see `8d74bd8 Retro: Epic 1, 5, 14 completion
     rounds (autonomous) (#229)`) and would require the GitHub API to resolve `#N` → head branch
     reliably, reintroducing the auth/rate-limit surface this story deliberately avoids (see
     Background). Enforcing merge-commit-only strategy at the repo level is simpler and strictly
     more reliable than trying to parse an unreliable fallback signal — this is the Occam's-Razor
     resolution reached during elicitation.

9. **AC-9 (fail loud vs. fail quiet — asymmetric error handling, found via failure-mode
   elicitation):** If the `git log` invocation itself throws (e.g. not a git repository, `git`
   binary missing, corrupted `.git` directory) the script must **fail loud**: non-zero exit code
   and a clear stderr message naming the underlying error — it must NOT silently report "no drift."
   This is the opposite convention from AC-4's YAML-parse-failure handling (`loadSprintStatuses` →
   `null` → `[]`, silently treated as "nothing to check"), and the asymmetry is intentional: a
   missing/unparseable `sprint-status.yaml` might legitimately mean "this repo doesn't use that
   convention yet" (existing sibling-script precedent), but this check runs in exactly one
   environment — a full-history CI checkout of `main` — where `git log` failing signals real
   infrastructure breakage (e.g. AC-5's `fetch-depth: 0` was dropped, or the checkout step itself is
   broken) that must be surfaced, not swallowed into a false "all clear." Contrast with
   `check-extension-api-version-skew.ts`'s deliberate fail-open behavior on diff-range errors — that
   script accepts fail-open because it also runs in ad hoc local/dev contexts where a resolvable
   base ref is a reasonable thing to be missing; this script has no such ambiguous context.

10. **AC-10 (report output — operational logging convention):** On success, the script writes a
   single stdout line: `check-post-merge-status-drift: no merged-PR / sprint-status drift found —
   OK\n` (matching the exact tone/format of `check-sprint-status-rollup`'s and
   `check-story-status-sync`'s success lines). On drift, it writes to stderr a `FATAL:` line
   followed by one line per drifted story (key, current status, PR number, merge commit SHA short
   form) and sets `process.exitCode = 1` — never `process.exit(1)` (matches existing scripts'
   convention of letting Node flush stdout/stderr before exiting).

## Tasks / Subtasks

- [ ] Task 1: Implement the pure scanning function (AC-1, AC-2, AC-3, AC-4)
  - [ ] 1.1 Create `scripts/check-post-merge-status-drift.ts`. Reuse `parseDevelopmentStatus` and
    `loadSprintStatuses` from `scripts/check-story-status-sync.ts` (already exported) rather than
    re-parsing the YAML — do not duplicate that parsing logic.
  - [ ] 1.2 Add a small `git(repoRoot, args)` wrapper via `execFileSync`, following
    `scripts/check-extension-api-version-skew.ts`'s exact pattern (including its
    `// NOSONAR(typescript:S4036)` comment convention for the trusted-binary-on-PATH exemption).
  - [ ] 1.3 Run `git log --merges --grep='^Merge pull request #' -E --format='%H%x09%s'` (tab-
    separated SHA + subject) against `HEAD` to enumerate merge commits without needing a ref range
    (contrast with `check-extension-api-version-skew.ts`, which needs a base/head diff range — this
    check only needs "all merge commits reachable from HEAD", not a comparison).
  - [ ] 1.4 Parse each subject line with a regex capturing PR number and branch, e.g.
    `/^Merge pull request #(\d+) from [^/]+\/feature\/(.+)$/`. Skip (do not throw on) any merge
    commit whose subject doesn't match this pattern at all, or whose captured slug is empty.
  - [ ] 1.5 Build a `Map<slug, {prNumber, sha}>` keeping the **last** (most recent) match per slug —
    simplest deterministic choice (git log is already chronologically ordered), no comment needed
    beyond a one-liner; do not over-engineer this with configurable first/last selection (Occam's
    Razor: only presence/absence of drift is asserted by AC-2, not which specific commit is cited).
  - [ ] 1.6 Cross-reference against `loadSprintStatuses(rootDir)`: for each slug in the map, look up
    its status; skip (AC-4) if the key is absent; flag if present and not `done`.
  - [ ] 1.7 Export a `PostMergeDrift` type: `{ storyKey: string; status: string; prNumber: number;
    mergeCommitSha: string }`.
  - [ ] 1.8 Let the `git log` call's own exceptions propagate uncaught out of
    `scanPostMergeStatusDrift` (do NOT wrap in a try/catch that swallows to `[]`) — this is what
    makes AC-9's fail-loud behavior happen for free; only the YAML-loading path
    (`loadSprintStatuses`) has its own internal try/catch-to-null, per AC-4.

- [ ] Task 2: Report/CLI entrypoint (AC-9, AC-10)
  - [ ] 2.1 Mirror `check-sprint-status-rollup.ts`'s `report()` function shape and its
    `if (import.meta.url === pathToFileURL(...))` CLI-entrypoint guard exactly.

- [ ] Task 3: Unit tests (AC-1 through AC-4)
  - [ ] 3.1 Create `scripts/check-post-merge-status-drift.test.ts`. Follow
    `check-extension-api-version-skew.test.ts`'s **real temporary git repository** fixture pattern
    (`mkdtempSync` + `git init --initial-branch=main` + `git commit`) — NOT the plain
    `writeFixture`-only pattern from `check-sprint-status-rollup.test.ts`, because this check's
    input (`git log` merge commits) cannot be faked without an actual git history. Combine both:
    use `writeFixture` to write `sprint-status.yaml` content inside the temp git repo, then commit
    it, then create merge commits via real git operations (`git merge --no-ff` or by directly
    crafting a commit with the exact subject line via `git commit --allow-empty -m '<subject>'` —
    prefer the latter, it's simpler and this check only reads commit *subjects*, not actual merged
    diffs).
  - [ ] 3.2 Cover, at minimum: happy path (done status, no drift); the 14.8 incident shape (status
    `review`, drift reported with correct key/PR/sha); AC-2 dedup (two merge commits, same slug,
    one drift entry); AC-3 non-`feature/` branch ignored; AC-4 untracked slug skipped; AC-4's
    corrupted/missing `sprint-status.yaml` → `[]`, no throw.
  - [ ] 3.3 Add a final "against the real repository" smoke test mirroring
    `check-sprint-status-rollup.test.ts`'s closing block — but note this one may legitimately need
    to tolerate the real repo's actual current state rather than asserting `[]` unconditionally: if
    scanning this repo's own `main` history at implementation time surfaces a *genuine* pre-existing
    drift, that is real, actionable information — do not silence it by weakening the test's
    assertion. Investigate any such finding before assuming the test is wrong.

- [ ] Task 4: `package.json` + GitHub Actions wiring (AC-5, AC-6, AC-7)
  - [ ] 4.1 Add the `check-post-merge-status-drift` script entry to `package.json` (AC-7).
  - [ ] 4.2 Create `.github/workflows/post-merge-status-drift.yml`: `on: push: branches: [main]`,
    `permissions: contents: read`, single job checking out with `fetch-depth: 0` (with the AC-5
    explanatory comment), Node 24 + pnpm 11.9.0 setup matching this repo's other workflows exactly
    (see `nightly.yml` for the canonical setup-node/setup-pnpm/cache block to copy), install deps,
    run `pnpm check-post-merge-status-drift`, then a `notify-failure` job needing the drift-check
    job with `if: failure()`, copying `nightly.yml`'s `notify-failure` job body verbatim (same
    `SLACK_WEBHOOK_URL` env/if guard, same payload text adapted to name this workflow).
  - [ ] 4.3 Deliberately do **not** touch `Makefile`'s `ci` target or `.github/workflows/ci.yml`
    (AC-6) — confirm this by re-reading the diff before committing.

- [ ] Task 5: Verify against this repo's real history
  - [ ] 5.1 Run `pnpm check-post-merge-status-drift` locally against this actual checked-out `main`
    and confirm it reports "OK" (or investigate and report any genuine finding — see 3.3).

- [ ] Task 6: Enforce merge-commit-only strategy (AC-8 — critical, found via pre-mortem elicitation)
  - [ ] 6.1 Disable squash merge and rebase merge on this repository (GitHub Settings → General →
    Pull Requests, or `gh api -X PATCH repos/<owner>/<repo> -f allow_squash_merge=false -f
    allow_rebase_merge=false` if the implementer has admin rights via `gh`). Leave "Allow merge
    commits" enabled — it already is.
  - [ ] 6.2 If the implementing agent/session lacks repository admin permissions to make this
    change, do NOT skip it silently — call it out explicitly in the final report/PR description as
    a required manual follow-up, and treat AC-8 as incomplete until confirmed done.

## Dev Notes

- **Why no runtime `fetch-depth` check (AC-5):** there is no reliable, portable way for a `git log`
  invocation to detect "this clone is shallow AND that shallowness caused something to be missed" —
  a shallow clone with `git log` simply returns fewer commits with no error signal distinguishing
  "shallow and truncated" from "genuinely short history." Attempting to call `git rev-parse
  --is-shallow-repository` and fail the job on `true` would be a reasonable **enhancement** but is
  explicitly out of scope for this story (see AC-5's edge case) — do not add it unless asked; it
  adds a new failure mode (a legitimately shallow local dev clone would now fail a check meant only
  to gate `main`) for marginal benefit over the documented-comment approach, given the workflow's
  own `fetch-depth: 0` is the actual enforcement point, not the library function.
- **Reuse, don't duplicate:** `parseDevelopmentStatus`/`loadSprintStatuses` already live in
  `scripts/check-story-status-sync.ts` and are already exported — import them, do not re-implement
  YAML parsing.
- **Branch-name convention is the join key:** this entire mechanism depends on `pick-story`'s
  `feature/<story-slug>` branch naming (`.claude/skills/pick-story/SKILL.md`, B2/C0) staying
  consistent. If that convention ever changes, this script's regex must change with it — there is
  no other coupling to enforce, so no cross-file test is needed beyond this note.
- **No GitHub API, no auth, no rate limits:** re-emphasized from Background — this is 100% local
  git history inspection. Do not introduce `gh` CLI calls, `GITHUB_TOKEN`, or `@octokit` — they are
  unnecessary complexity/attack-surface/rate-limit risk for information already present in the
  merge commit message itself.
- **RLS/tenant isolation, auth/session lifecycle, concurrent access, migration compatibility:** not
  applicable to this story — it is a pure, read-only, DB-free static/git-history scan with no
  application data path, no user session, and no schema/migration involvement. (Documented here
  explicitly, matching this project's convention of noting a category's non-applicability rather
  than silently omitting it — see `product-surface-contract.md`'s own N/A-with-rationale pattern.)
- **Audit behaviour:** the "audit trail" for this check IS its output — every drift report cites the
  specific story key, PR number, and merge commit SHA so the finding is independently verifiable by
  anyone reading the Slack alert or the failed Action's log, without needing to trust the tool.
- **ADR — push-triggered workflow only, not also duplicated into `nightly.yml` (decided during
  elicitation):** Considered three trigger options: (a) `push: branches: [main]` only [chosen],
  (b) nightly cron only, (c) both. Chose (a): a merge to `main` is the exact moment the 14.8-class
  drift becomes possible, so a push trigger catches it within seconds — materially better than the
  nightly cron's up-to-24h latency for the same signal, and this project's whole point in splitting
  1-17 out of 1-16 was faster detection than "the next epic retro stumbles onto it." Rejected (c)
  (both): would double-alert for the same drift on every affected day until fixed, adding noise
  without adding coverage — a push-triggered check has no missed-window gap that a nightly backstop
  would meaningfully close, since GitHub Actions push-trigger reliability is already a documented
  accepted risk this project relies on elsewhere (every other push-triggered check in `ci.yml`).
  Residual risk (a push-trigger silently failing to fire, e.g. platform outage) is accepted and
  already covered by the existing manual-epic-retro safety net this story is designed to
  supplement, not replace.
- **ADR — merge-commit message scan vs. GitHub API (decided during original design, reconfirmed
  during elicitation):** Chosen: parse `git log` merge-commit *messages* for the PR number and
  source branch (zero auth, zero rate limits, works if GitHub is unreachable, testable with plain
  local git operations). Rejected: calling the GitHub API (`gh api` / `@octokit`) to look up each
  PR's head branch or merge state — adds a token/auth dependency, a rate-limit surface, and a
  network dependency for information already present in the merge commit message itself, for no
  detection benefit **once AC-8's merge-commit-only enforcement is in place**. (Before AC-8's
  finding, the API approach looked more necessary since squash-merges hide the branch name in the
  message; enforcing merge-commit-only makes the simpler local-git approach fully sufficient instead
  of a workaround — this is why AC-8 was worth adding rather than reaching for the API fallback.)

### Project Structure Notes

- New file: `scripts/check-post-merge-status-drift.ts` (sibling to `check-story-status-sync.ts` /
  `check-sprint-status-rollup.ts` / `check-extension-api-version-skew.ts`).
- New file: `scripts/check-post-merge-status-drift.test.ts`.
- New file: `.github/workflows/post-merge-status-drift.yml`.
- Modified: `package.json` (new script entry only).
- No changes to `Makefile` or `.github/workflows/ci.yml` (AC-6 explicitly scopes this out of the
  pre-merge gate).
- No conflicts with existing project structure detected — follows the established `scripts/check-*`
  pattern exactly.

### References

- [Source: scripts/check-sprint-status-rollup.ts] — sibling drift-guard, same report()/CLI-entrypoint shape, same `loadSprintStatuses` reuse pattern.
- [Source: scripts/check-story-status-sync.ts] — `parseDevelopmentStatus`/`loadSprintStatuses` to reuse; "skip untracked key" precedent for AC-4.
- [Source: scripts/check-extension-api-version-skew.ts] — `execFileSync` git-wrapper pattern, `git show <ref>:<path>` precedent, NOSONAR comment convention.
- [Source: scripts/check-extension-api-version-skew.test.ts] — real-temp-git-repo test fixture pattern to follow for this story's tests (contrast with the plain-file-fixture pattern used by `check-sprint-status-rollup.test.ts`, which doesn't fit here since this check needs real commit history).
- [Source: scripts/lib/scan-utils.ts, scripts/lib/fixture-test-helpers.ts] — shared test/scan helpers already in use across sibling scripts.
- [Source: .github/workflows/nightly.yml] — canonical setup-node/setup-pnpm/cache block and `notify-failure` Slack job pattern to copy for the new workflow.
- [Source: .github/workflows/ci.yml#Quality Gates] — where `check-story-status-sync`/`check-sprint-status-rollup` are wired into pre-merge `make ci`; this story's check is deliberately NOT added here (AC-6).
- [Source: Makefile] — `ci` target wiring for the two existing sibling checks; not touched by this story.
- [Source: .claude/skills/pick-story/SKILL.md#B2, #C0, #C5, #C6] — `feature/<story-slug>` branch-naming convention this story's regex depends on; confirms `main`'s only inbound path is a merged PR (justifying the `push: branches: [main]` trigger as "post-merge").
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml] — `1-16-sprint-status-drift-ci-guard` entry (full incident narrative for 14.8/epic-14/epic-15/epic-16) and this story's own `1-17-...` entry (scope statement this story implements).
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules (`none` scope, N/A persona journey with rationale).
- Real git history evidence: `git log --oneline -1` on this repo's `main` at story-creation time showed `392e0e4 Merge pull request #253 from nestormata/feature/17-2-share-a-credential-with-an-external-recipient-via-secure-link` — confirms the merge-commit message format this story's regex targets is accurate for this repository today, not a hypothetical.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
