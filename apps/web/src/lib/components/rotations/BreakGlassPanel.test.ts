import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import { routeExists } from '$lib/test/route-exists.js'

const breakGlassRotationMock = vi.hoisted(() => vi.fn())
const listCredentialDependenciesMock = vi.hoisted(() => vi.fn())
// AC-17 regression guard: a fresh component instance always starts with empty `$state`, so
// re-mounting after `cleanup()` proves nothing about whether the `onDestroy` hook itself actually
// ran or does anything (per this AC's own test guidance: "if the test harness cannot directly
// observe post-unmount internal state, structure the test to spy on the clearing function/hook
// being called instead"). Capturing every callback registered via `onDestroy` lets the AC-17 test
// invoke that exact callback while the component is still mounted and assert the reactive DOM
// update it causes — a real regression guard that fails if the hook is ever removed.
const capturedOnDestroyCallbacks = vi.hoisted((): Array<() => void> => [])

vi.mock('$lib/api/rotations.js', () => ({
  breakGlassRotation: breakGlassRotationMock,
}))

vi.mock('$lib/api/credentials.js', () => ({
  listCredentialDependencies: listCredentialDependenciesMock,
}))

vi.mock('svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('svelte')>()
  return {
    ...actual,
    onDestroy: (fn: () => void) => {
      capturedOnDestroyCallbacks.push(fn)
      return actual.onDestroy(fn)
    },
  }
})

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
    capturedOnDestroyCallbacks.length = 0
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
    // Regression guard: this link 404'd for a long time — a matching href string alone doesn't
    // prove the destination is real.
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
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
  // down (e.g. the admin navigates away mid-fill without submitting). A fresh component instance
  // always starts with empty `$state` regardless of whether `onDestroy` ever ran (or exists at
  // all), so re-mounting after `cleanup()` alone cannot prove this hook does anything — this test
  // instead invokes the exact callback registered via `onDestroy` while the component is still
  // mounted and asserts the reactive DOM update it causes, per this AC's own test guidance ("spy
  // on the clearing function/hook being called").
  it('AC-17: the registered onDestroy callback clears newValue/reason (defense-in-depth teardown)', async () => {
    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    const valueInput = screen.getByLabelText(/New value/i) as HTMLTextAreaElement
    const reasonInput = screen.getByLabelText(/Reason/i) as HTMLTextAreaElement
    await fireEvent.input(valueInput, { target: { value: 'sk_live_unsubmitted' } })
    await fireEvent.input(reasonInput, { target: { value: 'investigating a leak' } })

    expect(capturedOnDestroyCallbacks).toHaveLength(1)

    // Invoke the real registered teardown callback directly, without unmounting, so the
    // still-mounted component's reactive DOM proves the callback itself clears the secret —
    // rather than merely proving a fresh instance starts empty.
    capturedOnDestroyCallbacks[0]()
    await waitFor(() => expect(valueInput.value).toBe(''))
    expect(reasonInput.value).toBe('')

    // Also verify the real unmount path (the only place this callback fires in production)
    // exercises the same registration without throwing.
    expect(() => cleanup()).not.toThrow()
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

  // Code-review finding (AC-18 gap): the reset on collapse cleared newValue/reason/confirmText/
  // awaitingConfirmText but not errorMessage — a stale error from a previous failed attempt (which
  // may include an "Enable MFA" link) would otherwise resurface next to a freshly blank form on
  // re-expand, contradicting AC-18's "full reset of the entire unsubmitted form" requirement.
  it('AC-18: re-collapsing the panel after a failed submit also clears the stale error message on re-expand', async () => {
    breakGlassRotationMock.mockRejectedValue(
      new ApiClientError(503, { status: 'sealed' }, 'sealed')
    )

    render(BreakGlassPanel, { props: { projectId, credentialId } })
    await expandAndFillForm()
    await fireEvent.input(screen.getByLabelText(/Type CONFIRM/i), { target: { value: 'CONFIRM' } })
    await fireEvent.click(screen.getByRole('button', { name: /Confirm break-glass rotation/i }))

    await screen.findByText(/vault is sealed/i)

    // Collapse without a further submit, then re-expand.
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))
    await fireEvent.click(screen.getByRole('button', { name: /Emergency: break-glass rotation/i }))

    expect(screen.queryByText(/vault is sealed/i)).toBeNull()
  })
})
