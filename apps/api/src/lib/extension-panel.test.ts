import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIPanel, UIPanelContext } from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import type { Tx } from '@project-vault/db'
import {
  DEFAULT_PANEL_DATA_PATHS,
  DEFAULT_UI_PANEL_SLOTS,
  __resetPanelDataPathsFallbackWarningForTests,
  __resetUiPanelSlotsFallbackWarningForTests,
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
  resolveExtensionNavItems,
  resolveKnownUiPanelSlots,
  resolvePanelDataPaths,
  type RenderExtensionPanelDeps,
} from './extension-panel.js'

// Story 25.12 — shared fixture literals for the mid-lifetime-reload tests below (both
// resolveKnownUiPanelSlots' pre-existing block and resolvePanelDataPaths' new one use the exact
// same two timestamps and example path templates); named constants avoid
// sonarjs/no-duplicate-string tripping on a literal repeated across both blocks.
const RELOAD_FIRST_LOADED_AT = '2026-01-01T00:00:00.000Z'
const RELOAD_SECOND_LOADED_AT = '2026-01-01T00:05:00.000Z'
const DEFAULT_PROJECTS_PATH = '/api/v1/projects'
const DEFAULT_PROJECT_ID_PATH = '/api/v1/projects/:id'
const ORG_USERS_PATH = '/api/v1/org/users'
const ORG_GROUPS_PATH = '/api/v1/org/groups'

function loadedState(overrides: {
  capabilities?: string[]
  uiPanel?: UIPanel
  uiPanelSlots?: string[]
  moduleActions?: string[]
  panelDataPaths?: string[]
  navItems?: Array<{
    id: string
    label: string
    href: string
    icon?: string
    parentId?: string
  }>
  name?: string
  loadedAt?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: overrides.name ?? 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
      ...(overrides.uiPanelSlots ? { uiPanelSlots: overrides.uiPanelSlots } : {}),
      ...(overrides.moduleActions ? { moduleActions: overrides.moduleActions } : {}),
      ...(overrides.panelDataPaths ? { panelDataPaths: overrides.panelDataPaths } : {}),
      ...(overrides.navItems ? { navItems: overrides.navItems as never } : {}),
    },
    loadedAt: overrides.loadedAt ?? new Date().toISOString(),
    hooks: overrides.uiPanel ? { uiPanel: overrides.uiPanel } : {},
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

const FAKE_TX = {} as Tx

function fakeDeps(overrides: Partial<RenderExtensionPanelDeps> = {}): RenderExtensionPanelDeps {
  return {
    callerCanSeeProject: vi.fn(async () => true),
    logVisibilityDenied: vi.fn(),
    getUserLocale: vi.fn(async () => 'en' as const),
    resolveTheme: vi.fn(async () => ({ name: null })),
    ...overrides,
  }
}

const IDENTITY_1 = { userId: 'user_1', orgId: 'org_1', orgRole: 'member' as const }
const IDENTITY_2 = { userId: 'user_2', orgId: 'org_2', orgRole: 'owner' as const }
const SHOULD_NOT_RUN_HTML = 'should not run'

describe('renderExtensionPanel (Story 25.1 AC3/AC3b, Story 25.3 AC1-AC6)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    vi.useRealTimers()
  })

  it('AC3b: rejects an empty slot before ever touching extension state', async () => {
    const result = await renderExtensionPanel(
      '',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects an oversized slot value', async () => {
    const result = await renderExtensionPanel(
      'a'.repeat(65),
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a wrong-charset slot value', async () => {
    const result = await renderExtensionPanel(
      'Group!',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a well-formed but not-the-one-known-slot value', async () => {
    const result = await renderExtensionPanel(
      'document',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3: returns unavailable when no extension is loaded', async () => {
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3: returns unavailable when the loaded extension has no uiPanel hook', async () => {
    __setExtensionStateForTests(loadedState({}))
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('happy path: returns the rendered html when the hook resolves a well-formed result', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: '<p>hi</p>' }) } })
    )
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({
      outcome: 'ok',
      html: '<p>hi</p>',
      allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
    })
  })

  it('AC3: degrades to unavailable when the hook throws', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: async () => {
            throw new Error('boom')
          },
        },
      })
    )
    const logger = silentLogger()
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      logger,
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'unavailable' })
    expect(logger.error).toHaveBeenCalled()
    // Never leaks the raw exception message/stack into the log payload's message string.
    const [, message] = logger.error.mock.calls[0] as [unknown, string]
    expect(message).not.toContain('boom')
  })

  it('AC3: degrades to unavailable when the hook returns a malformed result', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: { onRenderPanel: async () => ({ html: 123 }) as never },
      })
    )
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3: degrades to unavailable when the hook times out', async () => {
    vi.useFakeTimers()
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: () => new Promise(() => undefined),
        },
      })
    )
    const promise = renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await promise
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3 Boundary & Edge Case Sweep: extension unloading between calls is re-checked fresh', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) } })
    )
    const first = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(first).toEqual({
      outcome: 'ok',
      html: 'ok',
      allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
    })

    __resetExtensionStateForTests()
    const second = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(second).toEqual({ outcome: 'unavailable' })
  })

  describe('AC1/AC6: identity/orgId always populated and request-scoped', () => {
    it("passes identity.userId/identity.orgRole and orgId straight from this call's own identity argument", async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured).toMatchObject({
        identity: { userId: 'user_1', orgRole: 'member' },
        orgId: 'org_1',
      })
      // AC6: exactly userId/orgRole — no sessionId/jti/sessionVersion/isPlatformOperator.
      expect(Object.keys(captured?.identity ?? {}).sort()).toEqual(['orgRole', 'userId'])
    })

    it('AC1 Boundary & Edge Case Sweep: two concurrent requests for two different users/orgs never cross-contaminate identity/orgId', async () => {
      const captured: UIPanelContext[] = []
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              // Interleave: yield once so both in-flight calls' microtasks race each other.
              await Promise.resolve()
              captured.push(context)
              return { html: `ok:${context.identity.userId}` }
            },
          },
        })
      )

      const [resultA, resultB] = await Promise.all([
        renderExtensionPanel(
          'group',
          DEFAULT_UI_PANEL_SLOTS,
          silentLogger(),
          IDENTITY_1,
          FAKE_TX,
          {},
          fakeDeps({ getUserLocale: vi.fn(async () => 'en' as const) })
        ),
        renderExtensionPanel(
          'group',
          DEFAULT_UI_PANEL_SLOTS,
          silentLogger(),
          IDENTITY_2,
          FAKE_TX,
          {},
          fakeDeps({ getUserLocale: vi.fn(async () => 'es' as const) })
        ),
      ])

      expect(resultA).toEqual({
        outcome: 'ok',
        html: 'ok:user_1',
        allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
      })
      expect(resultB).toEqual({
        outcome: 'ok',
        html: 'ok:user_2',
        allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
      })

      const forUser1 = captured.find((c) => c.identity.userId === 'user_1')
      const forUser2 = captured.find((c) => c.identity.userId === 'user_2')
      expect(forUser1).toMatchObject({
        orgId: 'org_1',
        identity: { orgRole: 'member' },
        locale: 'en',
      })
      expect(forUser2).toMatchObject({
        orgId: 'org_2',
        identity: { orgRole: 'owner' },
        locale: 'es',
      })
    })
  })

  describe('AC2: projectId authorization', () => {
    it('includes projectId in context and calls callerCanSeeProject when authorized', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      const callerCanSeeProject = vi.fn(async () => true)
      const result = await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { projectId: 'proj_1' },
        fakeDeps({ callerCanSeeProject })
      )
      expect(result).toEqual({
        outcome: 'ok',
        html: 'ok',
        allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
      })
      expect(captured?.projectId).toBe('proj_1')
      expect(callerCanSeeProject).toHaveBeenCalledWith(
        expect.objectContaining({ auth: IDENTITY_1, tx: FAKE_TX }),
        'proj_1'
      )
    })

    it('an unauthorized projectId degrades to panel_unavailable, never invoking the hook, and logs visibility_denied', async () => {
      const onRenderPanel = vi.fn(async () => ({ html: SHOULD_NOT_RUN_HTML }))
      __setExtensionStateForTests(loadedState({ uiPanel: { onRenderPanel } }))
      const logVisibilityDenied = vi.fn()
      const result = await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { projectId: 'proj_2' },
        fakeDeps({ callerCanSeeProject: vi.fn(async () => false), logVisibilityDenied })
      )
      expect(result).toEqual({ outcome: 'unavailable' })
      expect(onRenderPanel).not.toHaveBeenCalled()
      expect(logVisibilityDenied).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectId: 'proj_2', callerId: 'user_1', orgRole: 'member' })
      )
    })

    it('a DB failure resolving project visibility degrades to panel_unavailable, not a raw throw', async () => {
      __setExtensionStateForTests(
        loadedState({ uiPanel: { onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }) } })
      )
      const result = await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { projectId: 'proj_1' },
        fakeDeps({
          callerCanSeeProject: vi.fn(async () => {
            throw new Error('db down')
          }),
        })
      )
      expect(result).toEqual({ outcome: 'unavailable' })
    })

    it('omitted projectId stays undefined in context and never calls callerCanSeeProject', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      const callerCanSeeProject = vi.fn(async () => true)
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({ callerCanSeeProject })
      )
      expect(captured?.projectId).toBeUndefined()
      expect(callerCanSeeProject).not.toHaveBeenCalled()
    })
  })

  describe('AC3: locale resolution', () => {
    it('uses the resolved stored locale value', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({ getUserLocale: vi.fn(async () => 'es' as const) })
      )
      expect(captured?.locale).toBe('es')
    })

    it('a DB failure resolving locale degrades to panel_unavailable, never a raw 500-shaped throw', async () => {
      __setExtensionStateForTests(
        loadedState({ uiPanel: { onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }) } })
      )
      const result = await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({
          getUserLocale: vi.fn(async () => {
            throw new Error('db down')
          }),
        })
      )
      expect(result).toEqual({ outcome: 'unavailable' })
    })
  })

  describe('AC4: theme resolution', () => {
    it('uses the resolved theme name (personal selection/org default/base all delegated to resolveTheme dep)', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({ resolveTheme: vi.fn(async () => ({ name: 'midnight' })) })
      )
      expect(captured?.theme).toEqual({ name: 'midnight' })
    })

    it('base theme resolves to theme.name null', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({ resolveTheme: vi.fn(async () => ({ name: null })) })
      )
      expect(captured?.theme).toEqual({ name: null })
    })

    it('a DB failure resolving theme degrades to panel_unavailable', async () => {
      __setExtensionStateForTests(
        loadedState({ uiPanel: { onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }) } })
      )
      const result = await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps({
          resolveTheme: vi.fn(async () => {
            throw new Error('db down')
          }),
        })
      )
      expect(result).toEqual({ outcome: 'unavailable' })
    })
  })

  describe('AC5: resourceId pass-through without authorization', () => {
    it('a shape-valid resourceId is passed through verbatim into context', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { resourceId: 'grp_42' },
        fakeDeps()
      )
      expect(captured?.resourceId).toBe('grp_42')
    })

    it('no project/access-group lookup is ever attempted for a resourceId-only request (negative assertion proving the no-authorization design is real)', async () => {
      __setExtensionStateForTests(
        loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) } })
      )
      const callerCanSeeProject = vi.fn(async () => true)
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { resourceId: 'grp_42' },
        fakeDeps({ callerCanSeeProject })
      )
      expect(callerCanSeeProject).not.toHaveBeenCalled()
    })

    it('omitted resourceId stays undefined in context', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured?.resourceId).toBeUndefined()
    })
  })

  describe('Story 25.8 AC1: subpath pass-through, never concatenated into :slot, never authorized', () => {
    it('a subpath value is passed through verbatim into context', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { subpath: 'groups/123/detail' },
        fakeDeps()
      )
      expect(captured?.subpath).toBe('groups/123/detail')
    })

    it('omitted subpath stays undefined in context (never an empty string)', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured?.subpath).toBeUndefined()
    })

    it('a subpath is never used to widen the knownSlots match — an invalid slot still rejects even with a subpath supplied', async () => {
      __setExtensionStateForTests(
        loadedState({ uiPanel: { onRenderPanel: async () => ({ html: SHOULD_NOT_RUN_HTML }) } })
      )
      const result = await renderExtensionPanel(
        'not-a-known-slot',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { subpath: 'anything' },
        fakeDeps()
      )
      expect(result).toEqual({ outcome: 'invalid_slot' })
    })
  })

  describe('Story 25.5 AC4/Task 4: actionEndpoint resolution', () => {
    it('resolves actionEndpoint to the absolute actions path when the loaded extension declares moduleActions', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          moduleActions: ['test-action'],
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured?.actionEndpoint).toBe('/api/v1/extensions/panels/group/actions')
    })

    it('leaves actionEndpoint undefined (never empty string) when the loaded extension declares no moduleActions', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured?.actionEndpoint).toBeUndefined()
    })

    it('leaves actionEndpoint undefined when the loaded extension declares an empty moduleActions array', async () => {
      let captured: UIPanelContext | undefined
      __setExtensionStateForTests(
        loadedState({
          moduleActions: [],
          uiPanel: {
            onRenderPanel: async (context) => {
              captured = context
              return { html: 'ok' }
            },
          },
        })
      )
      await renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        {},
        fakeDeps()
      )
      expect(captured?.actionEndpoint).toBeUndefined()
    })
  })
})

describe('isUiPanelCapabilityDeclared (Story 25.1 AC5)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('is false when no extension is loaded', () => {
    expect(isUiPanelCapabilityDeclared()).toBe(false)
  })

  it('is false when the loaded extension does not declare ui-panel', () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['auth-provider'] }))
    expect(isUiPanelCapabilityDeclared()).toBe(false)
  })

  it('is true when the loaded extension declares ui-panel', () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['ui-panel'] }))
    expect(isUiPanelCapabilityDeclared()).toBe(true)
  })
})

describe('resolveKnownUiPanelSlots (Story 25.2 AC2/AC3)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
    __resetUiPanelSlotsFallbackWarningForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    __resetUiPanelSlotsFallbackWarningForTests()
  })

  it('AC2: falls back to the legacy single-slot default when no extension is loaded', () => {
    const logger = silentLogger()
    expect(resolveKnownUiPanelSlots(undefined, logger)).toEqual(DEFAULT_UI_PANEL_SLOTS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('AC2: falls back to the legacy single-slot default when uiPanelSlots is omitted, warning once', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])

    // AC2: assert call count, not just presence — must fire once at load, never per-request.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('AC2: uiPanelSlots: undefined explicitly behaves identically to omitted (also warns once)', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    ;(status as { manifest: { uiPanelSlots?: string[] } }).manifest.uiPanelSlots = undefined
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('AC3: returns the manifest-declared list when present, never warning', () => {
    const status = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group', 'document'],
    })
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group', 'document'])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('AC3 Boundary & Edge Case Sweep: a reload with a different declared list resolves fresh on the very next call, not memoized', () => {
    const logger = silentLogger()
    const first = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group'],
      loadedAt: RELOAD_FIRST_LOADED_AT,
    })
    expect(resolveKnownUiPanelSlots(first, logger)).toEqual(['group'])

    const second = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group', 'document', 'classification'],
      loadedAt: RELOAD_SECOND_LOADED_AT,
    })
    expect(resolveKnownUiPanelSlots(second, logger)).toEqual([
      'group',
      'document',
      'classification',
    ])
  })

  it('AC2 fallback-warning identity is per-load: reloading (new loadedAt) re-warns even for the same extension name', () => {
    const logger = silentLogger()
    const firstLoad = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: RELOAD_FIRST_LOADED_AT,
    })
    resolveKnownUiPanelSlots(firstLoad, logger)
    resolveKnownUiPanelSlots(firstLoad, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const reloaded = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: RELOAD_SECOND_LOADED_AT,
    })
    resolveKnownUiPanelSlots(reloaded, logger)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('resolvePanelDataPaths (Story 25.12 AC2)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
    __resetPanelDataPathsFallbackWarningForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    __resetPanelDataPathsFallbackWarningForTests()
  })

  it('falls back to the legacy default pair when no extension is loaded', () => {
    const logger = silentLogger()
    expect(resolvePanelDataPaths(undefined, logger)).toEqual(DEFAULT_PANEL_DATA_PATHS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to the legacy default pair when panelDataPaths is omitted, warning once', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    const logger = silentLogger()

    expect(resolvePanelDataPaths(status, logger)).toEqual(DEFAULT_PANEL_DATA_PATHS)
    expect(resolvePanelDataPaths(status, logger)).toEqual(DEFAULT_PANEL_DATA_PATHS)
    expect(resolvePanelDataPaths(status, logger)).toEqual(DEFAULT_PANEL_DATA_PATHS)

    // AC2: assert call count, not just presence — must fire once at load, never per-request.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('panelDataPaths: undefined explicitly behaves identically to omitted (also warns once)', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    ;(status as { manifest: { panelDataPaths?: string[] } }).manifest.panelDataPaths = undefined
    const logger = silentLogger()

    expect(resolvePanelDataPaths(status, logger)).toEqual(DEFAULT_PANEL_DATA_PATHS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('returns the manifest-declared list when present, never warning', () => {
    const status = loadedState({
      capabilities: ['ui-panel'],
      panelDataPaths: [DEFAULT_PROJECTS_PATH, DEFAULT_PROJECT_ID_PATH, ORG_USERS_PATH],
    })
    const logger = silentLogger()

    expect(resolvePanelDataPaths(status, logger)).toEqual([
      DEFAULT_PROJECTS_PATH,
      DEFAULT_PROJECT_ID_PATH,
      ORG_USERS_PATH,
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a reload with a different declared list resolves fresh on the very next call, not memoized', () => {
    const logger = silentLogger()
    const first = loadedState({
      capabilities: ['ui-panel'],
      panelDataPaths: [ORG_USERS_PATH],
      loadedAt: RELOAD_FIRST_LOADED_AT,
    })
    expect(resolvePanelDataPaths(first, logger)).toEqual([ORG_USERS_PATH])

    const second = loadedState({
      capabilities: ['ui-panel'],
      panelDataPaths: [ORG_USERS_PATH, ORG_GROUPS_PATH],
      loadedAt: RELOAD_SECOND_LOADED_AT,
    })
    expect(resolvePanelDataPaths(second, logger)).toEqual([ORG_USERS_PATH, ORG_GROUPS_PATH])
  })

  it('fallback-warning identity is per-load: reloading (new loadedAt) re-warns even for the same extension name', () => {
    const logger = silentLogger()
    const firstLoad = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: RELOAD_FIRST_LOADED_AT,
    })
    resolvePanelDataPaths(firstLoad, logger)
    resolvePanelDataPaths(firstLoad, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const reloaded = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: RELOAD_SECOND_LOADED_AT,
    })
    resolvePanelDataPaths(reloaded, logger)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('resolveExtensionNavItems (Story 29.3 AC9)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('returns [] when no extension is loaded', () => {
    const logger = silentLogger()
    expect(resolveExtensionNavItems(undefined, logger)).toEqual([])
  })

  it('returns [] when the loaded extension omits navItems', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    const logger = silentLogger()
    expect(resolveExtensionNavItems(status, logger)).toEqual([])
  })

  it('returns the exact declared list when present, regardless of ui-panel capability', () => {
    const navItems = [
      { id: 'settings-page', label: 'Settings', href: '/ext/settings' },
      { id: 'child', label: 'Child', href: '/ext/settings/child', parentId: 'settings-page' },
    ]
    const status = loadedState({ capabilities: ['notification-channel'], navItems })
    const logger = silentLogger()
    expect(resolveExtensionNavItems(status, logger)).toEqual(navItems)
  })

  it('resolves fresh per call — a mid-lifetime reload with a different declared list is reflected on the very next call, not memoized', () => {
    const logger = silentLogger()
    const first = loadedState({
      capabilities: ['ui-panel'],
      navItems: [{ id: 'a', label: 'A', href: '/ext/a' }],
      loadedAt: RELOAD_FIRST_LOADED_AT,
    })
    expect(resolveExtensionNavItems(first, logger)).toEqual([
      { id: 'a', label: 'A', href: '/ext/a' },
    ])

    const second = loadedState({
      capabilities: ['ui-panel'],
      navItems: [{ id: 'b', label: 'B', href: '/ext/b' }],
      loadedAt: RELOAD_SECOND_LOADED_AT,
    })
    expect(resolveExtensionNavItems(second, logger)).toEqual([
      { id: 'b', label: 'B', href: '/ext/b' },
    ])
  })

  it('never warns — there is no fallback-default state to log (AC9)', () => {
    const logger = silentLogger()
    resolveExtensionNavItems(undefined, logger)
    resolveExtensionNavItems(loadedState({ capabilities: ['ui-panel'] }), logger)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe("renderExtensionPanel's allowedDataPaths wiring (Story 25.12 AC2)", () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
    __resetPanelDataPathsFallbackWarningForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    __resetPanelDataPathsFallbackWarningForTests()
  })

  it('the ok outcome carries the legacy default pair when the loaded extension omits panelDataPaths', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) } })
    )
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({
      outcome: 'ok',
      html: 'ok',
      allowedDataPaths: DEFAULT_PANEL_DATA_PATHS,
    })
  })

  it('the ok outcome carries the manifest-declared panelDataPaths list when present', async () => {
    __setExtensionStateForTests(
      loadedState({
        panelDataPaths: [DEFAULT_PROJECTS_PATH, DEFAULT_PROJECT_ID_PATH, ORG_USERS_PATH],
        uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) },
      })
    )
    const result = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(result).toEqual({
      outcome: 'ok',
      html: 'ok',
      allowedDataPaths: [DEFAULT_PROJECTS_PATH, DEFAULT_PROJECT_ID_PATH, ORG_USERS_PATH],
    })
  })

  it('a mid-lifetime reload with a changed panelDataPaths list resolves against the new list on the next call', async () => {
    __setExtensionStateForTests(
      loadedState({
        panelDataPaths: [ORG_USERS_PATH],
        loadedAt: RELOAD_FIRST_LOADED_AT,
        uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) },
      })
    )
    const first = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(first).toMatchObject({ allowedDataPaths: [ORG_USERS_PATH] })

    __resetExtensionStateForTests()
    __setExtensionStateForTests(
      loadedState({
        panelDataPaths: [ORG_USERS_PATH, ORG_GROUPS_PATH],
        loadedAt: RELOAD_SECOND_LOADED_AT,
        uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) },
      })
    )
    const second = await renderExtensionPanel(
      'group',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      {},
      fakeDeps()
    )
    expect(second).toMatchObject({
      allowedDataPaths: [ORG_USERS_PATH, ORG_GROUPS_PATH],
    })
  })
})
