import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type { UIPanelContext } from '@project-vault/extension-api'
import mockUiPanelExtension, {
  CONTEXT_ECHO_SLOT,
  GARBAGE_TRIGGER_SLOT,
  HANG_TRIGGER_SLOT,
  HAPPY_SLOT,
  TEST_ACTION_KIND,
  TEST_ACTION_NOTE,
  TEST_DATA_PATH,
  TEST_MODULE_DATA_PATH,
  TEST_NAV_CHILD_ITEM_ID,
  TEST_NAV_ITEM_ID,
  TEST_NAV_LINK_SUBPATH,
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

  it('Story 25.12 AC2/Task 6: declares panelDataPaths covering the legacy pair plus a new declared path', () => {
    expect(mockUiPanelExtension.manifest.panelDataPaths).toEqual([
      '/api/v1/projects',
      '/api/v1/projects/:id',
      TEST_DATA_PATH,
    ])
  })

  it('Story 29.3 AC13: declares a top-level navItems entry plus one nested child', () => {
    expect(mockUiPanelExtension.manifest.navItems).toEqual([
      { id: TEST_NAV_ITEM_ID, label: 'Mock Extension Settings', href: '/dashboard', icon: 'grid' },
      {
        id: TEST_NAV_CHILD_ITEM_ID,
        label: 'Mock Child Page',
        href: '/health',
        parentId: TEST_NAV_ITEM_ID,
      },
    ])
  })

  it('Story 29.4 AC1/AC10/Task 5: declares moduleDataRoutes with a real, matching moduleData handler', async () => {
    expect(mockUiPanelExtension.manifest.moduleDataRoutes).toEqual([
      { method: 'GET', path: TEST_MODULE_DATA_PATH },
    ])
    const hooks = mockUiPanelExtension.hooksFactory()
    const handler = hooks.moduleData?.[`GET ${TEST_MODULE_DATA_PATH}`]
    expect(typeof handler).toBe('function')
    const result = await handler?.({
      identity: { userId: 'user_1', orgRole: 'member' },
      orgId: 'org_1',
      params: {},
      query: {},
    })
    expect(result).toEqual({
      body: { ok: true, orgId: 'org_1', userId: 'user_1' },
    })
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

  it('Story 29.6 AC12: the happy-path html renders a plain <a href> navigation link, with no data-pv-action anywhere in its subtree', async () => {
    const hooks = mockUiPanelExtension.hooksFactory()
    const result = await hooks.uiPanel?.onRenderPanel(context({ slot: HAPPY_SLOT }))

    expect(result?.html).toContain(`<a href="${TEST_NAV_LINK_SUBPATH}">Open detail</a>`)
    const navLinkMarkup = result?.html?.match(/<a href="[^"]*">Open detail<\/a>/)?.[0] ?? ''
    expect(navLinkMarkup).not.toContain('data-pv-action')
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

  describe('moduleAction (Story 25.5 AC1/AC2)', () => {
    it('does not implement any other hook (proves module-action alone still declares uiPanel)', () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      expect(hooks.moduleAction).toBeDefined()
    })

    it('resolves ok for the declared TEST_ACTION_KIND', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.moduleAction?.onAction(context(), {
        action: { kind: TEST_ACTION_KIND },
      })
      expect(result).toEqual({
        outcome: 'ok',
        message: `test-action executed for slot "${HAPPY_SLOT}"`,
      })
    })

    it('resolves validation_failed for an unrecognized action kind', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.moduleAction?.onAction(context(), {
        action: { kind: 'not-a-real-kind' },
      })
      expect(result).toEqual({ outcome: 'validation_failed', message: 'Unknown action kind' })
    })

    it('Story 25.12 AC1/Task 6: echoes a field beyond kind (note) in the result message when present', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.moduleAction?.onAction(context(), {
        action: { kind: TEST_ACTION_KIND, note: TEST_ACTION_NOTE },
      })
      expect(result).toEqual({
        outcome: 'ok',
        message: `test-action executed for slot "${HAPPY_SLOT}" with note "${TEST_ACTION_NOTE}"`,
      })
    })

    it('Story 29.2 AC13: the fixture panel html declares the action button via data-pv-action/data-pv-action-note attributes, no inline <script>', async () => {
      const hooks = mockUiPanelExtension.hooksFactory()
      const result = await hooks.uiPanel?.onRenderPanel(
        context({ slot: HAPPY_SLOT, actionEndpoint: '/api/v1/extensions/panels/group/actions' })
      )
      expect(result?.html).toContain(`data-pv-action="${TEST_ACTION_KIND}"`)
      expect(result?.html).toContain(`data-pv-action-note="${TEST_ACTION_NOTE}"`)
      expect(result?.html).not.toContain('<script>')
      expect(result?.html).not.toContain('postMessage')
    })
  })
})
