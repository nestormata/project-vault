import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootProjectRouteTestApp } from '../projects/project-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'secalerts',
  orgNamePrefix: 'SecAlerts',
})

async function seedFailedAuthThresholdAlert(orgId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(securityAlerts)
      .values({
        orgId,
        alertType: 'security.failed_auth_threshold',
        severity: 'critical',
        status: 'delivered',
        payload: {
          thresholdType: 'ip',
          thresholdCount: 10,
          windowSeconds: 300,
          attemptCount: 12,
          windowStart: new Date(Date.now() - 300_000).toISOString(),
          windowEnd: new Date().toISOString(),
          ipAddress: '203.0.113.50',
        },
      })
      .returning({ id: securityAlerts.id })
  )
  if (!row) throw new Error('expected failed-auth-threshold alert to be inserted')
  return row.id
}

async function seedAnomalousAccessAlert(orgId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(securityAlerts)
      .values({
        orgId,
        alertType: 'security.anomalous_access',
        severity: 'critical',
        status: 'delivered',
        payload: {
          actorTokenId: null,
          revealedCount: 6,
          revealedCredentialIds: [],
          windowSeconds: 3600,
          windowStart: new Date(Date.now() - 3600_000).toISOString(),
          windowEnd: new Date().toISOString(),
        },
      })
      .returning({ id: securityAlerts.id })
  )
  if (!row) throw new Error('expected anomalous-access alert to be inserted')
  return row.id
}

function listSecurityAlerts(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/org/security-alerts',
    headers: { cookie: cookieHeader(cookies) },
  })
}

function dismissSecurityAlert(app: TestApp, cookies: CookieJar, securityAlertId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/org/security-alerts/${securityAlertId}/dismiss`,
    headers: { cookie: cookieHeader(cookies) },
    payload: {},
  })
}

describe.sequential('security-alerts routes (Story 6.2 ADR-6.2-07, AC 12/18)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('lists both security.failed_auth_threshold and security.anomalous_access alerts with their own payload shapes (ADR-6.2-07 regression guard)', async () => {
    const owner = await registerOwner(app, 'roundtrip')
    const failedAuthId = await seedFailedAuthThresholdAlert(owner.orgId)
    const anomalousId = await seedAnomalousAccessAlert(owner.orgId)

    const res = await listSecurityAlerts(app, owner.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { items: { id: string; alertType: string; payload: Record<string, unknown> }[] }
    }>()

    const failedAuthItem = body.data.items.find((item) => item.id === failedAuthId)
    const anomalousItem = body.data.items.find((item) => item.id === anomalousId)

    // Before ADR-6.2-07's fix, the anomalous-access row would be silently dropped (parsed
    // against the wrong schema) rather than appearing here at all.
    expect(failedAuthItem).toBeDefined()
    expect(anomalousItem).toBeDefined()
    expect(failedAuthItem?.payload).toMatchObject({ thresholdType: 'ip' })
    expect(anomalousItem?.payload).toMatchObject({ revealedCount: 6 })
  })

  it('dismisses a security alert (happy path) and is idempotent on re-dismiss (AC 18)', async () => {
    const owner = await registerOwner(app, 'dismiss-happy')
    const alertId = await seedAnomalousAccessAlert(owner.orgId)

    const first = await dismissSecurityAlert(app, owner.cookies, alertId)
    expect(first.statusCode).toBe(200)
    expect(first.json<{ data: { id: string } }>().data.id).toBe(alertId)

    const second = await dismissSecurityAlert(app, owner.cookies, alertId)
    expect(second.statusCode).toBe(200)
  })

  it('requires admin+ role — a member gets 403 (AC 18)', async () => {
    const owner = await registerOwner(app, 'dismiss-403')
    const alertId = await seedAnomalousAccessAlert(owner.orgId)
    const member = await addUserToOrg(app, owner.orgId, 'member', { orgRole: 'member' })

    const res = await dismissSecurityAlert(app, member.cookies, alertId)
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for a nonexistent securityAlertId', async () => {
    const owner = await registerOwner(app, 'dismiss-404')
    const res = await dismissSecurityAlert(app, owner.cookies, randomUUID())
    expect(res.statusCode).toBe(404)
  })
})
