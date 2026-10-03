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
    'project.detail.tiles': [{ component: './injections/HealthTile.svelte', order: 10 }],
  },
  replacements: {
    '$lib/components/shell/Footer.svelte': {
      with: './replacements/Footer.svelte',
      hostSha256: sha('src/lib/components/shell/Footer.svelte'),
    },
  },
  hooks: {
    server: './hooks.server.ts',
    universal: './hooks.universal.ts',
    client: './hooks.client.ts',
  },
  theme: './theme.css',
  messages: './messages',
})
