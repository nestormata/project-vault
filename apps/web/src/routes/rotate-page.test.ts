import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { routeExists } from '$lib/test/route-exists.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const initiateRotationMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$lib/api/rotations.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/rotations.js')>()
  return {
    ...original,
    initiateRotation: initiateRotationMock,
  }
})

import RotatePage from './(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    credentialId,
    orgRole: 'admin' as const,
    canManage: true as const,
    dependencies: { items: [], hasDependencies: false },
    ...overrides,
  }
}

describe('/rotate +page.svelte', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    initiateRotationMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-6: renders AccessNotice for member/viewer instead of the form', () => {
    render(RotatePage, {
      props: {
        data: baseData({
          orgRole: 'member' as const,
          canManage: false as const,
          dependencies: null,
        }),
      },
    })

    expect(screen.getByText('Rotation not available')).toBeTruthy()
    expect(screen.getByText('Starting a rotation requires Admin access or higher.')).toBeTruthy()
    expect(screen.queryByLabelText(/New value/i)).toBeNull()
  })

  it('AC-3: renders the dependency preview listing each system', () => {
    render(RotatePage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              { id: 'd1', systemName: 'billing-worker (production)' },
              { id: 'd2', systemName: 'GitHub Actions' },
            ],
            hasDependencies: true,
          },
        }),
      },
    })

    expect(screen.getByText(/create a checklist item for each of these 2 systems/i)).toBeTruthy()
    expect(screen.getByText('billing-worker (production)')).toBeTruthy()
    expect(screen.getByText('GitHub Actions')).toBeTruthy()
  })

  it('AC-3 edge: zero dependencies shows the foreshadowing empty-state copy', () => {
    render(RotatePage, { props: { data: baseData() } })

    expect(screen.getByText(/No dependent systems are recorded for this credential/i)).toBeTruthy()
  })

  it('AC-4: submits newValue/notes and redirects to the new rotation on success', async () => {
    initiateRotationMock.mockResolvedValue({ id: rotationId })

    render(RotatePage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/New value/i), {
      target: { value: 'sk_live_NEW_VALUE_abc123' },
    })
    await fireEvent.input(screen.getByLabelText(/Notes/i), {
      target: { value: 'Rotating after the June security review' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    await waitFor(() =>
      expect(initiateRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        {
          newValue: 'sk_live_NEW_VALUE_abc123',
          notes: 'Rotating after the June security review',
        }
      )
    )
    expect(gotoMock).toHaveBeenCalledWith(
      `/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`
    )
  })

  it('AC-4 edge: blocks submission client-side when the value is empty', async () => {
    render(RotatePage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(screen.getByText('New value cannot be empty')).toBeTruthy()
    expect(initiateRotationMock).not.toHaveBeenCalled()
  })

  it('AC-4 edge: shows the server 422 message under the textarea without clearing the form', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'validation_error', message: 'Value exceeds the 65536-character limit.' },
        'Value exceeds the 65536-character limit.'
      )
    )

    render(RotatePage, { props: { data: baseData() } })
    const valueInput = screen.getByLabelText(/New value/i) as HTMLTextAreaElement
    await fireEvent.input(valueInput, { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText('Value exceeds the 65536-character limit.')).toBeTruthy()
    expect(valueInput.value).toBe('sk_live_x')
  })

  it('AC-5: 409 rotation_in_progress links straight to the winning rotation', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'rotation_in_progress',
          message: 'A rotation is already in progress.',
          rotationId: 'r-1',
        },
        'A rotation is already in progress.'
      )
    )

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    const link = await screen.findByRole('link', { name: /already in progress/i })
    expect(link.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/${credentialId}/rotations/r-1`
    )
  })

  it('AC-6 edge: 403 on submit (role downgraded mid-session) shows a message and does not redirect', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(403, { code: 'insufficient_role', message: 'Forbidden' }, 'Forbidden')
    )

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText('You do not have permission to start a rotation.')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('AC-24: 503 sealed-vault reuses the existing sealed-vault message', async () => {
    initiateRotationMock.mockRejectedValue(new ApiClientError(503, { status: 'sealed' }, 'sealed'))

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText(/vault is sealed/i)).toBeTruthy()
  })

  it('AC-19: break-glass panel renders for admin/owner', () => {
    render(RotatePage, { props: { data: baseData() } })
    expect(screen.getByRole('button', { name: /Emergency: break-glass rotation/i })).toBeTruthy()
  })

  it('AC-2: renders the sealed-vault message (checked before the AccessNotice gate) with a link back to the credential', () => {
    render(RotatePage, {
      props: {
        data: baseData({
          vaultSealed: true as const,
          canManage: true as const,
          dependencies: null,
        }),
      },
    })

    expect(screen.getByRole('alert').textContent).toContain(onboardingCopy.vaultSealedMessage)
    expect(screen.queryByText('Rotation not available')).toBeNull()
    expect(screen.queryByLabelText(/New value/i)).toBeNull()
    const link = screen.getByRole('link', { name: /back to credential/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/credentials/${credentialId}`)
  })

  it('AC-6: 403 mfa_required shows an action-specific message with a working /settings/security link', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(
        403,
        {
          code: 'mfa_required',
          message:
            'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.',
        },
        'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'
      )
    )

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText(/Enable MFA to start a rotation/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /enable mfa/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('AC-6 edge: a plain 403 with a different code (e.g. insufficient_role) still shows the existing generic message, not the MFA one', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(403, { code: 'insufficient_role', message: 'Forbidden' }, 'Forbidden')
    )

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText('You do not have permission to start a rotation.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /enable mfa/i })).toBeNull()
  })

  it('AC-11: 429 rate_limit_exceeded shows a countdown message reading retryAfter, not the raw backend string', async () => {
    initiateRotationMock.mockRejectedValue(
      new ApiClientError(
        429,
        { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 12 },
        'Too many authenticated requests'
      )
    )

    render(RotatePage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/New value/i), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: /Start rotation/i }))

    expect(await screen.findByText(/12 seconds/i)).toBeTruthy()
    expect(screen.queryByText('Too many authenticated requests')).toBeNull()
  })

  it('AC-2 edge: member/viewer on a sealed vault still sees the role-gate AccessNotice, not the sealed message', () => {
    render(RotatePage, {
      props: {
        data: baseData({
          orgRole: 'member' as const,
          canManage: false as const,
          dependencies: null,
          vaultSealed: undefined,
        }),
      },
    })

    expect(screen.getByText('Rotation not available')).toBeTruthy()
    expect(screen.queryByText(onboardingCopy.vaultSealedMessage)).toBeNull()
  })
})
