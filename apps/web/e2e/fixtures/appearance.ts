import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

// Story 72.11 (V14): the four appearances every Epic 72 UI journey runs under, so "390 px" and
// "dark" are checked by the suite instead of by hand. Reused by later Epic 72 stories.
//
// `viewport` is a plain size and `colorScheme` is Playwright's `prefers-color-scheme` emulation.
// PV has no dark colour scheme of its own (epic 72 decision D2): in the dark appearances the
// browser reports `prefers-color-scheme: dark` and PV must stay legible and unbroken, but it does
// not restyle. A journey therefore asserts the emulation took effect (`matchMedia`) and that the
// layout holds, never that colours changed.

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const
export const NARROW_VIEWPORT = { width: 390, height: 844 } as const

export type ColorScheme = 'light' | 'dark'

export interface Appearance {
  /** A short unique label, used in the describe title. */
  readonly name: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly colorScheme: ColorScheme
  /** True at 390 px, where lists become cards and nothing may scroll sideways. */
  readonly narrow: boolean
}

export const APPEARANCES: readonly Appearance[] = [
  { name: 'desktop light', viewport: DESKTOP_VIEWPORT, colorScheme: 'light', narrow: false },
  { name: 'desktop dark', viewport: DESKTOP_VIEWPORT, colorScheme: 'dark', narrow: false },
  { name: '390px light', viewport: NARROW_VIEWPORT, colorScheme: 'light', narrow: true },
  { name: '390px dark', viewport: NARROW_VIEWPORT, colorScheme: 'dark', narrow: true },
]

/**
 * `test.describe` once per appearance, each block with that appearance's viewport and colour scheme
 * applied through `test.use`. `register` declares the tests and receives the appearance.
 */
export function describeEachAppearance(
  title: string,
  register: (appearance: Appearance) => void
): void {
  for (const appearance of APPEARANCES) {
    test.describe(`${title} [${appearance.name}]`, () => {
      test.use({ viewport: { ...appearance.viewport }, colorScheme: appearance.colorScheme })
      register(appearance)
    })
  }
}

/**
 * PV has no dark scheme of its own (epic 72 D2): what must hold is that the browser really runs in
 * the requested scheme and size, and that the page still lays out.
 */
export async function expectAppearanceApplied(page: Page, appearance: Appearance): Promise<void> {
  const dark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
  expect(dark).toBe(appearance.colorScheme === 'dark')
  expect(page.viewportSize()?.width).toBe(appearance.viewport.width)
}

/** Nothing scrolls sideways (the 390 px rule). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
}
