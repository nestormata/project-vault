import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrastRatio } from './lib/utils/color-contrast.js'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, 'app.css'), 'utf-8')

// Tailwind's default theme values for these tokens (the ones app.css's rule below actually
// resolves to at build time) — kept here as the literal hex source of truth for the contrast
// computation, since jsdom doesn't run the real Tailwind/PostCSS pipeline or evaluate
// `:focus-visible` against a loaded stylesheet.
const SLATE_950 = '#020617'
const BRAND_400 = '#a78bfa'

describe('app.css — AC-12/13 shared focus-visible fix for dark (bg-slate-950) buttons', () => {
  it('AC-13: fixes the ring at a shared selector level, not per-button', () => {
    // A single rule keyed off the existing `.bg-slate-950` utility class covers every current
    // and future dark button without touching each of the ~35 files that use it.
    expect(css).toMatch(/\.bg-slate-950:focus-visible\s*\{/)
  })

  it('AC-13: defines the contrasting ring color as a theme token (not a one-off hex)', () => {
    expect(css).toMatch(/--color-brand-400:\s*#a78bfa/i)
  })

  it('AC-12: the focus ring color meets the WCAG 2.1 AA 2.4.7 3:1 non-text contrast minimum against the button background', () => {
    const ratio = contrastRatio(SLATE_950, BRAND_400)
    expect(ratio).toBeGreaterThanOrEqual(3)
  })
})
