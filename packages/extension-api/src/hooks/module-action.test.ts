import { describe, expect, it } from 'vitest'
import type {
  ActionResult,
  ModuleAction,
  ModuleActionContext,
  ModuleActionRequest,
} from './module-action.js'
import type { UIPanelContext } from './ui-panel.js'

// Story 25.5 AC1 — `ModuleActionContext` still carries every `UIPanelContext` field: a
// `ModuleActionContext` value remains assignable where a `UIPanelContext` is expected (this
// direction is unaffected by Story 40.1's split below — `ModuleActionContext` is a strict
// superset, never a divergent shape).
function assertModuleActionIsAssignableToUIPanel(context: ModuleActionContext): UIPanelContext {
  return context
}
void assertModuleActionIsAssignableToUIPanel

// Story 40.1 ADR — `ModuleActionContext` is no longer a bare re-exported alias of
// `UIPanelContext` (`export type ModuleActionContext = UIPanelContext`); it is now
// `UIPanelContext & { requestState?: Record<string, unknown> }`. Because `requestState` is
// OPTIONAL, a plain `UIPanelContext` object literal (with no `requestState` key at all) remains
// structurally assignable wherever a `ModuleActionContext` is expected — TypeScript's optional-
// property assignability rules mean a bare `// @ts-expect-error` assignability check at that call
// site would NOT catch a regression back to a bare alias. The real, enforced difference is that
// `'requestState'` is a member of `ModuleActionContext` but NOT of `UIPanelContext` — asserted
// here via a `keyof` check: if a future change reverted the split (making `ModuleActionContext`
// a bare alias again), `'requestState' extends keyof UIPanelContext` would become `true`, and the
// `false` literal assigned below would fail to compile, breaking this file's own build.
type ModuleActionHasRequestState = 'requestState' extends keyof ModuleActionContext ? true : false
type UIPanelLacksRequestState = 'requestState' extends keyof UIPanelContext ? true : false
const moduleActionHasRequestState: ModuleActionHasRequestState = true
const uiPanelLacksRequestState: UIPanelLacksRequestState = false
void moduleActionHasRequestState
void uiPanelLacksRequestState

// Story 40.1 ADR — the other, complementary proof: reading `.requestState` off a value typed as
// the BASE `UIPanelContext` (not the widened `ModuleActionContext`) is a genuine compile error —
// `@ts-expect-error` fails the build if this ever stops being an error (i.e. if `UIPanelContext`
// itself were ever widened to carry `requestState`, which Story 40.1's Recommended Mechanism
// Decision explicitly rejects — see AC8).
function readRequestStateOffBaseUIPanelContext(context: UIPanelContext): void {
  // @ts-expect-error -- requestState does not exist on the base UIPanelContext type (AC8)
  void context.requestState
}
void readRequestStateOffBaseUIPanelContext

const RENAME_GROUP_KIND = 'rename-group'

function baseContext(overrides: Partial<ModuleActionContext> = {}): ModuleActionContext {
  return {
    slot: 'group',
    identity: { userId: 'user_1', orgRole: 'member' },
    orgId: 'org_1',
    locale: 'en',
    theme: { name: null },
    ...overrides,
  }
}

describe('ModuleAction hook type (AC1)', () => {
  it('ModuleActionRequest.action carries the raw parsed JSON body verbatim, including its own kind discriminant', () => {
    const request: ModuleActionRequest = {
      action: { kind: RENAME_GROUP_KIND, accessGroupId: 'grp_1', name: 'New Name' },
    }
    expect(request.action.kind).toBe(RENAME_GROUP_KIND)
    expect(request.action['accessGroupId']).toBe('grp_1')
  })

  it('onAction resolves an ok ActionResult carrying html', async () => {
    const hook: ModuleAction = {
      onAction: (_context: ModuleActionContext, request: ModuleActionRequest) =>
        Promise.resolve({ outcome: 'ok', html: `<section>${request.action.kind}</section>` }),
    }
    const result: ActionResult = await hook.onAction(baseContext(), {
      action: { kind: RENAME_GROUP_KIND },
    })
    expect(result).toEqual({ outcome: 'ok', html: '<section>rename-group</section>' })
  })

  it('onAction resolves an ok ActionResult carrying message instead of html', async () => {
    const hook: ModuleAction = {
      onAction: () => Promise.resolve({ outcome: 'ok', message: 'Saved' }),
    }
    const result = await hook.onAction(baseContext(), { action: { kind: 'toggle-group' } })
    expect(result).toEqual({ outcome: 'ok', message: 'Saved' })
  })

  it('supports every non-ok outcome discriminant', async () => {
    const outcomes: ActionResult[] = [
      { outcome: 'validation_failed', message: 'Name is required' },
      { outcome: 'denied' },
      { outcome: 'denied', message: 'not allowed' },
      { outcome: 'conflict' },
      { outcome: 'conflict', message: 'already renamed' },
      { outcome: 'error' },
    ]
    for (const outcome of outcomes) {
      const hook: ModuleAction = { onAction: () => Promise.resolve(outcome) }
      const result = await hook.onAction(baseContext(), { action: { kind: 'x' } })
      expect(result).toEqual(outcome)
    }
  })

  it('context passed to onAction is the same shape UIPanelContext already establishes', async () => {
    let seen: ModuleActionContext | undefined
    const hook: ModuleAction = {
      onAction: (context: ModuleActionContext) => {
        seen = context
        return Promise.resolve({ outcome: 'ok' })
      },
    }
    await hook.onAction(baseContext({ resourceId: 'grp_42', projectId: 'proj_1' }), {
      action: { kind: 'x' },
    })
    expect(seen).toMatchObject({ resourceId: 'grp_42', projectId: 'proj_1' })
  })

  it('Story 40.1 AC2 — requestState is passed through verbatim when present, absent when not', async () => {
    let seenWith: ModuleActionContext | undefined
    let seenWithout: ModuleActionContext | undefined
    const hook: ModuleAction = {
      onAction: (context: ModuleActionContext) => {
        seenWith = context
        return Promise.resolve({ outcome: 'ok' })
      },
    }
    await hook.onAction(baseContext({ requestState: { selectionId: 'abc123' } }), {
      action: { kind: 'x' },
    })
    expect(seenWith?.requestState).toEqual({ selectionId: 'abc123' })

    const hookNoState: ModuleAction = {
      onAction: (context: ModuleActionContext) => {
        seenWithout = context
        return Promise.resolve({ outcome: 'ok' })
      },
    }
    await hookNoState.onAction(baseContext(), { action: { kind: 'x' } })
    expect(seenWithout?.requestState).toBeUndefined()
  })
})
