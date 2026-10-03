import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pvComposeDev, pvHooks, pvReplace } from '@project-vault/composition-kit/vite'
import { viteConfig } from '@project-vault/web-host/vite.config'

// Vite bundles this file into a temporary one, where only import.meta.url is reliable.
const appRoot = fileURLToPath(new URL('.', import.meta.url))
const hostDir = dirname(
  createRequire(import.meta.url).resolve('@project-vault/web-host/package.json')
)

// The dev variant also runs the composer in watch mode (the plugin only applies to `vite dev`).
// pvHooks() (Story 68-6) generates the virtual:pv-hooks/* modules from the lock; without it
// web-host's empty provider refuses to build a composed tree.
const dev = process.env.PV_FIXTURE_DEV === '1'
const plugins = [
  pvHooks({ appRoot }),
  ...(dev ? [pvComposeDev({ appRoot, packRoot: process.env.PV_FIXTURE_PACK ?? '', hostDir })] : []),
]

// Story 68.5: `pvReplace()` is listed AFTER PV's own plugins (`sveltekit()` among them), which is
// where `viteConfig` puts a caller's plugins: SvelteKit's import guard must see every import before
// `pvReplace()` answers it, or it cannot walk a client import of a replaced `$lib/server` module back
// to its page and fails with "An impossible situation occurred" instead of its own message. The
// `compose-replace-first-leak` variant lists it first to prove exactly that.
const ours = pvReplace({ appRoot })
const options = { appRoot, composedRoot: appRoot }
const first = process.env.PV_FIXTURE_VARIANT === 'compose-replace-first-leak'
const config = viteConfig({ plugins: first ? plugins : [...plugins, ours] }, options)

export default first ? { ...config, plugins: [ours, ...(config.plugins ?? [])] } : config
