import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { parseDevelopmentStatus, scanStoryStatusSync } from './check-story-status-sync.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const SECOND_STORY_KEY = '1-2-second-story'
const SECOND_STORY_PATH = `${ARTIFACTS_DIR}/${SECOND_STORY_KEY}.md`

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
})

describe('scanStoryStatusSync', () => {
  it('returns no mismatches when every story file Status: header matches sprint-status.yaml', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story.md`, '# Story 1.1\n\nStatus: done\n')
    writeFixture(root, SECOND_STORY_PATH, '# Story 1.2\n\nStatus: review\n')

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags a story file whose Status: header disagrees with sprint-status.yaml (the P6-1/P7-1/P8-1 drift)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SECOND_STORY_PATH, '# Story 1.2\n\nStatus: review\n')
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
})

describe('scanStoryStatusSync against the real repository', () => {
  it('passes with zero mismatches against every story file currently committed', () => {
    expect(scanStoryStatusSync(process.cwd())).toEqual([])
  })
})
