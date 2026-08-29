import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import {
  forbiddenDashboardClaims,
  getDashboardEmptyStateCopy,
  getRecentAccessEventLabels,
  getSuggestedActionLabels,
} from '$lib/components/dashboard/dashboard-copy.js'
import { m } from '$lib/paraglide/messages.js'
import { formatDateTime } from '$lib/datetime.js'
import { EMPTY_PROJECT_DASHBOARD } from '@project-vault/shared'
import DashboardPage from './(app)/dashboard/+page.svelte'

describe('dashboard empty state', () => {
  it('renders project-centric explanation and preview-only warning', () => {
    const copy = getDashboardEmptyStateCopy()
    expect(copy.projectModel).toContain('Projects are the home')
    expect(copy.organizingPrinciple).toContain('organizes by project')
    expect(copy.previewWarning).toBe(
      'Preview only. Use Create project for saved project dashboards.'
    )
  })

  it('does not allow fake healthy/success/count copy', () => {
    expect(forbiddenDashboardClaims).toEqual(
      expect.arrayContaining(['All systems healthy', '100% coverage'])
    )
    const copy = getDashboardEmptyStateCopy()
    expect(JSON.stringify(copy)).not.toContain('All systems healthy')
    expect(JSON.stringify(copy)).not.toContain('100% coverage')
  })

  it('labels suggested actions without story deferrals', () => {
    expect(getSuggestedActionLabels()).toEqual({
      add_credential: 'Add first secret',
      add_service: 'Add first service',
      import_credentials: 'Import .env or JSON',
    })
  })

  // AC-H1 (Story 6.4): the "Add first service" label used to read "...- available in Epic 6" —
  // a claim that stopped being true the moment 6.1 shipped its API, and is fully false now that
  // 6.4 ships the services/certificates/domains/service-endpoints UI. No residual "Epic 6" or
  // "coming soon" language should remain anywhere in this copy file after the fix.
  it('AC-H1: no residual "Epic 6" or "coming soon" language remains in dashboard-copy.ts', () => {
    const allCopy = JSON.stringify({
      dashboardEmptyStateCopy: getDashboardEmptyStateCopy(),
      suggestedActionLabels: getSuggestedActionLabels(),
    })
    expect(allCopy).not.toContain('Epic 6')
    expect(allCopy).not.toContain('coming soon')
  })

  // AC-H2: pre-existing honest empty-state copy is explicitly left unchanged by this story.
  it('AC-H2: noCertificates/noServices empty-state copy is unchanged (already honest, not a "coming soon" claim)', () => {
    const copy = getDashboardEmptyStateCopy()
    expect(copy.noCertificates).toBe('No certificate or domain records added yet.')
    expect(copy.noServices).toBe('No monitored services configured yet.')
  })
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function baseDashboardData(dashboardOverrides: Record<string, unknown> = {}) {
  return {
    projects: {
      items: [
        {
          id: projectId,
          name: 'Payments',
          description: null,
          slug: 'payments',
          role: 'owner',
          credentialCount: 0,
          expiringCount: 0,
          alertCount: 0,
          tags: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          archivedAt: null,
          isArchived: false,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      hasNext: false,
    },
    orgDashboard: null,
    selectedProject: { id: projectId, name: 'Payments', description: null },
    dashboard: { ...EMPTY_PROJECT_DASHBOARD, ...dashboardOverrides },
    monitoringAssets: {
      certificates: { status: 'ready', count: 0 },
      domains: { status: 'ready', count: 0 },
    },
    alertStatus: 'ready',
  }
}

describe('/dashboard project selection (Story 18.12 AC-1b/AC-7)', () => {
  afterEach(() => cleanup())

  it('shows the selected project scope and an accessible project selector', () => {
    render(DashboardPage, {
      props: {
        data: {
          ...baseDashboardData(),
          projects: {
            ...baseDashboardData().projects,
            items: [
              baseDashboardData().projects.items[0],
              {
                ...baseDashboardData().projects.items[0],
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                name: 'Inventory',
                slug: 'inventory',
              },
            ],
            total: 2,
          },
        },
      },
    })

    expect(screen.getByText('Showing data for Payments')).toBeTruthy()
    const selector = screen.getByRole('combobox', { name: 'Dashboard project' })
    expect(selector).toBeTruthy()
    expect(selector.getAttribute('aria-describedby')).toBe('dashboard-project-help')
    expect(
      screen.getByText('Choose the project whose monitoring data you want to view.')
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Inventory' })).toBeTruthy()
  })
})

describe('/dashboard independent monitoring states (Story 18.12 AC-4/AC-6)', () => {
  afterEach(() => cleanup())

  it('keeps certificate/domain counts visible and marks the single Alerts source unavailable when the dashboard call fails', () => {
    render(DashboardPage, {
      props: {
        data: {
          ...baseDashboardData(),
          dashboard: null,
          dashboardError: true,
          alertStatus: 'error',
          monitoringAssets: {
            certificates: { status: 'ready', count: 2 },
            domains: { status: 'ready', count: 1 },
          },
        },
      },
    })

    expect(screen.getByText('Alerts')).toBeTruthy()
    expect(screen.getByText('Unavailable right now.')).toBeTruthy()
    expect(screen.getByText('2 certificates')).toBeTruthy()
    expect(screen.getByText('1 domain')).toBeTruthy()
  })
})

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
    expect(screen.getByText('No secrets have an upcoming rotation scheduled.')).toBeTruthy()
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

describe('/dashboard +page.svelte — Recent activity widget (AC-A1, A2)', () => {
  afterEach(() => cleanup())

  it('AC-A1: renders real recent access events, with credential name, actor, humanized label, and timestamp', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          recentAccessEvents: [
            {
              credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              credentialName: 'sk_stripe_live',
              actorDisplayName: 'Nestor',
              eventType: 'credential.value_revealed',
              occurredAt: '2026-07-01T12:00:00.000Z',
            },
            {
              credentialId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              credentialName: 'db_password_prod',
              actorDisplayName: 'user_a1b2c3d4',
              eventType: 'credential.tags_updated',
              occurredAt: '2026-06-30T09:30:00.000Z',
            },
          ],
        }),
      },
    })

    expect(screen.getByText('Recent activity')).toBeTruthy()
    expect(screen.getByText('sk_stripe_live')).toBeTruthy()
    expect(screen.getByText('Nestor')).toBeTruthy()
    expect(screen.getByText(getRecentAccessEventLabels()['credential.value_revealed'])).toBeTruthy()
    expect(screen.getByText(formatDateTime('2026-07-01T12:00:00.000Z'))).toBeTruthy()

    expect(screen.getByText('db_password_prod')).toBeTruthy()
    expect(screen.getByText('user_a1b2c3d4')).toBeTruthy()
    expect(screen.getByText(getRecentAccessEventLabels()['credential.tags_updated'])).toBeTruthy()
  })

  it('AC-A2: renders an honest empty state rather than omitting the section', () => {
    render(DashboardPage, {
      props: { data: baseDashboardData({ recentAccessEvents: [] }) },
    })

    expect(screen.getByText('Recent activity')).toBeTruthy()
    expect(screen.getByText('No recent activity yet.')).toBeTruthy()
  })

  it('does not use forbidden fake-healthy dashboard copy anywhere in the widget', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          recentAccessEvents: [
            {
              credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              credentialName: 'sk_stripe_live',
              actorDisplayName: 'Nestor',
              eventType: 'credential.value_revealed',
              occurredAt: '2026-07-01T12:00:00.000Z',
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

describe('/dashboard +page.svelte — Suggested next actions for partial coverage (AC-S1, AC-S2, AC-S3)', () => {
  afterEach(() => cleanup())

  it('AC-S1: credentials but no services shows exactly one suggestion, "Add first service", linking to the new-service form', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          credentialStats: { active: 3, expiringSoon: 0, expired: 0 },
          monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          isEmpty: false,
          suggestedActions: ['add_service'],
        }),
      },
    })

    expect(screen.getByText('Suggested next actions')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Add first service' })
    // Deviation from the story's literal "/services/new": that's the unrelated billing/
    // PaymentRecord feature. monitoredServiceHealth is sourced from service_endpoints, so the
    // functionally-correct target is /service-endpoints/new (see +page.svelte comment).
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/service-endpoints/new`)
    expect(screen.queryByText('Add first secret')).toBeNull()
    expect(screen.queryByText('Import .env or JSON')).toBeNull()
  })

  it('AC-S1 example 2: services but no credentials shows "Add first credential" and "Import .env or JSON"', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
          monitoredServiceHealth: { healthy: 2, degraded: 0, down: 0 },
          isEmpty: false,
          suggestedActions: ['add_credential', 'import_credentials'],
        }),
      },
    })

    expect(screen.getByText('Suggested next actions')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add first secret' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Import .env or JSON' })).toBeTruthy()
    expect(screen.queryByText('Add first service')).toBeNull()
  })

  it('AC-S2: a fully-covered project (both categories non-empty) shows no "Suggested next actions" section at all', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          credentialStats: { active: 3, expiringSoon: 0, expired: 0 },
          monitoredServiceHealth: { healthy: 2, degraded: 0, down: 0 },
          isEmpty: false,
          suggestedActions: [],
        }),
      },
    })

    expect(screen.queryByText('Suggested next actions')).toBeNull()
  })

  it('AC-S3 regression: a fully-empty project keeps the existing 3-action suggestion list, all with their existing link targets', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          isEmpty: true,
          suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
        }),
      },
    })

    expect(screen.getByText('Suggested next actions')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Add first secret' }).getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/new`
    )
    expect(screen.getByRole('link', { name: 'Add first service' }).getAttribute('href')).toBe(
      `/projects/${projectId}/service-endpoints/new`
    )
    expect(screen.getByRole('link', { name: 'Import .env or JSON' }).getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/import`
    )
  })
})

describe('/dashboard +page.svelte — DashboardPlaceholderGrid wiring (AC-G1, AC-G2)', () => {
  afterEach(() => cleanup())

  it('AC-G1 positive: a fully populated project suppresses the Credentials/Services placeholder cards and keeps the real alert summary', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          credentialStats: { active: 3, expiringSoon: 0, expired: 0 },
          monitoredServiceHealth: { healthy: 2, degraded: 0, down: 0 },
          isEmpty: false,
        }),
      },
    })

    expect(screen.queryByText('Secrets', { selector: 'h2' })).toBeNull()
    expect(screen.queryByText('Services and health', { selector: 'h2' })).toBeNull()
    expect(screen.getByText('Certificates and domains', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Alerts', { selector: 'dt' })).toBeTruthy()
  })

  it('AC-G1 edge: partial coverage (credentials but no services) only suppresses the Credentials card', () => {
    render(DashboardPage, {
      props: {
        data: baseDashboardData({
          credentialStats: { active: 3, expiringSoon: 0, expired: 0 },
          monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          isEmpty: false,
        }),
      },
    })

    expect(screen.queryByText('Secrets', { selector: 'h2' })).toBeNull()
    expect(screen.getByText('Services and health')).toBeTruthy()
  })

  it('AC-G2 regression: a selected-but-empty project still shows the full 4-card grid', () => {
    render(DashboardPage, {
      props: { data: baseDashboardData({ isEmpty: true }) },
    })

    expect(screen.getByText('Secrets', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Services and health', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Certificates and domains', { selector: 'h2' })).toBeTruthy()
  })

  it('AC-G2 regression: no project selected still shows the full 4-card grid', () => {
    render(DashboardPage, {
      props: {
        data: {
          projects: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          orgDashboard: null,
          selectedProject: null,
          dashboard: null,
        },
      },
    })

    expect(screen.getByText('Secrets', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Services and health', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Certificates and domains', { selector: 'h2' })).toBeTruthy()
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

    expect(screen.getByRole('alert').textContent).toContain(m.dashboard_vault_sealed_message())
    // A sealed vault means none of the dashboard's other data is trustworthy either — nothing
    // else should render, not even the empty-state grid.
    expect(screen.queryByText('Upcoming rotations')).toBeNull()
    expect(screen.queryByText('Secret overview')).toBeNull()
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
