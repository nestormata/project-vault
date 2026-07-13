import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const updateServiceMock = vi.hoisted(() => vi.fn())
const deleteServiceMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/services.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/services.js')>('$lib/api/services.js')
  return { ...actual, updateService: updateServiceMock, deleteService: deleteServiceMock }
})

import ServiceDetailPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const SERVICE = {
  id: 'svc-1',
  name: 'Payments API',
  url: 'https://payments.example.com',
  renewalDate: '2026-12-01T00:00:00.000Z',
  alertLeadDays: [7, 30],
}

function baseData(overrides: Record<string, unknown> = {}) {
  return { projectId, orgRole: 'owner', service: SERVICE, notFound: false, ...overrides }
}

describe('service detail +page.svelte', () => {
  it('shows an honest not-found banner instead of the form', () => {
    render(ServiceDetailPage, { props: { data: baseData({ service: null, notFound: true }) } })
    expect(screen.getByText(/service not found/i)).toBeTruthy()
  })

  it('a viewer sees a read-only panel with formatted values, not the edit form', () => {
    render(ServiceDetailPage, { props: { data: baseData({ orgRole: 'viewer' }) } })
    expect(screen.getByText('https://payments.example.com')).toBeTruthy()
    expect(screen.queryByLabelText('URL')).toBeNull()
  })

  it('a viewer sees dashes for a service with no URL and no alert lead days', () => {
    render(ServiceDetailPage, {
      props: {
        data: baseData({
          orgRole: 'viewer',
          service: { ...SERVICE, url: null, alertLeadDays: [] },
        }),
      },
    })
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('an owner submits changes and the page re-renders with the update', async () => {
    updateServiceMock.mockResolvedValue({ ...SERVICE, url: 'https://new.example.com' })
    render(ServiceDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText('URL'), {
      target: { value: 'https://new.example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(updateServiceMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      SERVICE.id,
      expect.objectContaining({ url: 'https://new.example.com' })
    )
    expect(await screen.findByDisplayValue('https://new.example.com')).toBeTruthy()
  })

  it('a submit failure maps to an inline error message', async () => {
    updateServiceMock.mockRejectedValue(new Error('conflict'))
    render(ServiceDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText(/conflict|permission|failed/i)).toBeTruthy()
  })

  it('deleting navigates back to the services list on success', async () => {
    deleteServiceMock.mockResolvedValue(undefined)
    render(ServiceDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(deleteServiceMock).toHaveBeenCalledWith(expect.anything(), projectId, SERVICE.id)
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/services`)
  })

  it('a delete failure shows an inline error instead of navigating away', async () => {
    deleteServiceMock.mockRejectedValue(new Error('cannot delete'))
    render(ServiceDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(await screen.findByText('cannot delete')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })
})
