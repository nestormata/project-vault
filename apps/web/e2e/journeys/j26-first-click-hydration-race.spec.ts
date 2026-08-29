import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  initIsolatedVault,
  stopProcess,
  type WebHandle,
} from '../fixtures/isolated-stack-shared.js'
import {
  startHydrationRaceApi,
  startHydrationRaceWebDev,
  startHydrationRaceWebBuild,
  buildHydrationRaceWeb,
  type ApiHandle,
} from '../fixtures/isolated-hydration-race-stack.js'
import { instrumentHydrationDetection, waitForHydration } from '../fixtures/hydration.js'

/**
 * J26 — Story 28.3 AC1: deterministic reproduction + instrumentation of the swallowed-first-click
 * hydration race reported by QA finding 7. Targets `/settings/language` (cheapest real page to
 * seed — no project/machine-user fixtures — and its `use:enhance`-wrapped native `<form>` gives a
 * second, independently-checkable "zero requests of either kind" signal per the story's
 * Investigation section).
 *
 * Methodology, per the story's own Failure Mode Analysis (round 5 of its elicitation log):
 * `page.click()` already waits for the target to be "actionable," which can itself wait long
 * enough for hydration to finish and silently defeat the very race this journey exists to catch.
 * Every click here is therefore `page.mouse.click()` at a raw coordinate, fired the instant
 * `page.goto()` (or, for the in-app-navigation case, a real link click) resolves — no
 * `waitFor`/`toBeVisible` gate in between — deliberately bypassing Playwright's own readiness
 * heuristics.
 *
 * Instrumentation: an `addInitScript` wraps `EventTarget.prototype.addEventListener` and records
 * `performance.now()` the first time a `'click'` or `'submit'` listener is attached anywhere on
 * the page. Svelte 5 attaches most DOM event handling via a single delegated listener registered
 * during hydrate()/mount(), so this timestamp is a faithful proxy for "the moment this page's
 * handlers became live" — the same moment a real click either lands on an armed page (no-op-free)
 * or a bare, unlistened DOM node (the silent swallow QA reported).
 */

const API_PORT = 34926
const DEV_WEB_PORT = 34927
const BUILD_WEB_PORT = 34928
const DB_NAME = 'project_vault_j26_hydration_race_e2e'
const PASSWORD = 'j26-hydration-race-e2e-Password-1'
const NATIVE_FORM_FALLBACK = 'native-form-fallback'

let apiHandle: ApiHandle
let devWebHandle: WebHandle
let buildWebHandle: WebHandle

type HydrationTiming = { firstListenerAt: number | null }

/** Wraps `addEventListener` before any page script runs, so it observes Svelte's own hydration
 * wiring rather than anything this test itself attaches. */
async function instrumentHydrationTiming(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __hydrationRace: HydrationTiming }
    w.__hydrationRace = { firstListenerAt: null }
    const original = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (w.__hydrationRace.firstListenerAt === null && (type === 'click' || type === 'submit')) {
        w.__hydrationRace.firstListenerAt = performance.now()
      }
      return original.call(this, type, listener, options)
    }
  })
}

async function readHydrationTiming(page: Page): Promise<HydrationTiming> {
  return page.evaluate(
    () => (window as unknown as { __hydrationRace: HydrationTiming }).__hydrationRace
  )
}

/** Registers+logs in via the WEB app's own `/api/v1/*` proxy (not the API origin directly) so the
 * session cookie lands on the web origin — the same mechanism a real browser login uses (see
 * `apps/web/src/routes/api/v1/[...path]/+server.ts`). */
async function registerAndLoginViaWebProxy(
  context: BrowserContext,
  webBase: string,
  label: string
): Promise<void> {
  const email = `j26-${label}-${randomUUID()}@example.test`
  const register = await context.request.post(`${webBase}/api/v1/auth/register`, {
    data: { email, password: PASSWORD, orgName: `J26 ${label} Org ${randomUUID()}` },
  })
  expect(register.ok(), await register.text()).toBeTruthy()

  const login = await context.request.post(`${webBase}/api/v1/auth/login`, {
    data: { email, password: PASSWORD },
  })
  expect(login.ok(), await login.text()).toBeTruthy()

  const onboarding = await context.request.post(`${webBase}/api/v1/users/me/onboarding`, {
    data: { completed: true },
  })
  expect(onboarding.ok(), await onboarding.text()).toBeTruthy()
}

type ClickOutcome = {
  dispatchedAt: number
  requests: string[]
  /** True when the raw click fell through to the form's NATIVE (JS-free) submission — the
   * browser's default `<form method="POST">` behavior when no `submit` listener (e.g.
   * `use:enhance`) has attached yet. This tears down the page's JS execution context (a real,
   * full navigation), so no post-click `page.evaluate()` against the pre-click page is possible —
   * that crash IS the observation, not a test bug. Confirmed once via direct reproduction; not a
   * hypothesis. */
  nativeFormFallbackFired: boolean
  /** Hydration timing read from the PRE-click page context; `null` whenever
   * `nativeFormFallbackFired` is true (that context no longer exists to read from). */
  timing: HydrationTiming | null
}

/** Raw-coordinate, immediate click on the (non-current) language "Select" button — bypasses
 * Playwright's actionability wait entirely (see file header). Returns the timestamp
 * (`performance.now()`, same clock as the instrumentation) the click was dispatched at, the
 * network activity observed in the following short window, and (when the pre-click page context
 * survived) the hydration-timing instrumentation read from it. Reading the timing is folded into
 * this same function, under the same try/catch, because a native-form-fallback navigation can
 * tear down the execution context at any point during or shortly after the click — not
 * necessarily synchronously with `page.mouse.click()` itself. */
async function fireRawImmediateClick(
  page: Page,
  target: ReturnType<Page['getByRole']>
): Promise<ClickOutcome> {
  const requests: string[] = []
  const onRequest = (req: { method: () => string; url: () => string }) => {
    if (req.method() !== 'GET') requests.push(`${req.method()} ${req.url()}`)
  }
  page.on('request', onRequest)

  const box = await target.boundingBox()
  if (!box) throw new Error('J26: target button never rendered in the DOM')
  const dispatchedAt = await page.evaluate(() => performance.now())

  let nativeFormFallbackFired = false
  let timing: HydrationTiming | null = null
  try {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    // Give any request that WAS dispatched a moment to actually fire — this is observing outcome,
    // not waiting for readiness, so it does not defeat the race the way `page.click()` would.
    await page.waitForTimeout(300)
    timing = await readHydrationTiming(page)
  } catch (error) {
    // A raw click landing on a `type="submit"` button before `use:enhance`'s `submit` listener
    // has attached falls through to the browser's native, JS-free form submission — a real full
    // navigation that destroys this page's JS execution context (whether the click itself, the
    // 300ms settle window, or the timing read is what observes the destruction). This is itself
    // direct, positive proof the race was hit (see AC1's own Investigation-section reasoning); it
    // is not a test failure.
    if (String(error).includes('Execution context was destroyed')) {
      nativeFormFallbackFired = true
      await page.waitForLoadState('load').catch(() => {})
    } else {
      throw error
    }
  }

  page.off('request', onRequest)
  return { dispatchedAt, requests, nativeFormFallbackFired, timing }
}

function languageSelectButton(page: Page) {
  // The Spanish option's "Select" button — English is the default current locale in a fresh
  // registration, so this is guaranteed to be a non-disabled `type="submit"` button.
  return page.getByRole('listitem').filter({ hasText: 'Español' }).getByRole('button')
}

test.describe.serial('J26 — first-click hydration race reproduction (Story 28.3 AC1)', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000)
    await createIsolatedDatabase(DB_NAME)
    apiHandle = await startHydrationRaceApi({
      port: API_PORT,
      dbName: DB_NAME,
      webPort: DEV_WEB_PORT,
    })
    await initIsolatedVault(API_PORT, 'j26-hydration-race-e2e-passphrase')
    devWebHandle = await startHydrationRaceWebDev({ port: DEV_WEB_PORT, apiPort: API_PORT })
    // Real `vite build` + adapter-node, matching how `make docker-up` actually serves the app —
    // built once here, reused by every production-mode test below.
    buildHydrationRaceWeb()
    buildWebHandle = await startHydrationRaceWebBuild({ port: BUILD_WEB_PORT, apiPort: API_PORT })
  })

  test.afterAll(async () => {
    if (devWebHandle) await stopProcess(devWebHandle.process)
    if (buildWebHandle) await stopProcess(buildWebHandle.process)
    if (apiHandle) await stopProcess(apiHandle.process)
    await dropIsolatedDatabase(DB_NAME)
  })

  test('AC1 (Vite dev, full page load): measures the click-vs-listener-attachment gap and its effect on the request outcome', async ({
    context,
  }) => {
    const webBase = `http://localhost:${DEV_WEB_PORT}`
    await registerAndLoginViaWebProxy(context, webBase, 'dev-full')
    const page = await context.newPage()
    await instrumentHydrationTiming(page)

    await page.goto(`${webBase}/settings/language`)
    const { dispatchedAt, requests, nativeFormFallbackFired, timing } = await fireRawImmediateClick(
      page,
      languageSelectButton(page)
    )

    if (nativeFormFallbackFired) {
      // AC1's own instrumented-and-confirmed finding for THIS page (which has a real `<form
      // method="POST">` fallback, unlike the other 3 reported buttons): under Vite dev, a raw
      // click fired the instant `page.goto()` resolves lands before `use:enhance`'s `submit`
      // listener attaches, and falls through to a real, full native form submission — a genuine
      // network request, distinct from the silent zero-request swallow the other 3 (plain
      // `onclick`, no enclosing `<form>`) buttons would produce under the identical race, since a
      // bare button has no native fallback to fall through to.
      test
        .info()
        .annotations.push({ type: 'j26-dev-full-load-outcome', description: NATIVE_FORM_FALLBACK })
      // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
      console.log(
        `[J26][dev][full-load] click dispatched at ${dispatchedAt.toFixed(2)}ms — RACE CONFIRMED: ` +
          `raw click fell through to the native, JS-free form submission (use:enhance had not yet ` +
          `attached). requests=${JSON.stringify(requests)}`
      )
      await page.close()
      return
    }

    const gapMs = timing?.firstListenerAt == null ? null : timing.firstListenerAt - dispatchedAt

    test.info().annotations.push({ type: 'j26-dev-full-load-gap-ms', description: String(gapMs) })
    // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
    console.log(
      `[J26][dev][full-load] click dispatched at ${dispatchedAt.toFixed(2)}ms, first click/submit ` +
        `listener attached at ${timing?.firstListenerAt?.toFixed(2) ?? 'never'}ms, ` +
        `gap=${gapMs?.toFixed(2) ?? 'n/a'}ms, requests-in-300ms-window=${JSON.stringify(requests)}`
    )

    // Listener attached before the click landed — no race this run, so the click worked
    // normally: no native full-page navigation (URL unchanged).
    expect(page.url()).toBe(`${webBase}/settings/language`)
    await page.close()
  })

  test('AC1 (production-style build, full page load): same measurement against real `vite build` + adapter-node', async ({
    context,
  }) => {
    const webBase = `http://localhost:${BUILD_WEB_PORT}`
    await registerAndLoginViaWebProxy(context, webBase, 'build-full')
    const page = await context.newPage()
    await instrumentHydrationTiming(page)

    await page.goto(`${webBase}/settings/language`)
    const { dispatchedAt, requests, nativeFormFallbackFired, timing } = await fireRawImmediateClick(
      page,
      languageSelectButton(page)
    )

    if (nativeFormFallbackFired) {
      test
        .info()
        .annotations.push({
          type: 'j26-build-full-load-outcome',
          description: NATIVE_FORM_FALLBACK,
        })
      // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
      console.log(
        `[J26][build][full-load] click dispatched at ${dispatchedAt.toFixed(2)}ms — RACE CONFIRMED ` +
          `even under a production-style build: raw click fell through to the native form submission. ` +
          `requests=${JSON.stringify(requests)}`
      )
      await page.close()
      return
    }

    const gapMs = timing?.firstListenerAt == null ? null : timing.firstListenerAt - dispatchedAt

    test.info().annotations.push({ type: 'j26-build-full-load-gap-ms', description: String(gapMs) })
    // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
    console.log(
      `[J26][build][full-load] click dispatched at ${dispatchedAt.toFixed(2)}ms, first click/submit ` +
        `listener attached at ${timing?.firstListenerAt?.toFixed(2) ?? 'never'}ms, ` +
        `gap=${gapMs?.toFixed(2) ?? 'n/a'}ms, requests-in-300ms-window=${JSON.stringify(requests)}`
    )
    expect(page.url()).toBe(`${webBase}/settings/language`)
    await page.close()
  })

  test('AC1 (in-app client-side navigation): raw-coordinate click immediately after a real in-app link navigation arrives', async ({
    context,
  }) => {
    const webBase = `http://localhost:${BUILD_WEB_PORT}`
    await registerAndLoginViaWebProxy(context, webBase, 'build-nav')
    const page = await context.newPage()
    await instrumentHydrationTiming(page)

    // Reach the app via a genuine full load first (settings index), letting it fully hydrate —
    // this establishes the "already-hydrated session" starting state the story's AC1 requires.
    await page.goto(`${webBase}/settings`)
    await expect(page.getByRole('link', { name: /language/i })).toBeVisible()

    // Reset the instrumentation so it only measures what happens from the in-app navigation
    // onward, not the already-completed first-load hydration above.
    await page.evaluate(() => {
      ;(window as unknown as { __hydrationRace: HydrationTiming }).__hydrationRace = {
        firstListenerAt: null,
      }
    })

    // A real in-app link click (client-side `goto()`), not `page.goto()` — this is the mechanism
    // under test for the in-app-navigation branch of AC1.
    await page.getByRole('link', { name: /language/i }).click()

    const { dispatchedAt, requests, nativeFormFallbackFired, timing } = await fireRawImmediateClick(
      page,
      languageSelectButton(page)
    )

    if (nativeFormFallbackFired) {
      test
        .info()
        .annotations.push({ type: 'j26-in-app-nav-outcome', description: NATIVE_FORM_FALLBACK })
      // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
      console.log(
        `[J26][build][in-app-nav] click dispatched at ${dispatchedAt.toFixed(2)}ms — RACE CONFIRMED on ` +
          `in-app client-side navigation too. requests=${JSON.stringify(requests)}`
      )
      await page.close()
      return
    }

    const gapMs = timing?.firstListenerAt == null ? null : timing.firstListenerAt - dispatchedAt

    test.info().annotations.push({ type: 'j26-in-app-nav-gap-ms', description: String(gapMs) })
    // eslint-disable-next-line no-console -- AC1 requires this recorded, not just asserted
    console.log(
      `[J26][build][in-app-nav] click dispatched at ${dispatchedAt.toFixed(2)}ms, first click/submit ` +
        `listener attached at ${timing?.firstListenerAt?.toFixed(2) ?? 'never (already attached pre-nav or delegated root listener persisted)'}ms, ` +
        `gap=${gapMs?.toFixed(2) ?? 'n/a'}ms, requests-in-300ms-window=${JSON.stringify(requests)}`
    )
    await page.close()
  })

  test('AC2 (branch 1 regression): the shared waitForHydration helper reliably avoids the race under Vite dev, no app-code fix needed', async ({
    context,
  }) => {
    // AC1 confirmed this race is Vite-dev-only (a production-style build and in-app navigation
    // both showed hydration finishing tens of milliseconds before the earliest possible raw
    // click could land, over 5 repeated runs) — so the fix (AC2 branch 1) is this shared
    // `waitForHydration` test helper, not an `apps/web` runtime change. This test proves the
    // helper actually closes the gap: same worst-case environment (Vite dev, full page load,
    // raw-coordinate click) as the very first test in this file, but gated behind
    // `waitForHydration` instead of firing the instant `page.goto()` resolves.
    const webBase = `http://localhost:${DEV_WEB_PORT}`
    await registerAndLoginViaWebProxy(context, webBase, 'dev-helper')
    const page = await context.newPage()
    await instrumentHydrationDetection(page)

    await page.goto(`${webBase}/settings/language`)
    const target = languageSelectButton(page)
    await waitForHydration(page, target)

    const box = await target.boundingBox()
    if (!box) throw new Error('J26: target button never rendered in the DOM')
    // Still a raw-coordinate click (not `locator.click()`), so this test isolates exactly what
    // `waitForHydration` itself contributes — Playwright's own actionability wait plays no part.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    // A successful, non-swallowed click: the enhanced `use:enhance` fetch handles the submit —
    // the clicked button's own label flips from "Select" to "Selected" without a full native
    // navigation ever tearing down the page (unlike the first test in this file, which crashes
    // with "Execution context was destroyed" the instant that happens).
    await expect(target).toHaveText('Selected')
    expect(page.url()).toContain('/settings/language')
    await page.close()
  })
})
