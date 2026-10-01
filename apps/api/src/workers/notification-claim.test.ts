import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimPendingNotificationEntry,
  markNotificationSendStarted,
  releaseNotificationClaim,
} from './notification-queue-ops.js'
import { withClaimedNotification } from './notification-claim.js'

// Story 70.1 AC2/AC5/AC9 — withClaimedNotification's release/no-release decisions, unit-level:
// the queue ops are mocked so a release failure can be forced deterministically.

vi.mock('./notification-queue-ops.js', () => ({
  claimPendingNotificationEntry: vi.fn(),
  releaseNotificationClaim: vi.fn(),
  markNotificationSendStarted: vi.fn(),
}))

const QUEUE_ID = randomUUID()
const ORG_ID = randomUUID()
const RECIPIENT = 'secret-recipient@example.com'
const SUBJECT = 'Top secret subject line'

function claimedRow(attemptCount = 1) {
  return {
    id: QUEUE_ID,
    orgId: ORG_ID,
    attemptCount,
    recipientEmail: RECIPIENT,
    payload: { subject: SUBJECT },
  } as unknown as NonNullable<Awaited<ReturnType<typeof claimPendingNotificationEntry>>>
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

afterEach(() => {
  vi.mocked(claimPendingNotificationEntry).mockReset()
  vi.mocked(releaseNotificationClaim).mockReset()
  vi.mocked(markNotificationSendStarted).mockReset()
})

describe('withClaimedNotification (Story 70.1)', () => {
  it('does not call fn when the claim is lost', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(null)
    const fn = vi.fn()

    await withClaimedNotification(QUEUE_ID, ORG_ID, fn)

    expect(fn).not.toHaveBeenCalled()
    expect(releaseNotificationClaim).not.toHaveBeenCalled()
  })

  it('success path does not release', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow())
    await withClaimedNotification(QUEUE_ID, ORG_ID, async () => undefined)
    expect(releaseNotificationClaim).not.toHaveBeenCalled()
  })

  it('a throw before any send releases (fenced on this attempt) and rethrows the original error', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow(3))
    const original = new Error('render failed')

    await expect(
      withClaimedNotification(QUEUE_ID, ORG_ID, async () => {
        throw original
      })
    ).rejects.toBe(original)

    expect(releaseNotificationClaim).toHaveBeenCalledWith(QUEUE_ID, ORG_ID, 3)
  })

  it('a send that throws is a definite failure: release, rethrow', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow(2))
    const original = new Error('provider unavailable')

    await expect(
      withClaimedNotification(QUEUE_ID, ORG_ID, async (_entry, claim) => {
        await claim.externalSend(async () => {
          throw original
        })
      })
    ).rejects.toBe(original)

    expect(markNotificationSendStarted).toHaveBeenCalledWith(QUEUE_ID, ORG_ID, 2)
    expect(releaseNotificationClaim).toHaveBeenCalledWith(QUEUE_ID, ORG_ID, 2)
  })

  it('a throw after the send resolved does NOT release (outcome unknown, never re-sent)', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow())
    const original = new Error('commit failed')

    await expect(
      withClaimedNotification(QUEUE_ID, ORG_ID, async (_entry, claim) => {
        await claim.externalSend(async () => 'ok')
        throw original
      })
    ).rejects.toBe(original)

    expect(releaseNotificationClaim).not.toHaveBeenCalled()
  })

  it('a lost lease at send-start never calls the send', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow())
    vi.mocked(markNotificationSendStarted).mockRejectedValue(new Error('claim lost'))
    const send = vi.fn()

    await expect(
      withClaimedNotification(QUEUE_ID, ORG_ID, async (_entry, claim) => {
        await claim.externalSend(send)
      })
    ).rejects.toThrow('claim lost')

    expect(send).not.toHaveBeenCalled()
  })

  it('a failing release logs one recipient-free warn and still rethrows the original error', async () => {
    vi.mocked(claimPendingNotificationEntry).mockResolvedValue(claimedRow(4))
    vi.mocked(releaseNotificationClaim).mockRejectedValue(new Error('db down'))
    const original = new Error('provider unavailable')
    const logger = makeLogger()

    await expect(
      withClaimedNotification(
        QUEUE_ID,
        ORG_ID,
        async () => {
          throw original
        },
        logger
      )
    ).rejects.toBe(original)

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'notification.claim_release_failed',
      notificationQueueId: QUEUE_ID,
      attemptNumber: 4,
    })
    const serialized = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])
    expect(serialized).not.toContain(RECIPIENT)
    expect(serialized).not.toContain(SUBJECT)
  })
})
