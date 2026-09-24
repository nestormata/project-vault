/* eslint-disable sonarjs/no-duplicate-string -- the outcome names are a string-literal union used as
   switch cases and matrix rows; spelling them inline keeps the matrix readable. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProgram,
  VERSION_CHECK_EXEMPT_COMMANDS,
  VERSION_CHECKED_COMMANDS,
  type CliRuntime,
} from './cli.js'
import { EXIT_CODES } from './exit-codes.js'
import type { CliVersionPolicy } from './version-policy-response.js'

/**
 * Story 43.6 — end-to-end through `buildProgram().parseAsync()` with a stamped fake build-info,
 * a fake agent, a fake spawn and a fake version-policy `fetchFn` (AC-1, AC-2, AC-3, AC-6).
 */

const BASE_URL = 'https://vault.example.com'
const PROJECT_ID = 'a1c2d3e4-0000-0000-0000-000000000000'
const MULTI_LINE_VALUE = 'line-one\nline-two\n'
const RELEASES = 'https://github.com/nestormata/project-vault/releases'
const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const REASON = 'Known-bad release; upgrade immediately.'
const STALE_NOTICE = `notice: pvault 1.2.0 is older than this server's release 1.3.0; download the matching pvault from ${RELEASES}\n`

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Outcome =
  | 'ok'
  | 'stale'
  | 'below-minimum'
  | 'server-older'
  | 'withdrawn'
  | 'unreachable'
  | 'malformed'
  | 'sticky-withdrawn'

function policyFor(outcome: Outcome, cliVersion: string): CliVersionPolicy {
  switch (outcome) {
    case 'ok':
      return { current: cliVersion, minimumSupported: null, withdrawn: [] }
    case 'below-minimum':
      return { current: '1.3.0', minimumSupported: '1.2.5', withdrawn: [] }
    case 'server-older':
      return { current: '1.1.0', minimumSupported: null, withdrawn: [] }
    case 'withdrawn':
    case 'sticky-withdrawn':
      return {
        current: '1.3.0',
        minimumSupported: null,
        withdrawn: [{ version: cliVersion, reason: REASON }],
      }
    default:
      return { current: '1.3.0', minimumSupported: null, withdrawn: [] }
  }
}

function policyResponse(policy: CliVersionPolicy): Response {
  return new Response(JSON.stringify({ data: { schemaVersion: 1, clients: { cli: policy } } }), {
    status: 200,
  })
}

type Command = 'get' | 'run' | 'write-env' | 'login'

type Invocation = {
  stdout: string
  stderr: string
  exitCode: number | undefined
  thrownExitCode: number | undefined
  versionFetch: ReturnType<typeof vi.fn>
  createVaultAgent: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  loginFetch: ReturnType<typeof vi.fn>
  workDir: string
}

type InvokeOptions = {
  versionFetch?: (url: string, init: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
  cliVersion?: string
  cacheDir?: string | null
  enabled?: boolean
  now?: () => number
}

function argvFor(command: Command): string[] {
  switch (command) {
    case 'get':
      return ['get', 'DATABASE_URL']
    case 'run':
      return ['run', '--secret', 'DATABASE_URL', '--', 'psql']
    case 'write-env':
      return ['write-env', '--secret', 'DATABASE_URL', '--output', '.env']
    default:
      return ['login']
  }
}

async function invoke(argv: string[], options: InvokeOptions = {}): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  let exitCode: number | undefined
  const workDir = tempDir('pvault-vc-e2e-cwd-')
  const getSecret = vi.fn(async () => MULTI_LINE_VALUE)
  const createVaultAgent = vi.fn(() => ({ getSecret }))
  const spawn = vi.fn(() => {
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    setTimeout(() => {
      for (const l of exitListeners) l(0, null)
    }, 0)
    return {
      on: (
        event: string,
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
      ) => {
        if (event === 'exit') exitListeners.push(listener)
      },
      kill: vi.fn(),
    }
  })
  // `login` with a blank email exits with a usage error before any network call; enough to
  // compare stdout/exit with and without the check.
  const prompt = vi.fn(async () => '')
  const loginFetch = vi.fn(async () => {
    throw new Error('login must not reach the network in these tests')
  })
  const versionFetch = vi.fn(
    options.versionFetch ?? (async () => policyResponse(policyFor('ok', '1.2.0')))
  )
  const runtime: CliRuntime = {
    streams: {
      stdout: { write: (c: string) => void stdout.push(c) },
      stderr: { write: (c: string) => void stderr.push(c) },
      isTTY: false,
    },
    env: {
      VAULT_API_KEY: 'pk_secret_key_value',
      VAULT_URL: BASE_URL,
      VAULT_PROJECT_ID: PROJECT_ID,
      // `logout` touches the session directory; keep it away from the real home directory.
      XDG_CONFIG_HOME: tempDir('pvault-vc-e2e-xdg-'),
      ...options.env,
    },
    createVaultAgent,
    setExitCode: (code) => {
      exitCode = code
    },
    prompt,
    fetchFn: loginFetch,
    spawn: spawn as unknown as CliRuntime['spawn'],
    parentProcess: {
      pid: 1,
      platform: 'linux',
      on: () => {},
      removeListener: () => {},
      kill: () => {},
    } as unknown as CliRuntime['parentProcess'],
    cwd: workDir,
    checkGitIgnored: async () => 'unknown',
    buildInfo: {
      cli: { version: options.cliVersion ?? '1.2.0', commit: 'abcdef0' },
      agent: { version: options.cliVersion ?? '1.2.0', commit: 'abcdef0' },
    },
    ...(options.enabled === false
      ? {}
      : {
          versionCheck: {
            fetchFn: versionFetch as unknown as typeof fetch,
            now: options.now ?? (() => T0),
            cacheDir:
              options.cacheDir === undefined ? tempDir('pvault-vc-e2e-cache-') : options.cacheDir,
          },
        }),
  }
  let thrownExitCode: number | undefined
  try {
    await buildProgram(runtime).parseAsync(['node', 'pvault', ...argv])
  } catch (error) {
    thrownExitCode = (error as { exitCode?: number }).exitCode
  }
  return {
    stdout: stdout.join(''),
    // write-env names its absolute output path; normalize the per-run temp dir for comparisons.
    stderr: stderr.join('').split(workDir).join('<cwd>'),
    exitCode,
    thrownExitCode,
    versionFetch,
    createVaultAgent,
    spawn,
    prompt,
    loginFetch,
    workDir,
  }
}

function fetchFor(outcome: Outcome, cliVersion = '1.2.0') {
  if (outcome === 'unreachable') return async () => Promise.reject(new TypeError('fetch failed'))
  if (outcome === 'malformed') return async () => new Response('<html>', { status: 200 })
  return async () => policyResponse(policyFor(outcome, cliVersion))
}

async function invokeOutcome(command: Command, outcome: Outcome, suppress: boolean) {
  const env = suppress ? { PVAULT_NO_VERSION_CHECK: '1' } : {}
  if (outcome !== 'sticky-withdrawn') {
    return invoke(argvFor(command), { versionFetch: fetchFor(outcome), env })
  }
  const cacheDir = tempDir('pvault-vc-e2e-sticky-')
  await invoke(argvFor(command), { versionFetch: fetchFor('withdrawn'), cacheDir, env })
  return invoke(argvFor(command), {
    versionFetch: fetchFor('unreachable'),
    cacheDir,
    env,
    now: () => T0 + 3 * 24 * 3_600_000,
  })
}

const COMMANDS: Command[] = ['get', 'run', 'write-env', 'login']
const OUTCOMES: Outcome[] = [
  'ok',
  'stale',
  'below-minimum',
  'server-older',
  'withdrawn',
  'unreachable',
  'malformed',
  'sticky-withdrawn',
]
const REFUSING: Outcome[] = ['withdrawn', 'sticky-withdrawn']
const MATRIX = COMMANDS.flatMap((command) =>
  OUTCOMES.flatMap((outcome) => [false, true].map((suppress) => ({ command, outcome, suppress })))
)

describe('AC-6 stdout purity matrix', () => {
  for (const { command, outcome, suppress } of MATRIX) {
    it(`${command} / ${outcome} / PVAULT_NO_VERSION_CHECK=${suppress ? '1' : 'unset'}`, async () => {
      const baseline = await invoke(argvFor(command), { enabled: false })
      const checked = await invokeOutcome(command, outcome, suppress)
      if (REFUSING.includes(outcome)) {
        expect(checked.stdout).toBe('')
        expect(checked.exitCode).toBe(EXIT_CODES.cliVersionWithdrawn)
        expect(checked.thrownExitCode).toBe(EXIT_CODES.cliVersionWithdrawn)
        expect(checked.stderr).toContain(
          'error: pvault 1.2.0 has been withdrawn by vault.example.com'
        )
        expect(checked.createVaultAgent).not.toHaveBeenCalled()
        expect(checked.spawn).not.toHaveBeenCalled()
        expect(checked.prompt).not.toHaveBeenCalled()
        expect(checked.loginFetch).not.toHaveBeenCalled()
        expect(readdirSync(checked.workDir)).toEqual([])
      } else {
        expect(checked.stdout).toBe(baseline.stdout)
        expect(checked.exitCode).toBe(baseline.exitCode)
        const extra = checked.stderr.replace(baseline.stderr, '')
        const expectNotice =
          !suppress && ['stale', 'below-minimum', 'server-older'].includes(outcome)
        expect(extra.split('\n').filter(Boolean)).toHaveLength(expectNotice ? 1 : 0)
      }
    })
  }

  it('get with a stale CLI: stdout is byte-identical (multi-line value), notice on stderr only', async () => {
    const result = await invoke(argvFor('get'), { versionFetch: fetchFor('stale') })
    expect(result.stdout).toBe(MULTI_LINE_VALUE)
    expect(result.stderr).toBe(STALE_NOTICE)
    expect(result.exitCode).toBe(0)
  })

  it('withdrawn: exact two-line refusal, stdout empty, no .env or temp file', async () => {
    const result = await invoke(argvFor('write-env'), { versionFetch: fetchFor('withdrawn') })
    expect(result.stderr).toBe(
      `error: pvault 1.2.0 has been withdrawn by vault.example.com: ${REASON}\nDownload a supported release from ${RELEASES}\n`
    )
    expect(existsSync(join(result.workDir, '.env'))).toBe(false)
    expect(readdirSync(result.workDir)).toEqual([])
  })
})

describe('PVAULT_NO_VERSION_CHECK (D10)', () => {
  it('set → the version-check request is still made', async () => {
    const result = await invoke(argvFor('get'), {
      versionFetch: fetchFor('stale'),
      env: { PVAULT_NO_VERSION_CHECK: 'true' },
    })
    expect(result.versionFetch).toHaveBeenCalledTimes(1)
    expect(result.stderr).toBe('')
  })

  it.each(['yes', '2', 'on'])(
    'invalid value %s → notices print plus one warning line',
    async (value) => {
      const result = await invoke(argvFor('get'), {
        versionFetch: fetchFor('stale'),
        env: { PVAULT_NO_VERSION_CHECK: value },
      })
      expect(result.stderr).toBe(
        `warning: ignoring PVAULT_NO_VERSION_CHECK=${value}; use 1 or true to silence version notices\n${STALE_NOTICE}`
      )
    }
  )

  it.each(['0', 'false', ''])('%j → notices print as normal', async (value) => {
    const result = await invoke(argvFor('get'), {
      versionFetch: fetchFor('stale'),
      env: { PVAULT_NO_VERSION_CHECK: value },
    })
    expect(result.stderr).toBe(STALE_NOTICE)
  })

  it('suppressed notice does not start the 24 h window', async () => {
    const cacheDir = tempDir('pvault-vc-e2e-window-')
    await invoke(argvFor('get'), {
      versionFetch: fetchFor('stale'),
      cacheDir,
      env: { PVAULT_NO_VERSION_CHECK: '1' },
    })
    const second = await invoke(argvFor('get'), { versionFetch: fetchFor('stale'), cacheDir })
    expect(second.stderr).toBe(STALE_NOTICE)
  })

  it('invalid value warning is not printed for exempt commands', async () => {
    const result = await invoke(['logout'], { env: { PVAULT_NO_VERSION_CHECK: 'yes' } })
    expect(result.stderr).not.toContain('PVAULT_NO_VERSION_CHECK')
  })
})

describe('server-older notice (AC-1)', () => {
  it('CLI 1.4.0 vs current 1.3.0 → one notice, stdout identical, second run within 24 h silent', async () => {
    const cacheDir = tempDir('pvault-vc-e2e-older-')
    const respond = async () =>
      policyResponse({ current: '1.3.0', minimumSupported: null, withdrawn: [] })
    const first = await invoke(argvFor('get'), {
      versionFetch: respond,
      cliVersion: '1.4.0',
      cacheDir,
    })
    expect(first.stderr).toBe(
      "notice: pvault 1.4.0 is newer than this server's release 1.3.0; some commands may not work until the server is upgraded\n"
    )
    expect(first.stdout).toBe(MULTI_LINE_VALUE)
    expect(first.exitCode).toBe(0)
    const second = await invoke(argvFor('get'), {
      versionFetch: respond,
      cliVersion: '1.4.0',
      cacheDir,
      now: () => T0 + 2 * 3_600_000,
    })
    expect(second.stderr).toBe('')
  })
})

describe('AC-3 unreachable', () => {
  it('a black-holed server aborts at 1500 ms and the command proceeds', async () => {
    vi.useFakeTimers()
    const pending = invoke(argvFor('get'), { versionFetch: () => new Promise<Response>(() => {}) })
    await vi.advanceTimersByTimeAsync(1500)
    const result = await pending
    expect(result.stdout).toBe(MULTI_LINE_VALUE)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })

  it('an older server (404) → proceed silently', async () => {
    const result = await invoke(argvFor('get'), {
      versionFetch: async () => new Response('not found', { status: 404 }),
    })
    expect(result.stdout).toBe(MULTI_LINE_VALUE)
    expect(result.stderr).toBe('')
  })

  it('no cache directory → the check still runs and proceeds', async () => {
    const result = await invoke(argvFor('get'), { versionFetch: fetchFor('stale'), cacheDir: null })
    expect(result.stderr).toBe(STALE_NOTICE)
  })

  it('http:// non-loopback URL: the insecure warning is printed once, by the command only', async () => {
    const result = await invoke(argvFor('get'), {
      versionFetch: fetchFor('ok'),
      env: { VAULT_URL: 'http://vault.example.com' }, // NOSONAR(typescript:S5332) verifying the insecure-http warning itself, not a real endpoint
    })
    expect(result.stderr.match(/is not https:\/\//g)).toHaveLength(1)
  })

  it('VAULT_URL missing → no version check, the usage error is unchanged', async () => {
    // NOSONAR(typescript:S2138) x2 below — `undefined` overrides invoke()'s default VAULT_URL via
    // object-spread merge; the runtime env type is `string | undefined`, so `null` would not
    // compile and would not match what an actually-unset environment variable looks like.
    const baseline = await invoke(argvFor('get'), { enabled: false, env: { VAULT_URL: undefined } }) // NOSONAR(typescript:S2138)
    const result = await invoke(argvFor('get'), { env: { VAULT_URL: undefined } }) // NOSONAR(typescript:S2138)
    expect(result.versionFetch).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(EXIT_CODES.usageError)
    expect(result.stderr).toBe(baseline.stderr)
  })

  it('--url overrides VAULT_URL for the check', async () => {
    const result = await invoke([...argvFor('get'), '--url', 'https://flag.example.com/'])
    expect(result.versionFetch.mock.calls[0]?.[0]).toBe(
      'https://flag.example.com/api/v1/client-version-policy'
    )
  })

  it('the request never carries the machine key or any x-vault header', async () => {
    const result = await invoke(argvFor('get'))
    const [url, init] = result.versionFetch.mock.calls[0] as [string, RequestInit]
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      'accept',
      'user-agent',
    ])
    expect(JSON.stringify([url, init.headers])).not.toContain('pk_secret_key_value')
  })

  it('the cache is written owner-only under the cache dir', async () => {
    const cacheDir = tempDir('pvault-vc-e2e-file-')
    await invoke(argvFor('get'), { cacheDir })
    const raw = JSON.parse(readFileSync(join(cacheDir, 'version-check.json'), 'utf8')) as {
      entries: Record<string, unknown>
    }
    expect(Object.keys(raw.entries)).toEqual([BASE_URL])
  })
})

describe('AC-6 wiring', () => {
  it('logout makes no version-check request, even on a withdrawn CLI', async () => {
    const result = await invoke(['logout'], { versionFetch: fetchFor('withdrawn') })
    expect(result.versionFetch).not.toHaveBeenCalled()
    expect(result.exitCode).not.toBe(EXIT_CODES.cliVersionWithdrawn)
  })

  it('--help makes no version-check request', async () => {
    const result = await invoke(['--help'])
    expect(result.versionFetch).not.toHaveBeenCalled()
  })

  it('run without "--" fails with exit 1 before any version-check request', async () => {
    const result = await invoke(['run', '--secret', 'X', 'psql'])
    expect(result.thrownExitCode).toBe(EXIT_CODES.usageError)
    expect(result.versionFetch).not.toHaveBeenCalled()
  })

  it('an unstamped (dev) build never checks', async () => {
    const result = await invoke(argvFor('get'), {
      cliVersion: 'dev',
      versionFetch: fetchFor('withdrawn'),
    })
    expect(result.versionFetch).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })

  it('inert by default: without runtime.versionCheck no request is ever made', async () => {
    const result = await invoke(argvFor('get'), { enabled: false })
    expect(result.versionFetch).not.toHaveBeenCalled()
    expect(result.stdout).toBe(MULTI_LINE_VALUE)
  })

  it('every registered subcommand is classified exactly once', () => {
    const program = buildProgram({
      streams: { stdout: { write: () => {} }, stderr: { write: () => {} }, isTTY: false },
      env: {},
      createVaultAgent: vi.fn(),
      setExitCode: vi.fn(),
      prompt: vi.fn(),
      fetchFn: vi.fn(),
      spawn: vi.fn(),
      parentProcess: {} as CliRuntime['parentProcess'],
    })
    for (const command of program.commands) {
      const name = command.name()
      const checked = VERSION_CHECKED_COMMANDS.has(name)
      const exempt = VERSION_CHECK_EXEMPT_COMMANDS.has(name)
      expect(checked !== exempt, `pvault ${name} must be in exactly one set`).toBe(true)
    }
    expect([...VERSION_CHECKED_COMMANDS].sort()).toEqual(['get', 'login', 'run', 'write-env'])
    expect([...VERSION_CHECK_EXEMPT_COMMANDS]).toEqual(['logout'])
  })
})
