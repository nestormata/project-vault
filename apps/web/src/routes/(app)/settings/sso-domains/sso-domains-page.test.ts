import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const createOrgSsoDomainMock = vi.hoisted(() => vi.fn())
const updateOrgSsoDomainMock = vi.hoisted(() => vi.fn())
const deleteOrgSsoDomainMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/org-sso-domains.js', () => ({
  createOrgSsoDomain: createOrgSsoDomainMock,
  updateOrgSsoDomain: updateOrgSsoDomainMock,
  deleteOrgSsoDomain: deleteOrgSsoDomainMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { routeExists } from '$lib/test/route-exists.js'
import SsoDomainsPage from './+page.svelte'

beforeEach(() => {
  invalidateAllMock.mockReset()
  createOrgSsoDomainMock.mockReset()
  updateOrgSsoDomainMock.mockReset()
  deleteOrgSsoDomainMock.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SAMPLE_DOMAIN = {
  id: 'domain-1',
  domain: 'acme.com',
  providerName: 'test.mock-sso-extension',
  createdAt: '2026-07-20T10:00:00.000Z',
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    orgRole: 'admin',
    mfaRequired: false,
    domains: [SAMPLE_DOMAIN],
    errorMessage: null,
    ...overrides,
  }
}

describe('/settings/sso-domains +page.svelte (Story 14.6)', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/sso-domains')).toBe(true)
  })

  it('AC-5: a non-admin role sees the permission message, not a crash', () => {
    render(SsoDomainsPage, { props: { data: { allowed: false, orgRole: 'member' } } })
    expect(screen.getByText(/need the admin role/i)).toBeTruthy()
  })

  it('AC-6 edge: MFA-not-enrolled admin sees a distinct message linking to /settings/security', () => {
    render(SsoDomainsPage, {
      props: { data: baseData({ mfaRequired: true, domains: [] }) },
    })
    expect(screen.getByText(/multi-factor authentication/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /security/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
  })

  it('generic fetch failure keeps the rest of the page intact', () => {
    render(SsoDomainsPage, {
      props: {
        data: baseData({ errorMessage: 'Failed to load SSO domains, try again.', domains: [] }),
      },
    })
    expect(screen.getByText(/failed to load sso domains, try again/i)).toBeTruthy()
  })

  it('AC-1: an honest empty state, not a blank table', () => {
    render(SsoDomainsPage, { props: { data: baseData({ domains: [] }) } })
    expect(screen.getByText(/no sso domains configured yet/i)).toBeTruthy()
  })

  it('AC-1: renders one row per mapping', () => {
    render(SsoDomainsPage, { props: { data: baseData() } })
    expect(screen.getByText('acme.com')).toBeTruthy()
    expect(screen.getByText('test.mock-sso-extension')).toBeTruthy()
  })

  it('AC-2: submits a new domain and calls invalidateAll on success', async () => {
    createOrgSsoDomainMock.mockResolvedValue({ ...SAMPLE_DOMAIN, id: 'domain-2' })
    render(SsoDomainsPage, { props: { data: baseData({ domains: [] }) } })

    await fireEvent.input(screen.getByLabelText(/domain/i), { target: { value: 'new-org.com' } })
    await fireEvent.input(screen.getByLabelText(/provider/i), {
      target: { value: 'test.mock-sso-extension' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /add domain/i }))

    expect(createOrgSsoDomainMock).toHaveBeenCalledWith(expect.anything(), {
      domain: 'new-org.com',
      providerName: 'test.mock-sso-extension',
    })
    expect(await vi.waitFor(() => invalidateAllMock)).toHaveBeenCalled()
  })

  it('AC-2 edge: a public_domain_blocked error renders inline, not a generic 500', async () => {
    createOrgSsoDomainMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'public_domain_blocked', message: 'This domain is on our list...' },
        'This domain is on our list...'
      )
    )
    render(SsoDomainsPage, { props: { data: baseData({ domains: [] }) } })

    await fireEvent.input(screen.getByLabelText(/domain/i), { target: { value: 'gmail.com' } })
    await fireEvent.input(screen.getByLabelText(/provider/i), {
      target: { value: 'test.mock-sso-extension' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /add domain/i }))

    expect(await screen.findByText(/this domain is on our list/i)).toBeTruthy()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  it('AC-8: the submit control is disabled while a create request is in flight (double-submit guard)', async () => {
    let resolveCreate!: (value: typeof SAMPLE_DOMAIN) => void
    createOrgSsoDomainMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )
    render(SsoDomainsPage, { props: { data: baseData({ domains: [] }) } })

    await fireEvent.input(screen.getByLabelText(/domain/i), { target: { value: 'pending.com' } })
    await fireEvent.input(screen.getByLabelText(/provider/i), {
      target: { value: 'test.mock-sso-extension' },
    })
    const submit = screen.getByRole('button', { name: /add domain/i })
    await fireEvent.click(submit)
    await fireEvent.click(submit)

    expect(createOrgSsoDomainMock).toHaveBeenCalledTimes(1)
    resolveCreate(SAMPLE_DOMAIN)
  })

  it('AC-3: edits an existing row and calls invalidateAll on success', async () => {
    updateOrgSsoDomainMock.mockResolvedValue({ ...SAMPLE_DOMAIN, providerName: 'other.provider' })
    render(SsoDomainsPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const editRow = within(screen.getByTestId(`edit-row-${SAMPLE_DOMAIN.id}`))
    await fireEvent.input(editRow.getByLabelText(/provider/i), {
      target: { value: 'other.provider' },
    })
    await fireEvent.click(editRow.getByRole('button', { name: /^save$/i }))

    expect(updateOrgSsoDomainMock).toHaveBeenCalledWith(expect.anything(), SAMPLE_DOMAIN.id, {
      domain: SAMPLE_DOMAIN.domain,
      providerName: 'other.provider',
    })
    expect(await vi.waitFor(() => invalidateAllMock)).toHaveBeenCalled()
  })

  it('AC-4: removes a row after a confirm dialog and calls invalidateAll', async () => {
    deleteOrgSsoDomainMock.mockResolvedValue({ id: SAMPLE_DOMAIN.id })
    render(SsoDomainsPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    expect(window.confirm).toHaveBeenCalled()
    expect(deleteOrgSsoDomainMock).toHaveBeenCalledWith(expect.anything(), SAMPLE_DOMAIN.id)
    expect(await vi.waitFor(() => invalidateAllMock)).toHaveBeenCalled()
  })

  it('AC-4: a cancelled confirm dialog does not call the delete API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(SsoDomainsPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    expect(deleteOrgSsoDomainMock).not.toHaveBeenCalled()
  })
})
