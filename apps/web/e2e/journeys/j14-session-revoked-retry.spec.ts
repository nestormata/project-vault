import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const FIELD_1_VALUE = 'Field 1 value'
const FIELD_2_VALUE = 'Field 2 value'

// J14 — regression test for a fast-navigation false sign-out. SvelteKit fires several
// concurrent requests during rapid navigation; if one wins a server-side refresh-token
// rotation, a sibling client-side apiFetch still holding the now-stale access token gets a 401
// `session_revoked` (apps/api's authenticate plugin, assertSessionMatchesClaims). Before the
// fix, `isRefreshableAccessError()` in apps/web/src/lib/api/client.ts only retried
// `access_token_missing`/`access_token_invalid`, not `session_revoked` — so the mutation failed
// outright and the UI surfaced a false "Your session expired" message even though the session
// was perfectly valid, just recently rotated.
test.describe('J14 — session_revoked on a client mutation is retried, not a false sign-out', () => {
  test('a mutation that hits session_revoked once transparently refreshes and retries', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j14-owner')
    const password = OWNER_PASSWORD
    const orgName = uniqueOrgName('J14 Org')

    await registerAndLoginViaApi(context, { email, password, orgName })

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J14 Project'),
      slug: `j14-${Date.now()}`,
    })
    const projectId = project.id

    await page.goto(`/projects/${projectId}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j14-db-login')
    await page.getByLabel('Template', { exact: true }).selectOption('login')
    await page.getByLabel(FIELD_1_VALUE).fill('svc-account')
    await page.getByLabel(FIELD_2_VALUE).fill('initial-password')
    await page.getByRole('button', { name: 'Create credential' }).click()
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)

    await page.getByRole('button', { name: 'Edit fields' }).click()
    await expect(page.getByRole('button', { name: 'Save fields' })).toBeVisible()

    // Simulate the race deterministically: the first attempt at the mutation is answered as if a
    // concurrent request had just rotated the session out from under it. The refresh call and the
    // retried mutation are both left unmocked and hit the real API, since the underlying session
    // is genuinely still valid (only the response to the *first* mutation attempt is faked).
    let versionCallCount = 0
    await page.route(`**/api/v1/projects/${projectId}/credentials/*/versions`, async (route) => {
      // Scoped to POST (the "Save fields" mutation) so a future GET added to this same path
      // (e.g. version history) can't be silently consumed by this fake and desync the count.
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      versionCallCount += 1
      if (versionCallCount === 1) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'session_revoked', message: 'Session has been revoked' }),
        })
        return
      }
      await route.continue()
    })

    await page.getByRole('button', { name: 'Save fields' }).click()

    // The retry must be silent: no false "session expired" sign-out message, and the save
    // completes normally (edit mode closes back to the read view).
    await expect(page.getByText('Your session expired')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Edit fields' })).toBeVisible()
    expect(versionCallCount).toBe(2)
  })
})
