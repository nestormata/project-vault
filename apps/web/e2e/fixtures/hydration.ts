import type { Page, Locator } from '@playwright/test'

/**
 * Story 28.3 (AC2, branch 1) — shared hydration-wait helper this suite was conspicuously missing.
 * J19 (`j19-native-login-exclusion.spec.ts`) and J20 (`j20-capability-gate-entitlement.spec.ts`)
 * each independently reinvented an ad hoc, page-specific wait for "has Svelte's hydration
 * attached this page's handlers yet" (a web-first `toBeVisible()`/`toBeEnabled()` assertion on the
 * element about to be interacted with) — this generalizes that into one reusable pair of
 * functions instead of a third bespoke reinvention.
 *
 * AC1's own instrumented measurement (J26) confirmed this race is real but Vite-dev-only: a
 * production-style build (`vite build` + `@sveltejs/adapter-node`) consistently finished
 * hydrating ~25-35ms BEFORE the earliest a raw, immediate `page.mouse.click()` could possibly
 * land (measured over 5 repeated runs), and in-app client-side navigation showed the same
 * comfortable margin. This is therefore a dev-only test/DX gap, not a production application bug
 * — no `apps/web` runtime code needed to change for the reported symptom. See this story's Dev
 * Notes for the full measurement.
 */

type HydrationWindow = { __pvHydrated?: boolean }

/**
 * Must be called BEFORE the navigation being waited on (i.e. before `page.goto()` or an in-app
 * navigation click) — registers a `page.addInitScript()` that wraps
 * `EventTarget.prototype.addEventListener` to detect the moment Svelte 5's hydration attaches its
 * first `'click'`/`'submit'` listener. Svelte 5 attaches most DOM event handling via a single
 * delegated listener registered during hydrate()/mount() (not one `addEventListener` call per
 * element), so this is a page-global, not per-element, signal — deterministic and independent of
 * which specific button/form a caller is about to interact with, unlike a `toBeVisible()`
 * assertion on the SSR'd-and-already-visible target element (which can resolve before hydration
 * ever runs, and only "worked" for J19/J20 by incidental timing).
 */
export async function instrumentHydrationDetection(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as HydrationWindow
    w.__pvHydrated = false
    const original = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (!w.__pvHydrated && (type === 'click' || type === 'submit')) {
        w.__pvHydrated = true
      }
      return original.call(this, type, listener, options)
    }
  })
}

/**
 * Waits until Svelte has hydrated this page and attached its first click/submit listener.
 * Requires `instrumentHydrationDetection(page)` to have been called before the navigation this
 * call follows. `locator` is required (and awaited for `state: 'attached'` first) so callers
 * document which element they mean to interact with next and this helper fails fast if that
 * element never rendered at all, rather than only ever reporting a generic hydration timeout.
 */
export async function waitForHydration(page: Page, locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'attached' })
  await page.waitForFunction(() => (window as unknown as HydrationWindow).__pvHydrated === true)
}
