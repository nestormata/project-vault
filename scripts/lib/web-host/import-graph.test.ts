import { describe, expect, it } from 'vitest'
import {
  compareCodeUnits,
  isTestFile,
  isTestSupportFile,
  moduleSpecifiers,
  packageNameOf,
  walkImportGraph,
  withoutQuery,
  type GraphResolver,
} from './import-graph.js'

// Story 68.2 AC-2/AC-7: the import graph is computed with real parsers, so type-only imports,
// re-exports, dynamic imports and Svelte <script> blocks are all handled structurally.

describe('moduleSpecifiers', () => {
  it('collects static, re-export and dynamic imports and flags type-only ones', () => {
    const code = [
      "import { a } from 'pkg-a'",
      "import type { B } from 'pkg-b'",
      "export { c } from './c'",
      "export type { D } from './d'",
      "const lazy = () => import('pkg-e')",
      "type T = typeof import('pkg-f')",
    ].join('\n')
    expect(moduleSpecifiers(code, 'x.ts')).toEqual([
      { specifier: 'pkg-a', typeOnly: false },
      { specifier: 'pkg-b', typeOnly: true },
      { specifier: './c', typeOnly: false },
      { specifier: './d', typeOnly: true },
      { specifier: 'pkg-e', typeOnly: false },
    ])
  })

  it('reads both script blocks of a Svelte component and ignores the markup', () => {
    const component = [
      '<script module lang="ts">',
      "  import { m } from 'module-pkg'",
      '</script>',
      '<script lang="ts">',
      "  import Child from './Child.svelte'",
      "  import type { P } from 'types-only'",
      '</script>',
      "<p>import x from 'not-code'</p>",
    ].join('\n')
    expect(moduleSpecifiers(component, 'C.svelte')).toEqual([
      { specifier: './Child.svelte', typeOnly: false },
      { specifier: 'types-only', typeOnly: true },
      { specifier: 'module-pkg', typeOnly: false },
    ])
  })
})

describe('packageNameOf', () => {
  it('maps bare specifiers to package names and drops everything else', () => {
    expect(packageNameOf('zod/v4')).toBe('zod')
    expect(packageNameOf('@zxcvbn-ts/core')).toBe('@zxcvbn-ts/core')
    expect(packageNameOf('@sveltejs/kit/vite')).toBe('@sveltejs/kit')
    for (const specifier of [
      './x',
      '../y',
      '/abs',
      '$lib/a',
      '$app/forms',
      'node:fs',
      'fs',
      'virtual:x',
    ]) {
      expect(packageNameOf(specifier), specifier).toBeUndefined()
    }
  })
})

describe('test-file classification (Story 68.2 AC-7)', () => {
  it('treats only *.test/*.spec files and __tests__ as tests', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true)
    expect(isTestFile('src/a.spec.mjs')).toBe(true)
    expect(isTestFile('src/__tests__/a.ts')).toBe(true)
    expect(isTestFile('src/lib/test/fixtures.ts')).toBe(false)
    expect(isTestFile('src/x-test-helpers.ts')).toBe(false)
  })

  it('treats src/lib/test and *-test-helpers as test support, not tests', () => {
    expect(isTestSupportFile('apps/web/src/lib/test/dom.ts')).toBe(true)
    expect(isTestSupportFile('apps/web/src/lib/a/onboarding-test-helpers.ts')).toBe(true)
    expect(isTestSupportFile('apps/web/src/lib/api/vault.ts')).toBe(false)
  })
})

const APP_A = '/app/a.ts'
const APP_B = '/app/b.ts'
const SHARED_INDEX = '/shared/index.ts'

function memoryResolver(
  files: Record<string, string>,
  aliases: Record<string, string> = {}
): GraphResolver {
  const table = new Map(Object.entries(files))
  const aliasTable = new Map(Object.entries(aliases))
  return { alias: (specifier) => aliasTable.get(specifier), readFile: (path) => table.get(path) }
}

describe('walkImportGraph', () => {
  it('follows relative and aliased runtime imports and records bare packages per importer', () => {
    const resolver = memoryResolver(
      {
        [APP_A]:
          "import { b } from './b'\nimport type { T } from './types-only'\nimport 'dompurify'",
        [APP_B]: "export { s } from '@shared'\nimport 'zod/v4'",
        [SHARED_INDEX]: "import 'zod'",
      },
      { '@shared': SHARED_INDEX }
    )
    const graph = walkImportGraph([APP_A], resolver)
    expect([...graph.files].sort()).toEqual([APP_A, APP_B, SHARED_INDEX])
    expect(graph.bareImports.get('zod')).toEqual([APP_B, SHARED_INDEX])
    expect(graph.bareImports.get('dompurify')).toEqual([APP_A])
    expect(graph.errors).toEqual([])
  })

  it('fails when shipped source imports a test file, naming both files', () => {
    const graph = walkImportGraph(
      [APP_A],
      memoryResolver({ [APP_A]: "import './a.test'", '/app/a.test.ts': '' })
    )
    expect(graph.errors).toEqual(['/app/a.ts imports the test file /app/a.test.ts'])
  })

  it('fails on a relative import that resolves to nothing', () => {
    const graph = walkImportGraph([APP_A], memoryResolver({ [APP_A]: "import './gone'" }))
    expect(graph.errors).toEqual(['/app/a.ts: cannot resolve "./gone"'])
  })

  it('resolves .js specifiers to .ts sources and strips Vite query suffixes', () => {
    const graph = walkImportGraph(
      [APP_A],
      memoryResolver({
        [APP_A]: "import './b.js'\nimport icon from './c.svg?raw'",
        [APP_B]: '',
        '/app/c.svg': '<svg/>',
      })
    )
    expect(graph.errors).toEqual([])
    expect(graph.files.has(APP_B)).toBe(true)
  })
})

describe('withoutQuery (Sonar typescript:S8786)', () => {
  it('drops a Vite query suffix and keeps a specifier without one', () => {
    expect(withoutQuery('./icon.svg?raw')).toBe('./icon.svg')
    expect(withoutQuery('./a?b?c')).toBe('./a')
    expect(withoutQuery('./plain.ts')).toBe('./plain.ts')
    expect(withoutQuery('?')).toBe('')
  })

  it('is linear on a ?-heavy specifier that made the old /\\?.*$/ regex quadratic', () => {
    // The old regex started a match at every `?` and re-scanned to the end: ~n^2/2 steps, which
    // is about 5e9 for 100k characters (many seconds). The scan is one indexOf.
    const pathological = `x${'?'.repeat(100_000)}\n`
    const started = performance.now()
    expect(withoutQuery(pathological)).toBe('x')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('compareCodeUnits (Sonar typescript:S2871)', () => {
  it('orders by UTF-16 code unit, independent of locale', () => {
    const paths = ['b.ts', 'B.ts', 'a/z.ts', 'a-b.ts', '\u00e9.ts', 'e.ts']
    expect([...paths].sort(compareCodeUnits)).toEqual([
      'B.ts',
      'a-b.ts',
      'a/z.ts',
      'b.ts',
      'e.ts',
      '\u00e9.ts',
    ])
    expect(compareCodeUnits('same', 'same')).toBe(0)
  })
})
