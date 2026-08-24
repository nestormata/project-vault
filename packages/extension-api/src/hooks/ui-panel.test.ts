import { describe, expect, it } from 'vitest'
import type { UIPanel, UIPanelContext, UIPanelResult } from './ui-panel.js'

// Story 25.3 AC6 scope-boundary regression: `UIPanelContext` must stay exactly the closed field
// set below — no additional identity/session field (`sessionId`/`jti`/`sessionVersion`/
// `isPlatformOperator`) is ever added without a corresponding AC. Compile-time guard: fails to
// typecheck if a new top-level key is ever added, since `keyof UIPanelContext` would then no
// longer extend this literal union.
type OnlyExpectedFields = keyof UIPanelContext extends
  'slot' | 'resourceId' | 'identity' | 'orgId' | 'projectId' | 'locale' | 'theme' | 'actionEndpoint'
  ? true
  : false
const _assertUIPanelContextHasOnlyExpectedFields: OnlyExpectedFields = true
void _assertUIPanelContextHasOnlyExpectedFields

// AC6: `identity` itself must stay exactly `{ userId, orgRole }` — no `sessionId`/`jti`/
// `sessionVersion`/`isPlatformOperator` ever added.
type OnlyExpectedIdentityFields = keyof UIPanelContext['identity'] extends 'userId' | 'orgRole'
  ? true
  : false
const _assertIdentityHasOnlyExpectedFields: OnlyExpectedIdentityFields = true
void _assertIdentityHasOnlyExpectedFields

function baseContext(overrides: Partial<UIPanelContext> = {}): UIPanelContext {
  return {
    slot: 'group',
    identity: { userId: 'user_1', orgRole: 'member' },
    orgId: 'org_1',
    locale: 'en',
    theme: { name: null },
    ...overrides,
  }
}

describe('UIPanel', () => {
  it('AC6: UIPanelContext has exactly the expected required field set at runtime (no projectId/resourceId when omitted)', () => {
    const context = baseContext()
    expect(Object.keys(context).sort()).toEqual(
      ['identity', 'locale', 'orgId', 'slot', 'theme'].sort()
    )
    expect(Object.keys(context.identity).sort()).toEqual(['orgRole', 'userId'])
  })

  it('AC1/AC2/AC5: accepts the optional resourceId/projectId fields when present', () => {
    const context = baseContext({ resourceId: 'grp_42', projectId: 'proj_1' })
    expect(context.resourceId).toBe('grp_42')
    expect(context.projectId).toBe('proj_1')
  })

  it('Story 25.5 AC4/Task 1: accepts the optional actionEndpoint field when present, absent by default', () => {
    expect(baseContext().actionEndpoint).toBeUndefined()
    expect(
      baseContext({ actionEndpoint: '/api/v1/extensions/panels/group/actions' }).actionEndpoint
    ).toBe('/api/v1/extensions/panels/group/actions')
  })

  it('AC3: locale is restricted to the supported-locale union', () => {
    const context = baseContext({ locale: 'es' })
    expect(context.locale).toBe('es')
  })

  it('AC4: theme.name is null for the base theme, or a resolved custom theme name string', () => {
    expect(baseContext({ theme: { name: null } }).theme.name).toBeNull()
    expect(baseContext({ theme: { name: 'midnight' } }).theme.name).toBe('midnight')
  })

  it('onRenderPanel resolves a serializable UIPanelResult', async () => {
    const panel: UIPanel = {
      onRenderPanel: (context) =>
        Promise.resolve({
          html: `<div>${context.slot}:${context.identity.userId}</div>`,
        }),
    }

    const result: UIPanelResult = await panel.onRenderPanel(baseContext({ slot: 'sidebar' }))

    expect(result).toEqual({ html: '<div>sidebar:user_1</div>' })
  })
})
