import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture, writeFixtureSymlink } from './fixture-test-helpers.js'
import { walkFiles } from './scan-utils.js'

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
