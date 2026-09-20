#!/usr/bin/env tsx
/**
 * Story 42.2 — audit-ci.jsonc config-hygiene gate, rewritten to match audit-ci's REAL config
 * schema (see this story's Dev Agent Record / Root-Cause Finding for the full investigation).
 *
 * `audit-ci.jsonc`'s severity keys (`high`/`critical`/`moderate`/`low`) are booleans that tell
 * audit-ci which severity-or-above to gate on. The actual suppression mechanism is the separate
 * `allowlist` array, whose entries are either a bare string (module/advisory/path id) or an
 * NSPRecord object mapping that same id to `{ active?, notes?, expiry? }`
 * (node_modules/audit-ci/dist/index.d.ts). This script validates that `allowlist`, not the old,
 * non-standard per-severity-array shape the pre-42.2 version of this file checked.
 *
 * Design decisions made for this repo (Story 42.2 — no existing precedent to follow):
 * - Bare-string allowlist entries are REJECTED. audit-ci itself accepts them, but every
 *   suppression in this repo must carry a non-expired `expiry` and non-empty `notes` so it stays
 *   auditable and time-boxed; a bare string has neither.
 * - No separate "max 90 days from acknowledgement" cap is enforced. The pre-42.2 audit-ci.jsonc
 *   comment claimed this, but the pre-42.2 version of this script never actually checked it (it
 *   only compared `expiry` against "today", an unbounded max) and the allowlist was empty at the
 *   time, so there was nothing to migrate. NSPRecord also has no built-in "acknowledged" date to
 *   measure 90 days from. This script enforces only "has a non-expired `expiry`"; the 90-day
 *   claim has been removed from audit-ci.jsonc's own comments in the same change.
 * - audit-ci's own `active` field IS honored: `active: false` marks a suppression as registered
 *   but not currently applied, so it's exempt from the `notes`/`expiry` hygiene checks below —
 *   there's nothing live to keep time-boxed.
 * - A missing or malformed `audit-ci.jsonc` fails closed (reported as a violation), matching this
 *   repo's other `check-*.ts` scripts' fail-closed-on-missing-input convention.
 *
 * Pure, DB-free: a static read of `audit-ci.jsonc` under the given root.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type AuditBaselineViolation = {
  entryKey: string
  reason: string
}

export type AuditBaselineResult = {
  violations: AuditBaselineViolation[]
}

type NSPContent = {
  active?: unknown
  notes?: unknown
  expiry?: unknown
}

function stripJsonComments(content: string): string {
  return content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function validateNSPContent(
  entryKey: string,
  content: NSPContent,
  today: Date
): AuditBaselineViolation[] {
  // Design decision (Story 42.2): `active: false` entries are intentionally dormant — skip
  // hygiene checks entirely.
  if (content.active === false) return []

  const violations: AuditBaselineViolation[] = []

  if (typeof content.notes !== 'string' || content.notes.trim() === '') {
    violations.push({ entryKey, reason: 'missing or empty "notes"' })
  }

  if (content.expiry === undefined) {
    violations.push({ entryKey, reason: 'missing "expiry"' })
  } else {
    const expiryDate = new Date(content.expiry as string | number)
    if (Number.isNaN(expiryDate.getTime())) {
      violations.push({
        entryKey,
        reason: `"expiry" is not a parseable date: ${JSON.stringify(content.expiry)}`,
      })
    } else if (expiryDate < today) {
      violations.push({ entryKey, reason: `"expiry" has passed: ${String(content.expiry)}` })
    }
  }

  return violations
}

/** Reads and JSON(C)-parses `<root>/audit-ci.jsonc`, or a synthetic failure result if it can't be. */
function loadAuditCiConfig(
  root: string
): { config: { allowlist?: unknown } } | { violation: AuditBaselineViolation } {
  const auditCiPath = resolve(root, 'audit-ci.jsonc')

  let raw: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is caller-controlled (tests pass a fixture dir, production passes cwd), never user input
    raw = readFileSync(auditCiPath, 'utf-8')
  } catch {
    return {
      violation: { entryKey: '<file>', reason: `audit-ci.jsonc not found at ${auditCiPath}` },
    }
  }

  try {
    return { config: JSON.parse(stripJsonComments(raw)) as { allowlist?: unknown } }
  } catch (err) {
    return {
      violation: {
        entryKey: '<file>',
        reason: `audit-ci.jsonc is not valid JSON(C): ${(err as Error).message}`,
      },
    }
  }
}

/** Validates one raw `allowlist` array entry (bare string or NSPRecord object). */
function validateAllowlistEntry(entry: unknown, now: Date): AuditBaselineViolation[] {
  if (typeof entry === 'string') {
    return [
      {
        entryKey: entry,
        reason:
          'bare-string allowlist entries are not permitted in this repo — use the NSPRecord ' +
          `object form ({ "${entry}": { "expiry": "...", "notes": "..." } }) instead`,
      },
    ]
  }

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [
      {
        entryKey: JSON.stringify(entry),
        reason: 'allowlist entry is neither a string nor an NSPRecord object',
      },
    ]
  }

  const violations: AuditBaselineViolation[] = []
  for (const [entryKey, content] of Object.entries(entry as Record<string, unknown>)) {
    if (typeof content !== 'object' || content === null) {
      violations.push({ entryKey, reason: 'NSPRecord entry value must be an object' })
      continue
    }
    violations.push(...validateNSPContent(entryKey, content as NSPContent, now))
  }
  return violations
}

/** Validates `<root>/audit-ci.jsonc` against audit-ci's real `allowlist` (NSPRecord) schema. */
export function scanAuditBaseline(root: string, now: Date = new Date()): AuditBaselineResult {
  const loaded = loadAuditCiConfig(root)
  if ('violation' in loaded) return { violations: [loaded.violation] }

  const { allowlist } = loaded.config
  if (allowlist === undefined) {
    // `allowlist` is optional in audit-ci's own schema — nothing to validate.
    return { violations: [] }
  }
  if (!Array.isArray(allowlist)) {
    return {
      violations: [{ entryKey: '<file>', reason: 'audit-ci.jsonc "allowlist" must be an array' }],
    }
  }

  const violations = (allowlist as unknown[]).flatMap((entry) => validateAllowlistEntry(entry, now))
  return { violations }
}

function report(result: AuditBaselineResult): void {
  if (result.violations.length === 0) {
    process.stdout.write('audit-ci.jsonc baseline check passed\n')
    return
  }

  process.stderr.write('FATAL: audit-ci.jsonc allowlist hygiene check failed:\n\n')
  for (const v of result.violations) {
    process.stderr.write(`  - ${v.entryKey}: ${v.reason}\n`)
  }
  process.stderr.write('\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanAuditBaseline(process.cwd()))
}
