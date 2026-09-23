import { VaultAgentError } from '@project-vault/agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { checkEntryTargets, fetchAllOrNothing } from './fetch-secrets.js'

const CONTEXT = { invocation: 'write-env' } as const

const entry = (credentialName: string, envVarName = credentialName) => ({
  credentialName,
  envVarName,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAllOrNothing (extracted from inject-and-run.ts, Story 43.5 Task 3)', () => {
  it('fetches every entry in order and returns a null-prototype map keyed by target', async () => {
    const getSecret = vi.fn(async (name: string) => `v-${name}`)
    const result = await fetchAllOrNothing([entry('A'), entry('b', '__proto__')], CONTEXT, {
      getSecret,
    })
    expect(getSecret.mock.calls.map(([n]) => n)).toEqual(['A', 'b'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.getPrototypeOf(result.injected)).toBeNull()
    expect(Object.hasOwn(result.injected, '__proto__')).toBe(true)
    expect(result.injected['A']).toBe('v-A')
    expect(result.servedFromCacheCount).toBe(0)
  })

  it('passes the caller-supplied audit invocation context to every fetch (Story 43.4 AC-3)', async () => {
    const getSecret = vi.fn(async () => 'v')
    await fetchAllOrNothing([entry('A'), entry('B')], CONTEXT, { getSecret })
    expect(getSecret.mock.calls).toEqual([
      ['A', CONTEXT],
      ['B', CONTEXT],
    ])
  })

  it('aborts on the first failure, never fetching later entries, with a message built only from the failing entry', async () => {
    const getSecret = vi.fn(async (name: string) => {
      if (name === 'B') throw new VaultAgentError('credential_not_found', 'nope')
      return 'ALREADY-FETCHED-VALUE'
    })
    const result = await fetchAllOrNothing([entry('A'), entry('B'), entry('C')], CONTEXT, {
      getSecret,
    })
    expect(getSecret).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.credentialNotFound,
      error: expect.stringContaining("'B'"),
    })
    if (!result.ok) expect(result.error).not.toContain('ALREADY-FETCHED-VALUE')
  })

  it('maps a non-VaultAgentError failure to the unexpected exit code', async () => {
    const result = await fetchAllOrNothing([entry('A')], CONTEXT, {
      getSecret: async () => {
        throw new Error('boom')
      },
    })
    expect(result).toEqual({
      ok: false,
      exitCode: EXIT_CODES.unexpected,
      error: "Unexpected error fetching 'A': boom",
    })
  })

  it('counts and warns about each value served after a network failure (offline cache)', async () => {
    const stderr: string[] = []
    const getSecret = async (name: string): Promise<string> => {
      if (name === 'CACHED') {
        await globalThis.fetch('http://unreachable.invalid').catch(() => undefined)
      }
      return 'v'
    }
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchAllOrNothing([entry('LIVE'), entry('CACHED')], CONTEXT, {
      getSecret,
      writeStderr: (c) => stderr.push(c),
    })
    expect(result.ok && result.servedFromCacheCount).toBe(1)
    expect(stderr).toEqual([
      "warning: 'CACHED' served from offline cache (vault unreachable), value may be stale and this fetch is not recorded in the vault audit log\n",
    ])
  })
})

describe('checkEntryTargets (shared reserved/duplicate validation)', () => {
  it('returns null for valid, distinct targets', () => {
    expect(checkEntryTargets([entry('A'), entry('B')], 'inject into')).toBeNull()
  })

  it('refuses a reserved target with the given action verb', () => {
    expect(checkEntryTargets([entry('x', 'NODE_OPTIONS')], 'write')).toEqual({
      ok: false,
      exitCode: EXIT_CODES.usageError,
      error: expect.stringMatching(
        /^Refusing to write reserved\/dangerous environment variable 'NODE_OPTIONS'/
      ),
    })
  })

  it('refuses case-insensitive duplicate targets', () => {
    expect(checkEntryTargets([entry('a', 'FOO'), entry('b', 'foo')], 'write')).toEqual({
      ok: false,
      exitCode: EXIT_CODES.usageError,
      error: 'Duplicate environment variable target: foo',
    })
  })
})
