import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSurfaceSnapshotIsFresh,
  generateSurfaceSnapshot,
  runSurfaceCli,
} from './api-surface.js'

// Story 66-6 AC-4: renderer coverage comes from in-process builds of a tiny committed fixture
// package (lib es5, no @types), not from the 259-file real build. The real build runs once,
// in an uninstrumented child process (see surface-runner.ts). Fixture assertions never depend
// on `__@<symbol>@<id>` numbers (DW-310).

const fixtureRoot = fileURLToPath(new URL('./fixtures/surface-mini/', import.meta.url))
const tempRoots: string[] = []
const NO_LIB_TSCONFIG = '{"compilerOptions":{"noLib":true,"types":[]}}'
const SNAPSHOT_FILE = 'api-surface.snapshot.md'
const INDEX_FILE = 'src/index.ts'
const TRUNCATION_NOTE = 'more differing lines not shown'
const EMIT_ARGV = ['node', 'api-surface.ts', '--emit']

// One read and one write call site keep the fs access to temp roots and the committed fixture.
function readText(root: string, name: string): string {
  return readFileSync(join(root, name), 'utf8')
}

function writeText(root: string, name: string, content: string): void {
  writeFileSync(join(root, name), content)
}

function section(snapshot: string, exportName: string): string {
  const start = snapshot.indexOf(`## export \`${exportName}\``)
  if (start === -1) throw new Error(`export ${exportName} not rendered`)
  const end = snapshot.indexOf('\n## export ', start + 1)
  return snapshot.slice(start, end === -1 ? undefined : end)
}

function tempCopy(options: { withSnapshot: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'surface-mini-'))
  tempRoots.push(root)
  cpSync(fixtureRoot, root, { recursive: true })
  if (!options.withSnapshot) rmSync(join(root, SNAPSHOT_FILE))
  return root
}

function tempRootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'surface-broken-'))
  tempRoots.push(root)
  cpSync(join(fixtureRoot, 'package.json'), join(root, 'package.json'))
  for (const [name, content] of Object.entries(files)) writeText(root, name, content)
  return root
}

function captureIo(): {
  io: { stdout: { write(chunk: string): boolean }; stderr: { write(chunk: string): boolean } }
  out: () => string
  err: () => string
} {
  let out = ''
  let err = ''
  return {
    io: {
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: (chunk: string) => ((err += chunk), true) },
    },
    out: () => out,
    err: () => err,
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('surface renderer over the surface-mini fixture package', () => {
  it('renders members, readonly and optional modifiers, index and call signatures', () => {
    const probe = section(generateSurfaceSnapshot(fixtureRoot), 'Probe')

    expect(probe).toContain('- kind: type')
    expect(probe).toContain('- member: `readonly id`')
    expect(probe).toContain('- member: `tags?`')
    expect(probe).toContain('- type: `string`')
    expect(probe).toContain('- index-signature: `[string]: unknown`')
    expect(probe).toContain('- call-signature: `(): void`')
  })

  it('renders union and intersection members', () => {
    const snapshot = generateSurfaceSnapshot(fixtureRoot)

    expect(section(snapshot, 'Choice')).toContain('- union-members: `"a"`, `"b"`')
    expect(section(snapshot, 'Both')).toContain('- intersection-members: `Left`, `Right`')
  })

  it('renders value exports and function call signatures', () => {
    const greet = section(generateSurfaceSnapshot(fixtureRoot), 'greet')

    expect(greet).toContain('- kind: value')
    expect(greet).toContain('- type: `(name: string) => string`')
    expect(greet).toContain('- call-signature: `(name: string): string`')
  })

  it('does not expand arrays or tuples into their methods', () => {
    const probe = section(generateSurfaceSnapshot(fixtureRoot), 'Probe')

    expect(probe).toContain('- type: `[string, number]`')
    expect(probe).toContain('- type: `string[]`')
    expect(probe).not.toContain('- member: `length`')
    expect(probe).not.toContain('- member: `push`')
  })

  it('renders a self-referential type once and stops', () => {
    const chain = section(generateSurfaceSnapshot(fixtureRoot), 'Chain')

    expect(chain.match(/- member: `head`/g)).toHaveLength(1)
    expect(chain.match(/- member: `next\?`/g)).toHaveLength(1)
    expect(chain.match(/- member: `value`/g)).toHaveLength(1)
    expect(chain.split('\n').length).toBeLessThan(20)
  })

  it('keeps since versions recorded in the existing snapshot and dates new entries at the package version', () => {
    const probe = section(generateSurfaceSnapshot(fixtureRoot), 'Probe')

    expect(probe).toMatch(/- member: `readonly id`\n {2}- since: 0\.9\.0/)
    expect(probe).toMatch(/- member: `run`\n {2}- since: 1\.0\.0/)
  })

  it('dates every entry at the package version when there is no previous snapshot', () => {
    const snapshot = generateSurfaceSnapshot(tempCopy({ withSnapshot: false }))

    expect(snapshot).not.toContain('- since: 0.9.0')
    expect(snapshot).toContain('- since: 1.0.0')
  })

  it('matches the committed fixture snapshot through the in-process freshness check', () => {
    expect(assertSurfaceSnapshotIsFresh(fixtureRoot, generateSurfaceSnapshot(fixtureRoot))).toEqual(
      { ok: true }
    )
  })

  it('fails closed with a readable message on a missing tsconfig, source or module symbol', () => {
    expect(() => generateSurfaceSnapshot(tempRootWith({}))).toThrow(/tsconfig\.json/)
    expect(() =>
      generateSurfaceSnapshot(tempRootWith({ 'tsconfig.json': NO_LIB_TSCONFIG }))
    ).toThrow('could not load extension-api src/index.ts')
  })

  it('throws when src/index.ts is not a module', () => {
    const root = tempCopy({ withSnapshot: false })
    writeText(root, INDEX_FILE, 'const notExported = 1\n')

    expect(() => generateSurfaceSnapshot(root)).toThrow('could not resolve index.ts module symbol')
  })

  // The generator builds with `types: []` (no @types/node) for speed. A source that starts to
  // depend on a Node global would otherwise render it as an unresolved type silently, so any
  // semantic diagnostic in the package's own src files must fail the generation.
  it('fails closed when a src file references a name the narrowed program cannot resolve', () => {
    const root = tempCopy({ withSnapshot: false })
    writeText(
      root,
      'src/helper.ts',
      'export function size(input: string): number {\n  return Buffer.byteLength(input)\n}\n'
    )
    writeText(root, INDEX_FILE, `${readText(root, INDEX_FILE)}import './helper'\n`)

    expect(() => generateSurfaceSnapshot(root)).toThrow(
      /src\/helper\.ts.*Cannot find name 'Buffer'/
    )
  })

  // Without an explicit `lib`, the generator uses the target's ECMAScript lib without the DOM
  // (lib.dom.d.ts is the largest lib file). A src file that needs a DOM type fails closed.
  it('builds without the DOM lib when tsconfig has no explicit lib, and fails closed on DOM names', () => {
    const root = tempCopy({ withSnapshot: false })
    writeText(
      root,
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"target":"es5","types":[]},"files":["src/index.ts"]}'
    )
    writeText(root, INDEX_FILE, `${readText(root, INDEX_FILE)}export type Element = HTMLElement\n`)

    expect(() => generateSurfaceSnapshot(root)).toThrow(
      /src\/index\.ts.*Cannot find name 'HTMLElement'/
    )
  })
})

describe('assertSurfaceSnapshotIsFresh (parent-side compare)', () => {
  it('reports since-index errors before comparing', () => {
    const root = tempCopy({ withSnapshot: true })
    const committed = readText(root, SNAPSHOT_FILE)
    writeText(
      root,
      SNAPSHOT_FILE,
      committed.replace(/(- member: `readonly id`\n) {2}- since: 0\.9\.0\n/, '$1')
    )

    const result = assertSurfaceSnapshotIsFresh(root, committed)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.errors.join('\n')).toContain('is missing since')
  })

  it('shows the regenerate hint and at most 20 differing lines on a mismatch', () => {
    const committed = readText(fixtureRoot, SNAPSHOT_FILE)
    const extra = Array.from(
      { length: 30 },
      (_, index) => `## export \`Extra${index}\`\n\n- since: 1.0.0\n`
    ).join('\n')

    const result = assertSurfaceSnapshotIsFresh(fixtureRoot, `${committed}\n${extra}`)

    expect(result.ok).toBe(false)
    const errors = result.ok ? [] : result.errors
    expect(errors[0]).toBe(
      `public contract changed: update ${SNAPSHOT_FILE} and classify the change against AC-2`
    )
    expect(errors.join('\n')).toContain('pnpm tsx tests/api-surface.ts --write')
    const diffLines = errors.filter((line) => /^[-+] /.test(line))
    expect(diffLines.length).toBeGreaterThan(0)
    expect(diffLines.length).toBeLessThanOrEqual(20)
    expect(errors.join('\n')).toContain('+ ## export `Extra0`')
    expect(errors.join('\n')).toContain(TRUNCATION_NOTE)
  })

  it('shows an inserted export as added lines only, not as every following line shifting', () => {
    const committed = readText(fixtureRoot, SNAPSHOT_FILE)
    const anchor = '## export `Both`'
    const inserted = '## export `Added`\n\n- since: 1.0.0\n- kind: value\n- type: `1`\n\n'
    const generated = committed.replace(anchor, `${inserted}${anchor}`)

    const result = assertSurfaceSnapshotIsFresh(fixtureRoot, generated)

    const errors = result.ok ? [] : result.errors
    expect(errors.filter((line) => line.startsWith('- '))).toEqual([])
    expect(errors.filter((line) => line.startsWith('+ '))).toEqual(
      inserted
        .split('\n')
        .slice(0, -1)
        .map((line) => `+ ${line}`)
    )
    expect(errors.join('\n')).toMatch(/@@ committed line \d+, generated line \d+ @@/)
    expect(errors.join('\n')).not.toContain(TRUNCATION_NOTE)
  })

  it('shows both sides of a changed line', () => {
    const committed = readText(fixtureRoot, SNAPSHOT_FILE)
    const generated = committed.replace('- member: `tags?`', '- member: `tags`')

    const result = assertSurfaceSnapshotIsFresh(fixtureRoot, generated)

    const text = result.ok ? '' : result.errors.join('\n')
    expect(text).toContain('- - member: `tags?`')
    expect(text).toContain('+ - member: `tags`')
    expect(text).not.toContain(TRUNCATION_NOTE)
  })
})

describe('api-surface CLI', () => {
  it('--emit writes the generated snapshot to stdout and nothing else', () => {
    const capture = captureIo()

    const exitCode = runSurfaceCli(EMIT_ARGV, fixtureRoot, capture.io)

    expect(exitCode).toBe(0)
    expect(capture.out()).toBe(readText(fixtureRoot, SNAPSHOT_FILE))
    expect(capture.err()).toBe('')
  })

  it('--emit exits 1 with the error on stderr and nothing on stdout when generation fails', () => {
    const capture = captureIo()

    const exitCode = runSurfaceCli(
      EMIT_ARGV,
      tempRootWith({ 'tsconfig.json': NO_LIB_TSCONFIG }),
      capture.io
    )

    expect(exitCode).toBe(1)
    expect(capture.out()).toBe('')
    expect(capture.err()).toContain('could not load extension-api src/index.ts')
  })

  it('--write regenerates the snapshot file in place', () => {
    const root = tempCopy({ withSnapshot: false })
    const capture = captureIo()

    const exitCode = runSurfaceCli([...EMIT_ARGV.slice(0, 2), '--write'], root, capture.io)

    expect(exitCode).toBe(0)
    expect(readText(root, SNAPSHOT_FILE)).toBe(generateSurfaceSnapshot(root))
  })

  it('prints usage and exits 2 without a mode flag', () => {
    const capture = captureIo()

    expect(runSurfaceCli(EMIT_ARGV.slice(0, 2), fixtureRoot, capture.io)).toBe(2)
    expect(capture.err()).toContain('--emit')
    expect(capture.out()).toBe('')
  })
})
