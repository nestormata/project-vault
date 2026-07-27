import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import LanguagePage from './+page.svelte'

afterEach(() => cleanup())

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    options: [
      { locale: 'en', label: 'English', isCurrent: true },
      { locale: 'es', label: 'Español', isCurrent: false },
    ],
    ...overrides,
  }
}

describe('/settings/language +page.svelte (AC 1)', () => {
  it('renders every supported locale with the current selection indicated', () => {
    render(LanguagePage, { props: { data: baseData(), form: null } })

    expect(screen.getByText('English')).toBeTruthy()
    expect(screen.getByText('Español')).toBeTruthy()
    // Only the current option shows the "current selection" label.
    expect(screen.getAllByText('Current selection').length).toBe(1)
  })

  it('renders correctly with a single compiled locale (AC 1 edge — never hardcoded to "at least 2")', () => {
    render(LanguagePage, {
      props: {
        data: baseData({ options: [{ locale: 'en', label: 'English', isCurrent: true }] }),
        form: null,
      },
    })

    expect(screen.getByText('English')).toBeTruthy()
    expect(screen.queryByText('Español')).toBeNull()
  })

  it('surfaces a server-side action failure message', () => {
    render(LanguagePage, {
      props: { data: baseData(), form: { error: 'Unsupported locale' } },
    })

    expect(screen.getByRole('alert').textContent).toContain('Unsupported locale')
  })

  it('shows the incremental-translation-coverage note', () => {
    render(LanguagePage, { props: { data: baseData(), form: null } })

    expect(screen.getByText(/More of the app will be translated over time/i)).toBeTruthy()
  })
})
