import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleAction, ModuleActionContext } from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import type { Tx } from '@project-vault/db'
import { DEFAULT_UI_PANEL_SLOTS, type RenderExtensionPanelDeps } from './extension-panel.js'
import { handleModuleAction } from './module-action-handler.js'

function loadedState(overrides: {
  capabilities?: string[]
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
      ...(overrides.moduleActions ? { moduleActions: overrides.moduleActions } : {}),
    },
    loadedAt: overrides.loadedAt ?? new Date().toISOString(),
    hooks: overrides.moduleAction ? { moduleAction: overrides.moduleAction } : {},
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
const GROUP_SLOT = 'group'
const RENAME_GROUP_KIND = 'rename-group'
const ADD_MEMBER_KIND = 'add-member'
const RENAME_ACTION = { kind: RENAME_GROUP_KIND, accessGroupId: 'grp_1' }

describe('handleModuleAction (Story 25.5 AC1-AC3, AC5, AC6)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    vi.useRealTimers()
  })

  it('rejects a well-formed but not-the-one-known-slot value before touching extension state', async () => {
    const result = await handleModuleAction(
      'document',
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('returns not_found when no extension is loaded — hook is never invoked (there is no hook to invoke)', async () => {
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'not_found' })
  })

  it('AC2: returns not_found for an action.kind not in the declared moduleActions list, and never invokes onAction', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(
      loadedState({ moduleActions: [ADD_MEMBER_KIND], moduleAction: { onAction } })
    )
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      { kind: 'delete-everything' },
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'not_found' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('AC2: an extension declaring moduleActions omitted entirely serves zero declared actions — every request not_found', async () => {
    const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
    __setExtensionStateForTests(loadedState({ moduleAction: { onAction } }))
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'not_found' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('happy path: dispatches to onAction and passes through an ok outcome with html', async () => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: {
          onAction: async () => ({ outcome: 'ok', html: '<section>renamed</section>' }),
        },
      })
    )
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'ok', html: '<section>renamed</section>' })
  })

  it.each([
    { outcome: 'validation_failed' as const, message: 'Name is required' },
    { outcome: 'denied' as const, message: 'not allowed' },
    { outcome: 'denied' as const },
    { outcome: 'conflict' as const, message: 'already renamed' },
  ])('passes through the extension-returned outcome %o verbatim', async (expected) => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: { onAction: async () => expected },
      })
    )
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual(expected)
  })

  it('AC5: degrades to error and logs (never the raw message) when onAction throws', async () => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: {
          onAction: async () => {
            throw new Error('permission denied: row-level policy violation on access_groups')
          },
        },
      })
    )
    const logger = silentLogger()
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      logger,
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'error' })
    expect(logger.error).toHaveBeenCalled()
    const [, message] = logger.error.mock.calls[0] as [unknown, string]
    expect(message).not.toContain('row-level policy')
  })

  it('AC5: onAction explicitly returning { outcome: "error" } still degrades and logs', async () => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: { onAction: async () => ({ outcome: 'error' }) },
      })
    )
    const logger = silentLogger()
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      logger,
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'error' })
    expect(logger.error).toHaveBeenCalled()
  })

  it('degrades to error when onAction returns a malformed result', async () => {
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: { onAction: async () => ({ outcome: 'ok', html: 123 }) as never },
      })
    )
    const result = await handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    expect(result).toEqual({ outcome: 'error' })
  })

  it('degrades to error when onAction times out', async () => {
    vi.useFakeTimers()
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [RENAME_GROUP_KIND],
        moduleAction: { onAction: () => new Promise(() => undefined) },
      })
    )
    const promise = handleModuleAction(
      GROUP_SLOT,
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger(),
      IDENTITY_1,
      FAKE_TX,
      RENAME_ACTION,
      {},
      fakeDeps()
    )
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await promise
    expect(result).toEqual({ outcome: 'error' })
  })

  describe('AC3: never trusts identity/org claims embedded in the action body', () => {
    it("context passed to onAction carries the caller's real session orgId regardless of a smuggled body.orgId", async () => {
      let seen: ModuleActionContext | undefined
      __setExtensionStateForTests(
        loadedState({
          moduleActions: [ADD_MEMBER_KIND],
          moduleAction: {
            onAction: async (context) => {
              seen = context
              return { outcome: 'ok' }
            },
          },
        })
      )
      await handleModuleAction(
        GROUP_SLOT,
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { kind: ADD_MEMBER_KIND, orgId: 'org-b', userId: 'user-b', projectId: 'proj-b' },
        {},
        fakeDeps()
      )
      expect(seen?.orgId).toBe('org_1')
      expect(seen?.identity.userId).toBe('user_1')
    })

    it('a request-scoped projectId the caller cannot see is rejected before onAction is ever invoked', async () => {
      const onAction = vi.fn(async () => ({ outcome: 'ok' as const }))
      __setExtensionStateForTests(
        loadedState({ moduleActions: [ADD_MEMBER_KIND], moduleAction: { onAction } })
      )
      const deps = fakeDeps({ callerCanSeeProject: vi.fn(async () => false) })
      const result = await handleModuleAction(
        GROUP_SLOT,
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { kind: ADD_MEMBER_KIND },
        { projectId: 'proj-not-visible' },
        deps
      )
      expect(result).toEqual({ outcome: 'not_found' })
      expect(onAction).not.toHaveBeenCalled()
      expect(deps.logVisibilityDenied).toHaveBeenCalled()
    })
  })

  it('Boundary & Edge Case Sweep: two concurrent requests for two different users/orgs never cross-contaminate context', async () => {
    const captured: ModuleActionContext[] = []
    __setExtensionStateForTests(
      loadedState({
        moduleActions: [ADD_MEMBER_KIND],
        moduleAction: {
          onAction: async (context) => {
            await Promise.resolve()
            captured.push(context)
            return { outcome: 'ok', message: `ok:${context.identity.userId}` }
          },
        },
      })
    )

    const [resultA, resultB] = await Promise.all([
      handleModuleAction(
        GROUP_SLOT,
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_1,
        FAKE_TX,
        { kind: ADD_MEMBER_KIND },
        {},
        fakeDeps({ getUserLocale: vi.fn(async () => 'en' as const) })
      ),
      handleModuleAction(
        GROUP_SLOT,
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY_2,
        FAKE_TX,
        { kind: ADD_MEMBER_KIND },
        {},
        fakeDeps({ getUserLocale: vi.fn(async () => 'es' as const) })
      ),
    ])

    expect(resultA).toEqual({ outcome: 'ok', message: 'ok:user_1' })
    expect(resultB).toEqual({ outcome: 'ok', message: 'ok:user_2' })

    const forUser1 = captured.find((c) => c.identity.userId === 'user_1')
    const forUser2 = captured.find((c) => c.identity.userId === 'user_2')
    expect(forUser1).toMatchObject({ orgId: 'org_1', locale: 'en' })
    expect(forUser2).toMatchObject({ orgId: 'org_2', locale: 'es' })
  })
})
