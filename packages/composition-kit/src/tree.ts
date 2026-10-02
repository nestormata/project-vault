import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { compareCodeUnits } from './paths.js'

export interface TreeFile {
  /** Forward-slash path relative to the tree root. */
  rel: string
  abs: string
}

export interface TreeSymlink {
  rel: string
  target: string
}

export interface Tree {
  files: TreeFile[]
  symlinks: TreeSymlink[]
}

export interface ReadTreeOptions {
  /** Directory names never entered (for example `node_modules`). */
  skipDirectories?: ReadonlySet<string>
}

function walk(root: string, rel: string, options: ReadTreeOptions, into: Tree): void {
  const directory = rel === '' ? root : join(root, rel)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const abs = join(root, childRel)
    if (entry.isSymbolicLink()) {
      into.symlinks.push({ rel: childRel, target: readlinkSync(abs) })
    } else if (entry.isDirectory()) {
      if (!options.skipDirectories?.has(entry.name)) walk(root, childRel, options, into)
    } else if (entry.isFile()) {
      into.files.push({ rel: childRel, abs })
    }
  }
}

/** Lists the regular files under `root` and every symlink it contains (never followed). A missing
 * root is an empty tree. */
export function readTree(root: string, options: ReadTreeOptions = {}): Tree {
  const tree: Tree = { files: [], symlinks: [] }
  if (!existsDirectory(root)) return tree
  walk(root, '', options, tree)
  tree.files.sort((a, b) => compareCodeUnits(a.rel, b.rel))
  tree.symlinks.sort((a, b) => compareCodeUnits(a.rel, b.rel))
  return tree
}

export function existsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
