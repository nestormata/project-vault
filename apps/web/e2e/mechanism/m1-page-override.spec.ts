import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { open, seedOrgOwner } from './fixtures.js'

// Story 68.10 AC-1 / AC-5, M1 (page override): every override of the mock UI pack against the
// composed image and the real API. Titles say `works` for the positive case and `fails` or `denied`
// for the failure or edge case of each row (the wiring test pins that convention).
const REPO = join(import.meta.dirname, '..', '..', '..', '..')
const packFavicon = readFileSync(join(REPO, 'fixtures/mock-ui-pack/ui-pack/static/favicon.png'))
const pvFavicon = readFileSync(join(REPO, 'apps/web/static/favicon.png'))

test.describe('M1 page override', () => {
  test('works: the authenticated dashboard override renders its own load data and its action round-trips', async ({
    page,
    context,
  }) => {
    const user = await seedOrgOwner(context, 'm1-dashboard')
    await open(page, '/dashboard', page.getByLabel('Note'))
    await expect(page.getByTestId('mock-dashboard-load')).toHaveText(
      'mock-ui-pack:m1-dashboard-load'
    )
    // read from the real API with the real session cookie, not from a stub
    await expect(page.getByTestId('mock-dashboard-user')).toHaveText(user.userId)
    await page.getByLabel('Note').fill('hello-m1')
    await page.getByRole('button', { name: 'Save note' }).click()
    await expect(page.getByTestId('mock-dashboard-note-result')).toHaveText(
      'mock-ui-pack:m1-dashboard-note:hello-m1'
    )
  })

  test('works: the 303 branch of the overridden load redirects to /settings', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm1-redirect')
    await page.goto('/dashboard?mock-redirect=1')
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('works: the public page override renders its load and round-trips its form action', async ({
    page,
  }) => {
    await open(page, '/recovery', page.getByLabel('Word'))
    await expect(page.getByTestId('mock-recovery-load')).toHaveText('mock-ui-pack:m1-recovery-load')
    await page.getByLabel('Word').fill('ping-m1')
    await page.getByRole('button', { name: 'Ping' }).click()
    await expect(page.getByTestId('mock-recovery-pong')).toHaveText(
      'mock-ui-pack:m1-recovery-pong:ping-m1'
    )
  })

  test('fails (denied): an anonymous request to the overridden dashboard is redirected to /login', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('works: the layout override, the app.html override and the hooks override are in effect', async ({
    page,
  }) => {
    const response = await page.goto('/login')
    await expect(page.getByTestId('mock-auth-layout')).toBeVisible()
    await expect(page.locator('meta[name="mock-ui-pack"]')).toHaveAttribute(
      'content',
      'm1-app-html'
    )
    // the full hooks.server.ts override: its own handle and its policy default, beside PV's CSP
    const headers = response?.headers() ?? {}
    expect(headers['x-mock-ui-pack-handle']).toBe('m1-hooks-handle')
    expect(headers['x-mock-ui-pack-policy']).toBe('m1-hooks-policy')
    expect(headers['x-frame-options']).toBe('DENY')
  })

  test('works: the static override serves the pack favicon bytes, not PV, and a new static file', async ({
    request,
  }) => {
    const favicon = await request.get('/favicon.png')
    expect(favicon.ok()).toBeTruthy()
    const bytes = await favicon.body()
    expect(bytes.equals(packFavicon)).toBe(true)
    expect(bytes.equals(pvFavicon)).toBe(false)
    const added = await request.get('/mock-ui-pack.txt')
    expect(await added.text()).toContain('mock-ui-pack:m1-static-file')
  })

  test('fails: the removed route is 404 exactly as declared; PV public routes it did not remove still serve', async ({
    request,
  }) => {
    expect((await request.get('/settings/external-identities')).status()).toBe(404)
    expect((await request.get('/status/abc')).status()).toBe(200)
    expect((await request.get('/register')).status()).toBe(200)
  })

  test('works: the root error page renders for a forced 404 and a forced 500 without leaking a stack or the thrown message', async ({
    page,
  }) => {
    await page.goto('/mock-ui-pack-no-such-route')
    await expect(page.getByTestId('mock-error')).toContainText('mock-ui-pack:m1-error')
    await expect(page.getByTestId('mock-error-status')).toHaveText('404')
    const boom = await page.goto('/boom')
    expect(boom?.status()).toBe(500)
    await expect(page.getByTestId('mock-error')).toContainText('mock-ui-pack:m1-error')
    await expect(page.getByTestId('mock-error-status')).toHaveText('500')
    const body = await page.content()
    expect(body).not.toContain('boom-internal-detail')
    expect(body).not.toMatch(/\bat [A-Za-z_.<>]+ \(|node_modules|\.ts:\d+/)
  })
})
