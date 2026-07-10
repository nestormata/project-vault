import { describe, expect, it, vi, beforeEach } from 'vitest'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const resolveAuthContextMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({
  getVaultReadiness: getVaultReadinessMock,
}))

vi.mock('$lib/server/auth-guard.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/auth-guard.js')>(
    '$lib/server/auth-guard.js'
  )
  return {
    ...actual,
    resolveAuthContext: resolveAuthContextMock,
  }
})

import { handle } from './hooks.server.js'

function makeEvent(pathname: string, cookieHeader: string | null = null) {
  const headers = new Headers()
  if (cookieHeader) headers.set('cookie', cookieHeader)
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`, { headers }),
    setHeaders: vi.fn(),
    locals: {} as { user: unknown },
  }
}

const resolveMock = vi.fn(async () => new Response('ok', { status: 200 }))

describe('hooks.server handle', () => {
  beforeEach(() => {
    getVaultReadinessMock.mockReset()
    resolveAuthContextMock.mockReset()
    resolveMock.mockClear()
    getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
    resolveAuthContextMock.mockResolvedValue({ status: 'unauthenticated' })
  })

  it('sets frame protection headers on every request', async () => {
    const event = makeEvent('/dashboard')
    resolveAuthContextMock.mockResolvedValue({
      status: 'authenticated',
      user: { id: 'u1' },
    })

    await handle({ event, resolve: resolveMock } as never)

    expect(event.setHeaders).toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
  })

  it('redirects to /vault when vault readiness is not ready on a checked path', async () => {
    getVaultReadinessMock.mockResolvedValue({ state: 'sealed', message: 'sealed' })
    const event = makeEvent('/login')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/vault')
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('does not check vault readiness for the /vault path itself', async () => {
    const event = makeEvent('/vault')

    await handle({ event, resolve: resolveMock } as never)

    expect(getVaultReadinessMock).not.toHaveBeenCalled()
    expect(resolveMock).toHaveBeenCalled()
  })

  it('does not check vault readiness for an unrelated path outside root/protected/auth', async () => {
    const event = makeEvent('/pricing')

    await handle({ event, resolve: resolveMock } as never)

    expect(getVaultReadinessMock).not.toHaveBeenCalled()
  })

  it('redirects unauthenticated users away from a protected app path, with a reason when present', async () => {
    resolveAuthContextMock.mockResolvedValue({
      status: 'unauthenticated',
      reason: 'session-expired',
    })
    const event = makeEvent('/dashboard')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login?reason=session-expired')
    expect(event.locals.user).toBeNull()
  })

  it('redirects unauthenticated users to /login without a reason query when none is given', async () => {
    resolveAuthContextMock.mockResolvedValue({ status: 'unauthenticated' })
    const event = makeEvent('/projects')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(response.headers.get('location')).toBe('/login')
  })

  it('redirects an authenticated user away from an auth path (login) to /dashboard', async () => {
    resolveAuthContextMock.mockResolvedValue({
      status: 'authenticated',
      user: { id: 'u1' },
    })
    const event = makeEvent('/login')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  it('forwards refresh set-cookie headers onto the final resolved response', async () => {
    resolveAuthContextMock.mockImplementation(async ({ forwardSetCookie }) => {
      forwardSetCookie?.('access-token=abc123; Path=/; HttpOnly')
      return { status: 'authenticated', user: { id: 'u1' } }
    })
    const event = makeEvent('/dashboard')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(response.headers.get('set-cookie')).toContain('access-token=abc123')
  })

  it('sets locals.user to the authenticated user and resolves normally on an unprotected, non-auth path', async () => {
    resolveAuthContextMock.mockResolvedValue({
      status: 'authenticated',
      user: { id: 'u2', orgRole: 'member' },
    })
    const event = makeEvent('/health')

    const response = await handle({ event, resolve: resolveMock } as never)

    expect(event.locals.user).toEqual({ id: 'u2', orgRole: 'member' })
    expect(resolveMock).toHaveBeenCalledWith(event)
    expect(await response.text()).toBe('ok')
  })
})
