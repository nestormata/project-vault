import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openAsBlob, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  REPO_ROOT,
  STAGE_DIR,
  computeDependencies,
  npmCli,
  packWebHost,
  type PackResult,
} from './pack-web-host.js'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { readComponentIndex } from './lib/web-host/component-index.js'
import { isTestFile } from './lib/web-host/import-graph.js'
import { packageJsonProblems, packageJsonShape } from './lib/web-host/package-manifest.js'
import {
  droppedSourceFiles,
  forbiddenPathProblems,
  lifecycleProblems,
  missingRequiredEntries,
  monorepoPathProblems,
  privateKeyProblems,
  shippedTestProblems,
} from './lib/web-host/tarball-rules.js'
import { trustedGit } from './lib/trusted-executable.js'

// Story 68.2 AC-2/AC-4/AC-6/AC-7/AC-9: pack @project-vault/web-host from this checkout and assert
// the tarball's exact content rules. Every assertion reads `npm pack --dry-run --json` of the
// staged directory (what npm would actually publish, after npm-packlist's own ignore handling),
// never the source tree, except the anti-narrowing comparison, which needs both.

// Static anchor (a local constant, unlike the imported REPO_ROOT) for the files read below.
const repositoryRoot = join(import.meta.dirname, '..')
const MANIFEST = 'package.json'
const VENDOR_PREFIX = 'vendor/shared/src/'
// The release workflow packs at the tag's version; locally and in PR CI a prerelease exercises AC-9's edge.
const TEST_VERSION = process.env.WEB_HOST_PACK_VERSION ?? '1.4.0-rc.1'
// Story 68.3 AC-1/AC-10: the tuple names the kit version the repository's own kit package.json carries.
const KIT_VERSION = (
  JSON.parse(
    readFileSync(join(repositoryRoot, 'packages', 'composition-kit', MANIFEST), 'utf8')
  ) as { version: string }
).version
const PACK_TIMEOUT_MS = 180_000

interface PackListing {
  files: { path: string }[]
  entryCount: number
  size: number
}

const sha256 = (bytes: ArrayBuffer): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex')

async function fileBytes(path: string): Promise<ArrayBuffer> {
  return (await openAsBlob(path)).arrayBuffer()
}

async function fileText(path: string): Promise<string> {
  return (await openAsBlob(path)).text()
}

const TEXT_FILE_RE = /\.(ts|js|svelte|css|html|json|md|txt|svg|d\.ts)$|(^|\/)LICENSE[^/]*$/

let result: PackResult
let listing: PackListing
let paths: string[]

beforeAll(async () => {
  result = await packWebHost({
    version: TEST_VERSION,
    repository: 'nestormata/project-vault',
    log: () => undefined,
  })
  const output = execFileSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json'], {
    cwd: STAGE_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  listing = (JSON.parse(output) as PackListing[])[0] as PackListing
  paths = listing.files.map((file) => file.path).sort((a, b) => a.localeCompare(b))
}, PACK_TIMEOUT_MS)

describe('web-host tarball rules: self-tests on mutated listings (Story 68.2 AC-7)', () => {
  it('rule 1: a misplaced test, e2e, coverage or .svelte-kit path fails', () => {
    expect(forbiddenPathProblems(['src/lib/a.test.ts'])).toEqual([])
    expect(
      forbiddenPathProblems([
        'config/a.test.js',
        'vendor/shared/src/b.test.ts',
        'src/__tests__/b.ts',
        'e2e/journeys/j1.spec.ts',
        'coverage/lcov.info',
        '.svelte-kit/tsconfig.json',
        'src/lib/paraglide/messages.js',
        'scripts/check-coverage-buffer.ts',
      ])
    ).toHaveLength(9) // the .spec.ts file breaks two rules
  })

  it('rule 1 (Nestor 2026-10-02): the shipped unit tests are exactly the self-contained ones', () => {
    const [a, b] = ['src/a.test.ts', 'src/b.test.ts']
    const selfContained = [a, b]
    expect(shippedTestProblems([a, b, 'src/x.ts'], selfContained)).toEqual([])
    expect(shippedTestProblems([a, 'src/c.test.ts'], selfContained)).toEqual([
      'src/c.test.ts ships but is not a self-contained test',
      'src/b.test.ts is a self-contained test but is not in the tarball',
    ])
  })

  it('rule 2: a missing README or vendored shared index fails', () => {
    expect(missingRequiredEntries([MANIFEST])).toContain('missing required entry README.md')
    expect(missingRequiredEntries([MANIFEST])).toContain(
      'missing required entry vendor/shared/src/index.ts'
    )
  })

  it('rule 3: a tracked source file the pack filtered out fails (anti-narrowing)', () => {
    expect(droppedSourceFiles(['src/lib/foo/bar.ts', 'src/app.html'], ['src/app.html'])).toEqual([
      'src/lib/foo/bar.ts is tracked PV source but is not in the tarball',
    ])
  })

  it('rule 4: ../../ in code fails, ../../ in a comment does not', () => {
    const files = new Map([
      ['config/a.js', "const x = '../../packages/shared/src/index.ts'"],
      ['config/b.js', '// see ../../packages/shared for history\nconst y = 1'],
      ['src/app.css', '/* was ../../../packages */\n@source "../vendor/shared/src/**/*.ts";'],
      ['src/bad.css', '@source "../../../packages/shared/src/**/*.ts";'],
    ])
    expect(monorepoPathProblems(files)).toEqual([
      'config/a.js contains a ../../ path into the monorepo',
      'src/bad.css contains a ../../ path into the monorepo',
    ])
  })

  it('rule 6: secret-shaped paths, PEM private keys and install hooks fail', () => {
    for (const path of [
      '.env',
      'src/.env.production',
      'static/cert.pem',
      'id_ed25519',
      'acme.json',
      'credentials.json',
      '.npmrc',
    ]) {
      expect(forbiddenPathProblems([path]), path).toHaveLength(1)
    }
    const pem = ['-----BEGIN', 'EC PRIVATE KEY-----\nabc'].join(' ')
    expect(privateKeyProblems(new Map([['src/k.ts', pem]]))).toHaveLength(1)
    expect(lifecycleProblems({ scripts: { postinstall: 'node x' }, bin: 'x' })).toEqual([
      'package.json declares bin',
      'package.json declares a postinstall script',
    ])
  })

  it('AC-2 failure example 2: an import missing from the lockfile fails, naming file and package', () => {
    const problems: string[] = []
    computeDependencies(
      {
        webBareImports: new Map([['left-pad', [join(REPO_ROOT, 'apps/web/src/lib/pad.ts')]]]),
        sharedBareImports: new Map(),
        webLocked: new Map(),
        sharedLocked: new Map(),
        extensionApi: '3.25.0',
      },
      problems
    )
    expect(problems).toContain(
      'apps/web/src/lib/pad.ts imports left-pad, which is not resolved in pnpm-lock.yaml for apps/web'
    )
  })
})

describe('web-host tarball: this checkout (Story 68.2 AC-7)', () => {
  it('rule 1/6: ships no test, generated, tooling or secret-shaped path', () => {
    expect(paths.length).toBeGreaterThan(300)
    expect(forbiddenPathProblems(paths)).toEqual([])
  })

  it('rule 2: contains every required entry', () => {
    expect(missingRequiredEntries(paths)).toEqual([])
  })

  it('rule 1: ships exactly the self-contained unit tests and excludes the cross-package ones', () => {
    const selfContained = result.shippedTests.map((file) => file.slice('apps/web/'.length))
    expect(selfContained.length).toBeGreaterThan(200)
    expect(shippedTestProblems(paths, selfContained)).toEqual([])
    const excluded = new Map(result.excludedTests.map((entry) => [entry.file, entry.reasons]))
    // The story's known cross-package tests, each excluded by a structural rule (not by name).
    for (const file of [
      'apps/web/src/lib/platform/cli-version-policy-view.test.ts',
      'apps/web/src/lib/server/e2e-global-setup-security.test.ts',
      'apps/web/src/tailwind-source-boundary.test.ts',
    ]) {
      expect(excluded.get(file)?.join(' '), file).toMatch(/outside the package/)
    }
    // The PV-tree-only route snapshot oracle is excluded with its reason, never shipped.
    expect(excluded.get('apps/web/src/routes/route-render-snapshot.test.ts')).toEqual([
      "oracle of PV's own un-composed markup; valid only on PV's tree",
    ])
    for (const reasons of excluded.values()) expect(reasons.length).toBeGreaterThan(0)
  })

  it('rule 3: every tracked non-test file under src/ and static/ ships (never a curated subset)', () => {
    const tracked = trustedGit(REPO_ROOT, [
      'ls-files',
      '-z',
      '--',
      'apps/web/src',
      'apps/web/static',
    ])
      .split('\0')
      .filter((path) => path !== '' && !isTestFile(path))
      .map((path) => path.slice('apps/web/'.length))
    expect(tracked.length).toBeGreaterThan(300)
    // Every tracked test is either shipped or excluded with a reason: none silently dropped.
    const testsTracked = trustedGit(REPO_ROOT, ['ls-files', '-z', '--', 'apps/web/src'])
      .split('\0')
      .filter((path) => path !== '' && isTestFile(path))
    const accounted = [...result.shippedTests, ...result.excludedTests.map((entry) => entry.file)]
    expect(accounted.sort()).toEqual(testsTracked.sort())
    expect(droppedSourceFiles(tracked, paths)).toEqual([])
  })

  it('rule 4/6: no ../../ outside comments in configs or app.css, and no private key material', async () => {
    const configFiles = paths.filter((path) => path.startsWith('config/') || path === 'src/app.css')
    const configs = new Map(
      await Promise.all(
        configFiles.map(async (path) => [path, await fileText(join(STAGE_DIR, path))] as const)
      )
    )
    expect(configs.size).toBeGreaterThanOrEqual(5)
    expect(monorepoPathProblems(configs)).toEqual([])
    const texts = new Map(
      await Promise.all(
        paths
          .filter((path) => TEXT_FILE_RE.test(path))
          .map(async (path) => [path, await fileText(join(STAGE_DIR, path))] as const)
      )
    )
    expect(privateKeyProblems(texts)).toEqual([])
  })

  it('rule 5/6: the generated package.json passes AC-2/AC-6 and has no install hook', async () => {
    expect(packageJsonProblems(result.packageJson)).toEqual([])
    expect(lifecycleProblems(result.packageJson)).toEqual([])
    const shipped = JSON.parse(await fileText(join(STAGE_DIR, MANIFEST))) as Record<string, unknown>
    expect(shipped).toEqual(result.packageJson)
  })
})

describe('web-host inlang project (Story 68.2 AC-5)', () => {
  it('loads every plugin from a copy inside the tarball, never from PV node_modules or a URL', async () => {
    const settings = JSON.parse(
      await fileText(join(STAGE_DIR, 'project.inlang', 'settings.json'))
    ) as { modules: string[] }
    expect(settings.modules.length).toBeGreaterThan(0)
    for (const module of settings.modules) {
      expect(module, module).toMatch(/^\.\/inlang-plugins\//)
      expect(paths).toContain(module.slice(2))
    }
  })
})

describe('web-host package.json (Story 68.2 AC-2/AC-6)', () => {
  it('matches the committed golden shape (keys and sources, not versions)', () => {
    const golden = JSON.parse(
      readFileSync(join(repositoryRoot, 'scripts', 'web-host-package.shape.json'), 'utf8')
    ) as unknown
    expect(packageJsonShape(result.packageJson)).toEqual(golden)
  })

  it('pins the toolchain peers to the lockfile versions and computes the runtime dependency set', () => {
    const peers = result.packageJson.peerDependencies as Record<string, string>
    const dependencies = result.packageJson.dependencies as Record<string, string>
    const toolchain = ['svelte', 'vite', '@sveltejs/kit', 'typescript', 'tailwindcss']
    const pinned = Object.entries(peers).filter(([name]) => toolchain.includes(name))
    expect(pinned).toHaveLength(toolchain.length)
    for (const [name, version] of pinned) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Object.keys(dependencies)).toEqual(
      expect.arrayContaining([
        '@inlang/paraglide-js',
        '@project-vault/extension-api',
        'dompurify',
        'undici',
        'zod',
        '@zxcvbn-ts/core',
        '@zxcvbn-ts/language-common',
        '@zxcvbn-ts/language-en',
        'cron-parser',
      ])
    )
    expect(dependencies).not.toHaveProperty(['@project-vault/shared'])
  })
})

describe('vendored @project-vault/shared (Story 68.2 AC-4)', () => {
  it('ships exactly the import-graph files, none of them tests', () => {
    const vendored = paths.filter((path) => path.startsWith(VENDOR_PREFIX))
    const expected = result.vendoredSharedFiles.map((file) =>
      file.replace('packages/shared/src/', VENDOR_PREFIX)
    )
    expect(vendored.sort()).toEqual(expected.sort())
    expect(vendored.filter(isTestFile)).toEqual([])
    expect(vendored).toContain('vendor/shared/src/node/test-pki-test-helpers.ts')
  })

  it('is byte-identical to the workspace source (sha256 of both trees)', async () => {
    for (const file of result.vendoredSharedFiles) {
      const vendoredPath = join(STAGE_DIR, file.replace('packages/shared/src/', VENDOR_PREFIX))
      expect(sha256(await fileBytes(vendoredPath)), file).toBe(
        sha256(await fileBytes(join(REPO_ROOT, file)))
      )
    }
  })
})

describe('compatibility manifest (Story 68.2 AC-9)', () => {
  const requireAjv = createRequire(
    join(REPO_ROOT, 'packages', 'api-contract-tests', 'package.json')
  )
  const Ajv = requireAjv('ajv') as typeof import('ajv').default
  const schema = JSON.parse(
    readFileSync(join(repositoryRoot, 'scripts', 'web-host-compat-manifest.schema.json'), 'utf8')
  ) as object
  const validate = new Ajv({ allErrors: true }).compile(schema)

  it('validates against the committed schema and carries the prerelease version everywhere', () => {
    const manifest = JSON.parse(result.compatibilityManifest) as Record<string, unknown>
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true)
    expect(manifest).toMatchObject({
      pvRelease: TEST_VERSION,
      kitVersion: KIT_VERSION,
      apiImageTag: `ghcr.io/nestormata/project-vault/api:${TEST_VERSION}`,
    })
    expect(paths).toContain('manifests/compatibility.json')
  })

  it('requires kitVersion as an exact version string (Story 68.3), and fails on any missing field', () => {
    const manifest = JSON.parse(result.compatibilityManifest) as Record<string, unknown>
    expect(validate({ ...manifest, kitVersion: null })).toBe(false)
    expect(validate({ ...manifest, kitVersion: '^0.1.0' })).toBe(false)
    expect(validate({ ...manifest, kitVersion: '0.1.0' })).toBe(true)
    for (const field of Object.keys(manifest)) {
      const { [field]: _dropped, ...rest } = manifest
      expect(validate(rest), field).toBe(false)
    }
  })

  it('packs only the manifests generated so far, never an empty stub for a later one', () => {
    // component-index.json (Story 68.5), injection-points.json (Story 68-4) and hooks-surface.json
    // (Story 68.6) are generated on every pack; nav-ids.json (68-7) is not, and a missing one is
    // never stubbed.
    expect(paths.filter((path) => path.startsWith('manifests/')).sort()).toEqual([
      'manifests/compatibility.json',
      'manifests/component-index.json',
      'manifests/guards.json',
      'manifests/hooks-surface.json',
      'manifests/injection-points.json',
      'manifests/test-subjects.json',
    ])
  })

  // Story 68.9 AC-1/AC-10: the guard registry and the test-subject map are generated from the guard
  // markers and the shipped tests, and every file they name is in the tarball.
  interface PackedGuard {
    id: string
    kind: string
    file: string
    scope: string
    license: string
    closure: { file: string; sha256: string }[]
    subjects?: string[]
    subjectClosure?: string[]
  }

  async function packedGuards(): Promise<{ schemaVersion: number; guards: PackedGuard[] }> {
    return JSON.parse(await fileText(join(STAGE_DIR, 'manifests', 'guards.json'))) as {
      schemaVersion: number
      guards: PackedGuard[]
    }
  }

  it('ships a guard registry whose files and closure files are all in the tarball (Story 68.9 AC-1)', async () => {
    const registry = await packedGuards()
    expect(registry.schemaVersion).toBe(1)
    expect(registry.guards.map((guard) => guard.id)).toEqual([
      'form-guidance',
      'form-secret-inputs',
      'internal-api-choke-point',
      'route-exists',
      'static-hardening',
      'tailwind-boundary',
    ])
    for (const guard of registry.guards) {
      expect(paths, guard.id).toContain(guard.file)
      expect(guard.scope, guard.id).toBe('all-files')
      expect(guard.license).toBe('AGPL-3.0-or-later')
    }
    for (const entry of registry.guards.flatMap((guard) => guard.closure)) {
      expect(paths, entry.file).toContain(entry.file)
      expect(entry.sha256).toBe(sha256(await fileBytes(join(STAGE_DIR, entry.file))))
    }
  })

  it('names a guard subject apart from its pristine helpers, and every subject file ships (Story 68.9 Q3)', async () => {
    const hardening = (await packedGuards()).guards.find((guard) => guard.id === 'static-hardening')
    expect(hardening?.closure.map((entry) => entry.file)).toContain('src/lib/test/guard-root.ts')
    // hardening.ts is a SUBJECT of the guard (its header assertion), not guard machinery: it is
    // staged from the composed app, so it is named separately and never hash-pinned.
    expect(hardening?.closure.map((entry) => entry.file)).not.toContain(
      'src/lib/security/hardening.ts'
    )
    expect(hardening?.subjects).toEqual(['src/lib/security/hardening.ts'])
    for (const file of [...(hardening?.subjects ?? []), ...(hardening?.subjectClosure ?? [])]) {
      expect(paths, file).toContain(file)
    }
  })

  it('ships a test-subject map that names only shipped source files (Story 68.9 AC-10)', async () => {
    const { schemaVersion, subjects } = JSON.parse(
      await fileText(join(STAGE_DIR, 'manifests', 'test-subjects.json'))
    ) as { schemaVersion: number; subjects: Record<string, string[]> }
    expect(schemaVersion).toBe(1)
    expect(Object.keys(subjects).length).toBeGreaterThan(50)
    for (const [test, list] of Object.entries(subjects)) {
      expect(paths, test).toContain(test)
      for (const subject of list) {
        expect(paths, `${test} -> ${subject}`).toContain(subject)
        expect(isTestFile(subject), subject).toBe(false)
        expect(subject.startsWith('src/lib/test/'), subject).toBe(false)
      }
    }
    expect(subjects['src/lib/security/static-hardening.test.ts']).toBeUndefined()
  })

  it('packs hooks-surface.json from PV HOOK_SURFACE and protected prefixes (Story 68.6 AC-12)', async () => {
    const surface = JSON.parse(
      await fileText(join(STAGE_DIR, 'manifests', 'hooks-surface.json'))
    ) as Record<string, unknown>
    expect(surface).toMatchObject({
      schemaVersion: 1,
      headerPolicy: true,
      protectedPaths: true,
      universal: ['reroute', 'transport'],
    })
    expect(surface.protectedPrefixes).toContain('/extensions/panels')
  })

  it('ships a parsable component-index.json that lists real shell components (Story 68.5 AC-9)', async () => {
    const index = readComponentIndex(
      await fileText(join(STAGE_DIR, 'manifests', 'component-index.json'))
    )
    expect(index).not.toBeNull()
    const byPath = new Map((index?.components ?? []).map((entry) => [entry.path, entry]))
    const search = byPath.get('src/lib/components/shell/GlobalSearch.svelte')
    expect(search?.stability).toBe('stable')
    expect(byPath.get('src/lib/components/shell/ShellAccount.svelte')?.stability).toBe('stable')
    expect(byPath.get('src/lib/components/shell/Footer.svelte')?.stability).toBe('unmarked')
    expect(byPath.get('src/lib/server/require-user.ts')).toBeDefined()
    expect(byPath.get('src/lib/api/audit.ts')).toBeDefined()
    // hash equals the sha256 of the shipped file's raw bytes (what a pack author puts in hostSha256)
    expect(search?.hash).toBe(
      sha256(await fileBytes(join(STAGE_DIR, 'src/lib/components/shell/GlobalSearch.svelte')))
    )
    for (const path of byPath.keys()) {
      expect(isTestFile(path), path).toBe(false)
      expect(path.startsWith('src/routes/'), path).toBe(false)
    }
  })
})

describe('web-host pack: CI wiring (Story 68.2 AC-10)', () => {
  it('runs the tarball test in ci.yml and in make ci-inner', () => {
    const command = 'pnpm vitest run scripts/check-web-host-tarball.test.ts'
    const ci = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(workflowRunCommands(ci).some((run) => run.includes(command))).toBe(true)
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), command)).toBe(true)
  })
})
