import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import MfaAwareErrorAlert from './MfaAwareErrorAlert.svelte'

describe('MfaAwareErrorAlert', () => {
  afterEach(cleanup)

  it('links an MFA-required error to security settings', () => {
    const message =
      'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

    render(MfaAwareErrorAlert, { props: { message, class: 'test-alert' } })

    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(screen.getByRole('alert').classList.contains('test-alert')).toBe(true)
    expect(screen.getByRole('link', { name: /enable mfa/i }).getAttribute('href')).toBe(
      '/settings/security'
    )
  })

  it('renders a non-MFA error without an enrollment link', () => {
    render(MfaAwareErrorAlert, {
      props: { message: 'Service temporarily unavailable', class: 'test-alert' },
    })

    expect(screen.getByRole('alert').textContent).toContain('Service temporarily unavailable')
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
  })

  it('renders nothing when there is no error', () => {
    render(MfaAwareErrorAlert, { props: { message: null, class: 'test-alert' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
