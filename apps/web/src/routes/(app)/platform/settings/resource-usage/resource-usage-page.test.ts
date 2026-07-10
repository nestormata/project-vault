import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import ResourceUsagePage from './+page.svelte'

const MFA_MESSAGE =
  'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

function data(errorMessage: string | null, warnings: string[] = []) {
  return {
    allowed: true,
    usage: null,
    errorMessage,
    warnings,
  }
}

describe('/platform/settings/resource-usage load errors', () => {
  afterEach(cleanup)

  it('AC-M3: links an MFA-required load error to security settings', () => {
    render(ResourceUsagePage, { props: { data: data(MFA_MESSAGE) } })

    expect(screen.getByRole('alert').textContent).toContain(MFA_MESSAGE)
    expect(screen.getByRole('link', { name: /enable mfa/i }).getAttribute('href')).toBe(
      '/settings/security'
    )
  })

  it('AC-M5: renders a non-MFA load error without an enrollment link', () => {
    render(ResourceUsagePage, {
      props: { data: data('Service temporarily unavailable', ['key_custody_risk']) },
    })

    expect(screen.getByText('Service temporarily unavailable')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
    expect(screen.getByText(/master key custody risk/i)).toBeTruthy()
  })
})
