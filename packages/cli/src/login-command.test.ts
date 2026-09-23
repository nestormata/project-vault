import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { runLogin, type LoginDeps } from './login-command.js'
import { PromptInterruptedError } from './prompt.js'

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

function jsonResponse(status: number, body: unknown) {
  return { status, json: () => Promise.resolve(body) } as Response
}

function promptSequence(answers: string[]): (q: string, o: { mask: boolean }) => Promise<string> {
  let i = 0
  return async () => {
    const value = answers[i]
    i += 1
    if (value === undefined) throw new Error('prompt called more times than expected')
    return value
  }
}

const BASE_CONFIG = { baseUrl: 'https://vault.example.com' }
const BEARER_DATA = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  tokenType: 'Bearer',
  expiresIn: 300,
  userId: 'a1c2d3e4-0000-0000-0000-000000000000',
  orgId: 'b1c2d3e4-0000-0000-0000-000000000000',
}
const TEST_EMAIL = 'dev@example.com'
const PENDING_MFA_TOKEN = 'pending-token'

describe('runLogin — AC-2 no-MFA success path', () => {
  it('prompts for email/password, stores the session, and never prints the token values', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: BEARER_DATA }))
    const writeSessionFn = vi.fn()
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'correct-horse-battery-staple']),
      env: {},
      writeSessionFn,
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(0)
    expect(writeSessionFn).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: BEARER_DATA.accessToken,
        refreshToken: BEARER_DATA.refreshToken,
        userId: BEARER_DATA.userId,
        orgId: BEARER_DATA.orgId,
        baseUrl: BASE_CONFIG.baseUrl,
      }),
      {}
    )
    const stdout = streams.stdoutChunks.join('')
    expect(stdout).not.toContain(BEARER_DATA.accessToken)
    expect(stdout).not.toContain(BEARER_DATA.refreshToken)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://vault.example.com/api/v1/auth/cli-login',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('sends email/password as the request body, not query params or headers', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: BEARER_DATA }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    await runLogin(BASE_CONFIG, streams, deps)

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ email: TEST_EMAIL, password: 'hunter2' })
  })
})

describe('runLogin — AC-2 MFA challenge round trip', () => {
  it('prompts for TOTP after an MFA challenge and succeeds on a valid code', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: BEARER_DATA }))
    const writeSessionFn = vi.fn()
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2', '123456']),
      env: {},
      writeSessionFn,
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(0)
    expect(writeSessionFn).toHaveBeenCalled()
    const [verifyUrl, verifyInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(verifyUrl).toBe('https://vault.example.com/api/v1/auth/cli/mfa/verify-login')
    expect(JSON.parse(verifyInit.body as string)).toEqual({
      mfaToken: PENDING_MFA_TOKEN,
      totp: '123456',
    })
  })

  it('trims whitespace and strips grouped-digit spacing from the TOTP before submitting', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: BEARER_DATA }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2', '  123 456  ']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    await runLogin(BASE_CONFIG, streams, deps)

    const [, verifyInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(verifyInit.body as string).totp).toBe('123456')
  })

  it('re-prompts locally on an empty TOTP submission without calling the server', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: BEARER_DATA }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2', '   ', '123456']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(0)
    // Only 2 fetch calls total: login + one verify-login (the blank TOTP never reached fetch).
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(streams.stderrChunks.join('')).toContain('required')
  })

  it('re-prompts for TOTP on invalid_totp without restarting the whole login', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN } })
      )
      .mockResolvedValueOnce(jsonResponse(422, { code: 'invalid_totp', message: 'nope' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: BEARER_DATA }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2', '111111', '222222']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(0)
    expect(streams.stderrChunks.join('')).toContain('incorrect')
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('restarts the whole flow (re-prompting email/password) on mfa_token_expired', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: 'pending-token-1' } })
      )
      .mockResolvedValueOnce(jsonResponse(401, { code: 'mfa_token_expired', message: 'expired' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: 'pending-token-2' } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: BEARER_DATA }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2', '111111', TEST_EMAIL, 'hunter2', '222222']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(0)
    expect(streams.stderrChunks.join('')).toContain('expired')
    expect(fetchFn).toHaveBeenCalledTimes(4)
    // Second login call re-submits fresh credentials, not a stale pending token.
    const [secondLoginUrl] = fetchFn.mock.calls[2] as [string, RequestInit]
    expect(secondLoginUrl).toBe('https://vault.example.com/api/v1/auth/cli-login')
  })
})

describe('runLogin — AC-3 WebAuthn-only fails closed', () => {
  it('fails closed with a distinct exit code on a non-TOTP challenge shape, without prompting for TOTP', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN, method: 'webauthn' },
        })
      )
    const promptFn = vi.fn(promptSequence([TEST_EMAIL, 'hunter2']))
    const deps: LoginDeps = { fetchFn, prompt: promptFn, env: {}, writeSessionFn: vi.fn() }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.webauthnOnlyUnsupported)
    expect(streams.stderrChunks.join('')).toMatch(/not supported|WebAuthn/i)
    // Only the 2 prompts for email+password ran — no TOTP prompt was ever issued.
    expect(promptFn).toHaveBeenCalledTimes(2)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('runLogin — invalid credentials / native-login-disabled', () => {
  it('maps a 401 to a plain invalid-credentials message and distinct exit code', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { code: 'invalid_credentials', message: 'no' }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'wrong-password']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.invalidCredentials)
    expect(streams.stderrChunks.join('')).toBe('Invalid email or password.\n')
  })

  it('surfaces native_login_disabled distinguishably from a generic auth failure', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { code: 'native_login_disabled', message: 'disabled' }))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.nativeLoginDisabled)
    expect(streams.stderrChunks.join('')).toMatch(/machine-user/i)
  })
})

describe('runLogin — AC-2 empty-submission and interrupt edge cases', () => {
  it('re-prompts locally (usage error) on an empty email without calling fetch', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn()
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence(['   ']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects an empty password locally without calling fetch', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn()
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, '']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a SIGINT mid-prompt (PromptInterruptedError) exits non-zero without writing a session or printing a stack trace', async () => {
    const streams = makeStreams()
    const fetchFn = vi.fn()
    const writeSessionFn = vi.fn()
    const deps: LoginDeps = {
      fetchFn,
      prompt: vi.fn().mockRejectedValue(new PromptInterruptedError()),
      env: {},
      writeSessionFn,
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(writeSessionFn).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(streams.stderrChunks.join('')).toBe('Login cancelled.\n')
    expect(streams.stderrChunks.join('')).not.toMatch(/at .*\.ts|Error:/)
  })

  it('a SIGINT during the TOTP prompt also exits cleanly without storing a session', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { mfaRequired: true, mfaToken: PENDING_MFA_TOKEN } })
      )
    const writeSessionFn = vi.fn()
    let call = 0
    const deps: LoginDeps = {
      fetchFn,
      prompt: async () => {
        call += 1
        if (call <= 2) return call === 1 ? TEST_EMAIL : 'hunter2'
        throw new PromptInterruptedError()
      },
      env: {},
      writeSessionFn,
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(writeSessionFn).not.toHaveBeenCalled()
  })
})

describe('runLogin — unexpected-error hardening', () => {
  it('never leaks the raw response body/tokens into the unexpected-error message', async () => {
    const streams = makeStreams()
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('network died: access-token-value leaked here'))
    const deps: LoginDeps = {
      fetchFn,
      prompt: promptSequence([TEST_EMAIL, 'hunter2']),
      env: {},
      writeSessionFn: vi.fn(),
    }

    const exitCode = await runLogin(BASE_CONFIG, streams, deps)

    expect(exitCode).toBe(EXIT_CODES.unexpected)
    expect(streams.stderrChunks.join('')).toContain('Unexpected error')
  })
})
