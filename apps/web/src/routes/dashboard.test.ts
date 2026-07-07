import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import {
  dashboardEmptyStateCopy,
  forbiddenDashboardClaims,
  suggestedActionLabels,
} from '$lib/components/dashboard/dashboard-copy.js'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { EMPTY_PROJECT_DASHBOARD } from '@project-vault/shared'
import DashboardPage from './(app)/dashboard/+page.svelte'

describe('dashboard empty state', () => {
  it('renders project-centric explanation and preview-only warning', () => {
    expect(dashboardEmptyStateCopy.projectModel).toContain('Projects are the home')
    expect(dashboardEmptyStateCopy.organizingPrinciple).toContain('organizes by project')
    expect(dashboardEmptyStateCopy.previewWarning).toBe(
      'Preview only. Use Create project for saved project dashboards.'
    )
  })

  it('does not allow fake healthy/success/count copy', () => {
    expect(forbiddenDashboardClaims).toEqual(
      expect.arrayContaining(['All systems healthy', '100% coverage'])
    )
    expect(JSON.stringify(dashboardEmptyStateCopy)).not.toContain('All systems healthy')
    expect(JSON.stringify(dashboardEmptyStateCopy)).not.toContain('100% coverage')
  })

  it('labels suggested actions without story deferrals', () => {
    expect(suggestedActionLabels).toEqual({
      add_credential: 'Add first credential',
      add_service: 'Add first service',
      import_credentials: 'Import .env or JSON',
    })
  })

  // AC-H1 (Story 6.4): the "Add first service" label used to read "...- available in Epic 6" —
  // a claim that stopped being true the moment 6.1 shipped its API, and is fully false now that
  // 6.4 ships the services/certificates/domains/service-endpoints UI. No residual "Epic 6" or
  // "coming soon" language should remain anywhere in this copy file after the fix.
  it('AC-H1: no residual "Epic 6" or "coming soon" language remains in dashboard-copy.ts', () => {
    const allCopy = JSON.stringify({ dashboardEmptyStateCopy, suggestedActionLabels })
    expect(allCopy).not.toContain('Epic 6')
    expect(allCopy).not.toContain('coming soon')
  })

  // AC-H2: pre-existing honest empty-state copy is explicitly left unchanged by this story.
  it('AC-H2: noCertificates/noServices empty-state copy is unchanged (already honest, not a "coming soon" claim)', () => {
    expect(dashboardEmptyStateCopy.noCertificates).toBe(
      'No certificate or domain records added yet.'
    )
    expect(dashboardEmptyStateCopy.noServices).toBe('No monitored services configured yet.')
  })
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function baseDashboardData(dashboardOverrides: Record<string, unknown> = {}) {
  return {
    projects: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    orgDashboard: null,
    selectedProject: { id: projectId, name: 'Payments', description: null },
    dashboard: { ...EMPTY_PROJECT_DASHBOARD, ...dashboardOverrides },
  }
}

describe('/dashboard +page.svelte — upcoming rotations widget (AC-23, G3)', () => {
  afterEach(() => cleanup())

  it('renders upcoming rotations for the first time, with an Overdue badge for overdue items (regression-critical for G3)', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          upcomingRotations: [
            {
              credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              credentialName: 'sk_stripe_live',
              scheduledAt: '2026-06-28T00:00:00.000Z',
              status: 'overdue',
            },
            {
              credentialId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              credentialName: 'db_password_prod',
              scheduledAt: '2026-07-20T00:00:00.000Z',
              status: 'pending',
            },
          ],
        }),
      },
    })

    expect(screen.getByText('Upcoming rotations')).toBeTruthy()
    expect(screen.getByText('sk_stripe_live')).toBeTruthy()
    expect(screen.getByText('db_password_prod')).toBeTruthy()
    expect(screen.getByText('Overdue')).toBeTruthy()
    expect(screen.getByText('Scheduled')).toBeTruthy()

    const link = screen.getByRole('link', { name: /sk_stripe_live/i })
    expect(link.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc`
    )
  })

  it('renders an honest empty state rather than omitting the section (AC-23 edge)', () => {
    render(DashboardPage, {
      props: { data: baseDashboardData({ upcomingRotations: [] }) },
    })

    expect(screen.getByText('Upcoming rotations')).toBeTruthy()
    expect(screen.getByText('No credentials have an upcoming rotation scheduled.')).toBeTruthy()
  })

  it('does not use forbidden fake-healthy dashboard copy anywhere in the widget', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          upcomingRotations: [
            {
              credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              credentialName: 'sk_stripe_live',
              scheduledAt: '2026-06-28T00:00:00.000Z',
              status: 'overdue',
            },
          ],
        }),
      },
    })

    for (const claim of forbiddenDashboardClaims) {
      expect(screen.queryByText(claim)).toBeNull()
    }
  })
})

describe('/dashboard +page.svelte — sealed vault on page load (AC-4)', () => {
  afterEach(() => cleanup())

  it('AC-4: renders the sealed-vault message in place of the entire dashboard body when data.vaultSealed is true', () => {
    render(DashboardPage, {
      props: {
        data: {
          projects: { items: [] },
          orgDashboard: null,
          selectedProject: null,
          dashboard: null,
          vaultSealed: true as const,
        },
      },
    })

    expect(screen.getByRole('alert').textContent).toContain(onboardingCopy.vaultSealedMessage)
    // A sealed vault means none of the dashboard's other data is trustworthy either — nothing
    // else should render, not even the empty-state grid.
    expect(screen.queryByText('Upcoming rotations')).toBeNull()
    expect(screen.queryByText('Credential overview')).toBeNull()
  })
})

describe('/dashboard +page.svelte — monitoredServiceHealth tile (AC-G1, G3 dashboard truth)', () => {
  afterEach(() => cleanup())

  it('AC-G1 happy path: shows the real healthy/degraded/down breakdown sourced from data.dashboard', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          monitoredServiceHealth: { healthy: 3, degraded: 1, down: 0 },
        }),
      },
    })

    expect(screen.getByText('Monitored services')).toBeTruthy()
    expect(screen.getByText('3 healthy · 1 degraded · 0 down')).toBeTruthy()
  })

  it('AC-G1 edge: zero endpoints registered shows an honest real zero, not a hidden/omitted tile', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
        }),
      },
    })

    expect(screen.getByText('Monitored services')).toBeTruthy()
    expect(screen.getByText('0 healthy · 0 degraded · 0 down')).toBeTruthy()
  })
})
