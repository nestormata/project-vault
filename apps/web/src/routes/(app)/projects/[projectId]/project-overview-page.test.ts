import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import ProjectOverviewPage from './+page.svelte'

afterEach(() => cleanup())

const baseProject = {
  id: 'p1',
  orgId: 'org-1',
  name: 'Payments API',
  slug: 'payments-api',
  description: 'Stripe + billing webhooks',
  role: 'owner' as const,
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  tags: [] as string[],
  memberCount: 1,
}

describe('project overview +page.svelte (AC-1/AC-2/AC-5)', () => {
  it('AC-1: renders the project name as the h1 and its description', () => {
    render(ProjectOverviewPage, {
      props: {
        data: {
          project: { ...baseProject, description: 'Stripe + billing webhooks' },
          dashboard: {
            credentialStats: { active: 0, expiringSoon: 2, expired: 0 },
            monitoredServiceHealth: { healthy: 1, degraded: 0, down: 0 },
          },
          notFound: false,
        },
      },
    })

    expect(screen.getByRole('heading', { level: 1, name: 'Payments API' })).toBeTruthy()
    expect(screen.getByText('Stripe + billing webhooks')).toBeTruthy()
  })

  it('AC-2: shows real non-zero summary data when it exists', () => {
    render(ProjectOverviewPage, {
      props: {
        data: {
          project: { ...baseProject, memberCount: 4 },
          dashboard: {
            credentialStats: { active: 1, expiringSoon: 2, expired: 0 },
            monitoredServiceHealth: { healthy: 1, degraded: 0, down: 0 },
          },
          notFound: false,
        },
      },
    })

    expect(screen.getByText('4 members')).toBeTruthy()
    expect(screen.getByText(/2 expiring soon/)).toBeTruthy()
  })

  it('AC-2: shows an honest empty state (never a fabricated 0) for a brand-new project', () => {
    render(ProjectOverviewPage, {
      props: {
        data: {
          project: { ...baseProject, memberCount: 1 },
          dashboard: {
            credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
            monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          },
          notFound: false,
        },
      },
    })

    expect(screen.getByText('1 member')).toBeTruthy()
    expect(screen.getByText('Nothing expiring soon')).toBeTruthy()
    expect(screen.getByText('No services configured yet')).toBeTruthy()
  })

  it('AC-5: shows an Archived badge for an archived project', () => {
    render(ProjectOverviewPage, {
      props: {
        data: {
          project: { ...baseProject, archivedAt: '2026-06-01T00:00:00.000Z' },
          dashboard: {
            credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
            monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          },
          notFound: false,
        },
      },
    })

    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('AC-3: renders an honest not-found state instead of leaking any project data', () => {
    render(ProjectOverviewPage, {
      props: { data: { project: null, dashboard: null, notFound: true } },
    })

    expect(screen.getByText(/project not found/i)).toBeTruthy()
    expect(screen.queryByText('Payments API')).toBeNull()
  })
})
