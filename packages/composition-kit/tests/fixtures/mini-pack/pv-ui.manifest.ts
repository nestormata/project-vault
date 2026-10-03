// The mini UI pack of the kit's integration job. It exercises overrides (a page, a server load, the
// app shell template, a static asset), M2 additions, a route removal, an injection component, a
// replacement, server/universal/client hooks with a header-policy delta, CM routes under (app)
// (protected by derivation, Story 68-6), a theme and message overlays. Hashes are computed from the installed
// web-host when the manifest loads, never hard-coded, and an override is declared only while its
// file exists in the pack (so deleting an override in dev mode restores the PV file).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineUiPack } from '@project-vault/composition-kit'

const pack = fileURLToPath(new URL('.', import.meta.url))
const host = process.env.PV_FIXTURE_HOST ?? ''

const sha = (rel: string): string =>
  createHash('sha256')
    .update(readFileSync(join(host, rel)))
    .digest('hex')
const release = (
  JSON.parse(readFileSync(join(host, 'manifests', 'compatibility.json'), 'utf8')) as {
    pvRelease: string
  }
).pvRelease

const OVERRIDES = [
  // Present only in the integration job's compose-full-override variant (Story 68-6 AC-11).
  'src/hooks.server.ts',
  'src/routes/(app)/shares/[token]/+page.server.ts',
  'src/routes/(auth)/recovery/+page.svelte',
  'src/routes/(auth)/login/+page.server.ts',
  'src/app.html',
  'static/favicon.png',
]

export default defineUiPack({
  host: { pvRelease: release },
  routes: {
    overrides: OVERRIDES.filter((path) => existsSync(join(pack, path))).map((path) => ({
      path,
      hostSha256: sha(path),
      story: 'FIXTURE-1',
    })),
    remove: ['/status'],
  },
  injections: {
    // Story 68.4 (M3): a component with server data and an action, a later one, a layout point and a
    // head contribution, all at real registry points. HealthTile is imported by the billing page.
    'auth.register.after': [
      {
        component: './injections/Tile.svelte',
        order: 10,
        load: './injections/tile.server.ts',
        actions: './injections/tile.actions.ts',
      },
      { component: './injections/Late.svelte', order: 20 },
    ],
    'auth.layout.before': [{ component: './injections/LayoutNote.svelte' }],
    'shell.head': [{ component: './injections/HeadMeta.svelte' }],
    'dashboard.home.after': [{ component: './injections/HealthTile.svelte', order: 10 }],
  },
  replacements: {
    '$lib/components/shell/Footer.svelte': {
      with: './replacements/Footer.svelte',
      hostSha256: sha('src/lib/components/shell/Footer.svelte'),
    },
    // Story 68.5 AC-12: a wrapped shell component, a wrapped `$lib/api` module and a `$lib/server`
    // module, each reached through `pv-original:`.
    '$lib/components/shell/ShellAccount.svelte': {
      with: './replacements/ShellAccount.svelte',
      hostSha256: sha('src/lib/components/shell/ShellAccount.svelte'),
    },
    '$lib/api/audit.ts': {
      with: './replacements/audit.ts',
      hostSha256: sha('src/lib/api/audit.ts'),
    },
    '$lib/server/require-user.ts': {
      with: './replacements/require-user.ts',
      hostSha256: sha('src/lib/server/require-user.ts'),
    },
  },
  hooks: {
    server: './hooks.server.ts',
    universal: './hooks.universal.ts',
    client: './hooks.client.ts',
  },
  // Story 68-6 (code review): a CM page outside (app) protected on purpose, and a callback-shaped
  // CM route under (app) made reachable anonymously.
  protectedPaths: { add: ['/public-cm'], remove: ['/(app)/cm-area/callback'] },
  // Story 68.7 (M5): the nav delta (every operation; see nav.ts).
  nav: './nav.ts',
  theme: './theme.css',
  messages: './messages',
  // Story 68.9: this pack's guard entries (a declared session-storage carve-out for one CM file).
  guards: './pv-guards.ts',
})
