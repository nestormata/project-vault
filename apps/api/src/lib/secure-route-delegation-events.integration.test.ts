import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { delegationAssertionJti, platformSecurityEvents } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'
import {
  counterDeltas,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  DELEGATION_TEST_KID,
  delegationCounterSamples,
  delegationTestVerifyKeysJsonFor,
  signDelegationAssertion,
  totalsByOutcome,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'
import {
  bootDelegatedApp,
  callDelegated,
  closeDelegatedApps,
  DELEGATED_ACTOR,
  DELEGATED_URL,
  type DelegatedCall,
} from '../__tests__/helpers/delegation-app-helpers.js'

/**
 * Story 71.9 AC-2 / AC-5 / AC-8 — the security-event surface of a rejected delegated assertion:
 * request-correlated, bounded by the per-kid limiter BEFORE any row is written, deadline-bound, and
 * never an audit row. Real `secureRoute` pipeline, real Postgres. Each limiter scenario owns one
 * configured kid (all share one test key), so no bucket starves another test.
 */

// Vite inlines `import.meta.glob` at transform time (no test code builds a filesystem path); this
// package has no `vite/client` types, so the one signature used here is declared locally.
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: string; import: string; eager: true }
    ): Record<string, string>
  }
}

const KID_CORRELATED = 'cm-deleg-test-corr'
const KID_SUPPRESSED = 'cm-deleg-test-suppressed'
const KID_BOUNDED = 'cm-deleg-test-bounded'
const KID_CONCURRENT = 'cm-deleg-test-concurrent'
const KIDS = [DELEGATION_TEST_KID, KID_CORRELATED, KID_SUPPRESSED, KID_BOUNDED, KID_CONCURRENT]

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJsonFor(KIDS)
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()

// Loaded only after the env above: these modules read env when they load.
const replayStore = await import('../modules/auth/delegation-replay-store.js')
const securityEventsModule = await import('../modules/auth/delegation-security-events.js')
const stages = await import('./delegation-stages.js')
const { enforceUserRateLimit } = await import('./route-helpers.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const WRONG_OP = 'POST /cm/other-operation'
const CLOSED_PAYLOAD_FIELDS = [
  'reason',
  'routeKey',
  'status',
  'orgId',
  'kid',
  'jtiHash',
  'requestId',
  'storeFailure',
]

let org: DelegationOrgFixture
let app: FastifyInstance
const logs = createLogCaptureStream()

beforeAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-events-test-passphrase')
  org = await createDelegationOrg('events')
  app = (await bootDelegatedApp({ logStream: logs.stream })).app
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  await closeDelegatedApps()
})

function send(options: Partial<DelegatedCall>) {
  return callDelegated(app, { org: org.cmOrgId, ...options })
}

type EventRow = { payload: Record<string, unknown> }

async function eventRows(reason: string, since: Date, kid?: string): Promise<EventRow[]> {
  const rows = await getDb()
    .select()
    .from(platformSecurityEvents)
    .where(
      sql`event_type = 'delegation_assertion_rejected' and created_at >= ${since.toISOString()}::timestamptz`
    )
  return rows
    .map((row) => ({ payload: row.payload as Record<string, unknown> }))
    .filter((row) => row.payload['reason'] === reason)
    .filter((row) => kid === undefined || row.payload['kid'] === kid)
}

/** Spends all but `leaveSlots` of a kid's per-kid pre-burn budget, as the verifier would. */
function drainKidBucket(kid: string, leaveSlots: number): void {
  const bucket = stages.delegationKidBucket(kid)
  const sink = { status: () => sink, header: () => sink, send: () => sink }
  const spend = stages.DELEGATION_PRE_BURN_LIMIT.max - leaveSlots
  for (let used = 0; used < spend; used += 1) {
    enforceUserRateLimit({ ...bucket, ...stages.DELEGATION_PRE_BURN_LIMIT, reply: sink as never })
  }
}

function expiredFor(kid: string) {
  const now = Math.floor(Date.now() / 1000)
  return { header: { kid }, claims: { iat: now - 200, exp: now - 150 } }
}

async function countersAround<T>(work: () => Promise<T>) {
  const before = totalsByOutcome(await delegationCounterSamples())
  const result = await work()
  const after = totalsByOutcome(await delegationCounterSamples())
  return { result, deltas: counterDeltas(before, after) }
}

/** Runs `fn` over `items` one after another (no parallelism, no await inside a loop). */
async function inSequence<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    results.push(await fn(item))
  }, Promise.resolve())
  return results
}

describe('Story 71.9 AC-2 — the payload is closed and carries the request id', () => {
  it('writes requestId, which joins the row to the structured log line of the same request', async () => {
    const since = new Date()
    const res = await send({ op: WRONG_OP, assertion: { header: { kid: KID_CORRELATED } } })
    expect(res.statusCode).toBe(403)
    const rows = await eventRows('operation_mismatch', since, KID_CORRELATED)
    expect(rows).toHaveLength(1)
    const payload = rows[0]?.payload ?? {}
    expect(payload).toMatchObject({
      reason: 'operation_mismatch',
      routeKey: `POST ${DELEGATED_URL}`,
      status: 403,
      kid: KID_CORRELATED,
      jtiHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      requestId: expect.any(String),
    })
    expect(Object.keys(payload).filter((key) => !CLOSED_PAYLOAD_FIELDS.includes(key))).toEqual([])
    const joined = parseCapturedLogLines(logs.lines).filter(
      (line) => line['reqId'] === payload['requestId']
    )
    expect(joined.length).toBeGreaterThan(0)
  })

  it('structurally cannot hold the assertion, header, actor subject, body or a secret', () => {
    const fields: Parameters<typeof securityEventsModule.writeDelegationSecurityEvent>[0] = {
      reason: 'expired',
      routeKey: 'POST /x',
      requestId: 'req-1',
      meta: { ipAddress: null, userAgent: null },
    }
    // The input type has no field for the raw assertion, header, `act.sub`, body or a key: adding
    // one makes this excess-property check fail to compile (typecheck is part of the gate).
    // @ts-expect-error — `assertion` is not a field of the event input
    const withAssertion: typeof fields = { ...fields, assertion: 'x' }
    expect(Object.keys(withAssertion)).toContain('assertion')
  })
})

describe('Story 71.9 AC-2 — the per-kid limiter runs before a post-signature event is written', () => {
  it('rejects with the typed code but writes no row, and logs the suppression, once the kid is over limit', async () => {
    drainKidBucket(KID_SUPPRESSED, 0)
    const since = new Date()
    const { result, deltas } = await countersAround(() =>
      send({ assertion: expiredFor(KID_SUPPRESSED) })
    )
    expect(result.statusCode).toBe(401)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'delegation_expired' })
    // Counted as its own outcome; NOT double counted as rate_limited_pre.
    expect(deltas).toEqual({ expired: 1 })
    expect(await eventRows('expired', since, KID_SUPPRESSED)).toHaveLength(0)
    const suppressed = parseCapturedLogLines(logs.lines).filter(
      (line) => line['eventType'] === 'delegation.event_suppressed'
    )
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]).toMatchObject({
      requestId: expect.any(String),
      routeKey: `POST ${DELEGATED_URL}`,
      outcome: 'expired',
      kid: KID_SUPPRESSED,
    })
  })

  it('writes at most the bucket of rows for a once-valid expired assertion replayed many times', async () => {
    drainKidBucket(KID_BOUNDED, 5)
    const since = new Date()
    const expired = signDelegationAssertion(
      { org: org.cmOrgId, sub: DELEGATED_ACTOR, op: `POST ${DELEGATED_URL}` },
      expiredFor(KID_BOUNDED)
    )
    const responses = await inSequence(
      Array.from({ length: 60 }, (_, i) => i),
      () => send({ token: expired })
    )
    expect(new Set(responses.map((res) => res.statusCode))).toEqual(new Set([401]))
    expect(
      new Set(responses.map((res) => (JSON.parse(res.body) as { code: string }).code))
    ).toEqual(new Set(['delegation_expired']))
    expect(await eventRows('expired', since, KID_BOUNDED)).toHaveLength(5)
  })

  it('bounds the rows for 20 simultaneous valid-signature expired assertions on one kid', async () => {
    drainKidBucket(KID_CONCURRENT, 5)
    const since = new Date()
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => send({ assertion: expiredFor(KID_CONCURRENT) }))
    )
    expect(responses.map((res) => res.statusCode)).toEqual(Array.from({ length: 20 }, () => 401))
    expect(await eventRows('expired', since, KID_CONCURRENT)).toHaveLength(5)
  })

  it('writes no row and does no database work for a pre-signature failure (Decision D-b, DW-539 item 3)', async () => {
    const since = new Date()
    const before = await getDb().select().from(platformSecurityEvents)
    const { deltas } = await countersAround(() => send({ assertion: { wrongKey: true } }))
    expect(deltas).toEqual({ signature_invalid: 1 })
    expect(await getDb().select().from(platformSecurityEvents)).toHaveLength(before.length)
    expect(await eventRows('signature_invalid', since)).toHaveLength(0)
  })
})

describe('Story 71.9 AC-2 — the event write has its own deadline and never changes the response', () => {
  it('answers the typed 4xx without waiting for a writer that never resolves, and logs the timeout', async () => {
    vi.spyOn(securityEventsModule, 'writeDelegationSecurityEvent').mockImplementationOnce(
      () => new Promise(() => undefined)
    )
    const started = Date.now()
    const { result, deltas } = await countersAround(() => send({ op: WRONG_OP }))
    const elapsed = Date.now() - started
    expect(result.statusCode).toBe(403)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'delegation_operation_mismatch' })
    expect(deltas).toEqual({ operation_mismatch: 1 })
    expect(elapsed).toBeGreaterThanOrEqual(stages.DELEGATION_EVENT_WRITE_DEADLINE_MS - 50)
    expect(elapsed).toBeLessThan(stages.DELEGATION_EVENT_WRITE_DEADLINE_MS + 2000)
    const timeouts = parseCapturedLogLines(logs.lines).filter(
      (line) => line['eventType'] === 'delegation.security_event_timeout'
    )
    expect(timeouts.at(-1)).toMatchObject({
      requestId: expect.any(String),
      routeKey: `POST ${DELEGATED_URL}`,
      outcome: 'operation_mismatch',
    })
  }, 15_000)

  it('keeps counting and answering when the event writer rejects (the store is down too)', async () => {
    vi.spyOn(securityEventsModule, 'writeDelegationSecurityEvent').mockRejectedValueOnce(
      new Error('event-write-failure-sentinel')
    )
    const { result, deltas } = await countersAround(() => send({ op: WRONG_OP }))
    expect(result.statusCode).toBe(403)
    expect(result.body).not.toContain('event-write-failure-sentinel')
    expect(deltas).toEqual({ operation_mismatch: 1 })
  })
})

describe('Story 71.9 AC-5 — a store_unavailable event carries a closed storeFailure', () => {
  async function storeFailureOf(burn: () => Promise<unknown>): Promise<unknown> {
    vi.spyOn(replayStore, 'burnDelegationAssertion').mockImplementationOnce(burn as never)
    const since = new Date()
    const res = await send({ sub: `user_${randomUUID()}` })
    expect(res.statusCode).toBe(503)
    const rows = await eventRows('store_unavailable', since)
    expect(rows).toHaveLength(1)
    return rows[0]?.payload['storeFailure']
  }

  it('records sqlstate:<code> for a real SQLSTATE such as 57P03', async () => {
    expect(
      await storeFailureOf(async () => ({ outcome: 'store_unavailable', sqlState: '57P03' }))
    ).toBe('sqlstate:57P03')
  })

  it('records driver_error when there is no real SQLSTATE', async () => {
    expect(
      await storeFailureOf(async () => ({ outcome: 'store_unavailable', sqlState: null }))
    ).toBe('driver_error')
  })

  it('records timeout when the request deadline fires, and never a sqlState label on the metric', async () => {
    expect(await storeFailureOf(() => new Promise(() => undefined))).toBe('timeout')
    const samples = await delegationCounterSamples()
    expect(
      samples.every((sample) => Object.keys(sample).sort().join() === 'kid,outcome,value')
    ).toBe(true)
  }, 15_000)
})

describe('Story 71.9 AC-8 — concurrency, audit separation and tenant isolation', () => {
  it('counts exactly one accepted and one replayed for two simultaneous presentations of one jti', async () => {
    const token = signDelegationAssertion({
      org: org.cmOrgId,
      sub: DELEGATED_ACTOR,
      op: `POST ${DELEGATED_URL}`,
    })
    const { result, deltas } = await countersAround(() =>
      Promise.all([send({ token }), send({ token })])
    )
    expect(result.map((res) => res.statusCode).sort()).toEqual([200, 409])
    expect(deltas).toEqual({ accepted: 1, replayed: 1, actor_unlinked: 1 })
  })

  it('never writes a rejection to audit_log_entries', async () => {
    const countAudit = () =>
      withOrg(org.orgId, async (tx) => {
        const rows = await (tx as Tx).execute(
          sql`select count(*)::int as n from audit_log_entries where org_id = ${org.orgId}`
        )
        return (Array.from(rows as never)[0] as { n: number }).n
      })
    const before = await countAudit()
    const replay = signDelegationAssertion({
      org: org.cmOrgId,
      sub: DELEGATED_ACTOR,
      op: `POST ${DELEGATED_URL}`,
    })
    await send({ token: replay })
    await send({ token: replay })
    await send({ op: WRONG_OP })
    await send({ assertion: expiredFor(DELEGATION_TEST_KID) })
    await send({ headers: { 'content-encoding': 'gzip' } })
    expect(await countAudit()).toBe(before)
  })

  it("carries org A's id only in A's rows, and org B's burn row is invisible to org A", async () => {
    const orgA = await createDelegationOrg('iso-a')
    const orgB = await createDelegationOrg('iso-b')
    const since = new Date()
    const tokenB = signDelegationAssertion({
      org: orgB.cmOrgId,
      sub: DELEGATED_ACTOR,
      op: `POST ${DELEGATED_URL}`,
    })
    const jtiB = JSON.parse(
      Buffer.from(tokenB.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as { jti: string }
    await callDelegated(app, { org: orgB.cmOrgId, token: tokenB })
    const tokenA = signDelegationAssertion({
      org: orgA.cmOrgId,
      sub: DELEGATED_ACTOR,
      op: `POST ${DELEGATED_URL}`,
    })
    await callDelegated(app, { org: orgA.cmOrgId, token: tokenA })
    await callDelegated(app, { org: orgA.cmOrgId, token: tokenA })
    const replayRows = await eventRows('replayed', since)
    expect(replayRows.map((row) => row.payload['orgId'])).toEqual([orgA.orgId])
    const visibleToA = await withOrg(orgA.orgId, async (tx) =>
      (tx as Tx)
        .select({ jti: delegationAssertionJti.jti })
        .from(delegationAssertionJti)
        .where(and(eq(delegationAssertionJti.jti, jtiB.jti)))
    )
    expect(visibleToA).toHaveLength(0)
  })

  it('has no application reader of platform_security_events (operator-only, no new route)', async () => {
    const sources = import.meta.glob(['../**/*.ts', '!../**/*.test.ts', '!../**/__tests__/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const entries = Object.entries(sources)
    expect(entries.length).toBeGreaterThan(50)
    const readers = entries
      .filter(([, text]) => /\.from\(\s*platformSecurityEvents\s*\)/.test(text))
      .map(([path]) => path)
    expect(readers).toEqual([])
  })
})
