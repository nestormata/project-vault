import { describe, expect, it } from 'vitest'
import { applyEdits, scanSpecifiers } from './rewrite.js'

const FROM = import.meta.dirname

function specifiers(text: string, file: string): string[] {
  return scanSpecifiers(text, file, FROM).specifiers.map((entry) => entry.specifier)
}

describe('scanSpecifiers: TypeScript and JavaScript (AST, never regex)', () => {
  it('finds every import form', () => {
    const source = `
      import a from './a'
      import type { T } from './types'
      import { type U, b } from '../b.js'
      import './side-effect'
      export { c } from './c'
      export * from './d'
      export * as ns from './e'
      const lazy = () => import('./lazy')
      type X = import('./typed').Y
      import asset from './logo.png?url'
      import raw from './x.txt?raw'
      import fs from 'node:fs'
      import svelte from 'svelte'
      import lib from '$lib/x'
      import cm from '$cm/x'
    `
    expect(specifiers(source, 'f.ts')).toEqual([
      './a',
      './types',
      '../b.js',
      './side-effect',
      './c',
      './d',
      './e',
      './lazy',
      './typed',
      './logo.png?url',
      './x.txt?raw',
      'node:fs',
      'svelte',
      '$lib/x',
      '$cm/x',
    ])
  })

  it('ignores imports that only look like imports (strings, comments, template text)', () => {
    const source = `
      // import x from './comment'
      const s = "import y from './string'"
      const t = \`import z from './template'\`
      /* export * from './block' */
    `
    expect(specifiers(source, 'f.ts')).toEqual([])
  })

  it('reports new URL(..., import.meta.url) as a note and does not edit it', () => {
    const scan = scanSpecifiers(
      "const u = new URL('./asset.png', import.meta.url)\nconst v = new URL('https://x.test', 'https://y.test')",
      'f.ts',
      FROM
    )
    expect(scan.specifiers).toEqual([])
    expect(scan.importMetaUrlAssets).toEqual(['./asset.png'])
  })

  it('handles .js and .mjs sources', () => {
    expect(specifiers("import a from './a.js'\nexport * from './b.js'", 'f.mjs')).toEqual([
      './a.js',
      './b.js',
    ])
  })
})

describe('scanSpecifiers: Svelte (script and module script blocks)', () => {
  it('reads instance and module scripts, ts or js, at the right file offsets', () => {
    const source = `<script context="module" lang="ts">
  import { m } from './module-thing'
</script>
<script lang="ts">
  import Child from './Child.svelte'
  import type { P } from '../types'
  const lazy = () => import('./lazy.svelte')
</script>

<Child />
<style>
  @import './theme.css';
  .a { background: url('./bg.png'); }
</style>
`
    const scan = scanSpecifiers(source, 'f.svelte', FROM)
    expect(scan.specifiers.map((entry) => entry.specifier)).toEqual([
      './module-thing',
      './Child.svelte',
      '../types',
      './lazy.svelte',
      './theme.css',
      './bg.png',
    ])
    for (const entry of scan.specifiers) {
      expect(source.slice(entry.start, entry.end)).toBe(entry.specifier)
    }
  })

  it('tolerates a svelte file without scripts', () => {
    expect(specifiers('<p>hello</p>', 'f.svelte')).toEqual([])
  })
})

describe('scanSpecifiers: CSS', () => {
  it('finds @import and url() references, skipping absolute and data urls', () => {
    const css = `@import "./a.css";
@import url('./b.css');
@import url(./c.css);
.x { background: url("./img/d.png"); mask: url(data:image/svg+xml;base64,AAAA); }
.y { background: url(https://example.test/e.png); background: url(/static/f.png); }
`
    expect(specifiers(css, 'f.css')).toEqual(['./a.css', './b.css', './c.css', './img/d.png'])
  })
})

describe('applyEdits', () => {
  it('replaces by offsets, preserving query suffixes, and is order independent', () => {
    const text = "import a from './a'\nimport b from './b.png?url'\n"
    const scan = scanSpecifiers(text, 'f.ts', FROM)
    const edited = applyEdits(
      text,
      scan.specifiers
        .map((entry) => ({ ...entry, replacement: `$cm/${entry.specifier.slice(2)}` }))
        .reverse()
    )
    expect(edited).toBe("import a from '$cm/a'\nimport b from '$cm/b.png?url'\n")
  })
})
