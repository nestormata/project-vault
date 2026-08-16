import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Story 23.2 AC-19 — the native-credential surface is derived by a procedure (five predicates)
 * and enforced by CI, not maintained by hand. This module implements the sweep half of that
 * procedure; `scripts/check-native-credential-surface.ts` is the thin CLI wrapper and
 * `apps/api/src/modules/auth/native-credential-surface.json` is the checked-in manifest.
 *
 * Scope, deliberately stated because a narrow scope was the original (2026-08-12) defect: every
 * `.ts` file under `apps/api/src/**`, every package's `src/**`, `fixtures/**`, and `scripts/**` —
 * excluding `node_modules`, build output (`dist`), and Drizzle's generated migration snapshots
 * (`packages/db/src/migrations/meta/**`, which repeat `"password_hash"` as a JSON schema field
 * name in every historical snapshot — noise, not a credential-surface hit).
 *
 * Documented simplification (recorded here, not hidden): test files (`*.test.ts`) and
 * `__tests__/helpers/**` are excluded from THIS scan entirely, rather than swept-and-classified
 * `test-only` as AC-19's prose describes. Tracking every test fixture's use of `passwordHash: 'x'`
 * would make the manifest's signal-to-noise ratio worse, not better, for the specific defect this
 * guard exists to catch (an unlisted *production* credential path). If a test helper's insert
 * pattern needs first-class tracking, add it explicitly — see the P5 sso-qa.ts entries, which
 * ARE tracked because `apps/api/src/scripts/sso-qa.ts` is a production script, not a test file.
 */

export type Predicate = 'P1' | 'P2' | 'P3' | 'P4' | 'P5'

export type SurfaceHit = {
  path: string
  line: number
  predicate: Predicate
  text: string
}

export type SurfaceManifestEntry = {
  path: string
  line: number
  predicate: Predicate
  symbol: string
  reachableRoute?: string
  classification: 'gate' | 'must-remain-functional' | 'bespoke' | 'non-runtime' | 'test-only'
  ac: string
}

const SCAN_ROOTS = ['apps/api/src', 'packages', 'fixtures', 'scripts']

const EXCLUDED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/migrations/meta/',
  '/.turbo/',
  '/coverage/',
  // The guard's own implementation necessarily quotes every predicate's symbol names in string
  // literals and regex source — excluded so the guard does not perpetually flag itself.
  '/scripts/lib/native-credential-surface-scan.ts',
  '/scripts/lib/check-native-credential-surface.ts',
  '/scripts/check-native-credential-surface.ts',
]

const PREDICATE_PATTERNS: Record<Predicate, RegExp[]> = {
  P1: [/\bverifyUserPassword\b/, /\bverifyPassword\(/],
  P2: [
    /\bpasswordHash\s*:/,
    /\bhashUserPassword\b/,
    /\bgenerateUnusablePasswordHash\b/,
    /password_hash/,
  ],
  P3: [
    /insert\(accountRecoveryTokens\)/,
    /\bcreateRecoveryToken\b/,
    /\bissueNewOwnerRecoveryLink\b/,
    /\bsendAdminRecoveryLink\b/,
    /account_recovery_tokens/,
  ],
  P4: [
    /\bfindRecoveryTokenByHash\b/,
    /\bhashRecoveryToken\b/,
    /\bsupersedePriorRecoveryTokens\b/,
    /\bcompleteAccountRecovery\b/,
    /\bpeekRecoveryToken\b/,
    /\bstartRecoveryMfa\b/,
  ],
  P5: [/insert\(users\)/, /INSERT INTO users/],
}

function isExcluded(absPath: string): boolean {
  return EXCLUDED_PATH_SEGMENTS.some((segment) => absPath.includes(segment))
}

function isTestFile(relPath: string): boolean {
  return relPath.endsWith('.test.ts') || relPath.includes('__tests__/helpers/')
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (isExcluded(full)) continue
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (stat.isFile() && full.endsWith('.ts')) {
      out.push(full)
    }
  }
}

/**
 * Runs the P1-P5 sweep over `SCAN_ROOTS` relative to `repoRoot`, returning every hit with a
 * `path:line`. Test files are excluded (see the module doc comment).
 */
export function scanNativeCredentialSurface(repoRoot: string): SurfaceHit[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root), files)

  const hits: SurfaceHit[] = []
  for (const absPath of files) {
    const relPath = relative(repoRoot, absPath).split('\\').join('/')
    if (isTestFile(relPath)) continue
    // absPath is derived from a directory walk of this repo's own tracked source tree, not
    // attacker-controlled input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const lines = readFileSync(absPath, 'utf-8').split('\n')
    lines.forEach((lineText, index) => {
      for (const predicate of Object.keys(PREDICATE_PATTERNS) as Predicate[]) {
        if (PREDICATE_PATTERNS[predicate].some((pattern) => pattern.test(lineText))) {
          hits.push({ path: relPath, line: index + 1, predicate, text: lineText.trim() })
        }
      }
    })
  }
  return hits
}

export const NATIVE_CREDENTIAL_SURFACE_CLASSIFICATIONS: SurfaceManifestEntry['classification'][] = [
  'gate',
  'must-remain-functional',
  'bespoke',
  'non-runtime',
  'test-only',
]

/** Files known to wire the shared native-login gate — the coarse cross-check for
 * `classification: 'gate'` manifest entries (AC-19 §3's fourth failure mode). Membership means
 * "this file calls the gate somewhere", not "this exact line is gated" — a file-level, not
 * line-level, guarantee, stated as a limitation rather than overclaimed. */
export function fileWiresNativeLoginGate(repoRoot: string, relPath: string): boolean {
  const absPath = join(repoRoot, relPath)
  let content: string
  try {
    // relPath is manifest-controlled (checked-in JSON, not request input).
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    content = readFileSync(absPath, 'utf-8')
  } catch {
    return false
  }
  return (
    content.includes('isNativeLoginEnabled()') ||
    content.includes('rejectIfNativeLoginDisabled') ||
    content.includes('nativeCredentialGatePreHandler')
  )
}
