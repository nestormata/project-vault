import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIPanel } from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import {
  KNOWN_UI_PANEL_SLOTS,
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
} from './extension-panel.js'

function loadedState(overrides: { capabilities?: string[]; uiPanel?: UIPanel }): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
    },
    loadedAt: new Date().toISOString(),
    hooks: overrides.uiPanel ? { uiPanel: overrides.uiPanel } : {},
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

describe('renderExtensionPanel (Story 25.1 AC3/AC3b)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    vi.useRealTimers()
  })

  it('AC3b: rejects an empty slot before ever touching extension state', async () => {
    const result = await renderExtensionPanel('', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects an oversized slot value', async () => {
    const result = await renderExtensionPanel('a'.repeat(65), KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a wrong-charset slot value', async () => {
    const result = await renderExtensionPanel('Group!', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a well-formed but not-the-one-known-slot value', async () => {
    const result = await renderExtensionPanel('document', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3: returns unavailable when no extension is loaded', async () => {
    const result = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3: returns unavailable when the loaded extension has no uiPanel hook', async () => {
    __setExtensionStateForTests(loadedState({}))
    const result = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('happy path: returns the rendered html when the hook resolves a well-formed result', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: '<p>hi</p>' }) } })
    )
    const result = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'ok', html: '<p>hi</p>' })
  })

  it('AC3: degrades to unavailable when the hook throws', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: async () => {
            throw new Error('boom')
          },
        },
      })
    )
    const logger = silentLogger()
    const result = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, logger)
    expect(result).toEqual({ outcome: 'unavailable' })
    expect(logger.error).toHaveBeenCalled()
    // Never leaks the raw exception message/stack into the log payload's message string.
    const [, message] = logger.error.mock.calls[0] as [unknown, string]
    expect(message).not.toContain('boom')
  })

  it('AC3: degrades to unavailable when the hook returns a malformed result', async () => {
    __setExtensionStateForTests(
      loadedState({
        uiPanel: { onRenderPanel: async () => ({ html: 123 }) as never },
      })
    )
    const result = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3: degrades to unavailable when the hook times out', async () => {
    vi.useFakeTimers()
    __setExtensionStateForTests(
      loadedState({
        uiPanel: {
          onRenderPanel: () => new Promise(() => undefined),
        },
      })
    )
    const promise = renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await promise
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3 Boundary & Edge Case Sweep: extension unloading between calls is re-checked fresh', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) } })
    )
    const first = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(first).toEqual({ outcome: 'ok', html: 'ok' })

    __resetExtensionStateForTests()
    const second = await renderExtensionPanel('group', KNOWN_UI_PANEL_SLOTS, silentLogger())
    expect(second).toEqual({ outcome: 'unavailable' })
  })
})

describe('isUiPanelCapabilityDeclared (Story 25.1 AC5)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('is false when no extension is loaded', () => {
    expect(isUiPanelCapabilityDeclared()).toBe(false)
  })

  it('is false when the loaded extension does not declare ui-panel', () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['auth-provider'] }))
    expect(isUiPanelCapabilityDeclared()).toBe(false)
  })

  it('is true when the loaded extension declares ui-panel', () => {
    __setExtensionStateForTests(loadedState({ capabilities: ['ui-panel'] }))
    expect(isUiPanelCapabilityDeclared()).toBe(true)
  })
})
