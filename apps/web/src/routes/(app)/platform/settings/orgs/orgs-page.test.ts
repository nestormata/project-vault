import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import OrgsPage from './+page.svelte'

const MFA_MESSAGE =
  'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

function data(errorMessage: string | null) {
  return {
    allowed: true,
    orgs: [],
    errorMessage,
  }
}

describe('/platform/settings/orgs load errors', () => {
  afterEach(cleanup)

  it('AC-M2: links an MFA-required load error to security settings', () => {
    render(OrgsPage, { props: { data: data(MFA_MESSAGE) } })

    expect(screen.getByRole('alert').textContent).toContain(MFA_MESSAGE)
    expect(screen.getByRole('link', { name: /enable mfa/i }).getAttribute('href')).toBe(
      '/settings/security'
    )
    expect(screen.queryByText('No organizations found.')).toBeNull()
  })

  it('AC-M5: renders a non-MFA load error without an enrollment link', () => {
    render(OrgsPage, { props: { data: data('Failed to load organizations') } })
    expect(screen.getByRole('alert').textContent).toContain('Failed to load organizations')
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
    expect(screen.queryByText('No organizations found.')).toBeNull()
  })

  it('retains the empty state when there is no load error', () => {
    render(OrgsPage, { props: { data: data(null) } })
    expect(screen.getByText('No organizations found.')).toBeTruthy()
  })
})
