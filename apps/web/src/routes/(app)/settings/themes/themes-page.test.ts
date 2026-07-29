import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const patchThemeSelectionMock = vi.hoisted(() => vi.fn())
const triggerThemeReloadMock = vi.hoisted(() => vi.fn())
const setAppliedThemeMock = vi.hoisted(() => vi.fn())
const invalidateAllMock = vi.hoisted(() => vi.fn())
const updateOrgDefaultThemeMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/themes.js', () => ({
  patchThemeSelection: patchThemeSelectionMock,
  triggerThemeReload: triggerThemeReloadMock,
}))
vi.mock('$lib/api/organization-settings.js', () => ({
  updateOrgDefaultTheme: updateOrgDefaultThemeMock,
}))
vi.mock('$lib/state/theme.svelte.js', () => ({ setAppliedTheme: setAppliedThemeMock }))
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

import ThemesPage from './+page.svelte'

afterEach(() => cleanup())

beforeEach(() => {
  patchThemeSelectionMock.mockReset()
  triggerThemeReloadMock.mockReset()
  setAppliedThemeMock.mockReset()
  invalidateAllMock.mockReset()
  updateOrgDefaultThemeMock.mockReset()
})

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    themes: [
      { name: 'base', label: 'Default', css: null },
      { name: 'acme-brand', label: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
    ],
    selected: null,
    errorMessage: null,
    orgRole: 'member',
    orgId: 'org-1',
    canReload: false,
    orgDefaultThemeName: null,
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

// Story 16.3 — "Reload themes" admin UI section
describe('/settings/themes +page.svelte reload section — visibility (Story 16.3 AC-1)', () => {
  it('AC-1: renders no reload section, button, or heading for a member/viewer (canReload false)', () => {
    render(ThemesPage, { props: { data: baseData({ orgRole: 'viewer', canReload: false }) } })

    expect(screen.queryByRole('button', { name: /reload themes/i })).toBeNull()
    expect(screen.queryByText(/reload themes/i)).toBeNull()
  })

  it('AC-1: renders the reload section and button for an admin/owner (canReload true)', () => {
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    expect(screen.getByRole('button', { name: /reload themes/i })).toBeTruthy()
  })
})

describe('/settings/themes +page.svelte reload section — happy path (Story 16.3 AC-2)', () => {
  it('AC-2: shows "Reloaded N theme(s)." and refetches the page data on a 200 with no failures', async () => {
    triggerThemeReloadMock.mockResolvedValue({ loaded: ['acme-brand', 'other'], failed: [] })
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    expect(await screen.findByText('Reloaded 2 theme(s).')).toBeTruthy()
    expect(triggerThemeReloadMock).toHaveBeenCalledWith(expect.any(Function))
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
  })

  it('AC-2 edge: "Reloaded 0 themes." (N=0) is a valid success state, not an error', async () => {
    triggerThemeReloadMock.mockResolvedValue({ loaded: [], failed: [] })
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Reloaded 0 theme(s).')
  })
})

describe('/settings/themes +page.svelte reload section — partial failure (Story 16.3 AC-3)', () => {
  it('AC-3: reports loaded/failed counts and lists each failed file with its reason as a warning, not an error', async () => {
    triggerThemeReloadMock.mockResolvedValue({
      loaded: ['acme-brand'],
      failed: [{ file: 'broken.css', reason: 'invalid CSS syntax' }],
    })
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Reloaded 1 theme(s).')
    expect(status.textContent).toContain('1 failed')
    expect(status.textContent).toContain('broken.css')
    expect(status.textContent).toContain('invalid CSS syntax')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('/settings/themes +page.svelte reload section — MFA required (Story 16.3 AC-4)', () => {
  it('AC-4: a 403 mfa_required response replaces the button with an inline MFA-required notice', async () => {
    triggerThemeReloadMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required' }, 'MFA required')
    )
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    expect(await screen.findByText(/mfa required to reload themes/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reload themes/i })).toBeNull()
  })
})

describe('/settings/themes +page.svelte reload section — rate limit (Story 16.3 AC-5)', () => {
  it('AC-5: a 429 response shows an error banner instructing the admin to wait, and does not retry automatically', async () => {
    triggerThemeReloadMock.mockRejectedValue(new ApiClientError(429, null, 'Too many requests'))
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(triggerThemeReloadMock).toHaveBeenCalledTimes(1)
  })
})

describe('/settings/themes +page.svelte reload section — pending state (Story 16.3 AC-6)', () => {
  it('AC-6: disables the button and shows a pending label while the request is in flight', async () => {
    let resolveReload!: (value: { loaded: string[]; failed: never[] }) => void
    triggerThemeReloadMock.mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve
      })
    )
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    const button = screen.getByRole('button', { name: /reload themes/i })
    await fireEvent.click(button)

    expect(button).toHaveProperty('disabled', true)
    expect(button.textContent).toMatch(/reloading/i)

    resolveReload({ loaded: [], failed: [] })
    await vi.waitFor(() => expect(button).toHaveProperty('disabled', false))
  })
})

describe('/settings/themes +page.svelte reload section — audit write failure (Story 16.3 AC-7)', () => {
  it('AC-7: a 503 audit_write_failed response shows a generic "Reload failed" error banner', async () => {
    triggerThemeReloadMock.mockRejectedValue(
      new ApiClientError(503, { code: 'audit_write_failed' }, 'Audit write failed')
    )
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/reload failed/i)
  })
})

describe('/settings/themes +page.svelte reload section — insufficient role defense-in-depth (Story 16.3 AC-8)', () => {
  it('AC-8: a 403 insufficient_role response (stale session) shows a generic error banner, not an unhandled exception', async () => {
    triggerThemeReloadMock.mockRejectedValue(
      new ApiClientError(403, { code: 'insufficient_role' }, 'Insufficient role')
    )
    render(ThemesPage, { props: { data: baseData({ orgRole: 'admin', canReload: true }) } })

    await fireEvent.click(screen.getByRole('button', { name: /reload themes/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

// Story 16.4 Task 5 — "Default theme for this organization" admin/owner-only section
describe('/settings/themes +page.svelte org default theme section — visibility (Story 16.4 AC-1)', () => {
  it('hides the section for a member/viewer (canReload false)', () => {
    render(ThemesPage, { props: { data: baseData({ orgRole: 'member', canReload: false }) } })

    expect(screen.queryByText(/default theme for this organization/i)).toBeNull()
  })

  it('shows the section, pre-selected to the current org default, for an admin/owner', () => {
    render(ThemesPage, {
      props: {
        data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: 'acme-brand' }),
      },
    })

    const select = screen.getByRole('combobox', {
      name: /default theme for this organization/i,
    }) as HTMLSelectElement
    expect(select.value).toBe('acme-brand')
  })

  it('pre-selects "None (base theme)" when no org default is configured', () => {
    render(ThemesPage, {
      props: { data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: null }) },
    })

    const select = screen.getByRole('combobox', {
      name: /default theme for this organization/i,
    }) as HTMLSelectElement
    expect(select.value).toBe('')
  })
})

describe('/settings/themes +page.svelte org default theme section — save (Story 16.4 AC-1)', () => {
  it('saves immediately on change and shows a success confirmation', async () => {
    updateOrgDefaultThemeMock.mockResolvedValue({ orgId: 'org-1', defaultThemeName: 'acme-brand' })
    render(ThemesPage, {
      props: { data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: null }) },
    })

    const select = screen.getByRole('combobox', { name: /default theme for this organization/i })
    await fireEvent.change(select, { target: { value: 'acme-brand' } })

    expect(updateOrgDefaultThemeMock).toHaveBeenCalledWith(
      expect.any(Function),
      'org-1',
      'acme-brand'
    )
    expect(await screen.findByRole('status')).toBeTruthy()
  })

  it('selecting "None (base theme)" clears the org default back to null', async () => {
    updateOrgDefaultThemeMock.mockResolvedValue({ orgId: 'org-1', defaultThemeName: null })
    render(ThemesPage, {
      props: {
        data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: 'acme-brand' }),
      },
    })

    const select = screen.getByRole('combobox', { name: /default theme for this organization/i })
    await fireEvent.change(select, { target: { value: '' } })

    expect(updateOrgDefaultThemeMock).toHaveBeenCalledWith(expect.any(Function), 'org-1', null)
  })

  it('shows a generic error banner when the save fails', async () => {
    updateOrgDefaultThemeMock.mockRejectedValue(new Error('boom'))
    render(ThemesPage, {
      props: { data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: null }) },
    })

    const select = screen.getByRole('combobox', { name: /default theme for this organization/i })
    await fireEvent.change(select, { target: { value: 'acme-brand' } })

    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('AC-1 edge: an unknown_theme 400 (stale client list) shows a dedicated defensive message', async () => {
    updateOrgDefaultThemeMock.mockRejectedValue(
      new ApiClientError(400, { code: 'unknown_theme' }, "unknown theme 'acme-brand'")
    )
    render(ThemesPage, {
      props: { data: baseData({ orgRole: 'admin', canReload: true, orgDefaultThemeName: null }) },
    })

    const select = screen.getByRole('combobox', { name: /default theme for this organization/i })
    await fireEvent.change(select, { target: { value: 'acme-brand' } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/no longer available/i)
  })
})
