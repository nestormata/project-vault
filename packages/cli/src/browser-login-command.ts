import { EXIT_CODES } from './exit-codes.js'
import { warnIfInsecureBaseUrl } from './config.js'
import { retryDelayPhrase } from './retry-after.js'
import { ERROR_TEXT_MAX_CODE_POINTS, sanitizeServerText } from './sanitize-server-text.js'
import { writeSession, type EnvLike, type SessionData } from './session-store.js'
import { postJson, type LoginStreams } from './login-command.js'

export type BrowserLoginDeps = {
  fetchFn: typeof fetch
  env: EnvLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  writeSessionFn?: typeof writeSession
}

type Created = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
const MAX_INTERVAL_SECONDS = 30

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function dataOf(json: unknown): Record<string, unknown> | undefined {
  if (!isRecord(json) || !isRecord(json['data'])) return undefined
  return json['data']
}

function codeOf(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined
  return typeof json['code'] === 'string' ? json['code'] : undefined
}

function asCreated(json: unknown): Created | undefined {
  const data = dataOf(json)
  if (!data) return undefined
  const deviceCode = data['deviceCode']
  const userCode = data['userCode']
  const verificationUri = data['verificationUri']
  const verificationUriComplete = data['verificationUriComplete']
  const expiresIn = data['expiresIn']
  const interval = data['interval']
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof verificationUriComplete !== 'string' ||
    typeof expiresIn !== 'number' ||
    typeof interval !== 'number'
  ) {
    return undefined
  }
  if (!USER_CODE.test(userCode)) return undefined
  return { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }
}

function printableUrl(value: string): string | undefined {
  if (!/^https?:\/\/\S+$/.test(value)) return undefined
  const cleaned = sanitizeServerText(value, ERROR_TEXT_MAX_CODE_POINTS)
  return cleaned.length > 0 ? cleaned : undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function runBrowserLogin(
  config: { baseUrl: string },
  streams: LoginStreams,
  deps: BrowserLoginDeps
): Promise<number> {
  warnIfInsecureBaseUrl(config.baseUrl, (chunk) => streams.stderr.write(chunk))
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const store = deps.writeSessionFn ?? writeSession
  const createdResponse = await postJson(
    deps.fetchFn,
    config.baseUrl,
    '/api/v1/auth/cli/device',
    {}
  )
  if (createdResponse.status === 429) {
    streams.stderr.write(
      `Too many sign-in attempts from this network. Try again ${retryDelayPhrase(createdResponse.retryAfterSeconds)}.\n`
    )
    return EXIT_CODES.rateLimited
  }
  const created = createdResponse.status === 201 ? asCreated(createdResponse.json) : undefined
  if (!created) {
    streams.stderr.write('The vault did not start a sign-in. Nothing was saved.\n')
    return EXIT_CODES.unexpected
  }
  const approvalUrl = printableUrl(created.verificationUriComplete)
  const plainUrl = printableUrl(created.verificationUri)
  if (!approvalUrl || !plainUrl) {
    streams.stderr.write('The vault returned an approval address this program will not print.\n')
    return EXIT_CODES.unexpected
  }
  streams.stdout.write(`Sign-in code: ${created.userCode}\n`)
  streams.stdout.write(`Open this address and approve the code: ${approvalUrl}\n`)
  const deadline = now() + created.expiresIn * 1000
  return pollForSession({
    config,
    streams,
    deps,
    created,
    interval: Math.min(Math.max(1, created.interval), MAX_INTERVAL_SECONDS),
    deadline,
    sleep,
    now,
    store,
  })
}

async function pollForSession(input: {
  config: { baseUrl: string }
  streams: LoginStreams
  deps: BrowserLoginDeps
  created: Created
  interval: number
  deadline: number
  sleep: (ms: number) => Promise<void>
  now: () => number
  store: typeof writeSession
}): Promise<number> {
  if (input.now() >= input.deadline) {
    input.streams.stderr.write('The sign-in expired before it was approved.\n')
    return EXIT_CODES.deviceLoginExpired
  }
  await input.sleep(input.interval * 1000)
  const polled = await postJson(
    input.deps.fetchFn,
    input.config.baseUrl,
    '/api/v1/auth/cli/device/token',
    { deviceCode: input.created.deviceCode }
  )
  if (polled.status === 429) {
    input.streams.stderr.write(
      `Too many sign-in attempts from this network. Try again ${retryDelayPhrase(polled.retryAfterSeconds)}.\n`
    )
    return EXIT_CODES.rateLimited
  }
  if (polled.status === 200) return storeBearer(polled.json, input)
  const code = codeOf(polled.json)
  if (code === 'slow_down' || code === 'authorization_pending') {
    const interval =
      code === 'slow_down' ? Math.min(input.interval + 5, MAX_INTERVAL_SECONDS) : input.interval
    return pollForSession({ ...input, interval })
  }
  if (code === 'access_denied') {
    input.streams.stderr.write('The sign-in was denied.\n')
    return EXIT_CODES.deviceLoginDenied
  }
  if (code === 'expired_token') {
    input.streams.stderr.write('The sign-in expired before it was approved.\n')
    return EXIT_CODES.deviceLoginExpired
  }
  input.streams.stderr.write('The vault did not complete the sign-in. Nothing was saved.\n')
  return EXIT_CODES.unexpected
}

function storeBearer(
  json: unknown,
  input: {
    config: { baseUrl: string }
    streams: LoginStreams
    deps: BrowserLoginDeps
    now: () => number
    store: typeof writeSession
  }
): number {
  const data = dataOf(json)
  if (
    !data ||
    typeof data['accessToken'] !== 'string' ||
    typeof data['refreshToken'] !== 'string' ||
    typeof data['expiresIn'] !== 'number' ||
    typeof data['userId'] !== 'string' ||
    data['scope'] !== 'user'
  ) {
    input.streams.stderr.write('The vault approved the sign-in but the session was unreadable.\n')
    return EXIT_CODES.unexpected
  }
  const session: SessionData = {
    accessToken: data['accessToken'],
    refreshToken: data['refreshToken'],
    accessExpiresAt: new Date(input.now() + data['expiresIn'] * 1000).toISOString(),
    userId: data['userId'],
    scope: 'user',
    baseUrl: input.config.baseUrl,
  }
  input.store(session, input.deps.env)
  input.streams.stdout.write('Logged in.\n')
  return 0
}
