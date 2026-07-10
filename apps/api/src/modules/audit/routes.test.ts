import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import {
  auditLogEntries,
  orgMemberships,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createLoginSessionInTx } from '../auth/service.js'
import { getAuditKey } from '../vault/key-service.js'
import { currentAuditKeyVersion } from './key-version.js'
import { writeHumanAuditEntry } from './human-entry.js'
import { computeAuditHmac } from './write-entry.js'
import { AUDIT_VERIFY_MAX_RANGE_DAYS, AUDIT_VERIFY_MAX_ROWS } from './verify.js'
import { AUDIT_EVENTS_MAX_OFFSET } from './routes.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Cookies = Record<string, string>
type VerifyBody = {
  summary: string
  rowsChecked: number
  passed: number
  failed: { id: string; eventType: string; timestamp: string }[]
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
}

const TEST_PASSPHRASE = 'audit-verify-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const VERIFY_URL = '/api/v1/org/audit/verify'
const TAMPERED_HMAC = 'deadbeef'.repeat(8)
const CREDENTIAL_VALUE_REVEALED = 'credential.value_revealed'

function verifyUrl(from: string, to: string): string {
  return `${VERIFY_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
}

/** A range comfortably covering "now" without approaching the 90-day/50k-row bounds. */
function wideRange(): [string, string] {
  const from = new Date(Date.now() - 3_600_000).toISOString()
  const to = new Date(Date.now() + 3_600_000).toISOString()
  return [from, to]
}

async function callVerify(app: TestApp, cookies: Cookies, [from, to]: [string, string]) {
  return app.inject({
    method: 'GET',
    url: verifyUrl(from, to),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `${label} ${randomUUID()}`,
  })
}

/** Inserts a row directly (bypassing the write path) so tests can construct rows the append-only
 * trigger/grant would never let a normal write-then-corrupt sequence produce (AC-2's edge case).
 * Uses `actor_type: 'system'` so these synthetic rows never interact with the AC-13/14
 * actor-token coverage check, which is scoped to `actor_type = 'human'` only. */
async function insertRawAuditRow(
  orgId: string,
  input: { eventType: string; keyVersion?: number; hmac?: string }
): Promise<{ id: string; createdAt: Date }> {
  return withOrg(orgId, async (tx) => {
    const keyVersion = input.keyVersion ?? (await currentAuditKeyVersion(tx))
    const hmac =
      input.hmac ??
      computeAuditHmac(
        {
          orgId,
          actorTokenId: null,
          actorType: 'system',
          eventType: input.eventType,
          resourceId: undefined,
          resourceType: undefined,
          payload: {},
          keyVersion,
        },
        getAuditKey()
      )
    const [row] = await tx
      .insert(auditLogEntries)
      .values({
        orgId,
        actorType: 'system',
        eventType: input.eventType,
        payload: {},
        keyVersion,
        hmac,
      })
      .returning({ id: auditLogEntries.id, createdAt: auditLogEntries.createdAt })
    if (!row) throw new Error('expected synthetic audit row to be inserted')
    return row
  })
}

/** AC-5 needs an `owner`-role session for a pre-existing (bare, registration-free) org — the
 * shared `loginExistingUserInOrg` test helper only types `role` as viewer/member/admin, since no
 * other route in the codebase is owner-only (D5). This mirrors that helper's logic for `owner`. */
async function mintOwnerSessionForOrg(
  app: TestApp,
  orgId: string,
  label: string
): Promise<Cookies> {
  const email = `${label}-${randomUUID()}@example.com`
  const [user] = await getDb()
    .insert(users)
    .values({ email, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected test user to be inserted')

  // Code-review finding (Story 8.1): a real user_identity_tokens row, mirroring the actual
  // registration flow — a bare `users` insert with no identity token means this owner's
  // SESSION_CREATED audit row is written with actor_token_id: null, permanently failing
  // checkAuditActorTokenCoverage on any reused local dev database (audit_log_entries is
  // append-only and never cleaned up between test runs).
  const [identityToken] = await getDb()
    .insert(userIdentityTokens)
    .values({ userId: user.id, displayName: email })
    .returning({ id: userIdentityTokens.id })
  if (!identityToken) throw new Error('expected identity token to be inserted')

  const result = await withOrg(orgId, async (tx) => {
    await tx
      .insert(orgMemberships)
      .values({ orgId, userId: user.id, role: 'owner', status: 'active' })
    return createLoginSessionInTx(tx, { id: user.id, identityTokenId: identityToken.id }, orgId, {})
  })
  const jwt = await (
    app as unknown as {
      jwt: {
        sign: (
          payload: Record<string, unknown>,
          options: { jti: string; expiresIn: number }
        ) => Promise<string>
      }
    }
  ).jwt.sign(
    {
      sub: result.tokens.accessClaims.sub,
      orgId: result.tokens.accessClaims.orgId,
      sessionVersion: result.tokens.accessClaims.sessionVersion,
    },
    { jti: result.tokens.accessClaims.jti, expiresIn: result.tokens.accessMaxAgeSec }
  )
  return { 'access-token': jwt }
}

describe.sequential('audit verify route', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('reports every row passed for a clean org, using the real write path (AC-1)', async () => {
    const owner = await registerOwner(app, 'verify-happy')
    await createProjectViaApi(app, owner.cookies, 'verify-happy')

    const res = await callVerify(app, owner.cookies, wideRange())

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: VerifyBody }>().data
    // registration writes USER_REGISTERED + SESSION_CREATED; createProjectViaApi writes
    // project.created — at least 3 rows, all through the normal write path.
    expect(body.rowsChecked).toBeGreaterThanOrEqual(3)
    expect(body.passed).toBe(body.rowsChecked)
    expect(body.failed).toEqual([])
    expect(body.failedCount).toBe(0)
    expect(body.failedTruncated).toBe(false)
    expect(body.summary).toBe(`All ${body.rowsChecked} records verified — no tampering detected`)
    expect(body.verifiedAt).toEqual(expect.any(String))
  }, 20_000)

  it('reports a tampered row as failed without erroring (AC-2)', async () => {
    const owner = await registerOwner(app, 'verify-tampered')
    const clean = await insertRawAuditRow(owner.orgId, { eventType: 'test.clean' })
    const tampered = await insertRawAuditRow(owner.orgId, {
      eventType: CREDENTIAL_VALUE_REVEALED,
      hmac: TAMPERED_HMAC,
    })

    const res = await callVerify(app, owner.cookies, wideRange())

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: VerifyBody }>().data
    // registration writes USER_REGISTERED + SESSION_CREATED (2 real rows) + 1 synthetic clean
    // row + 1 tampered row = 4 total, 3 passed, 1 failed.
    expect(body.rowsChecked).toBe(4)
    expect(body.passed).toBe(3)
    expect(body.failedCount).toBe(1)
    expect(body.failedTruncated).toBe(false)
    expect(body.failed).toEqual([
      {
        id: tampered.id,
        eventType: CREDENTIAL_VALUE_REVEALED,
        timestamp: tampered.createdAt.toISOString(),
      },
    ])
    expect(body.summary).toBe('3 of 4 records verified — 1 record failed integrity check')
    expect(clean.id).not.toBe(tampered.id)
  }, 20_000)

  it(
    'caps the failed array at 500 entries while reporting the true failedCount ' +
      '(AC-2 bulk-tamper truncation)',
    async () => {
      const owner = await registerOwner(app, 'verify-bulk-tamper')
      const bulkCount = 510
      await withOrg(owner.orgId, (tx) =>
        tx.execute(sql`
          INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
          SELECT ${owner.orgId}, 'system', 'bulk.tamper', 1, ${TAMPERED_HMAC}, '{}'::jsonb
          FROM generate_series(1, ${bulkCount})
        `)
      )

      const res = await callVerify(app, owner.cookies, wideRange())

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: VerifyBody }>().data
      expect(body.failedCount).toBe(bulkCount)
      expect(body.failed).toHaveLength(500)
      expect(body.failedTruncated).toBe(true)
      expect(body.rowsChecked).toBeGreaterThanOrEqual(bulkCount)
      expect(body.summary).toContain(`${bulkCount} records failed integrity check`)
    },
    30_000
  )

  it('reports a keyVersion mismatch as failed even when the HMAC matches its own fields (AC-3)', async () => {
    const owner = await registerOwner(app, 'verify-key-mismatch')
    const mismatched = await insertRawAuditRow(owner.orgId, {
      eventType: 'test.key-mismatch',
      keyVersion: 2,
    })

    const res = await callVerify(app, owner.cookies, wideRange())

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: VerifyBody }>().data
    expect(body.failed.some((entry) => entry.id === mismatched.id)).toBe(true)
  }, 20_000)

  it('rejects admin/member/viewer with 403 and unauthenticated with 401 (AC-4)', async () => {
    const authzEmailPrefix = 'audit-verify-authz'
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', authzEmailPrefix)
    const member = await createDirectAuthenticatedUser(app, 'member', 'member', authzEmailPrefix)
    const viewer = await createDirectAuthenticatedUser(app, 'viewer', 'viewer', authzEmailPrefix)

    for (const user of [admin, member, viewer]) {
      const res = await callVerify(app, user.cookies, wideRange())
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({
        code: 'insufficient_role',
        message: 'Insufficient permissions',
      })
    }

    const [from, to] = wideRange()
    const unauthenticated = await app.inject({ method: 'GET', url: verifyUrl(from, to) })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({ code: 'access_token_missing' })
  }, 20_000)

  it("only counts the calling org's own rows, never a peer org's (AC-5)", async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      for (let i = 0; i < 5; i += 1) {
        await insertRawAuditRow(orgAId, { eventType: `orgA.event.${i}` })
      }
      for (let i = 0; i < 3; i += 1) {
        await insertRawAuditRow(orgBId, { eventType: `orgB.event.${i}` })
      }

      const ownerACookies = await mintOwnerSessionForOrg(app, orgAId, 'verify-isolation-a')
      const res = await callVerify(app, ownerACookies, wideRange())

      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: VerifyBody }>().data
      // mintOwnerSessionForOrg's login itself writes 1 real SESSION_CREATED row via
      // createLoginSessionInTx, on top of the 5 synthetic org A rows — never org B's 3.
      expect(body.rowsChecked).toBe(6)
      expect(body.passed).toBe(6)

      // Code-review finding (Story 8.1): mintOwnerSessionForOrg used to mint this SESSION_CREATED
      // row with actor_token_id: null, permanently failing checkAuditActorTokenCoverage
      // (packages/db/src/check-audit-actor-token-coverage.ts) for any reused local dev database,
      // since audit_log_entries is append-only and never cleaned up between test runs.
      const sessionRows = await withOrg(orgAId, (tx) =>
        tx
          .select({ actorTokenId: auditLogEntries.actorTokenId })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, AuditEvent.SESSION_CREATED))
      )
      expect(sessionRows.length).toBeGreaterThan(0)
      for (const row of sessionRows) {
        expect(row.actorTokenId).not.toBeNull()
      }
    })
  }, 20_000)

  it('rejects missing, invalid, and inverted ranges but accepts a zero-width range (AC-6)', async () => {
    const owner = await registerOwner(app, 'verify-validation')

    const missing = await app.inject({
      method: 'GET',
      url: VERIFY_URL,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(missing.statusCode).toBe(422)
    expect(missing.json()).toMatchObject({ code: 'validation_error' })

    const invalidFrom = await app.inject({
      method: 'GET',
      url: `${VERIFY_URL}?from=not-a-date&to=${encodeURIComponent(new Date().toISOString())}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(invalidFrom.statusCode).toBe(422)

    const now = new Date()
    const inverted = await callVerify(app, owner.cookies, [
      now.toISOString(),
      new Date(now.getTime() - 3_600_000).toISOString(),
    ])
    expect(inverted.statusCode).toBe(422)
    expect(inverted.json()).toMatchObject({ code: 'invalid_range' })

    // Zero-width (from === to) is a valid, empty-matching range — not an error (AC-6/AC-7).
    const zeroWidthIso = now.toISOString()
    const zeroWidth = await callVerify(app, owner.cookies, [zeroWidthIso, zeroWidthIso])
    expect(zeroWidth.statusCode).toBe(200)
    expect(zeroWidth.json<{ data: VerifyBody }>().data).toMatchObject({
      rowsChecked: 0,
      summary: 'No records found in this range',
    })
  }, 20_000)

  it(`rejects a range spanning more than ${AUDIT_VERIFY_MAX_RANGE_DAYS} days (AC-6)`, async () => {
    const owner = await registerOwner(app, 'verify-range-too-large')
    const from = new Date()
    const to = new Date(from.getTime() + (AUDIT_VERIFY_MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000)

    const res = await callVerify(app, owner.cookies, [from.toISOString(), to.toISOString()])

    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'range_too_large' })
  }, 20_000)

  it(
    `rejects a range matching more than ${AUDIT_VERIFY_MAX_ROWS} rows without recomputing any ` +
      'HMACs (AC-6)',
    async () => {
      const owner = await registerOwner(app, 'verify-too-many-rows')
      const overCount = AUDIT_VERIFY_MAX_ROWS + 1
      await withOrg(owner.orgId, (tx) =>
        tx.execute(sql`
          INSERT INTO audit_log_entries (org_id, actor_type, event_type, key_version, hmac, payload)
          SELECT ${owner.orgId}, 'system', 'bulk.oversize', 1, ${TAMPERED_HMAC}, '{}'::jsonb
          FROM generate_series(1, ${overCount})
        `)
      )

      const res = await callVerify(app, owner.cookies, wideRange())

      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ code: 'range_too_large' })
    },
    60_000
  )

  it('reports the empty-range shape when no rows fall in the requested window (AC-7)', async () => {
    const owner = await registerOwner(app, 'verify-empty-range')
    // owner's registration row exists, but well before this future window.
    const from = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)

    const res = await callVerify(app, owner.cookies, [from.toISOString(), to.toISOString()])

    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: VerifyBody }>().data).toMatchObject({
      summary: 'No records found in this range',
      rowsChecked: 0,
      passed: 0,
      failed: [],
      failedCount: 0,
      failedTruncated: false,
    })
  }, 20_000)

  it('records its own call as an audit.integrity_verify_run entry, same transaction (D7)', async () => {
    const owner = await registerOwner(app, 'verify-self-audit')

    const res = await callVerify(app, owner.cookies, wideRange())
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(sql`${auditLogEntries.eventType} = 'audit.integrity_verify_run'`)
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({
      rowsChecked: expect.any(Number),
      passed: expect.any(Number),
      failedCount: expect.any(Number),
    })
  }, 20_000)

  it('allows a concurrent audit-triggering write during a verify call (AC-12)', async () => {
    const owner = await registerOwner(app, 'verify-concurrency')

    const [verifyRes] = await Promise.all([
      callVerify(app, owner.cookies, wideRange()),
      createProjectViaApi(app, owner.cookies, 'verify-concurrency-write'),
    ])

    expect(verifyRes.statusCode).toBe(200)
    const body = verifyRes.json<{ data: VerifyBody }>().data
    // Internally consistent regardless of whether the racing write landed inside the verify
    // call's snapshot or not (AC-12 — non-deterministic inclusion is by design, not asserted).
    expect(body.passed + body.failedCount).toBe(body.rowsChecked)
  }, 20_000)

  it('enforces 20/min and returns 429 on the 21st call within the window (AC-11)', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'verify-rate-limit')
      let last: Awaited<ReturnType<typeof callVerify>> | undefined
      for (let i = 0; i < 21; i += 1) {
        last = await callVerify(app, owner.cookies, wideRange())
      }
      expect(last?.statusCode).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)

  // Last test: seals the vault (a global, in-process singleton), so this must run after every
  // other test in this file that needs an unsealed vault (matches the established pattern in
  // projects/routes.test.ts's own "fail closed while sealed" test).
  it('returns 503 audit_key_unavailable while sealed — never a false all-pass (AC-10)', async () => {
    const sealedOwner = await registerOwner(app, 'verify-sealed')

    await app.close()
    await resetVaultForTest()
    // vaultGuardEnabled: false — the global vault-guard plugin would otherwise intercept every
    // request with a generic 503 {status:'sealed'} before this route's own handler ever runs
    // (see apps/api/src/plugins/vault-guard.ts). This test exercises the route's own
    // getAuditKey()-catch fail-closed behavior (AC-10) as a defense-in-depth layer independent
    // of that global guard, which is already covered elsewhere (e.g. projects/routes.test.ts).
    const sealedApp = await createApp({ logger: false, vaultGuardEnabled: false })

    const res = await callVerify(sealedApp, sealedOwner.cookies, wideRange())

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      code: 'audit_key_unavailable',
      message: 'Audit key is unavailable while the vault is sealed',
    })

    await sealedApp.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)
})

// --- Story 8.2: GET /audit/events (search) -------------------------------------------------

const EVENTS_URL = '/api/v1/org/audit/events'
const ROTATION_INITIATED = 'rotation.initiated'
const VALIDATION_ERROR_CODE = 'validation_error'
const CONCURRENCY_SEED_EVENT = 'concurrency.seed'
const NOT_A_UUID = 'not-a-uuid'

type EventsBody = {
  data: {
    id: string
    eventType: string
    actorDisplayName: string
    resourceId: string | null
    resourceType: string | null
    projectId: string | null
    ipAddress: string | null
    createdAt: string
  }[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

function eventsUrl(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${EVENTS_URL}?${qs}` : EVENTS_URL
}

async function callSearch(
  app: TestApp,
  cookies: Cookies,
  query: Record<string, string | number | undefined> = {}
) {
  return app.inject({
    method: 'GET',
    url: eventsUrl(query),
    headers: { cookie: cookieHeader(cookies) },
  })
}

/** Full-control raw insert for search tests: unlike insertRawAuditRow above (routes.test.ts's
 * verify-suite helper, actor_type: 'system' only, no resource/project/actor fields), search
 * tests need actorTokenId/resourceId/resourceType/projectId/createdAt control to exercise every
 * filter dimension independently (AC-1). */
async function insertSearchAuditRow(
  orgId: string,
  input: {
    eventType: string
    actorTokenId?: string | null
    resourceId?: string
    resourceType?: string
    projectId?: string
    createdAt?: Date
  }
): Promise<{ id: string; createdAt: Date }> {
  return withOrg(orgId, async (tx) => {
    const keyVersion = await currentAuditKeyVersion(tx)
    const actorType = input.actorTokenId ? 'human' : 'system'
    const hmac = computeAuditHmac(
      {
        orgId,
        actorTokenId: input.actorTokenId ?? null,
        actorType,
        eventType: input.eventType,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        payload: {},
        keyVersion,
      },
      getAuditKey()
    )
    const [row] = await tx
      .insert(auditLogEntries)
      .values({
        orgId,
        actorTokenId: input.actorTokenId ?? null,
        actorType,
        eventType: input.eventType,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        projectId: input.projectId,
        payload: {},
        keyVersion,
        hmac,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning({ id: auditLogEntries.id, createdAt: auditLogEntries.createdAt })
    if (!row) throw new Error('expected search test audit row to be inserted')
    return row
  })
}

async function insertIdentityToken(displayName: string): Promise<{ id: string; userId: string }> {
  const [user] = await getDb()
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected test user to be inserted')
  const [token] = await getDb()
    .insert(userIdentityTokens)
    .values({ userId: user.id, displayName })
    .returning({ id: userIdentityTokens.id })
  if (!token) throw new Error('expected identity token to be inserted')
  return { id: token.id, userId: user.id }
}

describe.sequential('audit search route (GET /audit/events)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it(
    'returns only the row matching all five filter dimensions simultaneously, excluding ' +
      'three near-miss rows each differing in exactly one dimension (AC-1)',
    async () => {
      const owner = await registerOwner(app, 'search-all-dims')
      const alice = await insertIdentityToken('Alice Chen')
      const bob = await insertIdentityToken('Bob Singh')
      const resourceId = randomUUID()
      const otherResourceId = randomUUID()
      const projectId = await createProjectViaApi(app, owner.cookies, 'search-ac1-a')
      const otherProjectId = await createProjectViaApi(app, owner.cookies, 'search-ac1-b')
      const from = new Date('2026-07-01T00:00:00.000Z')
      const inRange = new Date('2026-07-03T14:22:01.000Z')
      const outOfRange = new Date('2026-07-10T00:00:00.000Z')

      const match = await insertSearchAuditRow(owner.orgId, {
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorTokenId: alice.id,
        resourceId,
        resourceType: 'credential',
        projectId,
        createdAt: inRange,
      })
      // Near-miss: wrong actor
      await insertSearchAuditRow(owner.orgId, {
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorTokenId: bob.id,
        resourceId,
        resourceType: 'credential',
        projectId,
        createdAt: inRange,
      })
      // Near-miss: wrong event type
      await insertSearchAuditRow(owner.orgId, {
        eventType: 'credential.created',
        actorTokenId: alice.id,
        resourceId,
        resourceType: 'credential',
        projectId,
        createdAt: inRange,
      })
      // Near-miss: wrong resource
      await insertSearchAuditRow(owner.orgId, {
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorTokenId: alice.id,
        resourceId: otherResourceId,
        resourceType: 'credential',
        projectId,
        createdAt: inRange,
      })
      // Near-miss: wrong project
      await insertSearchAuditRow(owner.orgId, {
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorTokenId: alice.id,
        resourceId,
        resourceType: 'credential',
        projectId: otherProjectId,
        createdAt: inRange,
      })
      // Near-miss: outside the date range
      await insertSearchAuditRow(owner.orgId, {
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorTokenId: alice.id,
        resourceId,
        resourceType: 'credential',
        projectId,
        createdAt: outOfRange,
      })

      const res = await callSearch(app, owner.cookies, {
        actorId: alice.userId,
        eventType: CREDENTIAL_VALUE_REVEALED,
        resourceId,
        projectId,
        from: from.toISOString(),
        to: new Date('2026-07-04T23:59:59.999Z').toISOString(),
        page: 1,
        limit: 20,
      })

      expect(res.statusCode).toBe(200)
      const body = res.json<EventsBody>()
      expect(body.data).toHaveLength(1)
      expect(body.data[0]).toMatchObject({
        id: match.id,
        eventType: CREDENTIAL_VALUE_REVEALED,
        actorDisplayName: 'Alice Chen',
        resourceId,
        resourceType: 'credential',
        projectId,
      })
      expect(body.total).toBe(1)
      expect(body.hasNext).toBe(false)
    },
    20_000
  )

  it('resolves actorId through user_identity_tokens, never a raw actor_token_id (AC-2)', async () => {
    const owner = await registerOwner(app, 'search-actor-resolve')
    const alice = await insertIdentityToken('Alice Resolve')
    for (let i = 0; i < 3; i += 1) {
      await insertSearchAuditRow(owner.orgId, {
        eventType: `alice.event.${i}`,
        actorTokenId: alice.id,
      })
    }

    const res = await callSearch(app, owner.cookies, { actorId: alice.userId })
    expect(res.statusCode).toBe(200)
    expect(res.json<EventsBody>().total).toBe(3)
  })

  it('returns an empty 200 result (not 404/422) for a valid-shaped, never-tokenized actorId (AC-2)', async () => {
    const owner = await registerOwner(app, 'search-actor-unknown')
    const unknownActorId = randomUUID()

    const res = await callSearch(app, owner.cookies, { actorId: unknownActorId })

    expect(res.statusCode).toBe(200)
    expect(res.json<EventsBody>()).toMatchObject({ data: [], total: 0 })
  })

  it('returns rows for either of two token rows sharing the same user_id (AC-2 defensive case)', async () => {
    const owner = await registerOwner(app, 'search-actor-multi-token')
    const sharedUserId = randomUUID()
    await getDb()
      .insert(users)
      .values({ id: sharedUserId, email: `${randomUUID()}@example.com`, passwordHash: 'x' })
    const [tokenA] = await getDb()
      .insert(userIdentityTokens)
      .values({ userId: sharedUserId, displayName: 'Shared A' })
      .returning({ id: userIdentityTokens.id })
    const [tokenB] = await getDb()
      .insert(userIdentityTokens)
      .values({ userId: sharedUserId, displayName: 'Shared B' })
      .returning({ id: userIdentityTokens.id })
    if (!tokenA || !tokenB) throw new Error('expected both tokens to be inserted')

    await insertSearchAuditRow(owner.orgId, { eventType: 'shared.a', actorTokenId: tokenA.id })
    await insertSearchAuditRow(owner.orgId, { eventType: 'shared.b', actorTokenId: tokenB.id })

    const res = await callSearch(app, owner.cookies, { actorId: sharedUserId })
    expect(res.statusCode).toBe(200)
    expect(res.json<EventsBody>().total).toBe(2)
  })

  it('returns historical rows written before this story shipped, with no special-casing (AC-3)', async () => {
    const owner = await registerOwner(app, 'search-historical')
    const backdated = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    // A real actor token, not `null` — checkAuditActorTokenCoverage (Story 8.1 D3) is a
    // database-wide gate over the shared, never-cleaned-up dev/test Postgres instance; a
    // human-actor row with a null actor_token_id would permanently fail that check for every
    // future test run. `writeHumanAuditEntry()` always writes actor_type: 'human', so this
    // simulated "pre-8.2" row needs a real token to stay coverage-clean, exactly like the real
    // write path (Story 1.6) always provides one.
    const historicalActor = await insertIdentityToken('Historical Actor')
    await withOrg(owner.orgId, (tx) =>
      writeHumanAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId: historicalActor.id,
        eventType: ROTATION_INITIATED,
        payload: {},
      })
    )
    await insertSearchAuditRow(owner.orgId, {
      eventType: ROTATION_INITIATED,
      createdAt: backdated,
    })

    const res = await callSearch(app, owner.cookies, { eventType: ROTATION_INITIATED })
    expect(res.statusCode).toBe(200)
    expect(res.json<EventsBody>().total).toBe(2)
  })

  it('validates query parameters independently (AC-4)', async () => {
    const owner = await registerOwner(app, 'search-validation')

    const cases: [Record<string, string>, number, Record<string, unknown>?][] = [
      [{ actorId: NOT_A_UUID }, 422, { code: VALIDATION_ERROR_CODE }],
      [{ resourceId: NOT_A_UUID }, 422, { code: VALIDATION_ERROR_CODE }],
      [{ projectId: NOT_A_UUID }, 422, { code: VALIDATION_ERROR_CODE }],
      [{ from: 'garbage', to: new Date().toISOString() }, 422, { code: VALIDATION_ERROR_CODE }],
      [{ page: '0' }, 422],
      [{ page: '-1' }, 422],
      [{ limit: '101' }, 422],
    ]

    for (const [query, status, shape] of cases) {
      const res = await callSearch(app, owner.cookies, query)
      expect(res.statusCode).toBe(status)
      if (shape) expect(res.json()).toMatchObject(shape)
    }

    const now = new Date()
    const invertedRange = await callSearch(app, owner.cookies, {
      from: now.toISOString(),
      to: new Date(now.getTime() - 3_600_000).toISOString(),
    })
    expect(invertedRange.statusCode).toBe(422)
    expect(invertedRange.json()).toMatchObject({ code: 'invalid_range' })

    const noFilters = await callSearch(app, owner.cookies, {})
    expect(noFilters.statusCode).toBe(200)
  })

  it(`rejects an offset beyond ${AUDIT_EVENTS_MAX_OFFSET}, accepts one within it (AC-5)`, async () => {
    const owner = await registerOwner(app, 'search-page-depth')

    const tooDeep = await callSearch(app, owner.cookies, { page: 2001, limit: 20 })
    expect(tooDeep.statusCode).toBe(422)
    expect(tooDeep.json()).toMatchObject({ code: 'page_out_of_range' })

    const withinCap = await callSearch(app, owner.cookies, { page: 500, limit: 20 })
    expect(withinCap.statusCode).toBe(200)
  })

  it('rejects admin/member/viewer with 403, isolates by org via RLS (AC-6)', async () => {
    const authzEmailPrefix = 'audit-search-authz'
    const admin = await createDirectAuthenticatedUser(app, 'admin', 'admin', authzEmailPrefix)
    const member = await createDirectAuthenticatedUser(app, 'member', 'member', authzEmailPrefix)
    const viewer = await createDirectAuthenticatedUser(app, 'viewer', 'viewer', authzEmailPrefix)

    for (const user of [admin, member, viewer]) {
      const res = await callSearch(app, user.cookies)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    }

    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      for (let i = 0; i < 5; i += 1) {
        await insertSearchAuditRow(orgAId, { eventType: `orgA.event.${i}` })
      }
      for (let i = 0; i < 3; i += 1) {
        await insertSearchAuditRow(orgBId, { eventType: `orgB.event.${i}` })
      }

      const ownerACookies = await mintOwnerSessionForOrg(app, orgAId, 'search-isolation-a')
      const res = await callSearch(app, ownerACookies, { limit: 100 })

      expect(res.statusCode).toBe(200)
      const body = res.json<EventsBody>()
      // +1 for the owner's own SESSION_CREATED row from mintOwnerSessionForOrg's login.
      expect(body.total).toBe(6)
    })
  })

  it('writes an audit.search_run entry for its own call (AC-7)', async () => {
    const owner = await registerOwner(app, 'search-self-audit')

    const res = await callSearch(app, owner.cookies, { eventType: 'nonexistent.event' })
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(sql`${auditLogEntries.eventType} = 'audit.search_run'`)
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ resultCount: expect.any(Number) })
  })

  it('enforces 60/min and returns 429 on the 61st call within the window (AC-7)', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await registerOwner(app, 'search-rate-limit')
      let last: Awaited<ReturnType<typeof callSearch>> | undefined
      for (let i = 0; i < 61; i += 1) {
        last = await callSearch(app, owner.cookies)
      }
      expect(last?.statusCode).toBe(429)
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  }, 30_000)

  it(
    'remains internally consistent (sum of pages vs. point-in-time total) under a concurrent ' +
      'write (AC-8)',
    async () => {
      const owner = await registerOwner(app, 'search-concurrency')
      for (let i = 0; i < 10; i += 1) {
        await insertSearchAuditRow(owner.orgId, { eventType: CONCURRENCY_SEED_EVENT })
      }

      const [page1, , page2] = await Promise.all([
        callSearch(app, owner.cookies, { eventType: CONCURRENCY_SEED_EVENT, page: 1, limit: 5 }),
        insertSearchAuditRow(owner.orgId, { eventType: CONCURRENCY_SEED_EVENT }),
        callSearch(app, owner.cookies, { eventType: CONCURRENCY_SEED_EVENT, page: 2, limit: 5 }),
      ])

      expect(page1.statusCode).toBe(200)
      expect(page2.statusCode).toBe(200)
      const total1 = page1.json<EventsBody>().total
      const total2 = page2.json<EventsBody>().total
      // Both snapshots see either 10 or 11 rows depending on race timing — never anything else.
      expect([10, 11]).toContain(total1)
      expect([10, 11]).toContain(total2)
    }
  )
})
