import { describe, expect, it, beforeEach } from 'vitest'
import type { UIPanel } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../__tests__/helpers/org-role-test-helpers.js'
import { createUnsealedRouteSuite } from '../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from './loader.js'
import type { ExtensionState } from './loader.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof import('../app.js').createApp>>

const TEST_PASSPHRASE = 'extension-panel-route-passphrase'
const PANEL_URL = (slot: string) => `/api/v1/extensions/panels/${slot}`
const NAV_URL = '/api/v1/extensions/nav'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function loadedState(overrides: { capabilities?: string[]; uiPanel?: UIPanel }): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
    },
    loadedAt: new Date().toISOString(),
    hooks: overrides.uiPanel ? { uiPanel: overrides.uiPanel } : {},
  }
}

async function getPanel(app: TestApp, slot: string, cookies?: CookieJar) {
  return app.inject({
    method: 'GET',
    url: PANEL_URL(slot),
    headers: cookies ? { cookie: cookieHeader(cookies) } : {},
  })
}

async function getNav(app: TestApp, cookies?: CookieJar) {
  return app.inject({
    method: 'GET',
    url: NAV_URL,
    headers: cookies ? { cookie: cookieHeader(cookies) } : {},
  })
}

describe.sequential('GET /api/v1/extensions/panels/:slot (Story 25.1)', () => {
  suite.registerLifecycle()

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  it('AC1: an unauthenticated request is rejected before the hook is ever invoked', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: '<p>should not run</p>' }) } })
    )
    const res = await getPanel(suite.app, 'group')
    expect(res.statusCode).toBe(401)
  })

  it('AC1: any active org member (not just admin) can reach a loaded panel', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: '<p>hello</p>' }) } })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-member', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, html: '<p>hello</p>' })
  })

  it('AC2: renders using the session-resolved identity, never a client-supplied one', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: async (context) => ({ html: JSON.stringify(context) }),
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-identity', 'viewer')

    const res = await suite.app.inject({
      method: 'GET',
      url: PANEL_URL('group'),
      headers: { cookie: cookieHeader(member.cookies), 'x-user-id': 'attacker-supplied-id' },
    })

    expect(res.statusCode).toBe(200)
    // The hook only ever receives { slot } — no identity/org claim is ever forwarded to it.
    expect(res.json<{ html: string }>().html).toBe(JSON.stringify({ slot: 'group' }))
  })

  it('AC3: a hook that throws degrades to a calm panel_unavailable response, never a raw 500', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: async () => {
            throw new Error('boom')
          },
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-throw', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
    expect(JSON.stringify(res.json())).not.toContain('boom')
  })

  it('AC3: a hook that returns a malformed result degrades to panel_unavailable', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 42 }) as never } })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-malformed', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
  })

  it('AC3 Boundary & Edge Case Sweep: the extension unloading between nav-render and click-through still degrades calmly', async () => {
    // Simulates the real window: valid when nav rendered, gone by request time.
    __resetExtensionStateForTests()
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-unloaded', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
  })

  it('AC3: a loaded extension with no uiPanel hook degrades to panel_unavailable', async () => {
    __setExtensionStateForTests(loadedState({}))
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-no-hook', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
  })

  // Note: an empty slot value cannot be expressed as a real `GET /panels/:slot` route param (a
  // literal empty path segment does not match Fastify's route), so that case is exercised at the
  // unit level (extension-panel.test.ts) instead — this route-level sweep covers the
  // well-formed-but-invalid values that DO reach the handler as a real route param.
  it.each([
    ['oversized', 'a'.repeat(65)],
    ['wrong-charset', 'Group!'],
    ['not-the-known-slot', 'document'],
  ])('AC3b: a %s slot value returns 400 before the hook is ever called', async (_label, slot) => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'should not run' }) } })
    )
    const member = await createDirectAuthenticatedUser(suite.app, `panel-slot-${_label}`, 'member')

    const res = await getPanel(suite.app, slot, member.cookies)

    expect(res.statusCode).toBe(400)
    expect(res.json<{ ok?: unknown }>()).not.toHaveProperty('ok')
  })
})

describe.sequential('GET /api/v1/extensions/nav (Story 25.1 AC5)', () => {
  suite.registerLifecycle()

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  it('rejects an unauthenticated request', async () => {
    const res = await getNav(suite.app)
    expect(res.statusCode).toBe(401)
  })

  it('AC5: uiPanelSlot is null when no extension is loaded', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'nav-not-loaded', 'member')
    const res = await getNav(suite.app, member.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uiPanelSlot: null })
  })

  it('AC5: uiPanelSlot is null when the loaded extension does not declare ui-panel', async () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['auth-provider'] }))
    const member = await createDirectAuthenticatedUser(suite.app, 'nav-no-uipanel', 'member')
    const res = await getNav(suite.app, member.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uiPanelSlot: null })
  })

  it('AC5: uiPanelSlot is the fixed "group" slot when the loaded extension declares ui-panel', async () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['ui-panel'] }))
    const member = await createDirectAuthenticatedUser(suite.app, 'nav-uipanel', 'member')
    const res = await getNav(suite.app, member.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uiPanelSlot: 'group' })
  })
})
