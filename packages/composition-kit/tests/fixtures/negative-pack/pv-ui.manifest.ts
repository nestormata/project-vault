// The server-only guard proof (Story 68.3 AC-5, 68.5 AC-4). `server/store.ts` is materialized under
// src/lib/server/_cm, so Kit's own guard must reject a client page that imports it, while the same
// import from a +page.server.ts must build. Story 68.5: the same holds for a REPLACED `$lib/server`
// module (`server/require-user.ts`, materialized under src/lib/server/_cm too): a client import of
// PV's own specifier for it must fail, naming the `_cm` path, and a server import must build. The
// leak routes exist only in their own variants.
import { createHash } from 'node:crypto'
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
  replacements: {
    '$lib/server/require-user.ts': {
      with: './server/require-user.ts',
      hostSha256: createHash('sha256')
        .update(readFileSync(join(host, 'src/lib/server/require-user.ts')))
        .digest('hex'),
    },
  },
})
