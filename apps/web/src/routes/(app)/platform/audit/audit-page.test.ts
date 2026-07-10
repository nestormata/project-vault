import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import AuditPage from './+page.svelte'

const MFA_MESSAGE =
  'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

function data(eventsErrorMessage: string | null) {
  return {
    allowed: true,
    events: [],
    eventsErrorMessage,
    filters: {},
    page: 1,
    total: 0,
    hasNext: false,
    maintenanceStatus: {
      active: false,
      reason: null,
      activatedAt: null,
      deactivatedAt: null,
      pendingEntriesCount: 0,
    },
    maintenanceStatusError: null,
  }
}

describe('/platform/audit load errors', () => {
  afterEach(cleanup)

  it('AC-M4/AC-M8: links the events MFA error while showing maintenance status', () => {
    render(AuditPage, { props: { data: data(MFA_MESSAGE) } })

    expect(screen.getByRole('link', { name: /enable mfa/i }).getAttribute('href')).toBe(
      '/settings/security'
    )
    expect(screen.getByText('Maintenance mode: inactive')).toBeTruthy()
  })

  it('AC-M5: renders a non-MFA events error without an enrollment link', () => {
    render(AuditPage, { props: { data: data('Failed to load platform audit events') } })
    expect(screen.getByText('Failed to load platform audit events')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
  })

  it('retains the empty-events state when there is no load error', () => {
    render(AuditPage, { props: { data: data(null) } })
    expect(screen.getByText('No platform audit events yet.')).toBeTruthy()
  })
})
