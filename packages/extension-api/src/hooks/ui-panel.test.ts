import { describe, expect, it } from 'vitest'
import type { UIPanel, UIPanelContext, UIPanelResult } from './ui-panel.js'

// Story 25.1 AC6 scope-boundary regression: `UIPanelContext` must stay exactly `{ slot: string }`
// — no identity/org/project/locale/theme field added (that is Story 25.3's explicit scope).
// Compile-time guard: fails to typecheck if a second key is ever added, since `keyof
// UIPanelContext` would then no longer extend the literal `'slot'`.
type OnlySlotField = keyof UIPanelContext extends 'slot' ? true : false
const _assertUIPanelContextHasOnlySlotField: OnlySlotField = true
void _assertUIPanelContextHasOnlySlotField

// Story 25.4 AC6 scope-boundary regression: `UIPanelResult` must stay exactly `{ html: string }`
// — this story changes how `html` is *consumed* by the host, never its type (no `actionEndpoint`/
// `csrfToken` field, no shape change of any kind). Compile-time guard mirrors the one above.
type OnlyHtmlField = keyof UIPanelResult extends 'html' ? true : false
const _assertUIPanelResultHasOnlyHtmlField: OnlyHtmlField = true
void _assertUIPanelResultHasOnlyHtmlField

describe('UIPanel', () => {
  it('AC6: UIPanelContext has exactly one field, "slot" — runtime mirror of the compile-time guard above', () => {
    const context: UIPanelContext = { slot: 'group' }
    expect(Object.keys(context)).toEqual(['slot'])
  })

  it('Story 25.4 AC6: UIPanelResult has exactly one field, "html" — runtime mirror of the compile-time guard above', () => {
    const result: UIPanelResult = { html: '<p>x</p>' }
    expect(Object.keys(result)).toEqual(['html'])
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
