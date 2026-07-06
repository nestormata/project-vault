import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createServiceMock = vi.hoisted(() => vi.fn())
const updateServiceMock = vi.hoisted(() => vi.fn())
const deleteServiceMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/services.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/services.js')>()
  return {
    ...original,
    createService: createServiceMock,
    updateService: updateServiceMock,
    deleteService: deleteServiceMock,
  }
})

import ServicesListPage from './(app)/projects/[projectId]/services/+page.svelte'
import NewServicePage from './(app)/projects/[projectId]/services/new/+page.svelte'
import ServiceDetailPage from './(app)/projects/[projectId]/services/[serviceId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const serviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    id: serviceId,
    orgId: 'org-1',
    projectId,
    name: 'AWS Hosting',
    url: 'https://console.aws.amazon.com/billing',
    renewalDate: '2026-09-01T00:00:00.000Z',
    alertLeadDays: [14, 3],
    notifiedLeadDays: [],
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('/projects/:projectId/services list (AC-B1/B2/B5)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createServiceMock.mockReset()
    updateServiceMock.mockReset()
    deleteServiceMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-B1 viewer: shows the empty state with no create control', () => {
    render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'viewer', services: [], notFound: false } },
    })
    expect(screen.getByText('No services registered yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add service' })).toBeNull()
  })

  it('AC-B1 member: shows the empty state plus a visible "Add service" link', () => {
    render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'member', services: [], notFound: false } },
    })
    const link = screen.getByRole('link', { name: 'Add service' })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/services/new`)
  })

  it('AC-B2: renders name/url/renewalDate/alertLeadDays, with "—" for a null renewalDate', () => {
    render(ServicesListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          services: [makeService({ renewalDate: null, url: null })],
          notFound: false,
        },
      },
    })
    expect(screen.getByText('AWS Hosting')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Alerts at 14, 3 days before')).toBeTruthy()
  })

  it('AC-I1: viewer sees no Edit/Delete controls; member sees both', () => {
    const { unmount } = render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'viewer', services: [makeService()], notFound: false } },
    })
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    unmount()

    render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'member', services: [makeService()], notFound: false } },
    })
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('AC-B5: two-step delete removes the row without a full page reload', async () => {
    deleteServiceMock.mockResolvedValue(undefined)
    render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'member', services: [makeService()], notFound: false } },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }))

    await waitFor(() =>
      expect(deleteServiceMock).toHaveBeenCalledWith(expect.anything(), projectId, serviceId)
    )
    await waitFor(() => expect(screen.queryByText('AWS Hosting')).toBeNull())
    expect(screen.getByText('No services registered yet.')).toBeTruthy()
  })

  it('AC-A1 edge: project-not-found renders the not-found notice', () => {
    render(ServicesListPage, {
      props: { data: { projectId, orgRole: 'viewer', services: [], notFound: true } },
    })
    expect(screen.getByText(/project was not found/i)).toBeTruthy()
  })
})

describe('/projects/:projectId/services/new (AC-B3)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createServiceMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-I1: renders AccessNotice for a viewer instead of the form', () => {
    render(NewServicePage, { props: { data: { projectId, orgRole: 'viewer' } } })
    expect(screen.getByText('Create not available')).toBeTruthy()
    expect(screen.queryByLabelText(/Name/i)).toBeNull()
  })

  it('AC-B3 happy path: submits name/url/renewalDate and navigates to the created service', async () => {
    createServiceMock.mockResolvedValue(makeService())
    render(NewServicePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: 'AWS Hosting' } })
    await fireEvent.input(screen.getByLabelText(/URL/i), {
      target: { value: 'https://console.aws.amazon.com/billing' },
    })
    await fireEvent.input(screen.getByLabelText(/Renewal date/i), {
      target: { value: '2026-09-01' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create service' }))

    await waitFor(() =>
      expect(createServiceMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'AWS Hosting',
        url: 'https://console.aws.amazon.com/billing',
        renewalDate: '2026-09-01T00:00:00.000Z',
      })
    )
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/services/${serviceId}`)
  })

  it('AC-B3 edge: all optional fields left blank still submits name-only', async () => {
    createServiceMock.mockResolvedValue(makeService({ url: null, renewalDate: null }))
    render(NewServicePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: 'GitHub SaaS seat' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create service' }))

    await waitFor(() =>
      expect(createServiceMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        name: 'GitHub SaaS seat',
      })
    )
  })

  it('AC-B3 failure: blank name shows an inline error before any network call', async () => {
    render(NewServicePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.click(screen.getByRole('button', { name: 'Create service' }))

    expect(screen.getByText('Name is required')).toBeTruthy()
    expect(createServiceMock).not.toHaveBeenCalled()
  })

  it('AC-B3 failure: a 422 from the server is mapped to a readable banner', async () => {
    createServiceMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'validation_error', message: 'Too many alert lead days' },
        'Too many alert lead days'
      )
    )
    render(NewServicePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: 'AWS Hosting' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create service' }))

    expect(await screen.findByText('Too many alert lead days')).toBeTruthy()
  })

  it('AC-B3 failure: a 410 archived-project error shows a clear message', async () => {
    createServiceMock.mockRejectedValue(
      new ApiClientError(410, { code: 'project_archived', message: 'Archived' }, 'Archived')
    )
    render(NewServicePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: 'AWS Hosting' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create service' }))

    expect(await screen.findByText('This project is archived and cannot be modified.')).toBeTruthy()
  })
})

describe('/projects/:projectId/services/:serviceId (AC-B4)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    updateServiceMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-B4 edge: the edit form has no editable Name input, only a read-only label', () => {
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'member', service: makeService(), notFound: false } },
    })
    expect(screen.getByText('AWS Hosting')).toBeTruthy()
    expect(screen.queryByLabelText(/^Name$/i)).toBeNull()
  })

  it('AC-B4 happy path: changing renewalDate PATCHes only the three allowed fields', async () => {
    updateServiceMock.mockResolvedValue(makeService({ renewalDate: '2027-01-01T00:00:00.000Z' }))
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'member', service: makeService(), notFound: false } },
    })

    const renewalInput = screen.getByLabelText(/Renewal date/i)
    await fireEvent.input(renewalInput, { target: { value: '2027-01-01' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(updateServiceMock).toHaveBeenCalledWith(expect.anything(), projectId, serviceId, {
        url: 'https://console.aws.amazon.com/billing',
        renewalDate: '2027-01-01T00:00:00.000Z',
        alertLeadDays: [14, 3],
      })
    )
  })

  it('code-review finding: clearing the alert-lead-days field omits it from the PATCH instead of silently zeroing it out', async () => {
    updateServiceMock.mockResolvedValue(makeService())
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'member', service: makeService(), notFound: false } },
    })

    const alertLeadDaysInput = screen.getByLabelText(/Alert me before renewal/i)
    await fireEvent.input(alertLeadDaysInput, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateServiceMock).toHaveBeenCalled())
    const body = updateServiceMock.mock.calls[0]?.[3]
    expect(body).not.toHaveProperty('alertLeadDays')
  })

  it('AC-B4 failure: a not-found service shows the not-found notice', () => {
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'member', service: null, notFound: true } },
    })
    expect(screen.getByText(/service.*not found/i)).toBeTruthy()
  })

  it('AC-I1: viewer sees no Save/Delete controls on the detail page', () => {
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'viewer', service: makeService(), notFound: false } },
    })
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('code-review finding (AC-I1): viewer sees a read-only view, not disabled-but-visible form inputs', () => {
    render(ServiceDetailPage, {
      props: { data: { projectId, orgRole: 'viewer', service: makeService(), notFound: false } },
    })
    expect(screen.queryByLabelText(/^URL$/i)).toBeNull()
    expect(screen.queryByLabelText(/Renewal date/i)).toBeNull()
    expect(screen.queryByLabelText(/Alert me before renewal/i)).toBeNull()
    expect(screen.getByText('https://console.aws.amazon.com/billing')).toBeTruthy()
  })
})
