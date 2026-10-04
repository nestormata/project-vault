import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Story 68.10 AC-8.1: the mock UI pack and its boot-fault knob never reach production. (Lives under
// scripts/ beside the other repository-text guards: apps/api's `tsc` build, which also runs inside the
// Docker image, has no `import.meta.glob` types.) The repository text it reads is loaded through Vite,
// so no test code builds a dynamic filesystem path.
const MOCK_UI_PACK_PACKAGE_NAME = '@project-vault/mock-ui-pack'
const MOCK_UI_PACK_FAULT_KEY = 'MOCK_UI_PACK_BOOT_FAULT'
const MOCK_UI_PACK_BUILD_ARG = 'INCLUDE_MOCK_UI_PACK_MODULE'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The repository-relative path of a glob key (Vite spells keys relative to this file). */
const repoPath = (key: string): string =>
  relative(ROOT, fileURLToPath(new URL(key, import.meta.url)))
    .split(sep)
    .join('/')

const DEPLOY_TEXT = new Map(
  Object.entries(
    import.meta.glob(
      [
        '../fly*.toml',
        '../docker-compose*.yml',
        '../.env.example',
        '../apps/api/src/config/env.ts',
        '../apps/api/Dockerfile',
        '../apps/web/Dockerfile',
        '../Dockerfile.ci',
      ],
      { query: '?raw', import: 'default', eager: true }
    )
  ).map(([key, text]) => [repoPath(key), String(text)] as const)
)

// Every source file the fault knob must stay out of (lazy: loaded only by the one test that scans).
const SCANNED_SOURCES = import.meta.glob(
  [
    '../apps/api/src/**/*',
    '../apps/web/src/**/*',
    '../packages/**/*',
    '../scripts/**/*',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/coverage/**',
    '!**/.svelte-kit/**',
    '!**/.turbo/**',
  ],
  { query: '?raw', import: 'default' }
)

describe('mock-ui-pack stays out of production (Story 68.10 AC-8.1)', () => {
  const MOCK_ONLY = ['docker-compose.mock-ui-pack.yml', 'docker-compose.mock-ui-pack.yaml']
  const PRODUCTION_DEPLOY = [...DEPLOY_TEXT.keys()].filter((file) => !MOCK_ONLY.includes(file))
  const NOT_E2E_OVERRIDE = PRODUCTION_DEPLOY.filter((file) => file !== 'docker-compose.e2e.yml')
  const textOf = (file: string): string => DEPLOY_TEXT.get(file) ?? ''

  // Dockerfiles legitimately name the package (the opt-in install steps), so for them only the
  // build arg being switched on is checked.
  const NAMING_FILES = NOT_E2E_OVERRIDE.filter((file) => !file.endsWith('Dockerfile'))

  it('reads the production configuration it claims to guard', () => {
    for (const file of [
      'docker-compose.yml',
      'docker-compose.prod.yml',
      '.env.example',
      'apps/api/Dockerfile',
      'apps/web/Dockerfile',
      'Dockerfile.ci',
    ]) {
      expect(DEPLOY_TEXT.has(file), `${file} is not loaded`).toBe(true)
    }
    expect([...DEPLOY_TEXT.keys()].some((file) => /^fly.*\.toml$/.test(file))).toBe(true)
  })

  it.each(NAMING_FILES)('%s does not reference the package', (file) => {
    expect(textOf(file), file).not.toContain(MOCK_UI_PACK_PACKAGE_NAME)
  })

  it.each(NOT_E2E_OVERRIDE)('%s never switches the opt-in build arg on', (file) => {
    const enabled = /INCLUDE_MOCK_UI_PACK_MODULE\s*[:=]\s*['"]?true/
    expect(textOf(file), file).not.toMatch(enabled)
  })

  it('the opt-in build arg defaults to false in every Dockerfile that declares it', () => {
    const dockerfiles = ['apps/api/Dockerfile', 'apps/web/Dockerfile', 'Dockerfile.ci']
    const declared = dockerfiles.flatMap((file) =>
      textOf(file)
        .split('\n')
        .filter((line) => line.startsWith(`ARG ${MOCK_UI_PACK_BUILD_ARG}`))
        .map((line) => `${file}: ${line}`)
    )
    expect(declared.length).toBeGreaterThan(0)
    for (const line of declared) expect(line, line).toMatch(/INCLUDE_MOCK_UI_PACK_MODULE=false$/)
  })

  it('the boot-fault knob appears only in the compose override and the pack own source', async () => {
    const sources = Object.entries(SCANNED_SOURCES)
      .map(([key, load]) => [repoPath(key), load] as const)
      .filter(
        ([file]) =>
          !file.includes('mock-extension-not-in-production') &&
          // the pack's own runtime, tests and runners, and the test that pins the override
          !file.includes('mock-ui-pack') &&
          file !== 'scripts/e2e-stack.test.ts'
      )
    expect(sources.length).toBeGreaterThan(1000)
    const holders = (
      await Promise.all(sources.map(async ([file, load]) => [file, String(await load())] as const))
    )
      .filter(([, text]) => text.includes(MOCK_UI_PACK_FAULT_KEY))
      .map(([file]) => file)
    const deployHolders = PRODUCTION_DEPLOY.filter((file) =>
      textOf(file).includes(MOCK_UI_PACK_FAULT_KEY)
    )
    expect([...holders, ...deployHolders]).toEqual([])
  })
})
