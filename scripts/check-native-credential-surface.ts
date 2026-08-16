#!/usr/bin/env tsx
/**
 * Story 23.2 AC-19 — this guard exists specifically because two hand-written "complete"
 * native-credential-surface lists were both wrong: v1 was read from `routes.ts` alone and missed
 * live password verification in `credential-shares`; v2 was grepped for password *verification*
 * and structurally could not find token *issuance* (`POST
 * /org/users/:userId/recovery/send-link`). This re-runs the five-predicate derivation over the
 * live tree and fails the build the moment the checked-in manifest and the tree disagree.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  checkNativeCredentialSurface,
  formatFailure,
} from './lib/check-native-credential-surface.js'
import type { SurfaceManifestEntry } from './lib/native-credential-surface-scan.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/src/modules/auth/native-credential-surface.json')

function main(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as SurfaceManifestEntry[]
  const failures = checkNativeCredentialSurface(REPO_ROOT, manifest)

  if (failures.length === 0) {
    process.stdout.write(
      `check-native-credential-surface: ${manifest.length} manifest entries verified against the live tree — OK\n`
    )
    return
  }

  process.stderr.write(
    `FATAL: native-credential-surface guard found ${failures.length} problem(s):\n`
  )
  for (const failure of failures) {
    process.stderr.write(`  - ${formatFailure(failure)}\n`)
  }
  process.exitCode = 1
}

main()
