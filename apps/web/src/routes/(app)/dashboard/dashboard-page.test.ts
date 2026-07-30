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

// Story 18.5 AC-2/AC-6/AC-7
describe('/dashboard +page.svelte upcoming-rotations active badge (Story 18.5)', () => {
  it('AC-2/AC-7: an "active" entry renders the rotation-in-progress badge instead of Overdue/Scheduled', () => {
    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: null,
          selectedProject,
          dashboard: {
            ...dashboard,
            upcomingRotations: [
              {
                credentialId: 'c1',
                credentialName: 'Actively Rotating Credential',
                status: 'active',
                activeRotation: { rotationId: 'rot-1', status: 'staged' },
              },
            ],
          },
        },
      },
    })

    expect(screen.getByText(/rotation in progress/i)).toBeTruthy()
    expect(screen.queryByText('Overdue')).toBeNull()
    expect(screen.queryByText('Scheduled')).toBeNull()
  })

  it("AC-6: the active badge links to the rotation detail page using the credential detail page's link pattern", () => {
    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: null,
          selectedProject,
          dashboard: {
            ...dashboard,
            upcomingRotations: [
              {
                credentialId: 'c1',
                credentialName: 'Actively Rotating Credential',
                status: 'active',
                activeRotation: { rotationId: 'rot-1', status: 'staged' },
              },
            ],
          },
        },
      },
    })

    const link = screen.getByRole('link', { name: /rotation in progress/i })
    expect(link.getAttribute('href')).toBe('/projects/p1/credentials/c1/rotations/rot-1')
  })

  it('still renders the pre-existing Overdue/Scheduled badges for non-active entries', () => {
    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: null,
          selectedProject,
          dashboard: {
            ...dashboard,
            upcomingRotations: [
              {
                credentialId: 'c2',
                credentialName: 'Overdue Credential',
                scheduledAt: '2026-01-01T00:00:00.000Z',
                status: 'overdue',
              },
              {
                credentialId: 'c3',
                credentialName: 'Scheduled Credential',
                scheduledAt: '2026-09-01T00:00:00.000Z',
                status: 'pending',
              },
            ],
          },
        },
      },
    })

    expect(screen.getByText('Overdue')).toBeTruthy()
    expect(screen.getByText('Scheduled')).toBeTruthy()
  })
})
