import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIPanel } from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import {
  DEFAULT_UI_PANEL_SLOTS,
  __resetUiPanelSlotsFallbackWarningForTests,
  isUiPanelCapabilityDeclared,
  renderExtensionPanel,
  resolveKnownUiPanelSlots,
} from './extension-panel.js'

function loadedState(overrides: {
  capabilities?: string[]
  uiPanel?: UIPanel
  uiPanelSlots?: string[]
  name?: string
  loadedAt?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: overrides.name ?? 'com.example.ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['ui-panel']) as never,
      ...(overrides.uiPanelSlots ? { uiPanelSlots: overrides.uiPanelSlots } : {}),
    },
    loadedAt: overrides.loadedAt ?? new Date().toISOString(),
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
    const result = await renderExtensionPanel('', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects an oversized slot value', async () => {
    const result = await renderExtensionPanel(
      'a'.repeat(65),
      DEFAULT_UI_PANEL_SLOTS,
      silentLogger()
    )
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a wrong-charset slot value', async () => {
    const result = await renderExtensionPanel('Group!', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3b: rejects a well-formed but not-the-one-known-slot value', async () => {
    const result = await renderExtensionPanel('document', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'invalid_slot' })
  })

  it('AC3: returns unavailable when no extension is loaded', async () => {
    const result = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3: returns unavailable when the loaded extension has no uiPanel hook', async () => {
    __setExtensionStateForTests(loadedState({}))
    const result = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('happy path: returns the rendered html when the hook resolves a well-formed result', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: '<p>hi</p>' }) } })
    )
    const result = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
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
    const result = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, logger)
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
    const result = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
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
    const promise = renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await promise
    expect(result).toEqual({ outcome: 'unavailable' })
  })

  it('AC3 Boundary & Edge Case Sweep: extension unloading between calls is re-checked fresh', async () => {
    __setExtensionStateForTests(
      loadedState({ uiPanel: { onRenderPanel: async () => ({ html: 'ok' }) } })
    )
    const first = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
    expect(first).toEqual({ outcome: 'ok', html: 'ok' })

    __resetExtensionStateForTests()
    const second = await renderExtensionPanel('group', DEFAULT_UI_PANEL_SLOTS, silentLogger())
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

describe('resolveKnownUiPanelSlots (Story 25.2 AC2/AC3)', () => {
  beforeEach(() => {
    __resetExtensionStateForTests()
    __resetUiPanelSlotsFallbackWarningForTests()
  })

  afterEach(() => {
    __resetExtensionStateForTests()
    __resetUiPanelSlotsFallbackWarningForTests()
  })

  it('AC2: falls back to the legacy single-slot default when no extension is loaded', () => {
    const logger = silentLogger()
    expect(resolveKnownUiPanelSlots(undefined, logger)).toEqual(DEFAULT_UI_PANEL_SLOTS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('AC2: falls back to the legacy single-slot default when uiPanelSlots is omitted, warning once', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])

    // AC2: assert call count, not just presence — must fire once at load, never per-request.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('AC2: uiPanelSlots: undefined explicitly behaves identically to omitted (also warns once)', () => {
    const status = loadedState({ capabilities: ['ui-panel'] })
    ;(status as { manifest: { uiPanelSlots?: string[] } }).manifest.uiPanelSlots = undefined
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('AC3: returns the manifest-declared list when present, never warning', () => {
    const status = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group', 'document'],
    })
    const logger = silentLogger()

    expect(resolveKnownUiPanelSlots(status, logger)).toEqual(['group', 'document'])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('AC3 Boundary & Edge Case Sweep: a reload with a different declared list resolves fresh on the very next call, not memoized', () => {
    const logger = silentLogger()
    const first = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group'],
      loadedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(resolveKnownUiPanelSlots(first, logger)).toEqual(['group'])

    const second = loadedState({
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group', 'document', 'classification'],
      loadedAt: '2026-01-01T00:05:00.000Z',
    })
    expect(resolveKnownUiPanelSlots(second, logger)).toEqual([
      'group',
      'document',
      'classification',
    ])
  })

  it('AC2 fallback-warning identity is per-load: reloading (new loadedAt) re-warns even for the same extension name', () => {
    const logger = silentLogger()
    const firstLoad = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: '2026-01-01T00:00:00.000Z',
    })
    resolveKnownUiPanelSlots(firstLoad, logger)
    resolveKnownUiPanelSlots(firstLoad, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const reloaded = loadedState({
      capabilities: ['ui-panel'],
      loadedAt: '2026-01-01T00:05:00.000Z',
    })
    resolveKnownUiPanelSlots(reloaded, logger)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})
