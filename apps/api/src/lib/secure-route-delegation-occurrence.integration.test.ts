import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import {
  countBurnedAssertions,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  delegationTestVerifyKeysJson,
  linkDelegationActor,
  signDelegationAssertion,
  type AssertionOptions,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'

/**
 * Story 71.4 AC-3 — the occurrence window (S1) and historical admission, through the real
 * `secureRoute` delegated pipeline, a real Postgres and the real replay store. The signed `occ` is
 * placed relative to the real clock; the exact boundaries are pinned by the pure unit tests of
 * `occurrence-window.ts` (injected clock), so nothing here sleeps or depends on timing.
 */

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJson()
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()
const { loadedApiRoutesState } = await import('../__tests__/helpers/secure-route-stubs.js')
const { default: authenticatePlugin } = await import('../plugins/authenticate.js')
const { installApiRoutes, registerApiRouteAdds } =
  await import('../extensions/api-routes/install.js')
const stages = await import('./delegation-stages.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const URL_PATH = '/cm/audit-events'
const SIBLING_URL = '/cm/other-events'
const KEY = `POST ${URL_PATH}`
const OUTSIDE_WINDOW = 'delegation_occurrence_outside_window'
const NON_MEMBER = 'non-member' as const
const DAY = 86_400
const POLICY_30_DAYS = { historicalActorPolicy: { maxAgeSeconds: 30 * DAY } }

type Seen = { ctx: Record<string, unknown> }
const opened: FastifyInstance[] = []
let org: DelegationOrgFixture

async function boot(delegation: Record<string, unknown> | true = true) {
  const seen: Seen[] = []
  const handler = async (ctx: Record<string, unknown>, _req: FastifyRequest) => {
    seen.push({ ctx })
    return { ok: true }
  }
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(authenticatePlugin)
  const security = (value: unknown) => ({ security: { delegation: value, writeAuditEvent: false } })
  const runtime = installApiRoutes(
    app as never,
    loadedApiRoutesState(
      {
        add: [
          { method: 'POST', url: URL_PATH, options: security(delegation) },
          // The sibling declares NO policy: a policy never extends to another route.
          { method: 'POST', url: SIBLING_URL, options: security(true) },
        ],
      },
      { [KEY]: { handler }, [`POST ${SIBLING_URL}`]: { handler } }
    )
  )
  await app.after()
  await registerApiRouteAdds(app as never, runtime, {
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    docsEnabled: true,
  })
  await app.ready()
  opened.push(app)
  return { app, seen }
}

async function post(
  app: FastifyInstance,
  options: { sub: string; assertion?: AssertionOptions; url?: string }
) {
  const url = options.url ?? URL_PATH
  const token = signDelegationAssertion(
    { org: org.cmOrgId, sub: options.sub, op: `POST ${url}` },
    options.assertion
  )
  return app.inject({ method: 'POST', url, headers: { authorization: `PV-Delegation ${token}` } })
}

/** An assertion whose signed `occ` is `ageSeconds` before now (negative = in the future). */
function occurredAgo(ageSeconds: number): AssertionOptions {
  const now = Math.floor(Date.now() / 1000)
  // `occ` may be at most iat + 30, and `iat` at most now + 30: a future occ rides on a future iat.
  const iat = ageSeconds < 0 ? now + 29 : now
  return { claims: { iat, exp: iat + 45, occ: now - ageSeconds } }
}

function counterValue(outcome: string): number {
  const metric = register.getSingleMetric('pv_delegation_assertions_total') as unknown as {
    hashMap?: Record<string, { value: number; labels: Record<string, string> }>
  }
  return Object.values(metric?.hashMap ?? {})
    .filter((entry) => entry.labels['outcome'] === outcome)
    .reduce((sum, entry) => sum + entry.value, 0)
}

type ActorKind = 'member' | typeof NON_MEMBER | 'unlinked'
async function actorSubject(kind: ActorKind): Promise<{ sub: string; userId?: string }> {
  const sub = `user_${randomUUID()}`
  if (kind === 'unlinked') return { sub }
  const { userId } = await linkDelegationActor(org.orgId, sub, {
    membership: kind === 'member' ? 'active' : 'deactivated',
  })
  return { sub, userId }
}

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-occurrence-test-passphrase')
  org = await createDelegationOrg('occ')
})

afterAll(async () => {
  await Promise.all(opened.map((app) => app.close()))
})

type Row = {
  age: number
  policy: 'none' | '30d'
  actor: ActorKind
  expected: 200 | 400 | 403
}

// now - occ in {future, 0, 89 s, 91 s, 29 days, 31 days} x policy {none, 30 days} x actor kind.
const AGES = [-35, 0, 89, 91, 29 * DAY, 31 * DAY]
function expectedStatus(age: number, policy: Row['policy'], actor: ActorKind): Row['expected'] {
  const allowed = policy === '30d' ? 30 * DAY : 90
  if (age < 0 || age > allowed) return 400
  if (actor === NON_MEMBER && policy === 'none') return 403
  return 200
}
const MATRIX: Row[] = AGES.flatMap((age) =>
  (['none', '30d'] as const).flatMap((policy) =>
    (['member', NON_MEMBER, 'unlinked'] as const).map((actor) => ({
      age,
      policy,
      actor,
      expected: expectedStatus(age, policy, actor),
    }))
  )
)

describe('Story 71.4 AC-3 — occurrence window x policy x actor kind (real pipeline)', () => {
  it.each(MATRIX)(
    'age $age s, policy $policy, $actor actor -> $expected',
    async ({ age, policy, actor, expected }) => {
      const { app, seen } = await boot(policy === '30d' ? POLICY_30_DAYS : true)
      const { sub } = await actorSubject(actor)
      const res = await post(app, { sub, assertion: occurredAgo(age) })
      expect(res.statusCode).toBe(expected)
      if (expected === 400) {
        expect(JSON.parse(res.body)).toMatchObject({ code: OUTSIDE_WINDOW })
        expect(seen).toHaveLength(0)
      }
      if (expected === 403) {
        expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_actor_not_member' })
      }
      if (expected === 200) expect(seen).toHaveLength(1)
    }
  )
})

describe('Story 71.4 AC-3 — window rejection and admission details', () => {
  it('rejects outside the window before any burn or DB work, counted and as a security event', async () => {
    const { app, seen } = await boot()
    const before = counterValue('occurrence_outside_window')
    const burnedBefore = await countBurnedAssertions(org.orgId)
    const { sub } = await actorSubject('member')
    const res = await post(app, { sub, assertion: occurredAgo(3600) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      code: OUTSIDE_WINDOW,
      message: expect.any(String),
    })
    expect(counterValue('occurrence_outside_window')).toBe(before + 1)
    expect(await countBurnedAssertions(org.orgId)).toBe(burnedBefore)
    expect(seen).toHaveLength(0)
  })

  it('an assertion with no occ is never window-checked and is admitted as in 71-3', async () => {
    const { app, seen } = await boot(POLICY_30_DAYS)
    const { sub } = await actorSubject('member')
    expect((await post(app, { sub })).statusCode).toBe(200)
    expect(seen[0]?.ctx['delegation']).not.toHaveProperty('occurredAt')
  })

  it('admits a linked non-member on a policy route as issuer_attested/not_current_member with no role', async () => {
    const before = counterValue('actor_attested_nonmember')
    const { app, seen } = await boot(POLICY_30_DAYS)
    const { sub, userId } = await actorSubject(NON_MEMBER)
    const occ = occurredAgo(3600)
    const res = await post(app, { sub, assertion: occ })
    expect(res.statusCode).toBe(200)
    const ctx = seen[0]?.ctx as Record<string, Record<string, unknown>>
    expect(ctx['delegation']).toMatchObject({
      actorUserId: userId,
      actorAttestation: 'issuer_attested',
      actorAttestationReason: 'not_current_member',
      occurredAt: (occ.claims as { occ: number }).occ,
    })
    expect(ctx['auth']).not.toHaveProperty('orgRole')
    expect(counterValue('actor_attested_nonmember')).toBe(before + 1)
  })

  it('rejects a linked non-member on a policy route when the assertion carries no occ', async () => {
    const { app, seen } = await boot(POLICY_30_DAYS)
    const { sub } = await actorSubject(NON_MEMBER)
    const res = await post(app, { sub })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_actor_not_member' })
    expect(seen).toHaveLength(0)
  })

  it('marks an unlinked actor reason unlinked, and a current member with an old occ pv_verified', async () => {
    const { app, seen } = await boot(POLICY_30_DAYS)
    const unlinked = await actorSubject('unlinked')
    expect((await post(app, { sub: unlinked.sub, assertion: occurredAgo(3600) })).statusCode).toBe(
      200
    )
    const member = await actorSubject('member')
    const occ = occurredAgo(2 * DAY)
    expect((await post(app, { sub: member.sub, assertion: occ })).statusCode).toBe(200)
    expect(seen[0]?.ctx['delegation']).toMatchObject({
      actorUserId: null,
      actorAttestation: 'issuer_attested',
      actorAttestationReason: 'unlinked',
    })
    const memberDelegation = seen[1]?.ctx['delegation'] as Record<string, unknown>
    expect(memberDelegation).toMatchObject({
      actorUserId: member.userId,
      actorAttestation: 'pv_verified',
      occurredAt: (occ.claims as { occ: number }).occ,
    })
    expect(memberDelegation).not.toHaveProperty('actorAttestationReason')
  })

  it('never extends the policy to a sibling delegated route without one', async () => {
    const { app, seen } = await boot(POLICY_30_DAYS)
    const { sub } = await actorSubject(NON_MEMBER)
    const old = occurredAgo(2 * DAY)
    expect((await post(app, { sub, assertion: old })).statusCode).toBe(200)
    const sibling = await post(app, { sub, assertion: old, url: SIBLING_URL })
    expect(sibling.statusCode).toBe(400)
    expect(JSON.parse(sibling.body)).toMatchObject({ code: OUTSIDE_WINDOW })
    expect(seen).toHaveLength(1)
  })

  it('still rejects the admitted non-member on a role-gated route with insufficient_role', async () => {
    const roleApp = await bootRoleGated()
    const { sub } = await actorSubject(NON_MEMBER)
    const res = await post(roleApp, { sub, assertion: occurredAgo(3600) })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'insufficient_role' })
  })

  it('the 71-4 seam admits only a policy plus a signed occ', () => {
    const policy = { maxAgeSeconds: 600 }
    expect(stages.resolveHistoricalAdmission({ policy, occurredAt: 1 })).toEqual({ admitted: true })
    expect(stages.resolveHistoricalAdmission({ policy, occurredAt: undefined })).toEqual({
      admitted: false,
    })
    expect(stages.resolveHistoricalAdmission({ policy: undefined, occurredAt: 1 })).toEqual({
      admitted: false,
    })
  })
})

async function bootRoleGated(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(authenticatePlugin)
  const runtime = installApiRoutes(
    app as never,
    loadedApiRoutesState(
      {
        add: [
          {
            method: 'POST',
            url: URL_PATH,
            options: {
              security: {
                delegation: POLICY_30_DAYS,
                minimumRole: 'member',
                writeAuditEvent: false,
              },
            },
          },
        ],
      },
      { [KEY]: { handler: async () => ({ ok: true }) } }
    )
  )
  await app.after()
  await registerApiRouteAdds(app as never, runtime, {
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    docsEnabled: true,
  })
  await app.ready()
  opened.push(app)
  return app
}
