// Story 68.6 AC-6 (Nestor 2026-10-02, Q1) — with a CM header contribution that adds, changes and
// removes headers, extension-panel paths keep exactly today's panel headers: the frozen panel
// branch is outside the composed policy. Also proves the derived protected paths from the server
// virtual module reach PV's gate.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getExtensionPanelCspHeaders } from '$lib/security/hardening.js'
import type { HeaderPolicy } from '$lib/security/header-policy.js'
import { fakeKitRequest } from '$lib/server/composition/kit-request-test-helpers.js'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const resolveAuthContextMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({ getVaultReadiness: getVaultReadinessMock }))
vi.mock('$lib/server/auth-guard.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/auth-guard.js')>(
    '$lib/server/auth-guard.js'
  )
  return { ...actual, resolveAuthContext: resolveAuthContextMock }
})
vi.mock('virtual:pv-hooks/server', () => ({
  hooks: {
    headerPolicy: (pv: HeaderPolicy): HeaderPolicy => ({
      ...pv,
      defaults: { 'content-security-policy': "default-src 'self'", 'x-cm': 'added' },
      rules: [
        ...pv.rules,
        { id: 'cm-panels', match: { startsWith: '/extensions/' }, headers: { 'x-cm': 'rule' } },
      ],
    }),
  },
  protectedPaths: { routeIds: ['/(app)/cm-area'], add: [], remove: [] },
}))

import { handle } from './hooks.server.js'

beforeEach(() => {
  getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
  resolveAuthContextMock.mockResolvedValue({ status: 'authenticated', user: { id: 'u1' } })
})

describe('hooks.server with a CM contribution', () => {
  it('panel paths keep exactly the frozen panel headers (no CM delta reaches them)', async () => {
    for (const path of ['/extensions/panels/group', '/extensions/panels/group/a/b']) {
      const req = fakeKitRequest(path, { routeId: '/(app)/extensions/panels/[slot]/[...subpath]' })
      await handle({ event: req.event, resolve: req.resolve } as never)
      expect(req.setHeadersCalls).toEqual([getExtensionPanelCspHeaders()])
    }
  })

  it('every other path gets the composed policy (bare /extensions/panels included)', async () => {
    const bare = fakeKitRequest('/extensions/panels')
    await handle({ event: bare.event, resolve: bare.resolve } as never)
    expect(bare.setHeadersCalls).toEqual([{ 'x-cm': 'rule' }])
    const page = fakeKitRequest('/dashboard', { routeId: '/(app)/dashboard' })
    await handle({ event: page.event, resolve: page.resolve } as never)
    expect(page.setHeadersCalls).toEqual([
      { 'content-security-policy': "default-src 'self'", 'x-cm': 'added' },
    ])
  })

  it('derived protected route ids from the virtual module gate anonymous requests', async () => {
    resolveAuthContextMock.mockResolvedValue({ status: 'unauthenticated' })
    const req = fakeKitRequest('/cm-area', { routeId: '/(app)/cm-area' })
    const response = await handle({ event: req.event, resolve: req.resolve } as never)
    expect(response.headers.get('location')).toBe('/login')
  })
})
