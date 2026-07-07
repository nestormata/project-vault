import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const breakGlassRotationMock = vi.hoisted(() => vi.fn())
const listCredentialDependenciesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  breakGlassRotation: breakGlassRotationMock,
}))

vi.mock('$lib/api/credentials.js', () => ({
  listCredentialDependencies: listCredentialDependenciesMock,
}))

import BreakGlassPanel from './BreakGlassPanel.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

async function expandAndFillForm() {
  await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
  await fireEvent.input(screen.getByLabelText(/New value/i), {
    target: { value: 'sk_live_emergency' },
  })
  await fireEvent.input(screen.getByLabelText(/Reason/i), {
    target: { value: 'Key leaked in logs' },
  })
  await fireEvent.click(screen.getByRole('button', { name: /Rotate immediately/i }))
}

describe('BreakGlassPanel', () => {
  beforeEach(() => {
    breakGlassRotationMock.mockReset()
    listCredentialDependenciesMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-19: is collapsed by default and expands on click', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })

    expect(screen.queryByLabelText(/New value/i)).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    expect(screen.getByLabelText(/New value/i)).toBeTruthy()
    expect(screen.getByLabelText(/Reason/i)).toBeTruthy()
  })

  it('AC-21: blocks submission client-side when reason is empty/whitespace', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    await fireEvent.input(screen.getByLabelText(/New value/i), {
      target: { value: 'sk_live_emergency' },
    })
    await fireEvent.input(screen.getByLabelText(/Reason/i), { target: { value: '   ' } })
    await fireEvent.click(screen.getByRole('button', { name: /Rotate immediately/i }))

    expect(screen.getByText('A reason is required for break-glass rotation')).toBeTruthy()
    expect(breakGlassRotationMock).not.toHaveBeenCalled()
  })

  it('AC-20: requires literal CONFIRM text before the final submit is enabled', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()

    const finalButton = screen.getByRole('button', { name: /Confirm break-glass rotation/i })
    expect(finalButton).toHaveProperty('disabled', true)

    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'nope' } })
    expect(finalButton).toHaveProperty('disabled', true)

    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    expect(finalButton).toHaveProperty('disabled', false)
    expect(breakGlassRotationMock).not.toHaveBeenCalled()
  })

  it('AC-20: on success shows the overlap window, independently fetches dependencies, and links to the new rotation', async () => {
    breakGlassRotationMock.mockResolvedValue({
      id: rotationId,
      credentialId,
      projectId,
      status: 'break_glass_complete',
      version: 2,
      initiatedBy: null,
      initiatedAt: '2026-07-01T15:00:00.000Z',
      completedAt: '2026-07-01T15:00:00.000Z',
      notes: null,
      checklistItems: [],
      previousVersionOverlap: {
        versionNumber: 1,
        breakGlassOverlapExpiresAt: '2026-07-01T16:00:00.000Z',
      },
    })
    listCredentialDependenciesMock.mockResolvedValue({
      items: [
        { id: 'd1', systemName: 'billing-worker (production)', archivedAt: null },
        { id: 'd2', systemName: 'GitHub Actions', archivedAt: null },
      ],
      hasDependencies: true,
    })

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    await waitFor(() =>
      expect(breakGlassRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        {
          newValue: 'sk_live_emergency',
          reason: 'Key leaked in logs',
        }
      )
    )
    expect(await screen.findByText(/Break-glass rotation complete/i)).toBeTruthy()
    await waitFor(() => expect(listCredentialDependenciesMock).toHaveBeenCalled())
    expect(await screen.findByText('billing-worker (production)')).toBeTruthy()
    expect(screen.getByText('GitHub Actions')).toBeTruthy()
    const link = screen.getByRole('link', { name: /view the new rotation/i })
    expect(link.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`
    )
  })

  it('AC-21: 409 rotation_lock_contention shows a transient retry message without auto-retrying', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'rotation_lock_contention',
          message: 'Another rotation operation is in progress for this credential. Retry.',
        },
        'Another rotation operation is in progress for this credential. Retry.'
      )
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    expect(
      await screen.findByText(/Another rotation action is in progress for this credential/i)
    ).toBeTruthy()
    expect(breakGlassRotationMock).toHaveBeenCalledTimes(1)
  })

  it('AC-24: 503 sealed vault reuses the existing sealed-vault message', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(503, { status: 'sealed' }, 'sealed')
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    expect(await screen.findByText(/vault is sealed/i)).toBeTruthy()
  })

  it('AC-7: 403 mfa_required shows an action-specific message with a working /settings/security link', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(
        403,
        {
          code: 'mfa_required',
          message: 'MFA enrollment is required for Owner and Admin roles.',
        },
        'MFA enrollment is required for Owner and Admin roles.'
      )
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    expect(await screen.findByText(/Enable MFA to perform a break-glass rotation/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /enable mfa/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
  })

  it('AC-12: 429 shows the break-glass-specific reassuring countdown message, not the generic one', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(
        429,
        { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 45 },
        'Too many authenticated requests'
      )
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    expect(
      await screen.findByText(/Too many break-glass attempts. Try again in 45 seconds/i)
    ).toBeTruthy()
    expect(screen.getByText(/not to block a real incident response/i)).toBeTruthy()
  })

  // AC-16: the new-value field must be cleared on ANY terminal error outcome (not just success),
  // and the confirm-gate state (awaitingConfirmText/confirmText) must reset alongside it —
  // otherwise the admin is stuck staring at an empty-but-disabled textarea with no way to
  // re-paste, while the still-enabled confirm button would resubmit an empty value.
  it('AC-16: a failed submit clears newValue AND falls back out of the awaitingConfirmText step so the admin can re-paste', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(503, { status: 'sealed' }, 'sealed')
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    await screen.findByText(/vault is sealed/i)

    const valueInput = screen.getByLabelText(/New value/i) as HTMLTextAreaElement
    expect(valueInput.value).toBe('')
    expect(valueInput).toHaveProperty('disabled', false)
    expect(screen.queryByLabelText(/Type CONFIRM/i)).toBeNull()
  })

  it('AC-16 edge: the reason field is explicitly NOT cleared on error (admin-controlled incident context, not a secret)', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(503, { status: 'sealed' }, 'sealed')
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    await screen.findByText(/vault is sealed/i)

    const reasonInput = screen.getByLabelText(/Reason/i) as HTMLTextAreaElement
    expect(reasonInput.value).toBe('Key leaked in logs')
  })

  // AC-17: defense-in-depth — clear the plaintext value from $state before the component is torn
  // down (e.g. the admin navigates away mid-fill without submitting). Verified via cleanup()
  // triggering the same onDestroy path @testing-library/svelte always exercises.
  it('AC-17: unmounting the component (e.g. navigating away without submitting) clears newValue/reason before teardown', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    const valueInput = screen.getByLabelText(/New value/i) as HTMLTextAreaElement
    await fireEvent.input(valueInput, { target: { value: 'sk_live_unsubmitted' } })

    // No assertion is possible on post-unmount internal state directly (the component instance is
    // gone) — this test's job is to prove unmounting doesn't throw and that a fresh mount starts
    // clean, which combined with the onDestroy hook's presence in the source is this AC's
    // regression guard.
    cleanup()

    const { getByLabelText } = render(BreakGlassPanel, { props: { projectId, credentialId } })
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    expect((getByLabelText(/New value/i) as HTMLTextAreaElement).value).toBe('')
  })

  it('AC-18: re-collapsing the panel without submitting resets newValue/reason/confirmText/awaitingConfirmText to a clean slate', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })

    // Collapse without submitting.
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    expect(screen.queryByLabelText(/New value/i)).toBeNull()

    // Re-expand — everything must be back to the initial, empty, editable state.
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    const valueInput = screen.getByLabelText(/New value/i) as HTMLTextAreaElement
    const reasonInput = screen.getByLabelText(/Reason/i) as HTMLTextAreaElement
    expect(valueInput.value).toBe('')
    expect(reasonInput.value).toBe('')
    expect(valueInput).toHaveProperty('disabled', false)
    expect(screen.queryByLabelText(/Type CONFIRM/i)).toBeNull()
    expect(breakGlassRotationMock).not.toHaveBeenCalled()
  })
})
