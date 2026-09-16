import { existsSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

// Never descend into a node_modules directory. This guards a real regression AC-1's own fix would
// otherwise introduce: before following symlinks, a symlinked entry inside node_modules (pnpm's
// store layout links a package's dependencies into its own node_modules via symlinks, often
// pointing at another .pnpm store entry that itself contains more such symlinks) was invisible to
// walkFiles (`Dirent.isDirectory()` is false for a symlink), so callers that scan a directory
// containing node_modules (e.g. check-search-index's `apps/`/`packages/` roots) never recursed
// into it beyond node_modules' own top level. Once symlinks are followed, that same traversal
// expands into pnpm's full transitive dependency graph — the same package revisited through every
// path that depends on it, with real depth/fanout in the hundreds to thousands — which is not
// merely slow but can also hit genuine symlink cycles from circular peer dependencies. No caller
// of walkFiles has ever intended to scan third-party package contents; skipping node_modules
// entirely (matching this project's own eslint `ignores` convention, and every other mainstream JS
// tool's default) is the correct bound, not a workaround.
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules'])

export function toRepoPath(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join('/')
}

/**
 * A dangling symlink (or symlink-cycle entry) reported by `walkFiles`'s `onDanglingSymlink`
 * callback, shared by every `walkFiles` caller that surfaces this as its own violation kind
 * (Story 55.7 AC-2) — matches `check-implementation-artifacts-symlinks.ts`'s existing
 * `dangling-symlink` reporting shape (`file` + `target`).
 */
export type DanglingSymlinkViolation = { file: string; reason: 'dangling-symlink'; target: string }

/**
 * Builds a `DanglingSymlinkViolation` for `path` (a `walkFiles` `onDanglingSymlink` callback
 * argument), best-effort resolving the link's raw target text via `readlinkSync` for the report
 * message. `readlinkSync` itself can fail (e.g. the entry vanished between `statSync` and this
 * call) — in that case `target` falls back to an empty string rather than throwing, since the
 * violation itself (the entry is unreadable) is already established by the caller.
 */
export function toDanglingSymlinkViolation(
  rootDir: string,
  path: string
): DanglingSymlinkViolation {
  let target = ''
  try {
    target = readlinkSync(path)
  } catch {
    // best-effort only — the violation is reported regardless
  }
  return { file: toRepoPath(rootDir, path), reason: 'dangling-symlink', target }
}

/**
 * Walks `dir` recursively, collecting every file (following symlinks) that matches `predicate`.
 *
 * Story 55.7 (AC-1): `Dirent.isFile()`/`Dirent.isDirectory()` (from `readdirSync`'s own listing)
 * reflect the directory entry's *own* type — for a symlink, that is neither "file" nor
 * "directory", so a plain `Dirent`-based check silently drops every symlinked entry. This project's
 * per-file symlink local-checkout convention (see AGENTS.md's "Private overlay worktree setup")
 * means nearly every real story file under `_bmad-output/implementation-artifacts/` is exactly this
 * shape. `fs.statSync` follows the entire symlink chain (including symlink-to-symlink) and reports
 * the *target's* type, which is what every caller here actually wants: a symlinked file should be
 * scanned like a real file, and a symlinked directory should be recursed into like a real one
 * (modeled on `check-implementation-artifacts-symlinks.ts`'s existing `classifyEntry`/
 * `findCanonicalDir` resolve-then-classify shape).
 *
 * `onDanglingSymlink`, if provided, is called with the full path of any entry whose target
 * `statSync` cannot reach — a dangling symlink (`ENOENT`) or a symlink cycle (`ELOOP`) — instead of
 * that entry being silently dropped (AC-2). It defaults to a no-op so the six other `walkFiles`
 * callers that don't care about dangling symlinks need no changes.
 */
export function walkFiles(
  dir: string,
  predicate: (file: string) => boolean,
  onDanglingSymlink: (path: string) => void = () => {}
): string[] {
  if (!existsSync(dir)) return []

  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
    const fullPath = resolve(dir, entry.name)

    let stat
    try {
      stat = statSync(fullPath)
    } catch {
      // ENOENT (dangling symlink target) or ELOOP (symlink cycle) — report, don't crash the walk.
      onDanglingSymlink(fullPath)
      continue
    }

    if (stat.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate, onDanglingSymlink))
    } else if (stat.isFile() && predicate(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}
