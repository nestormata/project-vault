import { expect, test } from '@playwright/test'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

/**
 * J23 — Story 22.3's own end-to-end proof of the per-org audit-storage operator surface: the
 * resource-usage page's new "Audit Storage by Organization" table, the inline edit flow, and the
 * overcommit confirm-and-acknowledge flow. Unlike J21/J22 (Story 22.1/22.2's enforcement
 * journeys), this story's surface is pure read/write of configuration/observability data — no
 * enforcement kill switch needs to be enabled — so this journey runs against the SHARED E2E stack
 * (`make e2e`'s docker-compose.e2e.yml), not an isolated one.
 *
 * Known limitation (documented rather than silently flaky), mirroring J15's own precedent:
 * "platform operator" is granted to the FIRST user EVER registered on the instance, and this repo
 * has no UI/API self-promotion path. This journey skips itself with a clear reason when its own
 * registration does not land that slot, rather than falsely reporting a failure that is really
 * "some other journey/worker registered first."
 */
test.describe.serial('J23 — audit-storage operator surface journey', () => {
  test('AC-5/AC-6/AC-7: per-org table renders, inline edit updates in place, overcommit confirm-and-acknowledge flow', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j23-operator')
    const e2ePassValue = 'e2e-J23-Password-123'
    const { orgId } = await registerAndLoginViaApi(context, {
      email,
      password: e2ePassValue,
      orgName: uniqueOrgName('J23 Org'),
    })
    await enrollMfaViaUi(page)

    const resourceUsageCheck = await context.request.get('/api/v1/admin/resource-usage')
    if (resourceUsageCheck.status() === 403) {
      test.skip(
        // NOSONAR(typescript:S1607)
        true,
        'This registration did not land the instance-wide "first user" platform-operator ' +
          'bootstrap slot (see file-level comment) — skipping rather than failing.'
      )
    }
    expect(resourceUsageCheck.ok(), await resourceUsageCheck.text()).toBeTruthy()

    await page.goto('/platform/settings/resource-usage')
    await expect(page.getByRole('heading', { name: 'Resource Usage' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Audit Storage by Organization' })).toBeVisible()

    // AC-1/AC-6: this operator's own freshly-registered org appears in the table (never omitted,
    // even with zero prior audited writes).
    const ownRow = page.locator('tr', { hasText: orgId })
    await expect(ownRow).toBeVisible()

    // AC-5: inline edit — set a small, well-under-threshold quota and confirm it updates in place.
    // A never-configured org defaults its unit selector to GB (AC-5's defaultByteInputUnit rule),
    // so this explicitly switches to MB before entering "500" — otherwise "500" is interpreted as
    // 500 GB and trips the overcommit flow instead of a plain save.
    await ownRow.getByRole('button', { name: 'Edit' }).click()
    const editForm = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Save' }) })
    await editForm.locator('select').selectOption('MB')
    await editForm.getByPlaceholder('Unlimited').first().fill('500')
    await editForm.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText('Saved').first()).toBeVisible()
    await expect(ownRow).toContainText('500.0 MB')

    // AC-4/AC-5: raising the same org's quota to an intentionally huge value should trip the
    // overcommit bound (well over 80% of the default 50 GB instance limit at the default 3.0x
    // physical-overhead estimate) and surface the confirm-and-acknowledge flow rather than a bare
    // error with no path forward.
    await ownRow.getByRole('button', { name: 'Edit' }).click()
    const editForm2 = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Save' }) })
    const quotaInput = editForm2.getByPlaceholder('Unlimited').first()
    await quotaInput.fill('20')
    const unitSelect = editForm2.locator('select')
    await unitSelect.selectOption('GB')
    await editForm2.getByRole('button', { name: 'Save' }).click()

    const overcommitBanner = page.getByText(/estimated .* of physical storage/i)
    await expect(overcommitBanner).toBeVisible()
    await page.getByRole('button', { name: 'Continue anyway' }).click()

    await expect(page.getByText('Saved').first()).toBeVisible()
    await expect(ownRow).toContainText('20.0 GB')
  })
})
