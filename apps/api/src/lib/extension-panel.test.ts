import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIPanel, UIPanelContext } from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import type { Tx } from '@project-vault/db'
import {
  DEFAULT_UI_PANEL_SLOTS,
  __resetUiPanelSlotsFallbackWarningForTests,
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
  resolveKnownUiPanelSlots,
  type RenderExtensionPanelDeps,
} from './extension-panel.js'

function loadedState(overrides: {
  capabilities?: string[]
  uiPanel?: UIPanel
  uiPanelSlots?: string[]
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
    expect(result).toEqual({ outcome: 'ok', html: '<p>hi</p>' })
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
    expect(first).toEqual({ outcome: 'ok', html: 'ok' })

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

      expect(resultA).toEqual({ outcome: 'ok', html: 'ok:user_1' })
      expect(resultB).toEqual({ outcome: 'ok', html: 'ok:user_2' })

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
      expect(result).toEqual({ outcome: 'ok', html: 'ok' })
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
      loadedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(resolveKnownUiPanelSlots(first, logger)).toEqual(['group'])

    const second = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group', 'document', 'classification'],
      loadedAt: '2026-01-01T00:05:00.000Z',
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
      loadedAt: '2026-01-01T00:00:00.000Z',
    })
    resolveKnownUiPanelSlots(firstLoad, logger)
    resolveKnownUiPanelSlots(firstLoad, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const reloaded = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: '2026-01-01T00:05:00.000Z',
    })
    resolveKnownUiPanelSlots(reloaded, logger)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})
