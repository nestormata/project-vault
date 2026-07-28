import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const linkExternalIdentityMock = vi.hoisted(() => vi.fn())
const unlinkExternalIdentityMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/external-identities.js', () => ({
  linkExternalIdentity: linkExternalIdentityMock,
  unlinkExternalIdentity: unlinkExternalIdentityMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { routeExists } from '$lib/test/route-exists.js'
import ExternalIdentitiesPage from './+page.svelte'

beforeEach(() => {
  invalidateAllMock.mockReset()
  linkExternalIdentityMock.mockReset()
  unlinkExternalIdentityMock.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SAMPLE_IDENTITY = {
  id: 'identity-1',
  userId: 'user-1',
  email: 'alex@acme.com',
  providerName: 'test.mock-sso-extension',
  externalSubject: 'alex-sso-subject-123',
  createdAt: '2026-07-28T14:03:11.000Z',
}

const SAMPLE_ORG_USER = {
  userId: 'user-1',
  email: 'alex@acme.com',
  displayName: 'alex@acme.com',
  orgRole: 'member',
  status: 'active',
  projects: [],
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    orgRole: 'admin',
    mfaRequired: false,
    identities: [SAMPLE_IDENTITY],
    orgUsers: [SAMPLE_ORG_USER],
    errorMessage: null,
    ...overrides,
  }
}

describe('/settings/external-identities +page.svelte (Story 14.7)', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/external-identities')).toBe(true)
  })

  it('AC-4: a non-admin role sees the permission message, not a crash', () => {
    render(ExternalIdentitiesPage, { props: { data: { allowed: false, orgRole: 'owner' } } })
    expect(screen.getByText(/need the admin role/i)).toBeTruthy()
  })

  it('AC-5: MFA-not-enrolled admin sees a distinct message linking to /settings/security', () => {
    render(ExternalIdentitiesPage, {
      props: { data: baseData({ mfaRequired: true, identities: [] }) },
    })
    expect(screen.getByText(/multi-factor authentication/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /security/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
  })

  it('generic fetch failure keeps the rest of the page intact', () => {
    render(ExternalIdentitiesPage, {
      props: {
        data: baseData({
          errorMessage: 'Failed to load external identities, try again.',
          identities: [],
        }),
      },
    })
    expect(screen.getByText(/failed to load external identities, try again/i)).toBeTruthy()
  })

  it('AC-1: an honest empty state, not a blank table', () => {
    render(ExternalIdentitiesPage, { props: { data: baseData({ identities: [] }) } })
    expect(screen.getByText(/no external identities linked yet/i)).toBeTruthy()
  })

  it('AC-1: renders one row per mapping', () => {
    render(ExternalIdentitiesPage, { props: { data: baseData() } })
    expect(screen.getAllByText('alex@acme.com').length).toBeGreaterThan(0)
    expect(screen.getByRole('cell', { name: 'test.mock-sso-extension' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'alex-sso-subject-123' })).toBeTruthy()
  })

  it('AC-2/AC-12: submits the link form and calls invalidateAll on success', async () => {
    linkExternalIdentityMock.mockResolvedValue({ ...SAMPLE_IDENTITY, id: 'identity-2' })
    render(ExternalIdentitiesPage, { props: { data: baseData({ identities: [] }) } })

    await fireEvent.change(screen.getByLabelText(/member/i), { target: { value: 'user-1' } })
    await fireEvent.input(screen.getByLabelText(/provider name/i), {
      target: { value: 'test.mock-sso-extension' },
    })
    await fireEvent.input(screen.getByLabelText(/external subject/i), {
      target: { value: 'alex-sso-subject-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /link identity/i }))

    expect(linkExternalIdentityMock).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1',
      providerName: 'test.mock-sso-extension',
      externalSubject: 'alex-sso-subject-123',
    })
    expect(await vi.waitFor(() => invalidateAllMock)).toHaveBeenCalled()
  })

  it('AC-2 edge: a 409 conflict error renders inline, not a generic 500', async () => {
    linkExternalIdentityMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'conflict', message: 'This external identity is already linked' },
        'This external identity is already linked'
      )
    )
    render(ExternalIdentitiesPage, { props: { data: baseData({ identities: [] }) } })

    await fireEvent.change(screen.getByLabelText(/member/i), { target: { value: 'user-1' } })
    await fireEvent.input(screen.getByLabelText(/provider name/i), {
      target: { value: 'test.mock-sso-extension' },
    })
    await fireEvent.input(screen.getByLabelText(/external subject/i), {
      target: { value: 'alex-sso-subject-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /link identity/i }))

    expect(await screen.findByText(/this external identity is already linked/i)).toBeTruthy()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  it('AC-2 edge: a 404 user_not_found error renders inline, not a generic 500', async () => {
    linkExternalIdentityMock.mockRejectedValue(
      new ApiClientError(
        404,
        { code: 'user_not_found', message: 'User not found' },
        'User not found'
      )
    )
    render(ExternalIdentitiesPage, { props: { data: baseData({ identities: [] }) } })

    await fireEvent.change(screen.getByLabelText(/member/i), { target: { value: 'user-1' } })
    await fireEvent.input(screen.getByLabelText(/provider name/i), {
      target: { value: 'p' },
    })
    await fireEvent.input(screen.getByLabelText(/external subject/i), {
      target: { value: 's' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /link identity/i }))

    expect(await screen.findByText(/user not found/i)).toBeTruthy()
  })

  it('AC-7: the submit control is disabled while a link request is in flight (double-submit guard)', async () => {
    let resolveLink!: (value: typeof SAMPLE_IDENTITY) => void
    linkExternalIdentityMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLink = resolve
      })
    )
    render(ExternalIdentitiesPage, { props: { data: baseData({ identities: [] }) } })

    await fireEvent.change(screen.getByLabelText(/member/i), { target: { value: 'user-1' } })
    await fireEvent.input(screen.getByLabelText(/provider name/i), { target: { value: 'p' } })
    await fireEvent.input(screen.getByLabelText(/external subject/i), { target: { value: 's' } })
    const submit = screen.getByRole('button', { name: /link identity/i })
    await fireEvent.click(submit)
    await fireEvent.click(submit)

    expect(linkExternalIdentityMock).toHaveBeenCalledTimes(1)
    resolveLink(SAMPLE_IDENTITY)
  })

  it('AC-3: unlinks a row after a confirm dialog and calls invalidateAll', async () => {
    unlinkExternalIdentityMock.mockResolvedValue({ id: SAMPLE_IDENTITY.id })
    render(ExternalIdentitiesPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /unlink/i }))

    expect(window.confirm).toHaveBeenCalled()
    expect(unlinkExternalIdentityMock).toHaveBeenCalledWith(expect.anything(), SAMPLE_IDENTITY.id)
    expect(await vi.waitFor(() => invalidateAllMock)).toHaveBeenCalled()
  })

  it('AC-3: a cancelled confirm dialog does not call the unlink API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(ExternalIdentitiesPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /unlink/i }))

    expect(unlinkExternalIdentityMock).not.toHaveBeenCalled()
  })

  it('AC-3 edge: a 404 not_found unlink error renders inline', async () => {
    unlinkExternalIdentityMock.mockRejectedValue(
      new ApiClientError(
        404,
        { code: 'not_found', message: 'External identity not found' },
        'External identity not found'
      )
    )
    render(ExternalIdentitiesPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /unlink/i }))

    expect(await screen.findByText(/external identity not found/i)).toBeTruthy()
  })
})
