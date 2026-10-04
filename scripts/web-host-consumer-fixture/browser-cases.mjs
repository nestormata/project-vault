// Story 68-15 AC-6/AC-7/AC-8: the browser-only facts of M3 injection on a composed host, driven in a
// real Chromium against the built server the consumer fixture started (run.sh keeps the server and
// the API stub up while compose-mode.sh runs this).
//
//   node browser-cases.mjs <repo-root> <base-url>
//
// It runs outside the consumer's `env -i` because the consumer installs no browser: it only talks
// HTTP to the kept server. Every wait has an explicit timeout so a stuck page fails the job instead of
// hanging it. Each case prints `OK: ...`, and any failure exits 1 with its own message.
import { createRequire } from 'node:module'
import { join } from 'node:path'

const say = (text) => process.stdout.write(`${text}\n`)
const complain = (text) => process.stderr.write(`${text}\n`)

const [repoRoot, base] = process.argv.slice(2)
if (!repoRoot || !base) {
  complain('usage: browser-cases.mjs <repo-root> <base-url>')
  process.exit(2)
}
const { chromium } = createRequire(join(repoRoot, 'apps', 'web', 'package.json'))(
  '@playwright/test'
)

const CALLER = 'u1'
const THEME_TEST_ID = 'inject-theme'
const TIMEOUT_MS = 15_000
const NEGATIVE_TIMEOUT_MS = 1_500
const HYDRATION_PROBLEM = /hydration_mismatch|Failed to hydrate/

async function openPage(browser, session) {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'session', value: session, url: base }])
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT_MS)
  const problems = []
  page.on('console', (message) => {
    if (HYDRATION_PROBLEM.test(message.text())) problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return { context, page, problems }
}

/** Loads the page and waits until the injected component hydrated (its effect ran). */
async function loadHydrated(page, path) {
  await page.goto(`${base}${path}`, { waitUntil: 'load' })
  await page.waitForSelector('[data-testid="inject-who"][data-hydrated="true"]')
  // A mismatch warning is logged during hydration, before the effect that set the attribute.
}

async function expectText(page, testId, text, timeout = TIMEOUT_MS) {
  await page.waitForFunction(
    ([id, wanted]) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() === wanted,
    [testId, text],
    { timeout }
  )
}

function fail(message) {
  complain(`fixture: browser case failed: ${message}`)
  process.exit(1)
}

async function hydrationCases(browser) {
  const clean = await openPage(browser, CALLER)
  await loadHydrated(clean.page, '/settings')
  await expectText(clean.page, 'inject-who-id', 'iso:u1')
  if (clean.problems.length > 0)
    fail(`the injected page hydrated with: ${clean.problems.join(' | ')}`)
  await clean.context.close()
  say(
    'OK: the page with the injected component hydrated with no mismatch and no page error (real Chromium)'
  )

  // The oracle: the same check must fail when the server's HTML diverges from what the client renders.
  // The document is intercepted and loses one element of the injected component, which the client
  // still renders.
  const broken = await openPage(browser, CALLER)
  await broken.page.route(`${base}/settings`, async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    const diverged = html.replace(/<span data-testid="inject-who-project">[^<]*<\/span>/, '')
    if (diverged === html)
      fail('the oracle could not find the injected component in the server HTML')
    await route.fulfill({ response, body: diverged })
  })
  await loadHydrated(broken.page, '/settings')
  if (broken.problems.length === 0)
    fail('the hydration oracle did not detect a deliberate server/client mismatch')
  await broken.context.close()
  say('OK: the hydration check fails on deliberately diverging server HTML (the oracle can fail)')
}

async function navigationAndThemeCases(browser) {
  const { context, page, problems } = await openPage(browser, CALLER)
  await loadHydrated(page, '/settings')
  await page.evaluate(() => {
    window.__navprobe = 'alive'
  })
  // Client navigation: an in-app link, no document load (the probe survives only without one).
  await page.locator('a[href$="/settings/themes"]').first().click()
  await page.waitForURL(/\/settings\/themes$/)
  await page.getByRole('heading', { name: 'Themes' }).waitFor()
  if ((await page.evaluate(() => window.__navprobe)) !== 'alive') {
    fail('the click on an in-app link reloaded the document (the navigation probe was lost)')
  }
  say('OK: an in-app link changed the URL and content without a full document load')

  // Theme rune: the injected component reads PV's shared state; PV's own theme flow changes it.
  await expectText(page, THEME_TEST_ID, 'theme:light')
  let failedAsExpected = false
  try {
    await expectText(page, THEME_TEST_ID, 'theme:not-a-theme', NEGATIVE_TIMEOUT_MS)
  } catch {
    failedAsExpected = true
  }
  if (!failedAsExpected)
    fail('the theme text check passed for a text that is not rendered (vacuous oracle)')
  await page.getByLabel('Dark').check()
  await expectText(page, THEME_TEST_ID, 'theme:dark')
  if ((await page.evaluate(() => window.__navprobe)) !== 'alive') {
    fail('the theme change reloaded the document instead of re-rendering the injected component')
  }
  if (problems.length > 0) fail(`page problems during navigation: ${problems.join(' | ')}`)
  await context.close()
  say(
    "OK: a theme change through PV's own UI re-rendered the injected component (light to dark) without a reload"
  )
}

const browser = await chromium.launch({ headless: true })
try {
  await hydrationCases(browser)
  await navigationAndThemeCases(browser)
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await browser.close()
}
