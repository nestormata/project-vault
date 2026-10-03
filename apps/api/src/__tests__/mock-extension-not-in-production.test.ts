import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
// Story 23.3 AC-28: the third reference fixture extension (capability gating) gets the same
// guard as the two above.
const MOCK_CAPABILITY_GATE_EXTENSION_PACKAGE_NAME = '@project-vault/mock-capability-gate-extension'
// Story 23.8 AC-27: the fourth reference fixture extension (audit-event-source) gets the same
// guard as the three above.
const MOCK_AUDIT_EVENT_SOURCE_EXTENSION_PACKAGE_NAME =
  '@project-vault/mock-audit-event-source-extension'
// Story 25.1 Task 7: the fifth reference fixture extension (UI-panel mounting) gets the same
// guard as the four above.
const MOCK_UI_PANEL_EXTENSION_PACKAGE_NAME = '@project-vault/mock-ui-panel-extension'
// Story 68.8 Task 6: the M7 apiRoutes fixture extension gets the same guard as the five above.
const MOCK_API_ROUTES_EXTENSION_PACKAGE_NAME = '@project-vault/mock-api-routes-extension'
// Story 68.10 AC-8: the mock UI pack (its module pack is loaded by the composed mechanism e2e).
const MOCK_UI_PACK_PACKAGE_NAME = '@project-vault/mock-ui-pack'
const MOCK_UI_PACK_FAULT_KEY = 'MOCK_UI_PACK_BOOT_FAULT'
const MOCK_UI_PACK_BUILD_ARG = 'INCLUDE_MOCK_UI_PACK_MODULE'
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
  [
    'mock-capability-gate-extension',
    MOCK_CAPABILITY_GATE_EXTENSION_PACKAGE_NAME,
    'fixtures/mock-capability-gate-extension/package.json',
  ],
  [
    'mock-audit-event-source-extension',
    MOCK_AUDIT_EVENT_SOURCE_EXTENSION_PACKAGE_NAME,
    'fixtures/mock-audit-event-source-extension/package.json',
  ],
  [
    'mock-ui-panel-extension',
    MOCK_UI_PANEL_EXTENSION_PACKAGE_NAME,
    'fixtures/mock-ui-panel-extension/package.json',
  ],
  [
    'mock-api-routes-extension',
    MOCK_API_ROUTES_EXTENSION_PACKAGE_NAME,
    'fixtures/mock-api-routes-extension/package.json',
  ],
  ['mock-ui-pack', MOCK_UI_PACK_PACKAGE_NAME, 'fixtures/mock-ui-pack/package.json'],
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

/** Production-reachable configuration: root deploy manifests, every Fly config and Dockerfile. */
function deployFiles(): string[] {
  const root = readdirSync(REPO_ROOT).filter(
    (name) => /^fly.*\.toml$/.test(name) || /^docker-compose.*\.yml$/.test(name)
  )
  return [...root, ...PRODUCTION_CONFIG_FILES, 'apps/api/Dockerfile', 'apps/web/Dockerfile']
}

function sourceFiles(dir: string): string[] {
  const full = resolve(REPO_ROOT, dir)
  if (!existsSync(full)) return []
  return readdirSync(full).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return []
    const child = `${dir}/${entry}`
    return statSync(resolve(REPO_ROOT, child)).isDirectory() ? sourceFiles(child) : [child]
  })
}

describe('mock-ui-pack stays out of production (Story 68.10 AC-8.1)', () => {
  const MOCK_ONLY = ['docker-compose.mock-ui-pack.yml', 'docker-compose.mock-ui-pack.yaml']
  const PRODUCTION_DEPLOY = deployFiles().filter((file) => !MOCK_ONLY.includes(file))
  const NOT_E2E_OVERRIDE = PRODUCTION_DEPLOY.filter((file) => file !== 'docker-compose.e2e.yml')

  // Dockerfiles legitimately name the package (the opt-in install steps), so for them only the
  // build arg being switched on is checked.
  const NAMING_FILES = NOT_E2E_OVERRIDE.filter((file) => !file.endsWith('Dockerfile'))

  it.each(NAMING_FILES)('%s does not reference the package', (file) => {
    const fullPath = resolve(REPO_ROOT, file)
    if (!existsSync(fullPath)) return
    expect(readFileSync(fullPath, 'utf-8'), file).not.toContain(MOCK_UI_PACK_PACKAGE_NAME)
  })

  it.each(NOT_E2E_OVERRIDE)('%s never switches the opt-in build arg on', (file) => {
    const fullPath = resolve(REPO_ROOT, file)
    if (!existsSync(fullPath)) return
    const enabled = new RegExp(`${MOCK_UI_PACK_BUILD_ARG}\\s*[:=]\\s*['"]?true`)
    expect(readFileSync(fullPath, 'utf-8'), file).not.toMatch(enabled)
  })

  it('the opt-in build arg defaults to false in every Dockerfile that declares it', () => {
    const dockerfiles = ['apps/api/Dockerfile', 'apps/web/Dockerfile', 'Dockerfile.ci']
    const declared = dockerfiles.flatMap((file) =>
      [
        ...readFileSync(resolve(REPO_ROOT, file), 'utf-8').matchAll(
          /^ARG (INCLUDE_MOCK_UI_PACK_MODULE)(=.*)?$/gm
        ),
      ].map((match) => `${file}: ${match[0]}`)
    )
    expect(declared.length).toBeGreaterThan(0)
    for (const line of declared) expect(line, line).toMatch(/INCLUDE_MOCK_UI_PACK_MODULE=false$/)
  })

  it('the boot-fault knob appears only in the compose override and the pack own source', () => {
    const scanned = [
      ...PRODUCTION_DEPLOY,
      ...sourceFiles('apps/api/src').filter(
        (file) => !file.includes('mock-extension-not-in-production')
      ),
      ...sourceFiles('apps/web/src'),
      ...sourceFiles('packages'),
      ...sourceFiles('scripts').filter((file) => !file.includes('mock-ui-pack')),
    ]
    const holders = scanned.filter((file) => {
      const full = resolve(REPO_ROOT, file)
      return existsSync(full) && readFileSync(full, 'utf-8').includes(MOCK_UI_PACK_FAULT_KEY)
    })
    expect(holders).toEqual([])
  })
})
