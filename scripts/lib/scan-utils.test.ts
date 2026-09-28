import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture, writeFixtureSymlink } from './fixture-test-helpers.js'
import {
  detectOverlayInput,
  formatLineRefs,
  inspectOverlayInput,
  overlaySkipMessage,
  walkFiles,
} from './scan-utils.js'

const ROOT_DIR = 'root'

const makeFixtureRoot = useFixtureRoots('scan-utils-', [ROOT_DIR])

describe('walkFiles', () => {
  it('finds a plain regular file matching the predicate (existing behavior)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${ROOT_DIR}/a.md`, 'content')

    const found = walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))

    expect(found).toEqual([join(root, ROOT_DIR, 'a.md')])
  })

  it('follows a symlinked file and scans the target it resolves to (Story 55.7 AC-1)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${ROOT_DIR}/target/real.md`, 'content')
    writeFixtureSymlink(root, `${ROOT_DIR}/linked.md`, join(root, ROOT_DIR, 'target', 'real.md'))

    const found = walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))

    expect(found).toContain(join(root, ROOT_DIR, 'linked.md'))
  })

  it('recurses into a symlinked directory as if it were a real subdirectory (edge case)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${ROOT_DIR}/real-dir/inside.md`, 'content')
    writeFixtureSymlink(root, `${ROOT_DIR}/linked-dir`, join(root, ROOT_DIR, 'real-dir'))

    const found = walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))

    expect(found).toContain(join(root, ROOT_DIR, 'linked-dir', 'inside.md'))
  })

  it('reports a dangling symlink via the onDanglingSymlink callback instead of silently skipping it (AC-2)', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, ROOT_DIR), { recursive: true })
    writeFixtureSymlink(root, `${ROOT_DIR}/dangling.md`, join(root, ROOT_DIR, 'does-not-exist.md'))

    const reported: string[] = []
    const found = walkFiles(
      join(root, ROOT_DIR),
      (path) => path.endsWith('.md'),
      (path) => reported.push(path)
    )

    expect(found).toEqual([])
    expect(reported).toEqual([join(root, ROOT_DIR, 'dangling.md')])
  })

  it('does not report a dangling symlink when no onDanglingSymlink callback is passed (default no-op)', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, ROOT_DIR), { recursive: true })
    writeFixtureSymlink(root, `${ROOT_DIR}/dangling.md`, join(root, ROOT_DIR, 'does-not-exist.md'))

    expect(() => walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))).not.toThrow()
    expect(walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))).toEqual([])
  })

  it('does not hang or crash on a symlink cycle (a -> b -> a), reporting it as dangling', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, ROOT_DIR), { recursive: true })
    symlinkSync(join(root, ROOT_DIR, 'b.md'), join(root, ROOT_DIR, 'a.md'))
    symlinkSync(join(root, ROOT_DIR, 'a.md'), join(root, ROOT_DIR, 'b.md'))

    const reported: string[] = []
    const found = walkFiles(
      join(root, ROOT_DIR),
      (path) => path.endsWith('.md'),
      (path) => reported.push(path)
    )

    expect(found).toEqual([])
    expect(reported.sort()).toEqual(
      [join(root, ROOT_DIR, 'a.md'), join(root, ROOT_DIR, 'b.md')].sort()
    )
  })

  it('returns no files for a directory that does not exist (existing behavior)', () => {
    const root = makeFixtureRoot()
    expect(walkFiles(join(root, ROOT_DIR, 'missing'), () => true)).toEqual([])
  })

  it('does not recurse into a node_modules directory (regression guard: following symlinks per AC-1 must not blow up pnpm-style symlink farms inside node_modules for the existing apps/packages-scanning callers)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, `${ROOT_DIR}/src/real.md`, 'content')
    writeFixture(root, `${ROOT_DIR}/node_modules/some-pkg/inside.md`, 'content')

    const found = walkFiles(join(root, ROOT_DIR), (path) => path.endsWith('.md'))

    expect(found).toEqual([join(root, ROOT_DIR, 'src', 'real.md')])
  })
})

describe('detectOverlayInput (Story 43.11 AC-7.4)', () => {
  const REL = '_bmad-output/implementation-artifacts/sprint-status.yaml'

  it('is "present" for a readable regular file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, 'development_status:\n')
    expect(detectOverlayInput(root, REL)).toBe('present')
    expect(overlaySkipMessage('check-x', root, REL)).toBeUndefined()
  })

  it('is "present" for a symlink whose target resolves', () => {
    const root = makeFixtureRoot()
    writeFixture(root, 'private/sprint-status.yaml', 'development_status:\n')
    writeFixtureSymlink(root, REL, join(root, 'private/sprint-status.yaml'))
    expect(detectOverlayInput(root, REL)).toBe('present')
  })

  it('is "absent" when the file or its parent directory is missing', () => {
    const root = makeFixtureRoot()
    expect(detectOverlayInput(root, REL)).toBe('absent')
    mkdirSync(join(root, '_bmad-output/implementation-artifacts'), { recursive: true })
    expect(detectOverlayInput(root, REL)).toBe('absent')
    expect(overlaySkipMessage('check-x', root, REL)).toBe(
      `check-x: SKIPPED — ${REL} not found (private overlay not attached); nothing checked\n`
    )
  })

  it('is "dangling" for a file symlink whose target is missing (the pre-AC-11 make ci container case)', () => {
    const root = makeFixtureRoot()
    writeFixtureSymlink(root, REL, '/nonexistent/project-vault-private/sprint-status.yaml')
    expect(detectOverlayInput(root, REL)).toBe('dangling')
    expect(inspectOverlayInput(root, REL)).toEqual({
      state: 'dangling',
      target: '/nonexistent/project-vault-private/sprint-status.yaml',
    })
    const message = overlaySkipMessage('check-x', root, REL) ?? ''
    expect(message).toContain('check-x: SKIPPED')
    expect(message).toContain(
      '(dangling overlay symlink -> /nonexistent/project-vault-private/sprint-status.yaml)'
    )
    expect(message).not.toContain('OK')
  })

  it('is "dangling" when a parent directory is a dangling symlink (directory-attach layout)', () => {
    const root = makeFixtureRoot()
    symlinkSync('/nonexistent/project-vault-private/_bmad-output', join(root, '_bmad-output'))
    expect(inspectOverlayInput(root, REL)).toEqual({
      state: 'dangling',
      target: '/nonexistent/project-vault-private/_bmad-output',
    })
  })
})

describe('formatLineRefs (Story 43.11)', () => {
  it('joins 1, 2 and 3+ line numbers', () => {
    expect(formatLineRefs([3])).toBe(':3')
    expect(formatLineRefs([3, 7])).toBe(':3 and :7')
    expect(formatLineRefs([3, 7, 19])).toBe(':3, :7 and :19')
  })
})
