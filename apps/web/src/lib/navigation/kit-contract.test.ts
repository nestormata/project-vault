// Story 68.7 AC-8 (mirror of the kit's contract test): web-host's nav model and the kit's nav
// shapes are structurally the same. Neither imports the other; this reads both as text and
// type-checks them in an in-memory TypeScript program (`$app/types` stubbed), both directions,
// plus a negative control. Not shipped in web-host: it reads the kit's source (outside the package).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

// A relative path literal, so web-host's test selection sees this test reads outside the package
// (it is not shipped).
const KIT_TYPES = join(
  import.meta.dirname,
  '../../../../../packages/composition-kit/src/nav/types.ts'
)
const PV_TYPES = join(import.meta.dirname, 'types.ts')
const SVELTE_TYPES = join(
  dirname(createRequire(import.meta.url).resolve('svelte/package.json')),
  'types',
  'index.d.ts'
)

const CHECK = `
import type { NavDelta as PvDelta, NavItem as PvItem, NavOp as PvOp } from './pv-types.ts'
import type { NavItem as KitItem, NavOp as KitOp } from './kit-types.ts'
import type { ResolvedPathname } from './app-types.ts'
type Ctx = { pathname: string; projectId: string; orgRole: string }
declare const pvOp: PvOp<Ctx>
declare const kitOp: KitOp<Ctx, ResolvedPathname>
declare const pvItem: PvItem<Ctx>
declare const kitItem: KitItem<Ctx, ResolvedPathname>
export const kitFromPv: KitOp<Ctx, ResolvedPathname> = pvOp
export const pvFromKit: PvOp<Ctx> = kitOp
export const kitItemFromPv: KitItem<Ctx, ResolvedPathname> = pvItem
export const pvItemFromKit: PvItem<Ctx> = kitItem
export const delta: PvDelta = { project: [kitOp] }
`

// One program checks every case: building a TypeScript program (lib + svelte types) costs seconds
// under CI coverage, so it is built once in `beforeAll`, never once per test.
function diagnosticsByFile(checks: Record<string, string>): Map<string, string[]> {
  const files = new Map<string, string>([
    ['/v/app-types.ts', 'export type ResolvedPathname = `/${string}`\n'],
    [
      '/v/pv-types.ts',
      readFileSync(PV_TYPES, 'utf8').replace("from '$app/types'", "from './app-types.ts'"),
    ],
    ['/v/kit-types.ts', readFileSync(KIT_TYPES, 'utf8')],
    ...Object.entries(checks).map(([name, text]): [string, string] => [`/v/${name}.ts`, text]),
  ])
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
    paths: { svelte: [SVELTE_TYPES] },
  }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.readFile = (name) => files.get(name) ?? readFile(name)
  host.fileExists = (name) => files.has(name) || fileExists(name)
  const directoryExists = host.directoryExists?.bind(host)
  host.directoryExists = (dir) => dir === '/v' || (directoryExists?.(dir) ?? false)
  host.realpath = (path) => path
  host.getSourceFile = (name, version) => {
    const text = host.readFile(name)
    return text === undefined ? undefined : ts.createSourceFile(name, text, version)
  }
  const roots = Object.keys(checks).map((name) => `/v/${name}.ts`)
  const program = ts.createProgram(roots, options, host)
  const byFile = new Map<string, string[]>(roots.map((root) => [root, []]))
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file?.fileName
    if (file?.startsWith('/v/') !== true) continue
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? ''
    // An error inside a shared type file (pv-types, kit-types) breaks every case, so it counts for each.
    for (const [root, messages] of byFile)
      if (root === file || !byFile.has(file)) messages.push(message)
  }
  return byFile
}

describe("web-host's nav model = the kit's nav shapes (Story 68.7 AC-8)", () => {
  let byFile = new Map<string, string[]>()

  beforeAll(() => {
    const negative = `${CHECK}\ndeclare const loose: KitOp<Ctx, string>\nexport const bad: PvOp<Ctx> = loose\n`
    byFile = diagnosticsByFile({ check: CHECK, negative })
  }, 60_000)

  it('assign both ways (operations, items, a whole delta)', () => {
    expect(byFile.get('/v/check.ts')).toEqual([])
  })

  it('is not vacuous: a plain-string href does not satisfy web-host (it needs resolve())', () => {
    expect(byFile.get('/v/negative.ts')).toEqual([expect.stringContaining('is not assignable')])
  })
})
