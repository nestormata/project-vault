// Story 68.6 AC-1 (types): web-host declares `virtual:pv-hooks/*` with its own structural types
// (apps/web/src/lib/composition/virtual-hooks.d.ts); the kit ships `PvHooksModule` and
// `PvServerHooksModule` for CM authors. This contract test compiles both, read as data (the kit never
// imports web-host), and proves they are assignable both ways.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as TypeScript from 'typescript'
import { describe, expect, it } from 'vitest'

const ts = createRequire(import.meta.url)('typescript') as typeof TypeScript
const REPO = join(import.meta.dirname, '..', '..', '..')
const WEB_HOST_DECLARATIONS = join(
  REPO,
  'apps',
  'web',
  'src',
  'lib',
  'composition',
  'virtual-hooks.d.ts'
)
const KIT_TYPES = join(import.meta.dirname, '..', 'src', 'types.ts')

function diagnostics(snippet: string): string[] {
  const files = new Map([
    ['/contract/virtual-hooks.d.ts', readFileSync(WEB_HOST_DECLARATIONS, 'utf8')],
    ['/contract/kit-types.ts', readFileSync(KIT_TYPES, 'utf8')],
    ['/contract/check.ts', snippet],
  ])
  const options: TypeScript.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ['lib.es2022.d.ts'],
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version) => {
    const text = files.get(name)
    return text === undefined ? original(name, version) : ts.createSourceFile(name, text, version)
  }
  host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name)
  host.readFile = (name) => files.get(name) ?? ts.sys.readFile(name)
  host.directoryExists = (dir) => dir === '/contract' || ts.sys.directoryExists(dir)
  host.realpath = (name) => name
  const program = ts.createProgram([...files.keys()], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

const CONTRACT = `
import type { PvHooksModule, PvServerHooksModule } from './kit-types'
import * as server from 'virtual:pv-hooks/server'
import * as universal from 'virtual:pv-hooks/universal'
import * as client from 'virtual:pv-hooks/client'

// web-host's modules satisfy the kit's types...
export const s: PvServerHooksModule = server
export const u: PvHooksModule = universal
export const c: PvHooksModule = client
// ...and the kit's types satisfy web-host's module shapes.
declare const kitServer: PvServerHooksModule
declare const kitOther: PvHooksModule
export const s2: typeof server = kitServer
export const u2: typeof universal = kitOther
export const c2: typeof client = kitOther
`

describe('virtual:pv-hooks/* type contract (AC-1)', () => {
  it("web-host's declarations and the kit's types are assignable both ways", () => {
    expect(diagnostics(CONTRACT)).toEqual([])
  })

  it('red proof: a shape mismatch is reported', () => {
    const broken = `
import type { PvServerHooksModule } from './kit-types'
import * as client from 'virtual:pv-hooks/client'
export const s: PvServerHooksModule = client
`
    expect(diagnostics(broken).join('\n')).toContain('protectedPaths')
  })
})
