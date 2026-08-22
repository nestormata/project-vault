import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { evaluateFollowupReviewGate, isTrackedInDeferredWork } from './lib/followup-review-gate.js'
import { scanFollowupReviewGate } from './check-followup-review-gate.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const DEFERRED_WORK_PATH = `${ARTIFACTS_DIR}/deferred-work.md`

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeFixtureRoot = useFixtureRoots('followup-review-gate-', [ARTIFACTS_DIR])

const STORY_KEY = '9-1-fixture-story'
const DONE = 'done'
const NOT_APPLICABLE = 'not-applicable'
const EMPTY_DEFERRED_WORK = '# Deferred Work\n'
const FIXTURE_STORY_PATH = `${ARTIFACTS_DIR}/${STORY_KEY}.md`

const BASE_SPRINT_STATUS = `generated: 2026-05-31
last_updated: 2026-07-08
project: Fixture Project

development_status:
  epic-9: in-progress
  9-1-fixture-story: done
  9-2-fixture-story: in-progress
  9-3-fixture-story: review
  9-4-fixture-story: ready-for-dev
  9-5-fixture-story: backlog
  9-10-fixture-story: done
  epic-9-retrospective: optional
`

const DEFERRED_WORK_WITH_ENTRY = `# Deferred Work

### DW-901: Follow-up review still recommended for 9-1-fixture-story after shipping to done with the flag still set

origin: fixture
location: n/a
source_spec: \`9-1-fixture-story.md\`
severity: medium
reason: fixture entry
status: open
`

const DEFERRED_WORK_FOR_OTHER_STORY = `# Deferred Work

### DW-902: Follow-up review still recommended for 9-10-fixture-story after shipping to done with the flag still set

origin: fixture
location: n/a
source_spec: \`9-10-fixture-story.md\`
severity: medium
reason: fixture entry for a DIFFERENT story key that should not satisfy 9-1-fixture-story
status: open
`

const flaggedStorySimple = (extra = '') =>
  `# Story Title\n\nStatus: done\n\nsurface_scope: none\nfollowup_review_recommended: true\n${extra}`

const flaggedStoryYamlBlock = (extra = '') =>
  `---\ntitle: 'Fixture'\nstatus: 'done'\nfollowup_review_recommended: true\n${extra}---\n\n# Story Title\n\nStatus: done\n`

const unflaggedStory = () =>
  `# Story Title\n\nStatus: done\n\nsurface_scope: none\nfollowup_review_recommended: false\n`

const noFlagAtAllStory = () => `# Story Title\n\nStatus: done\n\nsurface_scope: none\n`

describe('evaluateFollowupReviewGate', () => {
  it('scenario 1 — blocks: flag true, status done, no ledger entry, no waiver', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, flaggedStorySimple(), '')).toBe('block')
  })

  it('scenario 2 — passes via ledger: matching source_spec entry in deferred-work.md', () => {
    expect(
      evaluateFollowupReviewGate(STORY_KEY, DONE, flaggedStorySimple(), DEFERRED_WORK_WITH_ENTRY)
    ).toBe('pass')
  })

  it('scenario 3 — passes via waiver: valid followup_review_waiver present, no ledger entry', () => {
    const content = flaggedStorySimple(
      'followup_review_waiver: "Waived by Nestor 2026-08-22 — fixture rationale"\n'
    )
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, content, '')).toBe('pass')
  })

  it('scenario 4 — unaffected without the flag: false value returns not-applicable regardless of ledger/waiver', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, unflaggedStory(), '')).toBe(NOT_APPLICABLE)
  })

  it('scenario 4b — unaffected without the flag: key absent entirely returns not-applicable', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, noFlagAtAllStory(), '')).toBe(NOT_APPLICABLE)
  })

  it('edge — substring near-miss: a ledger entry for a different story key does not satisfy this one', () => {
    expect(
      evaluateFollowupReviewGate(
        STORY_KEY,
        DONE,
        flaggedStorySimple(),
        DEFERRED_WORK_FOR_OTHER_STORY
      )
    ).toBe('block')
  })

  it('edge — non-closing status (in-progress) returns not-applicable even with the flag true', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, 'in-progress', flaggedStorySimple(), '')).toBe(
      NOT_APPLICABLE
    )
  })

  it('edge — non-closing status (review) returns not-applicable even with the flag true', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, 'review', flaggedStorySimple(), '')).toBe(
      NOT_APPLICABLE
    )
  })

  it('edge — malformed/truncated frontmatter does not throw and is treated as flag-absent', () => {
    const truncated = "---\ntitle: 'broken\n  nested: [unterminated\nfollowup_review"
    expect(() => evaluateFollowupReviewGate(STORY_KEY, DONE, truncated, '')).not.toThrow()
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, truncated, '')).toBe(NOT_APPLICABLE)
  })

  it('edge — followup_review_waiver: TBD is treated as no waiver present (still blocks absent a ledger entry)', () => {
    const content = flaggedStorySimple('followup_review_waiver: TBD\n')
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, content, '')).toBe('block')
  })

  it('edge — followup_review_waiver: "" (empty string) is treated as no waiver present', () => {
    const content = flaggedStorySimple('followup_review_waiver: ""\n')
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, content, '')).toBe('block')
  })

  it('edge — dual frontmatter convention: simple Key: value form parses followup_review_recommended', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, flaggedStorySimple(), '')).toBe('block')
  })

  it('edge — dual frontmatter convention: YAML --- block form parses followup_review_recommended', () => {
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, flaggedStoryYamlBlock(), '')).toBe('block')
  })

  it('edge — dual frontmatter convention: YAML --- block form parses a valid waiver', () => {
    const content = flaggedStoryYamlBlock(
      "followup_review_waiver: 'Waived by Nestor 2026-08-22 — fixture rationale'\n"
    )
    expect(evaluateFollowupReviewGate(STORY_KEY, DONE, content, '')).toBe('pass')
  })
})

describe('isTrackedInDeferredWork', () => {
  it('matches on the source_spec field naming the exact story file', () => {
    expect(isTrackedInDeferredWork(STORY_KEY, DEFERRED_WORK_WITH_ENTRY)).toBe(true)
  })

  it('does not match a near-miss story key (9-1 vs 9-10)', () => {
    expect(isTrackedInDeferredWork(STORY_KEY, DEFERRED_WORK_FOR_OTHER_STORY)).toBe(false)
  })

  it('falls back to matching the entry title when source_spec is absent', () => {
    const titleOnly = `# Deferred Work\n\n### DW-903: Follow-up review still recommended for 9-1-fixture-story after shipping to done with the flag still set\n\norigin: fixture\nseverity: medium\nreason: no source_spec field on this one\nstatus: open\n`
    expect(isTrackedInDeferredWork(STORY_KEY, titleOnly)).toBe(true)
  })
})

describe('scanFollowupReviewGate', () => {
  it('reports a violation for a done story with the flag, no ledger entry, no waiver', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(root, FIXTURE_STORY_PATH, flaggedStorySimple())

    const violations = scanFollowupReviewGate(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.storyKey).toBe(STORY_KEY)
  })

  it('passes clean once a matching ledger entry exists', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITH_ENTRY)
    writeFixture(root, FIXTURE_STORY_PATH, flaggedStorySimple())

    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('passes clean via an explicit waiver with no ledger entry', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(
      root,
      FIXTURE_STORY_PATH,
      flaggedStorySimple('followup_review_waiver: "Waived by Nestor 2026-08-22 — fixture"\n')
    )

    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('never reports a story without the flag, regardless of ledger/waiver state', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(root, FIXTURE_STORY_PATH, unflaggedStory())

    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('skips non-closing statuses even with the flag true', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(root, `${ARTIFACTS_DIR}/9-2-fixture-story.md`, flaggedStorySimple())
    writeFixture(root, `${ARTIFACTS_DIR}/9-3-fixture-story.md`, flaggedStorySimple())
    writeFixture(root, `${ARTIFACTS_DIR}/9-4-fixture-story.md`, flaggedStorySimple())
    writeFixture(root, `${ARTIFACTS_DIR}/9-5-fixture-story.md`, flaggedStorySimple())

    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('skips a non-story key (epic/retrospective) even if it somehow had a matching file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(root, `${ARTIFACTS_DIR}/epic-9.md`, flaggedStorySimple())
    writeFixture(root, `${ARTIFACTS_DIR}/epic-9-retrospective.md`, flaggedStorySimple())

    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('fails open (no crash, no violations) when deferred-work.md is missing entirely', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, FIXTURE_STORY_PATH, flaggedStorySimple())

    expect(() => scanFollowupReviewGate(root)).not.toThrow()
    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('returns empty when sprint-status.yaml is missing', () => {
    const root = makeFixtureRoot()
    expect(scanFollowupReviewGate(root)).toEqual([])
  })

  it('AC-7 backfill: the real repository state is clean under the new gate', () => {
    const violations = scanFollowupReviewGate(repositoryRoot)
    const flaggedKeys = violations.map((v) => v.storyKey)
    expect(flaggedKeys).not.toContain('22-1-per-org-audit-storage-quota-and-rate-limiting')
    expect(flaggedKeys).not.toContain('22-2-per-org-audit-write-rate-limiting')
    expect(flaggedKeys).not.toContain('20-5-pv-deliver-the-approved-scoped-sharing-experience')
  })

  it('the CI script exits non-zero and names the blocked story key on a fixture with no coverage', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, EMPTY_DEFERRED_WORK)
    writeFixture(root, FIXTURE_STORY_PATH, flaggedStorySimple())

    const script = resolve(repositoryRoot, 'scripts/check-followup-review-gate.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

    let stderr = ''
    let threw = false
    try {
      execFileSync(process.execPath, ['--import', tsxLoader, script], {
        cwd: root,
        stdio: 'pipe',
      })
    } catch (error) {
      threw = true
      stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    }
    expect(threw).toBe(true)
    expect(stderr).toContain(STORY_KEY)
  })

  it('the CI script exits zero against the real repository state (AC-7)', () => {
    const script = resolve(repositoryRoot, 'scripts/check-followup-review-gate.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, script], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain(
      'check-followup-review-gate: all followup_review_recommended flags on done stories are tracked or waived — OK'
    )
  })
})
