import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import postgres from 'postgres'
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test'
import { enrollMfaDirect, superuserDatabaseUrl, withDatabase } from '../fixtures/db.js'
import {
  auditRowCount,
  auditRows,
  auditSourceCounters,
  burnedJtiCount,
  countTable,
  delegationOutcomeTotals,
  GATE_KEY,
  GATE_URL,
  HISTORICAL_WINDOW_SECONDS,
  linkOrgToCentralizeMe,
  newEventType,
  outcomeDeltas,
  postDelegated,
  securityEventCount,
  seedActor,
  seedLinkedOrg,
  WRITE_KEY,
  WRITE_URL,
  type DelegatedResponse,
  type SeededOrg,
} from '../fixtures/delegation-audit.js'
import {
  DELEGATION_E2E_INSTANCE_ID,
  DELEGATION_E2E_ISSUER,
  DELEGATION_E2E_KID,
  DELEGATION_E2E_PROVIDER,
  delegationE2ePrivateKey,
  delegationE2eVerifyKeysJson,
  signDelegationE2eAssertion,
} from '../fixtures/delegation-test-key.js'
import { mintHandoffToken, type SeededHandoffUser } from '../fixtures/handoff.js'
import {
  HANDOFF_E2E_ISSUER,
  HANDOFF_E2E_KID,
  handoffE2ePrivateKey,
  handoffE2ePublicKeyPem,
} from '../fixtures/handoff-test-key.js'
import {
  allocateFreePort,
  createIsolatedDatabase,
  initIsolatedVault,
  registerAndLoginIsolated,
  spawnIsolatedApiProcess,
  spawnIsolatedWebProcess,
  stopProcess,
  dropIsolatedDatabase,
} from '../fixtures/isolated-stack-shared.js'

/**
 * J36 (Story 71.5): the real-host end-to-end proof of Epic 71. A real `apps/api` process (not a
 * Fastify instance built in a test), booted with the real extension loader on the fixture
 * extension `@project-vault/mock-delegation-audit-extension`, real env parsing of BOTH key sets
 * (delegation and handoff), real `secureRoute`, real replay store and a real audit sink, receives
 * service-delegated audit writes signed by the test-only signer
 * (`fixtures/delegation-test-key.ts`) and the audit reader and export read them back over HTTP.
 *
 * The api child is spawned like j19..j27 against a dedicated database on the compose DB server
 * (the stack/DB comes from `scripts/e2e-stack.sh`), so it does not disturb the shared stack, which
 * loads exactly one extension and carries the j31 handoff verifier.
 *
 * Rules: every case mints its assertion just before its request and is keyed by seeded ids, a
 * minted `jti` or a unique event type, never "the latest row"; expired / not-yet-valid cases are
 * signed with an explicit past / future `iat`, never by sleeping; no hardcoded ports.
 *
 * Rows of the story's AC-4 matrix that this journey does not exercise over HTTP are listed in the
 * story file (71-5) with the in-process suite that covers them.
 */

const DB_NAME = 'project_vault_j36_delegated_audit_e2e'
// A throwaway per-run credential, generated rather than committed.
// With J36_KEEP_STACK=1 the run leaves its api and web processes and database up, so a person can
// open Settings -> Audit on the real delegated rows (Chrome pass); the owner's login value then
// comes from J36_OWNER_PASS, so nothing secret is ever printed.
const KEEP_STACK = process.env['J36_KEEP_STACK'] === '1'
const E2E_PASS_VALUE = process.env['J36_OWNER_PASS'] ?? `Pw-${randomUUID()}-aA1!`
const MINUTE = 60
const DAY = 86_400
const AUDIT_BASE = '/api/v1/org/audit'
const UNLINKED_REASON = 'unlinked'
const NOT_MEMBER_REASON = 'not_current_member'
const ISSUER_ATTESTED = 'issuer_attested'
const WWW_AUTHENTICATE = 'www-authenticate'

let sql: postgres.Sql
let apiBase = ''
let keptWebPort = 0
let apiProcess: ChildProcess | undefined
let ownerApi: APIRequestContext
let ownerUserId = ''
const ownerEmail = `j36-owner-${randomUUID()}@example.test`
let orgA: SeededOrg
let orgB: SeededOrg
const childOutput: string[] = []
const issuedTokens: string[] = []
const responseBodies: string[] = []

const nowSeconds = () => Math.floor(Date.now() / 1000)

function handoffVerifyKeysJson(): string {
  return JSON.stringify([{ kid: HANDOFF_E2E_KID, publicKeyPem: handoffE2ePublicKeyPem() }])
}

test.describe.serial('J36 — Epic 71 real-host proof: delegated, idempotent audit writes', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    // Never inherit a real key set into the child (it would be merged under the test one).
    expect(
      process.env['VAULT_DELEGATION_VERIFY_KEYS'],
      'j36 must not run with a real VAULT_DELEGATION_VERIFY_KEYS in the environment'
    ).toBeUndefined()

    const webPort = await allocateFreePort()
    keptWebPort = webPort
    await createIsolatedDatabase(DB_NAME)
    const api = await spawnIsolatedApiProcess({
      dbName: DB_NAME,
      webPort,
      logLabel: 'api-delegated-audit',
      logLevelEnvVar: 'J36_DEBUG_LOG_LEVEL',
      onOutput: (chunk) => childOutput.push(chunk),
      extraEnv: {
        VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-delegation-audit-extension',
        LOG_LEVEL: 'debug',
        // Delegation: only the test key's public half, for the one test audience.
        VAULT_DELEGATION_VERIFY_KEYS: delegationE2eVerifyKeysJson(),
        VAULT_HANDOFF_INSTANCE_ID: DELEGATION_E2E_INSTANCE_ID,
        // Handoff on the same child (D4): the cross-verifier cases need both verifiers live.
        VAULT_HANDOFF_ENABLED: 'true',
        VAULT_HANDOFF_ISSUER: HANDOFF_E2E_ISSUER,
        VAULT_HANDOFF_VERIFY_KEYS: handoffVerifyKeysJson(),
      },
    })
    apiProcess = api.process
    apiBase = `http://localhost:${api.port}`
    await initIsolatedVault(api.port, 'j36-delegated-audit-e2e-passphrase')
    if (KEEP_STACK) {
      await spawnIsolatedWebProcess({ port: webPort, apiPort: api.port, logLabel: 'web-j36' })
    }

    sql = postgres(withDatabase(superuserDatabaseUrl(), DB_NAME), { max: 2 })
    ownerApi = await playwrightRequest.newContext()
    const owner = await registerAndLoginIsolated(ownerApi, apiBase, {
      email: ownerEmail,
      password: E2E_PASS_VALUE,
      orgName: `J36 Org A ${randomUUID()}`,
    })
    ownerUserId = owner.userId
    await enrollMfaDirect(owner.userId, DB_NAME)
    orgA = await linkOrgToCentralizeMe(sql, owner.orgId)
    orgB = await seedLinkedOrg(sql, 'org-b')
  })

  test.afterAll(async () => {
    await ownerApi?.dispose()
    await sql?.end({ timeout: 5 })
    if (KEEP_STACK) {
      process.stdout.write(
        `J36_KEEP_STACK: api ${apiBase}, web http://localhost:${keptWebPort}, owner ${ownerEmail}\n`
      )
      return
    }
    if (apiProcess) await stopProcess(apiProcess)
    await dropIsolatedDatabase(DB_NAME)
  })

  /** A delegated write to org A (or `org`), recording the token for the final secret sweep. */
  async function write(
    sub: string,
    payload: Record<string, unknown>,
    options: Partial<Parameters<typeof postDelegated>[0]> = {}
  ): Promise<DelegatedResponse> {
    const response = await postDelegated({
      apiBase,
      org: orgA.cmOrgId,
      sub,
      payload,
      ...options,
    })
    issuedTokens.push(response.token)
    responseBodies.push(response.raw)
    return response
  }

  const baseBody = (eventType: string, extra: Record<string, unknown> = {}) => ({
    eventType,
    resourceType: 'j36_thing',
    resourceId: randomUUID(),
    payload: { note: 'j36' },
    ...extra,
  })

  const receiptOf = (response: DelegatedResponse) =>
    response.body['data'] as { id: string; createdAt: string }
  const errorOf = (response: DelegatedResponse) =>
    response.body['error'] as { name: string; code: string | null }
  const codeOf = (response: DelegatedResponse) => response.body['code']

  /** Runs `act` and returns it with the counter deltas it caused. */
  async function withCounters<T>(act: () => Promise<T>) {
    const before = await delegationOutcomeTotals(apiBase)
    const result = await act()
    const after = await delegationOutcomeTotals(apiBase)
    return { result, deltas: outcomeDeltas(before, after) }
  }

  // ---- AC-2: cross-verifier confusion on the real process ----------------------------------

  test('AC-2: a handoff login token sent as PV-Delegation is rejected like garbage, with no state', async () => {
    const subject: Pick<SeededHandoffUser, 'workosUserId' | 'centralizemeOrganizationId'> = {
      workosUserId: `user_j36_${randomUUID()}`,
      centralizemeOrganizationId: orgA.cmOrgId,
    }
    const handoff = mintHandoffToken(subject, { instanceId: DELEGATION_E2E_INSTANCE_ID })
    const eventType = newEventType('confusion')
    const eventsBefore = await countTable(sql, 'platform_security_events')

    const garbage = await write('sub', baseBody(eventType), { token: 'garbage.token.value' })
    const { result: confused, deltas } = await withCounters(() =>
      write('sub', baseBody(eventType), { token: handoff.token })
    )

    expect(confused.status).toBe(401)
    expect(confused.body).toEqual({
      code: 'delegation_invalid',
      message: 'Delegation assertion is invalid',
    })
    expect(confused.status).toBe(garbage.status)
    expect(confused.body).toEqual(garbage.body)
    expect(confused.headers.get(WWW_AUTHENTICATE)).toBe('PV-Delegation')
    expect(confused.headers.get(WWW_AUTHENTICATE)).toBe(garbage.headers.get(WWW_AUTHENTICATE))
    // Pre-signature (the typ is not pv-delegation+jwt): the counter is the only signal; no event
    // row, no burn, no audit row.
    expect(deltas).toEqual({ malformed: 1 })
    expect(await countTable(sql, 'platform_security_events')).toBe(eventsBefore)
    expect(await burnedJtiCount(sql, orgA.orgId, handoff.jti)).toBe(0)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
  })

  test('AC-2: a delegation assertion posted to the handoff prepare endpoint is rejected before any state change', async () => {
    const before = {
      pending: await countTable(sql, 'handoff_pending_states'),
      sessions: await countTable(sql, 'sessions'),
      jtis: await countTable(sql, 'handoff_token_jti'),
    }
    const assertion = signDelegationE2eAssertion({
      apiBase,
      org: orgA.cmOrgId,
      sub: 'sub',
      op: 'POST /api/v1/auth/handoff/prepare',
      body: '{}',
    })
    issuedTokens.push(assertion)
    const response = await fetch(`${apiBase}/api/v1/auth/handoff/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: assertion }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'handoff_rejected' })
    expect({
      pending: await countTable(sql, 'handoff_pending_states'),
      sessions: await countTable(sql, 'sessions'),
      jtis: await countTable(sql, 'handoff_token_jti'),
    }).toEqual(before)
  })

  test('AC-2: a token signed by the HANDOFF key but labelled pv-delegation+jwt is rejected as an unknown kid', async () => {
    const eventType = newEventType('handoff_key')
    const eventsBefore = await countTable(sql, 'platform_security_events')
    const { result, deltas } = await withCounters(() =>
      write('sub', baseBody(eventType), {
        assertion: { signingKey: handoffE2ePrivateKey(), header: { kid: HANDOFF_E2E_KID } },
      })
    )
    expect(result.status).toBe(401)
    expect(codeOf(result)).toBe('delegation_invalid')
    expect(deltas).toEqual({ unknown_kid: 1 })
    expect(await countTable(sql, 'platform_security_events')).toBe(eventsBefore)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
  })

  // ---- AC-3: the happy path writes exactly one attributed row ------------------------------

  let happyEventType = ''
  let happyKey = ''
  let happyActor: { sub: string; userId: string }
  let happyReceipt: { id: string; createdAt: string }
  let happyBody: Record<string, unknown>
  let happyOcc = 0

  test('AC-3: a trusted service writes exactly one attributed audit row, and the chain verifies', async () => {
    happyActor = await seedActor(sql, orgA.orgId, 'active')
    happyEventType = newEventType('happy')
    happyKey = `k-${randomUUID()}`
    happyOcc = nowSeconds() - 2 * MINUTE
    happyBody = baseBody(happyEventType, { idempotencyKey: happyKey })

    const { result, deltas } = await withCounters(() =>
      write(happyActor.sub, happyBody, { assertion: { claims: { occ: happyOcc } } })
    )
    expect(result.status, result.raw).toBe(200)
    expect(deltas).toEqual({ accepted: 1 })
    happyReceipt = receiptOf(result)

    const rows = await auditRows(sql, orgA.orgId, happyEventType)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      id: happyReceipt.id,
      org_id: orgA.orgId,
      actor_type: 'extension',
      resource_type: 'j36_thing',
      resource_id: happyBody['resourceId'],
    })
    const occurredAt = new Date(happyOcc * 1000).toISOString()
    expect(row?.payload['pvAttribution']).toEqual({
      v: 1,
      occurredAt,
      occurredAtSource: 'delegation_signed',
      actor: {
        provider: DELEGATION_E2E_PROVIDER,
        subject: happyActor.sub,
        userId: happyActor.userId,
        attestation: 'pv_verified',
        reason: null,
      },
      delegatedBy: {
        kid: DELEGATION_E2E_KID,
        issuer: DELEGATION_E2E_ISSUER,
        assertionId: result.jti,
      },
    })
    expect(row?.created_at.getTime()).toBeGreaterThan(Date.parse(occurredAt))
    expect(await burnedJtiCount(sql, orgA.orgId, result.jti)).toBe(1)

    const verify = await ownerApi.get(
      `${apiBase}${AUDIT_BASE}/verify?from=${encodeURIComponent(new Date(Date.now() - DAY * 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + MINUTE * 1000).toISOString())}`
    )
    expect(verify.ok(), await verify.text()).toBeTruthy()
    const verified = (await verify.json()) as { data: { passed: number; failedCount: number } }
    expect(verified.data.failedCount).toBe(0)
    expect(verified.data.passed).toBeGreaterThan(0)
  })

  // ---- AC-4: the outcome matrix -----------------------------------------------------------

  test('AC-4: replaying the same request (same jti) answers 409 delegation_replayed and keeps one row', async () => {
    // A REPLAY resends the very same signed request, so sign once and send it twice.
    const replayBody = baseBody(newEventType('replay'))
    const original = await write(happyActor.sub, replayBody)
    expect(original.status).toBe(200)
    const eventsBefore = await securityEventCount(sql, 'replayed')
    const { result: replay, deltas } = await withCounters(() =>
      write(happyActor.sub, replayBody, { token: original.token })
    )
    expect(replay.status).toBe(409)
    expect(codeOf(replay)).toBe('delegation_replayed')
    expect(deltas).toEqual({ replayed: 1 })
    expect(await auditRowCount(sql, orgA.orgId, replayBody.eventType)).toBe(1)
    expect(await burnedJtiCount(sql, orgA.orgId, original.jti)).toBe(1)
    expect(await securityEventCount(sql, 'replayed')).toBe(eventsBefore + 1)
  })

  test('AC-4: a lost-response retry (same key, same content, fresh jti) returns the ORIGINAL receipt and one row', async () => {
    const before = await auditSourceCounters(apiBase)
    const retry = await write(happyActor.sub, happyBody, {
      assertion: { claims: { occ: happyOcc } },
    })
    expect(retry.status, retry.raw).toBe(200)
    expect(receiptOf(retry)).toEqual(happyReceipt)
    expect(await auditRowCount(sql, orgA.orgId, happyEventType)).toBe(1)
    const after = await auditSourceCounters(apiBase)
    expect(after.deduped).toBe(before.deduped + 1)
    // The fresh assertion was burned even though no row was written.
    expect(await burnedJtiCount(sql, orgA.orgId, retry.jti)).toBe(1)
  })

  test('AC-4: reusing the key with different content, a different time or a different actor is a typed non-retryable conflict', async () => {
    const otherActor = await seedActor(sql, orgA.orgId, 'active')
    const attempts = [
      write(
        happyActor.sub,
        { ...happyBody, payload: { note: 'different content' } },
        {
          assertion: { claims: { occ: happyOcc } },
        }
      ),
      write(happyActor.sub, happyBody, { assertion: { claims: { occ: happyOcc - 10 } } }),
      write(otherActor.sub, happyBody, { assertion: { claims: { occ: happyOcc } } }),
    ]
    const results = await Promise.all(attempts)
    for (const result of results) {
      expect(result.status, result.raw).toBe(409)
      expect(errorOf(result).name).toBe('ExtensionAuditIdempotencyConflictError')
    }
    expect(await auditRowCount(sql, orgA.orgId, happyEventType)).toBe(1)
  })

  test('AC-4: an unlinked actor is admitted as issuer_attested / unlinked with no user id', async () => {
    const sub = `user_unlinked_${randomUUID()}`
    const eventType = newEventType('unlinked')
    const { result, deltas } = await withCounters(() =>
      write(sub, baseBody(eventType), { assertion: { claims: { occ: nowSeconds() - 10 } } })
    )
    expect(result.status, result.raw).toBe(200)
    expect(deltas).toEqual({ accepted: 1, actor_unlinked: 1 })
    const [row] = await auditRows(sql, orgA.orgId, eventType)
    expect((row?.payload['pvAttribution'] as { actor: unknown }).actor).toEqual({
      provider: DELEGATION_E2E_PROVIDER,
      subject: sub,
      userId: null,
      attestation: ISSUER_ATTESTED,
      reason: UNLINKED_REASON,
    })
  })

  test('AC-4: a revoked actor within the route window is admitted as issuer_attested / not_current_member', async () => {
    const revoked = await seedActor(sql, orgA.orgId, 'deactivated')
    const eventType = newEventType('revoked_in')
    const { result, deltas } = await withCounters(() =>
      write(revoked.sub, baseBody(eventType), {
        assertion: { claims: { occ: nowSeconds() - 10 * MINUTE } },
      })
    )
    expect(result.status, result.raw).toBe(200)
    expect(deltas).toEqual({ accepted: 1, actor_attested_nonmember: 1 })
    const [row] = await auditRows(sql, orgA.orgId, eventType)
    expect((row?.payload['pvAttribution'] as { actor: unknown }).actor).toEqual({
      provider: DELEGATION_E2E_PROVIDER,
      subject: revoked.sub,
      userId: revoked.userId,
      attestation: ISSUER_ATTESTED,
      reason: NOT_MEMBER_REASON,
    })
  })

  test('AC-4: a revoked actor with an occ outside the window answers 400 and burns nothing', async () => {
    const revoked = await seedActor(sql, orgA.orgId, 'deactivated')
    const eventType = newEventType('revoked_out')
    const eventsBefore = await securityEventCount(sql, 'occurrence_outside_window')
    const { result, deltas } = await withCounters(() =>
      write(revoked.sub, baseBody(eventType), {
        assertion: { claims: { occ: nowSeconds() - HISTORICAL_WINDOW_SECONDS - 5 * MINUTE } },
      })
    )
    expect(result.status).toBe(400)
    expect(codeOf(result)).toBe('delegation_occurrence_outside_window')
    expect(deltas).toEqual({ occurrence_outside_window: 1 })
    expect(await burnedJtiCount(sql, orgA.orgId, result.jti)).toBe(0)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
    expect(await securityEventCount(sql, 'occurrence_outside_window')).toBe(eventsBefore + 1)
  })

  test('AC-4: a revoked actor with no occ answers 403 delegation_actor_not_member and the jti is burned', async () => {
    const revoked = await seedActor(sql, orgA.orgId, 'deactivated')
    const eventType = newEventType('revoked_no_occ')
    const { result, deltas } = await withCounters(() => write(revoked.sub, baseBody(eventType)))
    expect(result.status).toBe(403)
    expect(codeOf(result)).toBe('delegation_actor_not_member')
    expect(deltas).toEqual({ actor_not_member: 1 })
    expect(await burnedJtiCount(sql, orgA.orgId, result.jti)).toBe(1)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
  })

  test('AC-4: a capability disabled for the org is a documented denial with no row, and re-enabling restores the write', async () => {
    const actor = await seedActor(sql, orgA.orgId, 'active')
    const control = (deny: boolean) => write(actor.sub, { deny }, { url: GATE_URL, op: GATE_KEY })
    expect((await control(true)).status).toBe(200)
    const eventType = newEventType('gated')
    const denied = await write(actor.sub, baseBody(eventType))
    expect(denied.status).toBe(403)
    expect(codeOf(denied)).toBe('capability_denied')
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
    expect((await control(false)).status).toBe(200)
    const restored = await write(actor.sub, baseBody(eventType))
    expect(restored.status, restored.raw).toBe(200)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(1)
  })

  const wrongKey = generateKeyPairSync('ed25519').privateKey
  const rejectionRows = [
    {
      name: 'a bad signature',
      status: 401,
      code: 'delegation_invalid',
      outcome: 'signature_invalid',
      event: false,
      assertion: () => ({ signingKey: wrongKey }),
    },
    {
      name: 'a wrong body hash',
      status: 400,
      code: 'delegation_body_mismatch',
      outcome: 'body_mismatch',
      event: true,
      assertion: () => ({ claims: { bsh: 'A'.repeat(43) } }),
    },
    {
      name: 'a wrong operation',
      status: 403,
      code: 'delegation_operation_mismatch',
      outcome: 'operation_mismatch',
      event: true,
      assertion: () => ({ claims: { op: 'POST /api/v1/ext/mock-delegation/other' } }),
    },
    {
      name: 'an expired assertion',
      status: 401,
      code: 'delegation_expired',
      outcome: 'expired',
      event: true,
      assertion: () => ({ claims: { iat: nowSeconds() - 200, exp: nowSeconds() - 150 } }),
    },
    {
      name: 'an assertion issued in the future beyond the skew',
      status: 401,
      code: 'delegation_not_yet_valid',
      outcome: 'clock_skew',
      event: true,
      assertion: () => ({ claims: { iat: nowSeconds() + 120, exp: nowSeconds() + 165 } }),
    },
    {
      name: 'a wrong audience',
      status: 421,
      code: 'delegation_wrong_instance',
      outcome: 'audience_mismatch',
      event: true,
      assertion: () => ({ claims: { aud: 'pvd:some-other-instance' } }),
    },
  ]

  for (const row of rejectionRows) {
    test(`AC-4: ${row.name} answers ${row.status} ${row.code} and writes no audit row`, async () => {
      const eventType = newEventType('rejected')
      const eventsBefore = await securityEventCount(sql, row.outcome)
      const { result, deltas } = await withCounters(() =>
        write('sub', baseBody(eventType), { assertion: row.assertion() })
      )
      expect(result.status, result.raw).toBe(row.status)
      expect(codeOf(result)).toBe(row.code)
      expect(deltas).toEqual({ [row.outcome]: 1 })
      expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
      expect(await securityEventCount(sql, row.outcome)).toBe(eventsBefore + (row.event ? 1 : 0))
    })
  }

  test('AC-4: a plain session cookie on the delegated route is rejected with no substitute', async () => {
    const eventType = newEventType('session')
    const response = await ownerApi.post(`${apiBase}${WRITE_URL}`, {
      data: baseBody(eventType),
    })
    expect(response.status()).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'delegation_invalid' })
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
  })

  test('AC-4: an assertion for org B writes nothing visible to org A', async () => {
    const actorB = await seedActor(sql, orgB.orgId, 'active')
    const eventType = newEventType('tenant')
    const result = await write(actorB.sub, baseBody(eventType), { org: orgB.cmOrgId })
    expect(result.status, result.raw).toBe(200)
    expect(await auditRowCount(sql, orgB.orgId, eventType)).toBe(1)
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(0)
    const search = await ownerApi.get(
      `${apiBase}${AUDIT_BASE}/events?eventType=${encodeURIComponent(eventType)}`
    )
    expect(search.ok()).toBeTruthy()
    expect(((await search.json()) as { total: number }).total).toBe(0)
  })

  test('AC-4: two simultaneous presentations of the same assertion yield one 200, one 409 and one row', async () => {
    const actor = await seedActor(sql, orgA.orgId, 'active')
    const eventType = newEventType('race')
    const raced = baseBody(eventType)
    const token = signDelegationE2eAssertion({
      apiBase,
      org: orgA.cmOrgId,
      sub: actor.sub,
      op: WRITE_KEY,
      body: JSON.stringify(raced),
    })
    issuedTokens.push(token)
    const both = await Promise.all([
      write(actor.sub, raced, { token }),
      write(actor.sub, raced, { token }),
    ])
    expect(both.map((response) => response.status).sort()).toEqual([200, 409])
    expect(await auditRowCount(sql, orgA.orgId, eventType)).toBe(1)
  })

  // ---- AC-5: reader and export over HTTP -------------------------------------------------

  test('AC-5: the audit reader returns the delegated rows by external actor and never exposes userId or delegatedBy', async () => {
    const unlinkedSub = `user_unlinked_${randomUUID()}`
    const unlinkedType = newEventType('read_unlinked')
    const revoked = await seedActor(sql, orgA.orgId, 'deactivated')
    const revokedType = newEventType('read_revoked')
    const occ = nowSeconds() - 5 * MINUTE
    expect(
      (await write(unlinkedSub, baseBody(unlinkedType), { assertion: { claims: { occ } } })).status
    ).toBe(200)
    expect(
      (await write(revoked.sub, baseBody(revokedType), { assertion: { claims: { occ } } })).status
    ).toBe(200)

    const search = async (query: string) => {
      const response = await ownerApi.get(`${apiBase}${AUDIT_BASE}/events?${query}`)
      expect(response.ok(), await response.text()).toBeTruthy()
      return (await response.json()) as {
        data: Array<{ eventType: string; attribution?: { actor?: Record<string, unknown> } }>
        total: number
      }
    }
    const byUnlinked = await search(
      `actorProvider=${DELEGATION_E2E_PROVIDER}&actorSubject=${encodeURIComponent(unlinkedSub)}`
    )
    expect(byUnlinked.data.map((event) => event.eventType)).toEqual([unlinkedType])
    expect(byUnlinked.data[0]?.attribution?.actor).toEqual({
      kind: ISSUER_ATTESTED,
      provider: DELEGATION_E2E_PROVIDER,
      subject: unlinkedSub,
      reason: UNLINKED_REASON,
    })
    const byRevoked = await search(
      `actorProvider=${DELEGATION_E2E_PROVIDER}&actorSubject=${encodeURIComponent(revoked.sub)}`
    )
    expect(byRevoked.data.map((event) => event.eventType)).toEqual([revokedType])
    expect(byRevoked.data[0]?.attribution?.actor).toMatchObject({
      kind: ISSUER_ATTESTED,
      reason: NOT_MEMBER_REASON,
    })
    for (const body of [byUnlinked, byRevoked]) {
      const text = JSON.stringify(body)
      expect(text).not.toContain('userId')
      expect(text).not.toContain('delegatedBy')
      expect(text).not.toContain(revoked.userId)
    }
    // actorId filters the PV-user (human) actor tokens: it never returns a delegated row.
    const byMember = await search(
      `actorId=${ownerUserId}&eventType=${encodeURIComponent(unlinkedType)}`
    )
    expect(byMember.total).toBe(0)
  })

  test('AC-5: the CSV export carries the five format-v2 columns for delegated rows', async () => {
    const from = new Date(Date.now() - DAY * 1000).toISOString()
    const to = new Date(Date.now() + 5 * MINUTE * 1000).toISOString()
    const started = await ownerApi.post(`${apiBase}${AUDIT_BASE}/export`, {
      data: { from, to, format: 'csv', includeIntegrityReport: false },
    })
    expect(started.status(), await started.text()).toBe(202)
    const { jobId } = ((await started.json()) as { data: { jobId: string } }).data
    await expect
      .poll(
        async () => {
          const status = await ownerApi.get(`${apiBase}${AUDIT_BASE}/exports/${jobId}`)
          return ((await status.json()) as { data: { status: string } }).data.status
        },
        { timeout: 60_000, intervals: [500, 1000] }
      )
      .toBe('completed')
    const download = await ownerApi.get(`${apiBase}${AUDIT_BASE}/exports/${jobId}/download`)
    expect(download.ok()).toBeTruthy()
    const [header, ...lines] = (await download.text()).split('\n')
    const columns = (header ?? '').split(',')
    expect(columns.slice(-5)).toEqual([
      'actor_attestation',
      'actor_attestation_reason',
      'actor_provider',
      'actor_subject',
      'occurred_at',
    ])
    const cell = (cells: string[], column: string) => cells[columns.indexOf(column)]
    const happy = lines
      .map((line) => line.split(','))
      .find((cells) => cell(cells, 'event_type') === happyEventType)
    expect(happy, 'the happy-path row is in the export').toBeDefined()
    expect(cell(happy ?? [], 'actor_attestation')).toBe('pv_verified')
    expect(cell(happy ?? [], 'actor_attestation_reason')).toBe('')
    expect(cell(happy ?? [], 'actor_provider')).toBe(DELEGATION_E2E_PROVIDER)
    expect(cell(happy ?? [], 'actor_subject')).toBe(happyActor.sub)
    expect(cell(happy ?? [], 'occurred_at')).toBe(new Date(happyOcc * 1000).toISOString())
    const delegated = lines
      .map((line) => line.split(','))
      .filter((cells) => cells[columns.indexOf('actor_attestation')] === ISSUER_ATTESTED)
    expect(delegated.length).toBeGreaterThanOrEqual(2)
    for (const cells of delegated) {
      expect(cells[columns.indexOf('actor_provider')]).toBe(DELEGATION_E2E_PROVIDER)
      expect(cells[columns.indexOf('actor_subject')]).toMatch(/^user_/)
      expect(cells[columns.indexOf('occurred_at')]).not.toBe('')
    }
  })

  // ---- AC-3 (no secrets): the sweep over everything the run produced -------------------------

  test('AC-3: no assertion, header, seed or private key appears in a row, a receipt, a response or the child logs', async () => {
    const logs = childOutput.join('')
    const seedMarkers = [
      delegationE2ePrivateKey().export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      delegationE2ePrivateKey()
        .export({ format: 'der', type: 'pkcs8' })
        .subarray(-32)
        .toString('hex'),
      delegationE2ePrivateKey()
        .export({ format: 'der', type: 'pkcs8' })
        .subarray(-32)
        .toString('base64'),
      'PRIVATE KEY',
    ]
    for (const token of issuedTokens) {
      expect(logs).not.toContain(token)
      expect(logs).not.toContain(`PV-Delegation ${token}`)
    }
    for (const marker of seedMarkers) expect(logs).not.toContain(marker)

    const rows = await sql<{ payload: unknown }[]>`
      select payload from audit_log_entries where org_id = ${orgA.orgId}
    `
    const stored = JSON.stringify(rows)
    for (const token of issuedTokens) expect(stored).not.toContain(token)
    for (const marker of seedMarkers) expect(stored).not.toContain(marker)
    const responses = responseBodies.join('\n')
    for (const token of issuedTokens) expect(responses).not.toContain(token)
    for (const marker of seedMarkers) expect(responses).not.toContain(marker)
    expect(
      logs.length,
      'the child must have produced logs for this sweep to mean anything'
    ).toBeGreaterThan(0)
  })
})
