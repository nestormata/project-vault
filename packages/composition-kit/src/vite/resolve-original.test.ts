import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOriginalFile } from './resolve-original.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const A_TS = 'src/lib/a.ts'
const B_TS = 'src/lib/other/b.ts'
const FILES = [
  A_TS,
  'src/lib/state/theme.svelte.ts',
  'src/lib/components/Thing.svelte',
  'src/lib/dir/index.ts',
  B_TS,
]

function app(): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-resolve-original-'))
  roots.push(root)
  for (const rel of FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), '')
  }
  return root
}

describe('resolveOriginalFile', () => {
  it('resolves $lib specifiers: exact, extension-less, .js for .ts, a directory index', () => {
    const root = app()
    const file = (rel: string) => ({ kind: 'file', id: join(root, rel) })
    expect(resolveOriginalFile('$lib/a.ts', undefined, root)).toEqual(file(A_TS))
    expect(resolveOriginalFile('$lib/a', undefined, root)).toEqual(file(A_TS))
    expect(resolveOriginalFile('$lib/a.js', undefined, root)).toEqual(file(A_TS))
    expect(resolveOriginalFile('$lib/state/theme.svelte.js', undefined, root)).toEqual(
      file('src/lib/state/theme.svelte.ts')
    )
    expect(resolveOriginalFile('$lib/components/Thing', undefined, root)).toEqual(
      file('src/lib/components/Thing.svelte')
    )
    expect(resolveOriginalFile('$lib/dir', undefined, root)).toEqual(file('src/lib/dir/index.ts'))
  })

  it('resolves a relative specifier from the importer and keeps ?query#hash', () => {
    const root = app()
    const importer = join(root, B_TS)
    expect(resolveOriginalFile('../a.ts?raw', importer, root)).toEqual({
      kind: 'file',
      id: `${join(root, A_TS)}?raw`,
    })
    expect(resolveOriginalFile('./b.ts#x', importer, root)).toEqual({
      kind: 'file',
      id: `${importer}#x`,
    })
  })

  it('reports a path outside <appRoot>/src, whether or not it exists', () => {
    const root = app()
    const importer = join(root, B_TS)
    expect(resolveOriginalFile('../../../etc/hostname', importer, root).kind).toBe('outside')
    expect(resolveOriginalFile('$lib/../../package.json', undefined, root).kind).toBe('outside')
    // A sibling directory whose name merely starts with "src" is outside too.
    expect(resolveOriginalFile('../../../src-evil/x.ts', importer, root).kind).toBe('outside')
  })

  it('leaves other specifiers, missing files and an importer-less relative path to the pipeline', () => {
    const root = app()
    expect(resolveOriginalFile('$cm/x.ts', undefined, root).kind).toBe('unknown')
    expect(resolveOriginalFile('$lib/nope.ts', undefined, root).kind).toBe('unknown')
    expect(resolveOriginalFile('./a.ts', undefined, root).kind).toBe('unknown')
  })

  it('returns the real path of a file reached through a symlinked app root', () => {
    const root = app()
    const link = `${root}-link`
    symlinkSync(root, link)
    roots.push(link)
    expect(resolveOriginalFile('$lib/a.ts', undefined, link)).toEqual({
      kind: 'file',
      id: join(root, A_TS),
    })
  })
})
