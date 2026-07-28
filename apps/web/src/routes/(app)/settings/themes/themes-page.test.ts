import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const patchThemeSelectionMock = vi.hoisted(() => vi.fn())
const setAppliedThemeMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/themes.js', () => ({ patchThemeSelection: patchThemeSelectionMock }))
vi.mock('$lib/state/theme.svelte.js', () => ({ setAppliedTheme: setAppliedThemeMock }))

import ThemesPage from './+page.svelte'

afterEach(() => cleanup())

beforeEach(() => {
  patchThemeSelectionMock.mockReset()
  setAppliedThemeMock.mockReset()
})

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    themes: [
      { name: 'base', label: 'Default', css: null },
      { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
    ],
    selected: null,
    errorMessage: null,
    ...overrides,
  }
}

describe('/settings/themes +page.svelte (Story 16.2 AC-1)', () => {
  it('renders every available theme, "Default" first, with the current selection indicated', () => {
    render(ThemesPage, { props: { data: baseData({ selected: 'acme-brand' }) } })

    const options = screen.getAllByRole('radio')
    expect(options).toHaveLength(2)
    expect(screen.getByRole('radio', { name: /Default/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /acme-brand/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /acme-brand/ })).toHaveProperty('checked', true)
  })

  it('AC-1 edge: renders sanely with only the base theme (fresh instance, no custom themes)', () => {
    render(ThemesPage, {
      props: { data: baseData({ themes: [{ name: 'base', label: 'Default', css: null }] }) },
    })

    expect(screen.getByRole('radio', { name: /Default/ })).toHaveProperty('checked', true)
  })

  it('AC-3: shows a disabled "currently unavailable" option for an orphaned stored selection', () => {
    render(ThemesPage, {
      props: {
        data: baseData({
          themes: [{ name: 'base', label: 'Default', css: null }],
          selected: 'removed-theme',
        }),
      },
    })

    const unavailable = screen.getByRole('radio', { name: /removed-theme.*currently unavailable/i })
    expect(unavailable).toHaveProperty('disabled', true)
    expect(unavailable).toHaveProperty('checked', true)
  })

  it('surfaces the load errorMessage instead of the theme list', () => {
    render(ThemesPage, {
      props: { data: baseData({ errorMessage: 'Failed to load themes, try again.' }) },
    })

    expect(screen.getByRole('alert').textContent).toContain('Failed to load themes')
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })
})

describe('/settings/themes +page.svelte selection (Story 16.2 AC-2)', () => {
  it('AC-2: selecting a theme saves immediately (no Save button) and applies it only after the server confirms (pessimistic)', async () => {
    patchThemeSelectionMock.mockResolvedValue({ themeName: 'acme-brand' })
    render(ThemesPage, { props: { data: baseData({ selected: null }) } })

    await fireEvent.click(screen.getByRole('radio', { name: /acme-brand/ }))

    expect(patchThemeSelectionMock).toHaveBeenCalledWith(expect.any(Function), 'acme-brand')
    await vi.waitFor(() => expect(setAppliedThemeMock).toHaveBeenCalledWith('acme-brand'))
  })

  it('AC-2 edge: selecting "Default" clears back to null', async () => {
    patchThemeSelectionMock.mockResolvedValue({ themeName: null })
    render(ThemesPage, { props: { data: baseData({ selected: 'acme-brand' }) } })

    await fireEvent.click(screen.getByRole('radio', { name: /Default/ }))

    expect(patchThemeSelectionMock).toHaveBeenCalledWith(expect.any(Function), null)
    await vi.waitFor(() => expect(setAppliedThemeMock).toHaveBeenCalledWith(null))
  })

  it('AC-2 edge: a rejected PATCH surfaces an inline error and never applies the new theme (pessimistic UI)', async () => {
    patchThemeSelectionMock.mockRejectedValue(new Error('boom'))
    render(ThemesPage, { props: { data: baseData({ selected: null }) } })

    await fireEvent.click(screen.getByRole('radio', { name: /acme-brand/ }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(setAppliedThemeMock).not.toHaveBeenCalled()
  })
})
