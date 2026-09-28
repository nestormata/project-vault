import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSession, writeSession, type SessionData } from './session-store.js'
import { runLogout } from './logout-command.js'

const LOGGED_OUT = 'Logged out.\n'

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
    expect(streams.stdoutChunks.join('')).toBe(LOGGED_OUT)
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
    expect(streams.stdoutChunks.join('')).toBe(LOGGED_OUT)
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

describe('runLogout — Story 43.8 AC-7: a rate-limited logout is not a remote revocation', () => {
  const NOT_REVOKED_WARNING =
    "warning: the server rate-limited this logout, so the session was NOT revoked remotely and stays valid until it expires. Revoke it from the web app's Sessions page if the token may have leaked.\n"

  it('warns that the session was NOT revoked, still deletes the local file, and exits 0', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'rate_limit_exceeded' }), { status: 429 })
      )

    const exitCode = await runLogout(streams, { fetchFn, env: envFor() })

    expect(exitCode).toBe(0)
    expect(streams.stderrChunks.join('')).toBe(NOT_REVOKED_WARNING)
    expect(streams.stdoutChunks.join('')).toBe(LOGGED_OUT)
    expect(readSession(envFor())).toEqual({ status: 'not_found' })
  })

  it('prints no new warning for a 200 { revoked: false }', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { revoked: false } }), { status: 200 })
      )

    const exitCode = await runLogout(streams, { fetchFn, env: envFor() })

    expect(exitCode).toBe(0)
    expect(streams.stderrChunks.join('')).toBe('')
    expect(streams.stdoutChunks.join('')).toBe(LOGGED_OUT)
  })

  it('keeps the existing network-error warning (and no rate-limit warning) when offline', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await runLogout(streams, { fetchFn, env: envFor() })

    const stderr = streams.stderrChunks.join('')
    expect(stderr).toContain('could not reach the server')
    expect(stderr).not.toContain('rate-limited')
  })
})

describe('runLogout — Story 43.13 AC-2: network-error text is free text', () => {
  it('prints the error on one line, bidi stripped, capped at 500 code points', async () => {
    writeSession(SAMPLE, envFor())
    const streams = makeStreams()
    const fetchFn = vi.fn().mockRejectedValue(new Error(`x\u202Ey\n${'w'.repeat(5000)}`))

    await runLogout(streams, { fetchFn, env: envFor() })

    const prefix = 'warning: could not reach the server to invalidate the session remotely: '
    const warning = streams.stderrChunks.join('')
    expect(warning.startsWith(`${prefix}xy w`)).toBe(true)
    expect([...warning.slice(prefix.length, -1)]).toHaveLength(500)
    expect(warning.endsWith('…\n')).toBe(true)
  })
})
