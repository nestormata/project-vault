import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { loadManifest, validateManifest } from './manifest.js'
import { defineUiPack, type UiPackManifest } from './types.js'

const MANIFEST_FILE = 'pv-ui.manifest.ts'

const HASH = 'a'.repeat(64)

describe('defineUiPack', () => {
  it('is the identity at runtime and accepts the design section 4 example verbatim', () => {
    const pack = defineUiPack({
      host: { pvRelease: '1.4.0' },
      routes: {
        overrides: [
          { path: 'src/routes/(app)/dashboard/+page.svelte', hostSha256: HASH, story: 'CM-E16.3' },
          { path: 'static/favicon.png', hostSha256: HASH, story: 'CM-E16.1' },
        ],
        remove: [],
      },
      injections: {
        'project.detail.tiles': [
          {
            component: './injections/HealthTile.svelte',
            order: 10,
            load: './injections/health-tile.server.ts',
            actions: './injections/health-tile.actions.ts',
          },
        ],
      },
      replacements: {
        '$lib/components/shell/GlobalSearch.svelte': {
          with: './replacements/GlobalSearch.svelte',
          hostSha256: HASH,
          story: 'CM-E16.5',
        },
      },
      hooks: {
        server: './hooks.server.ts',
        universal: './hooks.universal.ts',
        client: './hooks.client.ts',
      },
      nav: './nav.ts',
      theme: './theme.css',
      messages: './messages',
      protectedPaths: { add: ['/billing'], remove: [] },
    })
    expect(pack.host.pvRelease).toBe('1.4.0')
    expectTypeOf(pack).toEqualTypeOf<UiPackManifest>()
    expect(validateManifest(pack).problems).toEqual([])
  })

  it('requires only host', () => {
    expect(validateManifest({ host: { pvRelease: '1.4.0' } })).toMatchObject({
      problems: [],
      notes: [],
    })
  })
})

describe('validateManifest (structural integrity only)', () => {
  const base = { host: { pvRelease: '1.4.0' } }

  it('fails a missing host or a non-exact pvRelease', () => {
    expect(validateManifest({}).problems).toEqual([expect.stringContaining('host')])
    expect(validateManifest({ host: { pvRelease: '^1.4.0' } }).problems).toEqual([
      expect.stringContaining('exact version'),
    ])
    expect(validateManifest('nope').problems).toEqual([expect.stringContaining('object')])
  })

  it('names the field and entry of a malformed hostSha256', () => {
    const result = validateManifest({
      ...base,
      routes: { overrides: [{ path: 'src/a.ts', hostSha256: 'ABC' }] },
    })
    expect(result.problems).toEqual([expect.stringContaining('routes.overrides[0].hostSha256')])
  })

  it('reports a duplicate override path and a path escape', () => {
    const result = validateManifest({
      ...base,
      routes: {
        overrides: [
          { path: 'src/a.ts', hostSha256: HASH, story: 's' },
          { path: 'src/a.ts', hostSha256: HASH, story: 's' },
          { path: '../x', hostSha256: HASH, story: 's' },
        ],
      },
    })
    expect(result.problems).toEqual([
      expect.stringContaining('declared twice'),
      expect.stringContaining('escapes'),
    ])
  })

  it('treats a missing story as informational', () => {
    const result = validateManifest({
      ...base,
      routes: { overrides: [{ path: 'src/a.ts', hostSha256: HASH }] },
      replacements: { '$lib/x.svelte': { with: './x.svelte', hostSha256: HASH } },
    })
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([
      'override src/a.ts has no story',
      'replacement $lib/x.svelte has no story',
    ])
  })

  it('treats unknown top-level keys as a note, never a failure', () => {
    const result = validateManifest({ ...base, futureThing: { a: 1 } })
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([expect.stringContaining('futureThing')])
  })

  it('checks the structural type of every field', () => {
    const result = validateManifest({
      ...base,
      routes: { overrides: 'x', remove: [1] },
      injections: { p: [{ order: 'a' }], q: 'z' },
      replacements: { '$lib/a': { with: 3 } },
      hooks: { server: 3 },
      nav: 1,
      theme: 2,
      messages: 3,
      protectedPaths: { add: 'x' },
    })
    expect(result.problems.length).toBeGreaterThanOrEqual(9)
    expect(result.problems.join('\n')).toContain('routes.overrides must be an array')
    expect(result.problems.join('\n')).toContain('injections.p[0].component')
  })

  it('never refuses a declaration on policy grounds (any PV path, any injection name)', () => {
    const paths = [
      'src/hooks.server.ts',
      'src/app.html',
      'src/lib/server/auth/session.ts',
      'src/routes/api/v1/[...path]/+server.ts',
      'static/favicon.png',
    ]
    const result = validateManifest({
      ...base,
      routes: {
        overrides: paths.map((path) => ({ path, hostSha256: HASH, story: 's' })),
        remove: paths,
      },
    })
    expect(result.problems).toEqual([])
  })
})

describe('loadManifest', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  function packDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-manifest-'))
    roots.push(dir)
    return dir
  }

  it('loads a TypeScript manifest, strips types, and leaves no temp file behind', async () => {
    const dir = packDir()
    writeFileSync(
      join(dir, MANIFEST_FILE),
      "type Pack = { host: { pvRelease: string } }\nconst pack: Pack = { host: { pvRelease: '1.4.0' } }\nexport default pack\n"
    )
    const manifest = await loadManifest(join(dir, MANIFEST_FILE), {
      resolveFrom: import.meta.dirname,
    })
    expect(manifest).toEqual({ host: { pvRelease: '1.4.0' } })
    expect(readdirSync(dir)).toEqual([MANIFEST_FILE])
  })

  it('loads .json and .mjs manifests', async () => {
    const dir = packDir()
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ host: { pvRelease: '1.0.0' } }))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.mjs'), "export default { host: { pvRelease: '2.0.0' } }\n")
    expect(await loadManifest(join(dir, 'a.json'), { resolveFrom: dir })).toEqual({
      host: { pvRelease: '1.0.0' },
    })
    expect(await loadManifest(join(dir, 'sub', 'b.mjs'), { resolveFrom: dir })).toEqual({
      host: { pvRelease: '2.0.0' },
    })
  })

  it('fails clearly on a missing file, a missing default export and an unknown extension', async () => {
    const dir = packDir()
    await expect(loadManifest(join(dir, 'missing.ts'), { resolveFrom: dir })).rejects.toThrow(
      /not found/
    )
    writeFileSync(join(dir, 'nodefault.mjs'), 'export const x = 1\n')
    await expect(loadManifest(join(dir, 'nodefault.mjs'), { resolveFrom: dir })).rejects.toThrow(
      /default export/
    )
    writeFileSync(join(dir, 'm.txt'), 'x')
    await expect(loadManifest(join(dir, 'm.txt'), { resolveFrom: dir })).rejects.toThrow(
      /unsupported/
    )
  })
})
