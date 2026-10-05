import { expect, test } from '@playwright/test'
import { seedOrgOwner } from './fixtures.js'

// Story 68.10 AC-1 / AC-5, M4 (component replacement): a shell component replacement, a wrapped shell
// component (`pv-original:`), a wrapped `$lib/server` module and a wrapped `$lib/api` module, seen on
// PV pages the pack did not override. The stale-hash negative (`pv-compose --check` exit 1 naming the
// file) runs in the compose stage (compose-mock-pack.sh), where the composer lives.
test.describe('M4 component replacement', () => {
  test('works: the replaced footer renders on PV pages the pack did not override', async ({
    page,
    context,
  }) => {
    await page.goto('/register')
    await expect(page.getByTestId('mock-footer')).toHaveText('mock-ui-pack:m4-footer')
    await seedOrgOwner(context, 'm4-footer')
    await page.goto('/settings')
    await expect(page.getByTestId('mock-footer')).toHaveText('mock-ui-pack:m4-footer')
  })

  test('works: the wrapped account component adds its marker and still contains PV original output', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm4-account')
    await page.goto('/settings')
    await expect(page.getByTestId('mock-account-wrap')).toHaveText('mock-ui-pack:m4-account-wrap')
    // PV's own ShellAccount output is inside the wrap
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  })

  test('works: a region component extracted from a monolithic page is replaced on that page only', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm4-settings-home')
    await page.goto('/settings')
    await expect(page.getByTestId('mock-settings-home')).toHaveText('mock-ui-pack:m4-settings-home')
    // the wrapped variant still contains PV's own header output and the page's nav cards
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await page.goto('/settings/themes')
    await expect(page.getByTestId('mock-settings-home')).toHaveCount(0)
  })

  test('works: the wrapped server module and the wrapped api module apply to their callers', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm4-modules')
    await page.goto('/m4')
    await expect(page.getByTestId('m4-org')).toContainText('(mock-ui-pack-m4)')
    await expect(page.getByTestId('m4-url')).toHaveText(
      '/api/v1/org/audit/exports/job-1/download?via=mock-ui-pack-m4'
    )
  })

  test('fails (denied): the server-module wrap still enforces PV own redirect for an anonymous request', async ({
    request,
  }) => {
    const response = await request.get('/m4', { maxRedirects: 0 })
    expect(response.status()).toBe(303)
    expect(response.headers()['location']).toBe('/login')
  })
})
