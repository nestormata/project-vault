import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import type { RotationChecklistItem } from '@project-vault/shared'

const confirmChecklistItemMock = vi.hoisted(() => vi.fn())
const failChecklistItemMock = vi.hoisted(() => vi.fn())
const retryChecklistItemMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  confirmChecklistItem: confirmChecklistItemMock,
  failChecklistItem: failChecklistItemMock,
  retryChecklistItem: retryChecklistItemMock,
}))

import ChecklistItemRow from './ChecklistItemRow.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const itemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function makeItem(overrides: Partial<RotationChecklistItem> = {}): RotationChecklistItem {
  return {
    id: itemId,
    dependencyId: null,
    systemName: 'GitHub Actions',
    status: 'unconfirmed',
    confirmedBy: null,
    confirmedAt: null,
    retryCount: 0,
    retryScheduledAt: null,
    lastFailureReason: null,
    lastActedBy: null,
    lastActedAt: null,
    ...overrides,
  }
}

function renderRow(overrides: Partial<RotationChecklistItem> = {}, canAct = true) {
  const onUpdate = vi.fn()
  const onConcurrentModification = vi.fn()
  render(ChecklistItemRow, {
    props: {
      item: makeItem(overrides),
      projectId,
      credentialId,
      rotationId,
      canAct,
      onUpdate,
      onConcurrentModification,
    },
  })
  return { onUpdate, onConcurrentModification }
}

describe('ChecklistItemRow', () => {
  beforeEach(() => {
    confirmChecklistItemMock.mockReset()
    failChecklistItemMock.mockReset()
    retryChecklistItemMock.mockReset()
  })
  afterEach(() => cleanup())

  it('AC-7: renders systemName, status badge, retryCount, and lastFailureReason', () => {
    renderRow({ status: 'failed', retryCount: 1, lastFailureReason: 'still on old key' })

    expect(screen.getByText('GitHub Actions')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
    expect(screen.getByText(/retry: 1/i)).toBeTruthy()
    expect(screen.getByText('still on old key')).toBeTruthy()
  })

  it('AC-14: renders no action buttons when canAct is false', () => {
    renderRow({}, false)

    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /report a problem/i })).toBeNull()
  })

  it('AC-8: confirm calls the API and updates the row in place', async () => {
    const updatedItem = makeItem({
      status: 'confirmed',
      confirmedBy: 'user-1',
      confirmedAt: '2026-07-01T15:00:00.000Z',
    })
    confirmChecklistItemMock.mockResolvedValue({ item: updatedItem, rotationVersion: 2 })
    const { onUpdate } = renderRow()

    await fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() =>
      expect(confirmChecklistItemMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId,
        itemId,
        {}
      )
    )
    expect(onUpdate).toHaveBeenCalledWith(updatedItem, 2)
  })

  it('AC-8 edge: 409 already_confirmed shows a notice and treats the row as confirmed', async () => {
    confirmChecklistItemMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'already_confirmed',
          message: 'Already confirmed',
          confirmedBy: 'user-2',
          confirmedAt: '2026-07-01T15:05:00.000Z',
        },
        'Already confirmed'
      )
    )
    const { onUpdate } = renderRow()

    await fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(await screen.findByText(/Already confirmed by user-2/i)).toBeTruthy()
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed', confirmedBy: 'user-2' }),
      undefined
    )
  })

  it('AC-9: report a problem requires a non-empty reason before submitting', async () => {
    renderRow()

    await fireEvent.click(screen.getByRole('button', { name: /report a problem/i }))
    await fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(screen.getByText(/reason is required/i)).toBeTruthy()
    expect(failChecklistItemMock).not.toHaveBeenCalled()
  })

  it('AC-9: fail transitions the row to failed and shows Retry + Confirm buttons', async () => {
    const failedItem = makeItem({ status: 'failed', lastFailureReason: 'still on old key' })
    failChecklistItemMock.mockResolvedValue({ item: failedItem, rotationVersion: 2 })
    renderRow()

    await fireEvent.click(screen.getByRole('button', { name: /report a problem/i }))
    await fireEvent.input(screen.getByLabelText(/reason/i), {
      target: { value: 'still on old key' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() =>
      expect(failChecklistItemMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId,
        itemId,
        { reason: 'still on old key', retryScheduledAt: null }
      )
    )
  })

  it('AC-9 happy path: retry calls the API with an empty body', async () => {
    const retriedItem = makeItem({ status: 'unconfirmed', retryCount: 1 })
    retryChecklistItemMock.mockResolvedValue({ item: retriedItem, rotationVersion: 3 })
    const { onUpdate } = renderRow({ status: 'failed', lastFailureReason: 'x' })

    await fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))

    await waitFor(() =>
      expect(retryChecklistItemMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId,
        itemId
      )
    )
    expect(onUpdate).toHaveBeenCalledWith(retriedItem, 3)
  })

  it('AC-9: a failed item shows both Retry and Confirm buttons simultaneously', () => {
    renderRow({ status: 'failed', lastFailureReason: 'x' })

    expect(screen.getByRole('button', { name: /^retry$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeTruthy()
  })

  it('AC-10: max_retries_exceeded shows the cap message and still renders Confirm (not Retry)', async () => {
    retryChecklistItemMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'max_retries_exceeded',
          message: 'Maximum retry attempts (3) reached',
          retryCount: 3,
          maxRetries: 3,
        },
        'Maximum retry attempts (3) reached'
      )
    )
    const { onUpdate } = renderRow({ status: 'failed', retryCount: 3, lastFailureReason: 'x' })

    await fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))

    expect(await screen.findByText(/retried the maximum number of times \(3\)/i)).toBeTruthy()
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'max_retries_exceeded', retryCount: 3 }),
      undefined
    )
  })

  it('AC-10: renders the Confirm button (not Retry) once status is max_retries_exceeded', () => {
    renderRow({ status: 'max_retries_exceeded', retryCount: 3 })

    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
  })

  it('AC-15: 409 concurrent_modification calls onConcurrentModification and does not update the row locally', async () => {
    confirmChecklistItemMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'concurrent_modification', message: 'Retry', currentVersion: 5 },
        'Retry'
      )
    )
    const { onUpdate, onConcurrentModification } = renderRow()

    await fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => expect(onConcurrentModification).toHaveBeenCalledTimes(1))
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
