import { env as privateEnv } from '$env/dynamic/private'
// Deliberately the undici MAJOR that Node 24 bundles (7.x) — a dispatcher from another major
// handed to the built-in fetch is a known source of subtle incompatibility. apps/api declares its
// own exact undici pin for its SSRF-guarded fetch; do not unify the two blindly (Story 43.16).
import { Agent } from 'undici'
import {
  INTERNAL_TLS_EXPIRY_WARN_DAYS,
  certificateExpiry,
  resolveTlsMaterial,
  type EnvLike,
  type ResolvedTlsMaterial,
  type TlsMaterialSpec,
} from '@project-vault/shared/node-tls'

/**
 * Story 43.16 AC-2: the ONE choke point for the web's server-side calls to the api. With the Fly
 * demo's internal-TLS variables set it pins the private CA (and presents the web's client
 * certificate for the api's mTLS listener) over TLS 1.3; with none set it is plain
 * `globalThis.fetch`, exactly as before (docker-compose, local dev, e2e).
 *
 * Validation runs once at first use and fails closed with an error naming the variable, never
 * the value.
 */
export const WEB_API_TLS_SPEC: TlsMaterialSpec = {
  certVar: 'API_TLS_CLIENT_CERT_B64',
  keyVar: 'API_TLS_CLIENT_KEY_B64',
  caVar: 'API_TLS_CA_B64',
  role: 'client',
}

const EXPIRY_WARN_INTERVAL_MS = 24 * 3_600_000

export type InternalApiLogLine = {
  level: 'info' | 'warn'
  eventType: 'internal_tls.configured' | 'internal_tls.cert_expiring'
  [field: string]: unknown
}

type AgentOptions = NonNullable<ConstructorParameters<typeof Agent>[0]>

export type InternalApiFetchDeps = {
  baseFetch?: typeof fetch
  createAgent?: (options: AgentOptions) => Agent
  log?: (line: InternalApiLogLine) => void
  clock?: () => number
}

type Resolved = {
  mode: 'off' | 'tls' | 'mtls'
  material: ResolvedTlsMaterial
  dispatcher?: Agent
}

function writeLogLine(line: InternalApiLogLine): void {
  process.stderr.write(`${JSON.stringify({ ...line, service: 'web' })}\n`)
}

/** An empty API_BASE_URL means server-api-fetch's plain-http local-dev default. */
function assertBaseUrl(apiBaseUrl: string, material: ResolvedTlsMaterial): void {
  const tlsConfigured = material.ca !== undefined
  const protocol = apiBaseUrl === '' ? 'http:' : new URL(apiBaseUrl).protocol
  if (tlsConfigured && protocol !== 'https:') {
    throw new Error('API_BASE_URL must be https:// when API_TLS_* is set')
  }
  // Public roots can never validate a private-CA certificate. This rule is about API_BASE_URL's
  // own host only — never a synthetic request URL such as the handoff route's placeholder.
  if (
    protocol === 'https:' &&
    new URL(apiBaseUrl).hostname.endsWith('.internal') &&
    !tlsConfigured
  ) {
    throw new Error('API_TLS_CA_B64 is required when API_BASE_URL is an https://*.internal URL')
  }
}

function resolve(env: EnvLike, createAgent: (options: AgentOptions) => Agent): Resolved {
  const material = resolveTlsMaterial(env, WEB_API_TLS_SPEC)
  const rawBase = new Map(Object.entries(env)).get('API_BASE_URL')
  assertBaseUrl(typeof rawBase === 'string' ? rawBase.trim() : '', material)
  if (material.ca === undefined) return { mode: 'off', material }
  const connect: AgentOptions['connect'] = {
    ca: material.ca,
    minVersion: 'TLSv1.3',
    rejectUnauthorized: true,
    ...(material.cert && material.key ? { cert: material.cert.pem, key: material.key } : {}),
  }
  return {
    mode: material.cert ? 'mtls' : 'tls',
    material,
    dispatcher: createAgent({ connect }),
  }
}

function createExpiryLogger(
  resolved: Resolved,
  log: (line: InternalApiLogLine) => void,
  clock: () => number
) {
  const leaf = resolved.material.cert?.leaf
  let lastWarnAt: number | undefined
  const configured = () => {
    log({
      level: 'info',
      eventType: 'internal_tls.configured',
      internalTls: resolved.mode,
      clientCertNotAfter: leaf ? certificateExpiry(leaf, new Date(clock())).notAfter : null,
    })
  }
  const maybeWarn = () => {
    if (!leaf) return
    const now = clock()
    if (lastWarnAt !== undefined && now - lastWarnAt < EXPIRY_WARN_INTERVAL_MS) return
    const expiry = certificateExpiry(leaf, new Date(now))
    if (expiry.daysRemaining >= INTERNAL_TLS_EXPIRY_WARN_DAYS) return
    lastWarnAt = now
    log({
      level: 'warn',
      eventType: 'internal_tls.cert_expiring',
      which: 'web-client',
      daysRemaining: expiry.daysRemaining,
      certNotAfter: expiry.notAfter,
    })
  }
  return { configured, maybeWarn }
}

/** Pure factory (tests inject env and deps); `internalApiFetch` below binds it to the process env. */
export function createInternalApiFetch(
  env: EnvLike,
  deps: InternalApiFetchDeps = {}
): typeof fetch {
  const baseFetch = deps.baseFetch ?? globalThis.fetch
  const createAgent = deps.createAgent ?? ((options: AgentOptions) => new Agent(options))
  const log = deps.log ?? writeLogLine
  const clock = deps.clock ?? Date.now
  let state:
    | { resolved: Resolved; expiry: ReturnType<typeof createExpiryLogger> }
    | { error: Error }
    | undefined

  const current = () => {
    if (state === undefined) {
      try {
        const resolved = resolve(env, createAgent)
        const expiry = createExpiryLogger(resolved, log, clock)
        expiry.configured()
        state = { resolved, expiry }
      } catch (error) {
        state = {
          error: error instanceof Error ? error : new Error('internal API TLS misconfigured'),
        }
      }
    }
    return state
  }

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const active = current()
    if ('error' in active) return Promise.reject(active.error)
    active.expiry.maybeWarn()
    const { dispatcher } = active.resolved
    if (!dispatcher) return baseFetch(input, init)
    return baseFetch(input, { ...init, dispatcher } as RequestInit)
  }) as typeof fetch
}

let defaultFetch: typeof fetch | undefined

/** The process-wide choke point, bound to `$env/dynamic/private` and memoized. */
export const internalApiFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  defaultFetch ??= createInternalApiFetch(privateEnv)
  return defaultFetch(input, init)
}) as typeof fetch
