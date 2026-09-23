import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSession, writeSession, type SessionData } from './session-store.js'
import { runLogout } from './logout-command.js'

let xdgHome: string

function envFor(): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: xdgHome }
}

function makeStreams() {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => void stdoutChunks.push(chunk) },
    stderr: { write: (chunk: string) => void stderrChunks.push(chunk) },
    stdoutChunks,
    stderrChunks,
  }
}

const SAMPLE: SessionData = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  accessExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  userId: 'a1c2d3e4-0000-0000-0000-000000000000',
  orgId: 'b1c2d3e4-0000-0000-0000-000000000000',
  baseUrl: 'https://vault.example.com',
}

beforeEach(() => {
  xdgHome = mkdtempSync(join(tmpdir(), 'pvault-logout-test-'))
})

afterEach(() => {
  rmSync(xdgHome, { recursive: true, force: true })
})

describe('runLogout — AC-6', () => {
  it('deletes the session file and prints a confirmation, exit code 0', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockResolvedValue({ status: 204 } as Response)

    const exitCode = await runLogout(streams, { fetchFn, env: envFor() })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('Logged out.\n')
    expect(readSession(envFor())).toEqual({ status: 'not_found' })
  })

  it('calls the server-side logout endpoint with the refresh token, best-effort', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockResolvedValue({ status: 204 } as Response)

    await runLogout(streams, { fetchFn, env: envFor() })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://vault.example.com/api/v1/auth/cli/logout',
      expect.objectContaining({ method: 'POST' })
    )
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: SAMPLE.refreshToken })
  })

  it('is idempotent success when no session file exists — not an error', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn()

    const exitCode = await runLogout(streams, { fetchFn, env: envFor() })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('Not logged in.\n')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('still deletes the local file and exits 0 when the server call fails (offline)', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const exitCode = await runLogout(streams, { fetchFn, env: envFor() })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('Logged out.\n')
    expect(readSession(envFor())).toEqual({ status: 'not_found' })
    expect(streams.stderrChunks.join('')).toContain('warning')
  })

  it('never prints the token values, even in the offline warning', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockRejectedValue(new Error('network fail'))

    await runLogout(streams, { fetchFn, env: envFor() })

    const all = streams.stdoutChunks.join('') + streams.stderrChunks.join('')
    expect(all).not.toContain(SAMPLE.accessToken)
    expect(all).not.toContain(SAMPLE.refreshToken)
  })
})
