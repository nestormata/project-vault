import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@project-vault/shared'
import { contrastRatio, isValidColorGrammar, kebabCase, LENGTH_GRAMMAR } from './service.js'

/**
 * Story 29.5 AC7 — registry-completeness AND grammar-validity test for `apps/web/src/app.css`'s
 * base theme-token defaults (Story 29.5 AC1/AC2/AC8).
 *
 * Package-boundary judgment call (documented in the story's Dev Agent Record, per AC7's explicit
 * "record whichever choice is made" instruction): this test lives here, in `apps/api`, and reads
 * `apps/web/src/app.css`'s raw file content directly with `fs.readFileSync`, rather than:
 *   (a) `apps/web` importing this module's `isValidColorGrammar`/`LENGTH_GRAMMAR`/`kebabCase` —
 *       `apps/web` is a SvelteKit frontend app and must not depend on `apps/api`'s server-only
 *       theming-service internals (wrong dependency direction), or
 *   (b) relocating the three grammars from `apps/api/src/modules/theming/service.ts` into
 *       `packages/shared` purely to satisfy this one test — that would move live production
 *       validation code (already covered by `service.test.ts`) for a speculative future reuse
 *       this story does not otherwise need, and risks subtly changing its exported shape.
 * `apps/api` already owns the grammars and the `kebabCase()` naming rule (AC5c), so this test
 * reuses them as-is and treats `apps/web/src/app.css` purely as data to parse — no cross-app
 * production import in either direction.
 */
const APP_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../web/src/app.css')

function parseDeclaredCustomProperties(css: string): Map<string, string> {
  // Strip comments first so a property name/value mentioned only in prose (e.g. this story's own
  // Dev Notes-style comments in app.css) can never false-positive-satisfy the presence check.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = new Map<string, string>()
  const pattern = /--([a-z0-9-]+):\s*([^;]+);/g
  for (
    let match = pattern.exec(withoutComments);
    match !== null;
    match = pattern.exec(withoutComments)
  ) {
    const [, name, rawValue] = match
    if (!name || rawValue === undefined) continue
    declarations.set(name, rawValue.trim())
  }
  return declarations
}

describe('apps/web base theme defaults (Story 29.5 AC7)', () => {
  const css = readFileSync(APP_CSS_PATH, 'utf-8')
  const declared = parseDeclaredCustomProperties(css)

  it('declares a base default custom property for every THEME_TOKENS registry key', () => {
    for (const key of Object.keys(THEME_TOKENS)) {
      const cssName = kebabCase(key)
      expect(
        declared.has(cssName),
        `apps/web/src/app.css is missing --${cssName} for token \`${key}\``
      ).toBe(true)
    }
  })

  it('every declared base default satisfies its registry token type grammar', () => {
    for (const [key, def] of Object.entries(THEME_TOKENS)) {
      const cssName = kebabCase(key)
      const value = declared.get(cssName)
      expect(value, `--${cssName} must be declared`).toBeDefined()
      if (!value) continue

      if (def.type === 'color') {
        expect(isValidColorGrammar(value), `--${cssName}: \`${value}\` is not a valid color`).toBe(
          true
        )
      } else if (def.type === 'length') {
        expect(LENGTH_GRAMMAR.test(value), `--${cssName}: \`${value}\` is not a valid length`).toBe(
          true
        )
      } else {
        const allowedValues: readonly string[] = def.values
        expect(
          allowedValues.includes(value),
          `--${cssName}: \`${value}\` is not one of ${allowedValues.join(', ')}`
        ).toBe(true)
      }
    }
  })

  it('AC4 (Story 30.4): colorPrimary600/colorPrimary700 base defaults satisfy the >= 4.5:1 WCAG contrast bar against white button text', () => {
    for (const key of ['colorPrimary600', 'colorPrimary700']) {
      const cssName = kebabCase(key)
      const value = declared.get(cssName)
      expect(value, `--${cssName} must be declared`).toBeDefined()
      if (!value) continue
      expect(
        contrastRatio(value, '#ffffff'),
        `--${cssName}: \`${value}\` must have >= 4.5:1 contrast against white button text`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
