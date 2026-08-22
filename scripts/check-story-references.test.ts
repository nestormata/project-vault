import { describe, expect, it } from 'vitest'
import { findDanglingStoryReferences, scanStoryReferences } from './check-story-references.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const STORY_13_5_REFERENCE = 'Story 13.5'

const makeFixtureRoot = useFixtureRoots('story-references-', [ARTIFACTS_DIR])

const SPRINT_STATUS = `development_status:
  epic-13: done
  13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates: done
  13-5-rotation-same-value-and-dependency-scoping: done
  epic-13-retrospective: done
`

describe('findDanglingStoryReferences', () => {
  it('flags a "Story X.Y" mention with no matching sprint-status.yaml key', () => {
    const keys = new Set(['13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates'])
    const dangling = findDanglingStoryReferences(
      'This limitation will be addressed in Story 13.5.',
      keys
    )
    expect(dangling).toEqual([STORY_13_5_REFERENCE])
  })

  it('does not flag a reference that resolves to a real story key', () => {
    const keys = new Set(['13-5-rotation-same-value-and-dependency-scoping'])
    const dangling = findDanglingStoryReferences('See Story 13.5 for the confirm gate.', keys)
    expect(dangling).toEqual([])
  })

  it('deduplicates repeated mentions of the same dangling reference', () => {
    const dangling = findDanglingStoryReferences(
      'Deferred to Story 13.5. See also Story 13.5 above.',
      new Set()
    )
    expect(dangling).toEqual([STORY_13_5_REFERENCE])
  })

  it('ignores content with no "Story X.Y" pattern', () => {
    expect(findDanglingStoryReferences('No forward references here.', new Set())).toEqual([])
  })
})

describe('scanStoryReferences', () => {
  it('returns no findings when every "Story X.Y" reference resolves to a real key', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates.md`,
      '# Story 13.2\n\nSee Story 13.5 for the follow-up confirm gate.\n'
    )

    expect(scanStoryReferences(root)).toEqual([])
  })

  it('P13-2 (Epic 13 retro Finding 2): flags a phantom forward reference to a story that was never created', () => {
    const root = makeFixtureRoot()
    const key = '13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates'
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      'development_status:\n  13-2-store-and-edit-a-secret-with-multiple-named-fields-via-templates: done\n'
    )
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/${key}.md`,
      '# Story 13.2\n\nSame-value detection is warn-only; a blocking gate is deferred to Story 13.5.\n' +
        'See Story 13.5 for details.\n'
    )

    expect(scanStoryReferences(root)).toEqual([
      {
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        referencedStory: STORY_13_5_REFERENCE,
      },
    ])
  })

  it('ignores non-story files (retros, adversarial reviews, deferred-work.md) even if they mention a nonexistent story number', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/epic-13-retro-2026-07-27.md`,
      'Scheduling Story 13.5 to close this finding.\n'
    )

    expect(scanStoryReferences(root)).toEqual([])
  })

  it('returns no findings when sprint-status.yaml does not exist', () => {
    const root = makeFixtureRoot()
    expect(scanStoryReferences(root)).toEqual([])
  })
})

describe('scanStoryReferences against the real repository', () => {
  it('passes with zero dangling references against every story file currently committed', () => {
    expect(scanStoryReferences(process.cwd())).toEqual([])
  })
})
