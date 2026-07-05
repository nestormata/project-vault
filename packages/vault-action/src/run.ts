import * as core from '@actions/core'
import { createVaultAgent } from '@project-vault/agent'
import { parseSecrets, type ParsedSecretEntry } from './parse-secrets.js'
import { isVaultUnreachable, perEntryMessage, reasonTokenFor } from './classify.js'
import { withTimeout } from './with-timeout.js'

type Failure = {
  credentialName: string
  message: string
  reasonToken: string
}

/** AC-6 — masks the full value plus each non-empty line, so a multi-line secret (e.g. a PEM key)
 * emitted piecemeal by a later log line is still redacted, not just a verbatim reproduction. */
function maskValue(value: string): void {
  core.setSecret(value)
  for (const line of value.split('\n')) {
    if (line.length > 0) core.setSecret(line)
  }
}

/** AC-9 — a single failure in a class uses its own verbose message; two or more use the terse
 * "N of M secrets failed to retrieve: NAME (reason), ..." aggregate form. */
function buildSummary(failures: Failure[], total: number): string {
  const first = failures[0]
  if (failures.length === 1 && first) return first.message
  const list = failures.map((f) => `${f.credentialName} (${f.reasonToken})`).join(', ')
  return `${failures.length} of ${total} secrets failed to retrieve: ${list}`
}

async function retrieveEntry(
  agent: { getSecret: (name: string) => Promise<string> },
  entry: ParsedSecretEntry,
  vaultUrl: string
): Promise<{ ok: true } | { ok: false; failure: Failure; vaultUnreachable: boolean }> {
  core.debug(
    `Retrieving credential '${entry.credentialName}' as '${entry.envVarName}' from project ${entry.projectId}`
  )
  try {
    const value = await withTimeout(() => agent.getSecret(entry.credentialName))
    maskValue(value)
    core.exportVariable(entry.envVarName, value)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      vaultUnreachable: isVaultUnreachable(error),
      failure: {
        credentialName: entry.credentialName,
        message: perEntryMessage(entry.credentialName, entry.projectId, vaultUrl, error),
        reasonToken: reasonTokenFor(error),
      },
    }
  }
}

/**
 * AC-10 — reading and masking the api-key must be the very first statement of substance in the
 * entry point: mask the key before any other action code runs, so it is redacted from log output
 * on every subsequent code path, including one added by a future edit that logs earlier than
 * intended. Returns null (having already called setFailed) if the input is missing.
 */
function readAndMaskApiKey(): string | null {
  try {
    const apiKey = core.getInput('api-key', { required: true })
    core.setSecret(apiKey)
    return apiKey
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
    return null
  }
}

/** AC-7 edge case — a typo'd continue-on-error value is caught and converted into a clean setFailed(). */
function readContinueOnError(): boolean | null {
  const raw = core.getInput('continue-on-error')
  try {
    return core.getBooleanInput('continue-on-error')
  } catch {
    core.setFailed(`Invalid 'continue-on-error' value '${raw}' — must be 'true' or 'false'`)
    return null
  }
}

function readVaultUrlAndSecrets(): { vaultUrl: string; secretsInput: string } | null {
  try {
    return {
      vaultUrl: core.getInput('vault-url', { required: true }),
      secretsInput: core.getInput('secrets', { required: true }),
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
    return null
  }
}

async function attemptAllEntries(
  agent: { getSecret: (name: string) => Promise<string> },
  entries: ParsedSecretEntry[],
  vaultUrl: string
): Promise<{ vaultUnreachableFailures: Failure[]; applicationFailures: Failure[] }> {
  const vaultUnreachableFailures: Failure[] = []
  const applicationFailures: Failure[] = []

  // AC-9/D4 — every entry is always attempted, regardless of any earlier entry's outcome.
  for (const entry of entries) {
    const result = await retrieveEntry(agent, entry, vaultUrl)
    if (result.ok) continue
    const bucket = result.vaultUnreachable ? vaultUnreachableFailures : applicationFailures
    bucket.push(result.failure)
  }

  return { vaultUnreachableFailures, applicationFailures }
}

/** D4 — the two failure classes are tracked and reported independently: vault-unreachable follows
 * `continue-on-error`; application-level failures always hard-fail the step. */
function reportOutcome(
  vaultUnreachableFailures: Failure[],
  applicationFailures: Failure[],
  totalEntries: number,
  continueOnError: boolean
): void {
  if (vaultUnreachableFailures.length > 0) {
    const summary = buildSummary(vaultUnreachableFailures, totalEntries)
    if (continueOnError) {
      core.warning(`${summary} — continuing because continue-on-error is true`)
    } else {
      core.setFailed(summary)
    }
  }

  if (applicationFailures.length > 0) {
    core.setFailed(buildSummary(applicationFailures, totalEntries))
  }
}

export async function run(): Promise<void> {
  const apiKey = readAndMaskApiKey()
  if (apiKey === null) return

  const continueOnError = readContinueOnError()
  if (continueOnError === null) return

  const inputs = readVaultUrlAndSecrets()
  if (!inputs) return
  const { vaultUrl, secretsInput } = inputs

  const parsed = parseSecrets(secretsInput)
  if (!parsed.ok) {
    core.setFailed(parsed.error)
    return
  }

  // D2 — one agent per invocation, reused across every parsed entry (one token exchange, not one
  // per secret). fallbackThreshold: 1 makes 7.2's own fallback-state machine short-circuit to
  // cache-only lookups for every entry after the first vault-unreachable classification (AC-8's
  // sustained-outage edge case), without vault-action needing to duplicate that logic itself.
  const agent = createVaultAgent({
    apiKey,
    baseUrl: vaultUrl,
    projectId: parsed.projectId,
    fallbackThreshold: 1,
  })

  const { vaultUnreachableFailures, applicationFailures } = await attemptAllEntries(
    agent,
    parsed.entries,
    vaultUrl
  )

  reportOutcome(
    vaultUnreachableFailures,
    applicationFailures,
    parsed.entries.length,
    continueOnError
  )
}
