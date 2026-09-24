import { parseStrictSemver } from './semver-precedence.js'

/**
 * Story 43.6 — strict, hand-written validator for `GET /api/v1/client-version-policy`'s
 * `data.clients.cli` (no Zod dependency in the distributed CLI). All-or-nothing: one bad field or
 * one bad withdrawn entry invalidates the whole response, which the caller then treats exactly
 * like "unreachable". Only the fields this CLI reads are validated; unknown extra fields (other
 * clients, a newer `schemaVersion`, a `downloadUrl`) are ignored and never copied out.
 */
export type WithdrawnCliVersion = { version: string; reason: string }

export type CliVersionPolicy = {
  current: string | null
  minimumSupported: string | null
  withdrawn: WithdrawnCliVersion[]
}

export const MAX_POLICY_BODY_BYTES = 16 * 1024
export const MAX_WITHDRAWN_ENTRIES = 100
export const MAX_REASON_CODE_POINTS = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableSemver(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && parseStrictSemver(value) !== null)
}

function validateWithdrawnEntry(value: unknown): WithdrawnCliVersion | null {
  if (!isRecord(value)) return null
  const { version, reason } = value
  if (typeof version !== 'string' || parseStrictSemver(version) === null) return null
  if (reason === undefined || reason === null) return { version, reason: '' }
  if (typeof reason !== 'string' || [...reason].length > MAX_REASON_CODE_POINTS) return null
  return { version, reason }
}

/** Validates an already-parsed `clients.cli` object (also used to re-validate cached policies). */
export function validateCliVersionPolicy(value: unknown): CliVersionPolicy | null {
  if (!isRecord(value)) return null
  const { current, minimumSupported, withdrawn } = value
  if (!isNullableSemver(current) || !isNullableSemver(minimumSupported)) return null
  if (!Array.isArray(withdrawn) || withdrawn.length > MAX_WITHDRAWN_ENTRIES) return null
  const entries: WithdrawnCliVersion[] = []
  for (const raw of withdrawn) {
    const entry = validateWithdrawnEntry(raw)
    if (entry === null) return null
    entries.push(entry)
  }
  return { current, minimumSupported, withdrawn: entries }
}

/** Parses the raw response body; `null` for anything malformed. */
export function parseCliVersionPolicyBody(body: string): CliVersionPolicy | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed['data'])) return null
  const clients = parsed['data']['clients']
  if (!isRecord(clients)) return null
  return validateCliVersionPolicy(clients['cli'])
}
