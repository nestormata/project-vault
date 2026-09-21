#!/usr/bin/env tsx
/**
 * Story 20.14 — hard stop on the *same* epic deferring its own retrospective across multiple of
 * its own subsequent story closures. `epic-20-retro-2026-09-21.md`'s Gap & Risk Audit Critical
 * Finding 1 diagnosed the gap directly: sprint-status.yaml recorded a free-text "retro now due"
 * note after 20-11's closure (2026-09-04), then again after 20-12's closure (2026-09-20) —
 * 16 days apart, both ignored until 20-13 finally triggered the round-4 retro. No existing guard
 * (`pick-story`'s A0, `my-epic-retro`'s Step 1.3/1.4) is positioned to catch this shape, since
 * both compare a story's/retro's epic against a *different* epic, never against itself over time.
 *
 * A new structured `epic-<N>-retro-pending-closures: <count>` key (same convention family as
 * `epic-<N>-gate`, see `check-epic-gate.ts`) records how many "last story in the epic, retro not
 * run" closures have fired without an intervening retro. `pick-story`'s Path C4 increments it when
 * the user defers the retro; `my-epic-retro`'s retro-completion step clears it. This script only
 * ever reads and reports on whatever value is already in `sprint-status.yaml` — it trusts the
 * counter, it does not second-guess it or recompute epic story history itself (same design
 * principle as `check-epic-gate.ts`).
 *
 * A count of `1` is tolerated (an occasional single deferral is common and often reasonable) and
 * only surfaced as a non-blocking `WARN:`. A count of `2` or more is an unconditional hard block —
 * no waiver, no override (AC-4): an epic self-deferring its own retro twice in a row has no
 * legitimate reason to stay unresolved.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'

export type RetroFreshnessViolation = {
  epicNum: string
  epicKey: string
  count: number
}

export type RetroFreshnessWarning = {
  epicNum: string
  epicKey: string
  value: string
  kind: 'pending-one' | 'malformed'
  count?: number
}

export type RetroFreshnessScanResult = {
  violations: RetroFreshnessViolation[]
  warnings: RetroFreshnessWarning[]
}

/**
 * Matches the counter key itself, e.g. `epic-20-retro-pending-closures`, capturing the epic
 * number. Anchored on the full, literal `-retro-pending-closures` suffix (and the leading
 * `epic-<digits>-` prefix) so it can never be confused with `epic-<N>-gate` or
 * `epic-<N>-retrospective` — a loose substring match would risk exactly that key-name collision
 * (AC-1's "key-name collision safety" edge case), mirroring `check-epic-gate.ts`'s own anchored,
 * non-substring epic-number matching.
 */
const RETRO_PENDING_KEY_PATTERN = /^epic-(\d+)-retro-pending-closures$/

/**
 * A well-formed counter value is a plain non-negative integer token, e.g. `2`. Anything else —
 * non-numeric (`abc`) or negative (`-1`) — is malformed: AC-2's edge case requires both to be
 * treated identically as a non-blocking parse warning, never silently coerced to `0`.
 */
const WELL_FORMED_COUNT_PATTERN = /^\d+$/

export function scanEpicRetroFreshness(rootDir = process.cwd()): RetroFreshnessScanResult {
  const root = resolve(rootDir)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return { violations: [], warnings: [] }

  const violations: RetroFreshnessViolation[] = []
  const warnings: RetroFreshnessWarning[] = []

  for (const [key, value] of sprintStatuses) {
    const keyMatch = RETRO_PENDING_KEY_PATTERN.exec(key)
    if (!keyMatch) continue
    const epicNum = keyMatch[1] as string

    if (!WELL_FORMED_COUNT_PATTERN.test(value)) {
      warnings.push({ epicNum, epicKey: key, value, kind: 'malformed' })
      continue
    }

    const count = Number(value)
    if (count === 0) continue // absent-equivalent — nothing pending, not flagged
    if (count === 1) {
      warnings.push({ epicNum, epicKey: key, value, kind: 'pending-one', count })
      continue
    }

    violations.push({ epicNum, epicKey: key, count })
  }

  violations.sort((a, b) => Number(a.epicNum) - Number(b.epicNum))
  warnings.sort((a, b) => Number(a.epicNum) - Number(b.epicNum))
  return { violations, warnings }
}

function report({ violations, warnings }: RetroFreshnessScanResult): void {
  for (const w of warnings) {
    if (w.kind === 'malformed') {
      process.stdout.write(
        `WARN: check-epic-retro-freshness: ${w.epicKey}: ${w.value} — non-numeric or negative ` +
          'value; treated as a parse warning, not coerced to 0 and not a hard failure, but a ' +
          "corrupted structured field is itself worth a human's attention.\n"
      )
      continue
    }
    process.stdout.write(
      `WARN: check-epic-retro-freshness: ${w.epicKey}: ${w.count} — epic ${w.epicNum}'s ` +
        'retrospective has been deferred once. Informational only (not yet a build failure) — a ' +
        'second consecutive miss will hard-block CI.\n'
    )
  }

  if (violations.length === 0) {
    process.stdout.write(
      'check-epic-retro-freshness: no epic has deferred its own retrospective twice — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: an epic has deferred its own retrospective across 2 or more of its own subsequent\n' +
      'story closures (Story 20.14 enforcement):\n\n'
  )
  for (const v of violations) {
    process.stderr.write(
      `  - epic-${v.epicNum} is at ${v.epicKey}: ${v.count} (>= 2) — retro is now hard-overdue\n` +
        '    Remediation — do exactly one of:\n' +
        `      1. Run \`my-epic-retro ${v.epicNum}\` now — the counter clears automatically on completion.\n` +
        '      2. If the counter itself is wrong (e.g. a stale/erroneous value), fix it directly\n' +
        '         in sprint-status.yaml — this script trusts the counter, it does not second-guess\n' +
        '         it.\n' +
        '      3. Never suppress, ignore-list, or hand-edit the counter down just to unblock CI\n' +
        "         without actually running the retro — per AGENTS.md's quality-gate policy,\n" +
        '         treating this hard block as an obstacle to route around requires expert\n' +
        "         consultation and Nestor's explicit sign-off, the same as any other CI-enforced\n" +
        '         quality gate.\n'
    )
  }
  process.stderr.write('\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanEpicRetroFreshness())
}
