import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { runBrowserLogin } from './browser-login-command.js'

function streams() {
  let out = ''
  let err = ''
  return {
    stdout: {
      write: (chunk: string) => {
        out += chunk
      },
    },
    stderr: {
      write: (chunk: string) => {
        err += chunk
      },
    },
    text: () => ({ out, err }),
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('pvault login --browser (Story 43.30)', () => {
  it('prints the user code and URL, polls, and stores the session', async () => {
    const written: unknown[] = []
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: {
            deviceCode: 'd'.repeat(43),
            userCode: 'BCDF-GHJK',
            verificationUri: 'http://localhost:5173/cli/device',
            verificationUriComplete: 'http://localhost:5173/cli/device?code=BCDF-GHJK',
            expiresIn: 300,
            interval: 1,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse(400, { code: 'authorization_pending', message: 'wait' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            accessToken: 'access',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
            expiresIn: 300,
            userId: 'user-1',
            sessionId: 'session-1',
            scope: 'user',
            isPlatformOperator: false,
          },
        })
      )
    const io = streams()
    const code = await runBrowserLogin({ baseUrl: 'http://localhost:3000' }, io, {
      fetchFn,
      env: {},
      sleep: async () => undefined,
      now: () => 1_000,
      writeSessionFn: (session) => {
        written.push(session)
      },
    })
    expect(code).toBe(0)
    expect(io.text().out).toContain('Sign-in code: BCDF-GHJK')
    expect(io.text().out).toContain('http://localhost:5173/cli/device?code=BCDF-GHJK')
    expect(io.text().out).not.toContain('d'.repeat(43))
    expect(written).toHaveLength(1)
  })

  it('writes no session when the sign-in is denied', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: {
            deviceCode: 'e'.repeat(43),
            userCode: 'BCDF-GHJK',
            verificationUri: 'https://vault.example/cli/device',
            verificationUriComplete: 'https://vault.example/cli/device?code=BCDF-GHJK',
            expiresIn: 300,
            interval: 5,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse(400, { code: 'access_denied', message: 'no' }))
    const io = streams()
    const writes: unknown[] = []
    const code = await runBrowserLogin({ baseUrl: 'https://vault.example' }, io, {
      fetchFn,
      env: {},
      sleep: async () => undefined,
      now: () => 1_000,
      writeSessionFn: (session) => {
        writes.push(session)
      },
    })
    expect(code).toBe(EXIT_CODES.deviceLoginDenied)
    expect(writes).toHaveLength(0)
    expect(io.text().err).toContain('denied')
  })
})
