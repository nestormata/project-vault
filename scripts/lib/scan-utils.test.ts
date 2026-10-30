import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { useFixtureRoots, writeFixture, writeFixtureSymlink } from './fixture-test-helpers.js'
import {
  runOverlayGuards,
  detectOverlayInput,
  formatLineRefs,
  inspectOverlayInput,
  overlayReadFailure,
  overlayShapeFailure,
  overlaySkipMessage,
  walkFiles,
} from './scan-utils.js'

const SPRINT_STATUS_REL = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const ROOT_DIR = 'root'
const SPRINT_STATUS_BODY = 'development_status:\n'

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
  const REL = SPRINT_STATUS_REL

  it('is "present" for a readable regular file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, SPRINT_STATUS_BODY)
    expect(detectOverlayInput(root, REL)).toBe('present')
    expect(overlaySkipMessage('check-x', root, REL)).toBeUndefined()
  })

  it('is "present" for a symlink whose target resolves', () => {
    const root = makeFixtureRoot()
    writeFixture(root, 'private/sprint-status.yaml', SPRINT_STATUS_BODY)
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

describe('overlayReadFailure (code review: a present-but-unreadable input is FATAL, never a false OK)', () => {
  const REL = SPRINT_STATUS_REL

  it('is undefined for a readable regular file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, SPRINT_STATUS_BODY)
    expect(overlayReadFailure('check-x', root, REL)).toBeUndefined()
  })

  it('is a FATAL line naming the restore command when the file is 0 bytes (66-19 AC-4)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, '')
    const failure = overlayReadFailure('check-x', root, REL)
    expect(failure).toContain(`FATAL: check-x: ${REL} is empty (0 bytes)`)
    expect(failure).toContain(`git show HEAD:${REL}`)
    expect(failure).toContain('nothing was checked')
  })

  it('is a FATAL line when the input is a directory', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, REL), { recursive: true })
    expect(overlayReadFailure('check-x', root, REL)).toMatch(
      new RegExp(`^FATAL: check-x: ${REL} cannot be read \\(not a regular file\\)`)
    )
  })

  it.skipIf(process.getuid?.() === 0)(
    'does not classify an unsearchable parent directory as "absent" (EACCES is not a skip)',
    () => {
      const root = makeFixtureRoot()
      writeFixture(root, REL, SPRINT_STATUS_BODY)
      const parent = join(root, '_bmad-output/implementation-artifacts')
      chmodSync(parent, 0o000)
      try {
        expect(detectOverlayInput(root, REL)).toBe('present')
        expect(overlayReadFailure('check-x', root, REL)).toContain('FATAL: check-x:')
      } finally {
        chmodSync(parent, 0o755)
      }
    }
  )
})

describe('overlayShapeFailure (66-19 AC-4 content-shape sentinel)', () => {
  const REL = SPRINT_STATUS_REL
  const SENTINEL = { pattern: /^development_status:/m, expected: 'a `development_status:` line' }

  it('is undefined when the sentinel is present', () => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, 'last_updated: x\ndevelopment_status:\n  1-1-a: done\n')
    expect(overlayShapeFailure('check-x', root, REL, SENTINEL)).toBeUndefined()
  })

  it.each([
    ['whitespace only', '\n'],
    ['partial wipe', 'last_updated: x\n'],
  ])('is a FATAL "looks truncated" line for %s', (_name, content) => {
    const root = makeFixtureRoot()
    writeFixture(root, REL, content)
    const failure = overlayShapeFailure('check-x', root, REL, SENTINEL)
    expect(failure).toContain(`FATAL: check-x: ${REL} looks truncated`)
    expect(failure).toContain('a `development_status:` line')
    expect(failure).toContain(`git show HEAD:${REL}`)
  })
})

describe('formatLineRefs (Story 43.11)', () => {
  it('joins 1, 2 and 3+ line numbers', () => {
    expect(formatLineRefs([3])).toBe(':3')
    expect(formatLineRefs([3, 7])).toBe(':3 and :7')
    expect(formatLineRefs([3, 7, 19])).toBe(':3, :7 and :19')
  })
})

describe('runOverlayGuards (Story 63.4)', () => {
  const makeRoot = useFixtureRoots('scan-utils-guards-', [])

  function capture(root: string, inputs: { relPath: string }[]) {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const run = vi.fn()
    try {
      runOverlayGuards('check-x', root, inputs, run)
      return { run, out: write.mock.calls.map((c) => String(c[0])).join('') }
    } finally {
      write.mockRestore()
    }
  }

  it('runs the guard only when every input is readable', () => {
    const root = makeRoot()
    writeFixture(root, 'a.txt', 'a')
    writeFixture(root, 'b.txt', 'b')
    expect(capture(root, [{ relPath: 'a.txt' }, { relPath: 'b.txt' }]).run).toHaveBeenCalledOnce()
  })

  it('reports SKIPPED for the first absent input and never runs the guard', () => {
    const root = makeRoot()
    writeFixture(root, 'a.txt', 'a')
    const { run, out } = capture(root, [{ relPath: 'a.txt' }, { relPath: 'b.txt' }])
    expect(run).not.toHaveBeenCalled()
    expect(out).toBe(
      'check-x: SKIPPED — b.txt not found (private overlay not attached); nothing checked\n'
    )
  })
})
