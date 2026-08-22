#!/usr/bin/env tsx
/**
 * Story 1-17 — the "Story 14.8 drift": a story's PR merges to `main`, but the
 * `review` -> `done` flip in sprint-status.yaml was supposed to be a separate, later commit
 * (this project's Path C flow: C1 commits at `review`, C4 flips to `done`, C5 pushes, C6 opens
 * the PR). If that C4 commit is ever skipped or the PR merges before it lands, `main` ends up
 * with a merged, working feature whose tracking entry never says so — invisible to
 * `check-sprint-status-rollup.ts` (only checks epic-N rollups) and to `check-story-status-sync.ts`
 * (only compares the story file's own `Status:` header against sprint-status.yaml — both can agree
 * with each other and still be wrong about whether the PR actually merged).
 *
 * Pure, DB-free, git-history scan: no GitHub API, no auth, no rate limits (see story Background).
 * Depends entirely on this project's `pick-story` branch-naming convention (`feature/<story-slug>`)
 * and on every PR merge to `main` producing a real merge commit (see AC-8 — squash/rebase merges
 * are invisible to this scanner and must be disabled at the repo settings level).
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'

export type PostMergeDrift = {
  storyKey: string
  status: string
  prNumber: number
  mergeCommitSha: string
}

/** Matches `Merge pull request #<N> from <owner>/feature/<slug>` exactly, anchored end-of-string
 * so `feature/1-1-foo` can never partially match a longer sibling slug like `1-11-foobar` (AC-3).
 * Branches that aren't `feature/<slug>` (chore/, fix/, retro/, ...) simply don't match at all. */
const MERGE_SUBJECT_PATTERN = /^Merge pull request #(\d+) from [^/]+\/feature\/(.+)$/

function git(repoRoot: string, args: string[]): string {
  return execFileSync(
    'git', // NOSONAR(typescript:S4036) — trusted binary on this CI/dev host's fixed, unwriteable PATH
    args,
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node's execFileSync default maxBuffer is 1MB — `git log --merges` over this repo's full
      // history (required by AC-5's fetch-depth: 0) will keep growing every time a story PR
      // merges, so the default ceiling would eventually throw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER
      // and crash this check outright rather than reporting drift. 64MB is generous headroom.
      maxBuffer: 64 * 1024 * 1024,
    }
  )
}

/**
 * Enumerates every merge commit reachable from HEAD as `{ sha, subject }`, tab-separated in the
 * underlying `git log` output. Requires full git history (`fetch-depth: 0` in CI, see AC-5) — a
 * shallow clone silently returns fewer commits with no error signal distinguishing "shallow and
 * truncated" from "genuinely short history", so there is no reliable runtime check for this here;
 * the GitHub Actions workflow's checkout step is the actual enforcement point (see Dev Notes).
 *
 * Deliberately NOT wrapped in try/catch — a `git log` failure (not a git repo, git binary missing,
 * corrupted `.git`) must propagate uncaught so the CLI entrypoint fails loud (AC-9), unlike the
 * YAML-loading path (`loadSprintStatuses`), which has its own internal fail-quiet fallback.
 */
export function getMergeCommits(repoRoot: string): Array<{ sha: string; subject: string }> {
  const output = git(repoRoot, [
    'log',
    '--merges',
    '--grep=^Merge pull request #',
    '-E',
    '--format=%H%x09%s',
  ])
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\t')
      return { sha, subject }
    })
}

/**
 * Cross-references merge commits' source-branch story slugs against sprint-status.yaml's
 * development_status block at HEAD, flagging any tracked slug whose status is not yet `done`.
 */
export function scanPostMergeStatusDrift(rootDir = process.cwd()): PostMergeDrift[] {
  const commits = getMergeCommits(rootDir)

  // Build a Map<slug, {prNumber, sha}>, keeping one entry per slug (AC-2 dedup) — simplest
  // deterministic choice; which specific commit ends up cited doesn't matter (AC-2 only asserts
  // presence/absence of a single drift entry per slug, not which duplicate commit is named).
  const bySlug = new Map<string, { prNumber: number; sha: string }>()
  for (const { sha, subject } of commits) {
    const match = MERGE_SUBJECT_PATTERN.exec(subject)
    if (!match) continue
    const prNumber = Number(match[1])
    const slug = match[2] as string
    bySlug.set(slug, { prNumber, sha })
  }

  const statuses = loadSprintStatuses(rootDir)
  if (!statuses) return []

  const drifts: PostMergeDrift[] = []
  for (const [slug, { prNumber, sha }] of bySlug) {
    // Only real story keys (e.g. "20-6-some-slug") are driftable — an epic rollup ("epic-20") or
    // retrospective ("epic-20-retrospective") key can coincidentally share a slug with a
    // non-story-convention branch name like "feature/epic-20" and must never be checked here.
    if (!/^\d+-\d+-/.test(slug)) continue
    const status = statuses.get(slug)
    // Not a tracked story key (renamed, deleted, or never tracked) — skip, not an error (AC-4).
    if (status === undefined) continue
    if (status !== 'done') {
      drifts.push({ storyKey: slug, status, prNumber, mergeCommitSha: sha })
    }
  }

  return drifts.sort((a, b) => a.storyKey.localeCompare(b.storyKey))
}

function report(drifts: PostMergeDrift[]): void {
  if (drifts.length === 0) {
    process.stdout.write(
      'check-post-merge-status-drift: no merged-PR / sprint-status drift found — OK\n'
    )
    return
  }

  process.stderr.write(
    "FATAL: a story's PR merged to main, but sprint-status.yaml never advanced its status to " +
      '"done" (the Story 14.8 drift):\n'
  )
  for (const d of drifts) {
    process.stderr.write(
      `  - ${d.storyKey}: status is "${d.status}", PR #${d.prNumber}, merge commit ` +
        `${d.mergeCommitSha.slice(0, 7)}\n`
    )
  }
  process.stderr.write(
    '\nFix: update sprint-status.yaml so the drifted story key(s) above read "done" (or ' +
      'investigate why the review -> done flip never landed).\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanPostMergeStatusDrift())
}
