import { EXIT_CODES } from './exit-codes.js'
import { isBlank } from './validate.js'
import { sanitizeForTerminal } from './sanitize.js'
import { warnIfInsecureBaseUrl } from './config.js'
import { writeSession, type EnvLike, type SessionData } from './session-store.js'
import { PromptInterruptedError, type PromptFn } from './prompt.js'

export type WritableLike = { write: (chunk: string) => void }
export type LoginStreams = { stdout: WritableLike; stderr: WritableLike }
export type LoginConfig = { baseUrl: string }

export type LoginDeps = {
  fetchFn: typeof fetch
  prompt: PromptFn
  env: EnvLike
  /** Test-injection seam only — production callers never pass this. */
  writeSessionFn?: typeof writeSession
}

const TOTP_METHOD = 'totp'
const MAX_RESTARTS = 5

type LoginBearerData = {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresIn: number
  userId: string
  orgId: string
}

type MfaChallengeData = { mfaRequired: true; mfaToken: string; method?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isMfaChallenge(data: unknown): data is MfaChallengeData {
  return isRecord(data) && data['mfaRequired'] === true && typeof data['mfaToken'] === 'string'
}

function isBearerData(data: unknown): data is LoginBearerData {
  if (!isRecord(data)) return false
  return (
    typeof data['accessToken'] === 'string' &&
    typeof data['refreshToken'] === 'string' &&
    typeof data['expiresIn'] === 'number' &&
    typeof data['userId'] === 'string' &&
    typeof data['orgId'] === 'string'
  )
}

function codeOf(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined
  return typeof json['code'] === 'string' ? (json['code'] as string) : undefined
}

function dataOf(json: unknown): unknown {
  if (!isRecord(json)) return undefined
  return json['data']
}

/** AC-2 whitespace/formatting edge case — strips all whitespace (leading, trailing, and internal
 * grouping like `123 456`) rather than just trim(), so a copy-pasted grouped code is submitted
 * correctly instead of burning a server-side attempt on a client-side formatting bug. */
function normalizeTotp(raw: string): string {
  return raw.replace(/\s+/g, '')
}

type PostJsonResult = { status: number; json: unknown }

async function postJson(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  body: unknown
): Promise<PostJsonResult> {
  const response = await fetchFn(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

function handlePromptInterrupt(error: unknown, streams: LoginStreams): number {
  if (error instanceof PromptInterruptedError) {
    streams.stderr.write('Login cancelled.\n')
    return EXIT_CODES.usageError
  }
  return unexpectedError(streams, error)
}

function unexpectedError(streams: LoginStreams, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  streams.stderr.write(`Unexpected error: ${sanitizeForTerminal(message)}\n`)
  return EXIT_CODES.unexpected
}

function finishLogin(
  bearer: LoginBearerData,
  config: LoginConfig,
  streams: LoginStreams,
  deps: LoginDeps
): number {
  const session: SessionData = {
    accessToken: bearer.accessToken,
    refreshToken: bearer.refreshToken,
    accessExpiresAt: new Date(Date.now() + bearer.expiresIn * 1000).toISOString(),
    userId: bearer.userId,
    orgId: bearer.orgId,
    baseUrl: config.baseUrl,
  }
  ;(deps.writeSessionFn ?? writeSession)(session, deps.env)
  // AC-1/security testing requirement — never write the token values to any stream; only this
  // fixed confirmation string.
  streams.stdout.write('Logged in.\n')
  return 0
}

async function promptEmailPassword(
  streams: LoginStreams,
  deps: LoginDeps
): Promise<{ email: string; password: string } | number> {
  let emailRaw: string
  try {
    emailRaw = await deps.prompt('Email: ', { mask: false })
  } catch (error) {
    return handlePromptInterrupt(error, streams)
  }
  const email = emailRaw.trim()
  if (isBlank(email)) {
    streams.stderr.write('Email must not be empty.\n')
    return EXIT_CODES.usageError
  }

  let password: string
  try {
    password = await deps.prompt('Password: ', { mask: true })
  } catch (error) {
    return handlePromptInterrupt(error, streams)
  }
  // AC-2 empty-submission edge case — caught locally, re-prompted without hitting the server.
  if (isBlank(password)) {
    streams.stderr.write('Password must not be empty.\n')
    return EXIT_CODES.usageError
  }

  return { email, password }
}

// AC-3 — fail closed on any non-TOTP challenge shape rather than assuming every challenge is a
// TOTP challenge. No live server path can produce this today (see AC-3's Dev Notes), but a
// synthetic challenge exercises this branch in tests.
function checkTotpMethodSupported(
  challenge: MfaChallengeData,
  streams: LoginStreams
): number | null {
  if (challenge.method !== undefined && challenge.method !== TOTP_METHOD) {
    streams.stderr.write(
      'This account requires a login method not supported by this CLI version (WebAuthn). ' +
        'Use a machine-user API key (`pvault get`) or the web app instead. ' +
        'CLI WebAuthn support is tracked separately (Epic 46).\n'
    )
    return EXIT_CODES.webauthnOnlyUnsupported
  }
  return null
}

/** Reads and normalizes one TOTP submission. Returns the exit code on a Ctrl-C interrupt, or
 * `null` on a blank submission (AC-2 edge case — re-prompt locally, never submit an empty code). */
async function readNormalizedTotp(
  streams: LoginStreams,
  deps: LoginDeps
): Promise<string | number | null> {
  let totpRaw: string
  try {
    totpRaw = await deps.prompt('Enter your 6-digit authenticator code: ', { mask: false })
  } catch (error) {
    return handlePromptInterrupt(error, streams)
  }
  const totp = normalizeTotp(totpRaw)
  if (isBlank(totp)) {
    streams.stderr.write('Authenticator code is required.\n')
    return null
  }
  return totp
}

/** Classifies the verify-login server response into the caller's next step. */
async function classifyTotpResult(
  result: PostJsonResult,
  config: LoginConfig,
  streams: LoginStreams,
  deps: LoginDeps
): Promise<number | 'restart' | 'retry'> {
  if (result.status === 200 && isBearerData(dataOf(result.json))) {
    return finishLogin(dataOf(result.json) as LoginBearerData, config, streams, deps)
  }

  const code = codeOf(result.json)
  if (code === 'invalid_totp') {
    streams.stderr.write('The authenticator code is incorrect.\n')
    return 'retry'
  }
  if (code === 'mfa_token_expired') {
    // AC-2 edge case — the pending-MFA token died (server-side attempt cap or TTL); restart
    // the whole flow from the top rather than re-prompting a dead token.
    streams.stderr.write('Your login session expired. Please sign in again.\n')
    return 'restart'
  }
  if (result.status === 429) {
    streams.stderr.write('Too many attempts. Please try again later.\n')
    return EXIT_CODES.invalidCredentials
  }
  return unexpectedError(
    streams,
    new Error(`Unexpected MFA verification response (${result.status})`)
  )
}

async function runTotpChallenge(
  challenge: MfaChallengeData,
  config: LoginConfig,
  streams: LoginStreams,
  deps: LoginDeps
): Promise<number | 'restart'> {
  const unsupported = checkTotpMethodSupported(challenge, streams)
  if (unsupported !== null) return unsupported

  for (;;) {
    const totp = await readNormalizedTotp(streams, deps)
    if (totp === null) continue
    if (typeof totp === 'number') return totp

    let result: PostJsonResult
    try {
      result = await postJson(deps.fetchFn, config.baseUrl, '/api/v1/auth/cli/mfa/verify-login', {
        mfaToken: challenge.mfaToken,
        totp,
      })
    } catch (error) {
      return unexpectedError(streams, error)
    }

    const outcome = await classifyTotpResult(result, config, streams, deps)
    if (outcome === 'retry') continue
    return outcome
  }
}

/** Classifies the cli-login server response into the caller's next step. May itself drive the
 * full TOTP-challenge sub-flow when the response is an MFA challenge. */
async function handleLoginResult(
  result: PostJsonResult,
  config: LoginConfig,
  streams: LoginStreams,
  deps: LoginDeps
): Promise<number | 'restart'> {
  if (result.status === 403 && codeOf(result.json) === 'native_login_disabled') {
    streams.stderr.write(
      'Native login is disabled on this vault. Use a machine-user API key instead (see `pvault get --help`).\n'
    )
    return EXIT_CODES.nativeLoginDisabled
  }

  if (result.status === 200) {
    const data = dataOf(result.json)
    if (isMfaChallenge(data)) {
      return runTotpChallenge(data, config, streams, deps)
    }
    if (isBearerData(data)) {
      return finishLogin(data, config, streams, deps)
    }
    return unexpectedError(streams, new Error('Unexpected login response shape'))
  }

  if (result.status === 401 || result.status === 422) {
    streams.stderr.write('Invalid email or password.\n')
    return EXIT_CODES.invalidCredentials
  }

  return unexpectedError(streams, new Error(`Unexpected login response (${result.status})`))
}

/** Orchestrates the full `pvault login` flow (AC-1 through AC-4, AC-7). Returns the process exit
 * code, mirroring `runGet`'s contract. */
export async function runLogin(
  config: LoginConfig,
  streams: LoginStreams,
  deps: LoginDeps
): Promise<number> {
  // AC-1/security hardening (matches get-command.ts's identical warning for the machine-user
  // path) — a plaintext VAULT_URL would send the user's password, and then the access/refresh
  // bearer-token pair, over the wire unencrypted. Defensive, non-blocking warning only.
  warnIfInsecureBaseUrl(config.baseUrl, (chunk) => streams.stderr.write(chunk))

  for (let attempt = 0; attempt < MAX_RESTARTS; attempt += 1) {
    const credentials = await promptEmailPassword(streams, deps)
    if (typeof credentials === 'number') return credentials

    let result: PostJsonResult
    try {
      result = await postJson(deps.fetchFn, config.baseUrl, '/api/v1/auth/cli-login', credentials)
    } catch (error) {
      return unexpectedError(streams, error)
    }

    const outcome = await handleLoginResult(result, config, streams, deps)
    if (outcome === 'restart') continue
    return outcome
  }
  // The pending-MFA token kept expiring/getting rejected across every restart attempt — this is
  // the same "pending MFA session is dead" condition mfa_token_expired signals mid-flow, just
  // repeated past MAX_RESTARTS, so it gets that condition's own distinguishable exit code rather
  // than the generic `unexpected` one.
  streams.stderr.write('Too many failed sign-in attempts. Please try `pvault login` again.\n')
  return EXIT_CODES.mfaTokenExpired
}
