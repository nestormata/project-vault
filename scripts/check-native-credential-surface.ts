#!/usr/bin/env tsx
/**
 * Story 23.2 AC-19 — this guard exists specifically because two hand-written "complete"
 * native-credential-surface lists were both wrong: v1 was read from `routes.ts` alone and missed
 * live password verification in `credential-shares`; v2 was grepped for password *verification*
 * and structurally could not find token *issuance* (`POST
 * /org/users/:userId/recovery/send-link`). This re-runs the five-predicate derivation over the
 * live tree and fails the build the moment the checked-in manifest and the tree disagree.
 *
 * Story 40.2 — adds a `--write` flag (local-only; never wired into CI, see AC-9) that regenerates
 * `line` numbers on EXISTING manifest entries only, to remove the manual-hand-edit tax that
 * unrelated line-shifting code changes otherwise impose on this manifest. Without `--write`,
 * behavior is byte-for-byte unchanged from before this story (AC-1).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  checkNativeCredentialSurface,
  diffManifestAgainstHits,
  formatFailure,
} from './lib/check-native-credential-surface.js'
import { scanNativeCredentialSurface } from './lib/native-credential-surface-scan.js'
import type { SurfaceManifestEntry } from './lib/native-credential-surface-scan.js'
import { regenerateManifest } from './lib/native-credential-surface-regenerate.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/src/modules/auth/native-credential-surface.json')

export type CliRunResult = { stdout: string; stderr: string; exitCode: number }

/**
 * The plain check-only path. Parameterized by `manifestPath`/`repoRoot` so it can be exercised
 * against synthetic fixtures in tests without touching the real repo manifest (see AC-1's
 * regression-boundary requirement: this logic is unchanged from before Story 40.2).
 */
export function runCheckOnly(manifestPath: string, repoRoot: string): CliRunResult {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SurfaceManifestEntry[]
  const failures = checkNativeCredentialSurface(repoRoot, manifest)

  if (failures.length === 0) {
    return {
      stdout: `check-native-credential-surface: ${manifest.length} manifest entries verified against the live tree — OK\n`,
      stderr: '',
      exitCode: 0,
    }
  }

  let stderr = `FATAL: native-credential-surface guard found ${failures.length} problem(s):\n`
  for (const failure of failures) stderr += `  - ${formatFailure(failure)}\n`
  return { stdout: '', stderr, exitCode: 1 }
}

/**
 * Story 40.2 — `--write` mode. Regenerates `line` numbers for existing manifest entries only
 * (AC-3/AC-4/AC-5), self-verifying before it writes (AC-11), and reports old-line -> new-line per
 * changed entry plus a summary line and the underlying failures for any group left unresolved
 * (AC-7). Rewrites the manifest file only when at least one entry actually changed.
 */
export function runWrite(manifestPath: string, repoRoot: string): CliRunResult {
  const originalManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SurfaceManifestEntry[]
  const hits = scanNativeCredentialSurface(repoRoot)

  const {
    manifest: regeneratedManifest,
    changes,
    unresolvedGroupCount,
  } = regenerateManifest(repoRoot, originalManifest, hits)

  if (changes.length > 0) {
    // regeneratedManifest preserves the original array's element order and every field besides
    // `line` on regenerated entries — see AC-3 and the Pre-Mortem's formatting-fidelity mitigation.
    writeFileSync(manifestPath, `${JSON.stringify(regeneratedManifest, null, 2)}\n`)
  }

  let stdout = ''
  for (const change of changes) {
    stdout += `${change.path}:${change.oldLine} (${change.predicate}) -- line ${change.oldLine} -> ${change.newLine}\n`
  }

  let stderr = ''
  const remainingFailures = diffManifestAgainstHits(repoRoot, hits, regeneratedManifest)
  for (const failure of remainingFailures) stderr += `  - ${formatFailure(failure)}\n`

  stdout += `${changes.length} entries regenerated, ${unresolvedGroupCount} groups left unresolved (needs manual review)\n`

  return { stdout, stderr, exitCode: unresolvedGroupCount > 0 ? 1 : 0 }
}

function main(): void {
  const write = process.argv.includes('--write')
  const result = write ? runWrite(MANIFEST_PATH, REPO_ROOT) : runCheckOnly(MANIFEST_PATH, REPO_ROOT)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

// Only auto-run when executed directly (`tsx scripts/check-native-credential-surface.ts`), not
// when imported for testing — `runCheckOnly`/`runWrite` are exported precisely so tests can call
// them against synthetic fixtures without triggering a real run against this repo's own manifest.
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
