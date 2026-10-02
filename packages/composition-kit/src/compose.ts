import { apply, persistAcceptances } from './apply.js'
import { lockDifference } from './lock.js'
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
  const difference = lockDifference(composed.existingLock, composed.lock)
  return difference === ''
    ? []
    : [`composition.lock.json is out of date; run pv-compose and commit the lock\n${difference}`]
}

/** Plans, then (unless `dryRun` or `check`) writes. `check` uses the plan only, so CI can verify a
 * lock without regenerating a tree. */
export async function compose(options: RunOptions): Promise<ComposeResult> {
  const log = options.log ?? (() => undefined)
  const composed = await plan(options)
  const messages = acceptanceMessages(composed)
  if (composed.problems.length > 0) {
    if (persistAcceptances(composed.lockPath, composed.accepted)) {
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
  const started = Date.now()
  log('pv-compose: copy')
  apply(composed, options.appRoot)
  const s = composed.summary
  log(
    `pv-compose: done: ${s.overrides} overrides, ${s.additions} additions, ${s.removals} removals, ${s.replacements} replacements, ${s.notes} notes, ${s.files} files, ${Date.now() - started} ms`
  )
  return { plan: composed, ok: true, written: true, messages }
}
