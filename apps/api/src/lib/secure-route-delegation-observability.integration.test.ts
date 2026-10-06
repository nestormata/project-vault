import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { register } from 'prom-client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import {
  counterDeltas,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  DELEGATION_TEST_KID,
  delegationCounterSamples,
  delegationTestVerifyKeysJsonFor,
  linkDelegationActor,
  signDelegationAssertion,
  totalsByOutcome,
  type AssertionOptions,
  type DelegationCounterSample,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'
import {
  bootDelegatedApp,
  callDelegated,
  closeDelegatedApps,
  DELEGATED_ACTOR,
  DELEGATED_URL,
} from '../__tests__/helpers/delegation-app-helpers.js'

/**
 * Story 71.9 AC-1 / AC-7 — counter completeness and log hygiene through the real `secureRoute`
 * delegated pipeline, a real Postgres and the real replay store. Several configured kids share
 * one test key so a limiter bucket can be spent per kid without starving the other tests.
 */

const KID_LIMITED = 'cm-deleg-test-limited'
const KID_EXTRA = 'cm-deleg-test-extra'
const CONFIGURED_KIDS = [DELEGATION_TEST_KID, KID_LIMITED, KID_EXTRA]

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJsonFor(CONFIGURED_KIDS)
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()

// Loaded only after the env above: these modules read env when they load.
const verify = await import('../modules/auth/delegation-verify.js')
const metrics = await import('../modules/auth/delegation-metrics.js')
const replayStore = await import('../modules/auth/delegation-replay-store.js')
const stages = await import('./delegation-stages.js')
const { enforceUserRateLimit } = await import('./route-helpers.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

// Series as they stood right after the app modules loaded, before any request of this file.
const bootSamples = await delegationCounterSamples()

const SUBJECT_URL = '/cm/subject-events'
const HISTORICAL_URL = '/cm/historical-events'
const DAY = 86_400
const UNCONFIGURED_SIBLING = 'secure-route-delegation-unconfigured.integration.test.ts'
const NO_KID = 'none'

let org: DelegationOrgFixture
let app: FastifyInstance
// The app `send` talks to: the shared one, or a log-capturing one inside the AC-7 test.
let activeApp: FastifyInstance

beforeAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-observability-test-passphrase')
  org = await createDelegationOrg('obs')
  const booted = await bootDelegatedApp({
    routes: [
      { url: DELEGATED_URL },
      {
        url: SUBJECT_URL,
        security: { delegation: { subjectFields: { org: { in: 'body', name: 'orgRef' } } } },
        schema: { body: z.object({ orgRef: z.unknown().optional() }).passthrough() },
      },
      {
        url: HISTORICAL_URL,
        security: { delegation: { historicalActorPolicy: { maxAgeSeconds: 30 * DAY } } },
      },
    ],
  })
  app = booted.app
  activeApp = app
})

afterAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  await closeDelegatedApps()
})

function send(options: {
  url?: string
  sub?: string
  op?: string
  body?: unknown
  assertion?: AssertionOptions
  headers?: Record<string, string>
  authorization?: string | null
  token?: string
  cmOrg?: string
}) {
  return callDelegated(activeApp, { org: options.cmOrg ?? org.cmOrgId, ...options })
}

async function member(): Promise<string> {
  const sub = `user_${randomUUID()}`
  await linkDelegationActor(org.orgId, sub)
  return sub
}

async function nonMember(): Promise<string> {
  const sub = `user_${randomUUID()}`
  await linkDelegationActor(org.orgId, sub, { membership: 'deactivated' })
  return sub
}

/** Lets work that continues after the response was sent run before the counters are read. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function occurredAgo(ageSeconds: number): AssertionOptions {
  const now = Math.floor(Date.now() / 1000)
  return { claims: { occ: now - ageSeconds } }
}

type Row = {
  outcome: string
  /** Outcomes that also move on an admitted request (`accepted` rides on the actor outcomes). */
  alsoCounts?: string[]
  /** Work done BEFORE the counter snapshot (e.g. the first presentation of a replayed assertion). */
  prepare?: () => Promise<unknown>
  act: (prepared: unknown) => Promise<{ statusCode: number }>
  status: number
  kid?: string
}

const ROWS: Row[] = [
  {
    outcome: 'accepted',
    act: async () => send({ sub: await member() }),
    status: 200,
  },
  { outcome: 'missing', act: () => send({ authorization: null }), status: 401, kid: NO_KID },
  {
    outcome: 'oversized',
    act: () => send({ authorization: `PV-Delegation ${'a'.repeat(9 * 1024)}` }),
    status: 401,
    kid: NO_KID,
  },
  {
    outcome: 'malformed',
    act: () => send({ authorization: 'PV-Delegation not-a-jws' }),
    status: 401,
    kid: NO_KID,
  },
  {
    outcome: 'unexpected_alg',
    act: () => send({ assertion: { header: { alg: 'none' } } }),
    status: 401,
    kid: NO_KID,
  },
  {
    outcome: 'unknown_kid',
    act: () => send({ assertion: { header: { kid: 'some-unconfigured-kid' } } }),
    status: 401,
    kid: NO_KID,
  },
  {
    outcome: 'signature_invalid',
    act: () => send({ assertion: { wrongKey: true } }),
    status: 401,
    kid: NO_KID,
  },
  {
    outcome: 'malformed_claim',
    act: () => send({ assertion: { claims: { ver: 2 } } }),
    status: 401,
  },
  {
    outcome: 'expired',
    act: () => {
      const now = Math.floor(Date.now() / 1000)
      return send({ assertion: { claims: { iat: now - 200, exp: now - 150 } } })
    },
    status: 401,
  },
  {
    outcome: 'clock_skew',
    act: () => {
      const now = Math.floor(Date.now() / 1000)
      return send({ assertion: { claims: { iat: now + 300, exp: now + 330 } } })
    },
    status: 401,
  },
  {
    outcome: 'audience_mismatch',
    act: () => send({ assertion: { claims: { aud: 'pvd:another-instance' } } }),
    status: 421,
  },
  {
    outcome: 'operation_mismatch',
    act: () => send({ op: 'POST /cm/other-operation' }),
    status: 403,
  },
  {
    outcome: 'unsupported_encoding',
    act: () => send({ headers: { 'content-encoding': 'gzip' } }),
    status: 415,
  },
  {
    outcome: 'body_mismatch',
    act: () => {
      const token = signDelegationAssertion({
        org: org.cmOrgId,
        sub: DELEGATED_ACTOR,
        op: `POST ${DELEGATED_URL}`,
        body: JSON.stringify({ a: 1 }),
      })
      return send({ token, body: { a: 2 } })
    },
    status: 400,
  },
  {
    outcome: 'subject_mismatch',
    act: () => send({ url: SUBJECT_URL, body: { orgRef: `cm-org-${randomUUID()}` } }),
    status: 400,
  },
  {
    outcome: 'occurrence_outside_window',
    act: () => send({ assertion: occurredAgo(3600) }),
    status: 400,
  },
  {
    outcome: 'org_not_served',
    act: () => send({ cmOrg: `cm-org-${randomUUID()}` }),
    status: 421,
  },
  {
    // An UNLINKED actor: if a rejected burn did not stop the pipeline, the stray actor lookup
    // would also count `actor_unlinked` (and `accepted`) for a request that was answered 409.
    outcome: 'replayed',
    prepare: async () => {
      const token = signDelegationAssertion({
        org: org.cmOrgId,
        sub: DELEGATED_ACTOR,
        op: `POST ${DELEGATED_URL}`,
      })
      await send({ token })
      return token
    },
    act: (token) => send({ token: token as string }),
    status: 409,
  },
  {
    outcome: 'store_unavailable',
    act: () => {
      vi.spyOn(replayStore, 'burnDelegationAssertion').mockResolvedValueOnce({
        outcome: 'store_unavailable',
        sqlState: '57P03',
      })
      return send({})
    },
    status: 503,
  },
  {
    outcome: 'actor_not_member',
    act: async () => send({ sub: await nonMember() }),
    status: 403,
  },
  {
    outcome: 'actor_unlinked',
    alsoCounts: ['accepted'],
    act: () => send({ sub: `user_${randomUUID()}` }),
    status: 200,
  },
  {
    outcome: 'actor_attested_nonmember',
    alsoCounts: ['accepted'],
    act: async () =>
      send({ url: HISTORICAL_URL, sub: await nonMember(), assertion: occurredAgo(10) }),
    status: 200,
  },
  // Last: spends the whole per-kid bucket of its OWN kid, which no other row uses.
  {
    outcome: 'rate_limited_pre',
    act: () => {
      const bucket = stages.delegationKidBucket(KID_LIMITED)
      const sink = { status: () => sink, header: () => sink, send: () => sink }
      for (let used = 0; used < stages.DELEGATION_PRE_BURN_LIMIT.max; used += 1) {
        enforceUserRateLimit({
          ...bucket,
          ...stages.DELEGATION_PRE_BURN_LIMIT,
          reply: sink as never,
        })
      }
      return send({ assertion: { header: { kid: KID_LIMITED } } })
    },
    status: 429,
    kid: KID_LIMITED,
  },
]

// `not_configured` needs an app booted with an empty key set: a sibling suite owns it, because the
// key set is read once at module load. `not_yet_valid` is declared but unreachable (R21, 71-6): a
// future `iat` is `clock_skew`, so no request can produce it; its counter path is exercised
// directly below.
const COVERED_ELSEWHERE: Record<string, string> = {
  not_configured: UNCONFIGURED_SIBLING,
  not_yet_valid: 'delegation-verify.test.ts (R21: declared but unreachable)',
}

describe('Story 71.9 AC-1 — every outcome has exactly one counted code path', () => {
  it('has a row (or a named sibling suite) for every outcome in DELEGATION_OUTCOMES, and no stale row', () => {
    const covered = new Set([...ROWS.map((row) => row.outcome), ...Object.keys(COVERED_ELSEWHERE)])
    const unmapped = verify.DELEGATION_OUTCOMES.filter((outcome) => !covered.has(outcome))
    const stale = [...covered].filter((outcome) => !verify.DELEGATION_OUTCOMES.includes(outcome))
    expect({ unmapped, stale }).toEqual({ unmapped: [], stale: [] })
  })

  it.each(ROWS)(
    '$outcome moves exactly its own counter (status $status)',
    async ({ outcome, alsoCounts, prepare, act, status, kid }) => {
      const prepared = await prepare?.()
      const before = await delegationCounterSamples()
      const res = await act(prepared)
      await settle()
      const after = await delegationCounterSamples()
      expect(res.statusCode).toBe(status)
      expect(counterDeltas(totalsByOutcome(before), totalsByOutcome(after))).toEqual(
        Object.fromEntries([outcome, ...(alsoCounts ?? [])].map((name) => [name, 1]))
      )
      const labelled = after.find(
        (sample) =>
          sample.outcome === outcome &&
          sample.kid === (kid ?? DELEGATION_TEST_KID) &&
          sample.value > (before.find((b) => sameSeries(b, sample))?.value ?? 0)
      )
      expect(labelled).toBeDefined()
    }
  )

  it('counts the unreachable not_yet_valid outcome through the recorder (R21)', async () => {
    const before = totalsByOutcome(await delegationCounterSamples())
    metrics.recordDelegationOutcome('not_yet_valid', DELEGATION_TEST_KID)
    const after = totalsByOutcome(await delegationCounterSamples())
    expect(counterDeltas(before, after)).toEqual({ not_yet_valid: 1 })
    expect(verify.DELEGATION_REASON_TO_OUTCOME['delegation_not_yet_valid']).toBe('not_yet_valid')
  })

  it('documents which outcome rows ride on an admitted request, so a dashboard does not double count', () => {
    const admittedOnly = ROWS.filter((row) => row.alsoCounts?.includes('accepted')).map(
      (row) => row.outcome
    )
    expect(admittedOnly.sort()).toEqual(['actor_attested_nonmember', 'actor_unlinked'])
  })
})

function sameSeries(a: DelegationCounterSample, b: DelegationCounterSample): boolean {
  return a.outcome === b.outcome && a.kid === b.kid
}

describe('Story 71.9 AC-1 — malformed is never signature_invalid (DW-513 item 5)', () => {
  it('counts a pre-signature malformed token as malformed', async () => {
    const before = totalsByOutcome(await delegationCounterSamples())
    const res = await send({ authorization: 'PV-Delegation only.two' })
    const after = totalsByOutcome(await delegationCounterSamples())
    expect(res.statusCode).toBe(401)
    expect(counterDeltas(before, after)).toEqual({ malformed: 1 })
  })

  it.each([
    ['a payload that is a JSON array', '[1,2,3]'],
    ['a payload that is not JSON', '{not json'],
  ])(
    'counts a validly signed assertion with %s as malformed, not signature_invalid',
    async (_n, rawPayload) => {
      const before = totalsByOutcome(await delegationCounterSamples())
      const res = await send({ assertion: { rawPayload } })
      const after = totalsByOutcome(await delegationCounterSamples())
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_invalid' })
      expect(counterDeltas(before, after)).toEqual({ malformed: 1 })
    }
  )
})

describe('Story 71.9 AC-1 — kid label cardinality and series pre-initialisation', () => {
  it('creates every outcome series at 0 for none and for each configured kid at boot', () => {
    const present = new Set(bootSamples.map((sample) => `${sample.outcome}|${sample.kid}`))
    const expected = verify.DELEGATION_OUTCOMES.flatMap((outcome) =>
      [NO_KID, ...CONFIGURED_KIDS].map((kid) => `${outcome}|${kid}`)
    )
    expect(expected.filter((series) => !present.has(series))).toEqual([])
    expect(bootSamples.every((sample) => sample.value === 0)).toBe(true)
    expect(bootSamples).toHaveLength(expected.length)
  })

  it('exposes the pre-initialised series in the /metrics text', async () => {
    const text = await register.metrics()
    expect(text).toContain('pv_delegation_assertions_total{outcome="replayed",kid="none"}')
    expect(text).toContain(
      `pv_delegation_assertions_total{outcome="store_unavailable",kid="${KID_EXTRA}"}`
    )
  })

  it('grows the label set by at most one series for 50 distinct unknown kids', async () => {
    const before = await delegationCounterSamples()
    const kids = Array.from({ length: 50 }, () => `attacker-kid-${randomUUID()}`)
    await Promise.all(kids.map((kid) => send({ assertion: { header: { kid } } })))
    const after = await delegationCounterSamples()
    expect(after.length - before.length).toBeLessThanOrEqual(1)
    expect(after.some((sample) => kids.includes(sample.kid))).toBe(false)
  })

  it('records nothing and never throws for an outcome outside the closed set', async () => {
    const before = await delegationCounterSamples()
    expect(() => metrics.recordDelegationOutcome('attacker-chosen-outcome', 'k')).not.toThrow()
    expect(await delegationCounterSamples()).toHaveLength(before.length)
  })
})

describe('Story 71.9 AC-7 — logging hygiene and request correlation', () => {
  const orgService = () => import('../modules/service-provisioning/service.js')
  const actorModule = () => import('../modules/auth/delegation-actor.js')

  it('logs no assertion, subject or raw jti on any outcome, and every delegation line is correlated', async () => {
    const { stream, lines } = createLogCaptureStream()
    const logged = await bootDelegatedApp({
      logStream: stream,
      routes: [
        { url: DELEGATED_URL },
        {
          url: SUBJECT_URL,
          security: { delegation: { subjectFields: { org: { in: 'body', name: 'orgRef' } } } },
          schema: { body: z.object({ orgRef: z.unknown().optional() }).passthrough() },
        },
        {
          url: HISTORICAL_URL,
          security: { delegation: { historicalActorPolicy: { maxAgeSeconds: 30 * DAY } } },
        },
      ],
    })
    activeApp = logged.app
    try {
      // The rate-limit row spends a whole bucket; every other row, success included, runs here.
      await ROWS.filter((candidate) => candidate.outcome !== 'rate_limited_pre').reduce(
        async (previous, row) => {
          await previous
          await row.act(await row.prepare?.())
        },
        Promise.resolve()
      )
      // The two lookup failures are the only rows that log a `delegation.*` line today.
      const realOrg = await orgService()
      vi.spyOn(realOrg, 'resolveOrgByCentralizemeId').mockRejectedValueOnce(
        new Error('lookup-failure-sentinel-for-org')
      )
      await send({})
      const realActor = await actorModule()
      vi.spyOn(realActor, 'resolveDelegatedActor').mockRejectedValueOnce(
        new Error('lookup-failure-sentinel-for-actor')
      )
      await send({})
    } finally {
      activeApp = app
      vi.restoreAllMocks()
    }
    const parsed = parseCapturedLogLines(lines)
    const text = parsed.map((line) => JSON.stringify(line)).join('\n')
    // An assertion's JWS always starts with the base64url of its `{"alg":...` header.
    expect(text).not.toContain('eyJhbGciOi')
    expect(text).not.toContain('PV-Delegation')
    expect(text).not.toContain(DELEGATED_ACTOR)
    expect(text).not.toContain('user_')
    expect(text).not.toContain('jti-')
    expect(text).not.toContain('lookup-failure-sentinel')
    const delegationLines = parsed.filter((line) =>
      String(line['eventType'] ?? line['msg'] ?? '').startsWith('delegation.')
    )
    expect(delegationLines.length).toBeGreaterThanOrEqual(2)
    for (const line of delegationLines) {
      expect(line).toMatchObject({
        requestId: expect.any(String),
        routeKey: `POST ${DELEGATED_URL}`,
        outcome: expect.any(String),
      })
    }
  })
})
