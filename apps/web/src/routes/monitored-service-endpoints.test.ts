import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createServiceEndpointMock = vi.hoisted(() => vi.fn())
const updateServiceEndpointMock = vi.hoisted(() => vi.fn())
const deleteServiceEndpointMock = vi.hoisted(() => vi.fn())
const getHealthHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/service-endpoints.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/service-endpoints.js')>()
  return {
    ...original,
    createServiceEndpoint: createServiceEndpointMock,
    updateServiceEndpoint: updateServiceEndpointMock,
    deleteServiceEndpoint: deleteServiceEndpointMock,
    getHealthHistory: getHealthHistoryMock,
  }
})

import ServiceEndpointsListPage from './(app)/projects/[projectId]/service-endpoints/+page.svelte'
import NewServiceEndpointPage from './(app)/projects/[projectId]/service-endpoints/new/+page.svelte'
import ServiceEndpointDetailPage from './(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceEndpointId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: serviceEndpointId,
    orgId: 'org-1',
    projectId,
    name: 'API health',
    url: 'https://api.example.com/health',
    checkFrequencyMinutes: 5,
    downThresholdFailures: 2,
    status: 'healthy' as const,
    consecutiveFailures: 0,
    lastCheckedAt: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('/projects/:projectId/service-endpoints list (AC-E1/E2, AC-F1 embedded panel)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    deleteServiceEndpointMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-E1 viewer: empty state, no create control', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: { projectId, orgRole: 'viewer', endpoints: [], alerts: [], notFound: false },
      },
    })
    expect(screen.getByText('No service endpoints registered yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add endpoint' })).toBeNull()
  })

  it('AC-E2: renders name/status badge/lastCheckedAt/checkFrequencyMinutes/downThresholdFailures', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('API health')).toBeTruthy()
    expect(screen.getByText('healthy')).toBeTruthy()
    expect(screen.getByText(/every 5 min/i)).toBeTruthy()
    expect(screen.getByText(/2 consecutive/i)).toBeTruthy()
  })

  it('AC-F1: embeds the ActiveAlertsPanel with the loaded alerts', () => {
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [
            {
              id: 'alert-1',
              alertType: 'service.down',
              severity: 'critical',
              status: 'active',
              episodeKey: 'ep-1',
              serviceEndpointId,
              snoozedUntil: null,
              dismissedBy: null,
              dismissedAt: null,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('Active alerts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Snooze 1 hour/i })).toBeTruthy()
  })

  it('two-step delete removes the row without a full reload, disclosing the alert-resolution effect (AC-E5)', async () => {
    deleteServiceEndpointMock.mockResolvedValue(undefined)
    render(ServiceEndpointsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member',
          endpoints: [makeEndpoint()],
          alerts: [],
          notFound: false,
        },
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // AC-E5/code-review finding: the list page's delete control must carry the same
    // alert-resolution disclosure as the detail page's, not a bare "Confirm delete?".
    const confirmButton = screen.getByRole('button', { name: /resolve any active alerts/i })
    await fireEvent.click(confirmButton)
    await waitFor(() =>
      expect(deleteServiceEndpointMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        serviceEndpointId
      )
    )
    expect(screen.getByText('No service endpoints registered yet.')).toBeTruthy()
  })
})

describe('/projects/:projectId/service-endpoints/new (AC-E3)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createServiceEndpointMock.mockReset()
  })
  afterEach(() => cleanup())

  it('happy path: name+url only (frequency/threshold left at defaults 5/2)', async () => {
    createServiceEndpointMock.mockResolvedValue(makeEndpoint())
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    await waitFor(() =>
      expect(createServiceEndpointMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'API health',
        url: 'https://api.example.com/health',
        checkFrequencyMinutes: 5,
        downThresholdFailures: 2,
      })
    )
    expect(gotoMock).toHaveBeenCalledWith(
      `/projects/${projectId}/service-endpoints/${serviceEndpointId}`
    )
  })

  it('edge: non-default frequency/threshold are submitted', async () => {
    createServiceEndpointMock.mockResolvedValue(makeEndpoint())
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.change(screen.getByLabelText(/Check frequency/i), { target: { value: '1' } })
    await fireEvent.input(screen.getByLabelText(/Failures before/i), { target: { value: '1' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    await waitFor(() =>
      expect(createServiceEndpointMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'API health',
        url: 'https://api.example.com/health',
        checkFrequencyMinutes: 1,
        downThresholdFailures: 1,
      })
    )
  })

  it('failure: endpoint cap reached surfaces the server message verbatim', async () => {
    createServiceEndpointMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'service_endpoint_limit_reached',
          message: 'This project has reached its maximum of 25 monitored endpoints',
        },
        'This project has reached its maximum of 25 monitored endpoints'
      )
    )
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'API health' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://api.example.com/health' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    expect(
      await screen.findByText('This project has reached its maximum of 25 monitored endpoints')
    ).toBeTruthy()
  })

  it('failure: SSRF rejection surfaces the server message verbatim, no client-side pre-validation', async () => {
    createServiceEndpointMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'url_not_allowed',
          message:
            'URL resolves to a private, loopback, or reserved address and cannot be monitored',
        },
        'URL resolves to a private, loopback, or reserved address and cannot be monitored'
      )
    )
    render(NewServiceEndpointPage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/^Name$/i), { target: { value: 'Metadata' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'http://169.254.169.254/' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }))

    expect(
      await screen.findByText(
        'URL resolves to a private, loopback, or reserved address and cannot be monitored'
      )
    ).toBeTruthy()
  })
})

describe('/projects/:projectId/service-endpoints/:serviceEndpointId (AC-E4/E5/E6)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    updateServiceEndpointMock.mockReset()
    getHealthHistoryMock.mockReset()
    getHealthHistoryMock.mockResolvedValue({
      items: [],
      page: 1,
      limit: 50,
      total: 0,
      hasNext: false,
    })
  })
  afterEach(() => cleanup())

  it('AC-E4: the url field starts blank (fresh entry), not pre-filled with the redacted value', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })
    const urlInput = screen.getByLabelText(/New URL/i) as HTMLInputElement
    expect(urlInput.value).toBe('')
  })

  it('AC-E4: PATCHes only the changed field (re-URL only)', async () => {
    updateServiceEndpointMock.mockResolvedValue(
      makeEndpoint({ url: 'https://api.example.com/healthz' })
    )
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })

    await fireEvent.input(screen.getByLabelText(/New URL/i), {
      target: { value: 'https://api.example.com/healthz' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(updateServiceEndpointMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        serviceEndpointId,
        { url: 'https://api.example.com/healthz' }
      )
    )
  })

  it('AC-E5: delete confirmation copy mentions resolving active alerts', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })
    expect(screen.getByText(/resolve any active alerts/i)).toBeTruthy()
  })

  it('AC-E6: renders health history rows (checkedAt/isHealthy/statusCode/latencyMs/failureReason)', async () => {
    getHealthHistoryMock.mockResolvedValue({
      items: [
        {
          isHealthy: false,
          statusCode: null,
          latencyMs: 0,
          failureReason: 'ssrf_blocked',
          checkedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      page: 1,
      limit: 50,
      total: 1,
      hasNext: false,
    })
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: makeEndpoint(), notFound: false } },
    })

    expect(await screen.findByText('Blocked (unsafe address)')).toBeTruthy()
  })

  it('failure: not-found shows the not-found notice', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'member', endpoint: null, notFound: true } },
    })
    expect(screen.getByText(/endpoint.*not found/i)).toBeTruthy()
  })

  it('code-review finding (AC-I1): viewer sees a read-only view, not disabled-but-visible form inputs', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: { projectId, orgRole: 'viewer', endpoint: makeEndpoint(), notFound: false } },
    })
    expect(screen.queryByLabelText(/^Name$/i)).toBeNull()
    expect(screen.queryByLabelText(/New URL/i)).toBeNull()
    expect(screen.queryByLabelText(/Check frequency/i)).toBeNull()
    expect(screen.queryByLabelText(/Failures before/i)).toBeNull()
    expect(screen.getByText('Checked every 5 min')).toBeTruthy()
    expect(screen.getByText('Down after 2 consecutive failures')).toBeTruthy()
  })
})
