import { fileURLToPath } from 'node:url'
import { pvReplace } from '@project-vault/composition-kit/vite'
import { vitestConfig } from '@project-vault/web-host/vitest.config'

// Vitest bundles this file into a temporary one, where only import.meta.url is reliable.
const composedRoot = fileURLToPath(new URL('.', import.meta.url))

// Story 68.5 AC-16: the same plugin the build uses, so a unit test that imports a replaced module
// gets the replacement exactly as `vite build` does. Share one plugin list between this file and
// vite.config.ts in a real consumer.
export default vitestConfig({ plugins: [pvReplace({ appRoot: composedRoot })] }, { composedRoot })
