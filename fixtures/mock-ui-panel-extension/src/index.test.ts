import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import mockUiPanelExtension, {
  GARBAGE_TRIGGER_SLOT,
  HANG_TRIGGER_SLOT,
  HAPPY_SLOT,
  THROW_TRIGGER_SLOT,
} from './index.js'

describe('mock-ui-panel-extension (Story 25.1 Task 7)', () => {
  it('declares a valid, reverse-DNS manifest with only the ui-panel capability', () => {
    expect(mockUiPanelExtension.manifest.name).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
    expect(mockUiPanelExtension.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(mockUiPanelExtension.manifest.capabilities).toEqual(['ui-panel'])
  })

  it('Story 25.2 AC6: declares uiPanelSlots covering the happy-path slot and all three trigger slots', () => {
    expect(mockUiPanelExtension.manifest.uiPanelSlots).toEqual([
      HAPPY_SLOT,
      THROW_TRIGGER_SLOT,
      HANG_TRIGGER_SLOT,
      GARBAGE_TRIGGER_SLOT,
    ])
  })

  it('does not implement any other hook (proves ui-panel alone is a valid manifest)', () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    expect(hooks.authStrategy).toBeUndefined()
    expect(hooks.capabilityGate).toBeUndefined()
    expect(hooks.uiPanel).toBeDefined()
  })

  it('resolves a well-formed html result for the happy-path slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const result = await hooks.uiPanel?.onRenderPanel({ slot: HAPPY_SLOT })
    expect(typeof result?.html).toBe('string')
    expect(result?.html).toContain(HAPPY_SLOT)
  })

  it('throws for the throw-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    await expect(hooks.uiPanel?.onRenderPanel({ slot: THROW_TRIGGER_SLOT })).rejects.toThrow()
  })

  it('never resolves for the hang-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const raced = await Promise.race([
      hooks.uiPanel?.onRenderPanel({ slot: HANG_TRIGGER_SLOT }),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])
    expect(raced).toBe('still-pending')
  })

  it('resolves a malformed result for the garbage-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const result = await hooks.uiPanel?.onRenderPanel({ slot: GARBAGE_TRIGGER_SLOT })
    expect(typeof result?.html).not.toBe('string')
  })
})
