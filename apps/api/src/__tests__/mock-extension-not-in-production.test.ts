import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Story 14.3 AC-12 edge case (Task 10): the mock external-IdP fixture extension
 * (`@project-vault/mock-sso-extension`) exists purely for CI/manual-QA and must never be
 * referenced by any production env file, deploy manifest, or default `VAULT_EXTENSIONS_PACKAGE`
 * example — this is the "dedicated check" the story's Task 10 explicitly requires.
 */
const MOCK_EXTENSION_PACKAGE_NAME = '@project-vault/mock-sso-extension'
// Story 23.2 Task 10: the second reference fixture extension gets the exact same guard — a
// production deploy must never be able to load either one.
const MOCK_ENVELOPE_EXTENSION_PACKAGE_NAME = '@project-vault/mock-envelope-extension'
const REPO_ROOT = resolve(process.cwd(), '../..')

const PRODUCTION_CONFIG_FILES = [
  '.env.example',
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'apps/api/src/config/env.ts',
]

describe.each([
  ['mock-sso-extension', MOCK_EXTENSION_PACKAGE_NAME, 'fixtures/mock-sso-extension/package.json'],
  [
    'mock-envelope-extension',
    MOCK_ENVELOPE_EXTENSION_PACKAGE_NAME,
    'fixtures/mock-envelope-extension/package.json',
  ],
])(
  '%s is never referenced by production config (AC-12/Story 23.2 AC-15)',
  (_label, packageName, pkgJsonRelPath) => {
    it.each(PRODUCTION_CONFIG_FILES)(
      '%s does not reference the mock extension package',
      (relPath) => {
        const fullPath = resolve(REPO_ROOT, relPath)
        if (!existsSync(fullPath)) return
        const contents = readFileSync(fullPath, 'utf-8')
        expect(contents).not.toContain(packageName)
      }
    )

    it('the fixture package itself is marked private (never publishable/installable in prod)', () => {
      const pkgPath = resolve(REPO_ROOT, pkgJsonRelPath)
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { private?: boolean; name: string }
      expect(pkg.name).toBe(packageName)
      expect(pkg.private).toBe(true)
    })
  }
)
