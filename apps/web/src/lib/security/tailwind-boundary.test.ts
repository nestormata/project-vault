/**
 * @pv-guard tailwind-boundary
 *
 * Story 68.9 AC-7: the Tailwind source boundary of `src/app.css`, on PV's own tree (monorepo shared
 * line) and on a composed app root (vendored shared line plus the composer's `src/lib/_cm` line).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_SOURCE_LINE,
  CM_SOURCE_LINE,
  IMPORT_LINE,
  MONOREPO_SHARED_LINE,
  VENDORED_SHARED_LINE,
  tailwindBoundaryProblems,
} from './tailwind-boundary.js'
import { guardAppRoot } from '../test/guard-root.js'

const BASE = `${IMPORT_LINE}\n\n${APP_SOURCE_LINE}\n/* marker */\n`

describe('Tailwind source boundary (Story 68.9 AC-7)', () => {
  it('holds for the app.css of the tree under test', () => {
    const root = guardAppRoot()
    const css = readFileSync(join(root, 'src/app.css'), 'utf8')
    expect(tailwindBoundaryProblems(css, existsSync(join(root, 'src/lib/_cm')))).toEqual([])
  })

  it('accepts the PV, packed and composed shapes', () => {
    expect(tailwindBoundaryProblems(`${BASE}${MONOREPO_SHARED_LINE}\n`, false)).toEqual([])
    expect(tailwindBoundaryProblems(`${BASE}${VENDORED_SHARED_LINE}\n`, false)).toEqual([])
    const composed = `${BASE}${VENDORED_SHARED_LINE}\n${CM_SOURCE_LINE}\n@import "./lib/_cm/theme.css";\n`
    expect(tailwindBoundaryProblems(composed, true)).toEqual([])
  })

  it('fails when source(none) is dropped', () => {
    const css = `@import "tailwindcss";\n${APP_SOURCE_LINE}\n${VENDORED_SHARED_LINE}\n`
    expect(tailwindBoundaryProblems(css, false)[0]).toContain('source(none)')
  })

  it('fails on a source that escapes the app root', () => {
    // Built from parts: a relative path literal in test code reads as a file outside the package.
    const outside = ['..', '..', '..', '**/*.svelte'].join('/')
    const css = `${BASE}${VENDORED_SHARED_LINE}\n@source "${outside}";\n`
    expect(tailwindBoundaryProblems(css, false).join('\n')).toContain('source escapes the app root')
    const nodeModules = `${BASE}${VENDORED_SHARED_LINE}\n@source "./node_modules/**/*.ts";\n`
    expect(tailwindBoundaryProblems(nodeModules, false).join('\n')).toContain('escapes')
  })

  it('fails on a duplicated app source line or a missing or doubled shared line', () => {
    expect(
      tailwindBoundaryProblems(`${BASE}${APP_SOURCE_LINE}\n${VENDORED_SHARED_LINE}\n`, false)
    ).toEqual([expect.stringContaining('exactly once (found 2)')])
    expect(tailwindBoundaryProblems(BASE, false).join('\n')).toContain('exactly one shared')
    const both = `${BASE}${MONOREPO_SHARED_LINE}\n${VENDORED_SHARED_LINE}\n`
    expect(tailwindBoundaryProblems(both, false).join('\n')).toContain('exactly one shared')
  })

  it('allows the composer line only when composed CM code exists', () => {
    const css = `${BASE}${VENDORED_SHARED_LINE}\n${CM_SOURCE_LINE}\n`
    expect(tailwindBoundaryProblems(css, true)).toEqual([])
    expect(tailwindBoundaryProblems(css, false).join('\n')).toContain('not a source line')
  })

  it('requires the theme import after the sources', () => {
    const css = `${IMPORT_LINE}\n@import "./theme.css";\n${APP_SOURCE_LINE}\n${VENDORED_SHARED_LINE}\n`
    expect(tailwindBoundaryProblems(css, false).join('\n')).toContain('after every @source')
  })
})
