import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import { getMergeCommits, scanPostMergeStatusDrift } from './check-post-merge-status-drift.js'

const SPRINT_STATUS_PATH = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const BRANCH_1_1_FOO = 'nestormata/feature/1-1-foo'
const BRANCH_9_3_FOO = 'nestormata/feature/9-3-foo'
const STATUS_REVIEW = 'review'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** Builds a throwaway real git repo with an initial commit, returning its root. */
function makeGitFixtureRepo(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'post-merge-status-drift-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
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

describe('scanPostMergeStatusDrift', () => {
  it('AC-1 happy path: merged PR whose story is already done reports no drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  17-2-share-a-credential: done
`
    )
    mergeCommit(root, 253, 'nestormata/feature/17-2-share-a-credential')

    expect(scanPostMergeStatusDrift(root)).toEqual([])
  })

  it('AC-1 the 14.8 incident shape: merged PR whose story is still "review" reports drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  14-8-some-story: review
`
    )
    const sha = mergeCommit(root, 243, 'nestormata/feature/14-8-some-story')

    expect(scanPostMergeStatusDrift(root)).toEqual([
      { storyKey: '14-8-some-story', status: STATUS_REVIEW, prNumber: 243, mergeCommitSha: sha },
    ])
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
    const drifts = scanPostMergeStatusDrift(root)
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

    expect(scanPostMergeStatusDrift(root)).toEqual([])
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

    expect(scanPostMergeStatusDrift(root)).toEqual([])
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
    expect(scanPostMergeStatusDrift(root)).toEqual([])
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

    expect(scanPostMergeStatusDrift(root)).toEqual([])
  })

  it('AC-4: a slug not present as a tracked key is skipped silently, not flagged as drift', () => {
    const { root } = makeFixtureRepo()
    writeSprintStatus(
      root,
      `development_status:
  2-1-new-slug-name: review
`
    )
    mergeCommit(root, 270, 'nestormata/feature/2-1-old-slug-name')

    expect(scanPostMergeStatusDrift(root)).toEqual([])
  })

  it('AC-4 edge case: missing sprint-status.yaml -> returns [] without throwing', () => {
    const { root } = makeFixtureRepo()
    mergeCommit(root, 280, BRANCH_1_1_FOO)

    expect(() => scanPostMergeStatusDrift(root)).not.toThrow()
    expect(scanPostMergeStatusDrift(root)).toEqual([])
  })

  it('AC-9: propagates the error when git log itself fails (not a git repository)', () => {
    const root = mkdtempSync(join(tmpdir(), 'post-merge-status-drift-not-git-2-'))
    tempRoots.push(root)
    expect(() => scanPostMergeStatusDrift(root)).toThrow()
  })
})

describe('scanPostMergeStatusDrift against the real repository', () => {
  // Task 3.3: this check may legitimately need to tolerate the real repo's actual current state
  // rather than asserting [] unconditionally. The 17-2/PR #253 drift this comment used to pin
  // (sprint-status.yaml + the story file's Status header both stuck on "review" after merge) was
  // investigated and reconciled 2026-07-29 — both now read "done". Asserting `[]` here is not
  // weakening the check: it reflects the real repo's actual current (drift-free) state, same as
  // the 1-17 story's own guidance to update this test once the underlying drift is genuinely
  // resolved.
  it('reports no drift against the real repository (17-2/PR #253 reconciled)', () => {
    const drifts = scanPostMergeStatusDrift(process.cwd())
    expect(drifts).toEqual([])
  })
})
