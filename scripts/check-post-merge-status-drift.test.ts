import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import { trustedGit } from './lib/trusted-executable.js'
import {
  formatPostMergeDriftReport,
  getMergeCommits,
  scanPostMergeStatusDrift,
} from './check-post-merge-status-drift.js'

const SPRINT_STATUS_PATH = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const BRANCH_1_1_FOO = 'nestormata/feature/1-1-foo'
const BRANCH_9_3_FOO = 'nestormata/feature/9-3-foo'
const BRANCH_EPIC_20 = 'nestormata/feature/epic-20'
const BRANCH_24_5_ID_ONLY = 'nestormata/feature/24-5'
const BRANCH_24_5B_UPPER = 'nestormata/feature/24-5B-short'
const KEY_24_5_PLAIN = '24-5-plain'
const KEY_24_5B_LETTER = '24-5b-letter'
const STATUS_REVIEW = 'review'
const NO_DRIFT = { drifts: [], ambiguities: [] }
const KEY_12_3_ALPHA = '12-3-alpha'
const KEY_12_3_BETA = '12-3-beta'
const SLUG_12_3_SHORT = '12-3-short'
const KEY_14_8_SOME_STORY = '14-8-some-story'

function git(cwd: string, args: string[]): string {
  return trustedGit(cwd, args).trim()
}

/** Builds a throwaway real git repo with an initial commit, returning its root. */
function makeGitFixtureRepo(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'post-merge-status-drift-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@invalid'])
  git(root, ['config', 'user.name', 'Test'])
  writeFixture(root, 'README.md', 'init\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'initial commit'])
  return { root }
}

function writeSprintStatus(root: string, yaml: string): void {
  writeFixture(root, SPRINT_STATUS_PATH, yaml)
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'update sprint-status.yaml'])
}

/** Crafts a real merge commit (two parents — `git log --merges` only matches those) with the
 * exact subject line GitHub's merge-commit UI produces. Uses a throwaway local branch + `--no-ff`
 * merge so the resulting commit has the right shape without needing a real PR/remote. */
function mergeCommit(root: string, prNumber: number, branch: string): string {
  const localBranch = `pr-${prNumber}`
  git(root, ['checkout', '-b', localBranch])
  writeFixture(root, `pr-${prNumber}.txt`, `content for PR #${prNumber}\n`)
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', `feature commit for PR #${prNumber}`])
  git(root, ['checkout', 'main'])
  git(root, [
    'merge',
    '--no-ff',
    localBranch,
    '-m',
    `Merge pull request #${prNumber} from ${branch}`,
  ])
  git(root, ['branch', '-D', localBranch])
  return git(root, ['rev-parse', 'HEAD'])
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixtureRepo(): { root: string } {
  const fixture = makeGitFixtureRepo()
  tempRoots.push(fixture.root)
  return fixture
}

describe('getMergeCommits', () => {
  it('extracts sha + subject for merge commits only, ignoring regular commits', () => {
    const { root } = makeFixtureRepo()
    writeFixture(root, 'other.txt', 'x\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'not a merge commit'])
    const sha = mergeCommit(root, 100, BRANCH_1_1_FOO)

    const commits = getMergeCommits(root)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toEqual({
      sha,
      subject: `Merge pull request #100 from ${BRANCH_1_1_FOO}`,
    })
  })

  it('propagates the underlying error when not run inside a git repository (AC-9 fail-loud)', () => {
    const root = mkdtempSync(join(tmpdir(), 'post-merge-status-drift-not-git-'))
    tempRoots.push(root)
    expect(() => getMergeCommits(root)).toThrow()
  })
})

// Two-merge fixtures measured about 30s in a full-file run.
describe('scanPostMergeStatusDrift', { timeout: 60_000 }, () => {
  it('AC-1 happy path: merged PR whose story is already done reports no drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  17-2-share-a-credential: done
`
    )
    mergeCommit(root, 253, 'nestormata/feature/17-2-share-a-credential')

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-1 the 14.8 incident shape: merged PR whose story is still "review" reports drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  ${KEY_14_8_SOME_STORY}: review
`
    )
    const sha = mergeCommit(root, 243, `nestormata/feature/${KEY_14_8_SOME_STORY}`)

    expect(scanPostMergeStatusDrift(root)).toEqual({
      drifts: [
        {
          storyKey: KEY_14_8_SOME_STORY,
          status: STATUS_REVIEW,
          prNumber: 243,
          mergeCommitSha: sha,
        },
      ],
      ambiguities: [],
    })
  })

  it('AC-2 dedup: two merge commits for the same slug produce exactly one drift entry', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  9-3-foo: ${STATUS_REVIEW}
`
    )
    mergeCommit(root, 300, BRANCH_9_3_FOO)
    mergeCommit(root, 301, BRANCH_9_3_FOO)

    // AC-2 only asserts a single drift entry per slug — which of the two duplicate merge commits
    // is cited is deliberately unspecified (Task 1.5: "not which specific commit is cited").
    const { drifts, ambiguities } = scanPostMergeStatusDrift(root)
    expect(ambiguities).toEqual([])
    expect(drifts).toHaveLength(1)
    expect(drifts[0]?.storyKey).toBe('9-3-foo')
    expect(drifts[0]?.status).toBe(STATUS_REVIEW)
    expect([300, 301]).toContain(drifts[0]?.prNumber)
  })

  it('AC-2 dedup edge case: two merge commits for the same slug, but status is done -> zero drift entries', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  9-3-foo: done
`
    )
    mergeCommit(root, 300, BRANCH_9_3_FOO)
    mergeCommit(root, 301, BRANCH_9_3_FOO)

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-3 non-feature branches are ignored entirely, even if a matching key exists', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  epic-16-retro: review
`
    )
    mergeCommit(root, 250, 'nestormata/chore/epic-16-retro')

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-3 edge case: an empty slug after feature/ is skipped safely, no throw', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  foo: review
`
    )
    mergeCommit(root, 251, 'nestormata/feature/')

    expect(() => scanPostMergeStatusDrift(root)).not.toThrow()
    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-3 slug-collision safety: feature/1-1-foo never partially matches sibling slug 1-11-foobar', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  1-1-foo: done
  1-11-foobar: review
`
    )
    mergeCommit(root, 260, BRANCH_1_1_FOO)

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-4: a story id with no sprint-status key is skipped, not flagged as drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  2-1-new-slug-name: review
`
    )
    mergeCommit(root, 270, 'nestormata/feature/9-9-no-such-story')

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('maps a shortened branch to the one key that starts with that story id', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  63-4-full-unrun-check-destinations: ${STATUS_REVIEW}
  65-5-full-terminal-share-org-rate-limit: in-progress
`
    )
    const sha63 = mergeCommit(root, 635, 'nestormata/feature/63-4-unrun-check-destinations')
    const sha65 = mergeCommit(root, 603, 'nestormata/feature/65-5-terminal-share-org-rate-limit')

    expect(scanPostMergeStatusDrift(root)).toEqual({
      drifts: [
        {
          storyKey: '63-4-full-unrun-check-destinations',
          status: STATUS_REVIEW,
          prNumber: 635,
          mergeCommitSha: sha63,
        },
        {
          storyKey: '65-5-full-terminal-share-org-rate-limit',
          status: 'in-progress',
          prNumber: 603,
          mergeCommitSha: sha65,
        },
      ],
      ambiguities: [],
    })
  })

  it('does not let a letter-suffixed story id match the id without the letter', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  ${KEY_24_5_PLAIN}: done
  ${KEY_24_5B_LETTER}: ${STATUS_REVIEW}
`
    )
    mergeCommit(root, 240, 'nestormata/feature/24-5-plain-short')
    const sha = mergeCommit(root, 241, 'nestormata/feature/24-5b-letter-short')

    expect(scanPostMergeStatusDrift(root)).toEqual({
      drifts: [
        {
          storyKey: KEY_24_5B_LETTER,
          status: STATUS_REVIEW,
          prNumber: 241,
          mergeCommitSha: sha,
        },
      ],
      ambiguities: [],
    })
  })

  it('fails closed when two keys share a story id, and does not guess a drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  ${KEY_12_3_BETA}: ${STATUS_REVIEW}
  ${KEY_12_3_ALPHA}: done
`
    )
    const sha = mergeCommit(root, 120, `nestormata/feature/${SLUG_12_3_SHORT}`)

    const scan = scanPostMergeStatusDrift(root)
    expect(scan.drifts).toEqual([])
    expect(scan.ambiguities).toEqual([
      {
        branchSlug: SLUG_12_3_SHORT,
        prNumber: 120,
        mergeCommitSha: sha,
        candidateKeys: [KEY_12_3_ALPHA, KEY_12_3_BETA],
      },
    ])
  })

  it('fails closed even when the branch slug equals one of the two keys', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  4-2-exact-name: done
  4-2-other-name: done
`
    )
    mergeCommit(root, 420, 'nestormata/feature/4-2-exact-name')

    const scan = scanPostMergeStatusDrift(root)
    expect(scan.drifts).toEqual([])
    expect(scan.ambiguities[0]?.candidateKeys).toEqual(['4-2-exact-name', '4-2-other-name'])
  })

  it('AC-4 edge case: missing sprint-status.yaml -> returns [] without throwing', () => {
    const { root } = makeFixtureRepo()
    mergeCommit(root, 280, BRANCH_1_1_FOO)

    expect(() => scanPostMergeStatusDrift(root)).not.toThrow()
    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('AC-9: propagates the error when git log itself fails (not a git repository)', () => {
    const root = mkdtempSync(join(tmpdir(), 'post-merge-status-drift-not-git-2-'))
    tempRoots.push(root)
    expect(() => scanPostMergeStatusDrift(root)).toThrow()
  })
})

describe('scanPostMergeStatusDrift skipped slug shapes (story 74-12)', { timeout: 60_000 }, () => {
  it('skips feature/epic-20 even when 20-1-foo is not done', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  20-1-foo: ${STATUS_REVIEW}
`
    )
    mergeCommit(root, 200, BRANCH_EPIC_20)

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })

  it('skips id-only feature/24-5 and uppercase feature/24-5B-short even when 24-5-plain and 24-5b-letter are not done', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  ${KEY_24_5_PLAIN}: ${STATUS_REVIEW}
  ${KEY_24_5B_LETTER}: ${STATUS_REVIEW}
`
    )
    mergeCommit(root, 245, BRANCH_24_5_ID_ONLY)
    mergeCommit(root, 246, BRANCH_24_5B_UPPER)

    expect(scanPostMergeStatusDrift(root)).toEqual(NO_DRIFT)
  })
})

describe('scanPostMergeStatusDrift against the real repository', { timeout: 60_000 }, () => {
  // Task 3.3: this check may legitimately need to tolerate the real repo's actual current state
  // rather than asserting [] unconditionally. The 17-2/PR #253 drift this comment used to pin
  // (sprint-status.yaml + the story file's Status header both stuck on "review" after merge) was
  // investigated and reconciled 2026-07-29 — both now read "done". Asserting `[]` here is not
  // weakening the check: it reflects the real repo's actual current (drift-free) state, same as
  // the 1-17 story's own guidance to update this test once the underlying drift is genuinely
  // resolved.
  it('reports no drift against the real repository (17-2/PR #253 reconciled)', () => {
    expect(scanPostMergeStatusDrift(process.cwd())).toEqual(NO_DRIFT)
  })
})

describe('formatPostMergeDriftReport', () => {
  it('names every candidate key when a story id is ambiguous and exits non-zero', () => {
    const report = formatPostMergeDriftReport({
      drifts: [],
      ambiguities: [
        {
          branchSlug: SLUG_12_3_SHORT,
          prNumber: 12,
          mergeCommitSha: 'abcdef1234567890',
          candidateKeys: [KEY_12_3_ALPHA, KEY_12_3_BETA],
        },
      ],
    })

    expect(report.exitCode).toBe(1)
    expect(report.stdout).toBe('')
    expect(report.stderr).toContain(KEY_12_3_ALPHA)
    expect(report.stderr).toContain(KEY_12_3_BETA)
    expect(report.stderr).toContain(SLUG_12_3_SHORT)
  })

  it('prints the drift FATAL for a drift-only report and does not mention ambiguity', () => {
    const mergeCommitSha = 'abcdef1234567890'
    const shortSha = mergeCommitSha.slice(0, 7)
    const report = formatPostMergeDriftReport({
      drifts: [
        {
          storyKey: KEY_14_8_SOME_STORY,
          status: STATUS_REVIEW,
          prNumber: 243,
          mergeCommitSha,
        },
      ],
      ambiguities: [],
    })

    expect(report.exitCode).toBe(1)
    expect(report.stdout).toBe('')
    expect(report.stderr).toContain(KEY_14_8_SOME_STORY)
    expect(report.stderr).toContain(STATUS_REVIEW)
    expect(report.stderr).toContain('243')
    expect(report.stderr).toContain(shortSha)
    expect(report.stderr).not.toContain(mergeCommitSha)
    expect(report.stderr).not.toContain('refusing to guess')
  })
})
