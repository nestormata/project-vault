import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb, type Tx } from '@project-vault/db'
import {
  handoffPendingStates,
  handoffTokenJti,
  platformSecurityEvents,
} from '@project-vault/db/schema'
import { count, desc, eq, sql } from 'drizzle-orm'
import { HandoffEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  parseSetCookies,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createLinkedHandoffOrg,
  HANDOFF_TEST_INSTANCE_ID,
  HANDOFF_TEST_KID,
  handoffTestPublicKeyPem,
  signToken,
} from '../../__tests__/helpers/handoff-test-helpers.js'
import * as seam from './handoff-claim-exchange-db.js'

/**
 * Story 60.5: the claim exchange's burn (`INSERT INTO handoff_token_jti`) and cookie re-key
 * (`UPDATE handoff_pending_states`) commit or roll back together. Every test here runs against
 * real Postgres: the burn really executes and is really rolled back. Failures are injected
 * deterministically through the seam module (Design Decision 2), which receives the real `tx`.
 */

vi.mock('./handoff-claim-exchange-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof seam>()
  return {
    ...actual,
    findPendingForClaim: vi.fn(actual.findPendingForClaim),
    rekeyPendingCookieHash: vi.fn(actual.rekeyPendingCookieHash),
  }
})

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

process.env['VAULT_HANDOFF_ENABLED'] = 'true'
process.env['VAULT_HANDOFF_INSTANCE_ID'] = HANDOFF_TEST_INSTANCE_ID
process.env['VAULT_HANDOFF_VERIFY_KEYS'] = JSON.stringify([
  { kid: HANDOFF_TEST_KID, publicKeyPem: handoffTestPublicKeyPem },
])

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
// Imported after the bootstrap: it reads env at module load.
const { hashCookieValue } = await import('../../lib/opaque-cookie-token.js')
const actualSeam = await vi.importActual<typeof seam>('./handoff-claim-exchange-db.js')
const rekeySpy = vi.mocked(seam.rekeyPendingCookieHash)
const findSpy = vi.mocked(seam.findPendingForClaim)

const PREPARE_URL = '/api/v1/auth/handoff/prepare'
const CONFIRM_URL = '/api/v1/auth/handoff/confirm'
const EXCHANGE_CLAIM_URL = '/api/v1/auth/handoff/exchange-claim'
const HANDOFF_COOKIE_NAME = 'handoff-confirm'
const GENERIC_REJECTION_BODY = {
  code: 'handoff_rejected',
  message: 'Sign-in could not be verified. Please start again.',
}
const RACE_TEST_TIMEOUT_MS = 15_000

type App = Awaited<ReturnType<typeof createApp>>
type Prepared = { pendingId: string; claim: string; prepareCookie: string }
type ExchangeBody = { data: { rawCookieValue: string; expiresAt: string } }

const createdClaims: string[] = []
const createdPendingIds: string[] = []
let openApp: App | undefined

async function newApp(): Promise<App> {
  // Task 2.4b: a fresh app per test — the rate-limit store is in-memory per app instance.
  openApp = await createApp({ logger: false })
  return openApp
}

async function prepare(app: App, claimOverrides: Record<string, unknown> = {}): Promise<Prepared> {
  const res = await app.inject({
    method: 'POST',
    url: PREPARE_URL,
    payload: { token: signToken(claimOverrides) },
  })
  expect(res.statusCode).toBe(200)
  const { pendingId, claim } = res.json<{ data: { pendingId: string; claim: string } }>().data
  const prepareCookie = new Map(Object.entries(parseSetCookies(res.headers['set-cookie']))).get(
    HANDOFF_COOKIE_NAME
  )
  if (!prepareCookie) throw new Error('expected the prepare-set handoff cookie')
  createdClaims.push(claim)
  createdPendingIds.push(pendingId)
  return { pendingId, claim, prepareCookie }
}

async function prepareLinked(app: App, label: string): Promise<Prepared & { orgId: string }> {
  const workosUserId = `user_${randomUUID()}`
  const cmOrgId = `org_synthetic_${randomUUID()}`
  const { orgId } = await createLinkedHandoffOrg(label, workosUserId, cmOrgId)
  const prepared = await prepare(app, { workosUserId, organizationId: cmOrgId })
  return { ...prepared, orgId }
}

function exchange(app: App, { pendingId, claim }: Prepared) {
  return app.inject({ method: 'POST', url: EXCHANGE_CLAIM_URL, payload: { pendingId, claim } })
}

function confirm(app: App, rawCookie: string) {
  return app.inject({
    method: 'POST',
    url: CONFIRM_URL,
    headers: { cookie: `${HANDOFF_COOKIE_NAME}=${rawCookie}`, 'sec-fetch-site': 'same-origin' },
  })
}

function claimBurnKey(claim: string): string {
  return `claim:${hashCookieValue(claim)}`
}

async function burnRowCount(claim: string, db: Pick<Tx, 'select'> = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(handoffTokenJti)
    .where(eq(handoffTokenJti.jti, claimBurnKey(claim)))
  return row?.n ?? 0
}

async function pendingCookieHash(pendingId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ cookieHash: handoffPendingStates.cookieHash })
    .from(handoffPendingStates)
    .where(eq(handoffPendingStates.id, pendingId))
  return row?.cookieHash
}

/** Task 2.4a: platform_security_events rows carry no request id, so assert per-type deltas. */
async function eventCounts(): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ eventType: platformSecurityEvents.eventType, n: count() })
    .from(platformSecurityEvents)
    .groupBy(platformSecurityEvents.eventType)
  return new Map(rows.map((r) => [r.eventType, r.n]))
}

/** Non-zero `handoff_*` event-count deltas since `before`, as a plain object for assertions. */
async function eventDeltaSince(before: Map<string, number>): Promise<Record<string, number>> {
  const after = await eventCounts()
  const delta = new Map<string, number>()
  for (const [type, n] of after) {
    const diff = n - (before.get(type) ?? 0)
    if (diff !== 0 && type.startsWith('handoff_')) delta.set(type, diff)
  }
  return Object.fromEntries(delta)
}

/** The body of a plain lookup-miss replay — every rollback 401 must be byte-identical to it. */
async function plainReplayBody(app: App): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: EXCHANGE_CLAIM_URL,
    payload: { pendingId: `missing-${randomUUID()}`, claim: `missing-${randomUUID()}` },
  })
  expect(res.statusCode).toBe(401)
  return res.json()
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Polls pg_stat_activity until some backend is blocked by `holderPid` — request A's own
 * transaction, which holds the uncommitted burn PK row. Scoped to A's pid so an unrelated lock
 * waiter (e.g. another package's concurrency test on the same database) cannot satisfy the poll
 * and silently turn 4.2 into a sequential test. Fails loudly on timeout.
 */
async function waitForWaiterBlockedBy(holderPid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await getDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`
    )
    if ((rows[0]?.n ?? 0) > 0) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(
    'request B never blocked on the burn PK lock held by request A — the race was not exercised concurrently'
  )
}

describe('POST /exchange-claim atomicity (Story 60.5)', () => {
  beforeAll(async () => {
    const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
    await resetVaultForTest()
    await initVaultForTest(initVault, 'handoff-claim-atomicity-test-passphrase')
  })

  afterEach(async () => {
    rekeySpy.mockReset()
    rekeySpy.mockImplementation(actualSeam.rekeyPendingCookieHash)
    findSpy.mockReset()
    findSpy.mockImplementation(actualSeam.findPendingForClaim)
    await openApp?.close()
    openApp = undefined
    // B9: delete only the rows this test created — never a blanket DELETE.
    for (const claim of createdClaims.splice(0)) {
      await getDb()
        .delete(handoffTokenJti)
        .where(eq(handoffTokenJti.jti, claimBurnKey(claim)))
    }
    for (const pendingId of createdPendingIds.splice(0)) {
      await getDb().delete(handoffPendingStates).where(eq(handoffPendingStates.id, pendingId))
    }
  })

  describe('AC1 — burn and re-key in one transaction', () => {
    it('1.1/3.3: happy path burns once, re-keys exactly one row to the returned cookie, writes no event', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      const before = await eventCounts()

      const res = await exchange(app, prepared)

      expect(res.statusCode).toBe(200)
      const { rawCookieValue, expiresAt } = res.json<ExchangeBody>().data
      expect(rawCookieValue).toBeTruthy()
      expect(expiresAt).toBeTruthy()
      expect(await burnRowCount(prepared.claim)).toBe(1)
      expect(await pendingCookieHash(prepared.pendingId)).toBe(hashCookieValue(rawCookieValue))
      expect(rekeySpy).toHaveBeenCalledTimes(1)
      await expect(rekeySpy.mock.results[0]?.value).resolves.toBe(1)
      expect(await eventDeltaSince(before)).toStrictEqual({})
    })

    it('1.2: the exchanged cookie completes /confirm to a real session', async () => {
      const app = await newApp()
      const prepared = await prepareLinked(app, 'atomic-happy')
      const res = await exchange(app, prepared)
      expect(res.statusCode).toBe(200)

      const confirmRes = await confirm(app, res.json<ExchangeBody>().data.rawCookieValue)
      expect(confirmRes.statusCode).toBe(200)
      expect(confirmRes.json<{ data: { orgId: string } }>().data.orgId).toBe(prepared.orgId)
    })

    it('1.3: after a successful exchange the prepare-set cookie no longer confirms (re-key supersedes it)', async () => {
      const app = await newApp()
      const prepared = await prepareLinked(app, 'atomic-orig-cookie')
      expect((await exchange(app, prepared)).statusCode).toBe(200)
      const before = await eventCounts()

      const confirmRes = await confirm(app, prepared.prepareCookie)

      expect(confirmRes.statusCode).toBe(401)
      expect(confirmRes.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
    })

    it('1.4: an unknown pendingId never opens the transaction and writes nothing', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      const before = await eventCounts()

      const res = await exchange(app, { ...prepared, pendingId: `unknown-${randomUUID()}` })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(rekeySpy).not.toHaveBeenCalled()
      expect(await burnRowCount(prepared.claim)).toBe(0)
      expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
    })

    it('1.5: the re-key receives the transaction holding the (still uncommitted) burn', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      const seen: { viaTx?: number; viaPool?: number } = {}
      rekeySpy.mockImplementationOnce(async (tx, args) => {
        seen.viaTx = await burnRowCount(prepared.claim, tx)
        seen.viaPool = await burnRowCount(prepared.claim, getDb())
        return actualSeam.rekeyPendingCookieHash(tx, args)
      })

      const res = await exchange(app, prepared)

      expect(res.statusCode).toBe(200)
      expect(seen).toStrictEqual({ viaTx: 1, viaPool: 0 })
      expect(await burnRowCount(prepared.claim)).toBe(1)
    })
  })

  describe('AC2 — a failure after the burn rolls the burn back, and a retry succeeds', () => {
    it('2.1/2.5/2.6: a real Postgres error inside the transaction rolls back burn and re-key; the retry confirms', async () => {
      const app = await newApp()
      const prepared = await prepareLinked(app, 'atomic-sqlerr')
      const replayBody = await plainReplayBody(app)
      const prepareTimeHash = await pendingCookieHash(prepared.pendingId)
      let attemptedHash: string | undefined
      rekeySpy.mockImplementationOnce(async (tx, args) => {
        attemptedHash = args.cookieHash
        await actualSeam.rekeyPendingCookieHash(tx, args)
        await tx.execute(sql`SELECT 1/0`)
        return 1
      })
      const before = await eventCounts()

      const first = await exchange(app, prepared)

      expect(first.statusCode).toBe(401)
      expect(first.json()).toStrictEqual(replayBody)
      expect(first.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(first.json()).not.toHaveProperty('data')
      expect(await eventDeltaSince(before)).toStrictEqual({
        [HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE]: 1,
      })
      expect(await burnRowCount(prepared.claim)).toBe(0)
      expect(attemptedHash).toBeTruthy()
      expect(await pendingCookieHash(prepared.pendingId)).toBe(prepareTimeHash)
      expect(await pendingCookieHash(prepared.pendingId)).not.toBe(attemptedHash)

      // 2.5: the event payload carries none of the exchange's secrets or identifiers.
      const [event] = await getDb()
        .select({ payload: platformSecurityEvents.payload })
        .from(platformSecurityEvents)
        .where(eq(platformSecurityEvents.eventType, HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE))
        .orderBy(desc(platformSecurityEvents.createdAt))
        .limit(1)
      const serialized = JSON.stringify(event?.payload ?? {})
      for (const forbidden of [
        prepared.claim,
        prepared.pendingId,
        hashCookieValue(prepared.claim),
        attemptedHash as string,
        '"claim"',
        '"rawClaim"',
        '"pendingId"',
        '"rawCookieValue"',
      ]) {
        expect(serialized).not.toContain(forbidden)
      }

      const retry = await exchange(app, prepared)
      expect(retry.statusCode).toBe(200)
      const { rawCookieValue } = retry.json<ExchangeBody>().data
      expect(await burnRowCount(prepared.claim)).toBe(1)
      const newHash = await pendingCookieHash(prepared.pendingId)
      expect(newHash).toBe(hashCookieValue(rawCookieValue))
      expect(newHash).not.toBe(attemptedHash)
      expect((await confirm(app, rawCookieValue)).statusCode).toBe(200)
    })

    it('2.2: a thrown JS error after the burn rolls back; the retry succeeds', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      rekeySpy.mockRejectedValueOnce(new Error('connection reset'))
      const before = await eventCounts()

      const first = await exchange(app, prepared)

      expect(first.statusCode).toBe(401)
      expect(first.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(await eventDeltaSince(before)).toStrictEqual({
        [HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE]: 1,
      })
      expect(await burnRowCount(prepared.claim)).toBe(0)

      const retry = await exchange(app, prepared)
      expect(retry.statusCode).toBe(200)
      expect(await burnRowCount(prepared.claim)).toBe(1)
    })

    it('2.3: failing twice, then succeeding — the burn is absent after each failure', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      rekeySpy
        .mockRejectedValueOnce(new Error('first blip'))
        .mockRejectedValueOnce(new Error('second blip'))

      const first = await exchange(app, prepared)
      expect(first.statusCode).toBe(401)
      expect(await burnRowCount(prepared.claim)).toBe(0)
      const second = await exchange(app, prepared)
      expect(second.statusCode).toBe(401)
      expect(await burnRowCount(prepared.claim)).toBe(0)
      const third = await exchange(app, prepared)
      expect(third.statusCode).toBe(200)
      expect(await burnRowCount(prepared.claim)).toBe(1)
    })

    it('2.4: a retry after the pending row expired is still a replay (expiry wins)', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      rekeySpy.mockRejectedValueOnce(new Error('blip'))
      expect((await exchange(app, prepared)).statusCode).toBe(401)
      await getDb()
        .update(handoffPendingStates)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(handoffPendingStates.id, prepared.pendingId))
      const before = await eventCounts()

      const retry = await exchange(app, prepared)

      expect(retry.statusCode).toBe(401)
      expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
      expect(await burnRowCount(prepared.claim)).toBe(0)
      expect(rekeySpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('AC3 — the re-key must hit exactly one row', () => {
    it('3.1/3.2: a row pruned mid-exchange rolls the burn back and is a replay; the retry misses the lookup', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      rekeySpy.mockImplementationOnce(async (tx, args) => {
        // Separate pool connection — the sweeper's view of the world.
        await getDb()
          .delete(handoffPendingStates)
          .where(eq(handoffPendingStates.id, prepared.pendingId))
        return actualSeam.rekeyPendingCookieHash(tx, args)
      })
      const before = await eventCounts()

      const first = await exchange(app, prepared)

      expect(first.statusCode).toBe(401)
      expect(first.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(first.json()).not.toHaveProperty('data')
      expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
      expect(await burnRowCount(prepared.claim)).toBe(0)

      const beforeRetry = await eventCounts()
      const retry = await exchange(app, prepared)
      expect(retry.statusCode).toBe(401)
      expect(await eventDeltaSince(beforeRetry)).toStrictEqual({
        [HandoffEvent.HANDOFF_REPLAY]: 1,
      })
      expect(rekeySpy).toHaveBeenCalledTimes(1)
      expect(await burnRowCount(prepared.claim)).toBe(0)
    })
  })

  describe('AC3b — every DB failure on this path lands in the generic rejection', () => {
    it('3b.1: a lookup outage is the generic 401 with replay-store-unavailable, never a 5xx', async () => {
      const app = await newApp()
      const prepared = await prepare(app)
      findSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const before = await eventCounts()

      const res = await exchange(app, prepared)

      expect(res.statusCode).toBe(401)
      expect(res.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(rekeySpy).not.toHaveBeenCalled()
      expect(await eventDeltaSince(before)).toStrictEqual({
        [HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE]: 1,
      })
      expect(await burnRowCount(prepared.claim)).toBe(0)
    })
  })

  describe('AC4 — concurrent exchanges of the same claim', () => {
    it(
      '4.1: racing two exchanges of one claim — exactly one wins, the loser sees replay (10 iterations)',
      async () => {
        const app = await newApp()
        for (let i = 0; i < 10; i++) {
          const prepared = await prepare(app)
          const before = await eventCounts()

          const results = await Promise.all([exchange(app, prepared), exchange(app, prepared)])

          expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toStrictEqual([200, 401])
          const winner = results.find((r) => r.statusCode === 200)
          const winnerCookie = winner?.json<ExchangeBody>().data.rawCookieValue ?? ''
          expect(await burnRowCount(prepared.claim)).toBe(1)
          expect(await pendingCookieHash(prepared.pendingId)).toBe(hashCookieValue(winnerCookie))
          expect(await eventDeltaSince(before)).toStrictEqual({
            [HandoffEvent.HANDOFF_REPLAY]: 1,
          })
        }
      },
      RACE_TEST_TIMEOUT_MS
    )

    it(
      '4.1/4.3: the race winner confirms; a third exchange of the same pair is a replay',
      async () => {
        const app = await newApp()
        const prepared = await prepareLinked(app, 'atomic-race')
        const results = await Promise.all([exchange(app, prepared), exchange(app, prepared)])
        const winner = results.find((r) => r.statusCode === 200)
        expect(winner).toBeDefined()
        const winnerCookie = winner?.json<ExchangeBody>().data.rawCookieValue ?? ''
        expect((await confirm(app, winnerCookie)).statusCode).toBe(200)

        const before = await eventCounts()
        const third = await exchange(app, prepared)
        expect(third.statusCode).toBe(401)
        expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
      },
      RACE_TEST_TIMEOUT_MS
    )

    it(
      '4.2/B8: when the burn holder rolls back, the request waiting on its PK lock succeeds',
      async () => {
        const app = await newApp()
        const prepared = await prepareLinked(app, 'atomic-rollback-race')
        const aReachedSeam = deferred<number>()
        const releaseA = deferred()
        rekeySpy.mockImplementationOnce(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
          aReachedSeam.resolve(Number(row?.pid))
          await releaseA.promise
          return 1
        })
        const before = await eventCounts()

        const pA = exchange(app, prepared)
        const aPid = await aReachedSeam.promise
        const pB = exchange(app, prepared)
        await waitForWaiterBlockedBy(aPid)
        releaseA.reject(new Error('injected'))
        const [resA, resB] = await Promise.all([pA, pB])

        expect(resA.statusCode).toBe(401)
        expect(resA.json()).toStrictEqual(GENERIC_REJECTION_BODY)
        expect(resB.statusCode).toBe(200)
        expect(await eventDeltaSince(before)).toStrictEqual({
          [HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE]: 1,
        })
        const bCookie = resB.json<ExchangeBody>().data.rawCookieValue
        expect(await burnRowCount(prepared.claim)).toBe(1)
        expect(await pendingCookieHash(prepared.pendingId)).toBe(hashCookieValue(bCookie))
        expect((await confirm(app, bCookie)).statusCode).toBe(200)
      },
      RACE_TEST_TIMEOUT_MS
    )

    it(
      '4.4: exchanges of two different claims in parallel both succeed',
      async () => {
        const app = await newApp()
        const first = await prepare(app)
        const second = await prepare(app)

        const results = await Promise.all([exchange(app, first), exchange(app, second)])

        expect(results.map((r) => r.statusCode)).toStrictEqual([200, 200])
        expect(await burnRowCount(first.claim)).toBe(1)
        expect(await burnRowCount(second.claim)).toBe(1)
      },
      RACE_TEST_TIMEOUT_MS
    )
  })

  describe('B5 — exchange after a successful confirm', () => {
    it('the claim is still unused (200), but the new cookie cannot mint a second session', async () => {
      const app = await newApp()
      const prepared = await prepareLinked(app, 'atomic-after-confirm')
      expect((await confirm(app, prepared.prepareCookie)).statusCode).toBe(200)

      const res = await exchange(app, prepared)
      expect(res.statusCode).toBe(200)
      const before = await eventCounts()

      const second = await confirm(app, res.json<ExchangeBody>().data.rawCookieValue)
      expect(second.statusCode).toBe(401)
      expect(second.json()).toStrictEqual(GENERIC_REJECTION_BODY)
      expect(await eventDeltaSince(before)).toStrictEqual({ [HandoffEvent.HANDOFF_REPLAY]: 1 })
    })
  })
})
