import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.12: the themes admin sections are one sub-region per card. A probe contribution lands
// after its own card, and each card keeps its own state across the other card's changes.

const api = vi.hoisted(() => ({
  triggerThemeReload: vi.fn(),
  updateOrgDefaultTheme: vi.fn(),
  invalidateAll: vi.fn(async () => undefined),
}))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/themes' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: api.invalidateAll }))
vi.mock('$lib/api/themes.js', () => ({ triggerThemeReload: api.triggerThemeReload }))
vi.mock('$lib/api/organization-settings.js', () => ({
  updateOrgDefaultTheme: api.updateOrgDefaultTheme,
}))

const POINTS = ['settings.themes.reload', 'settings.themes.org-default'] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const themes = [
  { name: 'base', label: 'Base' },
  { name: 'ocean', label: 'Ocean' },
]

let Sections: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Sections = (await import('./ThemesAdminSections.svelte')).default as unknown as typeof Sections
}, 60_000)
beforeEach(() => {
  api.triggerThemeReload.mockReset()
  api.updateOrgDefaultTheme.mockReset()
  api.invalidateAll.mockClear()
})
afterEach(cleanup)

const mount = (canReload = true) =>
  render(Sections, {
    props: { canReload, themes, orgId: 'org-1', orgDefaultThemeName: null, data: fills },
  })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const reloadButton = () => screen.getByRole('button', { name: 'Reload themes' })
const orgSelect = () =>
  screen.getByLabelText('Default theme for this organization') as HTMLSelectElement

describe('ThemesAdminSections sub-regions (probe order)', () => {
  it('each card is followed by its own probe, in page order', () => {
    mount()
    const reload = probe('settings.themes.reload')
    const orgDefault = probe('settings.themes.org-default')
    expect(follows(reloadButton(), reload)).toBe(true)
    expect(follows(reload, screen.getByText(/^Default theme for this organization$/))).toBe(true)
    expect(follows(document.getElementById('org-default-theme-help') as Node, orgDefault)).toBe(
      true
    )
    expect(reload.parentElement?.lastElementChild).toBe(reload)
    expect(orgDefault.parentElement?.lastElementChild).toBe(orgDefault)
  })

  it('the reload probe also follows the MFA notice that replaces the button', async () => {
    api.triggerThemeReload.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required' } as never, 'mfa')
    )
    mount()
    await fireEvent.click(reloadButton())
    const link = await screen.findByRole('link', { name: 'Enable MFA' })
    expect(follows(link, probe('settings.themes.reload'))).toBe(true)
  })

  it('renders no sub-region for a viewer who cannot reload', () => {
    mount(false)
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('ThemesAdminSections state (interaction)', () => {
  it('a reload outcome survives a save in the other card', async () => {
    api.triggerThemeReload.mockResolvedValue({ loaded: ['a'], failed: [] })
    api.updateOrgDefaultTheme.mockResolvedValue({ defaultThemeName: 'ocean' })
    mount()
    await fireEvent.click(reloadButton())
    await screen.findByText('Reloaded 1 theme(s).')
    await fireEvent.change(orgSelect(), { target: { value: 'ocean' } })
    await screen.findByText('Saved.')
    expect(screen.getByText('Reloaded 1 theme(s).')).toBeTruthy()
    expect(api.updateOrgDefaultTheme).toHaveBeenCalledWith(fetch, 'org-1', 'ocean')
    expect(api.invalidateAll).toHaveBeenCalledTimes(1)
    expect(follows(screen.getByText('Saved.'), probe('settings.themes.org-default'))).toBe(true)
  })

  it('a failed save is shown in its own card and leaves the reload card untouched', async () => {
    api.updateOrgDefaultTheme.mockRejectedValue(new ApiClientError(400, null, 'gone'))
    mount()
    await fireEvent.change(orgSelect(), { target: { value: 'ocean' } })
    await screen.findByText(/no longer available/)
    expect(screen.queryByText(/Reloaded/)).toBeNull()
    expect(follows(probe('settings.themes.reload'), screen.getByText(/no longer available/))).toBe(
      true
    )
  })

  it('never hands a typed or fetched value to a point', async () => {
    mount()
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.getAttribute('data-keys')).not.toMatch(/themes|orgId|orgDefault/)
    }
  })
})
