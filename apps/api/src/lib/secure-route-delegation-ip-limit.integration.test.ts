import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import {
  counterDeltas,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  delegationCounterSamples,
  delegationTestVerifyKeysJson,
  totalsByOutcome,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'
import {
  bootDelegatedApp,
  callDelegated,
  closeDelegatedApps,
  type DelegatedCall,
} from '../__tests__/helpers/delegation-app-helpers.js'

/**
 * Story 71.9 AC-4 (DW-539 item 1): a delegated route gets a default per-IP limiter that runs in the
 * delegation `onRequest` stage, before the `preParsing` verification, so an unauthenticated flood
 * costs no signature check and no database work. Real `secureRoute` pipeline, real Postgres.
 */

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJson()
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()

// Loaded only after the env above: these modules read env when they load.
const replayStore = await import('../modules/auth/delegation-replay-store.js')
const verify = await import('../modules/auth/delegation-verify.js')
const securityEvents = await import('../modules/auth/delegation-security-events.js')
const orgService = await import('../modules/service-provisioning/service.js')
const actorModule = await import('../modules/auth/delegation-actor.js')
const stages = await import('./delegation-stages.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const PLAIN_URL = '/plain-probe'
const BUDGET = stages.DELEGATION_IP_RATE_LIMIT.max

let org: DelegationOrgFixture
let app: FastifyInstance
let plainRoutes = 0

async function bootWith(options: { trustProxy?: boolean } = {}) {
  return (
    await bootDelegatedApp({
      ...options,
      extraRoutes: (instance) => {
        plainRoutes += 1
        instance.get(PLAIN_URL, async () => ({ ok: true }))
      },
    })
  ).app
}

beforeAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-ip-limit-test-passphrase')
  org = await createDelegationOrg('ip')
  app = await bootWith()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  await closeDelegatedApps()
})

/** Runs `fn` over `items` one after another (no parallelism, no await inside a loop). */
async function inSequence<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    results.push(await fn(item))
  }, Promise.resolve())
  return results
}

function post(target: FastifyInstance, call: Partial<DelegatedCall>) {
  return callDelegated(target, { org: org.cmOrgId, ...call })
}

function databaseSpies() {
  return [
    vi.spyOn(orgService, 'resolveOrgByCentralizemeId'),
    vi.spyOn(replayStore, 'burnDelegationAssertion'),
    vi.spyOn(actorModule, 'resolveDelegatedActor'),
    vi.spyOn(securityEvents, 'writeDelegationSecurityEvent'),
  ]
}

describe('Story 71.9 AC-4 — the default per-IP limiter on delegated routes', () => {
  it('sizes the default at 600 requests per minute per IP', () => {
    expect(stages.DELEGATION_IP_RATE_LIMIT).toEqual({ max: 600, timeWindowMs: 60_000 })
  })

  it('answers the first N generic 401s and the rest 429 with Retry-After, with no database work', async () => {
    const spies = databaseSpies()
    const verifySpy = vi.spyOn(verify, 'verifyDelegationAssertion')
    const before = totalsByOutcome(await delegationCounterSamples())
    const responses = await inSequence(
      Array.from({ length: 1000 }, (_, index) => index),
      () => post(app, { authorization: null, remoteAddress: '10.9.0.1' })
    )
    const codes = responses.map((res) => res.statusCode)
    expect(codes.slice(0, BUDGET).every((code) => code === 401)).toBe(true)
    expect(codes.slice(BUDGET).every((code) => code === 429)).toBe(true)
    expect(codes.slice(BUDGET)).toHaveLength(1000 - BUDGET)
    expect(Number(responses.at(BUDGET)?.headers['retry-after'])).toBeGreaterThan(0)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(verifySpy).not.toHaveBeenCalled()
    expect(counterDeltas(before, totalsByOutcome(await delegationCounterSamples()))).toEqual({
      missing: BUDGET,
      rate_limited_pre: 1000 - BUDGET,
    })
    const noKid = (await delegationCounterSamples()).find(
      (sample) => sample.outcome === 'rate_limited_pre' && sample.kid === 'none'
    )
    expect(noKid?.value).toBeGreaterThanOrEqual(1000 - BUDGET)
  }, 60_000)

  it('stops a flooded IP before the signature check even for a validly signed assertion', async () => {
    const spies = databaseSpies()
    const verifySpy = vi.spyOn(verify, 'verifyDelegationAssertion')
    // 10.9.0.1 is already over its budget (previous test, same window).
    const res = await post(app, { remoteAddress: '10.9.0.1' })
    expect(res.statusCode).toBe(429)
    expect(verifySpy).not.toHaveBeenCalled()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('keys on the connection IP, never on a raw X-Forwarded-For header (trustProxy off)', async () => {
    const res = await post(app, {
      remoteAddress: '10.9.0.1',
      headers: { 'x-forwarded-for': '203.0.113.77' },
    })
    expect(res.statusCode).toBe(429)
    const fresh = await post(app, {
      remoteAddress: '10.9.0.2',
      headers: { 'x-forwarded-for': '10.9.0.1' },
      authorization: null,
    })
    expect(fresh.statusCode).toBe(401)
  })

  it('keys on the configured client IP behind a trusted proxy, not on the socket address', async () => {
    const proxied = await bootWith({ trustProxy: true })
    const codes = await inSequence(
      Array.from({ length: BUDGET + 2 }, (_, index) => index),
      () =>
        post(proxied, {
          authorization: null,
          remoteAddress: '10.8.0.1',
          headers: { 'x-forwarded-for': '198.51.100.20' },
        })
    )
    expect(codes.at(-1)?.statusCode).toBe(429)
    const otherClient = await post(proxied, {
      authorization: null,
      remoteAddress: '10.8.0.1',
      headers: { 'x-forwarded-for': '198.51.100.21' },
    })
    expect(otherClient.statusCode).toBe(401)
  }, 60_000)

  it('shares one bucket across an IPv6 /64, like the other IP limiters', async () => {
    const codes = await inSequence(
      Array.from({ length: BUDGET }, (_, index) => index),
      (index) =>
        post(app, {
          authorization: null,
          remoteAddress: `2001:db8:1:2:0:0:0:${(index % 60000).toString(16)}`,
        })
    )
    expect(codes.every((res) => res.statusCode === 401)).toBe(true)
    const sameSubnet = await post(app, {
      authorization: null,
      remoteAddress: '2001:db8:1:2:ffff:0:0:1',
    })
    expect(sameSubnet.statusCode).toBe(429)
  }, 60_000)

  it('does not apply to a non-delegated route: byte-identical response and headers', async () => {
    expect(plainRoutes).toBeGreaterThan(0)
    const probe = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: PLAIN_URL, remoteAddress })
    const normalize = (res: Awaited<ReturnType<typeof probe>>) => ({
      status: res.statusCode,
      body: res.body,
      headers: Object.fromEntries(Object.entries(res.headers).filter(([name]) => name !== 'date')),
    })
    const fresh = normalize(await probe('10.7.0.1'))
    // 10.9.0.1 is the exhausted delegated-route client from the first test.
    const exhausted = normalize(await probe('10.9.0.1'))
    expect(fresh.status).toBe(200)
    expect(exhausted).toEqual(fresh)
    expect(Object.keys(exhausted.headers).some((name) => name.includes('retry'))).toBe(false)
  })

  it('does not limit when RATE_LIMIT_TEST_BYPASS is on, like the other limiters', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    try {
      const codes = await inSequence(
        Array.from({ length: BUDGET + 20 }, (_, index) => index),
        () => post(app, { authorization: null, remoteAddress: '10.6.0.1' })
      )
      expect(codes.every((res) => res.statusCode === 401)).toBe(true)
    } finally {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    }
  }, 60_000)
})
