import { describe, expect, it, vi } from 'vitest'
import { buildProgram, type CliRuntime } from './cli.js'
import { CLI_BUILD_INFO } from './build-info.js'

/** Story 43.6 AC-4 — `pvault --version` / `-V`. */

function makeRuntime(overrides: Partial<CliRuntime> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const fetchFn = vi.fn(async () => {
    throw new Error('--version must never make a network call')
  })
  const runtime: CliRuntime = {
    streams: {
      stdout: { write: (c: string) => void stdout.push(c) },
      stderr: { write: (c: string) => void stderr.push(c) },
      isTTY: false,
    },
    env: { VAULT_URL: 'https://vault.example.com' },
    createVaultAgent: vi.fn(() => {
      throw new Error('no agent')
    }),
    setExitCode: vi.fn(),
    prompt: vi.fn(),
    fetchFn,
    spawn: vi.fn(),
    parentProcess: {} as CliRuntime['parentProcess'],
    versionCheck: {
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => Date.now(),
      cacheDir: null,
    },
    ...overrides,
  }
  return { runtime, stdout, stderr, fetchFn }
}

async function parseVersion(runtime: CliRuntime, flag: string): Promise<number | undefined> {
  try {
    await buildProgram(runtime).parseAsync(['node', 'pvault', flag])
    return undefined
  } catch (error) {
    return (error as { exitCode?: number }).exitCode
  }
}

const STAMPED = { version: '1.3.0', commit: '3f2a1c9' }

describe('pvault --version (Story 43.6 AC-4)', () => {
  it.each(['--version', '-V'])(
    '%s prints the two stable lines, exits 0, no network',
    async (flag) => {
      const { runtime, stdout, stderr, fetchFn } = makeRuntime({
        buildInfo: { cli: STAMPED, agent: STAMPED },
      })
      expect(await parseVersion(runtime, flag)).toBe(0)
      expect(stdout.join('')).toBe('pvault 1.3.0 (commit 3f2a1c9)\nagent  1.3.0 (commit 3f2a1c9)\n')
      expect(stderr.join('')).toBe('')
      expect(fetchFn).not.toHaveBeenCalled()
    }
  )

  it('an unstamped checkout build prints dev / commit unknown and never 0.0.1', async () => {
    const { runtime, stdout } = makeRuntime()
    expect(await parseVersion(runtime, '--version')).toBe(0)
    expect(stdout.join('')).toBe('pvault dev (commit unknown)\nagent  dev (commit unknown)\n')
    expect(stdout.join('')).not.toContain('0.0.1')
    expect(stdout.join('').split('\n')[0]?.split(' ')[1]).toBe(CLI_BUILD_INFO.version)
  })

  it('skew between the CLI and its agent is reported on stderr only, exit stays 0', async () => {
    const { runtime, stdout, stderr } = makeRuntime({
      buildInfo: { cli: STAMPED, agent: { version: 'dev', commit: null } },
    })
    expect(await parseVersion(runtime, '--version')).toBe(0)
    expect(stdout.join('')).not.toContain('warning')
    expect(stderr.join('')).toBe(
      'warning: pvault and its agent were built from different sources; rebuild both (pnpm --filter "@project-vault/cli..." build)\n'
    )
  })

  it('still works on a withdrawn CLI (no version-check request at all)', async () => {
    const withdrawnFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              clients: {
                cli: {
                  current: '1.3.0',
                  minimumSupported: null,
                  withdrawn: [{ version: '1.3.0', reason: 'bad' }],
                },
              },
            },
          })
        )
    )
    const { runtime, stdout } = makeRuntime({
      buildInfo: { cli: STAMPED, agent: STAMPED },
      versionCheck: {
        fetchFn: withdrawnFetch as unknown as typeof fetch,
        now: () => Date.now(),
        cacheDir: null,
      },
    })
    expect(await parseVersion(runtime, '--version')).toBe(0)
    expect(stdout.join('')).toContain('pvault 1.3.0')
    expect(withdrawnFetch).not.toHaveBeenCalled()
  })
})
