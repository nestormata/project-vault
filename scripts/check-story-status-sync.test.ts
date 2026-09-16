import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanStoryReferences } from './check-story-references.js'
import { useFixtureRoots, writeFixture, writeFixtureSymlink } from './lib/fixture-test-helpers.js'
import { parseDevelopmentStatus, scanStoryStatusSync } from './check-story-status-sync.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const SECOND_STORY_KEY = '1-2-second-story'
const SECOND_STORY_PATH = `${ARTIFACTS_DIR}/${SECOND_STORY_KEY}.md`
const SECOND_STORY_REVIEW_CONTENT = '# Story 1.2\n\nStatus: review\n'

const makeFixtureRoot = useFixtureRoots('story-status-sync-', [ARTIFACTS_DIR])

const SPRINT_STATUS = `generated: 2026-05-31
last_updated: 2026-07-07
project: Fixture Project

development_status:
  # Epic 1: Fixture Epic
  epic-1: in-progress
  1-1-first-story: done
  1-2-second-story: review
  epic-1-retrospective: optional
`

describe('parseDevelopmentStatus', () => {
  it('extracts flat key: value entries from the development_status block only', () => {
    const statuses = parseDevelopmentStatus(SPRINT_STATUS)
    expect(statuses.get('1-1-first-story')).toBe('done')
    expect(statuses.get('1-2-second-story')).toBe('review')
    expect(statuses.get('epic-1')).toBe('in-progress')
    expect(statuses.get('generated')).toBeUndefined()
  })

  it('ignores an inline comment following the value', () => {
    const statuses = parseDevelopmentStatus(
      'development_status:\n  epic-4: done # closed 2026-07-05 — retro debt confirmed resolved\n'
    )
    expect(statuses.get('epic-4')).toBe('done')
  })

  it('does not truncate the block at a column-0 "#" comment interleaved mid-block (Story 55.7 AC-6, mirrors sprint-status.yaml:765)', () => {
    const yaml =
      'development_status:\n' +
      '  epic-25: done\n' +
      '  epic-25-retrospective: done\n' +
      '# last_updated: 2026-08-25 (epic-26/26-1: ...)\n' +
      '  epic-26: done\n' +
      '  26-1-first-story: done\n'

    const statuses = parseDevelopmentStatus(yaml)
    expect(statuses.get('epic-25-retrospective')).toBe('done')
    expect(statuses.get('epic-26')).toBe('done')
    expect(statuses.get('26-1-first-story')).toBe('done')
  })

  it('still terminates the block at a genuinely dedented non-comment key (edge case)', () => {
    const yaml =
      'development_status:\n' +
      '  epic-1: done\n' +
      'another_top_level_key: value\n' +
      '  should-not-be-parsed: done\n'

    const statuses = parseDevelopmentStatus(yaml)
    expect(statuses.get('epic-1')).toBe('done')
    expect(statuses.get('should-not-be-parsed')).toBeUndefined()
  })
})

describe('scanStoryStatusSync', () => {
  it('returns no mismatches when every story file Status: header matches sprint-status.yaml', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story.md`, '# Story 1.1\n\nStatus: done\n')
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags a story file whose Status: header disagrees with sprint-status.yaml (the P6-1/P7-1/P8-1 drift)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)
    // sprint-status.yaml already flipped this one to done, but the story file's header was never synced
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('flags a mismatch even when the Status: line carries trailing prose (Epic 23 retro regression, DW-140)', () => {
    // Established convention: "Status: review — implementation completed ..." / "Status: done
    // (targeted review complete; ...)" — the annotated form, not just the bare word. The prior
    // end-of-line-anchored regex silently produced no match at all for lines like this, hiding
    // real drift (found live on 23-5: a stale `Status: review — ...` header sitting undetected
    // against a `done` sprint-status.yaml entry).
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SECOND_STORY_PATH,
      '# Story 1.2\n\nStatus: review — implementation completed 2026-08-19 after Story 1.1.\n'
    )
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('matches cleanly when an annotated Status: line agrees with sprint-status.yaml', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/1-1-first-story.md`,
      '# Story 1.1\n\nStatus: done (targeted review and quality gate complete; a residual gap remains externally unexercised)\n'
    )
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('ignores files with no matching sprint-status.yaml key (adversarial-review docs, retros, deferred-work.md)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story-adversarial-review.md`, 'Status: review\n')
    writeFixture(root, `${ARTIFACTS_DIR}/epic-1-retro-2026-07-01.md`, 'Status: n/a\n')
    writeFixture(root, `${ARTIFACTS_DIR}/deferred-work.md`, '# Deferred Work\n')

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('returns no mismatches when sprint-status.yaml does not exist', () => {
    const root = makeFixtureRoot()
    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('follows a symlinked story file and checks it like a regular one (Story 55.7 AC-1)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `targets/${SECOND_STORY_KEY}.md`, SECOND_STORY_REVIEW_CONTENT)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, 'targets', `${SECOND_STORY_KEY}.md`))

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags a mismatch in a symlinked story file the same as a plain one (Story 55.7 AC-1)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )
    writeFixture(root, `targets/${SECOND_STORY_KEY}.md`, SECOND_STORY_REVIEW_CONTENT)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, 'targets', `${SECOND_STORY_KEY}.md`))

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('reports a dangling symlink as its own violation kind, distinct from a status mismatch (Story 55.7 AC-2)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, ARTIFACTS_DIR, 'does-not-exist.md'))

    const violations = scanStoryStatusSync(root)
    expect(violations).toEqual([
      {
        file: SECOND_STORY_PATH,
        reason: 'dangling-symlink',
        target: join(root, ARTIFACTS_DIR, 'does-not-exist.md'),
      },
    ])
  })
})

describe('scanStoryStatusSync — named historical-incident regression fixtures (Story 1.13 AC-P2)', () => {
  it('CP4-4 (Epic 4 retro, 2026-07-03): a story file stuck at review while sprint-status.yaml already says done', () => {
    const root = makeFixtureRoot()
    const key = '4-1-team-invitations-and-role-assignment'
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${key}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story 4.1\n\nStatus: review\n`)

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('A6-3 (Epic 6 retro, 2026-07-06): multiple story files simultaneously stuck at review while sprint-status.yaml says done', () => {
    const root = makeFixtureRoot()
    const keys = [
      '6-1-service-certificate-and-domain-record-management',
      '6-2-http-endpoint-monitoring-and-availability-alerts',
      '7-1-machine-user-identity-and-api-key-management',
    ]
    const sprintStatusLines = keys.map((key) => `  ${key}: done`).join('\n')
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n${sprintStatusLines}\n`)
    for (const key of keys) {
      writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story\n\nStatus: review\n`)
    }

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toHaveLength(3)
    for (const key of keys) {
      expect(mismatches).toContainEqual({
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      })
    }
  })

  it('Epic 8 "5th recurrence" (8-7, caught during its own post-implementation code review): a single story file stuck at review while sprint-status.yaml says done', () => {
    const root = makeFixtureRoot()
    const key = '8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt'
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${key}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story 8.7\n\nStatus: review\n`)

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })
})

describe('scanStoryStatusSync against the real repository', () => {
  it('passes with zero mismatches against every story file currently committed', () => {
    expect(scanStoryStatusSync(process.cwd())).toEqual([])
  })
})

describe('Story 55.7 AC-4 — the fixed walker makes both guards actually fail on a seeded violation', () => {
  const AC4_ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
  const AC4_SPRINT_STATUS_PATH = `${AC4_ARTIFACTS_DIR}/sprint-status.yaml`
  const AC4_KEY = '9-1-seeded-symlinked-story'
  const AC4_STORY_PATH = `${AC4_ARTIFACTS_DIR}/${AC4_KEY}.md`
  const AC4_SPRINT_STATUS = 'development_status:\n  9-1-seeded-symlinked-story: done\n'

  const makeAc4FixtureRoot = useFixtureRoots('story-ac4-', [AC4_ARTIFACTS_DIR])

  it('a seeded symlinked story file with a mismatched Status: header and a dangling "Story X.Y" reference fails both guards; the reconciled record passes both', () => {
    const root = makeAc4FixtureRoot()
    writeFixture(root, AC4_SPRINT_STATUS_PATH, AC4_SPRINT_STATUS)
    writeFixture(
      root,
      `targets/${AC4_KEY}.md`,
      '# Story 9.1\n\nStatus: review\n\nDeferred to Story 13.5.\n'
    )
    writeFixtureSymlink(root, AC4_STORY_PATH, join(root, 'targets', `${AC4_KEY}.md`))

    // Seeded: the symlinked file's `Status: review` disagrees with sprint-status.yaml's `done`,
    // and it forward-references a "Story 13.5" that has no sprint-status.yaml entry.
    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: AC4_KEY,
        storyFile: AC4_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
    expect(scanStoryReferences(root)).toEqual([
      {
        storyKey: AC4_KEY,
        storyFile: AC4_STORY_PATH,
        referencedStory: 'Story 13.5',
      },
    ])

    // Reconciled: fix the symlink target's content in place (real symlink still points at the
    // same target — this mirrors how a maintainer would actually reconcile a real symlinked
    // story file: edit the target, not the link).
    writeFixture(root, `targets/${AC4_KEY}.md`, '# Story 9.1\n\nStatus: done\n')

    expect(scanStoryStatusSync(root)).toEqual([])
    expect(scanStoryReferences(root)).toEqual([])
  })
})
