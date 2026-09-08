import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanImplementationArtifactsSymlinks } from './check-implementation-artifacts-symlinks.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const FIRST_STORY_PATH = `${ARTIFACTS_DIR}/1-1-first-story.md`
const FIRST_STORY_CONTENT = '# Story 1.1\n'
const SECOND_STORY_PATH = `${ARTIFACTS_DIR}/1-2-second-story.md`
const STRAY_COPY_CONTENT = '# Story 1.2 (stray copy)\n'
const NOT_A_SYMLINK = 'not-a-symlink'

const makeFixtureRoot = useFixtureRoots('implementation-artifacts-symlinks-', [ARTIFACTS_DIR])

/**
 * Creates a real file under a shared `targets/` directory and a symlink to it under
 * implementation-artifacts, using the SAME filename on both sides — mirroring the real
 * project-vault-private convention exactly, which matters for the missing-symlink check: it
 * anchors off the parent directory of a resolved symlink target and compares filenames across the
 * two directories, so a mismatched-name fixture would produce false "missing symlink" violations.
 */
function writeRealSymlink(root: string, relativeLinkPath: string, targetContent: string): void {
  const name = relativeLinkPath.split('/').pop() as string
  const targetPath = join(root, 'targets', name)
  writeFixture(root, `targets/${name}`, targetContent)
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
    writeRealSymlink(root, SECOND_STORY_PATH, '# Story 1.2\n')

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })

  it('flags a plain regular file (not a symlink) that is not on the allow-list', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeFixture(root, SECOND_STORY_PATH, STRAY_COPY_CONTENT)

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([
      {
        file: SECOND_STORY_PATH,
        reason: NOT_A_SYMLINK,
      },
    ])
  })

  it('flags a dangling symlink (a symlink whose target does not exist), reporting its target', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeDanglingSymlink(root, SECOND_STORY_PATH, '/nonexistent/path/1-2-second-story.md')

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([
      {
        file: SECOND_STORY_PATH,
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
      { file: `${ARTIFACTS_DIR}/2-2-second-story.md`, reason: NOT_A_SYMLINK },
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

  it('flags a file that exists in the canonical directory but has no local symlink at all', () => {
    // DW-160 residual gap #1 (Epic 38 retro, 2026-09-08): a symlink that was never created, as
    // opposed to being replaced by a stray plain file. Anchored off 1-1's own valid canonical
    // symlink, which points into a directory standing in for project-vault-private here.
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    writeFixture(root, 'targets/1-2-second-story.md', '# Story 1.2\n')

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([{ file: SECOND_STORY_PATH, reason: 'missing-symlink' }])
  })

  it('does not flag a subdirectory in the canonical directory as a missing symlink', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    // A subdirectory of the canonical dir (e.g. a private-only working folder) is not itself a
    // story file this guard tracks.
    writeFixture(root, 'targets/some-subdir/nested.md', '# nested\n')

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })

  it('fails open on the missing-symlink check when no valid local symlink exists to anchor from', () => {
    // An entirely stray/dangling local directory has nothing to resolve the canonical directory
    // from — the missing-symlink check must not guess or hard-fail, it simply doesn't run.
    const root = makeFixtureRoot()
    writeFixture(root, SECOND_STORY_PATH, STRAY_COPY_CONTENT)

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([{ file: SECOND_STORY_PATH, reason: NOT_A_SYMLINK }])
  })

  it('does not flag a file that exists in the canonical directory but is on the allow-list locally', () => {
    // An ALLOWED_NON_SYMLINK_FILES entry is intentionally local-only and would never exist in the
    // canonical directory in the first place, but the anchor-selection step must still skip
    // allow-listed names when looking for a symlink to anchor from.
    const root = makeFixtureRoot()
    writeFixture(root, `${ARTIFACTS_DIR}/epic-9-context.md`, '# Epic 9 context cache\n')
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)

    expect(scanImplementationArtifactsSymlinks(root)).toEqual([])
  })

  it('does not re-flag a file already reported as a stray plain file or dangling symlink', () => {
    const root = makeFixtureRoot()
    writeRealSymlink(root, FIRST_STORY_PATH, FIRST_STORY_CONTENT)
    // A file present locally as a stray plain file also exists (by construction) in the
    // canonical dir once mirrored there — but since it already has a local entry, it must not
    // additionally be reported as missing-symlink.
    writeFixture(root, SECOND_STORY_PATH, STRAY_COPY_CONTENT)
    writeFixture(root, 'targets/1-2-second-story.md', '# Story 1.2 (canonical)\n')

    const violations = scanImplementationArtifactsSymlinks(root)
    expect(violations).toEqual([{ file: SECOND_STORY_PATH, reason: NOT_A_SYMLINK }])
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
