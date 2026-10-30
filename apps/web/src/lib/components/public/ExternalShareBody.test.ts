import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const revealMock = vi.hoisted(() => vi.fn())
const sendMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({
  revealExternalCredentialShare: revealMock,
  sendExternalShareVerification: sendMock,
  confirmExternalShareVerification: confirmMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import ExternalShareBody from './ExternalShareBody.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const TOKEN = 'raw-external-token'
const OPEN = {
  credentialId: 'cred-1',
  credentialName: 'Stripe Key',
  sharedByDisplayName: 'morgan',
  fieldKey: null,
  attributeKeys: null,
  action: 'read' as const,
  expiresAt: '2026-08-01T00:00:00.000Z',
  status: 'active' as const,
}
const GATED = {
  credentialName: 'Stripe Key',
  sharedByDisplayName: 'morgan',
  expiresAt: '2026-08-01T00:00:00.000Z',
  status: 'active' as const,
  verificationRequired: true,
  maskedRecipient: 'v***@e***',
}

function renderBody(metadata: typeof OPEN | typeof GATED) {
  return render(ExternalShareBody, { props: { metadata, token: TOKEN, error: null } })
}

async function verifyWith(code: string) {
  await fireEvent.input(screen.getByLabelText('6-digit code'), { target: { value: code } })
  await fireEvent.click(screen.getByRole('button', { name: 'Verify code' }))
}

describe('ExternalShareBody (Story 72.11 guest verification)', () => {
  it('a share without verification keeps today flow: Reveal calls the API with no proof', async () => {
    revealMock.mockResolvedValue({ value: 'value-1', valueFormat: 'scalar' })
    renderBody(OPEN)
    expect(screen.queryByText('Send code')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: /^reveal secret$/i }))
    expect(await screen.findByText('value-1')).toBeTruthy()
    expect(revealMock).toHaveBeenCalledWith(expect.anything(), TOKEN, undefined)
  })

  it('a gated share shows the masked address and the code step, and no reveal button', () => {
    renderBody(GATED)
    expect(screen.getByText(/v\*\*\*@e\*\*\*/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reveal secret/i })).toBeNull()
    const input = screen.getByLabelText('6-digit code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('maxlength')).toBe('6')
  })

  it('Send code requests a code, then disables resend with a visible countdown', async () => {
    sendMock.mockResolvedValue({ maskedRecipient: 'v***@e***', cooldownSeconds: 60 })
    renderBody(GATED)
    await fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    const resend = await screen.findByRole('button', { name: /Resend code in 60 s/ })
    expect((resend as HTMLButtonElement).disabled).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(expect.anything(), TOKEN)
  })

  it('a wrong code shows the generic failure in a role=alert region', async () => {
    confirmMock.mockRejectedValue(new ApiClientError(422, { code: 'verification_failed' }, 'x'))
    renderBody(GATED)
    await verifyWith('000000')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('That code did not work')
  })

  it('the right code unlocks Reveal, which sends the proof in the body and shows the value', async () => {
    confirmMock.mockResolvedValue({ proof: 'proof-xyz' })
    revealMock.mockResolvedValue({ value: 'gated-value', valueFormat: 'scalar' })
    renderBody(GATED)
    await verifyWith('123456')
    await fireEvent.click(await screen.findByRole('button', { name: /^reveal secret$/i }))
    expect(await screen.findByText('gated-value')).toBeTruthy()
    expect(revealMock).toHaveBeenCalledWith(expect.anything(), TOKEN, 'proof-xyz')
  })

  it('keeps the proof out of the URL, web storage and cookies', async () => {
    confirmMock.mockResolvedValue({ proof: 'proof-in-memory-only' })
    renderBody(GATED)
    await verifyWith('123456')
    await screen.findByRole('button', { name: /^reveal secret$/i })
    expect(window.location.href).not.toContain('proof-in-memory-only')
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('proof-in-memory-only')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('proof-in-memory-only')
    expect(document.cookie).not.toContain('proof-in-memory-only')
  })

  it('a gated reveal that fails keeps showing the terminal reason, not the code step', async () => {
    confirmMock.mockResolvedValue({ proof: 'p' })
    revealMock.mockRejectedValue(new ApiClientError(410, { code: 'share_already_viewed' }, 'x'))
    renderBody(GATED)
    await verifyWith('123456')
    await fireEvent.click(await screen.findByRole('button', { name: /^reveal secret$/i }))
    expect(await screen.findByText('This link has already been used.')).toBeTruthy()
    expect(screen.queryByLabelText('6-digit code')).toBeNull()
  })
})
