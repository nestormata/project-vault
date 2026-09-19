#!/usr/bin/env tsx
/**
 * Story 42.0 — Epic 42 → Epic 51 crypto-assurance gate enforcement, and the belt to
 * `pick-story`'s own suspenders (its new "Step 0.6: Check Epic Gates" step prevents the mistake
 * proactively; this script catches it if `pick-story` was bypassed entirely — manual edits, a
 * different tool, human error).
 *
 * A gate key (`epic-<N>-gate: blocked-on-<epic>-<story>` in `sprint-status.yaml`'s
 * `development_status:` block) names a story that must be `done` before any story under the
 * gated epic `N` may advance past `backlog`. Satisfaction is always DERIVED from the named
 * blocking story's own `development_status` entry — never a manually-edited `satisfied` token
 * (see Story 42.0's Dev Notes: a two-state flag reintroduces exactly the "convention-policed,
 * silently ignored" failure class this gate exists to close, one level down).
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'

export type EpicGateViolation = {
  storyKey: string
  storyStatus: string
  gateKey: string
  blockingStoryKey: string
  blockingStatus: string
}

export type EpicGateWarning = {
  gateKey: string
  value: string
  reason: string
}

export type EpicGateScanResult = {
  violations: EpicGateViolation[]
  warnings: EpicGateWarning[]
}

/** Matches a gate key itself, e.g. `epic-51-gate`, capturing the gated epic number. */
const GATE_KEY_PATTERN = /^epic-(\d+)-gate$/

/**
 * Matches a well-formed gate value, e.g. `blocked-on-42-4`, capturing the blocking story's epic
 * and story numbers. There is no `satisfied` token by design (satisfaction is always derived) —
 * any other value is malformed.
 */
const GATE_VALUE_PATTERN = /^blocked-on-(\d+)-(\d+)$/

/**
 * Matches a real story key's leading `<epic>-<story>-` numeric prefix, e.g. `51-1-` out of
 * `51-1-fixture-story`. A static (never dynamically constructed) pattern — the gated epic number
 * is compared against the captured group in code, not interpolated into a new RegExp, so a
 * gated-epic number like `51` can never substring-match a story key like `151-1-...`.
 */
const STORY_KEY_EPIC_PREFIX_PATTERN = /^(\d+)-\d+-/

/** The epic number a story key belongs to, or undefined if `key` isn't shaped like a story key. */
function storyKeyEpicNumber(key: string): string | undefined {
  return STORY_KEY_EPIC_PREFIX_PATTERN.exec(key)?.[1]
}

type ResolvedGate = { blockingStoryKey: string; blockingStatus: string }

/**
 * Resolves a gate's `blocked-on-<epic>-<story>` value to the actual blocking story key and its
 * current status, or returns a warning reason if the value is malformed or names a story key with
 * no matching development_status entry (never registered, or a typo — AC6's edge case: both are
 * warnings, not build failures, since the script cannot tell them apart without human judgment).
 */
function resolveGate(
  value: string,
  sprintStatuses: Map<string, string>
): ResolvedGate | { warningReason: string } {
  const gateValueMatch = GATE_VALUE_PATTERN.exec(value)
  if (!gateValueMatch) {
    return {
      warningReason: `does not parse as "blocked-on-<epic>-<story>" (found "${value}") — cannot verify this gate; not failing the build over an unparseable value, but it is not protecting anything either.`,
    }
  }
  const [, blockingEpicNum, blockingStoryNum] = gateValueMatch

  // The gate value only carries the numeric pair (epic-story), not the full slug — the slug is
  // redundant with the numbers and can be typo'd/edited independently, so resolve the real key by
  // prefix match against development_status rather than trusting an embedded slug.
  const blockingKeyPrefix = `${blockingEpicNum}-${blockingStoryNum}-`
  const blockingStoryKey = [...sprintStatuses.keys()].find((k) => k.startsWith(blockingKeyPrefix))
  if (!blockingStoryKey) {
    return {
      warningReason: `names blocking story "${blockingEpicNum}-${blockingStoryNum}" but no development_status key starting with "${blockingKeyPrefix}" exists — either not yet registered (harmless, expected) or a typo (a real bug); cannot tell without human judgment, so this is a warning, not a build failure.`,
    }
  }

  return { blockingStoryKey, blockingStatus: sprintStatuses.get(blockingStoryKey) as string }
}

/**
 * Every story under `gatedEpicNum` that has advanced past `backlog` while `resolved`'s blocking
 * story is not `done` (creation was never gated — only pickup, i.e. advancing past `backlog` —
 * see AC1/AC6). Never flags the blocking story itself, even if it happens to also match the gated
 * epic's own prefix (edge case: a gate must never block the very story that satisfies it).
 */
function findGatedViolations(
  gatedEpicNum: string,
  gateKey: string,
  resolved: ResolvedGate,
  sprintStatuses: Map<string, string>
): EpicGateViolation[] {
  const violations: EpicGateViolation[] = []
  for (const [storyKey, storyStatus] of sprintStatuses) {
    if (storyKey === resolved.blockingStoryKey) continue
    if (storyKeyEpicNumber(storyKey) !== gatedEpicNum) continue
    if (storyStatus === 'backlog') continue

    violations.push({
      storyKey,
      storyStatus,
      gateKey,
      blockingStoryKey: resolved.blockingStoryKey,
      blockingStatus: resolved.blockingStatus,
    })
  }
  return violations
}

export function scanEpicGate(rootDir = process.cwd()): EpicGateScanResult {
  const root = resolve(rootDir)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return { violations: [], warnings: [] }

  const violations: EpicGateViolation[] = []
  const warnings: EpicGateWarning[] = []

  for (const [key, value] of sprintStatuses) {
    const gateKeyMatch = GATE_KEY_PATTERN.exec(key)
    if (!gateKeyMatch) continue
    const gatedEpicNum = gateKeyMatch[1] as string

    const resolved = resolveGate(value, sprintStatuses)
    if ('warningReason' in resolved) {
      warnings.push({ gateKey: key, value, reason: resolved.warningReason })
      continue
    }
    if (resolved.blockingStatus === 'done') continue // gate satisfied — nothing to flag

    violations.push(...findGatedViolations(gatedEpicNum, key, resolved, sprintStatuses))
  }

  violations.sort((a, b) => a.storyKey.localeCompare(b.storyKey))
  return { violations, warnings }
}

function report({ violations, warnings }: EpicGateScanResult): void {
  for (const w of warnings) {
    process.stdout.write(`WARN: check-epic-gate: ${w.gateKey}: ${w.value} — ${w.reason}\n`)
  }

  if (violations.length === 0) {
    process.stdout.write('check-epic-gate: all epic gates are respected — OK\n')
    return
  }

  process.stderr.write(
    'FATAL: story/stories under a gated epic have advanced past `backlog` while the gate blocking\n' +
      'them is not satisfied (Story 42.0 enforcement):\n\n'
  )
  for (const v of violations) {
    process.stderr.write(
      `  - ${v.storyKey} is "${v.storyStatus}", but ${v.gateKey} is blocked on ${v.blockingStoryKey}` +
        ` (currently "${v.blockingStatus}", not "done")\n` +
        '    Remediation — do exactly one of:\n' +
        `      1. Finish ${v.blockingStoryKey} first — the gate reads as satisfied automatically once it is "done".\n` +
        '      2. If this status change was intentional and the gate itself is wrong, fix the gate\n' +
        '         value directly in sprint-status.yaml — this script trusts the gate, it does not\n' +
        '         second-guess it.\n' +
        "      3. Never suppress or ignore-list this finding instead of fixing it — per AGENTS.md's\n" +
        "         quality-gate policy, an exception here requires expert consultation and Nestor's\n" +
        '         explicit sign-off.\n'
    )
  }
  process.stderr.write('\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanEpicGate())
}
