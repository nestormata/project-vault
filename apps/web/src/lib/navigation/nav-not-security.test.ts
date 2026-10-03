// Story 68.7 AC-7 (design rule 4: nav is not security) and AC-12 (no new request). Hiding a PV nav
// item never protects its route and never changes how PV answers it: the route stays PV's normal
// page for a signed-in user and the protected-path redirect for an anonymous one. Use protected
// paths or the API's authorization to restrict access, never a hidden nav item. And the nav adds
// no fetch: the (app) layout load makes the same API calls with or without a delta.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const holder = vi.hoisted(() => ({ delta: {} as unknown }))
const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const resolveAuthContextMock = vi.hoisted(() => vi.fn())
const api = vi.hoisted(() => ({
  onboarding: vi.fn(),
  projects: vi.fn(),
  usersMe: vi.fn(),
  themes: vi.fn(),
  extensionNav: vi.fn(),
}))

vi.mock('$lib/navigation/active-delta.js', () => ({
  get activeDelta() {
    return holder.delta
  },
}))
vi.mock('$lib/api/vault.js', () => ({ getVaultReadiness: getVaultReadinessMock }))
vi.mock('$lib/server/auth-guard.js', async () => ({
  ...(await vi.importActual<typeof import('$lib/server/auth-guard.js')>(
    '$lib/server/auth-guard.js'
  )),
  resolveAuthContext: resolveAuthContextMock,
}))
vi.mock('$lib/api/onboarding.js', () => ({ getOnboardingStatus: api.onboarding }))
vi.mock('$lib/api/projects.js', () => ({ listProjects: api.projects }))
vi.mock('$lib/api/inbox.js', () => ({ getUsersMe: api.usersMe }))
vi.mock('$lib/api/themes.js', () => ({ getThemes: api.themes }))
vi.mock('$lib/api/extension-panel.js', () => ({ getExtensionNav: api.extensionNav }))

import { handle } from '../../hooks.server.js'
import { load } from '../../routes/(app)/+layout.server.js'
import { renderSurface } from './build-surface.js'

const HIDE_SECURITY = {
  'settings.index': [{ op: 'hide', id: 'settings.index.security' }],
  primary: [{ op: 'remove', id: 'primary.settings' }],
}

function event(pathname: string) {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`),
    setHeaders: vi.fn(),
    locals: {} as { user: unknown },
  }
}

const resolve = vi.fn(async () => new Response('PV page', { status: 200 }))

beforeEach(() => {
  holder.delta = {}
  resolve.mockClear()
  getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
  api.onboarding.mockResolvedValue({ completed: true })
  api.usersMe.mockResolvedValue({ notifications: { unreadCount: 1 } })
  api.themes.mockResolvedValue({ themes: [], selected: null, orgDefaultThemeName: null })
  api.extensionNav.mockResolvedValue({ uiPanelSlot: null })
})

describe('a hidden nav item is not access control (Story 68.7 AC-7, design rule 4)', () => {
  it('the hidden item is gone from the nav, yet its route answers exactly as before', async () => {
    holder.delta = HIDE_SECURITY
    expect(renderSurface('settings.index', { pathname: '/' }).map((n) => n.id)).not.toContain(
      'settings.index.security'
    )

    resolveAuthContextMock.mockResolvedValue({ status: 'authenticated', user: { id: 'u1' } })
    const signedIn = await handle({ event: event('/settings/security'), resolve } as never)
    expect(signedIn.status).toBe(200)
    expect(await signedIn.text()).toBe('PV page')

    resolveAuthContextMock.mockResolvedValue({ status: 'unauthenticated' })
    const anonymous = await handle({ event: event('/settings/security'), resolve } as never)
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toBe('/login')
  })
})

describe('the nav adds no request (Story 68.7 AC-12)', () => {
  async function calls(delta: unknown): Promise<number[]> {
    holder.delta = delta
    for (const fn of Object.values(api)) fn.mockClear()
    const fetch = vi.fn()
    await load({ fetch, locals: { user: { id: 'u1', orgRole: 'owner' } } } as never)
    return [...Object.values(api).map((fn) => fn.mock.calls.length), fetch.mock.calls.length]
  }

  it('the (app) layout load makes the same calls with and without a delta', async () => {
    const without = await calls({})
    expect(await calls(HIDE_SECURITY)).toEqual(without)
    // onboarding, users/me, themes and the (frozen) extension nav once each; no direct fetch.
    expect(without).toEqual([1, 0, 1, 1, 1, 0])
  })
})
