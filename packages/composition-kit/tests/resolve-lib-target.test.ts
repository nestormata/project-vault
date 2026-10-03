// Story 68.5 AC-1 (Assumption Audit): PV imports runes modules as `$lib/state/theme.svelte.js`
// while the file is `theme.svelte.ts`; a manifest key spelled like the import must find it.
import { describe, expect, it } from 'vitest'
import { resolveLibTarget } from '../src/overlay.js'

const A_JS = 'src/lib/a.js'
const A_TS = 'src/lib/a.ts'
const hosts = (...paths: string[]) => new Set(paths)

describe('resolveLibTarget: the TypeScript ".js means .ts" spelling', () => {
  it('matches a .js spelling to the .ts file', () => {
    expect(
      resolveLibTarget('$lib/state/theme.svelte.js', hosts('src/lib/state/theme.svelte.ts'))
    ).toEqual(['src/lib/state/theme.svelte.ts'])
  })

  it.each([
    ['$lib/a.mjs', 'src/lib/a.mts'],
    ['$lib/a.jsx', 'src/lib/a.tsx'],
  ])('matches %s to %s', (target, file) => {
    expect(resolveLibTarget(target, hosts(file))).toEqual([file])
  })

  it('reports both files when the .js file and the .ts file exist (ambiguous)', () => {
    expect(resolveLibTarget('$lib/a.js', hosts(A_JS, A_TS)).sort()).toEqual([A_JS, A_TS])
  })

  it('reports nothing when neither exists, and never lists a file twice', () => {
    expect(resolveLibTarget('$lib/nope.js', hosts(A_TS))).toEqual([])
    expect(resolveLibTarget('$lib/a.js', hosts(A_JS))).toEqual([A_JS])
  })

  it('keeps the existing append-an-extension behaviour', () => {
    expect(resolveLibTarget('$lib/a', hosts(A_TS))).toEqual([A_TS])
    expect(resolveLibTarget('$lib/c', hosts('src/lib/c/index.svelte'))).toEqual([
      'src/lib/c/index.svelte',
    ])
  })
})
