import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { validateTuple } from './compat.js'
import { sha256Hex } from './hash.js'
import { compareCodeUnits } from './paths.js'
import { readTree, type Tree, type TreeFile } from './tree.js'
import type { CompatibilityTuple } from './types.js'

/** The directories of web-host the composer copies, relative to the package root. */
export const OWNED_DIRECTORIES = [
  'src',
  'static',
  'messages',
  'project.inlang',
  'inlang-plugins',
  'vendor',
] as const

export interface Host {
  dir: string
  tuple: CompatibilityTuple
  dependencies: Record<string, string>
  /** Forward-slash path relative to the host root -> absolute path. */
  files: Map<string, string>
}

export interface Pack {
  root: string
  files: Map<string, string>
}

function symlinkProblems(label: string, tree: Tree): string[] {
  return tree.symlinks.map(
    (link) =>
      `Refusing symlink in ${label}: ${link.rel} -> ${link.target} (the composer copies regular files only)`
  )
}

function collect(tree: Tree): Map<string, string> {
  return new Map(tree.files.map((file: TreeFile) => [file.rel, file.abs]))
}

/** Locates and reads web-host as data. Never imports code from it. */
export function loadHost(dir: string): { host?: Host; problems: string[] } {
  const manifestPath = join(dir, 'manifests', 'compatibility.json')
  if (!existsSync(manifestPath)) {
    return { problems: [`${dir} is not a web-host package (missing manifests/compatibility.json)`] }
  }
  const root = realpathSync(dir)
  const tuple = validateTuple(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
  const problems = [...tuple.problems]
  const files = new Map<string, string>()
  for (const owned of OWNED_DIRECTORIES) {
    const tree = readTree(join(root, owned))
    problems.push(
      ...symlinkProblems('web-host', {
        ...tree,
        symlinks: tree.symlinks.map((l) => ({ ...l, rel: `${owned}/${l.rel}` })),
      })
    )
    for (const file of tree.files) files.set(`${owned}/${file.rel}`, file.abs)
  }
  if (tuple.tuple === undefined) return { problems }
  const packageJson = join(root, 'package.json')
  const dependencies = existsSync(packageJson)
    ? ((JSON.parse(readFileSync(packageJson, 'utf8')) as { dependencies?: Record<string, string> })
        .dependencies ?? {})
    : {}
  return { host: { dir: root, tuple: tuple.tuple, dependencies, files }, problems }
}

const PACK_SKIPPED = new Set(['node_modules', '.git'])

/** Reads the UI pack tree (everything under its root except node_modules and .git). */
export function loadPack(root: string): { pack: Pack; problems: string[] } {
  const tree = readTree(root, { skipDirectories: PACK_SKIPPED })
  return {
    pack: { root, files: collect(tree) },
    problems: symlinkProblems('the UI pack', tree),
  }
}

/** Memoized SHA-256 of a file's bytes. */
export function hasher(): (abs: string) => string {
  const cache = new Map<string, string>()
  return (abs) => {
    const known = cache.get(abs)
    if (known !== undefined) return known
    const digest = sha256Hex(readFileSync(abs))
    cache.set(abs, digest)
    return digest
  }
}

/** A deterministic digest of several files: sha256 over sorted "path:hash" lines. */
export function treeDigest(entries: readonly { path: string; sha: string }[]): string {
  const lines = entries
    .map((entry) => `${entry.path}:${entry.sha}`)
    .sort(compareCodeUnits)
    .join('\n')
  return sha256Hex(Buffer.from(lines))
}
