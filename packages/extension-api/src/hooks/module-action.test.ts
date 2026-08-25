import { describe, expect, it } from 'vitest'
import type {
  ActionResult,
  ModuleAction,
  ModuleActionContext,
  ModuleActionRequest,
} from './module-action.js'
import type { UIPanelContext } from './ui-panel.js'

// Story 25.5 AC1 — `ModuleActionContext` is a plain re-exported alias of `UIPanelContext`, not a
// parallel, independently-drifting type. Compile-time guard: this only typechecks if the two
// types are structurally identical in both directions.
function assertSameShape(context: ModuleActionContext): UIPanelContext {
  return context
}
function assertReverseShape(context: UIPanelContext): ModuleActionContext {
  return context
}
void assertSameShape
void assertReverseShape

const RENAME_GROUP_KIND = 'rename-group'

function baseContext(overrides: Partial<UIPanelContext> = {}): ModuleActionContext {
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
})
