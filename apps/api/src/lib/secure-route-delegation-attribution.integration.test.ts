import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { and, eq, like, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg, type Tx } from '@project-vault/db'
import {
  auditLogEntries,
  externalIdentities,
  extensionAuditIdempotencyKeys,
  orgMemberships,
} from '@project-vault/db/schema'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'
import {
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  DELEGATION_TEST_KID,
  delegationTestVerifyKeysJson,
  linkDelegationActor,
  signDelegationAssertion,
  type AssertionOptions,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'

/**
 * Story 71.4 AC-4/AC-5/AC-6/AC-7 — attribution at the audit write boundary, driven from a real
 * delegated route (real `secureRoute`, real Postgres, real replay store, real `config/env`) that
 * calls the real `writeExtensionAuditEventForManifest`. Nothing here mocks the write path.
 */

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJson()
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()
const { loadedApiRoutesState } = await import('../__tests__/helpers/secure-route-stubs.js')
const { default: authenticatePlugin } = await import('../plugins/authenticate.js')
const { installApiRoutes, registerApiRouteAdds } =
  await import('../extensions/api-routes/install.js')
const sourceModule = await import('./audit-event-source.js')
const quotaGate = await import('../modules/audit/quota-gate.js')
const { computeAuditHmac, GENESIS_SENTINEL } = await import('../modules/audit/write-entry.js')
const { verifyAuditRange } = await import('../modules/audit/verify.js')
const { getAuditKey } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')
const { writeExtensionAuditEventForManifest } = sourceModule

const URL_PATH = '/cm/attributed-events'
const KEY = `POST ${URL_PATH}`
const DAY = 86_400
const MANIFEST_NAME = 'com.acme.attrib'
const MANIFEST: ExtensionManifest = {
  name: MANIFEST_NAME,
  apiVersion: '3.33.0',
  capabilities: ['audit-event-source'],
}
const NIL_UUID = ['00000000', '0000', '0000', '0000', '000000000000'].join('-')
const SENTINEL_SUBJECT = 'sentinel-actor-subject-71-4'
const POLICY = { historicalActorPolicy: { maxAgeSeconds: 30 * DAY } }
const REJECTED = 'ExtensionAuditAttributionRejectedError'

let org: DelegationOrgFixture
let caseNumber = 0
const opened: FastifyInstance[] = []
const logCapture = createLogCaptureStream()

function nextEventType(): string {
  caseNumber += 1
  return `ext.${MANIFEST_NAME}.case_${caseNumber}`
}

type Outcome = {
  receipt?: { id: string; createdAt: string }
  error?: { name: string; code: string | null }
}

/** A delegated route whose handler performs the audit write described by the request body. */
async function boot(delegation: Record<string, unknown> = POLICY) {
  const handler = async (ctx: Record<string, unknown>, req: FastifyRequest): Promise<Outcome> => {
    const body = req.body as { input: Record<string, unknown>; orgId?: string }
    const delegated = ctx['delegation'] as { orgId: string }
    try {
      const receipt = await writeExtensionAuditEventForManifest(
        MANIFEST,
        { orgId: body.orgId ?? delegated.orgId, payload: {}, ...body.input } as never,
        { logger: req.log as never }
      )
      return { receipt }
    } catch (error) {
      const typed = error as { name: string; code?: string }
      return { error: { name: typed.name, code: typed.code ?? null } }
    }
  }
  const app = Fastify({
    logger: { level: 'debug', stream: logCapture.stream },
    routerOptions: { ignoreTrailingSlash: true },
  })
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
            options: { security: { delegation, writeAuditEvent: false } },
          },
        ],
      },
      { [KEY]: { handler } }
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

type WriteOptions = {
  sub: string
  input?: Record<string, unknown>
  assertion?: AssertionOptions
  orgId?: string
}

async function write(app: FastifyInstance, options: WriteOptions): Promise<Outcome> {
  const raw = JSON.stringify({
    input: { eventType: nextEventType(), ...options.input },
    ...(options.orgId ? { orgId: options.orgId } : {}),
  })
  const token = signDelegationAssertion(
    { org: org.cmOrgId, sub: options.sub, op: KEY, body: raw },
    options.assertion
  )
  const res = await app.inject({
    method: 'POST',
    url: URL_PATH,
    payload: raw,
    headers: { 'content-type': 'application/json', authorization: `PV-Delegation ${token}` },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body) as Outcome
}

function receiptOf(outcome: Outcome | undefined): { id: string; createdAt: string } {
  if (!outcome?.receipt) throw new Error(`expected a receipt, got ${JSON.stringify(outcome)}`)
  return outcome.receipt
}

function occ(ageSeconds: number): AssertionOptions {
  const now = Math.floor(Date.now() / 1000)
  return { claims: { occ: now - ageSeconds } }
}

type Row = typeof auditLogEntries.$inferSelect
async function rowOf(id: string, orgId = org.orgId): Promise<Row> {
  const rows = await withOrg(orgId, (tx) =>
    (tx as Tx).select().from(auditLogEntries).where(eq(auditLogEntries.id, id))
  )
  const [row] = rows as Row[]
  if (!row) throw new Error('expected an audit row')
  return row
}

async function rowCount(eventType: string, orgId = org.orgId): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    (tx as Tx)
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), like(auditLogEntries.eventType, eventType)))
  )
  return rows.length
}

async function keyCount(key: string): Promise<number> {
  const rows = await withOrg(org.orgId, (tx) =>
    (tx as Tx)
      .select({ key: extensionAuditIdempotencyKeys.idempotencyKey })
      .from(extensionAuditIdempotencyKeys)
      .where(eq(extensionAuditIdempotencyKeys.idempotencyKey, key))
  )
  return rows.length
}

const attributionOf = (row: Row) =>
  (row.payload as Record<string, unknown>)['pvAttribution'] as Record<string, unknown> | undefined

async function memberSubject() {
  const sub = `user_${randomUUID()}`
  const { userId } = await linkDelegationActor(org.orgId, sub)
  return { sub, userId }
}

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-attribution-test-passphrase')
  org = await createDelegationOrg('attr')
})

afterEach(() => {
  vi.restoreAllMocks()
  sourceModule.__resetAuditEventSourceCountersForTests()
})

afterAll(async () => {
  await Promise.all(opened.map((app) => app.close()))
})

describe('Story 71.4 AC-4 — the row carries the verified actor, the signed time and the assertion', () => {
  it('attributes a linked member: pvAttribution under the HMAC, createdAt apart from occurredAt', async () => {
    const app = await boot()
    const { sub, userId } = await memberSubject()
    const eventType = nextEventType()
    const assertion = occ(3600)
    const out = await write(app, {
      sub,
      assertion,
      input: { eventType, idempotencyKey: `k-${randomUUID()}` },
    })
    const row = await rowOf(receiptOf(out).id)
    expect(row.actorType).toBe('extension')
    expect(row.actorTokenId).toBeNull()
    const attribution = attributionOf(row)
    expect(attribution).toEqual({
      v: 1,
      occurredAt: new Date((assertion.claims as { occ: number }).occ * 1000).toISOString(),
      occurredAtSource: 'delegation_signed',
      actor: {
        provider: 'centralizeme-handoff',
        subject: sub,
        userId,
        attestation: 'pv_verified',
        reason: null,
      },
      delegatedBy: {
        kid: DELEGATION_TEST_KID,
        issuer: 'https://app.centralizeme.com',
        assertionId: expect.stringMatching(/^jti-/),
      },
    })
    expect(row.payload).toMatchObject({ extensionName: MANIFEST_NAME })
    expect(row.createdAt.getTime()).toBeGreaterThan(
      Date.parse(attribution?.['occurredAt'] as string)
    )
    expect(receiptOf(out).createdAt).toBe(row.createdAt.toISOString())
  })

  it('records an unlinked actor with no user id, no nil UUID and no new external identity', async () => {
    const app = await boot()
    const sub = `user_unlinked_${randomUUID()}`
    const identitiesBefore = await withOrg(org.orgId, (tx) =>
      (tx as Tx).select({ id: externalIdentities.id }).from(externalIdentities)
    )
    const out = await write(app, { sub, assertion: occ(30) })
    const attribution = attributionOf(await rowOf(receiptOf(out).id))
    expect(attribution?.['actor']).toEqual({
      provider: 'centralizeme-handoff',
      subject: sub,
      userId: null,
      attestation: 'issuer_attested',
      reason: 'unlinked',
    })
    expect(JSON.stringify(attribution)).not.toContain(NIL_UUID)
    const identitiesAfter = await withOrg(org.orgId, (tx) =>
      (tx as Tx).select({ id: externalIdentities.id }).from(externalIdentities)
    )
    expect(identitiesAfter).toHaveLength(identitiesBefore.length)
  })

  it('records an admitted non-member as issuer_attested / not_current_member with the linked user id', async () => {
    const app = await boot()
    const sub = `user_${randomUUID()}`
    const { userId } = await linkDelegationActor(org.orgId, sub, { membership: 'deactivated' })
    const out = await write(app, { sub, assertion: occ(2 * DAY) })
    expect(attributionOf(await rowOf(receiptOf(out).id))?.['actor']).toMatchObject({
      userId,
      attestation: 'issuer_attested',
      reason: 'not_current_member',
    })
  })

  it('passes an actorId equal to the ambient subject and an occurredAt equal to the signed occ', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const assertion = occ(600)
    const iso = new Date((assertion.claims as { occ: number }).occ * 1000).toISOString()
    const out = await write(app, { sub, assertion, input: { actorId: sub, occurredAt: iso } })
    expect(out.receipt).toBeDefined()
    expect(attributionOf(await rowOf(receiptOf(out).id))?.['occurredAt']).toBe(iso)
  })

  it('attributes a delegated write with no occ to the actor, without a time', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const out = await write(app, { sub })
    const attribution = attributionOf(await rowOf(receiptOf(out).id))
    expect(attribution).not.toHaveProperty('occurredAt')
    expect(attribution?.['actor']).toMatchObject({ subject: sub })
  })

  it('stores the time as extension-declared, with no actor, outside a delegated request', async () => {
    const eventType = nextEventType()
    const receipt = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType,
      orgId: org.orgId,
      payload: { a: 1 },
      occurredAt: new Date(Date.now() - 2 * DAY * 1000).toISOString(),
    })
    const attribution = attributionOf(await rowOf(receipt.id))
    expect(attribution).toMatchObject({ v: 1, occurredAtSource: 'extension' })
    expect(attribution).not.toHaveProperty('actor')
    expect(attribution).not.toHaveProperty('delegatedBy')
  })

  it('writes no pvAttribution key at all, and the pre-71.4 payload, with neither (byte-identical, D7)', async () => {
    const receipt = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: nextEventType(),
      orgId: org.orgId,
      payload: { a: 1 },
    })
    const row = await rowOf(receipt.id)
    expect(row.payload).toEqual({ a: 1, extensionName: MANIFEST_NAME })
  })
})

describe('Story 71.4 AC-4 — typed rejections write nothing and consume nothing', () => {
  type Case = {
    name: string
    code: string
    delegation?: Record<string, unknown>
    sub?: 'member' | 'unlinked'
    assertion?: AssertionOptions
    input?: Record<string, unknown>
    orgId?: 'other'
  }
  const old = (ageSeconds: number) => new Date(Date.now() - ageSeconds * 1000).toISOString()
  const cases: Case[] = [
    { name: 'a different actorId', code: 'actor_mismatch', input: { actorId: 'someone_else' } },
    { name: 'an empty actorId', code: 'actor_id_invalid', input: { actorId: '' } },
    { name: 'a non-string actorId', code: 'actor_id_invalid', input: { actorId: 7 } },
    { name: 'a text occurredAt', code: 'occurred_at_invalid', input: { occurredAt: 'yesterday' } },
    {
      name: 'an impossible date',
      code: 'occurred_at_invalid',
      input: { occurredAt: '2026-13-01T00:00:00Z' },
    },
    { name: 'a numeric occurredAt', code: 'occurred_at_invalid', input: { occurredAt: 1_790 } },
    {
      name: 'another org than the delegated one',
      code: 'delegation_org_mismatch',
      orgId: 'other',
    },
    {
      name: 'a reserved payload key',
      code: 'reserved_payload_key',
      input: { payload: { pvAttribution: { forged: true } } },
    },
    {
      name: 'an occurredAt that differs from the signed occ',
      code: 'occurred_at_mismatch',
      assertion: occ(600),
      input: { occurredAt: old(500) },
    },
    {
      name: 'an unattested occurredAt older than 90 s',
      code: 'occurred_at_unattested',
      input: { occurredAt: old(300) },
    },
    {
      name: 'an occurredAt in the future',
      code: 'occurred_at_in_future',
      input: { occurredAt: new Date(Date.now() + 120_000).toISOString() },
    },
    {
      name: 'an occurredAt older than the 30 day cap',
      code: 'occurred_at_too_old',
      input: { occurredAt: old(31 * DAY) },
    },
  ]

  it.each(cases)('$name -> $code, no row, no key, no quota consumed', async (testCase) => {
    const app = await boot()
    const { sub } = await memberSubject()
    const gate = vi.spyOn(quotaGate, 'assertOrgMayWriteAuditGates')
    const idempotencyKey = `k-${randomUUID()}`
    const eventType = nextEventType()
    const other = await createDelegationOrg('other-org')
    const out = await write(app, {
      sub,
      assertion: testCase.assertion,
      orgId: testCase.orgId ? other.orgId : undefined,
      input: { eventType, idempotencyKey, ...testCase.input },
    })
    expect(out.error).toEqual({ name: REJECTED, code: testCase.code })
    expect(await rowCount(eventType)).toBe(0)
    expect(await rowCount(eventType, other.orgId)).toBe(0)
    expect(await keyCount(idempotencyKey)).toBe(0)
    expect(gate).not.toHaveBeenCalled()
    const counters = sourceModule.getAuditEventSourceCounters()
    expect(counters).toMatchObject({ succeeded: 0, rejected: 1 })
  })

  it('rejects an actorId when no delegated request is in progress (never records an unverified actor)', async () => {
    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, {
        eventType: nextEventType(),
        orgId: org.orgId,
        payload: {},
        actorId: 'someone',
      })
    ).rejects.toMatchObject({ name: REJECTED, code: 'actor_requires_delegation', retryable: false })
  })

  it('never writes a rejection to audit_log_entries', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const before = await withOrg(org.orgId, (tx) =>
      (tx as Tx).execute(sql`select count(*)::int as n from audit_log_entries`)
    )
    await write(app, { sub, input: { actorId: 'someone_else' } })
    const after = await withOrg(org.orgId, (tx) =>
      (tx as Tx).execute(sql`select count(*)::int as n from audit_log_entries`)
    )
    expect(Array.from(after as never)).toEqual(Array.from(before as never))
  })
})

describe('Story 71.4 AC-4 — tenant isolation and non-delegated callers', () => {
  it('never attributes an assertion for org A to a row in org B; a B-only link stays unlinked in A', async () => {
    const app = await boot()
    const orgB = await createDelegationOrg('attr-b')
    const sub = `user_${randomUUID()}`
    await linkDelegationActor(orgB.orgId, sub)
    const eventType = nextEventType()
    const denied = await write(app, { sub, orgId: orgB.orgId, input: { eventType } })
    expect(denied.error?.code).toBe('delegation_org_mismatch')
    expect(await rowCount(eventType, orgB.orgId)).toBe(0)
    const ok = await write(app, { sub })
    expect(attributionOf(await rowOf(receiptOf(ok).id))?.['actor']).toMatchObject({
      userId: null,
      reason: 'unlinked',
    })
  })

  it('has no ambient delegation on a plain call or a call made after the request finished', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    await write(app, { sub })
    const receipt = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: nextEventType(),
      orgId: org.orgId,
      payload: {},
    })
    expect((await rowOf(receipt.id)).payload).not.toHaveProperty('pvAttribution')
  })
})

describe('Story 71.4 AC-5 — idempotency interplay', () => {
  it('replays a retry that carries a FRESH assertion (new jti): same key, same actor, same time', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const key = `k-${randomUUID()}`
    const eventType = nextEventType()
    const assertion = occ(3600)
    const first = await write(app, { sub, assertion, input: { eventType, idempotencyKey: key } })
    const retry = await write(app, {
      sub,
      assertion: { claims: { ...assertion.claims, jti: `jti-retry-${randomUUID()}` } },
      input: { eventType, idempotencyKey: key },
    })
    expect(retry.receipt).toEqual(first.receipt)
    expect(await rowCount(eventType)).toBe(1)
    expect(sourceModule.getAuditEventSourceCounters()).toMatchObject({ succeeded: 1, deduped: 1 })
  })

  it('replays the original receipt when the actor stopped being a member between the write and its retry', async () => {
    const app = await boot()
    const { sub, userId } = await memberSubject()
    const key = `k-${randomUUID()}`
    const eventType = nextEventType()
    const assertion = occ(3600)
    const first = await write(app, { sub, assertion, input: { eventType, idempotencyKey: key } })
    await withOrg(org.orgId, (tx) =>
      (tx as Tx)
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(and(eq(orgMemberships.orgId, org.orgId), eq(orgMemberships.userId, userId)))
    )
    const retry = await write(app, {
      sub,
      assertion: { claims: { ...assertion.claims, jti: `jti-retry-${randomUUID()}` } },
      input: { eventType, idempotencyKey: key },
    })
    expect(retry.error).toBeUndefined()
    expect(retry.receipt).toEqual(first.receipt)
    expect(await rowCount(eventType)).toBe(1)
    expect(attributionOf(await rowOf(receiptOf(first).id))?.['actor']).toMatchObject({
      attestation: 'pv_verified',
    })
  })

  it('conflicts when the same key arrives with a different time or a different actor; first row untouched', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const other = await memberSubject()
    const key = `k-${randomUUID()}`
    const eventType = nextEventType()
    const first = await write(app, {
      sub,
      assertion: occ(3600),
      input: { eventType, idempotencyKey: key },
    })
    const differentTime = await write(app, {
      sub,
      assertion: occ(1800),
      input: { eventType, idempotencyKey: key },
    })
    const differentActor = await write(app, {
      sub: other.sub,
      assertion: occ(3600),
      input: { eventType, idempotencyKey: key },
    })
    const conflict = { name: 'ExtensionAuditIdempotencyConflictError', code: null }
    expect(differentTime.error).toEqual(conflict)
    expect(differentActor.error).toEqual(conflict)
    expect(await rowCount(eventType)).toBe(1)
    expect((await rowOf(receiptOf(first).id)).payload).toMatchObject({
      extensionName: MANIFEST_NAME,
    })
  })

  it('writes exactly one row for two concurrent first writes with different jtis; the winner assertion is stored', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const key = `k-${randomUUID()}`
    const eventType = nextEventType()
    const assertion = occ(3600)
    const jtis = [`jti-a-${randomUUID()}`, `jti-b-${randomUUID()}`]
    const outcomes = await Promise.all(
      jtis.map((jti) =>
        write(app, {
          sub,
          assertion: { claims: { ...assertion.claims, jti } },
          input: { eventType, idempotencyKey: key },
        })
      )
    )
    expect(receiptOf(outcomes[0]).id).toBeDefined()
    expect(receiptOf(outcomes[1]).id).toBe(receiptOf(outcomes[0]).id)
    expect(await rowCount(eventType)).toBe(1)
    const stored = attributionOf(await rowOf(receiptOf(outcomes[0]).id))
    expect(jtis).toContain((stored?.['delegatedBy'] as { assertionId: string }).assertionId)
  })

  it('still rejects an out-of-contract replay: attribution checks run before the replay lookup, and a replay takes no gate', async () => {
    const app = await boot()
    const { sub } = await memberSubject()
    const key = `k-${randomUUID()}`
    const eventType = nextEventType()
    await write(app, { sub, assertion: occ(3600), input: { eventType, idempotencyKey: key } })
    const gate = vi.spyOn(quotaGate, 'assertOrgMayWriteAuditGates')
    const bad = await write(app, {
      sub,
      assertion: occ(3600),
      input: { eventType, idempotencyKey: key, actorId: 'someone_else' },
    })
    expect(bad.error).toEqual({ name: REJECTED, code: 'actor_mismatch' })
    const replay = await write(app, {
      sub,
      assertion: occ(3600),
      input: { eventType, idempotencyKey: key },
    })
    expect(replay.receipt).toBeDefined()
    expect(gate).not.toHaveBeenCalled()
  })
})

describe('Story 71.4 AC-6 — chain, verification and retention', () => {
  it('verifies a chain holding attributed, unattributed and legacy rows; a flipped attestation breaks the HMAC', async () => {
    const chainOrg = await createDelegationOrg('chain')
    const sub = `user_${randomUUID()}`
    const { userId } = await linkDelegationActor(chainOrg.orgId, sub)
    expect(userId).toBeDefined()
    const attributed = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: nextEventType(),
      orgId: chainOrg.orgId,
      payload: {},
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    })
    const plain = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: nextEventType(),
      orgId: chainOrg.orgId,
      payload: { plain: true },
    })
    const result = await withOrg(chainOrg.orgId, (tx) =>
      verifyAuditRange(tx as Tx, {
        orgId: chainOrg.orgId,
        from: new Date(Date.now() - 600_000).toISOString(),
        to: new Date(Date.now() + 600_000).toISOString(),
      })
    )
    expect(result.failed).toEqual([])
    expect(plain.id).not.toBe(attributed.id)

    const row = await rowOf(attributed.id, chainOrg.orgId)
    const recompute = (payload: unknown) =>
      computeAuditHmac(
        {
          orgId: row.orgId,
          actorTokenId: row.actorTokenId,
          actorType: row.actorType,
          eventType: row.eventType,
          resourceId: row.resourceId ?? undefined,
          resourceType: row.resourceType ?? undefined,
          payload: payload as Record<string, unknown>,
          keyVersion: row.keyVersion,
          previousEntryHmac: row.previousEntryHmac ?? GENESIS_SENTINEL,
        },
        getAuditKey()
      )
    const forged = JSON.parse(JSON.stringify(row.payload)) as Record<
      string,
      Record<string, unknown>
    >
    forged['pvAttribution'] = { ...forged['pvAttribution'], occurredAtSource: 'delegation_signed' }
    expect(recompute(forged)).not.toBe(row.hmac)
  })

  it('does not let an old occurredAt make a row purgeable: retention follows createdAt only', async () => {
    const receipt = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: nextEventType(),
      orgId: org.orgId,
      payload: {},
      occurredAt: new Date(Date.now() - 29 * DAY * 1000).toISOString(),
    })
    const cutoff = new Date(Date.now() - DAY * 1000).toISOString()
    await withOrg(org.orgId, (tx) =>
      (tx as Tx).execute(
        sql`SELECT purge_expired_audit_log_entries(${org.orgId}::uuid, ${cutoff}::timestamptz)`
      )
    )
    expect((await rowOf(receipt.id)).id).toBe(receipt.id)
  })
})

describe('Story 71.4 AC-7 — logs carry only the audited event type and the closed reason', () => {
  it('never logs the actor subject, jti, kid, occurredAt value or payload on success or rejection', async () => {
    logCapture.lines.length = 0
    const app = await boot()
    const sub = `${SENTINEL_SUBJECT}-${randomUUID()}`
    await linkDelegationActor(org.orgId, sub)
    const jti = `jti-log-${randomUUID()}`
    const assertion = { claims: { ...occ(3600).claims, jti } }
    const secretValue = `payload-secret-${randomUUID()}`
    const occurredAt = new Date(Date.now() - 5 * 60_000).toISOString()
    await write(app, { sub, assertion, input: { payload: { secretValue } } })
    await write(app, { sub, input: { payload: { secretValue }, occurredAt } })
    const boundary = parseCapturedLogLines(logCapture.lines).filter((line) =>
      String(line['eventType'] ?? '').startsWith('extension_audit_event')
    )
    const logged = JSON.stringify(boundary)
    expect(boundary.length).toBeGreaterThanOrEqual(2)
    expect(logged).toContain('occurred_at_unattested')
    for (const forbidden of [sub, jti, secretValue, occurredAt, DELEGATION_TEST_KID]) {
      expect(logged).not.toContain(forbidden)
    }
  })
})
