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
import { trustedGit } from './lib/trusted-executable.js'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'

export type PostMergeDrift = {
  storyKey: string
  status: string
  prNumber: number
  mergeCommitSha: string
}

export type PostMergePrefixAmbiguity = {
  branchSlug: string
  prNumber: number
  mergeCommitSha: string
  candidateKeys: string[]
}

export type PostMergeDriftScan = {
  drifts: PostMergeDrift[]
  ambiguities: PostMergePrefixAmbiguity[]
}

export type PostMergeDriftReport = {
  stdout: string
  stderr: string
  exitCode: number
}

/** Matches `Merge pull request #<N> from <owner>/feature/<slug>` exactly, anchored end-of-string.
 * The slug is non-whitespace (`\S+`), so characters after it on the same line do not match.
 * Branches that aren't `feature/<slug>` (chore/, fix/, retro/, ...) simply don't match at all.
 * The story id inside the slug is `<digits>-<digits>` plus one optional trailing letter
 * (`24-5b`). The id is followed by a hyphen, so `1-1-foo` cannot match `1-11-foobar` and
 * `24-5-...` cannot match `24-5b-...`. */
const MERGE_SUBJECT_PATTERN = /^Merge pull request #(\d+) from [^/]+\/feature\/(\S+)$/
const STORY_ID_PREFIX = /^(\d+-\d+[a-z]?)-/
const OK_LINE = 'check-post-merge-status-drift: no merged-PR / sprint-status drift found — OK\n'

// `git log --merges` over the full history (AC-5's fetch-depth: 0) keeps growing with every
// merged story PR, which is why trustedGit() raises the child-process maxBuffer to 64MB.
const git = trustedGit

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

function storyIdPrefix(slug: string): string | null {
  return STORY_ID_PREFIX.exec(slug)?.[1] ?? null
}

function byText(left: string, right: string): number {
  return left.localeCompare(right)
}

function keysWithStoryId(prefix: string, statuses: Map<string, string>): string[] {
  const needle = `${prefix}-`
  return [...statuses.keys()].filter((key) => key.startsWith(needle)).toSorted(byText)
}

type ClassifiedSlug =
  | { kind: 'skip' }
  | { kind: 'drift'; storyKey: string; status: string }
  | { kind: 'ambiguous'; candidateKeys: string[] }

/** A shortened `feature/<id>-<tail>` branch is the story whose key starts with `<id>-`
 * when exactly one key does. No key: skip. Two or more: fail closed, do not guess. */
function classifySlug(slug: string, statuses: Map<string, string>): ClassifiedSlug {
  const prefix = storyIdPrefix(slug)
  if (prefix === null) return { kind: 'skip' }
  const candidateKeys = keysWithStoryId(prefix, statuses)
  if (candidateKeys.length === 0) return { kind: 'skip' }
  if (candidateKeys.length > 1) return { kind: 'ambiguous', candidateKeys }
  const storyKey = candidateKeys[0]
  if (storyKey === undefined) return { kind: 'skip' }
  const status = statuses.get(storyKey)
  if (status === undefined || status === 'done') return { kind: 'skip' }
  return { kind: 'drift', storyKey, status }
}

/**
 * Cross-references merge commits' source-branch story ids against sprint-status.yaml's
 * development_status block at HEAD. A merged feature branch flags its story when that
 * story is not yet `done`. One entry per story key (which duplicate merge is cited is
 * unspecified). An id that matches two keys is an ambiguity, not a guessed drift.
 */
export function scanPostMergeStatusDrift(rootDir = process.cwd()): PostMergeDriftScan {
  const commits = getMergeCommits(rootDir)
  const statuses = loadSprintStatuses(rootDir)
  if (!statuses) return { drifts: [], ambiguities: [] }

  const byStory = new Map<string, { status: string; prNumber: number; sha: string }>()
  const ambiguities: PostMergePrefixAmbiguity[] = []
  const seenPrefix = new Set<string>()

  for (const { sha, subject } of commits) {
    const match = MERGE_SUBJECT_PATTERN.exec(subject)
    if (!match) continue
    const slug = match[2] ?? ''
    const classified = classifySlug(slug, statuses)
    if (classified.kind === 'skip') continue
    const prNumber = Number(match[1])
    if (classified.kind === 'ambiguous') {
      const prefix = storyIdPrefix(slug)
      if (prefix !== null && !seenPrefix.has(prefix)) {
        seenPrefix.add(prefix)
        ambiguities.push({
          branchSlug: slug,
          prNumber,
          mergeCommitSha: sha,
          candidateKeys: classified.candidateKeys,
        })
      }
      continue
    }
    byStory.set(classified.storyKey, { status: classified.status, prNumber, sha })
  }

  const drifts = [...byStory.entries()].map(([storyKey, entry]) => ({
    storyKey,
    status: entry.status,
    prNumber: entry.prNumber,
    mergeCommitSha: entry.sha,
  }))

  return {
    drifts: drifts.toSorted((left, right) => byText(left.storyKey, right.storyKey)),
    ambiguities: ambiguities.toSorted((left, right) => byText(left.branchSlug, right.branchSlug)),
  }
}

export function formatPostMergeDriftReport(scan: PostMergeDriftScan): PostMergeDriftReport {
  if (scan.drifts.length === 0 && scan.ambiguities.length === 0) {
    return { stdout: OK_LINE, stderr: '', exitCode: 0 }
  }

  let stderr = ''
  if (scan.drifts.length > 0) {
    stderr +=
      "FATAL: a story's PR merged to main, but sprint-status.yaml never advanced its status to " +
      '"done" (the Story 14.8 drift):\n'
    for (const drift of scan.drifts) {
      stderr +=
        `  - ${drift.storyKey}: status is "${drift.status}", PR #${drift.prNumber}, merge commit ` +
        `${drift.mergeCommitSha.slice(0, 7)}\n`
    }
    stderr +=
      '\nFix: update sprint-status.yaml so the drifted story key(s) above read "done" (or ' +
      'investigate why the review -> done flip never landed).\n'
  }
  if (scan.ambiguities.length > 0) {
    stderr += 'FATAL: a merged feature branch matches more than one story key; refusing to guess:\n'
    for (const ambiguity of scan.ambiguities) {
      stderr +=
        `  - ${ambiguity.branchSlug}: PR #${ambiguity.prNumber}, merge commit ` +
        `${ambiguity.mergeCommitSha.slice(0, 7)}, candidate keys: ${ambiguity.candidateKeys.join(', ')}\n`
    }
    stderr += '\nFix: make exactly one sprint-status key start with that story id, then re-run.\n'
  }
  return { stdout: '', stderr, exitCode: 1 }
}

function report(scan: PostMergeDriftScan): void {
  const formatted = formatPostMergeDriftReport(scan)
  if (formatted.stdout.length > 0) process.stdout.write(formatted.stdout)
  if (formatted.stderr.length > 0) process.stderr.write(formatted.stderr)
  if (formatted.exitCode !== 0) process.exitCode = formatted.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanPostMergeStatusDrift())
}
