import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots } from './fixture-test-helpers.js'
import { appendToFile, computeEdit, safeEditFile, withFileLock } from './safe-edit.js'

const makeFixtureRoot = useFixtureRoots('safe-edit-', [])

const MID_EDIT_ERROR = 'assertion fired mid-edit'
const ORIGINAL = 'line one\nline two\nline three\nline four\n'

function fixtureFile(content = ORIGINAL): { dir: string; path: string } {
  const dir = makeFixtureRoot()
  const path = join(dir, 'ledger.md')
  writeFileSync(path, content)
  return { dir, path }
}

describe('computeEdit', () => {
  it('returns the edited content when it is non-empty and does not shrink too much', () => {
    expect(computeEdit(ORIGINAL, (c) => c.replace('two', 'TWO'))).toBe(
      'line one\nline TWO\nline three\nline four\n'
    )
  })

  it('refuses an empty result and a whitespace-only result', () => {
    expect(() => computeEdit(ORIGINAL, () => '')).toThrow(/empty/)
    expect(() => computeEdit(ORIGINAL, () => '\n \n')).toThrow(/empty/)
  })

  it('refuses a result that shrinks the file by more than the ratio, and allows a larger ratio explicitly', () => {
    const shrink = () => 'line one\n'
    expect(() => computeEdit(ORIGINAL, shrink)).toThrow(/shrinks/)
    expect(computeEdit(ORIGINAL, shrink, { maxShrinkRatio: 0.9 })).toBe('line one\n')
  })

  it('propagates an error thrown by the edit callback', () => {
    expect(() =>
      computeEdit(ORIGINAL, () => {
        throw new Error(MID_EDIT_ERROR)
      })
    ).toThrow(MID_EDIT_ERROR)
  })
})

describe('safeEditFile', () => {
  it('replaces one line, leaves every other byte identical and leaves no temp file', () => {
    const { dir, path } = fixtureFile()
    safeEditFile(path, (c) => c.replace('line two', 'line 2'))
    expect(readFileSync(path, 'utf-8')).toBe('line one\nline 2\nline three\nline four\n')
    expect(readdirSync(dir)).toEqual(['ledger.md'])
  })

  it('preserves the file mode', () => {
    const { path } = fixtureFile()
    chmodSync(path, 0o640)
    safeEditFile(path, (c) => c.replace('two', 'TWO'))
    expect(statSync(path).mode & 0o777).toBe(0o640)
  })

  it('historical shape 1: an assertion thrown inside the edit callback leaves the original byte-identical', () => {
    const { dir, path } = fixtureFile()
    expect(() =>
      safeEditFile(path, (c) => {
        if (c.includes('line two')) throw new Error(MID_EDIT_ERROR)
        return c
      })
    ).toThrow(MID_EDIT_ERROR)
    expect(readFileSync(path, 'utf-8')).toBe(ORIGINAL)
    expect(readdirSync(dir)).toEqual(['ledger.md'])
  })

  it('historical shape 2: an empty result is refused and the original survives', () => {
    const { path } = fixtureFile()
    expect(() => safeEditFile(path, () => '')).toThrow(/empty/)
    expect(readFileSync(path, 'utf-8')).toBe(ORIGINAL)
  })

  it('refuses an over-shrinking edit and leaves the file untouched', () => {
    const { path } = fixtureFile()
    expect(() => safeEditFile(path, () => 'x\n')).toThrow(/shrinks/)
    expect(readFileSync(path, 'utf-8')).toBe(ORIGINAL)
  })

  it('detects a concurrent write between read and rename, re-reads and retries once', () => {
    const { path } = fixtureFile()
    let calls = 0
    safeEditFile(path, (c) => {
      calls += 1
      if (calls === 1) writeFileSync(path, `${ORIGINAL}other session line\n`)
      return c.replace('line two', 'line 2')
    })
    expect(calls).toBe(2)
    expect(readFileSync(path, 'utf-8')).toBe(
      'line one\nline 2\nline three\nline four\nother session line\n'
    )
  })

  it('fails with an error naming the path when the file keeps changing, leaving the concurrent content', () => {
    const { dir, path } = fixtureFile()
    let calls = 0
    expect(() =>
      safeEditFile(path, (c) => {
        calls += 1
        writeFileSync(path, `${ORIGINAL}writer ${calls}\n`)
        return c.replace('two', 'TWO')
      })
    ).toThrow(`changed by another writer during the edit (retried once): ${path}`)
    expect(calls).toBe(2)
    expect(readFileSync(path, 'utf-8')).toBe(`${ORIGINAL}writer 2\n`)
    expect(readdirSync(dir)).toEqual(['ledger.md'])
  })

  it('edits the symlink target and keeps the symlink', () => {
    const dir = makeFixtureRoot()
    mkdirSync(join(dir, 'real'))
    const target = join(dir, 'real', 'ledger.md')
    const link = join(dir, 'link.md')
    writeFileSync(target, ORIGINAL)
    symlinkSync(target, link)
    safeEditFile(link, (c) => c.replace('two', 'TWO'))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf-8')).toContain('line TWO')
    expect(readdirSync(join(dir, 'real'))).toEqual(['ledger.md'])
  })

  it.skipIf(process.getuid?.() === 0)(
    'fails before leaving a temp file when the file is read-only',
    () => {
      const { dir, path } = fixtureFile()
      chmodSync(path, 0o444)
      expect(() => safeEditFile(path, (c) => c.replace('two', 'TWO'))).toThrow(/not writable/)
      expect(readdirSync(dir)).toEqual(['ledger.md'])
      expect(readFileSync(path, 'utf-8')).toBe(ORIGINAL)
    }
  )

  it('fails on a missing file without creating it', () => {
    const dir = makeFixtureRoot()
    const path = join(dir, 'nope.md')
    expect(() => safeEditFile(path, (c) => c)).toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

describe('appendToFile', () => {
  it('appends text in one write, preserving the existing bytes', () => {
    const { path } = fixtureFile()
    appendToFile(path, 'appended\n')
    expect(readFileSync(path, 'utf-8')).toBe(`${ORIGINAL}appended\n`)
  })

  it('refuses to create a missing file', () => {
    const dir = makeFixtureRoot()
    const path = join(dir, 'nope.md')
    expect(() => appendToFile(path, 'x')).toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('appends through a symlink without replacing it', () => {
    const dir = makeFixtureRoot()
    const target = join(dir, 'real.md')
    const link = join(dir, 'link.md')
    writeFileSync(target, ORIGINAL)
    symlinkSync(target, link)
    appendToFile(link, 'more\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe(`${ORIGINAL}more\n`)
  })
})

describe('withFileLock', () => {
  const NOW = new Date('2026-10-11T12:00:00.000Z')
  const lockIn = (dir: string) => join(dir, 'ledger.md.lock')

  it('runs fn with the lock held (pid + ISO time inside) and removes the lock afterwards', () => {
    const dir = makeFixtureRoot()
    const lock = lockIn(dir)
    const result = withFileLock(
      lock,
      () => {
        const [pid, iso] = readFileSync(lock, 'utf-8').trim().split(' ')
        expect(pid).toBe(String(process.pid))
        expect(iso).toBe(NOW.toISOString())
        return 'done'
      },
      { now: () => NOW }
    )
    expect(result).toBe('done')
    expect(existsSync(lock)).toBe(false)
  })

  it('releases the lock when fn throws', () => {
    const dir = makeFixtureRoot()
    expect(() =>
      withFileLock(lockIn(dir), () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(existsSync(lockIn(dir))).toBe(false)
  })

  it('excludes: a fresh lock held by someone else makes acquisition time out (fail closed) and is left alone', () => {
    const dir = makeFixtureRoot()
    const lock = lockIn(dir)
    writeFileSync(lock, `4242 ${NOW.toISOString()}\n`)
    let ran = false
    expect(() =>
      withFileLock(
        lock,
        () => {
          ran = true
        },
        { now: () => NOW, timeoutMs: 0, pollMs: 1 }
      )
    ).toThrow(/could not acquire/)
    expect(ran).toBe(false)
    expect(readFileSync(lock, 'utf-8')).toContain('4242')
  })

  it('takes over a lock older than 30 s (by embedded time) with a stderr WARN', () => {
    const dir = makeFixtureRoot()
    const lock = lockIn(dir)
    const old = new Date(NOW.getTime() - 31_000)
    writeFileSync(lock, `4242 ${old.toISOString()}\n`)
    const warnings: string[] = []
    const result = withFileLock(lock, () => 'ok', {
      now: () => NOW,
      warn: (message) => warnings.push(message),
    })
    expect(result).toBe('ok')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/stale lock/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not take over a lock that is 29 s old', () => {
    const dir = makeFixtureRoot()
    const lock = lockIn(dir)
    writeFileSync(lock, `4242 ${new Date(NOW.getTime() - 29_000).toISOString()}\n`)
    expect(() =>
      withFileLock(lock, () => 'x', { now: () => NOW, timeoutMs: 0, pollMs: 1 })
    ).toThrow(/could not acquire/)
  })

  it('does not treat a lock with unparsable content as stale', () => {
    const dir = makeFixtureRoot()
    const lock = lockIn(dir)
    writeFileSync(lock, '')
    expect(() =>
      withFileLock(lock, () => 'x', { now: () => NOW, timeoutMs: 0, pollMs: 1 })
    ).toThrow(/could not acquire/)
  })
})
