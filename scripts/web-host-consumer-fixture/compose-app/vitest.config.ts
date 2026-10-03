import { fileURLToPath } from 'node:url'
import { pvHooks } from '@project-vault/composition-kit/vite'
import { vitestConfig } from '@project-vault/web-host/vitest.config'

// Vitest bundles this file into a temporary one, where only import.meta.url is reliable.
const composedRoot = fileURLToPath(new URL('.', import.meta.url))

// Story 68-6: the composed tree's tests see the same virtual:pv-hooks/* modules as its build.
export default vitestConfig({ plugins: [pvHooks({ appRoot: composedRoot })] }, { composedRoot })
