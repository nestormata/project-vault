import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, orgMemberships } from '@project-vault/db/schema'
import { createTestUser } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { loginExistingUserInOrg } from '../../__tests__/helpers/org-role-test-helpers.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'theming-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const RELOAD_URL = '/api/v1/admin/themes/reload'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function postReload(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: RELOAD_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('POST /api/v1/admin/themes/reload', () => {
  suite.registerLifecycle()

  it('AC-1/AC-2: returns 200 with an empty loaded/failed shape when VAULT_THEMES_DIR is unset/absent', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'theming-reload-happy',
      orgNamePrefix: 'Theming Reload Happy',
      password: PASSWORD,
    })

    const res = await postReload(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ loaded: [], failed: [] })
  }, 20_000)

  it('AC-7/AC-8: writes a THEME_RELOADED audit row on a successful reload', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'theming-reload-audit',
      orgNamePrefix: 'Theming Reload Audit',
      password: PASSWORD,
    })

    const res = await postReload(suite.app, owner.cookies)
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, owner.orgId),
            eq(auditLogEntries.eventType, 'theme.reloaded')
          )
        )
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ loadedCount: 0, failedCount: 0, failedFiles: [] })
  }, 20_000)

  it('returns 403 insufficient_role when caller is member (not admin or owner)', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'theming-reload-member',
      orgNamePrefix: 'Theming Reload Member',
      password: PASSWORD,
    })
    const memberUserId = await createTestUser('theming-route-member')
    const memberCookies = await loginExistingUserInOrg(suite.app, {
      userId: memberUserId,
      orgId: owner.orgId,
      role: 'member',
    })

    const res = await postReload(suite.app, memberCookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'insufficient_role' })
  }, 20_000)

  it('returns 403 mfa_required for an admin/owner who never enrolled MFA', async () => {
    const { registerAndLoginViaApi } = await import('../../__tests__/helpers/auth-test-helpers.js')
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `theming-reload-no-mfa-${Date.now()}@example.com`,
      password: PASSWORD,
      orgName: `Theming Reload No MFA ${Date.now()}`,
    })
    // registration starts a grace period for owner/admin roles (Story 1.12) — expire it so the
    // MFA gate actually triggers, same pattern as platform-audit/routes.test.ts's AC-10.
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )

    const res = await postReload(suite.app, registered.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  }, 20_000)

  it('rate-limits after 10 requests from the same admin (429, matches admin/notifications/test precedent)', async () => {
    // bootstrapRouteIntegrationTest() sets RATE_LIMIT_TEST_BYPASS=true globally so unrelated
    // fixture setup never trips rate limits incidentally — opt back into real enforcement here,
    // matching org/default-locale-settings-routes.test.ts's AC5 precedent.
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const owner = await enrollUserWithMfa(suite.app, {
        emailPrefix: 'theming-reload-ratelimit',
        orgNamePrefix: 'Theming Reload Rate Limit',
        password: PASSWORD,
      })

      const statuses: number[] = []
      for (let i = 0; i < 11; i += 1) {
        const res = await postReload(suite.app, owner.cookies)
        statuses.push(res.statusCode)
      }

      expect(statuses.slice(0, 10).every((code) => code === 200)).toBe(true)
      expect(statuses[10]).toBe(429)
    } finally {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
    }
  }, 30_000)
})
