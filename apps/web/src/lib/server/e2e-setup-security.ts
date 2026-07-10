import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export function generateE2EVaultPassphrase(): string {
  return randomBytes(24).toString('base64url')
}

export function buildMigrationInvocation(): {
  executable: string
  args: [string, string]
} {
  const require = createRequire(import.meta.url)
  return {
    executable: process.execPath,
    args: [
      require.resolve('tsx/cli'),
      fileURLToPath(
        new URL('../../../../../packages/db/src/scripts/guarded-migrate.ts', import.meta.url)
      ),
    ],
  }
}
