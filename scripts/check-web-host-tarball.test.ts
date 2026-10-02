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
import { isTestFile } from './lib/web-host/import-graph.js'
import { packageJsonProblems, packageJsonShape } from './lib/web-host/package-manifest.js'
import {
  droppedSourceFiles,
  forbiddenPathProblems,
  lifecycleProblems,
  missingRequiredEntries,
  monorepoPathProblems,
  privateKeyProblems,
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
  it('rule 1: a leaked test, e2e, coverage or .svelte-kit path fails', () => {
    expect(
      forbiddenPathProblems([
        'src/lib/a.test.ts',
        'src/__tests__/b.ts',
        'e2e/journeys/j1.spec.ts',
        'coverage/lcov.info',
        '.svelte-kit/tsconfig.json',
        'src/lib/paraglide/messages.js',
        'scripts/check-coverage-buffer.ts',
      ])
    ).toHaveLength(8) // the .spec.ts file breaks two rules
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
      kitVersion: null,
      apiImageTag: `ghcr.io/nestormata/project-vault/api:${TEST_VERSION}`,
    })
    expect(paths).toContain('manifests/compatibility.json')
  })

  it('lets 68-3 set kitVersion, and fails on any missing field', () => {
    const manifest = JSON.parse(result.compatibilityManifest) as Record<string, unknown>
    expect(validate({ ...manifest, kitVersion: '0.1.0' })).toBe(true)
    for (const field of Object.keys(manifest)) {
      const { [field]: _dropped, ...rest } = manifest
      expect(validate(rest), field).toBe(false)
    }
  })

  it('packs no empty stub for a manifest a later story has not generated yet', () => {
    expect(paths.filter((path) => path.startsWith('manifests/'))).toEqual([
      'manifests/compatibility.json',
    ])
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
