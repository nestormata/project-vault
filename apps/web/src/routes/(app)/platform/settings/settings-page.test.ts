import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsPage from './+page.svelte'

const MFA_MESSAGE =
  'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

function data(errorMessage: string | null) {
  return {
    allowed: true,
    settings: null,
    errorMessage,
  }
}

describe('/platform/settings load errors', () => {
  afterEach(cleanup)

  it('AC-M1: links an MFA-required load error to security settings', () => {
    render(SettingsPage, { props: { data: data(MFA_MESSAGE) } })

    expect(screen.getByRole('alert').textContent).toContain(MFA_MESSAGE)
    expect(screen.getByRole('link', { name: /enable mfa/i }).getAttribute('href')).toBe(
      '/settings/security'
    )
  })

  it('AC-M5: renders a non-MFA load error without an enrollment link', () => {
    render(SettingsPage, { props: { data: data('Failed to load settings') } })

    expect(screen.getByRole('alert').textContent).toContain('Failed to load settings')
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
  })

  it('renders no alert when the load has no error', () => {
    render(SettingsPage, { props: { data: data(null) } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
