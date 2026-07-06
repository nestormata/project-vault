import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const resumeRotationMock = vi.hoisted(() => vi.fn())
const abandonRotationMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  resumeRotation: resumeRotationMock,
  abandonRotation: abandonRotationMock,
}))

import StaleRecoveryBanner from './StaleRecoveryBanner.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function renderBanner() {
  const onResumed = vi.fn()
  const onAbandoned = vi.fn()
  const onConcurrentModification = vi.fn()
  render(StaleRecoveryBanner, {
    props: {
      projectId,
      credentialId,
      rotationId,
      onResumed,
      onAbandoned,
      onConcurrentModification,
    },
  })
  return { onResumed, onAbandoned, onConcurrentModification }
}

describe('StaleRecoveryBanner', () => {
  beforeEach(() => {
    resumeRotationMock.mockReset()
    abandonRotationMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-16: renders the amber decision banner with Resume and Abandon buttons', () => {
    renderBanner()

    expect(screen.getByText(/needs a decision: resume it, or abandon it/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^resume$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^abandon$/i })).toBeTruthy()
  })

  it('AC-16: Resume calls the API and notifies the parent on success', async () => {
    resumeRotationMock.mockResolvedValue({ id: rotationId, status: 'in_progress' })
    const { onResumed } = renderBanner()

    await fireEvent.click(screen.getByRole('button', { name: /^resume$/i }))

    await waitFor(() =>
      expect(resumeRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId
      )
    )
    expect(onResumed).toHaveBeenCalled()
  })

  it('AC-17: Abandon requires an explicit confirmation step before calling the API', async () => {
    renderBanner()

    await fireEvent.click(screen.getByRole('button', { name: /^abandon$/i }))
    expect(
      screen.getByText(/Abandoning will discard the new value from this rotation/i)
    ).toBeTruthy()
    expect(abandonRotationMock).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: /abandon anyway/i }))
    await waitFor(() => expect(abandonRotationMock).toHaveBeenCalled())
  })

  it('AC-17: Cancel on the confirmation step does not call the API', async () => {
    renderBanner()

    await fireEvent.click(screen.getByRole('button', { name: /^abandon$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(abandonRotationMock).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/Abandoning will discard the new value from this rotation/i)
    ).toBeNull()
  })

  it('AC-17 edge: 422 rotation_not_stale shows a message and triggers a refetch', async () => {
    abandonRotationMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'rotation_not_stale', message: 'not stale', status: 'in_progress' },
        'not stale'
      )
    )
    renderBanner()

    await fireEvent.click(screen.getByRole('button', { name: /^abandon$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /abandon anyway/i }))

    expect(await screen.findByText(/no longer awaiting a decision/i)).toBeTruthy()
  })

  it('AC-15: 409 concurrent_modification triggers onConcurrentModification', async () => {
    resumeRotationMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'concurrent_modification', message: 'Retry', currentVersion: 5 },
        'Retry'
      )
    )
    const { onConcurrentModification } = renderBanner()

    await fireEvent.click(screen.getByRole('button', { name: /^resume$/i }))

    await waitFor(() => expect(onConcurrentModification).toHaveBeenCalledTimes(1))
  })
})
