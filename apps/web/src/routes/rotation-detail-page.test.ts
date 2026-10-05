import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import { apiClientError } from '$lib/test/api-error.js'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { routeExists } from '$lib/test/route-exists.js'
import type { RotationChecklistItem, RotationDetail } from '@project-vault/shared'

const getRotationMock = vi.hoisted(() => vi.fn())
const completeRotationMock = vi.hoisted(() => vi.fn())
const confirmChecklistItemMock = vi.hoisted(() => vi.fn())
const failChecklistItemMock = vi.hoisted(() => vi.fn())
const retryChecklistItemMock = vi.hoisted(() => vi.fn())
const resumeRotationMock = vi.hoisted(() => vi.fn())
const abandonRotationMock = vi.hoisted(() => vi.fn())
const promoteRotationMock = vi.hoisted(() => vi.fn())
const getStagedValueMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({
  getRotation: getRotationMock,
  completeRotation: completeRotationMock,
  confirmChecklistItem: confirmChecklistItemMock,
  failChecklistItem: failChecklistItemMock,
  retryChecklistItem: retryChecklistItemMock,
  resumeRotation: resumeRotationMock,
  abandonRotation: abandonRotationMock,
  promoteRotation: promoteRotationMock,
  getStagedValue: getStagedValueMock,
}))

import type { ComponentProps } from 'svelte'
import { projectLayoutData } from '$lib/test/page-data.js'
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
    targetFields: null,
    checklistItems: [],
    ...overrides,
  }
}

type Data = ComponentProps<typeof RotationDetailPage>['data']

/** The loaded page (not the not-found or sealed-vault fallbacks). */
type LoadedData = Exclude<Data, { notFound: true } | { vaultSealed: true }>

function baseData(overrides: Partial<LoadedData> = {}): LoadedData {
  return {
    ...projectLayoutData(),
    projectId,
    credentialId,
    rotationId,
    orgRole: 'admin',
    rotation: makeRotation(),
    notFound: false,
    ...overrides,
  }
}

/** The loader's 404 fallback. */
function notFoundData(): Data {
  return {
    ...projectLayoutData(),
    projectId,
    credentialId,
    rotationId,
    orgRole: 'admin',
    rotation: null,
    notFound: true,
  }
}

/** The loader's sealed-vault (503) fallback. */
function sealedData(): Data {
  return {
    ...projectLayoutData(),
    projectId,
    credentialId,
    rotationId,
    orgRole: 'admin',
    rotation: null,
    notFound: false,
    vaultSealed: true,
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
    promoteRotationMock.mockReset()
    getStagedValueMock.mockReset()
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
      props: { data: notFoundData() },
    })

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Rotation not found/i)).toBeTruthy()
  })

  it('AC-3: renders the sealed-vault message (not "Rotation not found") when data.vaultSealed is true', () => {
    render(RotationDetailPage, {
      props: {
        data: sealedData(),
      },
    })

    expect(screen.getByRole('alert').textContent).toContain(onboardingCopy.vaultSealedMessage)
    expect(screen.queryByText(/Rotation not found/i)).toBeNull()
    const link = screen.getByRole('link', { name: /back to secret/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/credentials/${credentialId}`)
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
      apiClientError(
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
        name: /I confirm this secret is updated in all consuming systems/i,
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
      apiClientError(
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
        name: /I confirm this secret is updated in all consuming systems/i,
      })
    )
    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    expect(await screen.findByText(/Please confirm the secret is updated everywhere/i)).toBeTruthy()
    expect(
      screen.getByRole('checkbox', {
        name: /I confirm this secret is updated in all consuming systems/i,
      })
    ).toHaveProperty('checked', false)
  })

  it('AC-15: concurrent_modification on complete triggers a single refetch and clears after refresh', async () => {
    completeRotationMock.mockRejectedValue(
      apiClientError(
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

  it('422 rotation_not_active on complete triggers the same refetch remediation as concurrent_modification', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'rotation_not_active',
          message: 'This rotation is not in progress.',
          status: 'abandoned',
        },
        'This rotation is not in progress.'
      )
    )
    getRotationMock.mockResolvedValue(
      makeRotation({
        status: 'abandoned',
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

    await waitFor(() => expect(getRotationMock).toHaveBeenCalledTimes(1))
  })

  it('AC-8: 403 mfa_required on complete shows an action-specific message with a working link, and re-enables the button', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA enrollment is required for Owner and Admin roles.' },
        'MFA enrollment is required for Owner and Admin roles.'
      )
    )
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
        }),
      },
    })

    const button = screen.getByRole('button', { name: /complete rotation/i })
    await fireEvent.click(button)

    expect(await screen.findByText(/Enable MFA to complete this rotation/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /enable mfa/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
    expect(button).toHaveProperty('disabled', false)
  })

  it('AC-14: 429 on complete shows the generic countdown message via the shared helper', async () => {
    completeRotationMock.mockRejectedValue(
      new ApiClientError(
        429,
        { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 8 },
        'Too many authenticated requests'
      )
    )
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    expect(await screen.findByText(/8 seconds/i)).toBeTruthy()
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

  // AC-5: the vault can seal between page load and a poll/refresh tick. The 15s poll and the
  // manual "Refresh" button both call refetch(), whose catch block today is an empty
  // best-effort comment — a sealed-vault 503 mid-poll is silently swallowed with zero indication.
  it('AC-5: a 503 mid-poll shows the sealed-vault banner without blanking the last known rotation state, then clears once a later poll succeeds', async () => {
    vi.useFakeTimers()
    getRotationMock.mockRejectedValueOnce(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            status: 'in_progress',
            checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed' })],
          }),
        }),
      },
    })

    await vi.advanceTimersByTimeAsync(15000)

    expect(await screen.findByText(onboardingCopy.vaultSealedMessage)).toBeTruthy()
    // Last known state must still be showing — the poll failing is not the same as not existing.
    expect(screen.getByText('billing-worker (production)')).toBeTruthy()

    getRotationMock.mockResolvedValueOnce(
      makeRotation({
        status: 'in_progress',
        checklistItems: [makeItem({ id: 'i1', status: 'unconfirmed' })],
      })
    )
    await vi.advanceTimersByTimeAsync(15000)

    await waitFor(() => expect(screen.queryByText(onboardingCopy.vaultSealedMessage)).toBeNull())
  })

  it('AC-5 edge: manual Refresh click while sealed surfaces the same banner as the poll', async () => {
    vi.useRealTimers()
    getRotationMock.mockRejectedValueOnce(
      new ApiClientError(
        503,
        { status: 'sealed', message: 'Vault not initialized' },
        'Vault not initialized'
      )
    )

    render(RotationDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))

    expect(await screen.findByText(onboardingCopy.vaultSealedMessage)).toBeTruthy()
  })

  it("AC-5 edge: a non-503 refetch error keeps today's exact behavior — silently keep the last known state, no banner", async () => {
    vi.useRealTimers()
    getRotationMock.mockRejectedValueOnce(new Error('network down'))

    render(RotationDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))

    await waitFor(() => expect(getRotationMock).toHaveBeenCalled())
    expect(screen.queryByText(onboardingCopy.vaultSealedMessage)).toBeNull()
  })

  it('renders rotation notes and the completed timestamp when both are present', () => {
    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({
            notes: 'Rotated after suspected leak in CI logs',
            completedAt: '2026-07-02T00:00:00.000Z',
          }),
        }),
      },
    })

    expect(screen.getByText('Rotated after suspected leak in CI logs')).toBeTruthy()
    expect(screen.getByText(/Completed/)).toBeTruthy()
  })

  it('a non-ApiClientError completion failure shows the raw Error message', async () => {
    vi.useRealTimers()
    completeRotationMock.mockRejectedValue(new Error('socket hang up'))

    render(RotationDetailPage, {
      props: {
        data: baseData({
          rotation: makeRotation({ checklistItems: [makeItem({ id: 'i1', status: 'confirmed' })] }),
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /complete rotation/i }))

    expect(await screen.findByText('socket hang up')).toBeTruthy()
  })

  describe('43-18: abandon a staged rotation', () => {
    function renderStaged(orgRole: LoadedData['orgRole'] = 'admin', status = 'staged') {
      return render(RotationDetailPage, {
        props: {
          data: baseData({
            orgRole,
            rotation: makeRotation({ status: status as RotationDetail['status'] }),
          }),
        },
      })
    }
    const openConfirm = async () => {
      await fireEvent.click(screen.getByRole('button', { name: /abandon rotation/i }))
    }
    const confirm = () => screen.getByRole('button', { name: /abandon anyway/i })
    const apiError = (status: number, code: string) =>
      new ApiClientError(status, { code, message: code }, code)
    const submitAbandon = async () => {
      renderStaged()
      await openConfirm()
      await fireEvent.click(confirm())
    }

    it('AC-1: admin sees Abandon next to Promote, without the stale-recovery banner', () => {
      renderStaged()

      expect(screen.getByRole('button', { name: /abandon rotation/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^promote$/i })).toBeTruthy()
      expect(screen.queryByText(/inactive for too long/i)).toBeNull()
      expect(screen.queryByRole('button', { name: /^resume$/i })).toBeNull()
    })

    it.each(['member', 'viewer'] as const)('AC-1/AC-9: %s has no Abandon in the DOM', (role) => {
      renderStaged(role)

      expect(screen.queryByRole('button', { name: /abandon/i })).toBeNull()
      expect(screen.queryByRole('heading', { name: /abandon/i })).toBeNull()
    })

    it.each(['in_progress', 'promoted', 'completed', 'retired', 'abandoned'])(
      'AC-2: %s offers no Abandon',
      (status) => {
        renderStaged('admin', status)

        expect(screen.queryByRole('button', { name: /abandon/i })).toBeNull()
      }
    )

    it('AC-3: Cancel closes the confirm panel with no API call; confirm copy is staged-specific', async () => {
      renderStaged()
      await openConfirm()

      expect(screen.getByText(/staged \(new\) value is discarded/i)).toBeTruthy()
      expect(screen.queryByText(/inactiv/i)).toBeNull()
      expect(abandonRotationMock).not.toHaveBeenCalled()

      await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

      expect(abandonRotationMock).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /abandon rotation/i })).toBeTruthy()
    })

    it('AC-3: double-click on Abandon anyway posts once', async () => {
      abandonRotationMock.mockReturnValue(new Promise(() => {}))
      await submitAbandon()
      await fireEvent.click(confirm())

      expect(abandonRotationMock).toHaveBeenCalledTimes(1)
      expect(abandonRotationMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        rotationId
      )
    })

    it('AC-4: success shows the abandoned message and removes Promote/Abandon', async () => {
      abandonRotationMock.mockResolvedValue(makeRotation({ status: 'abandoned' }))
      getRotationMock.mockResolvedValue(makeRotation({ status: 'abandoned' }))
      await submitAbandon()

      expect(await screen.findByText(/This rotation was abandoned/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^promote$/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /abandon/i })).toBeNull()
      await waitFor(() => expect(getRotationMock).toHaveBeenCalled())
    })

    it('AC-9: success does not depend on the follow-up refetch', async () => {
      abandonRotationMock.mockResolvedValue(makeRotation({ status: 'abandoned' }))
      getRotationMock.mockRejectedValue(apiError(503, 'vault_sealed'))
      await submitAbandon()

      expect(await screen.findByText(/This rotation was abandoned/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^promote$/i })).toBeNull()
    })

    it('AC-9: a revealed staged value is cleared on abandon', async () => {
      getStagedValueMock.mockResolvedValue({ value: 'super-secret-new-value' })
      abandonRotationMock.mockResolvedValue(makeRotation({ status: 'abandoned' }))
      getRotationMock.mockResolvedValue(makeRotation({ status: 'abandoned' }))
      renderStaged()
      await fireEvent.click(screen.getByRole('button', { name: /reveal staged value/i }))
      expect(await screen.findByText('super-secret-new-value')).toBeTruthy()

      await openConfirm()
      await fireEvent.click(confirm())

      expect(await screen.findByText(/This rotation was abandoned/i)).toBeTruthy()
      expect(screen.queryByText('super-secret-new-value')).toBeNull()
    })

    it('AC-9: Promote is disabled while the abandon request is in flight', async () => {
      abandonRotationMock.mockReturnValue(new Promise(() => {}))
      await submitAbandon()

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^promote$/i }).hasAttribute('disabled')).toBe(
          true
        )
      )
      expect(confirm().hasAttribute('disabled')).toBe(true)
    })

    it('AC-9: a poll that flips the status away from staged unmounts the open confirm panel', async () => {
      vi.useFakeTimers()
      getRotationMock.mockResolvedValue(makeRotation({ status: 'promoted' }))
      renderStaged()
      await openConfirm()
      expect(screen.queryByRole('button', { name: /abandon anyway/i })).not.toBeNull()

      await vi.advanceTimersByTimeAsync(15000)

      expect(screen.queryByRole('button', { name: /abandon anyway/i })).toBeNull()
      expect(screen.getByRole('button', { name: /retire old value/i })).toBeTruthy()
      expect(abandonRotationMock).not.toHaveBeenCalled()
    })

    it('AC-5: 409 concurrent_modification refetches without an inline error', async () => {
      abandonRotationMock.mockRejectedValue(apiError(409, 'concurrent_modification'))
      getRotationMock.mockResolvedValue(makeRotation({ status: 'staged' }))
      await submitAbandon()

      await waitFor(() => expect(getRotationMock).toHaveBeenCalledTimes(1))
      expect(screen.queryByText(/could not abandon/i)).toBeNull()
    })

    it('AC-5: 422 rotation_not_stale shows a message and closes the panel', async () => {
      abandonRotationMock.mockRejectedValue(apiError(422, 'rotation_not_stale'))
      await submitAbandon()

      expect(await screen.findByText(/no longer awaiting a decision/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /abandon anyway/i })).toBeNull()
    })

    it('AC-5: 409 rotation_not_abandonable_after_promotion closes the panel and refetches into Retire', async () => {
      abandonRotationMock.mockRejectedValue(
        apiError(409, 'rotation_not_abandonable_after_promotion')
      )
      getRotationMock.mockResolvedValue(makeRotation({ status: 'promoted' }))
      await submitAbandon()

      await waitFor(() => expect(getRotationMock).toHaveBeenCalledTimes(1))
      expect(await screen.findByRole('button', { name: /retire old value/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /abandon anyway/i })).toBeNull()
    })

    it('AC-5: 409 rotation_not_abandonable_after_promotion tells the admin to Retire when the refetch fails', async () => {
      abandonRotationMock.mockRejectedValue(
        apiError(409, 'rotation_not_abandonable_after_promotion')
      )
      getRotationMock.mockRejectedValue(new Error('offline'))
      await submitAbandon()

      expect(await screen.findByText(/already promoted.*retire/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /abandon anyway/i })).toBeNull()
    })

    it('AC-5: 403 mfa_required keeps the confirm panel open', async () => {
      abandonRotationMock.mockRejectedValue(apiError(403, 'mfa_required'))
      await submitAbandon()

      expect(await screen.findByText(/Enable MFA to abandon this rotation/i)).toBeTruthy()
      expect(confirm()).toBeTruthy()
    })

    it('AC-5: 503 sealed keeps the confirm panel open', async () => {
      abandonRotationMock.mockRejectedValue(apiError(503, 'vault_sealed'))
      await submitAbandon()

      await waitFor(() => expect(abandonRotationMock).toHaveBeenCalled())
      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(confirm()).toBeTruthy()
    })

    it('AC-5: 429 shows the retry seconds and keeps the panel open', async () => {
      abandonRotationMock.mockRejectedValue(
        new ApiClientError(
          429,
          { code: 'rate_limit_exceeded', message: 'slow down', retryAfter: 17 },
          'slow down'
        )
      )
      await submitAbandon()

      expect(await screen.findByText(/17 seconds/i)).toBeTruthy()
      expect(confirm()).toBeTruthy()
    })

    it('AC-5: a non-Error rejection shows the generic message and keeps the panel open', async () => {
      abandonRotationMock.mockRejectedValue('offline')
      await submitAbandon()

      expect(await screen.findByText('Could not abandon rotation.')).toBeTruthy()
      expect(confirm()).toBeTruthy()
    })
  })
})
