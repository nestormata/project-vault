import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASE_EXTENSION_THEME_VARS } from './extension-theme-vars.js'

/**
 * Story 29.5 AC4 — regression test guarding against future drift between the two
 * independently-hardcoded literal sets for the same semantic base/default chrome values:
 *
 *   - `extension-theme-vars.ts`'s existing `BASE_SURFACE`/`BASE_INK`/`BASE_BRAND`/`BASE_LINE`
 *     (Story 25.4, not modified by this story)
 *   - `app.css`'s new `--color-background`/`--color-foreground`/`--color-primary-600`/
 *     `--color-border` base theme-token defaults (this story's AC1/AC2)
 *
 * AC2 requires these to start out equal; this test fails loudly if a future edit to either one
 * (without the other) silently lets them diverge. It reads `app.css` as plain text — no
 * `apps/web` -> `apps/api` dependency, and no change to `extension-theme-vars.ts` itself.
 */
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../app.css')

function readCustomProperty(css: string, name: string): string | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = new RegExp(`${name}:\\s*([^;]+);`)
  return pattern.exec(withoutComments)?.[1]?.trim()
}

describe('app.css base theme defaults stay in sync with extension-theme-vars.ts base literals (Story 29.5 AC4)', () => {
  const css = readFileSync(APP_CSS_PATH, 'utf-8')

  it("--color-background matches BASE_EXTENSION_THEME_VARS['--pv-ext-surface']", () => {
    expect(readCustomProperty(css, '--color-background')).toBe(
      BASE_EXTENSION_THEME_VARS['--pv-ext-surface']
    )
  })

  it("--color-foreground matches BASE_EXTENSION_THEME_VARS['--pv-ext-ink']", () => {
    expect(readCustomProperty(css, '--color-foreground')).toBe(
      BASE_EXTENSION_THEME_VARS['--pv-ext-ink']
    )
  })

  it("--color-primary-600 matches BASE_EXTENSION_THEME_VARS['--pv-ext-brand']", () => {
    expect(readCustomProperty(css, '--color-primary-600')).toBe(
      BASE_EXTENSION_THEME_VARS['--pv-ext-brand']
    )
  })

  it("--color-border matches BASE_EXTENSION_THEME_VARS['--pv-ext-line']", () => {
    expect(readCustomProperty(css, '--color-border')).toBe(
      BASE_EXTENSION_THEME_VARS['--pv-ext-line']
    )
  })
})
