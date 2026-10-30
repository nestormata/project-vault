import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapRouteIntegrationTest } from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { forEachSequential } from '../../lib/for-each-sequential.js'
import { bootCredentialRouteApp } from '../credentials/credential-route-test-helpers.js'
import { flushPendingLosingAttempts } from './external-service.js'
import {
  createExternalShareSeeder,
  type ExternalShareSeeder,
  type ShareOverrides,
} from './external-share-test-helpers.js'
import { generateAndHashShareToken } from './service.js'
import { hashVerificationCode } from './verification.js'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import {
  evaluateTiming,
  formatTimingTable,
  mergeResample,
  mulberry32,
  seededShuffle,
  type TimingEvaluation,
  type TimingEvaluationOptions,
} from './timing-stats.js'

/**
 * Story 65.4 AC1/AC3 — statistical timing evidence for the external share miss paths, over a real
 * DB and both native routes. STRUCTURAL: it compares each miss class against an unknown token
 * (class vs class medians), never an absolute wall-clock budget. The run is reported INVALID, and
 * fails, when the A/A control (a second unknown-token sample) differs by more than T or when the
 * positive control (an unknown-token request with 20 ms added) is not detected, so it can never
 * pass vacuously. A class whose CI straddles T is re-sampled once with doubled n and then fails as
 * inconclusive.
 *
 * It takes about 90 s because every miss is held to the floor, so it is NOT part of the default
 * `vitest` run (see `vitest.config.ts`): the nightly workflow runs it with `RUN_TIMING_TESTS=1`
 * (`pnpm --filter @project-vault/api test:timing`). The PR gate keeps the deterministic tests in
 * `external-miss-deferred-write.integration.test.ts`, `min-response-time.test.ts` and
 * `credential-sharing-host.test.ts`.
 *
 * `TIMING_N` overrides the per-class sample size (default 30), `TIMING_SEED` the PRNG seed.
 *
 * Story 72-11 adds a second leg with the same method for the two guest verification routes
 * (`POST .../verification` and `POST .../verification/confirm`, decision V9): every outcome of
 * those routes, a success included, must be within T of an unknown token.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'external-timing',
  orgNamePrefix: 'External Timing Org',
})

const SEED = Number(process.env.TIMING_SEED ?? 20261006)
const N = Number(process.env.TIMING_N ?? 30)
const WARMUP_ROUNDS = 6
const POSITIVE_CONTROL_MS = 20
const PAST = () => new Date(Date.now() - 60_000)

const METHOD: Omit<TimingEvaluationOptions, 'seed' | 'missClasses'> = {
  floorMs: 2,
  k: 3,
  resamples: 2000,
  confidence: 0.995,
  maxInconclusive: 2,
}

type RouteKind = 'GET' | 'POST' | 'SEND' | 'CONFIRM'

const ROUTE_SUFFIX = new Map<RouteKind, string>([
  ['GET', ''],
  ['POST', '/reveal'],
  ['SEND', '/verification'],
  ['CONFIRM', '/verification/confirm'],
])

/** How each seeded miss class is expressed on a fresh row; classes without an entry carry no row
 *  at all (an unknown or malformed token, and the two controls). */
const ROW_CLASSES = new Map<string, () => ShareOverrides>([
  ['EXP', () => ({ status: 'expired', expiresAt: PAST() })],
  ['LAZY', () => ({ status: 'active', expiresAt: PAST() })],
  ['REV', () => ({ status: 'revoked', revokedAt: new Date() })],
  ['VIEW', () => ({ status: 'viewed', firstViewedAt: new Date(), viewCount: 1 })],
  ['SUP', () => ({ status: 'superseded', supersededAt: new Date() })],
  ['FLD', () => ({ fieldKey: 'no-longer-exists' })],
])

// Story 72-11: the verification classes are gated rows (`verificationRequired: true`), except LINK
// (a link-only share). LIVE is a verifiable share with no code yet, CODE one with a live code (the
// confirm then guesses wrong, or right for OK), THR one whose last send was just now, CAP one at
// the send cap, LOCK one an attempt cap closed.
const GATED = { verificationRequired: true } satisfies ShareOverrides
const VERIFICATION_ROW_CLASSES = new Map<string, () => ShareOverrides>([
  ['EXP', () => ({ ...GATED, status: 'expired', expiresAt: PAST() })],
  ['LAZY', () => ({ ...GATED, status: 'active', expiresAt: PAST() })],
  ['REV', () => ({ ...GATED, status: 'revoked', revokedAt: new Date() })],
  ['VIEW', () => ({ ...GATED, status: 'viewed', firstViewedAt: new Date(), viewCount: 1 })],
  ['LOCK', () => ({ ...GATED, status: 'revoked', revokedAt: new Date(), lockedAt: new Date() })],
  ['THR', () => ({ ...GATED, verificationSentAt: new Date(), verificationSendCount: 1 })],
  ['CAP', () => ({ ...GATED, verificationSendCount: 5, verificationSentAt: PAST() })],
  ['LINK', () => ({})],
  ['LIVE', () => ({ ...GATED })],
  ['CODE', () => ({ ...GATED })],
  ['OK', () => ({ ...GATED })],
])
const CONFIRM_CODE = '424242'
const WRONG_CODE = '131313'

const MISS_CLASSES_BY_ROUTE = new Map<RouteKind, string[]>([
  // The metadata GET answers a still-active share with its details (a hit), so FLD (a
  // reveal-only miss: the field was removed) does not apply to it.
  ['GET', ['MAL', 'EXP', 'LAZY', 'REV', 'VIEW', 'SUP']],
  ['POST', ['MAL', 'EXP', 'LAZY', 'REV', 'VIEW', 'SUP', 'FLD']],
  // Story 72-11 V9: on these two routes EVERY outcome is held, the live and successful ones too.
  ['SEND', ['MAL', 'EXP', 'LAZY', 'REV', 'VIEW', 'LOCK', 'THR', 'CAP', 'LINK', 'LIVE']],
  ['CONFIRM', ['MAL', 'EXP', 'REV', 'VIEW', 'LOCK', 'LINK', 'LIVE', 'CODE', 'OK']],
])

const isVerificationRoute = (kind: RouteKind) => kind === 'SEND' || kind === 'CONFIRM'

describe('external share miss-path timing (Story 65.4 AC1/AC3)', () => {
  let app: TestApp
  let seeder: ExternalShareSeeder
  let ipCounter = 0

  beforeAll(async () => {
    await resetVaultForTest()
    app = await bootCredentialRouteApp(createApp, initVault, 'external-timing-passphrase')
    seeder = await createExternalShareSeeder(app, registerOwner, 'timing')
  }, 120_000)

  afterAll(async () => {
    await flushPendingLosingAttempts()
    await app.close()
    await resetVaultForTest()
  })

  /** Story 72-11: gives a seeded verification row a live code, as a send would have. */
  async function giveLiveCode(id: string, token: string): Promise<void> {
    await withOrg(seeder.orgId, (tx) =>
      tx
        .update(credentialShares)
        .set({
          verificationCodeHash: hashVerificationCode(token, id, CONFIRM_CODE),
          verificationCodeExpiresAt: new Date(Date.now() + 5 * 60_000),
        })
        .where(eq(credentialShares.id, id))
    )
  }

  async function tokenFor(kind: RouteKind, cls: string): Promise<string> {
    if (cls === 'MAL') return 'x'
    const overrides = (isVerificationRoute(kind) ? VERIFICATION_ROW_CLASSES : ROW_CLASSES).get(cls)
    if (!overrides) return generateAndHashShareToken().rawToken
    const { id, token } = await seeder.seedShare(overrides())
    if (cls === 'CODE' || cls === 'OK') await giveLiveCode(id, token)
    return token
  }

  function expectedStatuses(kind: RouteKind, cls: string): number[] {
    // Every class here is never a reveal and never a rate-limit rejection.
    if (kind === 'SEND') return [200]
    if (kind === 'CONFIRM') return cls === 'OK' ? [200] : [422]
    return kind === 'POST' ? [404, 410] : [200, 404, 410]
  }

  async function timeOne(kind: RouteKind, cls: string): Promise<number> {
    const token = await tokenFor(kind, cls)
    ipCounter += 1
    const remoteAddress = `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
    const url = `/api/v1/external-shares/access/${token}${ROUTE_SUFFIX.get(kind) ?? ''}`
    const payload =
      kind === 'CONFIRM' ? { code: cls === 'OK' ? CONFIRM_CODE : WRONG_CODE } : undefined
    const method = kind === 'GET' ? 'GET' : 'POST'
    const started = performance.now()
    const response = await app.inject({
      method,
      url,
      remoteAddress,
      ...(payload ? { payload } : {}),
    })
    if (cls === 'H') await sleep(POSITIVE_CONTROL_MS)
    const elapsed = performance.now() - started
    expect(expectedStatuses(kind, cls)).toContain(response.statusCode)
    return elapsed
  }

  async function collect(
    kind: RouteKind,
    classes: string[],
    rounds: number,
    rng: () => number
  ): Promise<Record<string, number[]>> {
    const samples = new Map<string, number[]>(classes.map((c) => [c, []]))
    const schedule: { round: number; cls: string }[] = []
    for (let round = -WARMUP_ROUNDS; round < rounds; round += 1) {
      for (const cls of seededShuffle(classes, rng)) schedule.push({ round, cls })
    }
    // One probe at a time on purpose: this measures per-request latency, not throughput.
    await forEachSequential(schedule, async ({ round, cls }) => {
      const ms = await timeOne(kind, cls)
      if (round >= 0) samples.get(cls)?.push(ms)
    })
    return Object.fromEntries(samples)
  }

  async function measure(kind: RouteKind): Promise<TimingEvaluation> {
    const rng = mulberry32(SEED)
    const missClasses = MISS_CLASSES_BY_ROUTE.get(kind) ?? []
    const controls = ['U', "U'", 'H']
    const first = evaluateTiming(await collect(kind, [...controls, ...missClasses], N, rng), {
      ...METHOD,
      seed: SEED,
      missClasses,
    })
    let result = first
    if (first.inconclusive.length > 0 && !first.validity.startsWith('invalid: A/A')) {
      const retry = first.inconclusive
      const second = evaluateTiming(await collect(kind, [...controls, ...retry], N * 2, rng), {
        ...METHOD,
        seed: SEED + 1,
        missClasses: retry,
      })
      result = mergeResample(first, second, METHOD.maxInconclusive)
    }
    process.stdout.write(
      `[65-4/72-11 timing ${kind}] seed=${SEED} n=${N} resamples=${METHOD.resamples}\n${formatTimingTable(result)}\n`
    )
    return result
  }

  it.each(['GET', 'POST'] as const)(
    'every miss class is within T of an unknown token on %s',
    async (kind) => {
      const result = await measure(kind)
      expect(result.validity).toBe('valid')
      expect(result.leaks).toEqual([])
      expect(result.inconclusive).toEqual([])
    },
    600_000
  )

  // Story 72-11 V9: the guest verification routes. The deferred send tasks of the SEND leg are
  // drained before the CONFIRM leg so they never overlap its samples.
  it.each(['SEND', 'CONFIRM'] as const)(
    'every outcome class of the %s verification route is within T of an unknown token',
    async (kind) => {
      await flushPendingLosingAttempts()
      const result = await measure(kind)
      await flushPendingLosingAttempts()
      expect(result.validity).toBe('valid')
      expect(result.leaks).toEqual([])
      expect(result.inconclusive).toEqual([])
    },
    600_000
  )
})
