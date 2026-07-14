import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import DashboardPage from './+page.svelte'

afterEach(() => cleanup())

const selectedProject = {
  id: 'p1',
  name: 'Payments API',
  description: 'Stripe + billing webhooks',
}

const dashboard = {
  credentialStats: { active: 3, expiringSoon: 1, expired: 0 },
  unresolvedAlertCount: 0,
  monitoredServiceHealth: { healthy: 1, degraded: 0, down: 0 },
  upcomingRotations: [],
  recentAccessEvents: [],
  suggestedActions: [],
}

describe('/dashboard +page.svelte (AC-13)', () => {
  it('the selected project name links to its overview page, not a credential deep link', () => {
    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: null,
          selectedProject,
          dashboard,
        },
      },
    })

    const link = screen.getByRole('link', { name: 'Payments API' })
    expect(link.getAttribute('href')).toBe('/projects/p1')
  })
})
