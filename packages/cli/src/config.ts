import { CliUsageError } from './exit-codes.js'

export type CliFlags = {
  apiKey?: string
  url?: string
  projectId?: string
}

export type ResolvedConfig = {
  apiKey: string
  baseUrl: string
  projectId: string
}

type EnvLike = Record<string, string | undefined>

/**
 * Dev Notes decision #2 — config resolution order for apiKey/baseUrl/projectId.
 *
 * Primary mechanism: environment variables, kept under the SAME `VAULT_*` prefix
 * `@project-vault/agent` itself already uses (`VAULT_CACHE_PATH`, `VAULT_FALLBACK_THRESHOLD`)
 * rather than inventing a second prefix — `VAULT_API_KEY`, `VAULT_URL`, `VAULT_PROJECT_ID`. This
 * is a deliberate divergence from epics.md's illustrative `PV_*` example commands (see this
 * story's Dev Agent Record); the binary itself is `pvault`, not `pv`, for the same reason (see
 * README's "Package/binary name" decision).
 *
 * An explicit CLI flag (`--api-key`/`--url`/`--project-id`) always overrides the corresponding
 * env var, so Story 43.2/43.3 can layer a stored session or other flags on the same precedence
 * without re-deciding it.
 *
 * A missing required value fails here, synchronously, before any network call — never as an
 * `undefined is not a function` surfacing from inside packages/agent.
 */
export function resolveConfig(flags: CliFlags, env: EnvLike = process.env): ResolvedConfig {
  const apiKey = flags.apiKey ?? env['VAULT_API_KEY']
  const baseUrl = flags.url ?? env['VAULT_URL']
  const projectId = flags.projectId ?? env['VAULT_PROJECT_ID']

  const missing: string[] = []
  if (!apiKey) missing.push('VAULT_API_KEY (or --api-key)')
  if (!baseUrl) missing.push('VAULT_URL (or --url)')
  if (!projectId) missing.push('VAULT_PROJECT_ID (or --project-id)')

  if (missing.length > 0) {
    throw new CliUsageError(
      `Missing required configuration: ${missing.join(', ')}. Set the environment variable(s) or pass the equivalent flag.`
    )
  }

  return { apiKey: apiKey as string, baseUrl: baseUrl as string, projectId: projectId as string }
}

export type LoginFlags = { url?: string }
export type LoginConfig = { baseUrl: string }

/**
 * Story 43.2 — `pvault login`/`logout` only need `VAULT_URL` (no `--api-key`, since that's the
 * machine-user path — see Dev Notes "Architecture & prior art"). Same flag-overrides-env
 * precedence as `resolveConfig()` above, deliberately kept as a separate function rather than
 * widening `resolveConfig()` itself, since `apiKey`/`projectId` are not optional inputs to that
 * function's contract and login has no use for either.
 */
export function resolveLoginConfig(flags: LoginFlags, env: EnvLike = process.env): LoginConfig {
  const baseUrl = flags.url ?? env['VAULT_URL']
  if (!baseUrl) {
    throw new CliUsageError(
      'Missing required configuration: VAULT_URL (or --url). Set the environment variable or pass the flag.'
    )
  }
  return { baseUrl }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * AC-2 hardening (Red Team vs Blue Team elicitation, 2026-09-22) — packages/agent never enforces
 * a TLS scheme, so a misconfigured `http://` baseUrl would send the machine-user API key and the
 * fetched secret value in plaintext. This is a defensive WARNING, not a hard failure (so
 * legitimate `http://localhost`/`127.0.0.1` local-dev use keeps working), and does not require
 * modifying packages/agent.
 */
export function warnIfInsecureBaseUrl(baseUrl: string, writeStderr: (chunk: string) => void): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    // An unparsable baseUrl is caught later, when fetch() itself rejects it — this warning isn't
    // the right place to duplicate that validation.
    return
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return

  writeStderr(
    `warning: VAULT_URL (${baseUrl}) is not https:// and is not a loopback address — the API key and secret value will be sent in plaintext.\n`
  )
}
