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

function loadedState(overrides: {
  capabilities?: string[]
  uiPanel?: UIPanel
  uiPanelSlots?: string[]
  loadedAt?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
      ...(overrides.uiPanelSlots ? { uiPanelSlots: overrides.uiPanelSlots } : {}),
    },
    loadedAt: overrides.loadedAt ?? new Date().toISOString(),
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

  it('AC3: a slot declared in the extension manifest but not in the legacy default now renders 200 — the concrete regression this story fixes', async () => {
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', 'document'],
        uiPanel: {
          onRenderPanel: async (context) => ({ html: `rendered:${context.slot}` }),
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-dynamic-slot', 'member')

    const res = await getPanel(suite.app, 'document', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, html: 'rendered:document' })
  })

  it('AC3: a real slot owned by a DIFFERENT panel feature but not declared by this extension still 400s, never reaching the hook', async () => {
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', 'document'],
        uiPanel: {
          onRenderPanel: async () => ({ html: 'should not run' }),
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-undeclared-slot', 'member')

    const res = await getPanel(suite.app, 'project-container', member.cookies)

    expect(res.statusCode).toBe(400)
    expect(res.json<{ ok?: unknown }>()).not.toHaveProperty('ok')
  })

  it('AC3 Boundary & Edge Case Sweep: a mid-lifetime reload with a renamed/removed slot resolves fresh on the very next request', async () => {
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', 'document'],
        uiPanel: { onRenderPanel: async (context) => ({ html: `ok:${context.slot}` }) },
        loadedAt: '2026-01-01T00:00:00.000Z',
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-reload-slot', 'member')

    const firstRes = await getPanel(suite.app, 'document', member.cookies)
    expect(firstRes.statusCode).toBe(200)

    // Extension redeployed/reloaded mid-process with 'document' renamed away.
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', 'classification'],
        uiPanel: { onRenderPanel: async (context) => ({ html: `ok:${context.slot}` }) },
        loadedAt: '2026-01-01T00:05:00.000Z',
      })
    )

    const secondRes = await getPanel(suite.app, 'document', member.cookies)
    expect(secondRes.statusCode).toBe(400)
    expect(secondRes.json<{ ok?: unknown }>()).not.toHaveProperty('ok')
  })

  it("AC6: the fixture extension's previously-workaround-only trigger slots are reachable through the real HTTP route once declared", async () => {
    const throwTriggerSlot = 'fixture-throw'
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['group', throwTriggerSlot, 'fixture-hang', 'fixture-garbage'],
        uiPanel: {
          onRenderPanel: async (context) => {
            if (context.slot === throwTriggerSlot) throw new Error('deterministic throw trigger')
            return { html: `ok:${context.slot}` }
          },
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-fixture-throw', 'member')

    const res = await getPanel(suite.app, throwTriggerSlot, member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
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

  it('AC5: uiPanelSlot is the legacy "group" slot when the loaded extension declares ui-panel without uiPanelSlots (AC2 fallback)', async () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['ui-panel'] }))
    const member = await createDirectAuthenticatedUser(suite.app, 'nav-uipanel', 'member')
    const res = await getNav(suite.app, member.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uiPanelSlot: 'group' })
  })

  it('AC5 (Story 25.2 regression): uiPanelSlot is the FIRST entry of the dynamic manifest-declared list, still exactly one slot reported', async () => {
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        uiPanelSlots: ['document', 'group', 'classification'],
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'nav-uipanel-dynamic', 'member')
    const res = await getNav(suite.app, member.cookies)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ uiPanelSlot: 'document' })
  })
})
