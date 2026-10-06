import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'

/**
 * Story 65.4 AC4 (unit half): the deferred post-response write of an external share miss, with
 * the DB mocked. Covers what a real DB cannot show deterministically: a write that throws (DB
 * down) must not change the response, must be logged redacted and id-free, must never become an
 * unhandled rejection; the write runs under the resolved share's own org; and the shutdown drain is
 * bounded. The real-DB cap behaviour is in `external-miss-deferred-write.integration.test.ts`.
 */

const ORG_ID = randomUUID()
const SHARE_ID = randomUUID()

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@project-vault/db')>()),
  withOrg,
}))

const TOKEN = 'a-share-token'

const SHARE_ROW = {
  id: SHARE_ID,
  orgId: ORG_ID,
  credentialId: randomUUID(),
  recipientType: 'external',
  status: 'revoked',
  expiresAt: new Date(Date.now() + 3_600_000),
  revealAttemptCount: 0,
}

vi.mock('../../lib/db.js', () => ({
  getAdminDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([SHARE_ROW]) }) }),
    }),
  }),
}))

function readTx() {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([SHARE_ROW]) }) }),
    }),
  }
}

type ExternalServiceModule = typeof import('./external-service.js')

describe('external share deferred losing-attempt write (Story 65.4 AC4)', () => {
  let service: ExternalServiceModule
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  const unhandled = vi.fn()

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    process.on('unhandledRejection', unhandled)
    service = await import('./external-service.js')
  })

  afterEach(() => {
    process.off('unhandledRejection', unhandled)
    vi.useRealTimers()
  })

  it('answers the miss from the read; the write runs afterwards under the share org', async () => {
    withOrg
      .mockImplementationOnce((_org: string, fn: (tx: unknown) => unknown) => fn(readTx()))
      .mockImplementationOnce(() => Promise.resolve())

    await expect(service.revealExternalShare(TOKEN, logger)).resolves.toEqual({
      status: 'revoked',
    })
    await service.flushPendingLosingAttempts()

    expect(withOrg).toHaveBeenCalledTimes(2)
    expect(withOrg.mock.calls.map(([orgId]) => orgId)).toEqual([ORG_ID, ORG_ID])
  })

  it('a failing write leaves the response unchanged, is logged redacted without ids, and never rejects', async () => {
    withOrg
      .mockImplementationOnce((_org: string, fn: (tx: unknown) => unknown) => fn(readTx()))
      .mockRejectedValueOnce(new Error('connection refused'))

    const result = await service.revealExternalShare(TOKEN, logger)
    await expect(service.flushPendingLosingAttempts()).resolves.toBeUndefined()
    await new Promise((resolve) => setImmediate(resolve))

    expect(result).toEqual({ status: 'revoked' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [payload] = logger.error.mock.calls[0] as [Record<string, unknown>]
    expect(payload['eventType']).toBe(OperationalEvent.CREDENTIAL_SHARE_LOSING_ATTEMPT_WRITE_FAILED)
    const logged = JSON.stringify(payload)
    expect(logged).not.toContain(ORG_ID)
    expect(logged).not.toContain(SHARE_ID)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('a drizzle-shaped failure whose message embeds the bound ids never reaches the log', async () => {
    const queryError = Object.assign(
      new Error(
        `Failed query: update "credential_shares" where id = $1\nparams: ${SHARE_ID},${ORG_ID}`
      ),
      { cause: Object.assign(new Error('boom'), { code: '57P01' }) }
    )
    withOrg
      .mockImplementationOnce((_org: string, fn: (tx: unknown) => unknown) => fn(readTx()))
      .mockRejectedValueOnce(queryError)

    await service.revealExternalShare(TOKEN, logger)
    await service.flushPendingLosingAttempts()

    expect(logger.error).toHaveBeenCalledTimes(1)
    const [payload] = logger.error.mock.calls[0] as [Record<string, unknown>]
    const logged = JSON.stringify(payload)
    expect(logged).not.toContain(ORG_ID)
    expect(logged).not.toContain(SHARE_ID)
    expect(payload['errorCode']).toBe('57P01')
  })

  it('a failing write is dropped silently when no logger was supplied', async () => {
    withOrg
      .mockImplementationOnce((_org: string, fn: (tx: unknown) => unknown) => fn(readTx()))
      .mockRejectedValueOnce(new Error('db down'))

    await expect(service.revealExternalShare(TOKEN)).resolves.toEqual({ status: 'revoked' })
    await expect(service.flushPendingLosingAttempts()).resolves.toBeUndefined()
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('flush with a timeout is bounded: it resolves at the deadline while a write is stuck', async () => {
    vi.useFakeTimers()
    withOrg
      .mockImplementationOnce((_org: string, fn: (tx: unknown) => unknown) => fn(readTx()))
      .mockImplementationOnce(() => new Promise(() => undefined))

    await service.revealExternalShare(TOKEN, logger)

    let settled = false
    const flushed = service.flushPendingLosingAttempts(3000).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flushed
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flush with nothing pending resolves immediately', async () => {
    await expect(service.flushPendingLosingAttempts(50)).resolves.toBeUndefined()
  })

  it('an unknown token schedules nothing and touches no org transaction', async () => {
    // A different recipient type is the same "not found" outcome as no row at all.
    SHARE_ROW.recipientType = 'user'
    try {
      await expect(service.revealExternalShare(TOKEN, logger)).resolves.toEqual({
        status: 'not_found',
      })
    } finally {
      SHARE_ROW.recipientType = 'external'
    }
    expect(withOrg).not.toHaveBeenCalled()
  })
})
