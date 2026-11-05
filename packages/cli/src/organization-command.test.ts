import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import type { SessionData } from './session-store.js'

const { ensureFreshSession } = vi.hoisted(() => ({ ensureFreshSession: vi.fn() }))
vi.mock('./session-refresh.js', () => ({ ensureFreshSession }))

import { runUseOrganization } from './organization-command.js'

const ORGANIZATION_ID = '12345678-1234-1234-1234-123456789abc'
const ORGANIZATION_ACCESS_TOKEN = 'organization-token'
const ORGANIZATION_SESSION_ID = 'org-session-id'
const INVALID_CREDENTIAL_MESSAGE = 'The vault did not issue an organization credential.\n'
const SESSION: SessionData = {
  accessToken: 'user-token',
  refreshToken: 'refresh-token',
  accessExpiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-id',
  scope: 'user',
  baseUrl: 'https://vault.example.com',
}

function streams() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    streams: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
  }
}

function okSession(session: SessionData = SESSION) {
  ensureFreshSession.mockResolvedValue({ status: 'ok', session })
}

describe('runUseOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses a non-UUID before reading a session or making a request', async () => {
    const io = streams()
    const fetchFn = vi.fn()

    const result = await runUseOrganization('not-an-id', io.streams, {
      fetchFn,
      env: {},
      writeSessionFn: vi.fn(),
    })

    expect(result).toBe(EXIT_CODES.unexpected)
    expect(io.stderr).toEqual(['organizationId must be a UUID.\n'])
    expect(ensureFreshSession).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'not_logged_in' }, EXIT_CODES.notLoggedIn],
    [{ status: 'session_expired' }, EXIT_CODES.notLoggedIn],
    [{ status: 'insecure_permissions', path: '/session' }, EXIT_CODES.notLoggedIn],
    [{ status: 'rate_limited', retryAfterSeconds: 3 }, EXIT_CODES.notLoggedIn],
  ] as const)('refuses unavailable user sessions (%j)', async (sessionResult, expectedCode) => {
    ensureFreshSession.mockResolvedValue(sessionResult)
    const io = streams()
    const fetchFn = vi.fn()

    const result = await runUseOrganization(ORGANIZATION_ID, io.streams, {
      fetchFn,
      env: {},
    })

    expect(result).toBe(expectedCode)
    expect(io.stderr.join('')).toContain('pvault login --browser')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses an organization-scoped session', async () => {
    okSession({ ...SESSION, scope: 'org', orgId: ORGANIZATION_ID })
    const io = streams()
    const fetchFn = vi.fn()

    const result = await runUseOrganization(ORGANIZATION_ID, io.streams, {
      fetchFn,
      env: {},
    })

    expect(result).toBe(EXIT_CODES.unexpected)
    expect(io.stderr.join('')).toContain('pvault login --browser')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('mints and stores a separate organization credential without changing the user session', async () => {
    okSession()
    const io = streams()
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            accessToken: ORGANIZATION_ACCESS_TOKEN,
            expiresIn: 900,
            sessionId: ORGANIZATION_SESSION_ID,
            orgId: ORGANIZATION_ID,
          },
        }),
        { status: 200 }
      )
    )
    const writeSessionFn = vi.fn()

    const result = await runUseOrganization(ORGANIZATION_ID, io.streams, {
      fetchFn,
      env: {},
      writeSessionFn,
    })

    expect(result).toBe(0)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://vault.example.com/api/v1/auth/cli/org',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer user-token',
        },
        body: JSON.stringify({ organizationId: ORGANIZATION_ID }),
      })
    )
    const [written] = writeSessionFn.mock.calls[0] as [SessionData]
    expect(written).toMatchObject({
      ...SESSION,
      orgCredentials: {
        [ORGANIZATION_ID]: {
          accessToken: ORGANIZATION_ACCESS_TOKEN,
          orgId: ORGANIZATION_ID,
          sessionId: ORGANIZATION_SESSION_ID,
        },
      },
    })
    const storedCredentials = Object.values(written.orgCredentials ?? {})
    expect(storedCredentials).toHaveLength(1)
    const storedExpiry = storedCredentials[0]?.accessExpiresAt
    expect(storedExpiry).toBeDefined()
    expect(Date.parse(storedExpiry ?? '')).toBeGreaterThan(Date.now())
    expect(written).not.toHaveProperty('orgId')
    expect(io.stdout.join('')).toContain(ORGANIZATION_ID)
    expect(io.stderr).toEqual([])
  })

  it('does not overwrite credentials for other organizations', async () => {
    const otherOrganization = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const existing: SessionData = {
      ...SESSION,
      orgCredentials: {
        [otherOrganization]: {
          accessToken: 'other-token',
          accessExpiresAt: '2099-01-01T00:00:00.000Z',
          orgId: otherOrganization,
          sessionId: 'other-session',
        },
      },
    }
    okSession(existing)
    const writeSessionFn = vi.fn()

    await runUseOrganization(ORGANIZATION_ID, streams().streams, {
      fetchFn: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              accessToken: 'organization-token',
              expiresIn: 900,
              sessionId: 'org-session-id',
              orgId: ORGANIZATION_ID,
            },
          }),
          { status: 200 }
        )
      ),
      env: {},
      writeSessionFn,
    })

    expect(writeSessionFn).toHaveBeenCalledWith(
      expect.objectContaining({ orgCredentials: expect.objectContaining(existing.orgCredentials) }),
      {}
    )
  })

  it('reports not-a-member without attempting to store anything', async () => {
    okSession()
    const io = streams()
    const writeSessionFn = vi.fn()

    const result = await runUseOrganization(ORGANIZATION_ID, io.streams, {
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
      env: {},
      writeSessionFn,
    })

    expect(result).toBe(EXIT_CODES.unexpected)
    expect(io.stderr).toEqual(['You are not a member of that organization.\n'])
    expect(writeSessionFn).not.toHaveBeenCalled()
  })

  it.each([
    [
      'network error',
      () => Promise.reject(new TypeError('offline')),
      'The vault could not be reached.\n',
    ],
    [
      'unexpected status',
      () => Promise.resolve(new Response(null, { status: 500 })),
      INVALID_CREDENTIAL_MESSAGE,
    ],
    [
      'invalid JSON',
      () => Promise.resolve(new Response('not json', { status: 200 })),
      INVALID_CREDENTIAL_MESSAGE,
    ],
    [
      'missing fields',
      () => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
      INVALID_CREDENTIAL_MESSAGE,
    ],
    [
      'wrong organization',
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                accessToken: 'token',
                expiresIn: 900,
                sessionId: 'session',
                orgId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              },
            }),
            { status: 200 }
          )
        ),
      INVALID_CREDENTIAL_MESSAGE,
    ],
  ] as const)('fails closed for %s', async (_name, response, expectedError) => {
    okSession()
    const io = streams()
    const writeSessionFn = vi.fn()

    const result = await runUseOrganization(ORGANIZATION_ID, io.streams, {
      fetchFn: vi.fn().mockImplementation(response),
      env: {},
      writeSessionFn,
    })

    expect(result).toBe(EXIT_CODES.unexpected)
    expect(io.stderr).toEqual([expectedError])
    expect(writeSessionFn).not.toHaveBeenCalled()
  })
})
