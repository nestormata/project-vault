import { describe, expect, it } from 'vitest'
import type { UIPanel, UIPanelResult } from './ui-panel.js'

describe('UIPanel', () => {
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
