// Story 68.10 AC-2.1: the pack-and-compose steps every out-of-monorepo composition consumer shares,
// extracted from scripts/check-composition-kit-integration.test.ts so the mechanism e2e job
// (mock UI pack, real API) reuses ONE harness. It builds and packs web-host and the composition kit
// the way the release workflows do, resolves @project-vault/extension-api (registry or workspace
// tarball), and builds the environment `scripts/web-host-consumer-fixture/run.sh` expects.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { REPO_ROOT, STAGE_DIR, packWebHost } from '../../pack-web-host.js'
import { resolveBin } from '../trusted-executable.js'
import { extensionApiVersion, packInto, resolveExtensionApi } from './fixture-pack.js'

const KIT_DIR = join(REPO_ROOT, 'packages', 'composition-kit')

export interface ConsumerTarballs {
  webHostTarball: string
  kitTarball: string
  /** Undefined when the registry serves the pinned extension-api version. */
  extensionApiTarball: string | undefined
}

/** The version PV's web app has installed (the consumer pins the same, exactly). */
export function installedVersion(name: string): string {
  const requireFromWeb = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))
  return (requireFromWeb(`${name}/package.json`) as { version: string }).version
}

/** The kit's own integration fixtures (mini-pack, negative-pack, ...). */
export function kitFixturesDir(): string {
  return join(KIT_DIR, 'tests', 'fixtures')
}

/** Packs web-host (version `0.0.0-fixture`), builds and packs the kit, and resolves the
 * extension-api tarball, all into `workDir`. */
export async function packConsumerTarballs(workDir: string): Promise<ConsumerTarballs> {
  const { packageJson } = await packWebHost({
    version: '0.0.0-fixture',
    repository: 'nestormata/project-vault',
    log: () => undefined,
  })
  const webHostTarball = packInto(STAGE_DIR, workDir)
  // The kit is built and packed the way the release workflow does it.
  rmSync(join(KIT_DIR, 'dist'), { recursive: true, force: true })
  const build = spawnSync(
    process.execPath,
    [resolveBin('typescript', 'tsc', KIT_DIR), '-p', 'tsconfig.build.json'],
    { cwd: KIT_DIR, encoding: 'utf8' }
  )
  if (build.status !== 0) throw new Error(`kit build failed: ${build.stdout}${build.stderr}`)
  const kitTarball = packInto(KIT_DIR, workDir)
  const extensionApi = extensionApiVersion(packageJson.dependencies as Record<string, string>)
  if (extensionApi === undefined) {
    throw new Error('web-host depends on an exact extension-api version')
  }
  return {
    webHostTarball,
    kitTarball,
    extensionApiTarball: resolveExtensionApi(extensionApi, workDir),
  }
}

export interface ConsumerEnvOptions {
  /** Where `COMPOSITION_KIT_FIXTURES` points (default: the kit's own fixtures). */
  fixturesDir?: string
}

/** The environment run.sh needs. The pinned values come last, so a parent variable of the same
 * name never overrides them. */
export function consumerFixtureEnv(
  base: NodeJS.ProcessEnv,
  workDir: string,
  tarballs: ConsumerTarballs,
  options: ConsumerEnvOptions = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    WEB_HOST_FIXTURE_CACHE: join(workDir, 'npm-cache'),
    COMPOSITION_KIT_TARBALL: tarballs.kitTarball,
    COMPOSITION_KIT_FIXTURES: options.fixturesDir ?? kitFixturesDir(),
    COMPOSITION_KIT_SVELTE_CHECK: installedVersion('svelte-check'),
    COMPOSITION_KIT_TYPES_NODE: installedVersion('@types/node'),
  }
  if (tarballs.extensionApiTarball !== undefined) {
    env.WEB_HOST_FIXTURE_EXTENSION_API_TARBALL = tarballs.extensionApiTarball
  }
  return env
}
