import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import {
  dashboardEmptyStateCopy,
  forbiddenDashboardClaims,
  suggestedActionLabels,
} from '$lib/components/dashboard/dashboard-copy.js'
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
      add_service: 'Add first service - available in Epic 6',
      import_credentials: 'Import .env or JSON',
    })
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
