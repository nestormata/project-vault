import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, organizations, users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { __resetThemeStateForTests, reloadThemes } from './service.js'
import type { createApp } from '../../app.js'

const { initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'theme-selection-routes-passphrase'
const EMAIL_PREFIX = 'theme-selection'
const ORG_NAME_PREFIX = 'Theme Selection'
const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: EMAIL_PREFIX,
  orgNamePrefix: ORG_NAME_PREFIX,
})

const THEMES_URL = '/api/v1/themes'
const ACME_BRAND = 'acme-brand'
const SELECTION_URL = '/api/v1/themes/selection'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

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
 * `acme-brand` theme — bypassing the filesystem/HTTP reload endpoint entirely (this suite tests
 * theme *selection*, not reload, so a direct in-memory seed via the same `reloadThemes()` service
 * function the reload endpoint itself calls is the least-invasive fixture). */
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

async function getThemes(
  app: TestApp,
  cookies: Awaited<ReturnType<typeof registerOwner>>['cookies']
) {
  return app.inject({
    method: 'GET',
    url: THEMES_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function patchSelection(
  app: TestApp,
  cookies: Awaited<ReturnType<typeof registerOwner>>['cookies'],
  payload: unknown
) {
  return app.inject({
    method: 'PATCH',
    url: SELECTION_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

async function readSelectedThemeName(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ selectedThemeName: users.selectedThemeName })
    .from(users)
    .where(eq(users.id, userId))
  return row?.selectedThemeName ?? null
}

describe.sequential('GET /api/v1/themes (Story 16.2 AC-1/AC-5/AC-10)', () => {
  suite.registerLifecycle()

  it('AC-1: lists the base theme plus any compiled custom themes, and the caller selection', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'happy')

    const res = await getThemes(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      themes: [
        { name: 'base', label: 'Default', css: null },
        { name: ACME_BRAND, label: ACME_BRAND },
      ],
      selected: null,
      orgDefaultThemeName: null,
    })
  })

  it('AC-1 edge: returns only the base theme when zero custom themes are installed', async () => {
    await __resetThemeStateForTests()
    const owner = await registerOwner(suite.app, 'empty')

    const res = await getThemes(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      themes: [{ name: 'base', label: 'Default', css: null }],
      selected: null,
      orgDefaultThemeName: null,
    })
  })

  it("Story 16.4 AC-2: includes the caller org's own orgDefaultThemeName when configured", async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'org-default')
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(organizations)
        .set({ defaultThemeName: ACME_BRAND })
        .where(eq(organizations.id, owner.orgId))
    )

    const res = await getThemes(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ orgDefaultThemeName: ACME_BRAND })
  })

  it('Story 16.4 AC-4: cross-tenant isolation — each org only ever sees its own orgDefaultThemeName', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const ownerA = await registerOwner(suite.app, 'org-default-a')
    const ownerB = await registerOwner(suite.app, 'org-default-b')
    await withOrg(ownerA.orgId, (tx) =>
      tx
        .update(organizations)
        .set({ defaultThemeName: ACME_BRAND })
        .where(eq(organizations.id, ownerA.orgId))
    )
    // ownerB's org is left with no default configured (null).

    const resA = await getThemes(suite.app, ownerA.cookies)
    const resB = await getThemes(suite.app, ownerB.cookies)

    expect(resA.json()).toMatchObject({ orgDefaultThemeName: ACME_BRAND })
    expect(resB.json()).toMatchObject({ orgDefaultThemeName: null })
  })

  it('AC-5: a viewer-role (lowest rank) caller succeeds', async () => {
    await __resetThemeStateForTests()
    const owner = await registerOwner(suite.app, 'viewer-read')
    const viewer = await addUserToOrg(suite.app, owner.orgId, 'viewer-read-viewer', {
      orgRole: 'viewer',
    })

    const res = await getThemes(suite.app, viewer.cookies)

    expect(res.statusCode).toBe(200)
  })

  it('AC-5 edge: succeeds for a caller with no MFA enrolled at all', async () => {
    await __resetThemeStateForTests()
    const { registerAndLoginViaApi } = await import('../../__tests__/helpers/auth-test-helpers.js')
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `theme-selection-no-mfa-get-${Date.now()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `Theme Selection No MFA GET ${Date.now()}`,
    })

    const res = await getThemes(suite.app, registered.cookies)

    expect(res.statusCode).toBe(200)
  })
})

describe.sequential('PATCH /api/v1/themes/selection (Story 16.2 AC-2/AC-4/AC-5/AC-7/AC-10)', () => {
  suite.registerLifecycle()

  it('AC-2: selects a compiled custom theme and persists it', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'select')

    const res = await patchSelection(suite.app, owner.cookies, { themeName: ACME_BRAND })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ themeName: ACME_BRAND })
    expect(await readSelectedThemeName(owner.userId)).toBe(ACME_BRAND)
  })

  it('AC-2 edge: selecting null clears back to the base theme', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'clear')
    await patchSelection(suite.app, owner.cookies, { themeName: ACME_BRAND })

    const res = await patchSelection(suite.app, owner.cookies, { themeName: null })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ themeName: null })
    expect(await readSelectedThemeName(owner.userId)).toBeNull()
  })

  it('AC-2 edge: rejects an unknown theme name with 400 and writes no partial selection', async () => {
    await __resetThemeStateForTests()
    const owner = await registerOwner(suite.app, 'unknown')

    const res = await patchSelection(suite.app, owner.cookies, { themeName: 'does-not-exist' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'unknown_theme' })
    expect(await readSelectedThemeName(owner.userId)).toBeNull()
  })

  it('AC-2 edge: Zod rejects a themeName longer than 100 characters before any list lookup', async () => {
    await __resetThemeStateForTests()
    const owner = await registerOwner(suite.app, 'toolong')

    const res = await patchSelection(suite.app, owner.cookies, { themeName: 'x'.repeat(101) })

    expect(res.statusCode).toBe(422)
  })

  it('AC-5: a viewer-role (lowest rank) caller can select their own theme', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'viewer-select')
    const viewer = await addUserToOrg(suite.app, owner.orgId, 'viewer-select-viewer', {
      orgRole: 'viewer',
    })

    const res = await patchSelection(suite.app, viewer.cookies, { themeName: ACME_BRAND })

    expect(res.statusCode).toBe(200)
  })

  it('AC-5 edge: succeeds for a caller with no MFA enrolled at all', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const { registerAndLoginViaApi } = await import('../../__tests__/helpers/auth-test-helpers.js')
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `theme-selection-no-mfa-patch-${Date.now()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `Theme Selection No MFA PATCH ${Date.now()}`,
    })

    const res = await patchSelection(suite.app, registered.cookies, { themeName: ACME_BRAND })

    expect(res.statusCode).toBe(200)
  })

  it('AC-4: writes a THEME_SELECTED audit row with previous/new theme names', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'audit')

    const res = await patchSelection(suite.app, owner.cookies, { themeName: ACME_BRAND })
    expect(res.statusCode).toBe(200)

    const rows = await withOrg(owner.orgId, (tx) =>
      tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, 'theme.selected'))
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ themeName: ACME_BRAND, previousThemeName: null })
  })

  it('AC-4 edge: rolls back the selection change when the audit write fails', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const owner = await registerOwner(suite.app, 'audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error('forced audit failure'))

    try {
      const res = await patchSelection(suite.app, owner.cookies, { themeName: ACME_BRAND })
      expectAuditWriteFailed(res)
      expect(await readSelectedThemeName(owner.userId)).toBeNull()
    } finally {
      auditSpy.mockRestore()
    }
  })

  it('AC-10: cross-tenant isolation — org A selecting a theme never affects org B selected field', async () => {
    await __resetThemeStateForTests()
    await seedAcmeBrandTheme()
    const ownerA = await registerOwner(suite.app, 'cross-a')
    const ownerB = await registerOwner(suite.app, 'cross-b')

    const patchRes = await patchSelection(suite.app, ownerA.cookies, { themeName: ACME_BRAND })
    expect(patchRes.statusCode).toBe(200)

    const getResB = await getThemes(suite.app, ownerB.cookies)
    expect(getResB.json()).toMatchObject({ selected: null })
  })
})
