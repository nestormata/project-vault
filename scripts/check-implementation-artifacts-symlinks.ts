#!/usr/bin/env tsx
/**
 * Story 20.10 — a file-type scan across `_bmad-output/implementation-artifacts/` found 27 of 272
 * files were plain regular files instead of symlinks into `project-vault-private` (the canonical
 * git-tracked source): untracked, `.gitignore`d, and invisible to any tool that reads
 * `project-vault-private` directly. One concrete example (`1-19-...md`) let a stale, diverged copy
 * cause DW-137 to be closed on false evidence. This is the build failure that catches the *next*
 * stray file before it causes another silent false all-clear.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toRepoPath } from './lib/scan-utils.js'

export type ImplementationArtifactsViolation =
  | { file: string; reason: 'not-a-symlink' }
  | { file: string; reason: 'dangling-symlink'; target: string }

const BMAD_OUTPUT_DIR = '_bmad-output'
const STORIES_DIR = '_bmad-output/implementation-artifacts'

/**
 * Files intentionally kept as plain, non-symlinked, local-only artifacts under
 * `implementation-artifacts/` — each entry needs its own one-line rationale here (not just in a
 * story's Dev Agent Record, which won't be discoverable to a future session with no memory of this
 * story — AGENTS.md's "specs should be self-contained" rule, and this story's own AC-4).
 *
 * Do not add an entry here to silence this guard without a real, documented reason — that defeats
 * the guard's entire purpose.
 */
export const ALLOWED_NON_SYMLINK_FILES: ReadonlySet<string> = new Set([
  // compile-epic-context cache output for epic-9, which is fully `done` (sprint-status.yaml) —
  // nothing reads this file back; regenerable on demand, not worth a symlink for a cache artifact.
  'epic-9-context.md',
  // compile-epic-context cache output for epic-21, which is fully `done` (sprint-status.yaml) —
  // same rationale as epic-9-context.md above.
  'epic-21-context.md',
  // bmad-loop run-result artifact (a single blocked auto-dev-run's outcome, not a story file) —
  // transient tooling output, regenerable by re-running bmad-dev-auto, not canonical story content.
  'bmad-dev-auto-result-21-4-document-machine-user-usage.md',
])

/**
 * Scans `_bmad-output/implementation-artifacts/` for any top-level file that is neither a real
 * (non-dangling) symlink nor on the documented allow-list above.
 *
 * Skips the scan entirely (returns no violations) when `_bmad-output` itself is a symlink. In real
 * CI, `story-integrity-guards.yml` attaches project-vault-private's whole `_bmad-output` directory
 * as a single symlink (`ln -s .../project-vault-private/_bmad-output project-vault/_bmad-output`).
 * Every file reached through that one directory-level symlink lstats as a plain regular file —
 * only a path's *final* component matters to `lstat`, not whether an ancestor directory in the
 * path was itself a symlink — so a naive per-file scan would flag every single legitimate story
 * file as "not a symlink" and make this guard permanently red in real CI. When the whole tree is
 * attached this way it is canonical by construction (it *is* project-vault-private's own tree,
 * not a locally-drifted copy of it), so there is nothing this guard can usefully check — matching
 * check-followup-review-gate.ts's/check-psc-tbd-tracking.ts's existing fail-open-when-inapplicable
 * convention for missing/inapplicable inputs.
 */
/**
 * Classifies a single top-level entry under implementation-artifacts/, returning a violation if
 * it's a plain regular file or a dangling symlink, or `undefined` if it's fine (a real symlink, a
 * subdirectory, or on the allow-list).
 */
function classifyEntry(
  storiesDir: string,
  root: string,
  name: string
): ImplementationArtifactsViolation | undefined {
  if (ALLOWED_NON_SYMLINK_FILES.has(name)) return undefined

  const fullPath = resolve(storiesDir, name)
  const stat = lstatSync(fullPath)
  if (!stat.isSymbolicLink()) {
    if (stat.isDirectory()) return undefined // subdirectories aren't this story's stray-file class
    return { file: toRepoPath(root, fullPath), reason: 'not-a-symlink' }
  }

  // A symlink's target may be relative or absolute — resolve relative to the symlink's own
  // directory (readlink's contract), matching how the OS itself would resolve it.
  const target = readlinkSync(fullPath)
  const resolvedTarget = target.startsWith('/') ? target : resolve(storiesDir, target)
  try {
    lstatSync(resolvedTarget)
    return undefined
  } catch {
    // lstatSync().isSymbolicLink() is true for a dangling symlink too — it only tells you the
    // *link* exists, not that its target does. Following the link and stat'ing again (or failing
    // to) is what distinguishes "symlink" from "symlink pointing nowhere".
    return { file: toRepoPath(root, fullPath), reason: 'dangling-symlink', target }
  }
}

export function scanImplementationArtifactsSymlinks(
  rootDir = process.cwd()
): ImplementationArtifactsViolation[] {
  const root = resolve(rootDir)
  const bmadOutputPath = resolve(root, BMAD_OUTPUT_DIR)

  try {
    if (lstatSync(bmadOutputPath).isSymbolicLink()) return []
  } catch {
    // _bmad-output doesn't exist at all — nothing to scan.
    return []
  }

  const storiesDir = resolve(root, STORIES_DIR)

  let entries: string[]
  try {
    entries = readdirSync(storiesDir)
  } catch {
    return []
  }

  const violations: ImplementationArtifactsViolation[] = []
  for (const name of entries) {
    const violation = classifyEntry(storiesDir, root, name)
    if (violation) violations.push(violation)
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file))
}

function report(violations: ImplementationArtifactsViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-implementation-artifacts-symlinks: every file under implementation-artifacts/ is a ' +
        'real symlink or an explicitly allow-listed local-only artifact — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: found file(s) under _bmad-output/implementation-artifacts/ that are neither a real ' +
      "symlink into project-vault-private nor on this script's ALLOWED_NON_SYMLINK_FILES " +
      'allow-list:\n\n'
  )
  for (const v of violations) {
    if (v.reason === 'not-a-symlink') {
      process.stderr.write(`  - ${v.file}: plain regular file, not a symlink\n`)
    } else {
      process.stderr.write(`  - ${v.file}: dangling symlink (target does not exist: ${v.target})\n`)
    }
  }
  process.stderr.write(
    '\nFix: either replace the file with a real symlink to its project-vault-private counterpart ' +
      '(creating that counterpart first if it does not yet exist), fix the dangling symlink to ' +
      'point at a real file, or — only if this is a genuinely intentional, documented local-only ' +
      'artifact — add it to ALLOWED_NON_SYMLINK_FILES in ' +
      'scripts/check-implementation-artifacts-symlinks.ts with a one-line rationale.\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanImplementationArtifactsSymlinks())
}
