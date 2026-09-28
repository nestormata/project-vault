import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture, writeFixtureSymlink } from './fixture-test-helpers.js'
import { STORIES_DIR, resolveStoryFile } from './story-files.js'

const makeFixtureRoot = useFixtureRoots('story-files-', [STORIES_DIR])

describe('resolveStoryFile (Story 43.12 Task 3.1, extracted from check-followup-review-gate)', () => {
  it('prefers <key>.md, then falls back to spec-<key>.md', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${STORIES_DIR}/1-2-x.md`, 'plain')
    writeFixture(root, `${STORIES_DIR}/spec-1-2-x.md`, 'spec')
    writeFixture(root, `${STORIES_DIR}/spec-9-9-y.md`, 'spec only')
    expect(resolveStoryFile(root, '1-2-x')?.content).toBe('plain')
    expect(resolveStoryFile(root, '9-9-y')).toMatchObject({
      path: `${root}/${STORIES_DIR}/spec-9-9-y.md`,
      content: 'spec only',
    })
  })

  it('returns undefined for a missing file and for a dangling symlink, without throwing', () => {
    const root = makeFixtureRoot()
    writeFixtureSymlink(root, `${STORIES_DIR}/3-4-z.md`, '/nonexistent/3-4-z.md')
    expect(resolveStoryFile(root, '1-1-missing')).toBeUndefined()
    expect(resolveStoryFile(root, '3-4-z')).toBeUndefined()
  })
})
