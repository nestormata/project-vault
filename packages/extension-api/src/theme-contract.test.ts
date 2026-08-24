import { describe, expect, it } from 'vitest'
import { EXTENSION_THEME_CSS_VARS } from './theme-contract.js'
import type { ExtensionThemeCssVar } from './theme-contract.js'

describe('EXTENSION_THEME_CSS_VARS (Story 25.4 AC4)', () => {
  it('publishes exactly the five minimum-viable-set custom properties, in a stable order', () => {
    expect(EXTENSION_THEME_CSS_VARS).toEqual([
      '--pv-ext-surface',
      '--pv-ext-ink',
      '--pv-ext-muted',
      '--pv-ext-brand',
      '--pv-ext-line',
    ])
  })

  it('every entry matches the --pv-ext-* naming convention', () => {
    for (const name of EXTENSION_THEME_CSS_VARS) {
      expect(name).toMatch(/^--pv-ext-[a-z]+$/)
    }
  })

  it('ExtensionThemeCssVar is a union of exactly these literal values (compile-time guard)', () => {
    const value: ExtensionThemeCssVar = '--pv-ext-brand'
    expect(EXTENSION_THEME_CSS_VARS).toContain(value)
  })
})
