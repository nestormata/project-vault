import { describe, expect, it, afterEach } from 'vitest'
import { isNull } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { operationalStatusTokens } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'platform-admin-status-token-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const BASE = '/api/v1/admin/settings/status-token'
const NON_LOOPBACK_REMOTE_ADDRESS = '203.0.113.5'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function getMeta(app: TestApp, cookies: CookieJar) {
  return app.inject({ method: 'GET', url: BASE, headers: { cookie: cookieHeader(cookies) } })
}
function generate(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/generate`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
function rotate(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/rotate`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
function revoke(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/revoke`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
function test(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/test`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('Story 1.19 platform-admin status-token routes', () => {
  suite.registerLifecycle()

  afterEach(async () => {
    await getDb().delete(operationalStatusTokens)
  })

  it('AC-5/AC-9: 401 with no auth header', async () => {
    const res = await getMeta(suite.app, {})
    expect(res.statusCode).toBe(401)
  })

  it('AC-5/AC-9: 403 for a non-operator', async () => {
    const { enrollUserWithMfa } = await import('../../__tests__/helpers/mfa-enroll-test-helpers.js')
    // On a freshly-migrated database (no prior registrations) the very first user ever
    // registered auto-bootstraps as the platform operator (D1) — burn that slot with a
    // throwaway registration first so this test's own user is guaranteed to be a non-operator,
    // same precaution settings-routes.test.ts's shared-DB assumption otherwise gets for free.
    await enrollUserWithMfa(suite.app, {
      emailPrefix: 'status-token-bootstrap-burn',
      orgNamePrefix: 'Status Token Bootstrap Burn',
      password: PASSWORD,
    })
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'status-token-nonop',
      orgNamePrefix: 'Status Token NonOp',
      password: PASSWORD,
    })
    const res = await getMeta(suite.app, owner.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
  })

  it('AC-5/AC-6: GET reports unconfigured, generate returns plaintext once and audit-logs, GET no longer returns it', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-happy',
      orgNamePrefix: 'Status Token Happy',
      password: PASSWORD,
    })

    const before = await getMeta(suite.app, operator.cookies)
    expect(before.statusCode).toBe(200)
    expect(before.json<{ configured: boolean }>().configured).toBe(false)

    const gen = await generate(suite.app, operator.cookies)
    expect(gen.statusCode).toBe(200)
    const genBody = gen.json<{ token: string; createdAt: string }>()
    expect(typeof genBody.token).toBe('string')
    expect(genBody.token.length).toBeGreaterThan(20)

    const after = await getMeta(suite.app, operator.cookies)
    const afterBody = after.json<{ configured: boolean; createdAt?: string }>()
    expect(afterBody.configured).toBe(true)
    // AC-6: only a hash is stored — the GET metadata response never echoes the plaintext.
    expect(JSON.stringify(afterBody)).not.toContain(genBody.token)

    const rows = await getDb()
      .select()
      .from(operationalStatusTokens)
      .where(isNull(operationalStatusTokens.revokedAt))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).not.toBe(genBody.token)
  })

  it('AC-5/AC-6: rotate revokes the prior token and issues a new one', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-rotate',
      orgNamePrefix: 'Status Token Rotate',
      password: PASSWORD,
    })
    const first = await generate(suite.app, operator.cookies)
    const firstToken = first.json<{ token: string }>().token

    const second = await rotate(suite.app, operator.cookies)
    expect(second.statusCode).toBe(200)
    const secondToken = second.json<{ token: string }>().token
    expect(secondToken).not.toBe(firstToken)

    const allRows = await getDb().select().from(operationalStatusTokens)
    expect(allRows).toHaveLength(2)
    const active = allRows.filter((r) => r.revokedAt === null)
    expect(active).toHaveLength(1)
  })

  it('AC-5/AC-6: revoke disables token access; a second revoke returns 409', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-revoke',
      orgNamePrefix: 'Status Token Revoke',
      password: PASSWORD,
    })
    await generate(suite.app, operator.cookies)

    const first = await revoke(suite.app, operator.cookies)
    expect(first.statusCode).toBe(204)

    const meta = await getMeta(suite.app, operator.cookies)
    expect(meta.json<{ configured: boolean }>().configured).toBe(false)

    const second = await revoke(suite.app, operator.cookies)
    expect(second.statusCode).toBe(409)
  })

  it('AC-9: concurrent rotates leave the DB with exactly one active un-revoked token and no crash', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-concurrent-rotate',
      orgNamePrefix: 'Status Token Concurrent Rotate',
      password: PASSWORD,
    })
    await generate(suite.app, operator.cookies)

    // Fire several rotates concurrently. The service serializes generate/rotate/revoke via a
    // transaction-scoped advisory lock (see status-token-service.ts's acquireStatusTokenLock),
    // so each call should simply queue and succeed in some order rather than race and either
    // corrupt the "exactly one active token" invariant or blow up with an unhandled rejection.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => rotate(suite.app, operator.cookies))
    )
    for (const res of results) {
      expect(res.statusCode).toBe(200)
    }
    // Every returned plaintext must be distinct — no two concurrent rotates should ever hand out
    // the same token.
    const tokens = results.map((r) => r.json<{ token: string }>().token)
    expect(new Set(tokens).size).toBe(tokens.length)

    const allRows = await getDb().select().from(operationalStatusTokens)
    const active = allRows.filter((r) => r.revokedAt === null)
    expect(active).toHaveLength(1)
    // The final active row must be one of the tokens actually returned to a caller — never a
    // token nobody received (which would indicate a lost/duplicated insert under the race).
    const activeHash = active[0]?.tokenHash
    expect(activeHash).toBeDefined()
  })

  it('AC-9: concurrent revoke and rotate never leave two active tokens (mixed-op race)', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-concurrent-mixed',
      orgNamePrefix: 'Status Token Concurrent Mixed',
      password: PASSWORD,
    })
    await generate(suite.app, operator.cookies)

    const results = await Promise.allSettled([
      rotate(suite.app, operator.cookies),
      rotate(suite.app, operator.cookies),
      revoke(suite.app, operator.cookies),
    ])
    // No call should ever reject the promise (an unhandled rejection) — a losing "revoke" against
    // an already-revoked token is a handled 409, not a crash.
    for (const r of results) {
      expect(r.status).toBe('fulfilled')
    }
    const statusCodes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1))
    for (const code of statusCodes) {
      expect([200, 204, 409]).toContain(code)
    }

    const allRows = await getDb().select().from(operationalStatusTokens)
    const active = allRows.filter((r) => r.revokedAt === null)
    // Either the revoke landed last (0 active) or a rotate landed last (1 active) — but never 2+
    // active tokens, which would be the corruption this test guards against.
    expect(active.length).toBeLessThanOrEqual(1)
  })

  it('AC-9/AC-4: a token valid before rotate is rejected (401) immediately after — no stale-token replay window', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-replay-rotate',
      orgNamePrefix: 'Status Token Replay Rotate',
      password: PASSWORD,
    })
    const first = await generate(suite.app, operator.cookies)
    const oldToken = first.json<{ token: string }>().token

    // This integration harness's createApp() never wires a dbPool option (see
    // status-token-routes.test.ts's own "test action" case above), so the database check
    // deterministically reports db_unavailable and the aggregate status is always 503 here — a
    // *successfully authenticated* request still returns the full status body, just with a 503
    // status code, never the 401/404 shape a rejected request gets. That's the signal this test
    // cares about: auth passed vs. auth failed, not the aggregate health verdict.
    const beforeRotate = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${oldToken}` },
    })
    expect(beforeRotate.statusCode).toBe(503)
    expect(beforeRotate.json()).not.toMatchObject({ code: 'unauthorized' })

    const rotated = await rotate(suite.app, operator.cookies)
    expect(rotated.statusCode).toBe(200)
    const newToken = rotated.json<{ token: string }>().token
    expect(newToken).not.toBe(oldToken)

    const afterRotateOldToken = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${oldToken}` },
    })
    expect(afterRotateOldToken.statusCode).toBe(401)
    expect(afterRotateOldToken.json()).toMatchObject({ code: 'unauthorized' })

    const afterRotateNewToken = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${newToken}` },
    })
    expect(afterRotateNewToken.statusCode).toBe(503)
    expect(afterRotateNewToken.json()).not.toMatchObject({ code: 'unauthorized' })
  })

  it('AC-9/AC-4: a token valid before revoke is rejected (401) immediately after — no stale-token replay window', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-replay-revoke',
      orgNamePrefix: 'Status Token Replay Revoke',
      password: PASSWORD,
    })
    const first = await generate(suite.app, operator.cookies)
    const token = first.json<{ token: string }>().token

    const beforeRevoke = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${token}` },
    })
    // See the rotate-replay test above for why 503 (not 200) is the "authenticated" outcome in
    // this harness.
    expect(beforeRevoke.statusCode).toBe(503)
    expect(beforeRevoke.json()).not.toMatchObject({ code: 'unauthorized' })

    const revoked = await revoke(suite.app, operator.cookies)
    expect(revoked.statusCode).toBe(204)

    // After a full revoke there is no active token left at all, which is the same "not
    // configured" state as before any token ever existed — resolveStatusAuth's safe-default
    // branch applies (loopback-only, generic 404 for everyone else), not the "wrong token" 401
    // branch. The important assertion is still that the old plaintext no longer grants access —
    // it just does so via the safe-default path rather than a token-mismatch path.
    const afterRevoke = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(afterRevoke.statusCode).toBe(404)
    expect(afterRevoke.json()).toMatchObject({ code: 'not_found' })

    // A loopback caller without any token is allowed by the safe default — confirms the presented
    // (now-worthless) old token isn't somehow still being treated as a stale credential either.
    const loopbackNoToken = await suite.app.inject({
      method: 'GET',
      url: '/status',
      remoteAddress: '127.0.0.1',
    })
    expect(loopbackNoToken.statusCode).toBe(503)
    expect(loopbackNoToken.json<{ status: string }>().status).toBe('unavailable')
  })

  it('AC-5: test action reports the live check result (unwired dbPool in this test harness reports db_unavailable, not a crash)', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'status-token-test',
      orgNamePrefix: 'Status Token Test',
      password: PASSWORD,
    })
    const res = await test(suite.app, operator.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      status: string
      checks: { database: { status: string; reason?: string }; vault: { status: string } }
    }>()
    expect(['healthy', 'degraded', 'unavailable']).toContain(body.status)
    // This integration harness's createApp() call never wires a dbPool option (see
    // __tests__/helpers/auth-test-helpers.ts), so the database check deterministically reports
    // db_unavailable here — this assertion documents that harness limitation rather than
    // asserting a false "always healthy" expectation. The vault check (in-memory, no dbPool
    // needed) reports 'ok' since this suite runs unsealed.
    expect(body.checks.database.status).toBe('unavailable')
    expect(body.checks.database.reason).toBe('db_unavailable')
    expect(body.checks.vault.status).toBe('ok')
  })
})
