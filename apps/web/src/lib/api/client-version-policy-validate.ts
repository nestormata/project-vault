// Story 43.7 AC-2 (D3): hand-written, all-or-nothing validation of the public
// GET /api/v1/client-version-policy body. `apps/web` has no zod, and a half-accepted policy could
// render "No pvault versions are withdrawn" for a malformed list, so any failing field rejects
// the whole body. It checks types and display-safety caps only — never semver syntax (the API
// refuses to boot on values the CLI would reject; a third semver parser would be a drift risk).
import type { CliVersionPolicy } from './platform.js'

// Mirrors apps/api/src/modules/client-versions/policy.ts CLI_MAX_* caps.
const MAX_VERSION_LENGTH = 128
const MAX_WITHDRAWN_ENTRIES = 100
const MAX_REASON_CODE_POINTS = 200

type WithdrawnEntry = CliVersionPolicy['cli']['withdrawn'][number]

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_LENGTH
}

function isNullableVersion(value: unknown): value is string | null {
  return value === null || isVersionString(value)
}

function parseServer(value: unknown): CliVersionPolicy['server'] | null {
  const server = asRecord(value)
  if (!server || !isVersionString(server.version)) return null
  const { versionSource } = server
  if (versionSource !== 'release' && versionSource !== 'development') return null
  return { version: server.version, versionSource }
}

function parseWithdrawnEntry(value: unknown): WithdrawnEntry | null {
  const entry = asRecord(value)
  if (!entry || !isVersionString(entry.version)) return null
  const { reason } = entry
  // Code points, not UTF-16 units: an astral character counts once, as it does in the API.
  if (typeof reason !== 'string' || [...reason].length > MAX_REASON_CODE_POINTS) return null
  return { version: entry.version, reason }
}

function parseWithdrawn(value: unknown): WithdrawnEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_WITHDRAWN_ENTRIES) return null
  const entries: WithdrawnEntry[] = []
  for (const item of value) {
    const entry = parseWithdrawnEntry(item)
    if (!entry) return null
    entries.push(entry)
  }
  return entries
}

function parseCli(value: unknown): CliVersionPolicy['cli'] | null {
  const cli = asRecord(value)
  if (!cli) return null
  const { current, minimumSupported } = cli
  if (!isNullableVersion(current) || !isNullableVersion(minimumSupported)) return null
  const withdrawn = parseWithdrawn(cli.withdrawn)
  if (!withdrawn) return null
  return { current, minimumSupported, withdrawn }
}

/**
 * Returns a fresh object built only from the checked fields (never the parsed body spread), or
 * `null` when anything fails. `schemaVersion` and unknown keys (e.g. `clients.extension`) are
 * deliberately ignored for forward compatibility, as the CLI does.
 */
export function parseClientVersionPolicyBody(body: unknown): CliVersionPolicy | null {
  const data = asRecord(asRecord(body)?.data)
  if (!data) return null
  const server = parseServer(data.server)
  const cli = parseCli(asRecord(data.clients)?.cli)
  if (!server || !cli) return null
  return { server, cli }
}
