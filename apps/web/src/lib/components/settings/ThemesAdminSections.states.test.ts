// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the themes admin sections' client-driven states (reload outcomes and errors, the
// MFA notice, the org default save) cannot be reached by the route oracles. This pins them: the
// snapshot was recorded BEFORE the component was split into sub-regions and must come out
// unchanged. The mount helper is the only line that follows the component's props.

const api = vi.hoisted(() => ({
  triggerThemeReload: vi.fn(),
  updateOrgDefaultTheme: vi.fn(),
  invalidateAll: vi.fn(async () => undefined),
}))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/navigation', () => ({ invalidateAll: api.invalidateAll }))
vi.mock('$lib/api/themes.js', () => ({ triggerThemeReload: api.triggerThemeReload }))
vi.mock('$lib/api/organization-settings.js', () => ({
  updateOrgDefaultTheme: api.updateOrgDefaultTheme,
}))

const themes = [
  { name: 'base', label: 'Base' },
  { name: 'ocean', label: 'Ocean' },
  { name: 'forest', label: 'Forest' },
]

let Sections: Component<Record<string, unknown>>
beforeAll(async () => {
  Sections = (await import('./ThemesAdminSections.svelte')).default as unknown as typeof Sections
}, 60_000)
beforeEach(() => {
  api.triggerThemeReload.mockReset()
  api.updateOrgDefaultTheme.mockReset()
  api.invalidateAll.mockClear()
})
afterEach(cleanup)

const mountSections = (overrides: Record<string, unknown> = {}) =>
  render(Sections, {
    props: {
      canReload: true,
      themes,
      orgId: 'org-1',
      orgDefaultThemeName: 'ocean',
      ...overrides,
    },
  })
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const reload = () => fireEvent.click(screen.getByRole('button', { name: 'Reload themes' }))
const orgSelect = () =>
  screen.getByLabelText('Default theme for this organization') as HTMLSelectElement
const choose = (value: string) => fireEvent.change(orgSelect(), { target: { value } })
const failWith = (status: number, code?: string) =>
  new ApiClientError(status, code ? ({ code } as never) : null, 'failed')

describe('ThemesAdminSections client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const initial = mountSections()
    states['initial'] = serializeWithoutNoise(initial.container)
    cleanup()

    const hidden = mountSections({ canReload: false })
    states['cannot-reload'] = serializeWithoutNoise(hidden.container)
    cleanup()

    const noDefault = mountSections({ orgDefaultThemeName: null })
    states['no-org-default'] = serializeWithoutNoise(noDefault.container)
    cleanup()

    api.triggerThemeReload.mockResolvedValueOnce({ loaded: ['a', 'b'], failed: [] })
    const ok = mountSections()
    await reload()
    await screen.findByText('Reloaded 2 theme(s).')
    states['reload-ok'] = serializeWithoutNoise(ok.container)
    states['reload-ok-invalidated'] = api.invalidateAll.mock.calls.length
    cleanup()

    api.triggerThemeReload.mockResolvedValueOnce({
      loaded: ['a'],
      failed: [
        { file: 'x.css', reason: 'bad' },
        { file: 'y.css', reason: 'worse' },
      ],
    })
    const partial = mountSections()
    await reload()
    await screen.findByText(/2 failed/)
    states['reload-partial'] = serializeWithoutNoise(partial.container)
    cleanup()

    api.triggerThemeReload.mockRejectedValueOnce(failWith(403, 'mfa_required'))
    const mfa = mountSections()
    await reload()
    await screen.findByText(/MFA required to reload themes/)
    states['reload-mfa'] = serializeWithoutNoise(mfa.container)
    cleanup()

    for (const status of [429, 503, 403, 500]) {
      api.triggerThemeReload.mockRejectedValueOnce(failWith(status))
      const failed = mountSections()
      await reload()
      await screen.findByRole('alert')
      states[`reload-error-${status}`] = serializeWithoutNoise(failed.container)
      cleanup()
    }

    api.triggerThemeReload.mockRejectedValueOnce(new Error('network'))
    const generic = mountSections()
    await reload()
    await screen.findByRole('alert')
    states['reload-error-generic'] = serializeWithoutNoise(generic.container)
    cleanup()

    api.triggerThemeReload.mockReturnValueOnce(new Promise(() => undefined))
    const reloading = mountSections()
    await reload()
    await screen.findByRole('button', { name: 'Reloading…' })
    states['reloading'] = serializeWithoutNoise(reloading.container)
    cleanup()

    api.updateOrgDefaultTheme.mockResolvedValueOnce({ defaultThemeName: 'forest' })
    const saved = mountSections()
    await choose('forest')
    await screen.findByText('Saved.')
    states['org-default-saved'] = serializeWithoutNoise(saved.container)
    states['org-default-saved-value'] = orgSelect().value
    states['org-default-args'] = api.updateOrgDefaultTheme.mock.calls.map((call) => call.slice(1))
    cleanup()

    api.updateOrgDefaultTheme.mockResolvedValueOnce({ defaultThemeName: null })
    const cleared = mountSections()
    await choose('')
    await screen.findByText('Saved.')
    states['org-default-cleared'] = serializeWithoutNoise(cleared.container)
    states['org-default-cleared-args'] = api.updateOrgDefaultTheme.mock.calls.map((call) =>
      call.slice(1)
    )
    cleanup()

    api.updateOrgDefaultTheme.mockRejectedValueOnce(failWith(400))
    const stale = mountSections()
    await choose('forest')
    await screen.findByText(/no longer available/)
    states['org-default-400'] = serializeWithoutNoise(stale.container)
    cleanup()

    api.updateOrgDefaultTheme.mockRejectedValueOnce(new Error('network'))
    const failed = mountSections()
    await choose('forest')
    await screen.findByText(/Failed to save the organization default theme/)
    states['org-default-error'] = serializeWithoutNoise(failed.container)
    cleanup()

    api.updateOrgDefaultTheme.mockReturnValueOnce(new Promise(() => undefined))
    const saving = mountSections()
    await choose('forest')
    await waitFor(() => expect(orgSelect().disabled).toBe(true))
    states['org-default-saving'] = serializeWithoutNoise(saving.container)

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './ThemesAdminSections.states.snapshot.json'
    )
  }, 60_000)
})
