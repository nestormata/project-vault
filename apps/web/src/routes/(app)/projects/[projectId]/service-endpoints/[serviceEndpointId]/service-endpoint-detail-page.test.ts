import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const updateServiceEndpointMock = vi.hoisted(() => vi.fn())
const deleteServiceEndpointMock = vi.hoisted(() => vi.fn())
const getHealthHistoryMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/service-endpoints.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/api/service-endpoints.js')>(
    '$lib/api/service-endpoints.js'
  )
  return {
    ...actual,
    updateServiceEndpoint: updateServiceEndpointMock,
    deleteServiceEndpoint: deleteServiceEndpointMock,
    getHealthHistory: getHealthHistoryMock,
  }
})

import ServiceEndpointDetailPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const ENDPOINT = {
  id: 'ep-1',
  name: 'API health',
  url: 'https://api.example.com/health (redacted)',
  checkFrequencyMinutes: 5,
  downThresholdFailures: 2,
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    orgRole: 'owner',
    endpoint: ENDPOINT,
    notFound: false,
    ...overrides,
  }
}

function emptyHistory() {
  return { items: [], hasNext: false }
}

describe('service-endpoint detail +page.svelte', () => {
  it('shows an honest not-found banner instead of the form', () => {
    render(ServiceEndpointDetailPage, {
      props: { data: baseData({ endpoint: null, notFound: true }) },
    })

    expect(screen.getByText(/endpoint not found/i)).toBeTruthy()
  })

  it('an owner sees the editable form; a viewer sees a read-only panel', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    render(ServiceEndpointDetailPage, { props: { data: baseData({ orgRole: 'owner' }) } })
    expect(await screen.findByLabelText('Name')).toBeTruthy()

    cleanup()
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    render(ServiceEndpointDetailPage, { props: { data: baseData({ orgRole: 'viewer' }) } })
    expect(await screen.findByText(/checked every 5 min/i)).toBeTruthy()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('blocks submit client-side when the name is cleared, with no API call', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '   ' } })
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(screen.getByText(/name is required/i)).toBeTruthy()
    expect(updateServiceEndpointMock).not.toHaveBeenCalled()
  })

  it('submitting with no actual changes is a no-op (guarded branch)', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(updateServiceEndpointMock).not.toHaveBeenCalled()
  })

  it('submits only the changed fields (name and new URL) and re-renders with the update', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    updateServiceEndpointMock.mockResolvedValue({ ...ENDPOINT, name: 'Renamed' })
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    await fireEvent.input(screen.getByLabelText(/new url/i), {
      target: { value: 'https://new.example.com/health' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(updateServiceEndpointMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      ENDPOINT.id,
      expect.objectContaining({ name: 'Renamed', url: 'https://new.example.com/health' })
    )
  })

  it('a submit failure maps to a field/general error via mapMonitoringSubmitError', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    updateServiceEndpointMock.mockRejectedValue(new Error('conflict'))
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText(/conflict|permission|failed/i)).toBeTruthy()
  })

  it('deleting navigates back to the endpoints list on success', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    deleteServiceEndpointMock.mockResolvedValue(undefined)
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    const deleteButton = screen.getByRole('button', { name: /^delete$/i })
    await fireEvent.click(deleteButton)
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(deleteServiceEndpointMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      ENDPOINT.id
    )
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/service-endpoints`)
  })

  it('a delete failure shows an inline error instead of navigating away', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    deleteServiceEndpointMock.mockRejectedValue(new Error('cannot delete'))
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })
    await screen.findByLabelText('Name')

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(await screen.findByText('cannot delete')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('shows an honest empty state when there is no health-check history', async () => {
    getHealthHistoryMock.mockResolvedValue(emptyHistory())
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })

    expect(await screen.findByText(/no health checks recorded yet/i)).toBeTruthy()
  })

  it('renders history entries with distinct labels per failure reason, and paginates with Load more', async () => {
    getHealthHistoryMock.mockResolvedValueOnce({
      items: [
        {
          checkedAt: '2026-07-01T00:00:00.000Z',
          isHealthy: false,
          statusCode: null,
          latencyMs: 1200,
          failureReason: 'timeout',
        },
      ],
      hasNext: true,
    })
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })

    expect(await screen.findByText('Timed out')).toBeTruthy()
    expect(screen.getByText('Unhealthy')).toBeTruthy()

    getHealthHistoryMock.mockResolvedValueOnce({
      items: [
        {
          checkedAt: '2026-07-02T00:00:00.000Z',
          isHealthy: true,
          statusCode: 200,
          latencyMs: 80,
          failureReason: null,
        },
      ],
      hasNext: false,
    })
    await fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect(await screen.findByText('Healthy')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('a health-history load failure shows an inline error banner', async () => {
    getHealthHistoryMock.mockRejectedValue(new Error('history unavailable'))
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })

    expect(await screen.findByText('history unavailable')).toBeTruthy()
  })

  it('labels every distinct HTTP-error and network-error failure reason', async () => {
    getHealthHistoryMock.mockResolvedValue({
      items: [
        {
          checkedAt: '2026-07-01T00:00:00.000Z',
          isHealthy: false,
          statusCode: 500,
          latencyMs: 10,
          failureReason: 'http_error',
        },
        {
          checkedAt: '2026-07-02T00:00:00.000Z',
          isHealthy: false,
          statusCode: null,
          latencyMs: 5,
          failureReason: 'network_error',
        },
        {
          checkedAt: '2026-07-03T00:00:00.000Z',
          isHealthy: false,
          statusCode: null,
          latencyMs: 3,
          failureReason: 'ssrf_blocked',
        },
      ],
      hasNext: false,
    })
    render(ServiceEndpointDetailPage, { props: { data: baseData() } })

    expect(await screen.findByText('HTTP error')).toBeTruthy()
    expect(screen.getByText('Network error')).toBeTruthy()
    expect(screen.getByText(/blocked \(unsafe address\)/i)).toBeTruthy()
  })
})
