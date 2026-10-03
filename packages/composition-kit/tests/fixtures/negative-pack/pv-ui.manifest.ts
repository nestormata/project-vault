// The server-only guard proof (Story 68.3 AC-5). `server/store.ts` is materialized under
// src/lib/server/_cm, so Kit's own guard must reject a client page that imports it, while the same
// import from a +page.server.ts must build. The leak route exists only in the "leak" variant.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineUiPack } from '@project-vault/composition-kit'

const host = process.env.PV_FIXTURE_HOST ?? ''
const release = (
  JSON.parse(readFileSync(join(host, 'manifests', 'compatibility.json'), 'utf8')) as {
    pvRelease: string
  }
).pvRelease

export default defineUiPack({
  host: { pvRelease: release },
  hooks: { server: './server/store.ts' },
})
