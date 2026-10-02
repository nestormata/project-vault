// The repository root has no YAML dependency of its own (Story 68.2 Task 5.2: prefer an existing
// workspace dependency over a new root one); reuse the `yaml` package apps/api already depends on.
// Anchored on this file's location, never on process.cwd(), so it works from any working directory.
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireFromApi = createRequire(join(import.meta.dirname, '..', '..', 'apps/api/package.json'))

export const { parse: parseYaml } = requireFromApi('yaml') as typeof import('yaml')
