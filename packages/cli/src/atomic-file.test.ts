import * as realFs from 'node:fs'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomicOwnerOnly, type AtomicFs } from './atomic-file.js'

const isWindows = process.platform === 'win32'
const PREFIX = '.test-atomic.'
const VICTIM_CONTENT = 'victim-content'
const FALLBACK_PAYLOAD = 'via-fallback'

let dir: string
let target: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvault-atomic-test-'))
  target = join(dir, 'out.env')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

function fsWith(overrides: Partial<AtomicFs>): AtomicFs {
  return { ...realFs, ...overrides }
}

describe('writeFileAtomicOwnerOnly', () => {
  it('is fully synchronous (returns a non-Promise), so no JS can run mid-write', () => {
    const returned: unknown = writeFileAtomicOwnerOnly(target, 'x', {
      exclusive: true,
      tempPrefix: PREFIX,
    })
    expect(returned).toBeUndefined()
  })

  it.skipIf(isWindows)('writes exactly the data with mode 0600 even when umask is 000', () => {
    const previous = process.umask(0)
    try {
      writeFileAtomicOwnerOnly(target, 'hello\n', { exclusive: true, tempPrefix: PREFIX })
    } finally {
      process.umask(previous)
    }
    expect(readFileSync(target, 'utf8')).toBe('hello\n')
    expect(modeOf(target)).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['out.env'])
  })

  it('exclusive: refuses with EEXIST when the target exists, leaving it untouched and no temp file', () => {
    writeFileSync(target, 'original')
    expect(() =>
      writeFileAtomicOwnerOnly(target, 'new', { exclusive: true, tempPrefix: PREFIX })
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['out.env'])
  })

  it('exclusive: two back-to-back writers to an absent path → exactly one succeeds, file complete', () => {
    const outcomes = ['first', 'second'].map((payload) => {
      try {
        writeFileAtomicOwnerOnly(target, payload, { exclusive: true, tempPrefix: PREFIX })
        return 'ok'
      } catch (error) {
        return (error as NodeJS.ErrnoException).code
      }
    })
    expect(outcomes).toEqual(['ok', 'EEXIST'])
    expect(readFileSync(target, 'utf8')).toBe('first')
  })

  it.skipIf(isWindows)(
    'exclusive: a symlink (live or dangling) at the target counts as existing',
    () => {
      const victim = join(dir, 'victim')
      writeFileSync(victim, VICTIM_CONTENT)
      symlinkSync(victim, target)
      expect(() =>
        writeFileAtomicOwnerOnly(target, 'new', { exclusive: true, tempPrefix: PREFIX })
      ).toThrow(expect.objectContaining({ code: 'EEXIST' }))

      const dangling = join(dir, 'dangling.env')
      symlinkSync(join(dir, 'nowhere'), dangling)
      expect(() =>
        writeFileAtomicOwnerOnly(dangling, 'new', { exclusive: true, tempPrefix: PREFIX })
      ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM_CONTENT)
    }
  )

  it.skipIf(isWindows)(
    'non-exclusive: replaces a symlink itself with a regular 0600 file, never writing through it',
    () => {
      const victim = join(dir, 'victim')
      writeFileSync(victim, VICTIM_CONTENT)
      symlinkSync(victim, target)
      writeFileAtomicOwnerOnly(target, 'new', { exclusive: false, tempPrefix: PREFIX })
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM_CONTENT)
      expect(lstatSync(target).isFile()).toBe(true)
      expect(modeOf(target)).toBe(0o600)
    }
  )

  it.skipIf(isWindows)('non-exclusive: replacing an existing 0644 file yields a 0600 file', () => {
    writeFileSync(target, 'old')
    chmodSync(target, 0o644)
    writeFileAtomicOwnerOnly(target, 'new', { exclusive: false, tempPrefix: PREFIX })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(modeOf(target)).toBe(0o600)
  })

  it.each([
    [
      'ENOSPC on write',
      {
        writeSync: () => {
          throw errno('ENOSPC')
        },
      },
      'ENOSPC',
    ],
    [
      'EACCES on chmod',
      {
        chmodSync: () => {
          throw errno('EACCES')
        },
      },
      'EACCES',
    ],
    [
      'EIO on rename',
      {
        renameSync: () => {
          throw errno('EIO')
        },
      },
      'EIO',
    ],
  ] as Array<[string, Partial<AtomicFs>, string]>)(
    'removes the temp file after a failure (%s) and leaves the directory unchanged',
    (_label, overrides, code) => {
      writeFileSync(join(dir, 'unrelated'), 'x')
      const before = readdirSync(dir).sort()
      expect(() =>
        writeFileAtomicOwnerOnly(
          target,
          'secret',
          { exclusive: false, tempPrefix: PREFIX },
          fsWith(overrides)
        )
      ).toThrow(expect.objectContaining({ code }))
      expect(readdirSync(dir).sort()).toEqual(before)
    }
  )

  it.each(['EPERM', 'ENOTSUP'])(
    'falls back to an exclusive wx create when link() is unsupported (%s)',
    (code) => {
      const fs = fsWith({
        linkSync: () => {
          throw errno(code)
        },
      })
      writeFileAtomicOwnerOnly(
        target,
        FALLBACK_PAYLOAD,
        { exclusive: true, tempPrefix: PREFIX },
        fs
      )
      expect(readFileSync(target, 'utf8')).toBe(FALLBACK_PAYLOAD)
      if (!isWindows) expect(modeOf(target)).toBe(0o600)
      expect(readdirSync(dir)).toEqual(['out.env'])

      // The fallback is still exclusive: a second write refuses.
      expect(() =>
        writeFileAtomicOwnerOnly(target, 'again', { exclusive: true, tempPrefix: PREFIX }, fs)
      ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
      expect(readFileSync(target, 'utf8')).toBe(FALLBACK_PAYLOAD)
      expect(readdirSync(dir)).toEqual(['out.env'])
    }
  )

  it('fallback: a write failure after the exclusive create removes the partial target', () => {
    let writes = 0
    const fs = fsWith({
      linkSync: () => {
        throw errno('EPERM')
      },
      writeSync: ((...args: Parameters<typeof realFs.writeSync>) => {
        writes += 1
        if (writes === 2) throw errno('ENOSPC')
        return (realFs.writeSync as (...a: unknown[]) => number)(...args)
      }) as AtomicFs['writeSync'],
    })
    expect(() =>
      writeFileAtomicOwnerOnly(target, 'x', { exclusive: true, tempPrefix: PREFIX }, fs)
    ).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
    expect(readdirSync(dir)).toEqual([])
  })

  it('rethrows a non-"unsupported" link error without falling back', () => {
    const fs = fsWith({
      linkSync: () => {
        throw errno('EACCES')
      },
    })
    expect(() =>
      writeFileAtomicOwnerOnly(target, 'x', { exclusive: true, tempPrefix: PREFIX }, fs)
    ).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(readdirSync(dir)).toEqual([])
  })

  it("opens the temp file with 'wx' and retries once with a fresh name on EEXIST (A4)", () => {
    const openCalls: Array<[string, string]> = []
    const fs = fsWith({
      openSync: ((path: string, flags: string, mode?: number) => {
        openCalls.push([path, flags])
        if (openCalls.length === 1) throw errno('EEXIST')
        return realFs.openSync(path, flags, mode)
      }) as AtomicFs['openSync'],
    })
    writeFileAtomicOwnerOnly(target, 'x', { exclusive: false, tempPrefix: PREFIX }, fs)
    expect(openCalls).toHaveLength(2)
    expect(openCalls.every(([, flags]) => flags === 'wx')).toBe(true)
    expect(openCalls[0]?.[0]).not.toBe(openCalls[1]?.[0])
    expect(openCalls[0]?.[0]).toMatch(/[/\\]\.test-atomic\.[0-9a-f]+\.tmp$/)
    expect(readFileSync(target, 'utf8')).toBe('x')
  })

  it('gives up after the single temp-name retry', () => {
    const fs = fsWith({
      openSync: (() => {
        throw errno('EEXIST')
      }) as AtomicFs['openSync'],
    })
    expect(() =>
      writeFileAtomicOwnerOnly(target, 'x', { exclusive: false, tempPrefix: PREFIX }, fs)
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
  })
})
