import { fileURLToPath } from 'node:url'
import { pvHooks, pvNav, pvReplace } from '@project-vault/composition-kit/vite'
import { vitestConfig } from '@project-vault/web-host/vitest.config'

// Vitest bundles this file into a temporary one, where only import.meta.url is reliable.
const composedRoot = fileURLToPath(new URL('.', import.meta.url))

// Story 68-6: the composed tree's tests see the same virtual:pv-hooks/* modules as its build.
// Story 68.5 AC-16: the same plugin the build uses, so a unit test that imports a replaced module
// gets the replacement exactly as `vite build` does. Share one plugin list between this file and
// vite.config.ts in a real consumer.
// Story 68.7: the shipped composed-nav.test.ts validates the pack's real nav delta (virtual:pv-nav).
const plugins = [
  pvHooks({ appRoot: composedRoot }),
  pvNav({ appRoot: composedRoot }),
  pvReplace({ appRoot: composedRoot }),
]
export default vitestConfig({ plugins }, { composedRoot })
