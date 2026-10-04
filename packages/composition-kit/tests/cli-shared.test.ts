import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isEntryPoint } from '../src/cli-shared.js'

// Story 68-20: `runAsScript` must run `main` when the bin is launched through a symlink (the
// node_modules/.bin entry npm and pnpm create, or a symlinked package directory), and must not run it
// when the file is merely imported.

const MARKER = 'fixture-main-ran'
const IMPORT_FLAGS = ['--input-type=module', '-e']

let root = ''
let entry = ''
let other = ''

function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
  return path
}

function launch(
  args: string[],
  cwd: string = root
): { code: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function importOnly(path: string): { code: number | null; out: string; err: string } {
  return launch([...IMPORT_FLAGS, `import ${JSON.stringify(pathToFileURL(path).href)}`])
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pv-cli-shared-')))
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli-shared.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  mkdirSync(join(root, 'pkg', 'dist'), { recursive: true })
  writeFileSync(join(root, 'pkg', 'dist', 'cli-shared.mjs'), compiled)
  entry = join(root, 'pkg', 'dist', 'entry.mjs')
  writeFileSync(
    entry,
    [
      "import { runAsScript } from './cli-shared.mjs'",
      "await runAsScript('fixture', import.meta.url, (argv, io) => {",
      `  io.out('${MARKER}:' + argv.join(',') + '\\n')`,
      '  return Promise.resolve(0)',
      '})',
      '',
    ].join('\n')
  )
  other = join(root, 'pkg', 'dist', 'other.mjs')
  writeFileSync(other, '')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isEntryPoint', () => {
  const url = (): string => pathToFileURL(entry).href

  it('is true for the real path', () => {
    expect(isEntryPoint(url(), entry)).toBe(true)
  })

  it('is true for a symlink to the module file', () => {
    expect(isEntryPoint(url(), link(entry, join(root, 'bin1', 'pv-x')))).toBe(true)
  })

  it('is true for a chain of symlinks', () => {
    const first = link(entry, join(root, 'bin2', 'first'))
    const second = link(first, join(root, 'bin2', 'second'))
    expect(isEntryPoint(url(), second)).toBe(true)
  })

  it('is true when the package directory itself is a symlink (pnpm layout)', () => {
    const pkgLink = link(join(root, 'pkg'), join(root, 'nm', '@scope', 'pkg'))
    expect(isEntryPoint(url(), join(pkgLink, 'dist', 'entry.mjs'))).toBe(true)
  })

  it('is true for a relative argv[1]', () => {
    expect(isEntryPoint(url(), relative(process.cwd(), entry))).toBe(true)
  })

  it('is true when the module URL itself carries a symlink path (--preserve-symlinks-main)', () => {
    const linked = link(entry, join(root, 'bin3', 'pv-y'))
    expect(isEntryPoint(pathToFileURL(linked).href, linked)).toBe(true)
    expect(isEntryPoint(pathToFileURL(linked).href, entry)).toBe(true)
  })

  it('is false when argv[1] is absent', () => {
    expect(isEntryPoint(url(), undefined)).toBe(false)
    expect(isEntryPoint(url(), '')).toBe(false)
  })

  it('is false for a path that does not exist', () => {
    expect(isEntryPoint(url(), join(root, 'does-not-exist.mjs'))).toBe(false)
  })

  it('is false for a dangling symlink', () => {
    const dangling = link(join(root, 'gone.mjs'), join(root, 'bin4', 'dangling'))
    expect(isEntryPoint(url(), dangling)).toBe(false)
  })

  it('is false for a different entry file, also through a symlink', () => {
    expect(isEntryPoint(url(), other)).toBe(false)
    expect(isEntryPoint(url(), link(other, join(root, 'bin5', 'pv-other')))).toBe(false)
  })
})

describe('runAsScript as a spawned entry', () => {
  it('runs main when launched by its real path', () => {
    const result = launch([entry, 'a', 'b'])
    expect(result.out).toBe(`${MARKER}:a,b\n`)
    expect(result.code).toBe(0)
  })

  it('runs main when launched through a file symlink', () => {
    const result = launch([link(entry, join(root, 'bin6', 'pv-compose')), 'x'])
    expect(result.out).toBe(`${MARKER}:x\n`)
    expect(result.code).toBe(0)
  })

  it('runs main when launched through a symlink chain', () => {
    const first = link(entry, join(root, 'bin7', 'first'))
    const result = launch([link(first, join(root, 'bin7', 'second'))])
    expect(result.out).toBe(`${MARKER}:\n`)
  })

  it('runs main when launched through a symlinked package directory', () => {
    const pkgLink = link(join(root, 'pkg'), join(root, 'nm2', 'pkg'))
    const result = launch([join(pkgLink, 'dist', 'entry.mjs'), 'p'])
    expect(result.out).toBe(`${MARKER}:p\n`)
  })

  it('runs main with a relative path and under --preserve-symlinks-main', () => {
    expect(launch(['./entry.mjs', 'r'], join(root, 'pkg', 'dist')).out).toBe(`${MARKER}:r\n`)
    const pkgLink = link(join(root, 'pkg'), join(root, 'nm3', 'pkg'))
    const preserved = launch(['--preserve-symlinks-main', join(pkgLink, 'dist', 'entry.mjs'), 'k'])
    expect(preserved.out).toBe(`${MARKER}:k\n`)
  })

  it('does not run main when the file is only imported', () => {
    const result = importOnly(entry)
    expect(result.out).toBe('')
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
  })

  it('does not run main when imported through a symlink path', () => {
    const result = importOnly(link(entry, join(root, 'bin9', 'pv-imported')))
    expect(result.out).toBe('')
    expect(result.code).toBe(0)
  })
})
