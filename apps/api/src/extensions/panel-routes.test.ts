import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { organizations, projectMemberships, projects, users } from '@project-vault/db/schema'
import type { UIPanel, UIPanelContext } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../__tests__/helpers/org-role-test-helpers.js'
import { createUnsealedRouteSuite } from '../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { __resetThemeStateForTests, reloadThemes } from '../modules/theming/service.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from './loader.js'
import type { ExtensionState } from './loader.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof import('../app.js').createApp>>

const TEST_PASSPHRASE = 'extension-panel-route-passphrase'
const PANEL_URL = (slot: string) => `/api/v1/extensions/panels/${slot}`
const NAV_URL = '/api/v1/extensions/nav'
const SHOULD_NOT_RUN_HTML = 'should not run'
const ACME_BRAND_THEME = 'acme-brand'

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

async function getPanel(
  app: TestApp,
  slot: string,
  cookies?: CookieJar,
  query?: Record<string, string>
) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
  return app.inject({
    method: 'GET',
    url: `${PANEL_URL(slot)}${qs}`,
    headers: cookies ? { cookie: cookieHeader(cookies) } : {},
  })
}

/** Story 25.3 Task 6 — direct-insert helper, no vault involvement needed: a bare `projects` row
 * plus (optionally) a `project_memberships` row is all `callerCanSeeProject()` reads. */
async function createProjectDirect(orgId: string): Promise<string> {
  const id = randomUUID()
  await withOrg(orgId, (tx) =>
    tx.insert(projects).values({ id, orgId, name: 'panel-test-project', slug: `panel-${id}` })
  )
  return id
}

async function addProjectMembershipDirect(
  orgId: string,
  projectId: string,
  userId: string,
  role: string
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(projectMemberships).values({ orgId, projectId, userId, role })
  )
}

async function setUserLocaleDirect(userId: string, locale: 'en' | 'es'): Promise<void> {
  await getDb().update(users).set({ locale }).where(eq(users.id, userId))
}

async function setUserThemeSelectionDirect(
  userId: string,
  selectedThemeName: string | null
): Promise<void> {
  await getDb().update(users).set({ selectedThemeName }).where(eq(users.id, userId))
}

async function setOrgDefaultThemeDirect(
  orgId: string,
  defaultThemeName: string | null
): Promise<void> {
  await getDb().update(organizations).set({ defaultThemeName }).where(eq(organizations.id, orgId))
}

function contextEchoState(): ExtensionState {
  return loadedState({
    capabilities: ['ui-panel'],
    uiPanelSlots: ['group'],
    uiPanel: {
      onRenderPanel: async (context: UIPanelContext) => ({ html: JSON.stringify(context) }),
    },
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

  it('Story 25.3 AC1: renders using the session-resolved identity/org, never a client-supplied one', async () => {
    __setExtensionStateForTests(contextEchoState())
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-identity', 'viewer')

    const res = await suite.app.inject({
      method: 'GET',
      url: PANEL_URL('group'),
      headers: { cookie: cookieHeader(member.cookies), 'x-user-id': 'attacker-supplied-id' },
    })

    expect(res.statusCode).toBe(200)
    const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
    // Identity/org come straight from the resolved session — never the spoofed header, and
    // AC6: identity is exactly { userId, orgRole }.
    expect(context.identity).toEqual({ userId: member.userId, orgRole: 'viewer' })
    expect(context.orgId).toBe(member.orgId)
    expect(Object.keys(context.identity).sort()).toEqual(['orgRole', 'userId'])
    expect(context).not.toHaveProperty('sessionId')
    expect(context).not.toHaveProperty('jti')
    expect(context).not.toHaveProperty('isPlatformOperator')
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
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }) } })
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
          onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }),
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

describe.sequential('GET /api/v1/extensions/panels/:slot (Story 25.3 context)', () => {
  suite.registerLifecycle()

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  describe('AC2: projectId authorization', () => {
    it('an authorized member (project_memberships row) gets projectId in context', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-project-member',
        'member'
      )
      const projectId = await createProjectDirect(member.orgId)
      await addProjectMembershipDirect(member.orgId, projectId, member.userId, 'viewer')

      const res = await getPanel(suite.app, 'group', member.cookies, { projectId })

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.projectId).toBe(projectId)
    })

    it('org owner/admin bypass: sees projectId with no project_memberships row at all', async () => {
      __setExtensionStateForTests(contextEchoState())
      const owner = await createDirectAuthenticatedUser(suite.app, 'panel-project-owner', 'owner')
      const projectId = await createProjectDirect(owner.orgId)

      const res = await getPanel(suite.app, 'group', owner.cookies, { projectId })

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.projectId).toBe(projectId)
    })

    it('an unauthorized member (real project, no membership row, not owner/admin) gets the same panel_unavailable shape as a transient failure, hook never invoked', async () => {
      const onRenderPanel = vi.fn(async () => ({ html: SHOULD_NOT_RUN_HTML }))
      __setExtensionStateForTests(
        loadedState({
          capabilities: ['ui-panel'],
          uiPanelSlots: ['group'],
          uiPanel: { onRenderPanel },
        })
      )
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-project-denied',
        'member'
      )
      const projectId = await createProjectDirect(member.orgId)
      // Deliberately no project_memberships row for `member`.

      const res = await getPanel(suite.app, 'group', member.cookies, { projectId })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: false, reason: 'panel_unavailable' })
      expect(onRenderPanel).not.toHaveBeenCalled()
    })

    it('a malformed projectId 400s before any DB lookup', async () => {
      const onRenderPanel = vi.fn(async () => ({ html: SHOULD_NOT_RUN_HTML }))
      __setExtensionStateForTests(
        loadedState({
          capabilities: ['ui-panel'],
          uiPanelSlots: ['group'],
          uiPanel: { onRenderPanel },
        })
      )
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-project-malformed',
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies, { projectId: 'not-a-uuid' })

      expect(res.statusCode).toBe(400)
      expect(onRenderPanel).not.toHaveBeenCalled()
    })

    it('omitted projectId leaves it undefined in context', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-project-omitted',
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.projectId).toBeUndefined()
    })
  })

  describe('AC3: locale resolution', () => {
    it("uses the caller's stored locale", async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(suite.app, 'panel-locale-es', 'member')
      await setUserLocaleDirect(member.userId, 'es')

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.locale).toBe('es')
    })

    it('falls back to en for a legacy row with no stored locale', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-locale-default',
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.locale).toBe('en')
    })
  })

  describe('AC4: theme resolution', () => {
    beforeEach(async () => {
      await __resetThemeStateForTests()
    })

    it('personal selection wins when currently valid', async () => {
      await reloadThemes('/fixture/themes', {
        readdir: async () => ['midnight.json'],
        stat: async () => ({ size: 64 }),
        readFileBounded: async () =>
          JSON.stringify({ name: 'midnight', tokens: { radiusMd: '4px' } }),
      })
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-theme-personal',
        'member'
      )
      await setUserThemeSelectionDirect(member.userId, 'midnight')

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.theme).toEqual({ name: 'midnight' })
    })

    it('falls back to the org default when no personal selection is set', async () => {
      await reloadThemes('/fixture/themes', {
        readdir: async () => ['acme-brand.json'],
        stat: async () => ({ size: 64 }),
        readFileBounded: async () =>
          JSON.stringify({ name: ACME_BRAND_THEME, tokens: { radiusMd: '4px' } }),
      })
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-theme-org-default',
        'member'
      )
      await setOrgDefaultThemeDirect(member.orgId, ACME_BRAND_THEME)

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.theme).toEqual({ name: ACME_BRAND_THEME })
    })

    it("an orphaned personal selection falls through to base (null), matching resolveAppliedThemeWithOrgDefault's own fallthrough rule", async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-theme-orphaned',
        'member'
      )
      await setUserThemeSelectionDirect(member.userId, 'deleted-theme')

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.theme).toEqual({ name: null })
    })

    it('no selection and no org default resolves to base (null)', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(suite.app, 'panel-theme-base', 'member')

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.theme).toEqual({ name: null })
    })
  })

  describe('AC5: resourceId shape validation and pass-through', () => {
    it('a shape-valid resourceId is passed through verbatim', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-resource-valid',
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies, { resourceId: 'grp_42' })

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.resourceId).toBe('grp_42')
    })

    it.each([
      ['overlong', 'a'.repeat(129)],
      ['path-traversal-shaped', '../../etc/passwd'],
    ])('a %s resourceId 400s before the hook is ever called', async (_label, resourceId) => {
      const onRenderPanel = vi.fn(async () => ({ html: SHOULD_NOT_RUN_HTML }))
      __setExtensionStateForTests(
        loadedState({
          capabilities: ['ui-panel'],
          uiPanelSlots: ['group'],
          uiPanel: { onRenderPanel },
        })
      )
      const member = await createDirectAuthenticatedUser(
        suite.app,
        `panel-resource-${_label}`,
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies, { resourceId })

      expect(res.statusCode).toBe(400)
      expect(onRenderPanel).not.toHaveBeenCalled()
    })
  })

  describe('AC6: identity minimality', () => {
    it('the response never contains sessionId/jti/isPlatformOperator', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(suite.app, 'panel-ac6-minimal', 'member')

      const res = await getPanel(suite.app, 'group', member.cookies)

      const raw = JSON.stringify(res.json())
      expect(raw).not.toContain('sessionId')
      expect(raw).not.toContain('jti')
      expect(raw).not.toContain('isPlatformOperator')
      expect(raw).not.toContain('sessionVersion')
    })
  })

  describe('AC1 Boundary & Edge Case Sweep: concurrent requests never cross-contaminate', () => {
    it('two concurrent requests from different users/orgs each see only their own identity/orgId/locale', async () => {
      __setExtensionStateForTests(contextEchoState())
      const memberA = await createDirectAuthenticatedUser(suite.app, 'panel-concurrent-a', 'member')
      const memberB = await createDirectAuthenticatedUser(suite.app, 'panel-concurrent-b', 'owner')
      await setUserLocaleDirect(memberA.userId, 'en')
      await setUserLocaleDirect(memberB.userId, 'es')

      const [resA, resB] = await Promise.all([
        getPanel(suite.app, 'group', memberA.cookies),
        getPanel(suite.app, 'group', memberB.cookies),
      ])

      expect(resA.statusCode).toBe(200)
      expect(resB.statusCode).toBe(200)
      const contextA = JSON.parse(resA.json<{ html: string }>().html) as UIPanelContext
      const contextB = JSON.parse(resB.json<{ html: string }>().html) as UIPanelContext

      expect(contextA.identity.userId).toBe(memberA.userId)
      expect(contextA.orgId).toBe(memberA.orgId)
      expect(contextA.locale).toBe('en')
      expect(contextB.identity.userId).toBe(memberB.userId)
      expect(contextB.orgId).toBe(memberB.orgId)
      expect(contextB.locale).toBe('es')
      expect(contextA.identity.userId).not.toBe(contextB.identity.userId)
      expect(contextA.orgId).not.toBe(contextB.orgId)
    })
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
