// Story 68.7 AC-8: the kit's nav shapes and web-host's nav model are structurally the same. The kit
// (MIT) and web-host (AGPL) never import each other, so this type-checks both source files side by
// side in an in-memory TypeScript program (web-host's `$app/types` stubbed with a stand-in
// `ResolvedPathname`) and asserts assignability in both directions, plus a negative control that
// proves the check is not vacuous. web-host has the mirror test.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const KIT_TYPES = join(import.meta.dirname, 'types.ts')
const PV_TYPES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'web',
  'src',
  'lib',
  'navigation',
  'types.ts'
)
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

function diagnostics(check: string): string[] {
  const files = new Map<string, string>([
    ['/v/app-types.ts', 'export type ResolvedPathname = `/${string}`\n'],
    [
      '/v/pv-types.ts',
      readFileSync(PV_TYPES, 'utf8').replace("from '$app/types'", "from './app-types.ts'"),
    ],
    ['/v/kit-types.ts', readFileSync(KIT_TYPES, 'utf8')],
    ['/v/check.ts', check],
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
  const program = ts.createProgram(['/v/check.ts'], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith('/v/') === true)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0] ?? '')
}

describe("kit nav shapes = web-host's nav model (Story 68.7 AC-8)", () => {
  it('assign both ways (operations, items, a whole delta)', () => {
    expect(diagnostics(CHECK)).toEqual([])
  })

  it('is not vacuous: a plain-string href does not satisfy web-host (it needs resolve())', () => {
    const negative = `${CHECK}\ndeclare const loose: KitOp<Ctx, string>\nexport const bad: PvOp<Ctx> = loose\n`
    expect(diagnostics(negative)).toEqual([expect.stringContaining('is not assignable')])
  })
})
