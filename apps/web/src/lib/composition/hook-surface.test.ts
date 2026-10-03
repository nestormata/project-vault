// @vitest-environment node
// Story 68.6 AC-10 — the installed SvelteKit's hooks are enumerated from TWO independent sources
// (the `ServerHooks`/`ClientHooks` types via the TypeScript compiler API, and the code Kit
// generates to read the hooks files) and must both equal HOOK_SURFACE. A new Kit hook (or a removed
// one) fails this test, so the contribution surface never silently lags Kit.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { HOOK_SURFACE } from './hook-surface.js'

type Surface = Record<'server' | 'universal' | 'client', string[]>

const KIT_ROOT = dirname(createRequire(import.meta.url).resolve('@sveltejs/kit/package.json'))
const read = (relative: string) => readFileSync(join(KIT_ROOT, relative), 'utf8')

function fail(file: string): never {
  throw new Error(`could not enumerate Kit hooks from ${file}; update this test`)
}

/** Source 1: property names of ServerHooks and ClientHooks. Names in both interfaces with an
 * identical type are universal (`reroute`, `transport`); the rest belong to their own file. */
function hooksFromTypes(source: string, file: string): Surface {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const members = new Map<string, Map<string, string>>()
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return
    if (node.name.text !== 'ServerHooks' && node.name.text !== 'ClientHooks') return
    const props = new Map<string, string>()
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name))
        props.set(member.name.text, member.type?.getText(sf) ?? '')
    }
    members.set(node.name.text, props)
  })
  const server = members.get('ServerHooks') ?? fail(file)
  const client = members.get('ClientHooks') ?? fail(file)
  const universal = [...server.keys()].filter((name) => client.get(name) === server.get(name))
  const result: Surface = {
    server: [...server.keys()].filter((name) => !universal.includes(name)),
    universal,
    client: [...client.keys()].filter((name) => !universal.includes(name)),
  }
  for (const names of Object.values(result)) if (names.length < 2) fail(file)
  return result
}

/** Source 2: the destructuring lists in write_server.js and the reads in write_client_manifest.js. */
function hooksFromGeneratedCode(writeServer: string, writeClient: string): Surface {
  const list = (text: string | undefined, file: string) =>
    (text ?? fail(file))
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  const serverList = /\(\{([^}]*)\} = await import\(\$\{s\(server_hooks\)\}\)\)/.exec(writeServer)
  const universalList = /\(\{([^}]*)\} = await import\(\$\{s\(universal_hooks\)\}\)\)/.exec(
    writeServer
  )
  const clientReads = [...writeClient.matchAll(/client_hooks\.(\w+)/g)].map((m) => m[1] as string)
  const universalReads = [...writeClient.matchAll(/universal_hooks\.(\w+)/g)].map(
    (m) => m[1] as string
  )
  const universal = list(universalList?.[1], 'write_server.js')
  if (universalReads.sort().join() !== [...universal].sort().join())
    fail('write_client_manifest.js')
  const result: Surface = {
    server: list(serverList?.[1], 'write_server.js'),
    universal,
    client: [...new Set(clientReads)],
  }
  for (const names of Object.values(result)) if (names.length < 2) fail('write_client_manifest.js')
  return result
}

/** Every difference between Kit's hooks and HOOK_SURFACE, as actionable messages. */
function surfaceProblems(kit: Surface, surface: Readonly<Record<string, readonly string[]>>) {
  const problems: string[] = []
  const ours = new Map(Object.entries(surface))
  for (const [file, kitNames] of Object.entries(kit)) {
    const listed = ours.get(file) ?? []
    for (const name of kitNames)
      if (!listed.includes(name))
        problems.push(
          `SvelteKit hook "${name}" (${file}) is not in HOOK_SURFACE: add it to the contribution surface (design §8.1)`
        )
    for (const name of listed)
      if (!kitNames.includes(name))
        problems.push(`"${name}" (${file}) is in HOOK_SURFACE but not in Kit: remove it`)
  }
  return problems
}

describe('HOOK_SURFACE covers every SvelteKit hook (AC-10)', () => {
  it('source 1 (types, TypeScript compiler API) equals HOOK_SURFACE', () => {
    const kit = hooksFromTypes(read('src/types/internal.d.ts'), 'src/types/internal.d.ts')
    expect(surfaceProblems(kit, HOOK_SURFACE)).toEqual([])
  })

  it('source 2 (generated hooks-reading code) equals HOOK_SURFACE', () => {
    const kit = hooksFromGeneratedCode(
      read('src/core/sync/write_server.js'),
      read('src/core/sync/write_client_manifest.js')
    )
    expect(surfaceProblems(kit, HOOK_SURFACE)).toEqual([])
  })

  it('red proof: a Kit types file with an extra server hook fails with an actionable message', () => {
    const fixture = readFileSync(
      join(import.meta.dirname, 'fixtures', 'kit-internal-hooks-extra.d.ts.txt'),
      'utf8'
    )
    expect(surfaceProblems(hooksFromTypes(fixture, 'fixture'), HOOK_SURFACE)).toEqual([
      'SvelteKit hook "handleNewThing" (server) is not in HOOK_SURFACE: add it to the contribution surface (design §8.1)',
    ])
  })

  it('a hook Kit removed fails too', () => {
    const kit = hooksFromTypes(read('src/types/internal.d.ts'), 'internal.d.ts')
    const stale = { ...HOOK_SURFACE, client: [...HOOK_SURFACE.client, 'handleGone'] }
    expect(surfaceProblems(kit, stale)).toEqual([
      '"handleGone" (client) is in HOOK_SURFACE but not in Kit: remove it',
    ])
  })

  it('fails closed when a source cannot be enumerated (never passes vacuously)', () => {
    expect(() => hooksFromTypes('export interface Other {}', 'x.d.ts')).toThrow(
      'could not enumerate Kit hooks from x.d.ts; update this test'
    )
    expect(() => hooksFromGeneratedCode('', '')).toThrow(
      'could not enumerate Kit hooks from write_server.js; update this test'
    )
  })
})
