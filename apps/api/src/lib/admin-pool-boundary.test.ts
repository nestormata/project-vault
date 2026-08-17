import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })
}

const importerAllowlist = new Set([
  'modules/auth/domain-lookup-routes.ts',
  'modules/auth/recovery-lookup.ts',
  'modules/auth/sso-routes.ts',
  'modules/compliance/erasure-lookup.ts',
  'modules/compliance/erasure-service.ts',
  'modules/credential-shares/external-service.ts',
  'modules/invitations/lookup.ts',
  'modules/machine-users/token-exchange-lookup.ts',
  'modules/monitoring/status-page-service.ts',
  'modules/org/pseudonymize.ts',
  'modules/platform-admin/service.ts',
  'modules/rotation/metrics.ts',
  'modules/status/token-store.ts',
  'workers/audit-org-usage-reconcile.ts',
  'workers/audit-storage-check.ts',
  'workers/import-cleanup.ts',
  'workers/notification-inbox-purge.ts',
])

describe('admin pool boundary drift guards', () => {
  it('keeps getAdminDb importers on the reviewed allowlist', () => {
    const actual = new Set<string>()
    for (const path of sourceFiles(srcRoot)) {
      const source = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      if (/import\s*\{[^}]*\bgetAdminDb\b[^}]*\}\s*from\s*['"][^'"]+['"]/s.test(source)) {
        actual.add(relative(srcRoot, path))
      }
    }
    expect(actual).toEqual(importerAllowlist)
  })

  it('does not create a second admin pool from the validated credential', () => {
    const forbidden = [] as string[]
    for (const path of sourceFiles(srcRoot)) {
      const file = relative(srcRoot, path)
      if (file === 'lib/db.ts' || file === 'config/env.ts' || file.startsWith('__tests__/'))
        continue
      const source = readFileSync(path, 'utf8')
      if (
        /process\.env(?:\[['"]ADMIN_DATABASE_URL['"]\]|\.ADMIN_DATABASE_URL)|env\.ADMIN_DATABASE_URL/.test(
          source
        )
      ) {
        forbidden.push(file)
      }
    }
    expect(forbidden).toEqual([])
  })
})
