import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs'
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
 * Writes the standard "FATAL: found dangling symlink(s)..." report block to `process.stderr` for
 * `danglingSymlinks` (a no-op if empty). Shared by every `check-*.ts` script whose violation union
 * includes `DanglingSymlinkViolation` (Story 55.7 AC-2) — `check-story-references.ts` and
 * `check-story-status-sync.ts` both reported this identical block inline, which is exactly the kind
 * of drift this story's own guard scripts warn against (a copy silently going stale in one call site
 * while the other is fixed).
 */
export function reportDanglingSymlinks(danglingSymlinks: DanglingSymlinkViolation[]): void {
  if (danglingSymlinks.length === 0) {
    return
  }
  process.stderr.write(
    '\nFATAL: found dangling symlink(s) under implementation-artifacts/ (Story 55.7 AC-2 — ' +
      'a symlink whose target could not be read, not silently skipped):\n'
  )
  for (const d of danglingSymlinks) {
    process.stderr.write(`  - ${d.file}: dangling symlink (target does not exist: ${d.target})\n`)
  }
  process.stderr.write(
    '\nFix: point the symlink at a real target, or remove it if it should not exist.\n'
  )
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

/** Whether a private-overlay input file is readable here (Story 43.11 AC-7). */
export type OverlayInputState = 'present' | 'absent' | 'dangling'

export type OverlayInputInspection =
  { state: 'present' | 'absent' } | { state: 'dangling'; target: string }

/**
 * Classifies `relPath` (under `rootDir`) as `present`, `absent`, or `dangling`, walking every path
 * component with `lstat` so a dangling symlink anywhere along the way is told apart from a plain
 * missing file. Both layouts occur for real: per-file overlay symlinks copied into the `make ci`
 * image (the file itself dangles) and the private workflow's directory-level `_bmad-output` attach
 * (a parent directory dangles). For the overlay's top-level inputs (sprint-status.yaml,
 * deferred-work.md) both mean "overlay not attached here", not data corruption.
 */
export function inspectOverlayInput(rootDir: string, relPath: string): OverlayInputInspection {
  let current = resolve(rootDir)
  for (const segment of relPath.split('/')) {
    current = resolve(current, segment)
    let isLink: boolean
    try {
      isLink = lstatSync(current).isSymbolicLink()
    } catch (error) {
      // Only a provably missing path is "absent". Anything else (EACCES on a parent, ...) is not a
      // reason to skip: stop here and let `overlayReadFailure` report it as FATAL.
      if (isMissingPathError(error)) return { state: 'absent' }
      return { state: 'present' }
    }
    if (isLink && !existsSync(current)) {
      return { state: 'dangling', target: readlinkSync(current) }
    }
  }
  return { state: 'present' }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function detectOverlayInput(rootDir: string, relPath: string): OverlayInputState {
  return inspectOverlayInput(rootDir, relPath).state
}

/**
 * The stdout line a guard prints instead of its "— OK" line when its overlay input is not
 * readable (Story 43.11 AC-7.1/7.2), or `undefined` when the input is present and the guard should
 * run normally. Never an OK: a guard that checked nothing must say so.
 */
export function overlaySkipMessage(
  checkName: string,
  rootDir: string,
  relPath: string
): string | undefined {
  const inspection = inspectOverlayInput(rootDir, relPath)
  if (inspection.state === 'present') return undefined
  const reason =
    inspection.state === 'dangling'
      ? `dangling overlay symlink -> ${inspection.target}`
      : 'private overlay not attached'
  return `${checkName}: SKIPPED — ${relPath} not found (${reason}); nothing checked\n`
}

/**
 * The FATAL stderr text for an overlay input that is there (not absent, not dangling) but cannot
 * be read as a regular file (a directory, EACCES, ...), or `undefined` when it is readable. Without
 * this, every guard's loader swallows the read error and the guard prints a false "— OK" having
 * checked nothing, which is exactly what AC-7 forbids.
 */
export function overlayReadFailure(
  checkName: string,
  rootDir: string,
  relPath: string
): string | undefined {
  const path = resolve(rootDir, relPath)
  try {
    if (!statSync(path).isFile()) throw new Error('not a regular file')
    accessSync(path, constants.R_OK)
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return (
      `FATAL: ${checkName}: ${relPath} cannot be read (${reason}); nothing was checked, ` +
      'so this is not an OK.\n'
    )
  }
}

/**
 * The shared CLI entry for an overlay guard (Story 43.11 AC-7): prints SKIPPED (exit 0) when the
 * input is absent or a dangling overlay symlink, FATAL (exit 1) when it is there but unreadable,
 * and otherwise runs the guard.
 */
export function runOverlayGuard(
  checkName: string,
  rootDir: string,
  relPath: string,
  run: () => void
): void {
  const skipped = overlaySkipMessage(checkName, rootDir, relPath)
  if (skipped !== undefined) {
    process.stdout.write(skipped)
    return
  }
  const failure = overlayReadFailure(checkName, rootDir, relPath)
  if (failure !== undefined) {
    process.stderr.write(failure)
    process.exitCode = 1
    return
  }
  run()
}

/** Story 43.11 violation-line suffix for a key declared on several lines: `:3`, `:3 and :7`,
 * `:3, :7 and :19`. */
export function formatLineRefs(lines: number[]): string {
  const refs = lines.map((line) => `:${line}`)
  if (refs.length <= 1) return refs.join('')
  return `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`
}
