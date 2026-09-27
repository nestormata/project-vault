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

import { handle, checkHandoffCorsBootWarning } from './hooks.server.js'

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

  // AC5.20 (Story 30.5): the handoff confirmation page is the first (auth)-group page whose sole
  // purpose is a single consent click, making UI-redress (iframe overlay) attacks a relevant
  // threat class. Confirms by test, rather than assuming, that it inherits the same app-wide
  // frame-protection headers as any other route -- no per-route opt-out exists for it.
  // Story 60.3 AC4: superseded by the route-scoped getHandoffSecurityHeaders() branch below —
  // /handoff now gets its own Referrer-Policy header alongside (not instead of) the same
  // frame-protection headers AC5.20 originally required.
  it('sets frame-protection headers plus a Referrer-Policy on the handoff confirmation route (AC5.20, Story 60.3 AC4)', async () => {
    const event = makeEvent('/handoff')

    await handle({ event, resolve: resolveMock } as never)

    expect(event.setHeaders).toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin',
    })
  })

  // Story 60.3 AC4 — precision requirement: a near-miss path must still get the app-wide default
  // headers, never accidentally routed into the handoff-specific branch.
  it('does not apply the handoff-specific Referrer-Policy header to a near-miss path', async () => {
    const event = makeEvent('/handoff-admin')

    await handle({ event, resolve: resolveMock } as never)

    expect(event.setHeaders).toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
  })

  it('sets a tighter, route-scoped CSP on the extension panel route instead of the general frame-protection headers (Story 29.1 code-review hardening)', async () => {
    const event = makeEvent('/extensions/panels/group')
    resolveAuthContextMock.mockResolvedValue({
      status: 'authenticated',
      user: { id: 'u1' },
    })

    await handle({ event, resolve: resolveMock } as never)

    expect(event.setHeaders).toHaveBeenCalledWith({
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
    expect(event.setHeaders).not.toHaveBeenCalledWith({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
  })

  it('applies the extension panel CSP for a nested subpath too, not just the bare slot', async () => {
    const event = makeEvent('/extensions/panels/group/some/nested/subpath')
    resolveAuthContextMock.mockResolvedValue({
      status: 'authenticated',
      user: { id: 'u1' },
    })

    await handle({ event, resolve: resolveMock } as never)

    expect(event.setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        'content-security-policy': expect.stringContaining("img-src 'none'"),
      })
    )
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
    // Story 15.1: resolve is now always called with a transformPageChunk option (substitutes
    // %paraglide.lang% in app.html), so this asserts the event only, not exact-args equality.
    expect(resolveMock).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ transformPageChunk: expect.any(Function) })
    )
    expect(await response.text()).toBe('ok')
  })

  // Story 15.1 AC 7 edge — a tampered/garbage PARAGLIDE_LOCALE cookie must never crash SSR; it
  // falls back to the base locale ('en') via Paraglide's own strategy chain
  // (['cookie', 'baseLocale']), not a hand-rolled guard.
  it('falls back to en in %paraglide.lang% substitution when the locale cookie is garbage', async () => {
    const event = makeEvent('/pricing', 'PARAGLIDE_LOCALE=not-a-real-locale')
    const echoResolve = vi.fn(
      async (
        _ev: unknown,
        opts?: {
          transformPageChunk?: (c: { html: string }) => string | Promise<string | undefined>
        }
      ) =>
        new Response(
          await opts?.transformPageChunk?.({ html: '<html lang="%paraglide.lang%">' })
        ) as Response
    )

    const response = await handle({ event, resolve: echoResolve } as never)

    expect(await response.text()).toBe('<html lang="en">')
  })

  it('substitutes %paraglide.lang% with a valid, explicitly-selected locale cookie', async () => {
    const event = makeEvent('/pricing', 'PARAGLIDE_LOCALE=es')
    const echoResolve = vi.fn(
      async (
        _ev: unknown,
        opts?: {
          transformPageChunk?: (c: { html: string }) => string | Promise<string | undefined>
        }
      ) =>
        new Response(
          await opts?.transformPageChunk?.({ html: '<html lang="%paraglide.lang%">' })
        ) as Response
    )

    const response = await handle({ event, resolve: echoResolve } as never)

    expect(await response.text()).toBe('<html lang="es">')
  })
})

// AC4 (Story 60.1) — boot-time warning when handoff is enabled but apps/web's own
// CORS_ALLOWED_ORIGINS has no non-PV origin (F1's "no PV-side log line" gap). Tested directly
// against the extracted function, not only through hooks.server's module-scope call site, per
// the story's own elicitation finding: the function itself must be pure/non-throwing/silent by
// default, since a bare top-level call re-executes on every test-file import.
describe('checkHandoffCorsBootWarning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('warns when handoff is enabled and the allowlist contains only the PV origin', () => {
    checkHandoffCorsBootWarning({
      VAULT_HANDOFF_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      ORIGIN: 'http://localhost:5173',
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[handoff] WARN')
    expect(warnSpy.mock.calls[0]?.[0]).toContain('CORS_ALLOWED_ORIGINS')
  })

  it('warns when handoff is enabled and the allowlist is empty', () => {
    checkHandoffCorsBootWarning({
      VAULT_HANDOFF_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: undefined,
      ORIGIN: 'http://localhost:5173',
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('does not warn when handoff is enabled and a non-PV origin is present', () => {
    checkHandoffCorsBootWarning({
      VAULT_HANDOFF_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173,https://app.centralizeme.com',
      ORIGIN: 'http://localhost:5173',
    })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when handoff is disabled, regardless of the allowlist', () => {
    checkHandoffCorsBootWarning({
      VAULT_HANDOFF_ENABLED: 'false',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      ORIGIN: 'http://localhost:5173',
    })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when VAULT_HANDOFF_ENABLED is unset', () => {
    checkHandoffCorsBootWarning({
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      ORIGIN: 'http://localhost:5173',
    })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  // Elicitation finding (Pre-mortem, integrated) — the fourth required case: with every relevant
  // env var absent/undefined (the default state in a bare vitest run with no .env loaded), the
  // call must throw nothing and print nothing.
  it('throws nothing and warns nothing when every relevant env var is absent', () => {
    expect(() => checkHandoffCorsBootWarning({})).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
