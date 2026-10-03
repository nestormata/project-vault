import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { guardMarker, leadingCommentText } from './lib/web-host/guard-registry.js'

// Story 68.9 AC-1: every test under apps/web/src that scans the whole source tree (a `readdirSync`,
// `globSync` or `import.meta.glob` over `src`, `routes` or a `**` root) must say what it is: a guard
// (`@pv-guard <id>`, registered in manifests/guards.json and never auto-excluded) or a test of one
// module that happens to read the tree (`@pv-not-guard <reason>`). Otherwise the composer would
// treat a tree-scanning rule as a subject test and could exclude it when a pack overrides a file.
// This runs on PV's own tree only (it is a PV maintainer rule, never a gate on a composed tree).
const WEB_SRC = join(import.meta.dirname, '..', 'apps', 'web', 'src')

const TREE_CALL = /\b(?:readdirSync|globSync|import\.meta\.glob)\s*\(([^)]{0,240})/g
const TREE_ROOT = /src|routes|\*\*|Root\b/

export function scansWholeTree(code: string): boolean {
  return [...code.matchAll(TREE_CALL)].some((match) => TREE_ROOT.test(match[1] ?? ''))
}

export function isClassified(code: string): boolean {
  return guardMarker(code) !== undefined || /@pv-not-guard[ \t]+\S/.test(leadingCommentText(code))
}

describe('web guard completeness (Story 68.9 AC-1)', () => {
  it('flags a tree scanner without a marker and accepts both markers', () => {
    const scanner = "const all = import.meta.glob('/src/**/*.ts', { eager: true })\n"
    expect(scansWholeTree(scanner)).toBe(true)
    expect(isClassified(scanner)).toBe(false)
    expect(isClassified(`/** @pv-guard some-guard */\n${scanner}`)).toBe(true)
    expect(isClassified(`// @pv-not-guard tests one module\n${scanner}`)).toBe(true)
    expect(scansWholeTree("const one = import.meta.glob('./compose-handles.ts')")).toBe(false)
    expect(scansWholeTree('readdirSync(sourceRoot, { recursive: true })')).toBe(true)
  })

  it('classifies every whole-tree scanner under apps/web/src', () => {
    const unclassified = globSync('**/*.test.ts', { cwd: WEB_SRC })
      .map((rel) => join(WEB_SRC, rel))
      .filter((file) => scansWholeTree(readFileSync(file, 'utf8')))
      .filter((file) => !isClassified(readFileSync(file, 'utf8')))
      .map(
        (file) =>
          `${relative(WEB_SRC, file)}: whole-tree scanner not registered as a guard; it would be ` +
          'auto-excluded or mis-classified as a subject test. Add `@pv-guard <id>` (and the shared ' +
          'guard-root helper) or `@pv-not-guard <reason>` to its first comment block.'
      )
    expect(unclassified).toEqual([])
  })
})
