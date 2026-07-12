import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  users,
  orgMemberships,
  platformAuditPendingEntries,
  platformAuditMaintenanceState,
} from '@project-vault/db/schema'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'platform-audit-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const EVENTS_URL = '/api/v1/platform/audit/events'
const VERIFY_URL = '/api/v1/platform/audit/verify'
const MAINTENANCE_URL = '/api/v1/platform/maintenance-mode'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function getEvents(app: TestApp, cookies: CookieJar, query = '') {
  return app.inject({
    method: 'GET',
    url: `${EVENTS_URL}${query}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function getVerify(app: TestApp, cookies: CookieJar, query: string) {
  return app.inject({
    method: 'GET',
    url: `${VERIFY_URL}${query}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function postMaintenance(app: TestApp, cookies: CookieJar, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: MAINTENANCE_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

async function resetMaintenanceState(): Promise<void> {
  await getDb()
    .update(platformAuditMaintenanceState)
    .set({
      active: false,
      reason: null,
      activatedByUserId: null,
      activatedAt: null,
      deactivatedAt: null,
    })
    .where(eq(platformAuditMaintenanceState.id, 1))
  await getDb().delete(platformAuditPendingEntries)
}

describe.sequential('Story 9.4 AC-9 through AC-16: platform-audit routes', () => {
  suite.registerLifecycle()

  afterEach(async () => {
    await resetMaintenanceState()
  })

  it('AC-10/Story 9.8 AC-M9: 401 with no auth header on every platform-audit route', async () => {
    for (const res of [
      await getEvents(suite.app, {}),
      await getVerify(suite.app, {}, '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'),
      await postMaintenance(suite.app, {}, { reason: 'x' }),
      await suite.app.inject({ method: 'GET', url: MAINTENANCE_URL }),
    ]) {
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'access_token_missing' })
    }
  })

  it('AC-10/AC-12: 403 platform_operator_required for a non-operator org owner, with X-Log-Scope header', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'platform-audit-nonop',
      orgNamePrefix: 'Platform Audit NonOp',
      password: PASSWORD,
    })
    const res = await getEvents(suite.app, owner.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
    expect(res.headers['x-log-scope']).toBe('platform')
  })

  it('AC-10: 403 mfa_required for a platform operator who never enrolled MFA', async () => {
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `platform-audit-no-mfa-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Platform Audit No MFA ${randomUUID()}`,
    })
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, registered.userId))
    })
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )
    const res = await getEvents(suite.app, registered.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('AC-9: GET /platform/audit/events returns an empty-but-200 result for a fresh filter with no matches', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-events-empty',
      orgNamePrefix: 'Platform Audit Events Empty',
      password: PASSWORD,
    })
    const res = await getEvents(suite.app, operator.cookies, `?actionType=${randomUUID()}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { items: [], page: 1, limit: 20, total: 0 } })
  })

  it('AC-9: GET /platform/audit/events?limit=500 returns 422 validation_error', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-events-limit',
      orgNamePrefix: 'Platform Audit Events Limit',
      password: PASSWORD,
    })
    const res = await getEvents(suite.app, operator.cookies, '?limit=500')
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('AC-9: GET /platform/audit/events lists a row written by POST /platform/maintenance-mode', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-events-list',
      orgNamePrefix: 'Platform Audit Events List',
      password: PASSWORD,
    })
    const uniqueReason = `reason-${randomUUID()}`
    const activate = await postMaintenance(suite.app, operator.cookies, { reason: uniqueReason })
    expect(activate.statusCode).toBe(200)

    const res = await getEvents(
      suite.app,
      operator.cookies,
      '?actionType=maintenance_mode.activated'
    )
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { items: Array<{ payload: { reason?: string } }> } }
    expect(body.data.items.some((item) => item.payload.reason === uniqueReason)).toBe(true)
  })

  it('AC-11: GET /platform/audit/verify happy path reports zero failures for a fresh window', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-verify-happy',
      orgNamePrefix: 'Platform Audit Verify Happy',
      password: PASSWORD,
    })
    const from = new Date().toISOString()
    await postMaintenance(suite.app, operator.cookies, { reason: 'verify-happy' })
    const to = new Date(Date.now() + 1000).toISOString()

    const res = await getVerify(suite.app, operator.cookies, `?from=${from}&to=${to}`)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { failedCount: number; rowsChecked: number } }
    expect(body.data.failedCount).toBe(0)
    expect(body.data.rowsChecked).toBeGreaterThanOrEqual(1)
  })

  it('AC-11: GET /platform/audit/verify rejects a range over 90 days with 422 range_too_large', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-verify-range',
      orgNamePrefix: 'Platform Audit Verify Range',
      password: PASSWORD,
    })
    const res = await getVerify(
      suite.app,
      operator.cookies,
      '?from=2020-01-01T00:00:00Z&to=2025-01-01T00:00:00Z'
    )
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'range_too_large' })
  })

  it('AC-11: self-audit — a successful GET /platform/audit/verify call writes its own platform_audit.integrity_verify_run row', async () => {
    const { withPlatformOperatorContext } = await import('@project-vault/db')
    const { platformAuditEvents } = await import('@project-vault/db/schema')

    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-verify-self-audit',
      orgNamePrefix: 'Platform Audit Verify Self Audit',
      password: PASSWORD,
    })
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 1000).toISOString()

    const res = await getVerify(suite.app, operator.cookies, `?from=${from}&to=${to}`)
    expect(res.statusCode).toBe(200)

    const rows = await withPlatformOperatorContext((tx) =>
      tx
        .select()
        .from(platformAuditEvents)
        .where(eq(platformAuditEvents.actionType, 'platform_audit.integrity_verify_run'))
    )
    expect(rows.some((r) => r.operatorId === operator.userId)).toBe(true)
  })

  it('AC-9: filters by operatorId/targetOrgId narrow the result set', async () => {
    const operatorA = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-filter-a',
      orgNamePrefix: 'Platform Audit Filter A',
      password: PASSWORD,
    })
    await postMaintenance(suite.app, operatorA.cookies, { reason: 'filter-test-a' })

    const res = await getEvents(suite.app, operatorA.cookies, `?operatorId=${operatorA.userId}`)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { items: Array<{ operatorId: string }> } }>()
    expect(body.data.items.length).toBeGreaterThan(0)
    expect(body.data.items.every((item) => item.operatorId === operatorA.userId)).toBe(true)
  })

  it('AC-9: filters by targetUserId and from/to date range narrow the result set (Story 10.4 branch coverage)', async () => {
    const operatorB = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-filter-b',
      orgNamePrefix: 'Platform Audit Filter B',
      password: PASSWORD,
    })
    await postMaintenance(suite.app, operatorB.cookies, { reason: 'filter-test-b' })

    // targetUserId narrows to a value that matches no row — still a 200 with an empty result,
    // exercising the query-builder's targetUserId branch without depending on maintenance-mode
    // events carrying a targetUserId.
    const byTargetUser = await getEvents(
      suite.app,
      operatorB.cookies,
      `?targetUserId=${randomUUID()}`
    )
    expect(byTargetUser.statusCode).toBe(200)
    expect(byTargetUser.json<{ data: { items: unknown[] } }>().data.items).toEqual([])

    // from/to bracket the event just written — both branches of the query-builder's date-range
    // filter execute together.
    const from = new Date(Date.now() - 60_000).toISOString()
    const to = new Date(Date.now() + 60_000).toISOString()
    const byRange = await getEvents(
      suite.app,
      operatorB.cookies,
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    )
    expect(byRange.statusCode).toBe(200)
    expect(byRange.json<{ data: { items: unknown[] } }>().data.items.length).toBeGreaterThan(0)
  })

  it('AC-12: X-Log-Scope: platform header present on every response (success and error)', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-log-scope',
      orgNamePrefix: 'Platform Audit Log Scope',
      password: PASSWORD,
    })
    const ok = await getEvents(suite.app, operator.cookies)
    expect(ok.headers['x-log-scope']).toBe('platform')

    const badRange = await getVerify(suite.app, operator.cookies, '?from=bad&to=bad')
    expect(badRange.headers['x-log-scope']).toBe('platform')
  })

  it('AC-14: POST /platform/maintenance-mode activates, then 409 on a second activation', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-maint-activate',
      orgNamePrefix: 'Platform Audit Maint Activate',
      password: PASSWORD,
    })
    const first = await postMaintenance(suite.app, operator.cookies, {
      reason: 'planned maintenance',
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ active: true, reason: 'planned maintenance' })

    const second = await postMaintenance(suite.app, operator.cookies, { reason: 'another reason' })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'maintenance_mode_already_active' })
  })

  it('AC-14: POST /platform/maintenance-mode with no reason returns 422 validation_error', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-maint-noreason',
      orgNamePrefix: 'Platform Audit Maint NoReason',
      password: PASSWORD,
    })
    const res = await postMaintenance(suite.app, operator.cookies, {})
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('AC-16: POST /platform/maintenance-mode { action: "deactivate" } deactivates while the log is available', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'platform-audit-maint-deactivate',
      orgNamePrefix: 'Platform Audit Maint Deactivate',
      password: PASSWORD,
    })
    await postMaintenance(suite.app, operator.cookies, { reason: 'temp' })
    const res = await postMaintenance(suite.app, operator.cookies, { action: 'deactivate' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ active: false })
  })

  // AC-13: matches 8.1's /org/audit/verify rate limit exactly — 20 allowed, 21st rejected.
  it('AC-13: GET /platform/audit/events allows 20 requests/minute, rejects the 21st with 429', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const operator = await registerPlatformOperator(suite.app, {
        emailPrefix: 'platform-audit-ratelimit',
        orgNamePrefix: 'Platform Audit RateLimit',
        password: PASSWORD,
      })
      for (let i = 0; i < 20; i++) {
        const res = await getEvents(suite.app, operator.cookies)
        expect(res.statusCode).toBe(200)
      }
      const res21 = await getEvents(suite.app, operator.cookies)
      expect(res21.statusCode).toBe(429)
      expect(res21.json()).toMatchObject({ code: 'rate_limit_exceeded' })
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
  })

  // AC-20: sealed vault fails closed uniformly on all three routes. Also a regression guard for
  // the code-review finding this story fixed: a route declaring `503` in its response schema
  // without also including vaultGuard's own `{status, message}` shape in that union causes a
  // silent serialization failure (opaque 500) the moment vaultGuard's onRequest hook — not the
  // handler — is what actually produces the 503.
  it('AC-20: sealed vault returns 503 { status: "sealed" } for all three routes (no allow-list entry needed)', async () => {
    const cookie = cookieHeader(
      (
        await registerPlatformOperator(suite.app, {
          emailPrefix: 'platform-audit-sealed',
          orgNamePrefix: 'Platform Audit Sealed',
          password: PASSWORD,
        })
      ).cookies
    )

    const { createApp } = await import('../../app.js')
    const sealedApp = await assertRoutesFailClosedWhileSealed(
      suite.app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        { method: 'GET', url: EVENTS_URL, headers: { cookie } },
        {
          method: 'GET',
          url: `${VERIFY_URL}?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`,
          headers: { cookie },
        },
        { method: 'POST', url: MAINTENANCE_URL, headers: { cookie }, payload: { reason: 'x' } },
      ]
    )
    await sealedApp.close()

    // Re-unseal + reopen a fresh app for any subsequent test in this file.
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    suite.app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  it('D2.4/AC-A4: GET /platform/maintenance-mode returns 403 for non-platform-operator', async () => {
    const nonOperator = await enrollUserWithMfa(suite.app, {
      emailPrefix: `platform-audit-mm-nonop-${randomUUID()}`,
      orgNamePrefix: 'Platform Audit MM NonOp',
      password: PASSWORD,
    })
    const res = await suite.app.inject({
      method: 'GET',
      url: MAINTENANCE_URL,
      headers: { cookie: cookieHeader(nonOperator.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
  })

  it('Story 9.8 AC-M7: GET /platform/maintenance-mode allows an unenrolled platform operator', async () => {
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `platform-audit-mm-no-mfa-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Platform Audit MM No MFA ${randomUUID()}`,
    })
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, registered.userId))
    })
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )

    const res = await suite.app.inject({
      method: 'GET',
      url: MAINTENANCE_URL,
      headers: { cookie: cookieHeader(registered.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { active: false, pendingEntriesCount: expect.any(Number) },
    })
  })

  it('D2.4: GET /platform/maintenance-mode returns current status for a platform operator', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: `platform-audit-mm-status-${randomUUID()}`,
      orgNamePrefix: 'Platform Audit MM Status',
      password: PASSWORD,
    })
    const res = await suite.app.inject({
      method: 'GET',
      url: MAINTENANCE_URL,
      headers: { cookie: cookieHeader(operator.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { active: boolean; pendingEntriesCount: number } }
    expect(body.data.active).toBe(false)
    expect(typeof body.data.pendingEntriesCount).toBe('number')
  })
})
