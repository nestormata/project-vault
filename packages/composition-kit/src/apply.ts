import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { writeFileAtomic } from './lock.js'
import { patchAcceptances, type PatchEntry } from './lock-patch.js'
import type { FileSource } from './overlay.js'
import { writeReplacementMap } from './replacement-map.js'
import { OWNED_DIRECTORIES } from './sources.js'
import type { ComposePlan } from './plan.js'
import {
  copyFile,
  lstatPath,
  makeDir,
  makeTempDir,
  pathExists,
  readText,
  realPath,
  removePath,
  renamePath,
  writeFile,
} from './fs-access.js'

/** Refuses an app root the composer must never delete under (Red Team: the output directory is
 * deleted and rewritten, so it must be a real app directory and its owned children real children). */
export function appRootProblems(appRoot: string): string[] {
  const problems: string[] = []
  if (!pathExists(join(appRoot, 'package.json'))) {
    problems.push(
      `${appRoot} is not an app root (no package.json); refusing to write generated directories there.`
    )
    return problems
  }
  const real = realPath(appRoot)
  if (real === parse(real).root || real === realPath(homedir())) {
    problems.push(
      `${real} is a filesystem root or a home directory; refusing to write generated directories there.`
    )
  }
  for (const owned of OWNED_DIRECTORIES) {
    const dir = join(appRoot, owned)
    if (!pathExists(dir)) continue
    if (lstatPath(dir).isSymbolicLink() || dirname(realPath(dir)) !== real) {
      problems.push(
        `${dir} is not a plain child directory of the app root (symlink or elsewhere); refusing to delete it.`
      )
    }
  }
  return problems
}

function writeSource(path: string, source: FileSource): void {
  makeDir(dirname(path))
  if (source.kind === 'file') copyFile(source.abs, path)
  else writeFile(path, source.content)
}

/** Moves each previous directory aside, then the new one in. On failure only what this call
 * moved or installed is touched: installed directories are removed and moved ones restored, so a
 * directory the swap never reached is never deleted. */
export function swapIn(appRoot: string, stage: string): void {
  const moved: string[] = []
  const installed: string[] = []
  makeDir(join(stage, 'old'))
  try {
    for (const owned of OWNED_DIRECTORIES) {
      const current = join(appRoot, owned)
      if (pathExists(current)) {
        renamePath(current, join(stage, 'old', owned))
        moved.push(owned)
      }
      renamePath(join(stage, 'new', owned), current)
      installed.push(owned)
    }
  } catch (error) {
    for (const owned of installed) removePath(join(appRoot, owned))
    for (const owned of moved) renamePath(join(stage, 'old', owned), join(appRoot, owned))
    throw error
  }
}

/** Writes the composed tree and the lock. Everything is built in a `0700` temp directory next to
 * the target (same filesystem) and swapped in by rename, so a failure leaves the previous tree
 * intact. The temp directory is removed on every exit path. */
export function apply(plan: ComposePlan, appRoot: string): void {
  const refused = appRootProblems(appRoot)
  if (refused.length > 0) throw new Error(refused.join('\n'))
  const stage = makeTempDir(join(appRoot, '.pv-compose-'))
  try {
    const fresh = join(stage, 'new')
    for (const owned of OWNED_DIRECTORIES) makeDir(join(fresh, owned))
    for (const [dest, source] of plan.files) writeSource(join(fresh, dest), source)
    swapIn(appRoot, stage)
    if (plan.replacementMapText !== undefined) writeReplacementMap(appRoot, plan.replacementMapText)
    if (plan.lockText !== undefined) writeFileAtomic(plan.lockPath, plan.lockText)
  } finally {
    removePath(stage)
  }
}

/** `--accept-host` when the rest of compose still fails: the acceptance is recorded in the
 * committed lock alone, so it is not lost, and nothing else changes. */
export function persistAcceptances(lockPath: string, entries: readonly PatchEntry[]): boolean {
  if (!pathExists(lockPath) || entries.length === 0) return false
  writeFileAtomic(lockPath, patchAcceptances(readText(lockPath), entries))
  return true
}
