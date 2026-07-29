import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const revealCredentialShareMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({
  revealCredentialShare: revealCredentialShareMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import ShareAccessPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const token = 'raw-token-value'

const METADATA = {
  credentialId: 'cred-1',
  credentialName: 'Stripe Secret Key',
  sharedBy: 'sharer-1',
  sharedByEmail: 'morgan@example.com',
  fieldKey: null,
  expiresAt: '2026-08-01T00:00:00.000Z',
  singleUse: true,
  status: 'active' as const,
}

describe('/shares/[token] +page.svelte', () => {
  it('AC-8: shows the two-step consent screen — never the value on first render', () => {
    render(ShareAccessPage, { props: { data: { token, metadata: METADATA, error: null } } })

    expect(screen.getByText(/Stripe Secret Key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^reveal$/i })).toBeTruthy()
  })

  it('AC-8: clicking Reveal shows the value only after the explicit second action', async () => {
    revealCredentialShareMock.mockResolvedValue({
      credentialId: 'cred-1',
      fieldKey: null,
      value: 'sentinel-value',
      viewedAt: '2026-07-28T00:00:00.000Z',
    })
    render(ShareAccessPage, { props: { data: { token, metadata: METADATA, error: null } } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }))

    expect(await screen.findByText('sentinel-value')).toBeTruthy()
    expect(revealCredentialShareMock).toHaveBeenCalledWith(expect.anything(), token)
  })

  it('AC-14: an already-viewed share shows an honest message, not the value', async () => {
    revealCredentialShareMock.mockRejectedValue(
      new ApiClientError(410, { code: 'share_already_viewed' }, 'already viewed')
    )
    render(ShareAccessPage, { props: { data: { token, metadata: METADATA, error: null } } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }))

    expect(await screen.findByText(/already been viewed/i)).toBeTruthy()
  })

  it('shows an honest expired message on a 410 share_expired', async () => {
    revealCredentialShareMock.mockRejectedValue(
      new ApiClientError(410, { code: 'share_expired' }, 'expired')
    )
    render(ShareAccessPage, { props: { data: { token, metadata: METADATA, error: null } } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }))

    expect(await screen.findByText(/has expired/i)).toBeTruthy()
  })

  it('AC-7: renders an honest not-found state', () => {
    render(ShareAccessPage, { props: { data: { token, metadata: null, error: 'not_found' } } })
    expect(screen.getByText(/invalid, or has already expired/i)).toBeTruthy()
  })

  it('AC-7: renders an honest session-mismatch state (not a generic error)', () => {
    render(ShareAccessPage, {
      props: { data: { token, metadata: null, error: 'session_mismatch' } },
    })
    expect(screen.getByText(/not addressed to your account/i)).toBeTruthy()
  })
})
