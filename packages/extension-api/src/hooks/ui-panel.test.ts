import { describe, expect, it } from 'vitest'
import type { UIPanel, UIPanelContext, UIPanelResult } from './ui-panel.js'

// Story 25.1 AC6 scope-boundary regression: `UIPanelContext` must stay exactly `{ slot: string }`
// — no identity/org/project/locale/theme field added (that is Story 25.3's explicit scope).
// Compile-time guard: fails to typecheck if a second key is ever added, since `keyof
// UIPanelContext` would then no longer extend the literal `'slot'`.
type OnlySlotField = keyof UIPanelContext extends 'slot' ? true : false
const _assertUIPanelContextHasOnlySlotField: OnlySlotField = true
void _assertUIPanelContextHasOnlySlotField

describe('UIPanel', () => {
  it('AC6: UIPanelContext has exactly one field, "slot" — runtime mirror of the compile-time guard above', () => {
    const context: UIPanelContext = { slot: 'group' }
    expect(Object.keys(context)).toEqual(['slot'])
  })

  it('onRenderPanel resolves a serializable UIPanelResult', async () => {
    const panel: UIPanel = {
      onRenderPanel: (context) =>
        Promise.resolve({
          html: `<div>${context.slot}</div>`,
        }),
    }

    const result: UIPanelResult = await panel.onRenderPanel({ slot: 'sidebar' })

    expect(result).toEqual({ html: '<div>sidebar</div>' })
  })
})
