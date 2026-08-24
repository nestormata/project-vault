import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type { UIPanelContext } from '@project-vault/extension-api'
import mockUiPanelExtension, {
  CONTEXT_ECHO_SLOT,
  GARBAGE_TRIGGER_SLOT,
  HANG_TRIGGER_SLOT,
  HAPPY_SLOT,
  THROW_TRIGGER_SLOT,
} from './index.js'

function context(overrides: Partial<UIPanelContext> = {}): UIPanelContext {
  return {
    slot: HAPPY_SLOT,
    identity: { userId: 'user_1', orgRole: 'member' },
    orgId: 'org_1',
    locale: 'en',
    theme: { name: null },
    ...overrides,
  }
}

describe('mock-ui-panel-extension (Story 25.1 Task 7)', () => {
  it('declares a valid, reverse-DNS manifest with only the ui-panel capability', () => {
    expect(mockUiPanelExtension.manifest.name).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
    expect(mockUiPanelExtension.manifest.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(mockUiPanelExtension.manifest.capabilities).toEqual(['ui-panel'])
  })

  it('Story 25.2 AC6/25.3 Task 5: declares uiPanelSlots covering the happy-path slot and all fixture trigger slots', () => {
    expect(mockUiPanelExtension.manifest.uiPanelSlots).toEqual([
      HAPPY_SLOT,
      THROW_TRIGGER_SLOT,
      HANG_TRIGGER_SLOT,
      GARBAGE_TRIGGER_SLOT,
      CONTEXT_ECHO_SLOT,
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
    const result = await hooks.uiPanel?.onRenderPanel(context({ slot: HAPPY_SLOT }))
    expect(typeof result?.html).toBe('string')
    expect(result?.html).toContain(HAPPY_SLOT)
  })

  it('Story 25.4 AC4 Task 4: the happy-path html consumes at least one --pv-ext-* custom property with a CM-style fallback', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const result = await hooks.uiPanel?.onRenderPanel(context({ slot: HAPPY_SLOT }))

    expect(result?.html).toMatch(/var\(--pv-ext-[a-z]{1,20},[ ]{0,3}#[0-9a-fA-F]{3,8}\)/)
  })

  it('throws for the throw-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    await expect(
      hooks.uiPanel?.onRenderPanel(context({ slot: THROW_TRIGGER_SLOT }))
    ).rejects.toThrow()
  })

  it('never resolves for the hang-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const raced = await Promise.race([
      hooks.uiPanel?.onRenderPanel(context({ slot: HANG_TRIGGER_SLOT })),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])
    expect(raced).toBe('still-pending')
  })

  it('resolves a malformed result for the garbage-trigger slot', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const result = await hooks.uiPanel?.onRenderPanel(context({ slot: GARBAGE_TRIGGER_SLOT }))
    expect(typeof result?.html).not.toBe('string')
  })

  describe('fixture-context-echo (Story 25.3 AC1-AC5)', () => {
    it('renders every context field as visible text, including optional fields when present', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.uiPanel?.onRenderPanel(
        context({
          slot: CONTEXT_ECHO_SLOT,
          identity: { userId: 'user_42', orgRole: 'owner' },
          orgId: 'org_9',
          projectId: 'proj_1',
          resourceId: 'grp_42',
          locale: 'es',
          theme: { name: 'midnight' },
        })
      )
      expect(result?.html).toContain('userId:user_42')
      expect(result?.html).toContain('orgRole:owner')
      expect(result?.html).toContain('orgId:org_9')
      expect(result?.html).toContain('projectId:proj_1')
      expect(result?.html).toContain('resourceId:grp_42')
      expect(result?.html).toContain('locale:es')
      expect(result?.html).toContain('themeName:midnight')
    })

    it('renders optional fields as empty when omitted from context', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.uiPanel?.onRenderPanel(context({ slot: CONTEXT_ECHO_SLOT }))
      expect(result?.html).toContain('projectId:</p>')
      expect(result?.html).toContain('resourceId:</p>')
      expect(result?.html).toContain('themeName:</p>')
    })
  })
})
