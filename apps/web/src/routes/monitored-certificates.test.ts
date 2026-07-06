import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createCertificateMock = vi.hoisted(() => vi.fn())
const updateCertificateMock = vi.hoisted(() => vi.fn())
const deleteCertificateMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

vi.mock('$lib/api/certificates.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/certificates.js')>()
  return {
    ...original,
    createCertificate: createCertificateMock,
    updateCertificate: updateCertificateMock,
    deleteCertificate: deleteCertificateMock,
  }
})

import CertificatesListPage from './(app)/projects/[projectId]/certificates/+page.svelte'
import NewCertificatePage from './(app)/projects/[projectId]/certificates/new/+page.svelte'
import CertificateDetailPage from './(app)/projects/[projectId]/certificates/[certificateId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const certificateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeCertificate(overrides: Record<string, unknown> = {}) {
  return {
    id: certificateId,
    orgId: 'org-1',
    projectId,
    domain: 'api.example.com',
    expiresAt: '2026-08-15T00:00:00.000Z',
    alertLeadDays: [30, 7],
    notifiedLeadDays: [],
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('/projects/:projectId/certificates list (AC-C1/C2)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    deleteCertificateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-B1-equivalent viewer: empty state, no create control', () => {
    render(CertificatesListPage, {
      props: { data: { projectId, orgRole: 'viewer', certificates: [], notFound: false } },
    })
    expect(screen.getByText('No certificates registered yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Add certificate' })).toBeNull()
  })

  it('AC-C2: labels the expiry column "Expires on," not "Renews on"', () => {
    render(CertificatesListPage, {
      props: {
        data: { projectId, orgRole: 'viewer', certificates: [makeCertificate()], notFound: false },
      },
    })
    expect(screen.getByText('Expires on')).toBeTruthy()
    expect(screen.queryByText('Renews on')).toBeNull()
  })

  it('member sees Edit/Delete controls', () => {
    render(CertificatesListPage, {
      props: {
        data: { projectId, orgRole: 'member', certificates: [makeCertificate()], notFound: false },
      },
    })
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('two-step delete removes the row without a full reload', async () => {
    deleteCertificateMock.mockResolvedValue(undefined)
    render(CertificatesListPage, {
      props: {
        data: { projectId, orgRole: 'member', certificates: [makeCertificate()], notFound: false },
      },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete?' }))
    await waitFor(() =>
      expect(deleteCertificateMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        certificateId
      )
    )
    expect(screen.getByText('No certificates registered yet.')).toBeTruthy()
  })
})

describe('/projects/:projectId/certificates/new (AC-C1)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    createCertificateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('happy path: submits domain+expiresAt and navigates to the created certificate', async () => {
    createCertificateMock.mockResolvedValue(makeCertificate())
    render(NewCertificatePage, { props: { data: { projectId, orgRole: 'member' } } })

    await fireEvent.input(screen.getByLabelText(/Domain/i), {
      target: { value: 'api.example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/Expiry date/i), {
      target: { value: '2026-08-15' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create certificate' }))

    await waitFor(() =>
      expect(createCertificateMock).toHaveBeenCalledWith(expect.anything(), projectId, {
        domain: 'api.example.com',
        expiresAt: '2026-08-15T00:00:00.000Z',
      })
    )
    expect(gotoMock).toHaveBeenCalledWith(`/projects/${projectId}/certificates/${certificateId}`)
  })

  it('failure: missing required expiresAt blocks submission client-side', async () => {
    render(NewCertificatePage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/Domain/i), {
      target: { value: 'api.example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create certificate' }))

    expect(screen.getByText('Expiry date is required')).toBeTruthy()
    expect(createCertificateMock).not.toHaveBeenCalled()
  })

  it('failure: missing required domain blocks submission client-side', async () => {
    render(NewCertificatePage, { props: { data: { projectId, orgRole: 'member' } } })
    await fireEvent.input(screen.getByLabelText(/Expiry date/i), {
      target: { value: '2026-08-15' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create certificate' }))

    expect(screen.getByText('Domain is required')).toBeTruthy()
    expect(createCertificateMock).not.toHaveBeenCalled()
  })
})

describe('/projects/:projectId/certificates/:certificateId (AC-C1 edit)', () => {
  beforeEach(() => {
    updateCertificateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('allows renaming domain via edit (contrast with services)', async () => {
    updateCertificateMock.mockResolvedValue(makeCertificate({ domain: 'api-v2.example.com' }))
    render(CertificateDetailPage, {
      props: {
        data: { projectId, orgRole: 'member', certificate: makeCertificate(), notFound: false },
      },
    })

    const domainInput = screen.getByLabelText(/Domain/i)
    await fireEvent.input(domainInput, { target: { value: 'api-v2.example.com' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(updateCertificateMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        certificateId,
        {
          domain: 'api-v2.example.com',
          expiresAt: '2026-08-15T00:00:00.000Z',
          alertLeadDays: [30, 7],
        }
      )
    )
  })

  it('failure: not-found shows the not-found notice', () => {
    render(CertificateDetailPage, {
      props: { data: { projectId, orgRole: 'member', certificate: null, notFound: true } },
    })
    expect(screen.getByText(/certificate.*not found/i)).toBeTruthy()
  })
})
