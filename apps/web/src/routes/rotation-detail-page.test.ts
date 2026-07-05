import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import type { RotationChecklistItem, RotationDetail } from '@project-vault/shared'

const getRotationMock = vi.hoisted(() => vi.fn())
const completeRotationMock = vi.hoisted(() => vi.fn())
const confirmChecklistItemMock = vi.hoisted(() => vi.fn())
const failChecklistItemMock = vi.hoisted(() => vi.fn())
const retryChecklistItemMock = vi.hoisted(() => vi.fn())
const resumeRotationMock = vi.hoisted(() => vi.fn())
const abandonRotationMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  getRotation: getRotationMock,
  completeRotation: completeRotationMock,
  confirmChecklistItem: confirmChecklistItemMock,
  failChecklistItem: failChecklistItemMock,
  retryChecklistItem: retryChecklistItemMock,
  resumeRotation: resumeRotationMock,
  abandonRotation: abandonRotationMock,
}))

import RotationDetailPage from './(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeItem(overrides: Partial<RotationChecklistItem> = {}): RotationChecklistItem {
  return {
    id: overrides.id ?? 'i1',
    dependencyId: null,
    systemName: overrides.systemName ?? 'billing-worker (production)',
    status: overrides.status ?? 'unconfirmed',
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

function makeRotation(overrides: Partial<RotationDetail> = {}): RotationDetail {
  return {
    id: rotationId,
    credentialId,
    projectId,
    status: 'in_progress',
    version: 1,
    initiatedBy: null,
    initiatedAt: '2026-07-01T14:10:00.000Z',
    completedAt: null,
    notes: null,
    checklistItems: [],
    ...overrides,
  }
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    credentialId,
    rotationId,
    orgRole: 'admin' as const,
    rotation: makeRotation(),
    notFound: false as const,
    ...overrides,
  }
}

describe('/rotations/[rotationId] +page.svelte', () => {
  beforeEach(() => {
    getRotationMock.mockReset()
    completeRotationMock.mockReset()
    confirmChecklistItemMock.mockReset()
    failChecklistItemMock.mockReset()
    retryChecklistItemMock.mockReset()
    resumeRotationMock.mockReset()
    abandonRotationMock.mockReset()
    vi.useRealTimers()
  })
  afterEach(() => cleanup())

  it('AC-7: renders rotation metadata and one row per checklist item', () => {
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            checklistItems: [
              makeItem({
                id: 'i1',
                systemName: 'billing-worker (production)',
                status: 'confirmed',
              }),
              makeItem({ id: 'i2', systemName: 'GitHub Actions', status: 'failed', retryCount: 1 }),
              makeItem({ id: 'i3', systemName: 'Vercel env vars', status: 'unconfirmed' }),
            ],
          }),
        }),
      },
    })

    expect(screen.getByText('billing-worker (production)')).toBeTruthy()
    expect(screen.getByText('GitHub Actions')).toBeTruthy()
    expect(screen.getByText('Vercel env vars')).toBeTruthy()
    expect(screen.getByText('in_progress')).toBeTruthy()
  })

  it('AC-7 edge: zero checklist items shows the explicit empty-state message, not an empty table', () => {
    render(RotationDetailPage, { props: { data: baseData() } })

    expect(
      screen.getByText('No dependent systems were recorded when this rotation started.')
    ).toBeTruthy()
  })

  it('AC-7 edge: renders the not-found block when notFound is true', () => {
    render(RotationDetailPage, {
      props: { data: baseData({ notFound: true as const, rotation: null }) },
    })

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Rotation not found/i)).toBeTruthy()
  })

  it('AC-14: viewer sees no action buttons and a read-access banner', () => {
    render(RotationDetailPage, {
      props: {
        data: baseData({
          orgRole: 'viewer' as const,
          rotation: makeRotation({ checklistItems: [makeItem({ status: 'unconfirmed' })] }),
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /complete rotation/i })).toBeNull()
    expect(
      screen.getByText(/Confirming, completing, or resolving rotations requires Member access/i)
    ).toBeTruthy()
  })

  it('AC-11: complete button is disabled while items remain unconfirmed, enabled once all confirmed', () => {
    const { rerender } = render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed' })],
          }),
        }),
      },
    })

    const button = screen.getByRole('button', { name: /complete rotation/i })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByText(/1 system\(s\) still need confirmation/i)).toBeTruthy()

    rerender({
      data: baseData({
        rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
      }),
    })
    expect(screen.getByRole('button', { name: /complete rotation/i })).toHaveProperty(
      'disabled',
      false
    )
  })

  it('AC-11: complete happy path re-renders the rotation as completed', async () => {
    completeRotationMock.mockResolvedValue(
      makeRotation({
        status: 'completed',
        completedAt: '2026-07-02T00:00:00.000Z',
        checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })],
      })
    )
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    await waitFor(() =>
      expect(completeRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId,
        {}
      )
    )
    expect(await screen.findByText('completed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /complete rotation/i })).toBeNull()
  })

  it('AC-12: 422 checklist_incomplete lists pending systems and triggers a refetch', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'checklist_incomplete',
          message: '1 of 2 checklist items are not yet confirmed.',
          pendingItems: [{ id: 'i2', systemName: 'GitHub Actions', status: 'unconfirmed' }],
        },
        '1 of 2 checklist items are not yet confirmed.'
      )
    )
    getRotationMock.mockResolvedValue(
      makeRotation({
        checklistItems: [
          makeItem({ id: 'i1', status: 'confirmed' }),
          makeItem({ id: 'i2', systemName: 'GitHub Actions', status: 'unconfirmed' }),
        ],
      })
    )

    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            checklistItems: [
              makeItem({ id: 'i1', status: 'confirmed' }),
              makeItem({ id: 'i2', systemName: 'GitHub Actions', status: 'confirmed' }),
            ],
          }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    const alertBlock = await screen.findByRole('alert')
    expect(alertBlock.textContent).toContain('GitHub Actions')
    await waitFor(() => expect(getRotationMock).toHaveBeenCalledTimes(1))
  })

  it('AC-13: zero-item rotation requires the acknowledgement checkbox before completing', async () => {
    completeRotationMock.mockResolvedValue(
      makeRotation({ status: 'completed', checklistItems: [] })
    )
    render(RotationDetailPage, {
      props: { data: baseData({ rotation: makeRotation({ checklistItems: [] }) }) },
    })

    const button = screen.getByRole('button', { name: /complete rotation/i })
    expect(button).toHaveProperty('disabled', true)

    await fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I confirm this credential is updated in all consuming systems/i,
      })
    )
    expect(button).toHaveProperty('disabled', false)

    await fireEvent.click(button)
    await waitFor(() =>
      expect(completeRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId,
        { acknowledgedNoDependencies: true }
      )
    )
  })

  it('AC-13 edge: 422 acknowledgement_required shows the message and re-shows the unchecked checkbox', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'acknowledgement_required',
          message: 'ack required',
          checklistItemCount: 0,
        },
        'ack required'
      )
    )
    render(RotationDetailPage, {
      props: { data: baseData({ rotation: makeRotation({ checklistItems: [] }) }) },
    })

    await fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I confirm this credential is updated in all consuming systems/i,
      })
    )
    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    expect(
      await screen.findByText(/Please confirm the credential is updated everywhere/i)
    ).toBeTruthy()
    expect(
      screen.getByRole('checkbox', {
        name: /I confirm this credential is updated in all consuming systems/i,
      })
    ).toHaveProperty('checked', false)
  })

  it('AC-15: concurrent_modification on complete triggers a single refetch and clears after refresh', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'concurrent_modification', message: 'Retry', currentVersion: 5 },
        'Retry'
      )
    )
    getRotationMock.mockResolvedValue(
      makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] })
    )

    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    await waitFor(() => expect(getRotationMock).toHaveBeenCalledTimes(1))
  })

  it('AC-16: renders StaleRecoveryBanner and hides per-item action buttons while stale_recovery', () => {
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            status: 'stale_recovery',
            checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed', retryCount: 3 })],
          }),
        }),
      },
    })

    expect(screen.getByText(/needs a decision: resume it, or abandon it/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^confirm$/i })).toBeNull()
  })

  it('AC-16: resuming refetches the rotation and shows per-item buttons again', async () => {
    resumeRotationMock.mockResolvedValue(makeRotation({ status: 'in_progress' }))
    getRotationMock.mockResolvedValue(
      makeRotation({
        status: 'in_progress',
        checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed' })],
      })
    )

    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            status: 'stale_recovery',
            checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed' })],
          }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^resume$/i }))

    await waitFor(() => expect(getRotationMock).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: /^confirm$/i })).toBeTruthy()
  })

  it('polling: refetches every 15s while in_progress and stops once terminal', async () => {
    vi.useFakeTimers()
    getRotationMock.mockResolvedValue(makeRotation({ status: 'completed', checklistItems: [] }))

    render(RotationDetailPage, { props: { data: baseData() } })

    await vi.advanceTimersByTimeAsync(15000)
    expect(getRotationMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    // rotation is now completed (terminal) — polling should not have scheduled a further call
    expect(getRotationMock).toHaveBeenCalledTimes(1)
  })

  it('polling: does not refetch while the tab is hidden', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    render(RotationDetailPage, { props: { data: baseData() } })
    await vi.advanceTimersByTimeAsync(30000)

    expect(getRotationMock).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
})
