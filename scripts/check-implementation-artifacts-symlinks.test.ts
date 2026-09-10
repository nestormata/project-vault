import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanImplementationArtifactsSymlinks } from './check-implementation-artifacts-symlinks.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const FIRST_STORY_PATH = `${ARTIFACTS_DIR}/1-1-first-story.md`
const FIRST_STORY_CONTENT = '# Story 1.1\n'

const makeFixtureRoot = useFixtureRoots('implementation-artifacts-symlinks-', [ARTIFACTS_DIR])

/** Creates a real file elsewhere in the fixture root and a symlink to it under implementation-artifacts. */
function writeRealSymlink(root: string, relativeLinkPath: string, targetContent: string): void {
  const targetPath = join(root, 'targets', `${relativeLinkPath.split('/').pop()}.target`)
  writeFixture(root, `targets/${relativeLinkPath.split('/').pop()}.target`, targetContent)
  symlinkSync(targetPath, join(root, relativeLinkPath))
}

/** Creates a symlink under implementation-artifacts pointing at a path that does not exist. */
function writeDanglingSymlink(
  root: string,
  relativeLinkPath: string,
  missingTargetPath: string
): void {
  symlinkSync(missingTargetPath, join(root, relativeLinkPath))
}

describe('scanImplementationArtifactsSymlinks', () => {
  it('returns no violations when every file is a real (non-dangling) symlink', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeRealSymlink(root, `${ARTIFACTS_DIR}/1-2-second-story.md`, '# Story 1.2\n')

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })

  it('flags a plain regular file (not a symlink) that is not on the allow-list', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeFixture(root, `${ARTIFACTS_DIR}/1-2-second-story.md`, '# Story 1.2 (stray copy)\n')

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([
      {
        file: `${ARTIFACTS_DIR}/1-2-second-story.md`,
        reason: 'not-a-symlink',
      },
    ])
  })

  it('flags a dangling symlink (a symlink whose target does not exist), reporting its target', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeDanglingSymlink(
      root,
      `${ARTIFACTS_DIR}/1-2-second-story.md`,
      '/nonexistent/path/1-2-second-story.md'
    )

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([
      {
        file: `${ARTIFACTS_DIR}/1-2-second-story.md`,
        reason: 'dangling-symlink',
        target: '/nonexistent/path/1-2-second-story.md',
      },
    ])
  })

  it('reports multiple violations together, sorted by file path', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${ARTIFACTS_DIR}/2-2-second-story.md`, '# Story 2.2 (stray)\n')
    writeDanglingSymlink(root, FIRST_STORY_PATH, '/nonexistent/1-1.md')

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([
      { file: FIRST_STORY_PATH, reason: 'dangling-symlink', target: '/nonexistent/1-1.md' },
      { file: `${ARTIFACTS_DIR}/2-2-second-story.md`, reason: 'not-a-symlink' },
    ])
  })

  it('does not flag a file whose name is on the documented allow-list', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    // epic-9-context.md is a real allow-listed cache filename (compile-epic-context output for a
    // fully `done` epic) — see the ALLOWED_NON_SYMLINK_FILES constant in the script under test.
    writeFixture(root, `${ARTIFACTS_DIR}/epic-9-context.md`, '# Epic 9 context cache\n')

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })

  it('returns no violations when implementation-artifacts does not exist', () => {
    expect(scanImplementationArtifactsSymlinks(join(makeFixtureRoot(), 'does-not-exist'))).toEqual(
      []
    )
  })

  it('skips the file-level scan entirely when _bmad-output itself is a symlink (CI attach mode)', () => {
    // In CI, story-integrity-guards.yml attaches project-vault-private's whole _bmad-output
    // directory as a single symlink (`ln -s .../project-vault-private/_bmad-output
    // project-vault/_bmad-output`). Every file reached through that one directory symlink is a
    // real, plain file when lstat'd (only the final path component's own type matters — an
    // intermediate symlinked ancestor is transparently followed by the OS), so a naive per-file
    // scan would flag every legitimate story file as "not a symlink" and make this guard
    // permanently red in real CI. When the whole tree is attached this way, it is canonical by
    // construction (it *is* project-vault-private's real tree) and there is nothing to check —
    // this mirrors check-followup-review-gate.ts's/check-psc-tbd-tracking.ts's existing
    // fail-open-when-inapplicable convention.
    const root = makeFixtureRoot()
    const realBmadOutputDir = join(root, 'real-bmad-output')
    writeFixture(
      root,
      `real-bmad-output/implementation-artifacts/${FIRST_STORY_PATH.split('/').pop()}`,
      FIRST_STORY_CONTENT
    )

    // Replace the pre-created real `_bmad-output` dir (from useFixtureRoots) with a symlink to a
    // separate real directory, reproducing the CI attach shape.
    rmSync(join(root, '_bmad-output'), { recursive: true, force: true })
    symlinkSync(realBmadOutputDir, join(root, '_bmad-output'))

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })
})
