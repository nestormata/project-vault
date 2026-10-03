// Story 68.2 AC-8 / Story 68.3 AC-12: the packing helpers every out-of-monorepo consumer fixture
// shares (the web-host consumer fixture and the composition kit integration job). Both build their
// tarballs the way the release workflows do and resolve @project-vault/extension-api the same way.
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, npmCli } from '../../pack-web-host.js'
import { resolveBin } from '../trusted-executable.js'
import {
  EXTENSION_API_PACKAGE,
  extensionApiFallbackLine,
  extensionApiSource,
} from './extension-api-source.js'

export const EXTENSION_API_DIR = join(REPO_ROOT, 'packages', 'extension-api')

/** `npm pack`s the package in `cwd` into `destination` (npm's own CLI, never a $PATH lookup). */
export function packInto(cwd: string, destination: string): string {
  const packed = execFileSync(
    process.execPath,
    [npmCli(), 'pack', '--json', '--pack-destination', destination],
    { cwd, encoding: 'utf8' }
  )
  return join(destination, (JSON.parse(packed) as { filename: string }[])[0]?.filename ?? '')
}

/** Builds and packs packages/extension-api, as extension-api-release.yml does before publishing. */
export function packWorkspaceExtensionApi(destination: string): string {
  rmSync(join(EXTENSION_API_DIR, 'dist'), { recursive: true, force: true })
  execFileSync(
    process.execPath,
    [resolveBin('typescript', 'tsc', EXTENSION_API_DIR), '-p', 'tsconfig.build.json'],
    { cwd: EXTENSION_API_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return packInto(EXTENSION_API_DIR, destination)
}

/** Story 68.2 (Nestor 2026-10-02): the registry version when published; a workspace tarball when
 * npm answers E404 outside a registry-only run; a failure otherwise. */
export function resolveExtensionApi(version: string, workDir: string): string | undefined {
  const view = spawnSync(
    process.execPath,
    [npmCli(), 'view', `${EXTENSION_API_PACKAGE}@${version}`, 'version'],
    { cwd: workDir, encoding: 'utf8' }
  )
  const source = extensionApiSource(version, view, {
    registryOnly: process.env.WEB_HOST_FIXTURE_REGISTRY_ONLY === '1',
  })
  if (source.kind === 'registry') return undefined
  process.stderr.write(`${extensionApiFallbackLine(version, source.reason)}\n`)
  return packWorkspaceExtensionApi(workDir)
}

/** The exact `@project-vault/extension-api` version a packed web-host depends on. */
export function extensionApiVersion(dependencies: Record<string, string>): string | undefined {
  return Object.entries(dependencies).find(([name]) => name === EXTENSION_API_PACKAGE)?.[1]
}
