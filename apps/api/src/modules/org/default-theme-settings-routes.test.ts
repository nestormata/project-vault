import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, organizations } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { __resetThemeStateForTests, reloadThemes } from '../theming/service.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const EMAIL_PREFIX = 'org-default-theme-settings'
const ORG_NAME_PREFIX = 'Org Default Theme Settings'
const membershipHelpers = { emailPrefix: EMAIL_PREFIX, orgNamePrefix: ORG_NAME_PREFIX }
const { registerOwner, addUserToOrg } = createMembershipTestHelpers(membershipHelpers)

const PASSPHRASE = 'org-default-theme-settings-routes-passphrase'
const ACME_BRAND = 'acme-brand'
const url = (orgId: string) => `/api/v1/organizations/${orgId}/default-theme-settings`

async function readDefaultThemeName(orgId: string): Promise<string | null | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(organizations).where(eq(organizations.id, orgId))
  )
  return row?.defaultThemeName
}

function fixtureDeps(files: Record<string, { content: string }>) {
  const readdir = vi.fn(async () => Object.keys(files))
  const stat = vi.fn(async (filePath: string) => {
    const name = filePath.split('/').pop() as string
    const fixture = files[name]
    if (!fixture) throw new Error('ENOENT')
    return { size: Buffer.byteLength(fixture.content, 'utf-8') }
  })
  const readFileBounded = vi.fn(async (filePath: string) => {
    const name = filePath.split('/').pop() as string
    const fixture = files[name]
    if (!fixture) throw new Error('ENOENT')
    return fixture.content
  })
  return { readdir, stat, readFileBounded }
}

/** Seeds the module-level compiled-themes state with a single real, successfully-compiled
 * `acme-brand` theme — same fixture strategy `selection-routes.test.ts` uses. */
async function seedAcmeBrandTheme(): Promise<void> {
  await reloadThemes(
    '/fixture/themes',
    fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({ name: ACME_BRAND, tokens: { radiusMd: '4px' } }),
      },
    })
  )
}

describe.sequential(
  'PATCH /api/v1/organizations/:orgId/default-theme-settings (Story 16.4 AC-1/4/5/7/8/9)',
  () => {
    let app: TestApp

    beforeAll(async () => {
      await resetVaultForTest()
      await initVaultForTest(initVault, PASSPHRASE)
      app = await createApp({ logger: false, vaultGuardEnabled: true })
      await seedAcmeBrandTheme()
    })

    afterAll(async () => {
      __resetThemeStateForTests()
      await app.close()
      await resetVaultForTest()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('AC-1: an admin-role user sets the org default theme to a currently-compiled theme', async () => {
      const owner = await registerOwner(app, 'admin-update')
      const admin = await addUserToOrg(app, owner.orgId, 'admin-update-admin', {
        orgRole: 'admin',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(admin.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: { orgId: owner.orgId, defaultThemeName: ACME_BRAND },
      })
      expect(await readDefaultThemeName(owner.orgId)).toBe(ACME_BRAND)
    })

    it('AC-1: an owner-role user succeeds identically to an admin', async () => {
      const owner = await registerOwner(app, 'owner-update')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(res.statusCode).toBe(200)
      expect(await readDefaultThemeName(owner.orgId)).toBe(ACME_BRAND)
    })

    it('AC-1: clearing a previously-set org default back to null succeeds', async () => {
      const owner = await registerOwner(app, 'clear')
      const setRes = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: ACME_BRAND },
      })
      expect(setRes.statusCode).toBe(200)

      const clearRes = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: null },
      })

      expect(clearRes.statusCode).toBe(200)
      expect(clearRes.json()).toMatchObject({
        data: { orgId: owner.orgId, defaultThemeName: null },
      })
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-1 edge: an unknown theme name (not currently compiled) is rejected 400 unknown_theme, not 422 — no DB write', async () => {
      const owner = await registerOwner(app, 'unknown-theme')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: 'does-not-exist' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        code: 'unknown_theme',
        message: "unknown theme 'does-not-exist'",
      })
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-1 edge: a member role is rejected with 403 and the column is unchanged', async () => {
      const owner = await registerOwner(app, 'member-forbidden')
      const member = await addUserToOrg(app, owner.orgId, 'member-forbidden-member', {
        orgRole: 'member',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(member.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(res.statusCode).toBe(403)
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-1 edge: a viewer role is rejected with 403', async () => {
      const owner = await registerOwner(app, 'viewer-forbidden')
      const viewer = await addUserToOrg(app, owner.orgId, 'viewer-forbidden-viewer', {
        orgRole: 'viewer',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(viewer.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(res.statusCode).toBe(403)
    })

    it("AC-1 edge: PATCHing a different org than the caller's own returns 404, not 403, and does not touch the DB", async () => {
      const owner1 = await registerOwner(app, 'cross-org-caller')
      const owner2 = await registerOwner(app, 'cross-org-target')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner2.orgId),
        headers: { cookie: cookieHeader(owner1.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(res.statusCode).toBe(404)
      expect(await readDefaultThemeName(owner2.orgId)).toBeNull()
    })

    it('AC-1 edge (Red Team Round 2): the 404 body is byte-for-byte identical for a nonexistent org id vs. an org that exists but belongs to another tenant', async () => {
      const owner1 = await registerOwner(app, 'nonleak-caller')
      const owner2 = await registerOwner(app, 'nonleak-target')
      // A syntactically-valid but freshly-generated UUID is guaranteed not to exist as an org row.
      const nonexistentOrgId = randomUUID()

      const resNonexistent = await app.inject({
        method: 'PATCH',
        url: url(nonexistentOrgId),
        headers: { cookie: cookieHeader(owner1.cookies) },
        payload: { themeName: ACME_BRAND },
      })
      const resOtherTenant = await app.inject({
        method: 'PATCH',
        url: url(owner2.orgId),
        headers: { cookie: cookieHeader(owner1.cookies) },
        payload: { themeName: ACME_BRAND },
      })

      expect(resNonexistent.statusCode).toBe(404)
      expect(resOtherTenant.statusCode).toBe(404)
      // byte-for-byte identical: same headers and same JSON body, no distinguishing signal.
      expect(resNonexistent.json()).toEqual(resOtherTenant.json())
      expect(resNonexistent.headers['content-length']).toBe(
        resOtherTenant.headers['content-length']
      )
    })

    it('AC-1 edge: .strict() rejects a body carrying an extra orgId field with 422 before touching the DB', async () => {
      const owner = await registerOwner(app, 'strict')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: ACME_BRAND, orgId: owner.orgId },
      })

      expect(res.statusCode).toBe(422)
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-1 edge: an oversized themeName (> 100 chars) is rejected 422 before the list-membership check runs', async () => {
      const owner = await registerOwner(app, 'oversized')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: 'x'.repeat(101) },
      })

      expect(res.statusCode).toBe(422)
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-5: writes a human audit entry recording the previous and new default theme', async () => {
      const owner = await registerOwner(app, 'audit')

      const res = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: ACME_BRAND },
      })
      expect(res.statusCode).toBe(200)

      const [entry] = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'organization.default_theme_updated'))
      )
      expect(entry).toBeDefined()
      expect(entry?.payload).toMatchObject({
        previousDefaultThemeName: null,
        newDefaultThemeName: ACME_BRAND,
      })
    })

    it('AC-5 edge: rolls back the column change when the audit write fails (503 audit_write_failed)', async () => {
      const owner = await registerOwner(app, 'audit-fail')
      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error('forced audit failure'))

      try {
        const res = await app.inject({
          method: 'PATCH',
          url: url(owner.orgId),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: { themeName: ACME_BRAND },
        })
        expectAuditWriteFailed(res)
        expect(await readDefaultThemeName(owner.orgId)).toBeNull()
      } finally {
        auditSpy.mockRestore()
      }
    })

    it('AC-7: two sequential PATCHes from different admin sessions are last-write-wins', async () => {
      const owner = await registerOwner(app, 'concurrent')
      const admin = await addUserToOrg(app, owner.orgId, 'concurrent-admin', { orgRole: 'admin' })

      const first = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { themeName: ACME_BRAND },
      })
      const second = await app.inject({
        method: 'PATCH',
        url: url(owner.orgId),
        headers: { cookie: cookieHeader(admin.cookies) },
        payload: { themeName: null },
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })

    it('AC-8: throttles far-more-than-normal repeated requests with 429', async () => {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
      try {
        const owner = await registerOwner(app, 'rate-limit')
        const responses = []
        for (let i = 0; i < 11; i += 1) {
          responses.push(
            await app.inject({
              method: 'PATCH',
              url: url(owner.orgId),
              headers: { cookie: cookieHeader(owner.cookies) },
              payload: { themeName: i % 2 === 0 ? ACME_BRAND : null },
            })
          )
        }
        const lastResponse = responses.at(-1)
        expect(lastResponse?.statusCode).toBe(429)
      } finally {
        delete process.env['RATE_LIMIT_TEST_BYPASS']
      }
    }, 30_000)

    it('AC-9: an existing org (pre-dating this migration) already has a null default theme', async () => {
      const owner = await registerOwner(app, 'default-value')
      expect(await readDefaultThemeName(owner.orgId)).toBeNull()
    })
  }
)
