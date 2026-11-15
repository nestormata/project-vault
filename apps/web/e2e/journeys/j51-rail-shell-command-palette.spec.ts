import type { ChildProcess } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { enrollMfaDirect } from '../fixtures/db.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
  type Appearance,
} from '../fixtures/appearance.js'
import {
  registerAndLoginIsolated,
  setupIsolatedFullStack,
  teardownIsolatedStack,
  type WebHandle,
} from '../fixtures/isolated-stack-shared.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

/**
 * J51 (Story 73.15): opening the command palette under `WEB_SHELL_VARIANT=rail` must not throw
 * Svelte `state_unsafe_mutation`. The shared E2E compose stack is the header shell in CI, so this
 * journey boots a pure pv-web isolated process with `WEB_SHELL_VARIANT=rail` and no CM pack.
 */

const DB_NAME = 'project_vault_j51_rail_palette_e2e'
const PASSWORD = 'j51-rail-palette-e2e-Password-1'
const BOTTOM_BAR = 'bottom-bar'

let apiProcess: ChildProcess | undefined
let webHandle: WebHandle | undefined
let baseUrl = ''
let apiBase = ''

function attachPageErrors(page: Page) {
  const pageErrors: string[] = []
  const mutationConsole: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/state_unsafe_mutation/i.test(text)) mutationConsole.push(text)
  })
  return { pageErrors, mutationConsole }
}

async function openTypeDismiss(page: Page, origin: string, appearance: Appearance) {
  const heading = page.getByRole('heading', { name: 'Secret overview' })
  await gotoHydrated(page, `${origin}/dashboard`, heading)
  await expectAppearanceApplied(page, appearance)
  if (appearance.narrow) {
    await expect(page.getByTestId(BOTTOM_BAR)).toBeVisible()
  } else {
    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await expect(page.getByTestId(BOTTOM_BAR)).toHaveCount(1)
  }
  await page.keyboard.press('Control+K')
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  await expect(dialog).toBeVisible()
  if (appearance.narrow) {
    await expect(page.getByTestId(BOTTOM_BAR)).toHaveCount(0)
  }
  const query = `zz-${Date.now().toString(36)}-nothing`
  await dialog.getByRole('combobox', { name: 'Search' }).fill(query)
  await expect(dialog.getByText(`No results for "${query}"`)).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

test.describe.serial('J51 isolated rail web — command palette (Story 73.15)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000)
    ;({ apiProcess, webHandle, baseUrl, apiBase } = await setupIsolatedFullStack({
      dbName: DB_NAME,
      apiLogLabel: 'api-j51-rail',
      webLogLabel: 'web-j51-rail',
      vaultPassphrase: 'j51-rail-palette-e2e-passphrase',
      debugLogLevelEnvVar: 'J51_DEBUG_LOG_LEVEL',
      webExtraEnv: { WEB_SHELL_VARIANT: 'rail' },
    }))
  })

  test.afterAll(async () => {
    await teardownIsolatedStack({
      webHandle,
      apiHandle: apiProcess ? { process: apiProcess } : undefined,
      dbName: DB_NAME,
    })
  })

  describeEachAppearance('J51 rail palette isolated', (appearance) => {
    test('open, type, dismiss with no state_unsafe_mutation', async ({ page, context }) => {
      test.setTimeout(90_000)
      const errors = attachPageErrors(page)
      const identity = await registerAndLoginIsolated(context.request, apiBase, {
        email: uniqueEmail('j51-rail'),
        password: PASSWORD,
        orgName: uniqueOrgName('J51 Rail Org'),
      })
      await enrollMfaDirect(identity.userId, DB_NAME)
      await openTypeDismiss(page, baseUrl, appearance)
      expect(errors.pageErrors, errors.pageErrors.join('\n')).toEqual([])
      expect(errors.mutationConsole).toEqual([])
    })
  })
})
