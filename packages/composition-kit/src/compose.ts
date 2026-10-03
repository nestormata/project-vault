import { apply, persistAcceptances } from './apply.js'
import { LOCKFILE_VERSION, driftedSections, lockDifference } from './lock.js'
import { plan, type ComposeOptions, type ComposePlan } from './plan.js'

export interface RunOptions extends ComposeOptions {
  /** Print the plan summary and write nothing. */
  dryRun?: boolean
  /** Fail when the committed lock differs from the regenerated one (normative sections only). */
  check?: boolean
}

export interface ComposeResult {
  plan: ComposePlan
  /** True when the run succeeded (exit 0). */
  ok: boolean
  written: boolean
  /** Everything to print, in order: problems first, then notes are available on the plan. */
  messages: string[]
}

function acceptanceMessages(composed: ComposePlan): string[] {
  return [
    ...composed.accepted.map(
      (entry) =>
        `accepted ${entry.key}: ${entry.oldSha256} -> ${entry.newSha256} (PV ${entry.hostVersion})`
    ),
    ...composed.alreadyAccepted.map((key) => `already accepted: ${key}`),
  ]
}

function checkMessages(composed: ComposePlan): string[] {
  if (composed.existingLock === undefined || composed.lock === undefined) {
    return [`no committed lock at ${composed.lockPath}; run pv-compose and commit it`]
  }
  const committedVersion = composed.existingLock.lockfileVersion
  if (committedVersion !== LOCKFILE_VERSION) {
    return [
      `composition.lock.json is lockfileVersion ${committedVersion} but this kit writes lockfileVersion ${LOCKFILE_VERSION}; run pv-compose and commit the lock (recomposing rewrites it)`,
    ]
  }
  const difference = lockDifference(composed.existingLock, composed.lock)
  if (difference === '') return []
  const sections = driftedSections(composed.existingLock, composed.lock).join(', ')
  return [
    `composition.lock.json is out of date (${sections}); run pv-compose and commit the lock\n${difference}`,
  ]
}

function logMigration(composed: ComposePlan, log: (line: string) => void): void {
  const committedVersion = composed.existingLock?.lockfileVersion
  if (committedVersion !== undefined && committedVersion !== LOCKFILE_VERSION) {
    log(
      `pv-compose: migrating composition.lock.json from lockfileVersion ${committedVersion} to ${LOCKFILE_VERSION}`
    )
  }
}

/** Plans, then (unless `dryRun` or `check`) writes. `check` uses the plan only, so CI can verify a
 * lock without regenerating a tree. */
export async function compose(options: RunOptions): Promise<ComposeResult> {
  const log = options.log ?? (() => undefined)
  const composed = await plan(options)
  const messages = acceptanceMessages(composed)
  if (composed.problems.length > 0) {
    // `--dry-run` and `--check` promise to write nothing, so they never persist an acceptance.
    const readOnly = options.dryRun === true || options.check === true
    if (!readOnly && persistAcceptances(composed.lockPath, composed.accepted)) {
      messages.push(
        'the accepted hashes were recorded in the committed lock; fix the remaining problems and run again'
      )
    }
    return {
      plan: composed,
      ok: false,
      written: false,
      messages: [...messages, ...composed.problems],
    }
  }
  if (options.check === true) {
    const failures = checkMessages(composed)
    return {
      plan: composed,
      ok: failures.length === 0,
      written: false,
      messages: [...messages, ...failures],
    }
  }
  if (options.dryRun === true) {
    log(`pv-compose: dry run, nothing written (${composed.summary.files} files planned)`)
    return { plan: composed, ok: true, written: false, messages }
  }
  logMigration(composed, log)
  const started = Date.now()
  log('pv-compose: copy')
  apply(composed, options.appRoot)
  const s = composed.summary
  log(
    `pv-compose: done: ${s.overrides} overrides, ${s.additions} additions, ${s.removals} removals, ${s.replacements} replacements, ${s.notes} notes, ${s.files} files, ${Date.now() - started} ms`
  )
  return { plan: composed, ok: true, written: true, messages }
}
