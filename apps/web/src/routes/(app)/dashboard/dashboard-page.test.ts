import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { setLocale } from '$lib/paraglide/runtime.js'
import DashboardPage from './+page.svelte'
import CrossProjectEmptyState from '$lib/components/dashboard/CrossProjectEmptyState.svelte'

afterEach(async () => {
  cleanup()
  await setLocale('en', { reload: false })
})

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

// Story 28.4 AC1 (happy path/edge): the Dashboard page and its rendered components route every
// user-facing string through m.dashboard_*(), with a real Spanish translation for each.
describe('Story 28.4 AC1: Dashboard copy translates under the Spanish locale', () => {
  afterEach(() => cleanup())

  it('happy path: the org-dashboard summary section renders in Spanish', async () => {
    await setLocale('es', { reload: false })

    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: {
            totalCredentials: 4,
            expiringWithin30Days: { count: 1, items: [] },
            unresolvedAlertCount: 0,
          },
          selectedProject: null,
          dashboard: null,
        },
      },
    })

    expect(screen.getByText('Organización')).toBeTruthy()
    expect(screen.getByText('Resumen de secretos')).toBeTruthy()
    expect(screen.getByText('Total de secretos')).toBeTruthy()
    expect(screen.queryByText('Secret overview')).toBeNull()
  })

  it('happy path: the project dashboard (upcoming rotations/recent activity) renders in Spanish', async () => {
    await setLocale('es', { reload: false })

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

    expect(screen.getByText('Próximas rotaciones')).toBeTruthy()
    expect(screen.getByText('Actividad reciente')).toBeTruthy()
    expect(screen.queryByText('Upcoming rotations')).toBeNull()
    expect(screen.queryByText('Recent activity')).toBeNull()
  })

  it('edge: the sealed-vault banner renders its title and message in Spanish', async () => {
    await setLocale('es', { reload: false })

    render(DashboardPage, {
      props: {
        data: {
          vaultSealed: true,
          orgDashboard: null,
          selectedProject: null,
          dashboard: null,
        },
      },
    })

    expect(screen.getByText('Vault sellado')).toBeTruthy()
  })

  // AC1 edge: the cross-project empty state is the least-visited branch, exactly the kind a less
  // careful translation pass would skip — a dedicated test targets it specifically.
  it('edge: CrossProjectEmptyState (zero-projects branch) renders in Spanish', async () => {
    await setLocale('es', { reload: false })

    render(CrossProjectEmptyState)

    expect(screen.getByText('Panel vacío')).toBeTruthy()
    expect(screen.getByText('Aún no hay proyectos guardados.')).toBeTruthy()
    expect(screen.getByText('Crea tu primer proyecto')).toBeTruthy()
    expect(screen.queryByText('Empty dashboard')).toBeNull()
    expect(screen.queryByText('Create your first project')).toBeNull()
  })
})

// Story 28.4 Task 3: dashboard-copy.ts's suggestedActionLabels/recentAccessEventLabels resolve at
// the point of use (not module-level literals), so — mirroring AC2's nav reactivity proof — a
// locale switch without remount updates them too.
describe('Story 28.4 Task 3: dashboard-copy labels are reactive to a no-reload locale switch', () => {
  afterEach(() => cleanup())

  it('re-renders the "Recent activity" event label in Spanish after setLocale, with no remount', async () => {
    const { rerender } = render(DashboardPage, {
      props: {
        data: {
          vaultSealed: false,
          orgDashboard: null,
          selectedProject,
          dashboard: {
            ...dashboard,
            recentAccessEvents: [
              {
                credentialId: 'c1',
                credentialName: 'sk_live',
                actorDisplayName: 'Nestor',
                eventType: 'credential.value_revealed',
                occurredAt: '2026-07-01T12:00:00.000Z',
              },
            ],
          },
        },
      },
    })

    expect(screen.getByText('Revealed value')).toBeTruthy()

    await setLocale('es', { reload: false })
    await rerender({
      data: {
        vaultSealed: false,
        orgDashboard: null,
        selectedProject,
        dashboard: {
          ...dashboard,
          recentAccessEvents: [
            {
              credentialId: 'c1',
              credentialName: 'sk_live',
              actorDisplayName: 'Nestor',
              eventType: 'credential.value_revealed',
              occurredAt: '2026-07-01T12:00:00.000Z',
            },
          ],
        },
      },
    })

    expect(screen.getByText('Valor revelado')).toBeTruthy()
    expect(screen.queryByText('Revealed value')).toBeNull()
  })
})
