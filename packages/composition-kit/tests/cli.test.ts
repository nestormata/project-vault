import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'
import { makeWorld, manifest, sha, useWorlds, type World } from './compose-test-helpers.js'

useWorlds()

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'

async function cli(
  args: string[],
  locate?: (appRoot: string) => string
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io = { out: (text: string) => (out += text), err: (text: string) => (err += text) }
  const code = await (locate === undefined ? runCli(args, io) : runCli(args, io, locate))
  return { code, out, err }
}

function baseArgs(world: World): string[] {
  return [
    '--app',
    world.app,
    '--pack',
    world.pack,
    '--host',
    world.host,
    '--manifest',
    join(world.pack, 'pv-ui.manifest.json'),
  ]
}

function writeManifest(world: World, content: unknown): void {
  writeFileSync(join(world.pack, 'pv-ui.manifest.json'), JSON.stringify(content))
}

describe('pv-compose CLI contract (AC-2)', () => {
  it('exits 0 with one line per phase and a summary, and never logs file contents', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm secret-looking content\n' } })
    writeManifest(
      world,
      manifest({
        routes: { overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD), story: 's' }] },
      })
    )
    const result = await cli(baseArgs(world))
    expect(result.code).toBe(0)
    expect(result.out).toContain('pv-compose: locate web-host')
    expect(result.out).toMatch(
      /pv-compose: done: 1 overrides, 0 additions, 0 removals, 0 replacements, \d+ notes, \d+ files, \d+ ms/
    )
    expect(result.out + result.err).not.toContain('cm secret-looking content')
    expect(readFileSync(join(world.app, 'composition.lock.json'), 'utf8')).toContain(
      '"lockfileVersion": 2'
    )
  })

  it('prints the protected-paths line, and each derived route under --verbose (Story 68.6)', async () => {
    const world = makeWorld({
      hostFiles: {
        'manifests/hooks-surface.json': JSON.stringify({
          schemaVersion: 1,
          server: ['handle'],
          universal: ['reroute'],
          client: ['init'],
          protectedPrefixes: ['/dashboard'],
        }),
      },
      packFiles: { 'src/routes/(app)/cm-area/+page.svelte': 'cm\n' },
    })
    writeManifest(world, manifest())
    const quiet = await cli(baseArgs(world))
    expect(quiet.out).toContain(
      'pv-compose: protected paths: 1 derived (app) routes, 0 added, 0 removed (0 notes)'
    )
    expect(quiet.out).not.toContain('pv-compose:   protected /(app)/cm-area')
    const verbose = await cli([...baseArgs(world), '--verbose'])
    expect(verbose.out).toContain('pv-compose:   protected /(app)/cm-area')
  })

  it('exits 1 on an integrity failure, printing every problem then a count', async () => {
    const world = makeWorld({
      packFiles: { 'src/routes/login/+page.svelte': 'x\n', [DASHBOARD]: 'y\n' },
    })
    writeManifest(world, manifest())
    const result = await cli(baseArgs(world))
    expect(result.code).toBe(1)
    expect(result.err).toContain('Collision: src/routes/login/+page.svelte')
    expect(result.err).toContain('Collision: src/routes/(app)/dashboard/+page.svelte')
    expect(result.err).toContain('pv-compose: failed (2 problems)')
    expect(existsSync(join(world.app, 'src'))).toBe(false)
  })

  it('exits 2 on a usage error: unknown flag or missing --pack', async () => {
    expect((await cli(['--nope'])).code).toBe(2)
    const missing = await cli([])
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('--pack')
  })

  it('exits 2 when the web-host cannot be located and --host is absent', async () => {
    const world = makeWorld()
    const result = await cli(['--app', world.app, '--pack', world.pack], () => {
      throw new Error('not installed')
    })
    expect(result.code).toBe(2)
    expect(result.err).toContain('cannot locate @project-vault/web-host')
  })

  it('prints help with exit 0', async () => {
    const result = await cli(['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('--accept-host')
  })

  it('--dry-run writes nothing and --check passes after a compose', async () => {
    const world = makeWorld()
    writeManifest(world, manifest())
    expect((await cli([...baseArgs(world), '--dry-run'])).code).toBe(0)
    expect(readdirSync(world.app)).toEqual(['node_modules', 'package.json'])
    expect((await cli([...baseArgs(world), '--check'])).code).toBe(1)
    expect((await cli(baseArgs(world))).code).toBe(0)
    expect((await cli([...baseArgs(world), '--check'])).code).toBe(0)
  })

  it('reports a manifest that cannot be loaded with exit 1', async () => {
    const world = makeWorld()
    const result = await cli([...baseArgs(world)])
    expect(result.code).toBe(1)
    expect(result.err).toContain('manifest not found')
  })
})
