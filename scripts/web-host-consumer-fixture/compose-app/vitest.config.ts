import { fileURLToPath } from 'node:url'
import { vitestConfig } from '@project-vault/web-host/vitest.config'

// Vitest bundles this file into a temporary one, where only import.meta.url is reliable.
const composedRoot = fileURLToPath(new URL('.', import.meta.url))

export default vitestConfig({}, { composedRoot })
