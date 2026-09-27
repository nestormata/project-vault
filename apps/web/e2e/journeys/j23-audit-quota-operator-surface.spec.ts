import { expect, test } from '@playwright/test'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

/**
 * J23 — Story 22.3's own end-to-end proof of the per-org audit-storage operator surface: the
 * resource-usage page's new "Audit Storage by Organization" table, the inline edit flow, and the
 * overcommit confirm-and-acknowledge flow. Unlike J21/J22 (Story 22.1/22.2's enforcement
 * journeys), this story's surface is pure read/write of configuration/observability data — no
 * enforcement kill switch needs to be enabled — so this journey runs against the SHARED E2E stack
 * (`make e2e`'s docker-compose.e2e.yml), not an isolated one.
 *
 * The platform operator is the FIRST user ever registered, and j1 registers first in file order,
 * so this journey promotes its own user with `setPlatformOperatorViaDb` (setup-only, on the
 * disposable E2E database; Story 43.9, following j29). The API re-reads
 * `users.is_platform_operator` on every request, so the promotion applies to the already-logged-in
 * session. The schema allows one operator, so the helper returns the operator it displaced, which
 * `afterAll` restores. MFA is still enrolled: the /api/v1/admin/resource-usage probe is
 * `requireMfa`.
 */
test.describe.serial('J23 — audit-storage operator surface journey', () => {
  let displacedOperatorEmail: string | null = null

  test.afterAll(async () => {
    if (displacedOperatorEmail) await setPlatformOperatorViaDb(displacedOperatorEmail, true)
  })

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
    const displaced = await setPlatformOperatorViaDb(email, true)
    // Record the operator this worker displaced so afterAll can restore it. `??=` is only a
    // defensive keep-first guard: a Playwright retry runs in a fresh worker (module state is
    // reset), so it does not carry this value across retries. The suite runs `workers: 1`.
    displacedOperatorEmail ??= displaced
    await enrollMfaViaUi(page)

    const resourceUsageCheck = await context.request.get('/api/v1/admin/resource-usage')
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
