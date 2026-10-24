import { expect, test } from '@playwright/test'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import { open, precedes, seedOrgOwner, trackHydrationMismatch } from './fixtures.js'

// Story 69.10 AC-4 / 69-6 AC-8 case 12 (probe order): the pack fills sub-region points the users
// panel and the platform settings page gained when their big region components were split. Each
// fill must land BETWEEN the two PV sections it targets (DOM order), not at the end of the region.
// Render-only fills; the existing mechanism cases are untouched.
const ID = {
  usersDormancy: 'mock-p10-users-dormancy',
  usersTable: 'mock-p10-users-table',
  smtpServer: 'mock-p10-smtp-server',
  settingsForm: 'mock-p10-settings-form',
} as const
const SENTINEL = 'mock-ui-pack:m3-p10'
const USERS = '/settings/users'
const PLATFORM_SETTINGS = '/platform/settings'

test.describe('M3 sub-region points on the users panel and the platform settings page', () => {
  test('works: users panel fills sit between the PV cards and above the table', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p10-users')
    await open(page, USERS, page.getByTestId(ID.usersDormancy))
    const dormancy = page.getByTestId(ID.usersDormancy)
    await expect(dormancy).toContainText(`${SENTINEL}-settings.users.machine-dormancy`)
    // after the machine-key card's own save button, before the next card
    expect(await precedes(page.getByRole('button', { name: 'Save', exact: true }), dormancy)).toBe(
      true
    )
    expect(
      await precedes(dormancy, page.getByRole('heading', { name: 'User dormancy alerts' }))
    ).toBe(true)
    // the table fill sits after the last settings card, before the table itself
    const table = page.getByTestId(ID.usersTable)
    await expect(table).toContainText(`${SENTINEL}-settings.users.table`)
    expect(await precedes(page.getByRole('button', { name: 'Save default language' }), table)).toBe(
      true
    )
    expect(await precedes(table, page.getByRole('table'))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: platform settings fills sit inside the SMTP grid and before the Save button', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const operator = await seedOrgOwner(context, 'p10-settings')
    const displaced = await setPlatformOperatorViaDb(operator.email, true)
    try {
      await open(page, PLATFORM_SETTINGS, page.getByTestId(ID.smtpServer))
      const server = page.getByTestId(ID.smtpServer)
      await expect(server).toContainText(`${SENTINEL}-platform.settings.smtp-server`)
      // between the Port field and the Username field
      expect(await precedes(page.locator('#smtp-port-help'), server)).toBe(true)
      expect(await precedes(server, page.getByText('Username', { exact: true }))).toBe(true)
      // the form fill: after the last card, before the Save settings button
      const form = page.getByTestId(ID.settingsForm)
      await expect(form).toContainText(`${SENTINEL}-platform.settings.form`)
      expect(await precedes(page.getByRole('heading', { name: 'Instance Policy' }), form)).toBe(
        true
      )
      expect(await precedes(form, page.getByRole('button', { name: 'Save settings' }))).toBe(true)
      expect(mismatches()).toEqual([])
    } finally {
      await setPlatformOperatorViaDb(operator.email, false)
      if (displaced !== null) await setPlatformOperatorViaDb(displaced, true)
    }
  })

  test('fails (authorization): a non-operator gets PV own notice and no sub-region fill', async ({
    context,
  }) => {
    await seedOrgOwner(context, 'p10-nonop')
    const html = (await (await context.request.get(PLATFORM_SETTINGS)).text()).replaceAll(
      '<!---->',
      ''
    )
    expect(html).toContain('Platform Operator Access Required')
    for (const id of [ID.smtpServer, ID.settingsForm]) expect(html).not.toContain(id)
    const data = await context.request.get(`${PLATFORM_SETTINGS}/__data.json`)
    expect(await data.text()).not.toContain(SENTINEL)
  })
})
