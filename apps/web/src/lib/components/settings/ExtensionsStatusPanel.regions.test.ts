import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.11: the extension status page body is one sub-region per state. A probe contribution
// lands after its own section, and only the sub-regions of the state that renders are present.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/extensions' }, params: {} },
}))

const POINTS = [
  'settings.extensions.notice',
  'settings.extensions.summary',
  'settings.extensions.capabilities',
  'settings.extensions.declarations',
  'settings.extensions.not-loaded',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const MANIFEST = {
  name: 'test.mock-extension',
  apiVersion: '3.30.0',
  packageVersion: '1.2.3',
  capabilities: ['capability-gate'],
  loadedAt: '2026-10-04T08:00:00.000Z',
}

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./ExtensionsStatusPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Panel, {
    props: {
      allowed: true,
      mfaRequired: false,
      errorMessage: null,
      manifest: null,
      healthStatus: 'not_configured',
      data: fills,
      ...overrides,
    },
  })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('ExtensionsStatusPanel sub-regions (probe order)', () => {
  it('loaded: summary, capabilities and declarations probes each follow their own section', () => {
    mount({ manifest: MANIFEST, healthStatus: 'loaded' })
    const summary = probe('settings.extensions.summary')
    const capabilities = probe('settings.extensions.capabilities')
    const declarations = probe('settings.extensions.declarations')
    expect(follows(screen.getByText('Package version 1.2.3'), summary)).toBe(true)
    expect(follows(summary, screen.getByText('capability-gate'))).toBe(true)
    expect(follows(screen.getByText('capability-gate'), capabilities)).toBe(true)
    expect(follows(capabilities, screen.getByText(/^Loaded at /))).toBe(true)
    expect(follows(screen.getByText(/Audit event source/), declarations)).toBe(true)
    expect(probeCount()).toBe(3)
  })

  it('loaded: the capabilities probe also follows the empty-state line', () => {
    mount({ manifest: { ...MANIFEST, capabilities: [] }, healthStatus: 'loaded' })
    expect(
      follows(
        screen.getByText('No capabilities declared'),
        probe('settings.extensions.capabilities')
      )
    ).toBe(true)
  })

  it('not-loaded: after the not-configured card, and after the failed-load card', () => {
    mount()
    expect(
      follows(
        screen.getByText('No extension configured for this vault.'),
        probe('settings.extensions.not-loaded')
      )
    ).toBe(true)
    expect(probeCount()).toBe(1)
    cleanup()
    mount({ healthStatus: 'load_failed' })
    expect(
      follows(screen.getByText(/failed to load/), probe('settings.extensions.not-loaded'))
    ).toBe(true)
    expect(probeCount()).toBe(1)
  })

  it('notice: after the notice for a denied caller, an MFA-less admin and a failed fetch', () => {
    for (const overrides of [
      { allowed: false },
      { mfaRequired: true },
      { errorMessage: 'status unavailable' },
    ]) {
      mount(overrides)
      expect(probeCount()).toBe(1)
      expect(probe('settings.extensions.notice')).toBeTruthy()
      cleanup()
    }
  })

  it('a denied caller never reaches the manifest, even when one is passed', () => {
    mount({ allowed: false, manifest: MANIFEST })
    expect(screen.queryByText('test.mock-extension')).toBeNull()
    expect(screen.getByText('You need the Admin role to view extension status.')).toBeTruthy()
    expect(probeCount()).toBe(1)
  })

  it('shows the package version as unknown when the loader could not determine it', () => {
    mount({ manifest: { ...MANIFEST, packageVersion: null }, healthStatus: 'loaded' })
    expect(screen.getByText('Package version unknown')).toBeTruthy()
  })
})
