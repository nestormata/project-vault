import { expect, test } from '@playwright/test'
import { seedOrgOwner } from './fixtures.js'

// Story 68.10 AC-1 / AC-5, M2 (new pages at any path): routes outside any PV prefix, with a page,
// a load and a JSON endpoint; one route under `(app)` (protected by derivation), one outside it
// declared protected (`protectedPaths.add`) and one under `(app)` declared public (`remove`).
const BILLING_DATA = '/billing/data'

test.describe('M2 new pages at any path', () => {
  test('works: a new page, a deep page and a JSON endpoint answer at their own paths', async ({
    page,
    request,
  }) => {
    await page.goto('/billing')
    await expect(page.getByTestId('mock-billing')).toBeVisible()
    await expect(page.getByTestId('mock-billing-plan')).toHaveText('mock-ui-pack:m2-billing-plan')
    await page.goto('/billing/deep/level')
    await expect(page.getByTestId('mock-billing-deep')).toBeVisible()
    const get = await request.get(BILLING_DATA)
    expect((await get.json()) as unknown).toEqual({ marker: 'mock-ui-pack:m2-billing-data' })
    const post = await request.post(BILLING_DATA, { data: { echo: 'm2' } })
    expect((await post.json()) as unknown).toEqual({
      marker: 'mock-ui-pack:m2-billing-post',
      echo: 'm2',
    })
  })

  test('fails: a verb the endpoint does not export is 405', async ({ request }) => {
    expect((await request.put(BILLING_DATA, { data: {} })).status()).toBe(405)
  })

  test('works: the (app) route redirects anonymous users to /login and serves a signed-in user', async ({
    page,
    request,
    context,
  }) => {
    const anonymous = await request.get('/cm-area', { maxRedirects: 0 })
    expect(anonymous.status()).toBe(303)
    expect(anonymous.headers()['location']).toBe('/login')
    await seedOrgOwner(context, 'm2-app')
    await page.goto('/cm-area')
    await expect(page.getByTestId('mock-cm-area')).toContainText('a signed-in user')
  })

  test('fails (denied): every spelling of the protected route behaves like the plain form', async ({
    request,
  }) => {
    const spellings = ['/%63m-area', '/cm-area/__data.json', '/cm-area/']
    for (const path of spellings) {
      const response = await request.get(path, { maxRedirects: 0 })
      const body = await response.text()
      // a 303 to /login, a 308 normalising the trailing slash, or SvelteKit's JSON redirect for a
      // data request: never the page itself
      expect(body, path).not.toContain('mock-ui-pack:m2-cm-area')
      expect([303, 308, 200], path).toContain(response.status())
      if (response.status() === 200) expect(body, path).toContain('"type":"redirect"')
    }
  })

  test('works: a route outside (app) declared protected is guarded, one under (app) declared public is reachable', async ({
    page,
    request,
    context,
  }) => {
    const anonymous = await request.get('/protected-cm', { maxRedirects: 0 })
    expect(anonymous.status()).toBe(303)
    expect(anonymous.headers()['location']).toBe('/login')
    const callback = await request.get('/cm-area/public-callback')
    expect(await callback.text()).toContain('mock-ui-pack:m2-public-callback')
    await seedOrgOwner(context, 'm2-protected')
    await page.goto('/protected-cm')
    await expect(page.getByTestId('mock-protected-cm')).toBeVisible()
  })
})
