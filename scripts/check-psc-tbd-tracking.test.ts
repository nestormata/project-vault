import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { hasPscTbd, isTrackedInDeferredWork, scanPscTbdTracking } from './check-psc-tbd-tracking.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const DEFERRED_WORK_PATH = `${ARTIFACTS_DIR}/deferred-work.md`

const makeFixtureRoot = useFixtureRoots('psc-tbd-tracking-', [ARTIFACTS_DIR])

const BASE_SPRINT_STATUS = `generated: 2026-05-31
last_updated: 2026-07-08
project: Fixture Project

development_status:
  epic-9: in-progress
  9-1-encrypted-backup-and-restore: done
  9-2-system-settings: in-progress
  9-3-api-parity: review
  9-4-platform-audit: ready-for-dev
  epic-9-retrospective: optional
`

const DEFERRED_WORK_WITH_WEB_UI_GAPS = `# Deferred Work

### Web UI gaps — API exists, web incomplete (Epic 2 surface)

| Capability | API story | Web status | Suggested follow-up |
|------------|-----------|------------|---------------------|
| Backup/restore admin | 9.1/9.2 | API-only | **Resolved 2026-07-08 (Epic 9 retro):** scheduled as \`9-7\` |
`

const DEFERRED_WORK_WITHOUT_WEB_UI_GAPS = `# Deferred Work

### Web UI gaps — API exists, web incomplete (Epic 2 surface)

| Capability | API story | Web status | Suggested follow-up |
|------------|-----------|------------|---------------------|
| Some other cap | 2.3 | ... | Web story |
`

// PSC story content helpers
const pscTbdStory = (extra = '') =>
  `# Story Title\n\nStatus: done\n\n## Product Surface Contract\n\n| **Linked UI story** (if API-only) | \`TBD\` — no story exists yet ${extra}|\n`

const pscNaStory = () =>
  `# Story Title\n\nStatus: done\n\n## Product Surface Contract\n\n| **Linked UI story** (if API-only) | N/A — not API-only |\n`

const pscLinkedStory = () =>
  `# Story Title\n\nStatus: done\n\n## Product Surface Contract\n\n| **Linked UI story** (if API-only) | Covered by story 9-7 |\n`

describe('hasPscTbd', () => {
  it('detects a TBD Linked UI story row', () => {
    expect(hasPscTbd(pscTbdStory())).toBe(true)
  })

  it('does not match N/A Linked UI story row', () => {
    expect(hasPscTbd(pscNaStory())).toBe(false)
  })

  it('does not match a row with a real linked story (not TBD)', () => {
    expect(hasPscTbd(pscLinkedStory())).toBe(false)
  })

  it('does not match files with no Product Surface Contract section', () => {
    expect(hasPscTbd('# Story\n\nStatus: done\n\nSome notes\n')).toBe(false)
  })
})

describe('isTrackedInDeferredWork', () => {
  it('returns true when the story is referenced by dot notation (9.1)', () => {
    expect(isTrackedInDeferredWork('9-1-encrypted-backup', DEFERRED_WORK_WITH_WEB_UI_GAPS)).toBe(
      true
    )
  })

  it('returns true when the story is referenced by hyphen notation (9-2)', () => {
    const content = DEFERRED_WORK_WITH_WEB_UI_GAPS.replace('9.1/9.2', '9-1/9-2')
    expect(isTrackedInDeferredWork('9-2-system-settings', content)).toBe(true)
  })

  it('returns false when the story is not in the Web UI gaps section', () => {
    expect(isTrackedInDeferredWork('9-3-api-parity', DEFERRED_WORK_WITHOUT_WEB_UI_GAPS)).toBe(false)
  })

  it('returns true for unusual story keys (no numeric prefix match) — skips gracefully', () => {
    expect(isTrackedInDeferredWork('foo-bar-story', DEFERRED_WORK_WITH_WEB_UI_GAPS)).toBe(true)
  })

  it('does not match the same epic+story number appearing in unrelated prose outside the Web UI gaps section', () => {
    const contentWithProseReference = `# Deferred Work\n\nSee 9.1 for context.\n\n### Web UI gaps\n\n| Some other | 2.3 | ... | Polish |\n`
    expect(isTrackedInDeferredWork('9-1-encrypted-backup', contentWithProseReference)).toBe(false)
  })
})

describe('scanPscTbdTracking', () => {
  it('returns no violations when all TBD stories are tracked in deferred-work.md', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITH_WEB_UI_GAPS)
    writeFixture(root, `${ARTIFACTS_DIR}/9-1-encrypted-backup-and-restore.md`, pscTbdStory())
    writeFixture(root, `${ARTIFACTS_DIR}/9-2-system-settings.md`, pscTbdStory())

    expect(scanPscTbdTracking(root)).toEqual([])
  })

  it('returns violations for active stories with TBD PSC and no deferred-work.md row', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITHOUT_WEB_UI_GAPS)
    writeFixture(root, `${ARTIFACTS_DIR}/9-1-encrypted-backup-and-restore.md`, pscTbdStory())
    writeFixture(root, `${ARTIFACTS_DIR}/9-2-system-settings.md`, pscTbdStory())

    const violations = scanPscTbdTracking(root)
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.storyKey)).toEqual([
      '9-1-encrypted-backup-and-restore',
      '9-2-system-settings',
    ])
  })

  it('skips stories with N/A or resolved Linked UI story PSC entries', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITHOUT_WEB_UI_GAPS)
    writeFixture(root, `${ARTIFACTS_DIR}/9-1-encrypted-backup-and-restore.md`, pscNaStory())
    writeFixture(root, `${ARTIFACTS_DIR}/9-2-system-settings.md`, pscLinkedStory())

    expect(scanPscTbdTracking(root)).toEqual([])
  })

  it('skips stories with status outside active statuses (backlog, optional)', () => {
    const root = makeFixtureRoot()
    const statusWithBacklog = BASE_SPRINT_STATUS.replace(
      '9-1-encrypted-backup-and-restore: done',
      '9-1-encrypted-backup-and-restore: backlog'
    )
    writeFixture(root, SPRINT_STATUS_PATH, statusWithBacklog)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITHOUT_WEB_UI_GAPS)
    writeFixture(root, `${ARTIFACTS_DIR}/9-1-encrypted-backup-and-restore.md`, pscTbdStory())

    expect(scanPscTbdTracking(root)).toEqual([])
  })

  it('ignores adversarial-review files, retro docs, and deferred-work.md itself', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, BASE_SPRINT_STATUS)
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITH_WEB_UI_GAPS)
    // These files have no matching sprint-status.yaml key — should be silently skipped
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/9-1-encrypted-backup-and-restore-adversarial-review.md`,
      pscTbdStory()
    )
    writeFixture(root, `${ARTIFACTS_DIR}/epic-9-retro-2026-07-08.md`, pscTbdStory())
    writeFixture(root, DEFERRED_WORK_PATH, DEFERRED_WORK_WITH_WEB_UI_GAPS)

    expect(scanPscTbdTracking(root)).toEqual([])
  })

  it('returns empty when sprint-status.yaml is missing', () => {
    const root = makeFixtureRoot()
    // No sprint-status.yaml written
    expect(scanPscTbdTracking(root)).toEqual([])
  })
})
