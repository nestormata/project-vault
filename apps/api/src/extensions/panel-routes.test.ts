import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { organizations, projectMemberships, projects, users } from '@project-vault/db/schema'
import type {
  ModuleAction,
  ModuleActionContext,
  UIPanel,
  UIPanelContext,
} from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../__tests__/helpers/org-role-test-helpers.js'
import { createUnsealedRouteSuite } from '../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { __resetThemeStateForTests, reloadThemes } from '../modules/theming/service.js'
import { env } from '../config/env.js'
import { CSRF_HEADER_NAME } from '../lib/csrf.js'
import { csrfCookieName } from '../modules/auth/tokens.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from './loader.js'
import type { ExtensionState } from './loader.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof import('../app.js').createApp>>

const TEST_PASSPHRASE = 'extension-panel-route-passphrase'
const PANEL_URL = (slot: string) => `/api/v1/extensions/panels/${slot}`
const NAV_URL = '/api/v1/extensions/nav'
const SHOULD_NOT_RUN_HTML = 'should not run'
const HELLO_HTML = '<p>hello</p>'
const ACME_BRAND_THEME = 'acme-brand'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function loadedState(overrides: {
  capabilities?: string[]
  uiPanel?: UIPanel
  uiPanelSlots?: string[]
  moduleAction?: ModuleAction
  moduleActions?: string[]
  loadedAt?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
      ...(overrides.uiPanelSlots ? { uiPanelSlots: overrides.uiPanelSlots } : {}),
      ...(overrides.moduleActions ? { moduleActions: overrides.moduleActions } : {}),
    },
    loadedAt: overrides.loadedAt ?? new Date().toISOString(),
    hooks: {
      ...(overrides.uiPanel ? { uiPanel: overrides.uiPanel } : {}),
      ...(overrides.moduleAction ? { moduleAction: overrides.moduleAction } : {}),
    },
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

const ACTION_URL = (slot: string) => `/api/v1/extensions/panels/${slot}/actions`

// Story 25.6 AC1/AC6 — every existing (Story 25.5) test below dispatches through this same helper,
// so it defaults to attaching a MATCHING CSRF cookie/header pair (the double-submit-cookie
// pattern's own "valid token" case) — otherwise every one of those pre-existing happy-path tests
// would now 403 on the new check this story adds, for a reason unrelated to what they're actually
// testing. `'omit'` (no cookie, no header) and an explicit `{ cookieValue, headerValue }` mismatch
// are how this story's own new CSRF-specific tests below exercise the rejection paths.
const DEFAULT_CSRF_TOKEN = 'test-csrf-token-0123456789abcdef'
const CSRF_COOKIE_NAME = csrfCookieName(env.COOKIE_SECURE)

type CsrfOverride = 'omit' | { cookieValue?: string; headerValue?: string }

async function postAction(
  app: TestApp,
  slot: string,
  body: Record<string, unknown>,
  cookies?: CookieJar,
  extraHeaders?: Record<string, string>,
  csrf: CsrfOverride = {}
) {
  const cookieValue = csrf === 'omit' ? undefined : (csrf.cookieValue ?? DEFAULT_CSRF_TOKEN)
  const headerValue = csrf === 'omit' ? undefined : (csrf.headerValue ?? DEFAULT_CSRF_TOKEN)
  const mergedCookies: CookieJar = {
    ...(cookies ?? {}),
    ...(cookieValue !== undefined ? { [CSRF_COOKIE_NAME]: cookieValue } : {}),
  }
  return app.inject({
    method: 'POST',
    url: ACTION_URL(slot),
    headers: {
      ...(Object.keys(mergedCookies).length > 0 ? { cookie: cookieHeader(mergedCookies) } : {}),
      ...(headerValue !== undefined ? { [CSRF_HEADER_NAME]: headerValue } : {}),
      ...extraHeaders,
    },
    payload: body,
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
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: HELLO_HTML }) } })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-member', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, html: HELLO_HTML })
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

  it('Story 25.5 AC4/Task 4: the response includes actionEndpoint when the loaded extension declares moduleActions', async () => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: ['test-action'],
        uiPanel: { onRenderPanel: async () => ({ html: HELLO_HTML }) },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'panel-action-endpoint', 'member')

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      ok: true,
      html: HELLO_HTML,
      actionEndpoint: '/api/v1/extensions/panels/group/actions',
    })
  })

  it('Story 25.5 AC4/Task 4: the response omits actionEndpoint entirely when the loaded extension declares no moduleActions', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: HELLO_HTML }) } })
    )
    const member = await createDirectAuthenticatedUser(
      suite.app,
      'panel-no-action-endpoint',
      'member'
    )

    const res = await getPanel(suite.app, 'group', member.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, html: HELLO_HTML })
    expect(res.json()).not.toHaveProperty('actionEndpoint')
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

  describe('Story 25.8 AC1: subpath shape validation and pass-through, never widens the :slot match', () => {
    it('a shape-valid multi-segment subpath is passed through verbatim into context', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(suite.app, 'panel-subpath-valid', 'member')

      const res = await getPanel(suite.app, 'group', member.cookies, {
        subpath: 'groups/123/detail',
      })

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.subpath).toBe('groups/123/detail')
    })

    it('omitted subpath leaves it undefined in context', async () => {
      __setExtensionStateForTests(contextEchoState())
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-subpath-omitted',
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies)

      expect(res.statusCode).toBe(200)
      const context = JSON.parse(res.json<{ html: string }>().html) as UIPanelContext
      expect(context.subpath).toBeUndefined()
    })

    it.each([
      ['overlong', 'a'.repeat(257)],
      ['path-traversal-shaped', '../../etc/passwd'],
      ['leading-slash', '/groups/123'],
      ['trailing-slash', 'groups/123/'],
      ['empty-segment', 'groups//123'],
    ])('a %s subpath 400s before the hook is ever called', async (_label, subpath) => {
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
        `panel-subpath-${_label}`,
        'member'
      )

      const res = await getPanel(suite.app, 'group', member.cookies, { subpath })

      expect(res.statusCode).toBe(400)
      expect(onRenderPanel).not.toHaveBeenCalled()
    })

    it('a subpath value is NEVER concatenated into the :slot allowlist match — an unknown slot still 400s even with a subpath supplied', async () => {
      const onRenderPanel = vi.fn(async () => ({ html: SHOULD_NOT_RUN_HTML }))
      __setExtensionStateForTests(
        loadedState({ capabilities: ['ui-panel'], uiPanel: { onRenderPanel } })
      )
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'panel-subpath-unknown-slot',
        'member'
      )

      const res = await getPanel(suite.app, 'not-a-known-slot', member.cookies, {
        subpath: 'detail',
      })

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

const ACTION_SLOT = 'group'
const RENAME_ACTION_KIND = 'rename-group'
const CSRF_REJECTED_BODY = { code: 'csrf_rejected', message: 'Request rejected' }

function actionState(
  onAction: ModuleAction['onAction'],
  moduleActions: string[] = [RENAME_ACTION_KIND]
): ExtensionState {
  return loadedState({
    capabilities: ['ui-panel'],
    moduleActions,
    moduleAction: { onAction },
  })
}

describe.sequential('POST /api/v1/extensions/panels/:slot/actions (Story 25.5)', () => {
  suite.registerLifecycle()

  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  it('AC3: an unauthenticated request is rejected before the hook is ever invoked', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(actionState(onAction))
    const res = await postAction(suite.app, ACTION_SLOT, { kind: RENAME_ACTION_KIND })
    expect(res.statusCode).toBe(401)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('AC1/AC5: happy path — an authenticated member dispatches a declared action and gets back { html }', async () => {
    __setExtensionStateForTests(
      actionState(async () => ({ outcome: 'ok', html: '<section>renamed</section>' }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-happy', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND, accessGroupId: 'grp_1' },
      member.cookies
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ html: '<section>renamed</section>' })
  })

  it('AC1: happy path with a message-only success response', async () => {
    __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok', message: 'Saved' })))
    const member = await createDirectAuthenticatedUser(suite.app, 'action-msg', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: 'Saved' })
  })

  it('Task 3: an invalid slot 400s before touching extension state', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(actionState(onAction))
    const member = await createDirectAuthenticatedUser(suite.app, 'action-badslot', 'member')
    const res = await postAction(
      suite.app,
      'not-a-real-slot',
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_slot' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('Task 3: a missing kind field 400s before any DB lookup or hook invocation', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(actionState(onAction))
    const member = await createDirectAuthenticatedUser(suite.app, 'action-nokind', 'member')
    const res = await postAction(suite.app, ACTION_SLOT, { accessGroupId: 'grp_1' }, member.cookies)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_action' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('AC2: an action.kind not in the declared moduleActions list 404s, and the hook is never invoked', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(actionState(onAction, ['add-member']))
    const member = await createDirectAuthenticatedUser(suite.app, 'action-unknown', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: 'delete-everything' },
      member.cookies
    )
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'action_not_found' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('AC2: an extension declaring no moduleActions at all (omitted field) 404s every action request', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(
      loadedState({ capabilities: ['ui-panel'], moduleAction: { onAction } })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-none-declared', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(404)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('AC5: validation_failed maps to 400 and forwards the extension-supplied message', async () => {
    __setExtensionStateForTests(
      actionState(async () => ({ outcome: 'validation_failed', message: 'Name is required' }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-validation', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ message: 'Name is required' })
  })

  it('AC5: denied maps to 403 with a fixed generic message — the extension-supplied message never leaks', async () => {
    __setExtensionStateForTests(
      actionState(async () => ({ outcome: 'denied', message: 'user is not a group owner' }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-denied', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.stringify(res.json())).not.toContain('group owner')
  })

  it('AC5: conflict maps to 409 and forwards the extension-supplied message', async () => {
    __setExtensionStateForTests(
      actionState(async () => ({ outcome: 'conflict', message: 'already renamed' }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-conflict', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ message: 'already renamed' })
  })

  it('AC5: a thrown error degrades to a fixed 500, never the raw exception text', async () => {
    __setExtensionStateForTests(
      actionState(async () => {
        throw new Error('permission denied: row-level policy violation on access_groups')
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'action-throws', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.json())).not.toContain('row-level policy')
  })

  it('AC5: onAction explicitly returning { outcome: "error" } also degrades to a fixed 500', async () => {
    __setExtensionStateForTests(actionState(async () => ({ outcome: 'error' })))
    const member = await createDirectAuthenticatedUser(suite.app, 'action-error', 'member')
    const res = await postAction(
      suite.app,
      ACTION_SLOT,
      { kind: RENAME_ACTION_KIND },
      member.cookies
    )
    expect(res.statusCode).toBe(500)
  })

  describe('AC3: never trusts identity/org claims embedded in the action body', () => {
    it("the context passed to onAction carries the caller's real session orgId/userId regardless of a smuggled body", async () => {
      let seen: ModuleActionContext | undefined
      __setExtensionStateForTests(
        actionState(async (context) => {
          seen = context
          return { outcome: 'ok' }
        })
      )
      const member = await createDirectAuthenticatedUser(suite.app, 'action-smuggle', 'viewer')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND, orgId: 'org-b', userId: 'user-b', projectId: 'proj-b' },
        member.cookies
      )
      expect(res.statusCode).toBe(200)
      expect(seen?.orgId).toBe(member.orgId)
      expect(seen?.identity.userId).toBe(member.userId)
      expect(seen?.identity.orgRole).toBe('viewer')
    })

    it('a structural check: the route handler source never references body.orgId/body.userId/body.projectId', async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url-relative path to this test file's own sibling source, never user input.
      const source = await readFile(
        fileURLToPath(new URL('./panel-routes.ts', import.meta.url)),
        'utf-8'
      )
      expect(source).not.toMatch(/\baction\.orgId\b/)
      expect(source).not.toMatch(/\baction\.userId\b/)
      expect(source).not.toMatch(/\baction\.projectId\b/)
      expect(source).not.toMatch(/\bbody\.orgId\b/)
      expect(source).not.toMatch(/\bbody\.userId\b/)
      expect(source).not.toMatch(/\bbody\.projectId\b/)
    })

    it('a structural check: the module-action handler source never references request.orgId/request.userId/request.projectId', async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url-relative path to a fixed sibling source file, never user input.
      const source = await readFile(
        fileURLToPath(new URL('../lib/module-action-handler.ts', import.meta.url)),
        'utf-8'
      )
      expect(source).not.toMatch(/\brequest\.orgId\b/)
      expect(source).not.toMatch(/\brequest\.userId\b/)
      expect(source).not.toMatch(/\brequest\.projectId\b/)
    })
  })

  describe('Task 2/Open Design Question 1 (Option B, resolved 2026-08-24): Sec-Fetch-Site check', () => {
    it('rejects a request with Sec-Fetch-Site: cross-site', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(actionState(onAction))
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'action-secfetch-cross',
        'member'
      )
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        {
          'sec-fetch-site': 'cross-site',
        }
      )
      expect(res.statusCode).toBe(403)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('rejects a request with Sec-Fetch-Site: same-site (not same-origin)', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(actionState(onAction))
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'action-secfetch-samesite',
        'member'
      )
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        {
          'sec-fetch-site': 'same-site',
        }
      )
      expect(res.statusCode).toBe(403)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('accepts a request with Sec-Fetch-Site: same-origin', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'action-secfetch-same',
        'member'
      )
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        {
          'sec-fetch-site': 'same-origin',
        }
      )
      expect(res.statusCode).toBe(200)
    })

    it('treats a MISSING Sec-Fetch-Site header as pass-through, not rejection (older browsers)', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'action-secfetch-missing',
        'member'
      )
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Story 25.6 AC3/AC6: every action-route outcome pins its exact {code, message} shape (never incidental)', () => {
    it('invalid_slot: exactly { code: "invalid_slot", message: "Unknown or malformed panel slot" }', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(suite.app, 'shape-invalid-slot', 'member')
      const res = await postAction(
        suite.app,
        'not-a-real-slot',
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.json()).toEqual({
        code: 'invalid_slot',
        message: 'Unknown or malformed panel slot',
      })
    })

    it('invalid_action: exactly { code: "invalid_action", message: ... }', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(
        suite.app,
        'shape-invalid-action',
        'member'
      )
      const res = await postAction(suite.app, ACTION_SLOT, {}, member.cookies)
      expect(res.json()).toEqual({
        code: 'invalid_action',
        message: 'Request body must include a string "kind" field',
      })
    })

    it('not_found (action_not_found): exactly { code: "action_not_found", message: "Action not found" }', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' }), ['other-action']))
      const member = await createDirectAuthenticatedUser(suite.app, 'shape-not-found', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.json()).toEqual({ code: 'action_not_found', message: 'Action not found' })
    })

    it('denied: exactly { code: "denied", message: "Request denied" } — never the extension-supplied message', async () => {
      __setExtensionStateForTests(
        actionState(async () => ({ outcome: 'denied', message: 'secret internal reason' }))
      )
      const member = await createDirectAuthenticatedUser(suite.app, 'shape-denied', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.json()).toEqual({ code: 'denied', message: 'Request denied' })
    })

    it('error: exactly { code: "internal_error", message: "Request failed" }', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'error' })))
      const member = await createDirectAuthenticatedUser(suite.app, 'shape-error', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.json()).toEqual({ code: 'internal_error', message: 'Request failed' })
    })

    it('csrf_rejected: exactly { code: "csrf_rejected", message: "Request rejected" }', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(suite.app, 'shape-csrf', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        undefined,
        'omit'
      )
      expect(res.json()).toEqual(CSRF_REJECTED_BODY)
    })
  })

  describe('Story 25.6 AC1/AC2/AC3/AC4/AC6: real CSRF token defense', () => {
    it('AC1/AC6: a request with a valid (matching) CSRF cookie/header pair succeeds', async () => {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok', message: 'done' })))
      const member = await createDirectAuthenticatedUser(suite.app, 'csrf-valid', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies
      )
      expect(res.statusCode).toBe(200)
    })

    it('AC1/AC2/AC3/AC6: a request with NO CSRF cookie/header at all is rejected (403) before the hook is invoked, with the normalized ApiErrorSchema envelope', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(actionState(onAction))
      const member = await createDirectAuthenticatedUser(suite.app, 'csrf-missing', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        undefined,
        'omit'
      )
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual(CSRF_REJECTED_BODY)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('AC1/AC2/AC6: a request whose header does not match the CSRF cookie value is rejected (403), hook never invoked', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(actionState(onAction))
      const member = await createDirectAuthenticatedUser(suite.app, 'csrf-mismatch', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        undefined,
        { cookieValue: 'cookie-value', headerValue: 'a-different-header-value' }
      )
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual(CSRF_REJECTED_BODY)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('AC2: a request with the CSRF cookie but no header at all is rejected, hook never invoked', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(actionState(onAction))
      const member = await createDirectAuthenticatedUser(suite.app, 'csrf-no-header', 'member')
      const res = await postAction(
        suite.app,
        ACTION_SLOT,
        { kind: RENAME_ACTION_KIND },
        member.cookies,
        undefined,
        { cookieValue: 'cookie-only-value', headerValue: undefined }
      )
      expect(res.statusCode).toBe(403)
      expect(onAction).not.toHaveBeenCalled()
    })

    it('AC2: rejection happens before any DB lookup or onAction() call — a structural check, the source rejects before extractValidActionBody is reached', async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url-relative path to this test file's own sibling source, never user input.
      const source = await readFile(
        fileURLToPath(new URL('./panel-routes.ts', import.meta.url)),
        'utf-8'
      )
      const csrfCheckIndex = source.indexOf('isRejectedByCsrfToken(')
      const bodyExtractIndex = source.indexOf('extractValidActionBody(req.body)')
      const dispatchCallIndex = source.indexOf('await handleModuleAction(')
      expect(csrfCheckIndex).toBeGreaterThan(-1)
      expect(bodyExtractIndex).toBeGreaterThan(-1)
      expect(dispatchCallIndex).toBeGreaterThan(-1)
      expect(csrfCheckIndex).toBeLessThan(bodyExtractIndex)
      expect(csrfCheckIndex).toBeLessThan(dispatchCallIndex)
    })
  })

  it('AC6/Task 3: rate-limits after 30 requests from the same user (429)', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      __setExtensionStateForTests(actionState(async () => ({ outcome: 'ok' })))
      const member = await createDirectAuthenticatedUser(suite.app, 'action-ratelimit', 'member')

      const statuses: number[] = []
      for (let i = 0; i < 31; i += 1) {
        const res = await postAction(
          suite.app,
          ACTION_SLOT,
          { kind: RENAME_ACTION_KIND },
          member.cookies
        )
        statuses.push(res.statusCode)
      }

      expect(statuses.slice(0, 30).every((code) => code === 200)).toBe(true)
      expect(statuses[30]).toBe(429)
    } finally {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    }
  }, 30_000)

  it('Boundary & Edge Case Sweep: two concurrent requests for two different users/orgs never cross-contaminate context', async () => {
    const captured: ModuleActionContext[] = []
    __setExtensionStateForTests(
      actionState(async (context) => {
        await Promise.resolve()
        captured.push(context)
        return { outcome: 'ok', message: `ok:${context.identity.userId}` }
      })
    )
    const memberA = await createDirectAuthenticatedUser(suite.app, 'action-concurrent-a', 'member')
    const memberB = await createDirectAuthenticatedUser(suite.app, 'action-concurrent-b', 'owner')

    const [resA, resB] = await Promise.all([
      postAction(suite.app, ACTION_SLOT, { kind: RENAME_ACTION_KIND }, memberA.cookies),
      postAction(suite.app, ACTION_SLOT, { kind: RENAME_ACTION_KIND }, memberB.cookies),
    ])

    expect(resA.statusCode).toBe(200)
    expect(resB.statusCode).toBe(200)
    const forA = captured.find((c) => c.identity.userId === memberA.userId)
    const forB = captured.find((c) => c.identity.userId === memberB.userId)
    expect(forA?.orgId).toBe(memberA.orgId)
    expect(forB?.orgId).toBe(memberB.orgId)
  })
})
