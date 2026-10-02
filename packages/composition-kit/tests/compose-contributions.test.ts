import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose, type ComposeResult, type RunOptions } from '../src/compose.js'
import { MARKER, makeWorld, manifest, sha, useWorlds, type World } from './compose-test-helpers.js'

const APP_CSS = 'src/app.css'

useWorlds()

const HEALTH = 'injections/HealthTile.svelte'
const FORMAT = 'src/lib/format.ts'
const CM_DIR = 'src/lib/_cm'
const SERVER_CM_DIR = 'src/lib/server/_cm'

function run(world: World, pack: unknown, extra: Partial<RunOptions> = {}): Promise<ComposeResult> {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: pack,
    ...extra,
  })
}

function read(world: World, rel: string): string {
  return readFileSync(join(world.app, rel), 'utf8')
}

describe('AC-5: materialization under $cm with AST-rewritten relative imports', () => {
  it('relocates injections, rewrites imports to $lib and $cm, and routes server-only code', async () => {
    const world = makeWorld({
      packFiles: {
        [HEALTH]: `<script lang="ts">\n  import { fmt } from '../src/lib/format'\n  import Helper from './Helper.svelte'\n</script>\n<p>{fmt(1)}</p>\n`,
        'injections/Helper.svelte': '<b>helper</b>\n',
        'injections/health-tile.server.ts':
          "import { stored } from './data/store'\nexport const load = () => stored\n",
        'injections/data/store.ts': 'export const stored = 1\n',
        'hooks.server.ts': "import { fmt } from './src/lib/format'\nexport const handle = fmt\n",
        [FORMAT]: 'export const fmt = (n: number) => `${n}`\n',
      },
    })
    const pack = manifest({
      injections: {
        'project.detail.tiles': [
          { component: `./${HEALTH}`, order: 10, load: './injections/health-tile.server.ts' },
        ],
      },
      hooks: { server: './hooks.server.ts' },
    })
    const result = await run(world, pack)
    expect(result.messages).toEqual([])
    expect(read(world, `${CM_DIR}/${HEALTH}`)).toContain("from '$lib/format'")
    expect(read(world, `${CM_DIR}/${HEALTH}`)).toContain("from '$cm/injections/Helper.svelte'")
    expect(existsSync(join(world.app, `${CM_DIR}/injections/Helper.svelte`))).toBe(true)
    expect(read(world, `${SERVER_CM_DIR}/injections/health-tile.server.ts`)).toContain(
      "from '$cm/injections/data/store'"
    )
    expect(existsSync(join(world.app, `${CM_DIR}/injections/data/store.ts`))).toBe(true)
    expect(read(world, `${SERVER_CM_DIR}/hooks.server.ts`)).toContain("from '$lib/format'")
    const lock = JSON.parse(read(world, 'composition.lock.json')) as {
      contributions: { hooks: Record<string, string> }
      injectionPointsUsed: unknown[]
      materialized: { path: string }[]
    }
    expect(lock.contributions.hooks).toEqual({ server: `${SERVER_CM_DIR}/hooks.server.ts` })
    expect(lock.injectionPointsUsed).toEqual([{ name: 'project.detail.tiles', file: null }])
    expect(lock.materialized.map((entry) => entry.path)).toContain(`${CM_DIR}/${HEALTH}`)
    expect(result.plan.notes).toContain(
      'injection point names not validated: this web-host ships no injection-points.json'
    )
    expect(result.plan.notes).toContainEqual(
      expect.stringContaining('hook composition not applied')
    )
  })

  it('rewrites imports in overlay files that escape src/, and leaves in-src imports alone', async () => {
    const world = makeWorld({
      packFiles: {
        'src/routes/billing/+page.svelte': `<script>\n  import Card from '../../../shared/Card.svelte'\n  import local from '../../lib/local'\n</script>\n`,
        'shared/Card.svelte': '<div />\n',
        'src/lib/local.ts': 'export default 1\n',
      },
    })
    const result = await run(world, manifest())
    expect(result.messages).toEqual([])
    const page = read(world, 'src/routes/billing/+page.svelte')
    expect(page).toContain("from '$cm/shared/Card.svelte'")
    expect(page).toContain("from '../../lib/local'")
  })

  it('fails an unresolvable relative import, a path escape and a reserved destination', async () => {
    const world = makeWorld({
      packFiles: {
        'injections/bad.ts': "import './missing.ts'\nimport '../../../../../etc/x'\n",
      },
    })
    const result = await run(
      world,
      manifest({ injections: { p: [{ component: './injections/bad.ts' }] } })
    )
    expect(result.messages).toEqual([
      expect.stringContaining('Path escape'),
      expect.stringContaining('Unresolvable import: injections/bad.ts imports "./missing.ts"'),
    ])
  })

  it('terminates on a closure cycle and materializes each file once', async () => {
    const world = makeWorld({
      packFiles: {
        'a/a.ts': "import './b'\nexport const a = 1\n",
        'a/b.ts': "import './a'\nexport const b = 1\n",
      },
    })
    const result = await run(world, manifest({ injections: { p: [{ component: './a/a.ts' }] } }))
    expect(result.messages).toEqual([])
    expect(result.plan.summary.materialized).toBe(2)
  })

  it('notes new URL(..., import.meta.url) and fails a manifest file the pack lacks', async () => {
    const world = makeWorld({
      packFiles: { 'x/asset.ts': "export const u = new URL('./a.png', import.meta.url)\n" },
    })
    const ok = await run(world, manifest({ injections: { p: [{ component: './x/asset.ts' }] } }))
    expect(ok.plan.notes).toContainEqual(expect.stringContaining('was left alone'))
    const missing = await run(world, manifest({ theme: './nope.css', nav: '../outside.ts' }))
    expect(missing.messages).toEqual([
      expect.stringContaining('nav: "../outside.ts" must be a path inside the UI pack'),
      expect.stringContaining('theme: ./nope.css does not exist in the UI pack'),
    ])
  })

  it('lists an unreachable pack file as informational and does not copy it', async () => {
    const world = makeWorld({ packFiles: { 'tools/build.ts': 'x\n', 'README.md': 'x\n' } })
    const result = await run(world, manifest())
    expect(result.ok).toBe(true)
    expect(result.plan.notes).toContainEqual(
      'unreached pack file README.md was not copied (nothing in the manifest or the overlay imports it)'
    )
    expect(existsSync(join(world.app, `${CM_DIR}/tools/build.ts`))).toBe(false)
  })
})

describe('AC-11: theme and messages', () => {
  it('appends the theme import at the end of app.css and rewrites the shared @source', async () => {
    const world = makeWorld({
      hostFiles: {
        [APP_CSS]: `@import "tailwindcss" source(none);\n${MARKER}\n@source "../../../packages/shared/src/**/*.ts";\n.pv { color: red; }\n`,
      },
      packFiles: {
        'theme.css':
          '@theme { --color-cm-accent: #123456; }\n.x { background: url(./img/bg.png); }\n',
        'img/bg.png': 'png',
      },
    })
    const result = await run(world, manifest({ theme: './theme.css' }))
    expect(result.messages).toEqual([])
    const css = read(world, APP_CSS)
    expect(css).toContain('@source "../vendor/shared/src/**/*.ts";')
    expect(css).not.toContain('packages/shared')
    expect(css.trimEnd().split('\n').at(-1)).toBe('@import "./lib/_cm/theme.css";')
    expect(css).toContain('@source "./lib/_cm/**/*.{svelte,ts}";')
    expect(read(world, `${CM_DIR}/theme.css`)).toContain('url(./img/bg.png)')
    expect(existsSync(join(world.app, `${CM_DIR}/img/bg.png`))).toBe(true)
  })

  it('leaves PV bytes plus the shared line alone when there is no theme', async () => {
    const world = makeWorld()
    await run(world, manifest())
    expect(read(world, APP_CSS)).toContain('.pv { color: red; }')
    expect(read(world, APP_CSS)).not.toContain('@import "./lib/_cm')
  })

  it('appends the theme to an overridden app.css, and adds the shared source when its marker is gone', async () => {
    const world = makeWorld({
      packFiles: {
        [APP_CSS]: '.cm-brand { color: blue; }\n',
        'theme.css': '.t { color: green; }\n',
      },
    })
    const pack = manifest({
      theme: './theme.css',
      routes: { overrides: [{ path: APP_CSS, hostSha256: sha(world, APP_CSS), story: 's' }] },
    })
    const result = await run(world, pack)
    expect(result.messages).toEqual([])
    const css = read(world, APP_CSS)
    expect(css.startsWith('.cm-brand')).toBe(true)
    expect(css).toContain('@source "../vendor/shared/src/**/*.ts";')
    expect(css.trimEnd().split('\n').at(-1)).toBe('@import "./lib/_cm/theme.css";')
    expect(result.plan.notes).toContainEqual(expect.stringContaining('no shared-source marker'))
  })

  it('fails a marker not followed by an @source line and a repeated marker', async () => {
    const broken = makeWorld({ hostFiles: { [APP_CSS]: `${MARKER}\n.x {}\n` } })
    expect((await run(broken, manifest())).messages).toEqual([
      expect.stringContaining('not followed by an @source'),
    ])
    const twice = makeWorld({
      hostFiles: { [APP_CSS]: `${MARKER}\n@source "x";\n${MARKER}\n@source "y";\n` },
    })
    expect((await run(twice, manifest())).messages).toEqual([
      expect.stringContaining('exactly once'),
    ])
  })

  it('overrides PV message values, adds a locale, keeps $schema, and notes unknown keys without merging them', async () => {
    const world = makeWorld({
      packFiles: {
        'messages/en.json': JSON.stringify({
          $schema: 'ignored',
          app_name: 'Acme Vault',
          cm_only_key: 'x',
        }),
        'messages/fr.json': JSON.stringify({
          app_name: 'Acme Coffre',
          greeting: 'Bonjour',
          other: 'nope',
        }),
        'messages/es.json': JSON.stringify({ greeting: 'Buenas' }),
      },
    })
    const result = await run(world, manifest({ messages: './messages' }))
    expect(result.messages).toEqual([])
    const en = JSON.parse(read(world, 'messages/en.json')) as Record<string, string>
    expect(en).toEqual({
      $schema: 'https://inlang.com/schema/inlang-message-format',
      app_name: 'Acme Vault',
      greeting: 'Hello',
    })
    const fr = JSON.parse(read(world, 'messages/fr.json')) as Record<string, string>
    expect(fr).toEqual({
      $schema: 'https://inlang.com/schema/inlang-message-format',
      app_name: 'Acme Coffre',
      greeting: 'Bonjour',
    })
    const es = JSON.parse(read(world, 'messages/es.json')) as Record<string, string>
    expect(es.app_name).toBe('Project Vault')
    expect(es.greeting).toBe('Buenas')
    const settings = JSON.parse(read(world, 'project.inlang/settings.json')) as {
      baseLocale: string
      locales: string[]
    }
    expect(settings).toEqual({ baseLocale: 'en', locales: ['en', 'es', 'fr'] })
    expect(result.plan.notes).toEqual(
      expect.arrayContaining([
        'messages/en.json: key "cm_only_key" is not a PV message key and was not merged',
        'messages/fr.json: key "other" is not a PV message key and was not merged',
      ])
    )
  })

  it('fails malformed JSON, a non-string value and a bad locale tag', async () => {
    const world = makeWorld({
      packFiles: {
        'messages/en.json': '{ not json',
        'messages/fr.json': JSON.stringify({ app_name: 3 }),
        'messages/not a locale.json': '{}',
      },
    })
    const result = await run(world, manifest({ messages: './messages' }))
    expect(result.messages).toEqual([
      expect.stringContaining('messages/en.json: malformed JSON'),
      expect.stringContaining('messages/fr.json: the value of "app_name" must be a string'),
      expect.stringContaining('"not a locale" is not a valid locale tag'),
    ])
  })
})
