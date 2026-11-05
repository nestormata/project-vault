import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileSourceSubset } from '../../../scripts/lib/compile-source-subset.js'

const TEMP_PREFIX = 'pv-compile-subset-'
const DEP_SPECIFIER = './dep.js'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function remember(root: string): string {
  roots.push(root)
  return root
}

function fixtureRoot(): string {
  return remember(mkdtempSync(join(tmpdir(), 'pv-subset-fixture-')))
}

function writeSource(root: string, name: string, text: string): string {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function tempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX))
}

describe('compileSourceSubset', () => {
  it('emits the entry and its relative imports as ESM in a temp dir', async () => {
    const root = fixtureRoot()
    writeSource(root, 'dep.ts', 'export const value = 42\n')
    const entry = writeSource(
      root,
      'entry.ts',
      `import { value } from '${DEP_SPECIFIER}'\nexport const got = value\n`
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)

    expect(existsSync(join(compiled.directory, 'package.json'))).toBe(true)
    expect(JSON.parse(readPackage(compiled.directory))).toEqual({ type: 'module' })
    expect(existsSync(join(compiled.directory, 'dep.js'))).toBe(true)
    const loaded = (await import(compiled.entryUrl)) as { got: number }
    expect(loaded.got).toBe(42)
    expect(compiled.entryUrl.endsWith('/entry.js')).toBe(true)
  })

  it('follows a dynamic import the caller did not name', async () => {
    const root = fixtureRoot()
    writeSource(root, 'dep.ts', 'export const value = 9\n')
    const entry = writeSource(
      root,
      'entry.ts',
      `const loaded = await import('${DEP_SPECIFIER}')\nexport const got = loaded.value\n`
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    const loaded = (await import(compiled.entryUrl)) as { got: number }
    expect(loaded.got).toBe(9)
  })

  it('follows a relative import that was not named by the caller', () => {
    const root = fixtureRoot()
    writeSource(root, 'extra.ts', 'export const extra = 1\n')
    writeSource(root, 'dep.ts', "import { extra } from './extra.js'\nexport const value = extra\n")
    const entry = writeSource(
      root,
      'entry.ts',
      `import { value } from '${DEP_SPECIFIER}'\nexport const got = value\n`
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    expect(existsSync(join(compiled.directory, 'extra.js'))).toBe(true)
  })

  it('follows a nested relative import and a worker URL', async () => {
    const root = fixtureRoot()
    writeSource(root, 'dep.ts', 'export const value = 7\n')
    writeSource(root, 'sub/worker.ts', 'export const ran = true\n')
    const entry = writeSource(
      root,
      'sub/entry.ts',
      [
        `import { value } from '../dep.js'`,
        `const worker = new URL('./worker.js', import.meta.url)`,
        `export const got = value`,
        `export { worker }`,
        '',
      ].join('\n')
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    expect(existsSync(join(compiled.directory, 'dep.js'))).toBe(true)
    expect(existsSync(join(compiled.directory, 'sub', 'worker.js'))).toBe(true)
    const loaded = (await import(compiled.entryUrl)) as { got: number }
    expect(loaded.got).toBe(7)
  })

  it('does not follow a node builtin, a type-only import, or a URL mentioned in a comment', () => {
    const root = fixtureRoot()
    writeSource(root, 'dep.ts', 'export const value = 1\n')
    const entry = writeSource(
      root,
      'entry.ts',
      [
        `import { value } from '${DEP_SPECIFIER}'`,
        `import type { Dirent } from 'node:fs'`,
        `import type { Missing } from './missing-types.js'`,
        `export type { Missing as MissingAgain } from './missing-types.js'`,
        `// new URL('./not-a-file.js', import.meta.url)`,
        `export const got = value`,
        `export type Unused = Dirent | Missing`,
        '',
      ].join('\n')
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    expect(existsSync(join(compiled.directory, 'missing-types.js'))).toBe(false)
    expect(existsSync(join(compiled.directory, 'not-a-file.js'))).toBe(false)
    const names = readdirSync(compiled.directory)
    expect(names.some((name) => name.includes('node'))).toBe(false)
  })

  it('resolves a relative .js file that already exists', () => {
    const root = fixtureRoot()
    writeSource(root, 'dep.js', 'export const value = 3\n')
    const entry = writeSource(root, 'entry.ts', `export { value } from '${DEP_SPECIFIER}'\n`)
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    expect(existsSync(join(compiled.directory, 'dep.js'))).toBe(true)
  })

  it('stops on an import cycle', async () => {
    const root = fixtureRoot()
    writeSource(root, 'b.ts', `import { a } from './a.js'\nexport const b = 2\nexport { a }\n`)
    const entry = writeSource(
      root,
      'a.ts',
      `import { b } from './b.js'\nexport const a = 1\nexport { b }\n`
    )
    const compiled = compileSourceSubset(entry)
    roots.push(compiled.directory)
    const loaded = (await import(compiled.entryUrl)) as { a: number; b: number }
    expect(loaded.a).toBe(1)
    expect(loaded.b).toBe(2)
  })

  it('throws when a relative import has no source file and leaves no temp dir', () => {
    const root = fixtureRoot()
    const entry = writeSource(root, 'entry.ts', `import './missing.js'\nexport const got = 1\n`)
    const before = tempDirs()
    expect(() => compileSourceSubset(entry)).toThrow(/imports \.\/missing\.js/)
    expect(tempDirs()).toEqual(before)
  })

  it('throws when the entry file does not exist', () => {
    expect(() => compileSourceSubset(join(fixtureRoot(), 'nope.ts'))).toThrow(/does not exist/)
  })

  it('refuses to compile a file inside node_modules', () => {
    const root = fixtureRoot()
    writeSource(root, 'node_modules/pkg/index.ts', 'export const value = 1\n')
    const entry = writeSource(
      root,
      'entry.ts',
      `import { value } from './node_modules/pkg/index.js'\nexport const got = value\n`
    )
    expect(() => compileSourceSubset(entry)).toThrow(/node_modules/)
  })

  it('removes the temp dir on cleanup, including a second call', () => {
    const root = fixtureRoot()
    const entry = writeSource(root, 'entry.ts', 'export const got = 1\n')
    const compiled = compileSourceSubset(entry)
    expect(existsSync(compiled.directory)).toBe(true)
    compiled.cleanup()
    expect(existsSync(compiled.directory)).toBe(false)
    expect(() => compiled.cleanup()).not.toThrow()
  })
})

function readPackage(directory: string): string {
  return readFileSync(join(directory, 'package.json'), 'utf8')
}
