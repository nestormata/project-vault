import * as realFs from 'node:fs'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
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
import { VaultAgentError } from '@project-vault/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtomicFs } from './atomic-file.js'
import { ENV_FILE_HEADER } from './env-file-format.js'
import { EXIT_CODES } from './exit-codes.js'
import type { InjectEntry } from './fetch-secrets.js'
import { writeEnvFile, type WriteEnvFileDeps } from './write-env-file.js'

const isWindows = process.platform === 'win32'

let dir: string
let stderr: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvault-write-env-test-'))
  stderr = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const entry = (credentialName: string, envVarName = credentialName): InjectEntry => ({
  credentialName,
  envVarName,
})

function deps(
  values: Record<string, string>,
  extra: Partial<Omit<WriteEnvFileDeps, 'getSecret'>> = {}
) {
  const getSecret = vi.fn(async (name: string) => {
    const value = values[name]
    if (value === undefined) throw new VaultAgentError('credential_not_found', 'not found')
    return value
  })
  return {
    getSecret,
    writeStderr: (chunk: string) => void stderr.push(chunk),
    cwd: dir,
    checkGitIgnored: vi.fn(async () => 'unknown' as const),
    ...extra,
  }
}

const DOTENV = { format: 'dotenv', force: false } as const

describe('writeEnvFile — AC-1 success', () => {
  it('writes only the scoped secrets, in flag order, with the header, mode 0600, relative path resolved against cwd', async () => {
    const d = deps({ DATABASE_URL: 'postgres://u:p@h/db', 'stripe-key': 'sk_live_1' })
    const result = await writeEnvFile(
      [entry('DATABASE_URL'), entry('stripe-key', 'STRIPE_KEY')],
      '.env',
      DOTENV,
      d
    )
    const path = join(dir, '.env')
    expect(result).toEqual({ ok: true, exitCode: 0, path, count: 2, servedFromCacheCount: 0 })
    expect(readFileSync(path, 'utf8')).toBe(
      `${ENV_FILE_HEADER}DATABASE_URL='postgres://u:p@h/db'\nSTRIPE_KEY='sk_live_1'\n`
    )
    if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['.env'])
    expect(stderr).toEqual([])
  })

  it('writes the shell format when asked', async () => {
    const result = await writeEnvFile(
      [entry('K')],
      'out.sh',
      { format: 'shell', force: false },
      deps({ K: "it's" })
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, 'out.sh'), 'utf8')).toBe(
      `${ENV_FILE_HEADER}export K='it'\\''s'\n`
    )
    expect(stderr).toEqual([])
  })

  it("tags every fetch with the 'write-env' audit invocation context (Story 43.5 AC-8)", async () => {
    const d = deps({ A: 'a', B: 'b' })
    await writeEnvFile([entry('A'), entry('B')], '.env', DOTENV, d)
    expect(d.getSecret.mock.calls).toEqual([
      ['A', { invocation: 'write-env' }],
      ['B', { invocation: 'write-env' }],
    ])
  })

  it('the same credential under two targets is fetched twice and both keys are written', async () => {
    const d = deps({ A: 'v' })
    const result = await writeEnvFile([entry('A', 'X'), entry('A', 'Y')], '.env', DOTENV, d)
    expect(result.ok && result.count).toBe(2)
    expect(d.getSecret).toHaveBeenCalledTimes(2)
  })

  it('carries the offline-cache count into the result', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const d = deps({})
    d.getSecret.mockImplementation(async () => {
      await globalThis.fetch('http://x.invalid').catch(() => undefined)
      return 'stale'
    })
    const result = await writeEnvFile([entry('A')], '.env', DOTENV, d)
    expect(result.ok && result.servedFromCacheCount).toBe(1)
    expect(stderr.join('')).toContain("warning: 'A' served from offline cache")
  })
})

describe('writeEnvFile — AC-1 fail-closed', () => {
  it('B fails → nothing written, existing target untouched, C never fetched, exit 3, no A value in the error', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'ORIGINAL')
    const d = deps({ A: 'A-SECRET-VALUE', C: 'c' })
    const result = await writeEnvFile(
      [entry('A'), entry('B'), entry('C')],
      '.env',
      { format: 'dotenv', force: true },
      d
    )
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.credentialNotFound,
      error: "Credential 'B' was not found in this project.",
    })
    expect(d.getSecret.mock.calls.map(([n]) => n)).toEqual(['A', 'B'])
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['.env'])
  })

  it.each([
    ['reserved target', [entry('x', 'NODE_OPTIONS')], /^Refusing to write reserved/],
    ['duplicate target', [entry('a', 'FOO'), entry('b', 'foo')], /^Duplicate environment/],
    // Code review 43-5: a non-CLI caller (AC-7) skips parseRunSecrets' identifier check. An
    // invalid name must be refused up front, not after every secret was revealed and audited.
    [
      'invalid identifier target (non-CLI caller)',
      [entry('x', 'OK'), entry('a', 'BAD\nNODE_OPTIONS')],
      /^Invalid environment variable name 'BADNODE_OPTIONS'/, // control chars sanitized
    ],
    ['empty target', [entry('x', '')], /^Invalid environment variable name ''/],
  ])('%s → exit 1 before any network call (AC-6)', async (_l, entries, message) => {
    const d = deps({ x: 'v', a: 'v', b: 'v' })
    const result = await writeEnvFile(entries, '.env', DOTENV, d)
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.usageError,
      error: expect.stringMatching(message),
    })
    expect(d.getSecret).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('writeEnvFile — AC-3 pre-flight (before any network call)', () => {
  it('existing target without --force → 25, byte-for-byte unchanged, nothing fetched, no git check', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'ORIGINAL')
    const d = deps({ A: 'v' })
    const result = await writeEnvFile([entry('A')], path, DOTENV, d)
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.outputExists,
      error: `'${path}' already exists; pass --force to overwrite`,
    })
    expect(d.getSecret).not.toHaveBeenCalled()
    expect(d.checkGitIgnored).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('ORIGINAL')
  })

  it.skipIf(isWindows)(
    'a live or dangling symlink at the target counts as existing without --force',
    async () => {
      symlinkSync(join(dir, 'victim'), join(dir, 'dangling'))
      const result = await writeEnvFile([entry('A')], 'dangling', DOTENV, deps({ A: 'v' }))
      expect(result.exitCode).toBe(EXIT_CODES.outputExists)
    }
  )

  it.skipIf(isWindows)(
    '--force replaces the symlink itself (0600 regular file), never the link target',
    async () => {
      const victim = join(dir, 'victim')
      writeFileSync(victim, 'VICTIM')
      symlinkSync(victim, join(dir, '.env'))
      const result = await writeEnvFile(
        [entry('A')],
        '.env',
        { format: 'dotenv', force: true },
        deps({ A: 'v' })
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(victim, 'utf8')).toBe('VICTIM')
      expect(lstatSync(join(dir, '.env')).isFile()).toBe(true)
      expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(isWindows)('--force over an existing 0644 file yields a 0600 file', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'old')
    chmodSync(path, 0o644)
    const result = await writeEnvFile(
      [entry('A')],
      '.env',
      { format: 'dotenv', force: true },
      deps({ A: 'v' })
    )
    expect(result.ok).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['parent directory missing', 'no-such-dir/.env', /parent directory does not exist/],
    ['target is an existing directory', 'sub', /is a directory/],
    ['trailing slash', 'fresh/', /is a directory/],
    ['"."', '.', /is a directory/],
    ['".."', '..', /is a directory/],
    ['a path component is a file', 'afile/.env', /parent directory does not exist/],
  ])('%s → 26 even with --force, nothing fetched', async (_l, target, message) => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'afile'), 'x')
    const d = deps({ A: 'v' })
    const result = await writeEnvFile([entry('A')], target, { format: 'dotenv', force: true }, d)
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.outputPathInvalid,
      error: expect.stringMatching(message),
    })
    expect(d.getSecret).not.toHaveBeenCalled()
  })

  it.skipIf(isWindows)(
    'a non-regular target (character device) → 26 even with --force',
    async () => {
      const d = deps({ A: 'v' })
      const result = await writeEnvFile(
        [entry('A')],
        '/dev/null',
        { format: 'dotenv', force: true },
        d
      )
      expect(result).toEqual({
        ok: false,
        exitCode: EXIT_CODES.outputPathInvalid,
        error: expect.stringContaining('is not a regular file'),
      })
      expect(d.getSecret).not.toHaveBeenCalled()
    }
  )

  it('sanitizes control characters in the reported path', async () => {
    const result = await writeEnvFile([entry('A')], 'x\u001b[31m/.env', DOTENV, deps({ A: 'v' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain('\u001b')
  })
})

describe('writeEnvFile — AC-2 refusal (27) happens before any temp file', () => {
  it.each([
    ['all three quote chars', `a'b\`c"d`, 'dotenv', /no dotenv quoting style/],
    ['carriage return', 'a\rb', 'dotenv', /carriage return/],
    ['NUL', 'a\0b', 'shell', /NUL/],
  ] as const)(
    '%s → 27, names the credential, never the value',
    async (_l, value, format, reason) => {
      const d = deps({ 'my-cred': value, OTHER: 'OTHER-VALUE' })
      const result = await writeEnvFile(
        [entry('OTHER'), entry('my-cred', 'MY_CRED')],
        '.env',
        { format, force: false },
        d
      )
      expect(result).toEqual({
        ok: false,
        exitCode: EXIT_CODES.valueNotRepresentable,
        error: expect.stringMatching(reason),
      })
      if (!result.ok) {
        expect(result.error).toContain("'my-cred'")
        expect(result.error).toContain('MY_CRED')
        expect(result.error).not.toContain(value)
        expect(result.error).not.toContain('OTHER-VALUE')
      }
      expect(readdirSync(dir)).toEqual([])
    }
  )
})

describe('writeEnvFile — AC-6 dotenv-only quoting warning', () => {
  it('names only the affected keys, never values', async () => {
    await writeEnvFile(
      [entry('PLAIN'), entry('STRIPE_KEY'), entry('OTHER')],
      '.env',
      DOTENV,
      deps({ PLAIN: 'x', STRIPE_KEY: "it's", OTHER: "a'b`c" })
    )
    expect(stderr).toEqual([
      "warning: STRIPE_KEY, OTHER use dotenv-only quoting; do not 'source' this file from a shell — use --format shell for that\n",
    ])
  })

  it('uses the singular verb for one key', async () => {
    await writeEnvFile([entry('STRIPE_KEY')], '.env', DOTENV, deps({ STRIPE_KEY: "it's" }))
    expect(stderr).toEqual([
      "warning: STRIPE_KEY uses dotenv-only quoting; do not 'source' this file from a shell — use --format shell for that\n",
    ])
  })
})

describe('writeEnvFile — AC-5 write failure after serialization', () => {
  it.each(['EACCES', 'ENOSPC', 'EROFS'])(
    '%s → 28 with the code and sanitized path only, directory unchanged',
    async (code) => {
      const failingFs: AtomicFs = {
        ...realFs,
        writeSync: () => {
          const error = new Error(`${code}: SECRET-IN-MESSAGE`) as NodeJS.ErrnoException
          error.code = code
          throw error
        },
      }
      const result = await writeEnvFile(
        [entry('A')],
        '.env',
        DOTENV,
        deps({ A: 'line-one\nline-two' }, { fs: failingFs })
      )
      expect(result).toEqual({
        ok: false,
        exitCode: EXIT_CODES.outputWriteFailed,
        error: `Failed to write '${join(dir, '.env')}': ${code}`,
      })
      expect(stderr.join('')).not.toMatch(/line-one|line-two|SECRET-IN-MESSAGE/)
      expect(readdirSync(dir)).toEqual([])
    }
  )

  it('an error without a code is reported generically', async () => {
    const failingFs: AtomicFs = {
      ...realFs,
      writeSync: () => {
        throw new Error('no code here')
      },
    }
    const result = await writeEnvFile(
      [entry('A')],
      '.env',
      DOTENV,
      deps({ A: 'v' }, { fs: failingFs })
    )
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.outputWriteFailed,
      error: `Failed to write '${join(dir, '.env')}': unknown error`,
    })
  })
})

describe('writeEnvFile — AC-3 concurrency (real writer, real path)', () => {
  it('two concurrent writers without --force → exactly one succeeds, the other gets 25, file complete', async () => {
    const [a, b] = await Promise.all([
      writeEnvFile([entry('A')], '.env', DOTENV, deps({ A: 'payload-one' })),
      writeEnvFile([entry('A')], '.env', DOTENV, deps({ A: 'payload-two' })),
    ])
    expect([a.exitCode, b.exitCode].sort()).toEqual([0, EXIT_CODES.outputExists])
    const content = readFileSync(join(dir, '.env'), 'utf8')
    expect([
      `${ENV_FILE_HEADER}A='payload-one'\n`,
      `${ENV_FILE_HEADER}A='payload-two'\n`,
    ]).toContain(content)
    expect(readdirSync(dir)).toEqual(['.env'])
  })

  it('two concurrent writers with --force → both succeed, final file is one complete payload', async () => {
    const force = { format: 'dotenv', force: true } as const
    const results = await Promise.all([
      writeEnvFile([entry('A')], '.env', force, deps({ A: 'payload-one' })),
      writeEnvFile([entry('A')], '.env', force, deps({ A: 'payload-two' })),
    ])
    expect(results.map((r) => r.exitCode)).toEqual([0, 0])
    const content = readFileSync(join(dir, '.env'), 'utf8')
    expect([
      `${ENV_FILE_HEADER}A='payload-one'\n`,
      `${ENV_FILE_HEADER}A='payload-two'\n`,
    ]).toContain(content)
  })
})

describe('writeEnvFile — AC-9 accidental-commit guard (injected dep)', () => {
  it('warns once when the target is not gitignored, called with (parentDir, basename) after pre-flight and before fetching', async () => {
    const order: string[] = []
    const checkGitIgnored = vi.fn(async () => {
      order.push('git')
      return 'not-ignored' as const
    })
    const d = deps({ A: 'v' }, { checkGitIgnored })
    d.getSecret.mockImplementation(async () => {
      order.push('fetch')
      return 'v'
    })
    const result = await writeEnvFile([entry('A')], '.env', DOTENV, d)
    expect(result.exitCode).toBe(0)
    expect(checkGitIgnored).toHaveBeenCalledWith(dir, '.env')
    expect(order).toEqual(['git', 'fetch'])
    expect(stderr).toEqual([
      `warning: '${join(dir, '.env')}' is inside a git repository and is not gitignored; add it to .gitignore before committing\n`,
    ])
  })

  it.each(['ignored', 'unknown'] as const)('is silent when the status is %s', async (status) => {
    const result = await writeEnvFile(
      [entry('A')],
      '.env',
      DOTENV,
      deps({ A: 'v' }, { checkGitIgnored: async () => status })
    )
    expect(result.exitCode).toBe(0)
    expect(stderr).toEqual([])
  })

  it('fails open (silent, exit unaffected) when the check itself throws', async () => {
    const result = await writeEnvFile(
      [entry('A')],
      '.env',
      DOTENV,
      deps({ A: 'v' }, { checkGitIgnored: async () => Promise.reject(new Error('boom')) })
    )
    expect(result.exitCode).toBe(0)
    expect(stderr).toEqual([])
  })
})
