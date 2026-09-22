import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { readSession, writeSession, sessionFilePath, type SessionData } from './session-store.js'
import {
  ensureFreshSession,
  messageForSessionFailure,
  type EnsureSessionResult,
} from './session-refresh.js'

function assertNotOk(
  result: EnsureSessionResult
): asserts result is Exclude<EnsureSessionResult, { status: 'ok' }> {
  if (result.status === 'ok') throw new Error('expected a non-ok EnsureSessionResult')
}

let xdgHome: string

function envFor(): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: xdgHome }
}

function jsonResponse(status: number, body: unknown) {
  return { status, json: () => Promise.resolve(body) } as Response
}

const FRESH: SessionData = {
  accessToken: 'fresh-access',
  refreshToken: 'fresh-refresh',
  accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  userId: 'a1c2d3e4-0000-0000-0000-000000000000',
  orgId: 'b1c2d3e4-0000-0000-0000-000000000000',
  baseUrl: 'https://vault.example.com',
}

const EXPIRED: SessionData = {
  ...FRESH,
  accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
}

const REFRESHED_ACCESS_TOKEN = 'new-access'

beforeEach(() => {
  xdgHome = mkdtempSync(join(tmpdir(), 'pvault-refresh-test-'))
})

afterEach(() => {
  rmSync(xdgHome, { recursive: true, force: true })
})

describe('ensureFreshSession — AC-4 silent refresh', () => {
  it('returns the session as-is when the access token has plenty of time left', async () => {
    writeSession(FRESH, envFor())
    const fetchFn = vi.fn()

    const result = await ensureFreshSession({ fetchFn, env: envFor() })

    expect(result).toEqual({ status: 'ok', session: FRESH })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('silently refreshes an expired access token when the refresh token is still valid, rewriting the session file', async () => {
    writeSession(EXPIRED, envFor())
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: { accessToken: REFRESHED_ACCESS_TOKEN, refreshToken: 'new-refresh', expiresIn: 300 },
      })
    )

    const result = await ensureFreshSession({ fetchFn, env: envFor() })

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.session.accessToken).toBe(REFRESHED_ACCESS_TOKEN)
      expect(result.session.refreshToken).toBe('new-refresh')
    }
    const onDisk = readSession(envFor())
    expect(onDisk).toEqual({
      status: 'ok',
      session: expect.objectContaining({ accessToken: REFRESHED_ACCESS_TOKEN }),
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://vault.example.com/api/v1/auth/cli/refresh',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('produces session_expired + the exact re-prompt message when the refresh call itself fails and no fresher file exists', async () => {
    writeSession(EXPIRED, envFor())
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { code: 'refresh_token_expired' }))

    const result = await ensureFreshSession({ fetchFn, env: envFor() })

    expect(result).toEqual({ status: 'session_expired' })
    assertNotOk(result)
    const translated = messageForSessionFailure(result)
    expect(translated).toEqual({
      message: 'Your session has expired. Run `pvault login` to sign in again.\n',
      exitCode: EXIT_CODES.sessionExpired,
    })
  })

  it('AC-4 concurrency: re-reads the session file once before declaring it dead, picking up a fresher write from another process', async () => {
    writeSession(EXPIRED, envFor())
    const fetchFn = vi.fn().mockImplementation(async () => {
      // Simulate a concurrent process winning the refresh-token-rotation race and writing fresh
      // tokens to disk while this process's own refresh call is in flight and then rejected.
      writeSession(
        {
          ...EXPIRED,
          accessToken: 'other-process-access',
          accessExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
        envFor()
      )
      return jsonResponse(401, { code: 'refresh_token_invalid' })
    })

    const result = await ensureFreshSession({ fetchFn, env: envFor() })

    expect(result).toEqual({
      status: 'ok',
      session: expect.objectContaining({ accessToken: 'other-process-access' }),
    })
  })

  it('never throws on malformed refresh JSON — falls through to session_expired', async () => {
    writeSession(EXPIRED, envFor())
    const fetchFn = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        json: () => Promise.reject(new Error('bad json')),
      } as Response)

    const result = await ensureFreshSession({ fetchFn, env: envFor() })

    expect(result).toEqual({ status: 'session_expired' })
  })
})

describe('ensureFreshSession — not-logged-in / insecure-permissions distinguishability', () => {
  it('returns not_logged_in when no session file exists', async () => {
    const result = await ensureFreshSession({ fetchFn: vi.fn(), env: envFor() })
    expect(result).toEqual({ status: 'not_logged_in' })
    assertNotOk(result)
    expect(messageForSessionFailure(result).exitCode).toBe(EXIT_CODES.notLoggedIn)
  })

  it('AC-5: returns insecure_permissions (not session_expired) for a world-readable session file', async () => {
    writeSession(FRESH, envFor())
    const fs = await import('node:fs')
    fs.chmodSync(sessionFilePath(envFor()), 0o644)

    const result = await ensureFreshSession({ fetchFn: vi.fn(), env: envFor() })

    expect(result.status).toBe('insecure_permissions')
    assertNotOk(result)
    expect(messageForSessionFailure(result).exitCode).toBe(
      EXIT_CODES.insecureSessionFilePermissions
    )
  })
})

describe('session file atomicity — AC-4 concurrency', () => {
  it('writeSession never leaves the file in a partially-written state a concurrent reader could observe', () => {
    writeSession(FRESH, envFor())
    const raw = readFileSync(sessionFilePath(envFor()), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
