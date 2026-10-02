#!/usr/bin/env tsx
/**
 * Story 68.2: assemble the publishable @project-vault/web-host package in .web-host-pack/
 * (gitignored, rebuilt from scratch on every run, never incrementally).
 *
 *   pnpm pack:web-host [--version 1.4.0] [--repository owner/repo] [--tarball <dir>]
 *
 * The staged package ships PV's WHOLE tracked src/ and static/ (minus test files), messages, the
 * inlang project and its vendored plugin, @project-vault/shared's source vendored byte for byte,
 * the compiled config factories, the compatibility manifest, LICENSE and README, plus a generated
 * package.json whose versions are exact and read from pnpm-lock.yaml. It never narrows what a
 * composer may override (ADR 0007 M1-M7): the only exclusions are tests, generated output and dev
 * tooling. Any packaging error (lockfile drift, an unresolvable or test-only import, a vendored
 * file reaching outside packages/shared/src, a symlink, a version-triangle mismatch) fails the pack.
 *
 * `--version` defaults to 0.0.0-dev. A release passes the PV tag's version (vX.Y.Z -> X.Y.Z), the
 * single source of the PV release version (the same one cli-release.yml and container-publish.yml
 * use; the root package.json version is a 0.0.1 placeholder).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  globSync,
  mkdirSync,
  openAsBlob,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_RELEASE_REPOSITORY, releaseImageRef } from './lib/release-image.js'
import { resolveBin, trustedGit } from './lib/trusted-executable.js'
import { extensionApiVersion } from './lib/version-triangle.js'
import {
  compareCodeUnits,
  isTestFile,
  isTestSupportFile,
  relativePosix,
  sysReadFile,
  walkImportGraph,
  type GraphResolver,
} from './lib/web-host/import-graph.js'
import {
  packedSettings,
  type InlangSettings,
  type PluginLock,
} from './lib/web-host/inlang-plugins.js'
import {
  classifyTest,
  type TestClassification,
  type TestSelectionContext,
} from './lib/web-host/test-selection.js'
import {
  isExactVersion,
  findDrift,
  importerDependencies,
  parseLockfile,
  singleVersion,
  type LockedDependency,
} from './lib/web-host/lockfile.js'
import {
  OPTIONAL_PEER_PACKAGES,
  PEER_PACKAGES,
  VENDORED_SHARED_DIR,
  buildCompatibilityManifest,
  buildPackageJson,
  optionalManifestsToPack,
  packageJsonProblems,
  packageReadme,
} from './lib/web-host/package-manifest.js'
import {
  VENDORED_SHARED_SOURCE_GLOB,
  rewriteSharedSource,
} from '../apps/web/config/app-css-source.ts'
import { paraglideOptions } from '../apps/web/config/paths.ts'

export const REPO_ROOT = join(import.meta.dirname, '..')
export const WEB_DIR = join(REPO_ROOT, 'apps', 'web')
// Outside apps/, packages/ and scripts/ on purpose: jscpd, ESLint and SonarCloud scan those trees,
// and the staged copy of src/ would read as a wholesale duplicate of apps/web.
export const STAGE_DIR = join(REPO_ROOT, '.web-host-pack')
const MANIFEST = 'package.json'
const SHARED_SRC = join(REPO_ROOT, 'packages', 'shared', 'src')
const WEB_PACKAGE = '@project-vault/web-host'
const SHARED_PACKAGE = '@project-vault/shared'
const EXTENSION_API_PACKAGE = '@project-vault/extension-api'

/** apps/web's tracked directories the package ships, relative to apps/web. */
const SHIPPED_TREES = ['src', 'static', 'messages', 'project.inlang', 'inlang-plugins'] as const
const INLANG_SETTINGS = 'project.inlang/settings.json'
/** @project-vault/shared's three entry points apps/web aliases (index, /node-tls, /test-pki). */
const SHARED_ENTRIES = ['index.ts', 'node/internal-tls-pem.ts', 'node/test-pki-test-helpers.ts']
const SOURCE_FILE_RE = /\.(ts|js|svelte)$/
const SYMLINK_MODE = '120000'

export class PackError extends Error {
  constructor(public readonly problems: string[]) {
    super(`web-host pack failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'PackError'
  }
}

export interface PackOptions {
  version: string
  repository: string
  log?: (line: string) => void
}

export interface PackResult {
  packageJson: Record<string, unknown>
  /** Repo-relative paths of the apps/web non-test files copied. */
  shippedWebFiles: string[]
  /** Repo-relative paths of the self-contained unit tests shipped. */
  shippedTests: string[]
  /** Cross-package tests left out, with the rule each one breaks. */
  excludedTests: { file: string; reasons: string[] }[]
  /** Repo-relative paths of the vendored packages/shared/src files. */
  vendoredSharedFiles: string[]
  compatibilityManifest: string
}

interface TrackedFile {
  path: string
  symlink: boolean
}

/** Tracked files under `paths` (repo-relative), with symlinks flagged from their git mode. */
function trackedFiles(paths: string[]): TrackedFile[] {
  return trustedGit(REPO_ROOT, ['ls-files', '-s', '-z', '--', ...paths])
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const [meta = '', path = ''] = line.split('\t')
      return { path, symlink: meta.startsWith(SYMLINK_MODE) }
    })
}

function readJson<T>(path: string): T {
  return createRequire(import.meta.url)(path) as T
}

function webResolver(): GraphResolver {
  const aliases: [string, string][] = [
    [`${SHARED_PACKAGE}/node-tls`, join(SHARED_SRC, 'node', 'internal-tls-pem.ts')],
    [`${SHARED_PACKAGE}/test-pki`, join(SHARED_SRC, 'node', 'test-pki-test-helpers.ts')],
    [SHARED_PACKAGE, join(SHARED_SRC, 'index.ts')],
  ]
  return {
    alias: (specifier) => {
      if (specifier === '$lib' || specifier.startsWith('$lib/')) {
        return join(WEB_DIR, 'src', 'lib', specifier.slice('$lib'.length))
      }
      return aliases.find(([name]) => name === specifier)?.[1]
    },
    readFile: sysReadFile,
  }
}

function runNode(script: string, args: string[], cwd: string): void {
  execFileSync(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
}

function copyToStage(path: string): void {
  cpSync(join(REPO_ROOT, path), join(STAGE_DIR, path.slice('apps/web/'.length)))
}

/** Copies every tracked non-test file; returns them plus the tracked test files under src/,
 * which ship only when self-contained (classified later, once the import graph is ready). */
function copyWebTrees(problems: string[]): { shipped: string[]; testCandidates: string[] } {
  const tracked = trackedFiles(SHIPPED_TREES.map((tree) => `apps/web/${tree}`))
  for (const file of tracked.filter((entry) => entry.symlink)) {
    problems.push(`${file.path} is a symlink; the pack never dereferences one silently`)
  }
  const regular = tracked.filter((entry) => !entry.symlink).map((entry) => entry.path)
  const shipped = regular.filter((path) => !isTestFile(path))
  for (const path of shipped) copyToStage(path)
  const testCandidates = regular.filter(
    (path) => isTestFile(path) && path.startsWith('apps/web/src/') && SOURCE_FILE_RE.test(path)
  )
  return { shipped, testCandidates }
}

/** Ships the self-contained unit tests (Story 68.2, Nestor 2026-10-02) and reports the rest. */
function packSelfContainedTests(
  candidates: string[],
  context: TestSelectionContext
): { shipped: TestClassification[]; excluded: TestClassification[] } {
  const classified = candidates.map((path) => {
    const file = join(REPO_ROOT, path)
    return classifyTest(file, sysReadFile(file) ?? '', context)
  })
  const shipped = classified.filter((entry) => entry.selfContained)
  for (const entry of shipped) copyToStage(relativePosix(REPO_ROOT, entry.file))
  return { shipped, excluded: classified.filter((entry) => !entry.selfContained) }
}

/** Packages the shipped tests import that the runtime does not: optional, exact peers. */
function testPeers(
  shipped: TestClassification[],
  runtime: { dependencies: Record<string, string>; peerDependencies: Record<string, string> },
  webLocked: Map<string, LockedDependency>
): Record<string, string> {
  const names = new Set(shipped.flatMap((entry) => entry.bareImports))
  const taken = new Set([
    ...Object.keys(runtime.dependencies),
    ...Object.keys(runtime.peerDependencies),
    SHARED_PACKAGE,
  ])
  return Object.fromEntries(
    [...names]
      .filter((name) => !taken.has(name))
      .flatMap((name) => {
        const version = webLocked.get(name)?.version
        return version === undefined ? [] : [[name, version]]
      })
  )
}

/** Vendors @project-vault/shared: exactly the non-test files reachable from its three entries. */
function vendorShared(problems: string[]): { files: string[]; bareImports: Map<string, string[]> } {
  const graph = walkImportGraph(
    SHARED_ENTRIES.map((entry) => join(SHARED_SRC, entry)),
    { alias: () => undefined, readFile: sysReadFile },
    (path) => relativePosix(REPO_ROOT, path)
  )
  problems.push(...graph.errors)
  const files = [...graph.files]
    .map((path) => relativePosix(REPO_ROOT, path))
    .sort(compareCodeUnits)
  const symlinks = new Set(
    trackedFiles(['packages/shared/src'])
      .filter((entry) => entry.symlink)
      .map((entry) => entry.path)
  )
  for (const file of files) {
    if (!file.startsWith('packages/shared/src/')) {
      problems.push(`vendored shared source reaches outside packages/shared/src: ${file}`)
    } else if (symlinks.has(file)) {
      problems.push(`${file} is a symlink; the pack never dereferences one silently`)
    } else {
      cpSync(
        join(REPO_ROOT, file),
        join(STAGE_DIR, VENDORED_SHARED_DIR, file.slice('packages/shared/src/'.length))
      )
    }
  }
  for (const [name, importers] of graph.bareImports) {
    if (name.startsWith('@project-vault/')) {
      problems.push(
        `${relativePosix(REPO_ROOT, importers[0] ?? '')} imports the workspace package ${name}`
      )
    }
  }
  return { files, bareImports: graph.bareImports }
}

export interface DependencyInputs {
  webBareImports: Map<string, string[]>
  sharedBareImports: Map<string, string[]>
  webLocked: Map<string, LockedDependency>
  sharedLocked: Map<string, LockedDependency>
  extensionApi: string
}

function lockedVersion(name: string, locked: LockedDependency | undefined, extensionApi: string) {
  if (locked?.link === undefined) return locked?.version
  return name === EXTENSION_API_PACKAGE ? extensionApi : undefined
}

const WEB_IMPORTER = 'apps/web'
const SHARED_IMPORTER = 'packages/shared'

interface ImportSource {
  name: string
  importer: typeof WEB_IMPORTER | typeof SHARED_IMPORTER
  from: string
}

/** Which lockfile importer each bare import resolves against: a web file's against apps/web, a
 * vendored shared file's against packages/shared (the web graph also walks into shared through the
 * alias, so those files are attributed to shared). Peers always come from apps/web. */
function importSources(inputs: DependencyInputs, peers: ReadonlySet<string>): ImportSource[] {
  const web = [...inputs.webBareImports].flatMap(([name, files]): ImportSource[] => {
    const webFile = files.find((file) => !file.startsWith(SHARED_SRC))
    const workspace = name === WEB_PACKAGE || name === SHARED_PACKAGE
    return webFile === undefined || workspace
      ? []
      : [{ name, importer: WEB_IMPORTER, from: webFile }]
  })
  const shared = [...inputs.sharedBareImports].map(([name, files]): ImportSource => ({
    name,
    importer: SHARED_IMPORTER,
    from: files[0] ?? SHARED_SRC,
  }))
  const peerSources = [...peers].map((name): ImportSource => ({
    name,
    importer: WEB_IMPORTER,
    from: join(WEB_DIR, MANIFEST),
  }))
  return [...web, ...shared, ...peerSources]
}

/** Exact runtime dependencies and peers, every version taken from the lockfile. */
export function computeDependencies(inputs: DependencyInputs, problems: string[]) {
  const peers = new Set<string>([...PEER_PACKAGES, ...OPTIONAL_PEER_PACKAGES])
  const versionsByName = new Map<string, string[]>()
  for (const { name, importer, from } of importSources(inputs, peers)) {
    const locked = importer === WEB_IMPORTER ? inputs.webLocked : inputs.sharedLocked
    const version = lockedVersion(name, locked.get(name), inputs.extensionApi)
    if (version === undefined || !isExactVersion(version)) {
      problems.push(
        `${relativePosix(REPO_ROOT, from)} imports ${name}, which is not resolved in pnpm-lock.yaml for ${importer}`
      )
    } else {
      versionsByName.set(name, [...(versionsByName.get(name) ?? []), version])
    }
  }
  const dependencies: Record<string, string> = {}
  const peerDependencies: Record<string, string> = {}
  for (const [name, versions] of versionsByName) {
    try {
      const target = peers.has(name) ? peerDependencies : dependencies
      Object.assign(target, { [name]: singleVersion(name, versions) })
    } catch (error) {
      problems.push((error as Error).message)
    }
  }
  return { dependencies, peerDependencies }
}

/** Copies each pinned inlang plugin (and its licence) into the package, checks the copy against
 * its pin, and points the packed settings.json at the copies: a consumer has no PV node_modules. */
async function packInlangPlugins(problems: string[]): Promise<void> {
  const lock = readJson<PluginLock>(join(WEB_DIR, 'inlang-plugins', 'plugins.lock.json'))
  for (const [name, pin] of Object.entries(lock)) {
    const target = join(STAGE_DIR, pin.packedAs)
    cpSync(join(WEB_DIR, pin.module), target)
    cpSync(
      join(WEB_DIR, 'node_modules', name, 'LICENSE'),
      join(dirname(target), `LICENSE-${name.split('/').at(-1) ?? name}`)
    )
    const bytes = await (await openAsBlob(target)).arrayBuffer()
    const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
    if (sha256 !== pin.sha256) {
      problems.push(`${name}: packed plugin sha256 ${sha256} does not match the pin ${pin.sha256}`)
    }
  }
  const settings = readJson<InlangSettings>(join(WEB_DIR, INLANG_SETTINGS))
  writeFileSync(
    join(STAGE_DIR, INLANG_SETTINGS),
    `${JSON.stringify(packedSettings(settings, lock), null, 2)}\n`
  )
}

/** Compiles apps/web's messages with the same options the exported factories use. */
async function compileParaglide(): Promise<void> {
  const entry = createRequire(join(WEB_DIR, MANIFEST)).resolve('@inlang/paraglide-js')
  const { compile } = (await import(
    pathToFileURL(entry).href
  )) as typeof import('@inlang/paraglide-js')
  await compile(paraglideOptions(WEB_DIR))
}

function compileConfigFactories(): void {
  const tsc = resolveBin('typescript', 'tsc', WEB_DIR)
  runNode(
    tsc,
    [
      '-p',
      'config/tsconfig.json',
      '--noEmit',
      'false',
      '--declaration',
      '--outDir',
      join(STAGE_DIR, 'config'),
    ],
    WEB_DIR
  )
}

function writeTsconfigBase(): void {
  const webTsconfig = JSON.parse(readFileSync(join(WEB_DIR, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>
  }
  // rootDirs is path-valued and relative to apps/web; a consumer's own Kit tsconfig sets it.
  const { rootDirs: _rootDirs, ...compilerOptions } = webTsconfig.compilerOptions
  writeFileSync(
    join(STAGE_DIR, 'tsconfig.base.json'),
    `${JSON.stringify({ compilerOptions }, null, 2)}\n`
  )
}

/** Copies the later stories' generated manifests that exist in apps/web/manifests/ (68-4, 68-5,
 * 68-7); a missing one is simply not packed, never stubbed. */
function packOptionalManifests(): string[] {
  const existing = new Set(globSync('*.json', { cwd: join(WEB_DIR, 'manifests') }))
  const packed = optionalManifestsToPack(existing)
  for (const name of packed) {
    cpSync(join(WEB_DIR, 'manifests', name), join(STAGE_DIR, 'manifests', name))
  }
  return packed
}

export async function packWebHost(options: PackOptions): Promise<PackResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const problems: string[] = []
  if (!isExactVersion(options.version)) {
    throw new PackError([`--version ${options.version} is not an exact semver version`])
  }

  rmSync(STAGE_DIR, { recursive: true, force: true })
  mkdirSync(join(STAGE_DIR, 'manifests'), { recursive: true })
  log(`pack-web-host: staging ${relativePosix(REPO_ROOT, STAGE_DIR)} (version ${options.version})`)

  const { shipped: shippedWebFiles, testCandidates } = copyWebTrees(problems)
  writeFileSync(
    join(STAGE_DIR, 'src', 'app.css'),
    rewriteSharedSource(
      readFileSync(join(WEB_DIR, 'src', 'app.css'), 'utf8'),
      VENDORED_SHARED_SOURCE_GLOB
    )
  )
  log(`pack-web-host: copied ${shippedWebFiles.length} tracked apps/web non-test files`)
  await packInlangPlugins(problems)

  // `$lib/paraglide/*` is generated; compile it so the import graph can follow it (never shipped).
  await compileParaglide()
  const roots = [
    ...shippedWebFiles
      .filter((path) => path.startsWith('apps/web/src/') && SOURCE_FILE_RE.test(path))
      .filter((path) => !isTestSupportFile(path)),
    ...trackedFiles(['apps/web/config'])
      .map((entry) => entry.path)
      .filter((path) => path.endsWith('.ts') && !isTestFile(path)),
  ].map((path) => join(REPO_ROOT, path))
  const webGraph = walkImportGraph(roots, webResolver(), (path) => relativePosix(REPO_ROOT, path))
  problems.push(...webGraph.errors)
  const shared = vendorShared(problems)
  log(
    `pack-web-host: import graph reached ${webGraph.files.size} web files, vendored ${shared.files.length} shared files`
  )

  const lockfile = parseLockfile(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8'))
  const webLocked = importerDependencies(lockfile, WEB_IMPORTER)
  const webManifest = readJson<{
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }>(join(WEB_DIR, MANIFEST))
  problems.push(
    ...findDrift({ ...webManifest.devDependencies, ...webManifest.dependencies }, webLocked)
  )
  const extensionApi = await extensionApiVersion()
  const runtime = computeDependencies(
    {
      webBareImports: webGraph.bareImports,
      sharedBareImports: shared.bareImports,
      webLocked,
      sharedLocked: importerDependencies(lockfile, SHARED_IMPORTER),
      extensionApi,
    },
    problems
  )
  const { dependencies } = runtime
  const tests = packSelfContainedTests(testCandidates, {
    webSrc: join(WEB_DIR, 'src'),
    vendoredShared: new Set(shared.files.map((file) => join(REPO_ROOT, file))),
    // apps/web's own registry dependencies, plus the runtime dependencies the vendored shared
    // source brings (zod, cron-parser, ...), which web-host's own `dependencies` already carry.
    lockedPackages: new Set([
      ...[...webLocked].filter(([, entry]) => entry.link === undefined).map(([name]) => name),
      ...Object.keys(dependencies),
    ]),
    publishedWorkspacePackages: new Set([EXTENSION_API_PACKAGE]),
    resolver: webResolver(),
    display: (path) => relativePosix(REPO_ROOT, path),
  })
  const optionalTestPeers = testPeers(tests.shipped, runtime, webLocked)
  const peerDependencies = { ...runtime.peerDependencies, ...optionalTestPeers }
  log(
    `pack-web-host: ${tests.shipped.length} self-contained tests shipped, ${tests.excluded.length} cross-package tests excluded`
  )
  log(
    `pack-web-host: ${Object.keys(dependencies).length} dependencies and ${Object.keys(peerDependencies).length} peers from pnpm-lock.yaml`
  )

  const rootManifest = readJson<{ engines: { node: string } }>(join(REPO_ROOT, MANIFEST))
  const extensionApiManifest = readJson<{ repository: { url: string } }>(
    join(REPO_ROOT, 'packages', 'extension-api', MANIFEST)
  )
  const packageJson = buildPackageJson({
    version: options.version,
    repositoryUrl: extensionApiManifest.repository.url,
    nodeEngine: rootManifest.engines.node,
    dependencies,
    peerDependencies,
    optionalPeers: Object.keys(optionalTestPeers),
  })
  problems.push(...packageJsonProblems(packageJson))
  if (problems.length > 0) throw new PackError(problems)

  compileConfigFactories()
  writeTsconfigBase()
  cpSync(join(REPO_ROOT, 'LICENSE'), join(STAGE_DIR, 'LICENSE'))
  writeFileSync(join(STAGE_DIR, 'README.md'), packageReadme(options.version))
  const compatibilityManifest = buildCompatibilityManifest({
    pvRelease: options.version,
    extensionApiVersion: extensionApi,
    toolchain: {
      kit: peerDependencies['@sveltejs/kit'] ?? '',
      svelte: peerDependencies.svelte ?? '',
      vite: peerDependencies.vite ?? '',
      typescript: peerDependencies.typescript ?? '',
    },
    apiImageTag: releaseImageRef(options.repository, 'api', options.version),
  })
  writeFileSync(join(STAGE_DIR, 'manifests', 'compatibility.json'), compatibilityManifest)
  const optional = packOptionalManifests()
  writeFileSync(join(STAGE_DIR, MANIFEST), `${JSON.stringify(packageJson, null, 2)}\n`)
  log(
    `pack-web-host: done: ${options.version}, ${shippedWebFiles.length + shared.files.length} source files, ` +
      `manifests: compatibility.json${optional.map((name) => `, ${name}`).join('')}`
  )
  return {
    packageJson,
    shippedWebFiles,
    shippedTests: tests.shipped.map((entry) => relativePosix(REPO_ROOT, entry.file)),
    excludedTests: tests.excluded.map((entry) => ({
      file: relativePosix(REPO_ROOT, entry.file),
      reasons: entry.reasons,
    })),
    vendoredSharedFiles: shared.files,
    compatibilityManifest,
  }
}

/** npm's own CLI next to the running node binary (never a $PATH lookup). */
export function npmCli(): string {
  return join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      version: { type: 'string', default: '0.0.0-dev' },
      repository: {
        type: 'string',
        default: process.env.GITHUB_REPOSITORY ?? DEFAULT_RELEASE_REPOSITORY,
      },
      tarball: { type: 'string' },
    },
  })
  try {
    await packWebHost({ version: values.version, repository: values.repository })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
    return
  }
  if (values.tarball !== undefined) {
    const output = execFileSync(
      process.execPath,
      [npmCli(), 'pack', '--json', '--pack-destination', values.tarball],
      {
        cwd: STAGE_DIR,
        encoding: 'utf8',
      }
    )
    const [packed] = JSON.parse(output) as { filename: string; size: number }[]
    process.stdout.write(
      `pack-web-host: tarball ${join(values.tarball, packed?.filename ?? '')} (${packed?.size ?? 0} bytes)\n`
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
}
