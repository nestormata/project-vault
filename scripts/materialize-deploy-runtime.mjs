/* eslint-disable security/detect-non-literal-fs-filename -- paths are explicit Docker CLI/test inputs. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

function readPackage(packageDirectory) {
  return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
}

function packagePathFromNodeModules(nodeModulesDirectory, packageName) {
  return join(nodeModulesDirectory, packageName)
}

function resolveDependency(packageDirectory, packageName, workspaceRoot, deployRoot) {
  const packageNodeModules = join(packageDirectory, 'node_modules')
  const virtualStorePeerDirectory = dirname(packageDirectory)
  const candidates = [
    packagePathFromNodeModules(packageNodeModules, packageName),
    packagePathFromNodeModules(virtualStorePeerDirectory, packageName),
    packagePathFromNodeModules(join(deployRoot, 'node_modules'), packageName),
    packagePathFromNodeModules(join(workspaceRoot, 'node_modules/.pnpm/node_modules'), packageName),
    packagePathFromNodeModules(join(workspaceRoot, 'node_modules'), packageName),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }

  throw new Error(
    `Could not resolve ${packageName} from ${relative(workspaceRoot, packageDirectory)}`
  )
}

function assertNoSymlinks(directory) {
  const entries = [directory]
  while (entries.length > 0) {
    const current = entries.pop()
    const stat = lstatSync(current)
    if (stat.isSymbolicLink())
      throw new Error(`Symlink remained in materialized package: ${current}`)
    if (!stat.isDirectory()) continue

    for (const entry of readdirSync(current)) entries.push(join(current, entry))
  }
}

function runtimeDependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
}

function materializeDependency(
  packageDirectory,
  dependencyName,
  manifest,
  deployRoot,
  workspaceRoot,
  copiedPackages
) {
  try {
    materialize(
      resolveDependency(packageDirectory, dependencyName, workspaceRoot, deployRoot),
      deployRoot,
      workspaceRoot,
      copiedPackages
    )
  } catch (error) {
    if (manifest.optionalDependencies && dependencyName in manifest.optionalDependencies) return
    throw error
  }
}

function materialize(packageDirectory, deployRoot, workspaceRoot, copiedPackages) {
  const actualDirectory = realpathSync(packageDirectory)
  const manifest = readPackage(actualDirectory)
  const existingVersion = copiedPackages.get(manifest.name)
  if (existingVersion && existingVersion !== manifest.version) {
    throw new Error(
      `Conflicting runtime versions for ${manifest.name}: ${existingVersion} and ${manifest.version}`
    )
  }
  if (existingVersion) return
  copiedPackages.set(manifest.name, manifest.version)

  const destination = join(deployRoot, 'node_modules', manifest.name)
  // A packed workspace package may already live at its final deploy path. Do not remove that
  // source before copying it to itself; still walk its dependencies and validate the tree below.
  if (actualDirectory !== destination) {
    mkdirSync(dirname(destination), { recursive: true })
    rmSync(destination, { recursive: true, force: true })
    cpSync(actualDirectory, destination, { recursive: true, dereference: true })
  }

  for (const dependencyName of runtimeDependencyNames(manifest)) {
    materializeDependency(
      actualDirectory,
      dependencyName,
      manifest,
      deployRoot,
      workspaceRoot,
      copiedPackages
    )
  }
}

export function materializeDeployRuntime(deployRoot, workspaceRoot, sourcePackagePaths) {
  if (!deployRoot || !workspaceRoot || !sourcePackagePaths?.length) {
    throw new Error(
      'Usage: node scripts/materialize-deploy-runtime.mjs <deploy-root> <workspace-root> <package-path>...'
    )
  }

  const copiedPackages = new Map()
  for (const sourcePackagePath of sourcePackagePaths) {
    materialize(realpathSync(sourcePackagePath), deployRoot, workspaceRoot, copiedPackages)
  }

  for (const packageName of copiedPackages.keys()) {
    assertNoSymlinks(join(deployRoot, 'node_modules', packageName))
  }

  return [...copiedPackages.keys()]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [deployRoot, workspaceRoot, ...sourcePackagePaths] = process.argv.slice(2)
  const packageNames = materializeDeployRuntime(deployRoot, workspaceRoot, sourcePackagePaths)
  process.stdout.write(
    `Materialized ${packageNames.length} runtime packages: ${packageNames.join(', ')}\n`
  )
}
