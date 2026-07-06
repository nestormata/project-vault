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
})
