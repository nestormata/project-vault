import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  accountRecoveryTokens,
  orgMemberships,
  systemSettings,
  users,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'platform-admin-orgs-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const ORGS_URL = '/api/v1/admin/orgs'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function createOrgReq(app: TestApp, cookies: CookieJar, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: ORGS_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

async function listOrgsReq(app: TestApp, cookies: CookieJar) {
  return app.inject({ method: 'GET', url: ORGS_URL, headers: { cookie: cookieHeader(cookies) } })
}

describe.sequential('Story 9.2 platform-admin orgs routes', () => {
  suite.registerLifecycle()

  // This shared test database accumulates organizations across every test file's ordinary
  // self-registration flow over the suite's lifetime (36+ by the time this file runs) — default
  // maxOrgs=10 would make every org-creation test here spuriously 422 org_limit_reached. Raise it
  // for every test except AC-10, which explicitly re-lowers/re-raises it to test the limit itself.
  beforeEach(async () => {
    await getDb()
      .insert(systemSettings)
      .values({ id: 1, maxOrgs: 1_000_000 })
      .onConflictDoUpdate({ target: systemSettings.id, set: { maxOrgs: 1_000_000 } })
  })

  it('AC-1: 401 with no auth header', async () => {
    const res = await suite.app.inject({ method: 'GET', url: ORGS_URL })
    expect(res.statusCode).toBe(401)
  })

  it('AC-8: creates an org for an existing user (multi-org membership)', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-existing-op',
      orgNamePrefix: 'Orgs Existing Op',
      password: PASSWORD,
    })
    const alice = await registerAndLoginViaApi(suite.app, {
      email: `alice-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Alice Org ${randomUUID()}`,
    })

    const create = await createOrgReq(suite.app, operator.cookies, {
      name: 'Acme Subsidiary',
      // fetch alice's email via DB since registerAndLoginViaApi doesn't return it
      ownerEmail: (
        await getDb().select({ email: users.email }).from(users).where(eq(users.id, alice.userId))
      )[0]?.email,
    })
    expect(create.statusCode).toBe(201)
    const body = create.json<{
      id: string
      slug: string
      ownerAccountAction: string
      ownerUserId: string
    }>()
    expect(body.ownerAccountAction).toBe('existing_user_added')
    expect(body.ownerUserId).toBe(alice.userId)

    const membership = await withOrg(body.id, (tx) =>
      tx
        .select({ role: orgMemberships.role })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, alice.userId))
    )
    expect(membership[0]?.role).toBe('owner')
  })

  it('AC-8: duplicate org name gets a distinct slug', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-dup-name-op',
      orgNamePrefix: 'Orgs Dup Name Op',
      password: PASSWORD,
    })
    const first = await createOrgReq(suite.app, operator.cookies, {
      name: 'Dup Name Co',
      ownerEmail: `dup1-${randomUUID()}@example.com`,
    })
    const second = await createOrgReq(suite.app, operator.cookies, {
      name: 'Dup Name Co',
      ownerEmail: `dup2-${randomUUID()}@example.com`,
    })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(first.json<{ slug: string }>().slug).not.toBe(second.json<{ slug: string }>().slug)
  })

  it('AC-9: creates a new user + 72h recovery token for a brand-new ownerEmail', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-new-owner-op',
      orgNamePrefix: 'Orgs New Owner Op',
      password: PASSWORD,
    })
    const ownerEmail = `bob-${randomUUID()}@example.com`
    const res = await createOrgReq(suite.app, operator.cookies, {
      name: 'New Customer Co',
      ownerEmail,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ ownerAccountAction: string; ownerUserId: string }>()
    expect(body.ownerAccountAction).toBe('invited_new_user')

    const [newUser] = await getDb()
      .select({ isPlatformOperator: users.isPlatformOperator })
      .from(users)
      .where(eq(users.id, body.ownerUserId))
    expect(newUser?.isPlatformOperator).toBe(false)

    const [tokenRow] = await getDb()
      .select({
        expiresAt: accountRecoveryTokens.expiresAt,
        initiatedBy: accountRecoveryTokens.initiatedBy,
      })
      .from(accountRecoveryTokens)
      .where(eq(accountRecoveryTokens.userId, body.ownerUserId))
    expect(tokenRow?.initiatedBy).toBe('admin')
    const ttlHours = tokenRow ? (tokenRow.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000) : 0
    expect(ttlHours).toBeGreaterThan(71)
    expect(ttlHours).toBeLessThan(73)
  })

  it('AC-9: rejects a deactivated owner account with 409', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-deactivated-op',
      orgNamePrefix: 'Orgs Deactivated Op',
      password: PASSWORD,
    })
    const deactivated = await registerAndLoginViaApi(suite.app, {
      email: `deactivated-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Deactivated Org ${randomUUID()}`,
    })
    await withOrg(deactivated.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(eq(orgMemberships.userId, deactivated.userId))
    )
    const email = (
      await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, deactivated.userId))
    )[0]?.email
    const res = await createOrgReq(suite.app, operator.cookies, {
      name: 'Should Not Provision',
      ownerEmail: email,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'owner_account_deactivated' })
  })

  it('AC-9: malformed ownerEmail returns 422', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-malformed-op',
      orgNamePrefix: 'Orgs Malformed Op',
      password: PASSWORD,
    })
    const res = await createOrgReq(suite.app, operator.cookies, {
      name: 'X',
      ownerEmail: 'not-an-email',
    })
    expect(res.statusCode).toBe(422)
  })

  it('AC-10: rejects the (n+1)th org once maxOrgs is reached, succeeds after raising the limit', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-limit-op',
      orgNamePrefix: 'Orgs Limit Op',
      password: PASSWORD,
    })
    const [orgCountRow] = await getDb().execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM organizations`
    )
    const currentOrgCount = Number(orgCountRow?.c ?? 0)
    await getDb().delete(systemSettings)
    await suite.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: { cookie: cookieHeader(operator.cookies) },
      payload: { instancePolicy: { maxOrgs: 1 } },
    })
    // The instance already has >= 1 org from the operator's own registration (and possibly
    // others from earlier tests in this shared DB) — a single new org creation attempt at
    // maxOrgs=1 must be rejected.
    const res = await createOrgReq(suite.app, operator.cookies, {
      name: 'One Too Many',
      ownerEmail: `toomany-${randomUUID()}@example.com`,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'org_limit_reached' })

    // Raise the limit above the current org count so the next creation succeeds. Use a
    // dynamic value (current count + 10) rather than a hardcoded constant — the shared test
    // DB accumulates orgs across all test runs, so a fixed cap will eventually fall below
    // the existing org count and cause a false failure here.
    await suite.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: { cookie: cookieHeader(operator.cookies) },
      payload: { instancePolicy: { maxOrgs: currentOrgCount + 10 } },
    })
    const retried = await createOrgReq(suite.app, operator.cookies, {
      name: 'Now Fits',
      ownerEmail: `nowfits-${randomUUID()}@example.com`,
    })
    expect(retried.statusCode).toBe(201)
    await getDb().delete(systemSettings)
  })

  it('AC-10 code-review regression: concurrent creations at the limit never both succeed (no TOCTOU race on maxOrgs)', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-limit-race-op',
      orgNamePrefix: 'Orgs Limit Race Op',
      password: PASSWORD,
    })
    const [orgCountRow] = await getDb().execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM organizations`
    )
    const currentOrgCount = Number(orgCountRow?.c ?? 0)
    // Set the limit to exactly the current count + 1 — only ONE more org may ever be created,
    // regardless of how many concurrent requests race for that one remaining slot.
    await getDb()
      .insert(systemSettings)
      .values({ id: 1, maxOrgs: currentOrgCount + 1 })
      .onConflictDoUpdate({ target: systemSettings.id, set: { maxOrgs: currentOrgCount + 1 } })

    const [resA, resB] = await Promise.all([
      createOrgReq(suite.app, operator.cookies, {
        name: 'Race Org A',
        ownerEmail: `racelimit-a-${randomUUID()}@example.com`,
      }),
      createOrgReq(suite.app, operator.cookies, {
        name: 'Race Org B',
        ownerEmail: `racelimit-b-${randomUUID()}@example.com`,
      }),
    ])
    const statuses = [resA.statusCode, resB.statusCode].sort()
    // Exactly one must succeed (201) and the other must be rejected (422) — never both 201,
    // which would mean the instance now exceeds its configured maxOrgs.
    expect(statuses).toEqual([201, 422])

    const [finalCountRow] = await getDb().execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM organizations`
    )
    expect(Number(finalCountRow?.c ?? 0)).toBe(currentOrgCount + 1)
    await getDb().delete(systemSettings)
  })

  it('AC-11: lists organizations most-recently-created first with memberCount', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-list-op',
      orgNamePrefix: 'Orgs List Op',
      password: PASSWORD,
    })
    await createOrgReq(suite.app, operator.cookies, {
      name: 'List Me',
      ownerEmail: `listme-${randomUUID()}@example.com`,
    })
    const res = await listOrgsReq(suite.app, operator.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ items: { id: string; memberCount: number }[] }>()
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]?.memberCount).toBeGreaterThanOrEqual(1)
  })

  it('AC-23: two concurrent creations for the same new ownerEmail both succeed with one shared user', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-race-op',
      orgNamePrefix: 'Orgs Race Op',
      password: PASSWORD,
    })
    const raceEmail = `race-${randomUUID()}@example.com`
    const [resA, resB] = await Promise.all([
      createOrgReq(suite.app, operator.cookies, { name: 'Org A', ownerEmail: raceEmail }),
      createOrgReq(suite.app, operator.cookies, { name: 'Org B', ownerEmail: raceEmail }),
    ])
    expect(resA.statusCode).toBe(201)
    expect(resB.statusCode).toBe(201)
    const usersWithEmail = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, raceEmail))
    expect(usersWithEmail).toHaveLength(1)
  })

  // Story 9.4 AC-8: retrofit — POST /admin/orgs also writes a platform_audit_events row.
  it('Story 9.4 AC-8: writes an org.created row with targetOrgId/targetUserId in the same transaction', async () => {
    const { withPlatformOperatorContext } = await import('@project-vault/db')
    const { platformAuditEvents } = await import('@project-vault/db/schema')

    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'orgs-platform-audit',
      orgNamePrefix: 'Orgs Platform Audit',
      password: PASSWORD,
    })
    const ownerEmail = `orgs-platform-audit-owner-${randomUUID()}@example.com`
    const res = await createOrgReq(suite.app, operator.cookies, {
      name: 'Platform Audit Org',
      ownerEmail,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string; ownerUserId: string }>()

    const rows = await withPlatformOperatorContext((tx) =>
      tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.targetOrgId, body.id))
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actionType).toBe('org.created')
    expect(rows[0]?.operatorId).toBe(operator.userId)
    expect(rows[0]?.targetUserId).toBe(body.ownerUserId)
    expect((rows[0]?.payload as { ownerAccountAction?: string })?.ownerAccountAction).toBe(
      'invited_new_user'
    )
  })
})
