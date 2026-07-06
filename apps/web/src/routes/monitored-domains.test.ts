import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createDomainMock = vi.hoisted(() => vi.fn())
const updateDomainMock = vi.hoisted(() => vi.fn())
const deleteDomainMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/domains.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/domains.js')>()
  return {
    ...original,
    createDomain: createDomainMock,
    updateDomain: updateDomainMock,
    deleteDomain: deleteDomainMock,
  }
})

import DomainsListPage from './(app)/projects/[projectId]/domains/+page.svelte'
import NewDomainPage from './(app)/projects/[projectId]/domains/new/+page.svelte'
import DomainDetailPage from './(app)/projects/[projectId]/domains/[domainId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const domainId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: domainId,
    orgId: 'org-1',
    projectId,
    domainName: 'example.com',
    renewalDate: '2027-01-01T00:00:00.000Z',
    alertLeadDays: [30],
    notifiedLeadDays: [],
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('/projects/:projectId/domains list (AC-D1)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    deleteDomainMock.mockReset()
  })
  afterEach(() => cleanup())

  it('viewer: empty state, no create control', () => {
    render(DomainsListPage, {
      props: { data: { projectId, orgRole: 'viewer', domains: [], notFound: false } },
    })
    expect(screen.getByText('No domains registered yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add domain' })).toBeNull()
  })

  it('AC-D1 edge: two rows with the same domainName and different renewalDates both display', () => {
    render(DomainsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer',
          domains: [
            makeDomain({ id: 'd1', renewalDate: '2027-01-01T00:00:00.000Z' }),
            makeDomain({ id: 'd2', renewalDate: '2027-06-01T00:00:00.000Z' }),
          ],
          notFound: false,
        },
      },
    })
    expect(screen.getAllByText('example.com')).toHaveLength(2)
  })

  it('two-step delete removes the row without a full reload', async () => {
    deleteDomainMock.mockResolvedValue(undefined)
    render(DomainsListPage, {
      props: { data: { projectId, orgRole: 'member', domains: [makeDomain()], notFound: false } },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }))
    await waitFor(() =>
      expect(deleteDomainMock).toHaveBeenCalledWith(expect.anything(), projectId, domainId)
    )
    expect(screen.getByText('No domains registered yet.')).toBeTruthy()
  })
})

describe('/projects/:projectId/domains/new (AC-D1)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createDomainMock.mockReset()
  })
  afterEach(() => cleanup())

  it('happy path: submits domainName+renewalDate and navigates to the created domain', async () => {
    createDomainMock.mockResolvedValue(makeDomain())
    render(NewDomainPage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Domain name/i), {
      target: { value: 'example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/Renewal date/i), {
      target: { value: '2027-01-01' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create domain' }))

    await waitFor(() =>
      expect(createDomainMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        domainName: 'example.com',
        renewalDate: '2027-01-01T00:00:00.000Z',
      })
    )
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/domains/${domainId}`)
  })

  it('failure: missing required renewalDate blocks submission client-side', async () => {
    render(NewDomainPage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/Domain name/i), {
      target: { value: 'example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create domain' }))

    expect(screen.getByText('Renewal date is required')).toBeTruthy()
    expect(createDomainMock).not.toHaveBeenCalled()
  })
})

describe('/projects/:projectId/domains/:domainId (AC-D1 edit)', () => {
  beforeEach(() => updateDomainMock.mockReset())
  afterEach(() => cleanup())

  it('allows renaming domainName via edit', async () => {
    updateDomainMock.mockResolvedValue(makeDomain({ domainName: 'example.org' }))
    render(DomainDetailPage, {
      props: { data: { projectId, orgRole: 'member', domain: makeDomain(), notFound: false } },
    })

    await fireEvent.input(screen.getByLabelText(/Domain name/i), {
      target: { value: 'example.org' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(updateDomainMock).toHaveBeenCalledWith(expect.anything(), projectId, domainId, {
        domainName: 'example.org',
        renewalDate: '2027-01-01T00:00:00.000Z',
        alertLeadDays: [30],
      })
    )
  })

  it('code-review finding: clearing the alert-lead-days field omits it from the PATCH instead of silently zeroing it out', async () => {
    updateDomainMock.mockResolvedValue(makeDomain())
    render(DomainDetailPage, {
      props: { data: { projectId, orgRole: 'member', domain: makeDomain(), notFound: false } },
    })

    const alertLeadDaysInput = screen.getByLabelText(/Alert me before renewal/i)
    await fireEvent.input(alertLeadDaysInput, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateDomainMock).toHaveBeenCalled())
    const body = updateDomainMock.mock.calls[0]?.[3]
    expect(body).not.toHaveProperty('alertLeadDays')
  })

  it('failure: not-found shows the not-found notice', () => {
    render(DomainDetailPage, {
      props: { data: { projectId, orgRole: 'member', domain: null, notFound: true } },
    })
    expect(screen.getByText(/domain.*not found/i)).toBeTruthy()
  })

  it('code-review finding (AC-I1): viewer sees a read-only view, not disabled-but-visible form inputs', () => {
    render(DomainDetailPage, {
      props: { data: { projectId, orgRole: 'viewer', domain: makeDomain(), notFound: false } },
    })
    expect(screen.queryByLabelText(/Domain name/i)).toBeNull()
    expect(screen.queryByLabelText(/Renewal date/i)).toBeNull()
    expect(screen.queryByLabelText(/Alert me before renewal/i)).toBeNull()
    expect(screen.getByText('Alerts at 30 days before')).toBeTruthy()
  })
})
