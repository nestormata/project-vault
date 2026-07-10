import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { ApiClientError } from '$lib/api/client.js'

const createOrgMock = vi.hoisted(() => vi.fn())
const listOrgsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', () => ({
  createOrg: createOrgMock,
  listOrgs: listOrgsMock,
}))

import OrgsPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE_ORG = {
  id: 'org-1',
  name: 'Acme Corp',
  slug: 'acme-corp',
  createdAt: '2026-01-01T00:00:00Z',
  memberCount: 3,
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    orgs: [SAMPLE_ORG],
    errorMessage: null,
    ...overrides,
  }
}

async function fillCreateForm(name = 'New Org', email = 'owner@example.com') {
  await fireEvent.input(screen.getByLabelText(/organization name/i), { target: { value: name } })
  await fireEvent.input(screen.getByLabelText(/owner email/i), { target: { value: email } })
}

describe('/platform/settings/orgs +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/settings/orgs')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(OrgsPage, { props: { data: { allowed: false } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /organizations/i })).toBeNull()
  })

  it('renders a real org row', () => {
    render(OrgsPage, { props: { data: allowedData() } })

    expect(screen.getByText('Acme Corp')).toBeTruthy()
    expect(screen.getByText('acme-corp')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('edge: shows empty state when there are no organizations', () => {
    render(OrgsPage, { props: { data: allowedData({ orgs: [] }) } })

    expect(screen.getByText(/no organizations found/i)).toBeTruthy()
  })

  it('surfaces a load-time errorMessage', () => {
    render(OrgsPage, { props: { data: allowedData({ errorMessage: 'Failed to load orgs' }) } })

    expect(screen.getByText('Failed to load orgs')).toBeTruthy()
  })

  it('create org: success shows an invited-owner message and refreshes the list', async () => {
    createOrgMock.mockResolvedValue({
      name: 'New Org',
      ownerAccountAction: 'invitation_sent',
    })
    listOrgsMock.mockResolvedValue({
      items: [SAMPLE_ORG, { ...SAMPLE_ORG, id: 'org-2', name: 'New Org' }],
    })
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm('New Org', 'owner@example.com')
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/an invitation was sent to owner@example\.com/i)).toBeTruthy()
    expect(createOrgMock).toHaveBeenCalledWith(expect.anything(), {
      name: 'New Org',
      ownerEmail: 'owner@example.com',
    })
    expect(listOrgsMock).toHaveBeenCalledTimes(1)
  })

  it('create org: success with an existing user shows a distinct message', async () => {
    createOrgMock.mockResolvedValue({
      name: 'New Org',
      ownerAccountAction: 'existing_user_added',
    })
    listOrgsMock.mockResolvedValue({ items: [SAMPLE_ORG] })
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm('New Org', 'existing@example.com')
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/was added as owner \(existing account\)/i)).toBeTruthy()
  })

  it('create org: 409 org_name_taken shows a name-specific inline error', async () => {
    createOrgMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'org_name_taken', message: 'An organization with that name already exists.' },
        'An organization with that name already exists.'
      )
    )
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/an organization with that name already exists/i)).toBeTruthy()
  })

  it('create org: 409 max_orgs_reached shows a message with a link to Settings', async () => {
    createOrgMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'max_orgs_reached',
          message: 'This instance has reached its maximum organizations.',
        },
        'This instance has reached its maximum organizations.'
      )
    )
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/reached its maximum organizations/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /→ settings/i })
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('create org: 422 validation error shows a generic message', async () => {
    createOrgMock.mockRejectedValue(
      new ApiClientError(422, { message: 'Name is required' }, 'Name is required')
    )
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText('Name is required')).toBeTruthy()
  })

  it('create org: 503 vault-sealed body shows the unseal message', async () => {
    createOrgMock.mockRejectedValue(new ApiClientError(503, { status: 'sealed' }, 'sealed'))
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/unseal it to continue/i)).toBeTruthy()
  })

  it('create org: 503 without a sealed-vault body shape shows the API error message', async () => {
    createOrgMock.mockRejectedValue(
      new ApiClientError(
        503,
        { code: 'maintenance', message: 'Under maintenance' },
        'Under maintenance'
      )
    )
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText('Under maintenance')).toBeTruthy()
  })

  it('create org: a non-ApiClientError (network failure) shows the generic failure message', async () => {
    createOrgMock.mockRejectedValue(new Error('network down'))
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText(/^failed to create organization$/i)).toBeTruthy()
  })

  it('create org: MFA-required shows the MFA notice', async () => {
    createOrgMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA is required' },
        'MFA is required'
      )
    )
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    await fireEvent.click(screen.getByRole('button', { name: /create organization/i }))

    expect(await screen.findByText('MFA is required')).toBeTruthy()
  })

  it('create org: submit button disables while creating', async () => {
    let resolveFn: (value: { name: string; ownerAccountAction: string }) => void = () => {}
    createOrgMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve
      })
    )
    listOrgsMock.mockResolvedValue({ items: [SAMPLE_ORG] })
    render(OrgsPage, { props: { data: allowedData() } })

    await fillCreateForm()
    const submitButton = screen.getByRole('button', {
      name: /create organization/i,
    }) as HTMLButtonElement
    await fireEvent.click(submitButton)

    expect(submitButton.disabled).toBe(true)
    expect(screen.getByText(/creating…/i)).toBeTruthy()

    resolveFn({ name: 'New Org', ownerAccountAction: 'invitation_sent' })
    await screen.findByText(/an invitation was sent/i)
    await waitFor(() => expect(submitButton.disabled).toBe(false))
  })
})
