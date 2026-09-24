import { PVAULT_RELEASES_URL } from './build-info.js'
import { sanitizeServerText } from './sanitize-server-text.js'
import { compareSemverStrings } from './semver-precedence.js'
import {
  computeServerKey,
  isWithinTtl,
  NOTICE_INTERVAL_MS,
  OK_TTL_MS,
  readVersionCheckCache,
  UNREACHABLE_TTL_MS,
  versionCheckCachePath,
  writeVersionCheckCache,
  type VersionCheckCacheEntry,
} from './version-check-cache.js'
import {
  MAX_POLICY_BODY_BYTES,
  parseCliVersionPolicyBody,
  type CliVersionPolicy,
} from './version-policy-response.js'
import { EXIT_CODES } from './exit-codes.js'

/**
 * Story 43.6 — the CLI-entry-only version check (AC-1, AC-2, AC-3, AC-8). Wired in exactly one
 * place (`cli.ts`'s `preAction` hook); never imported by the Epic 50 seams.
 *
 * It uses its own `fetch` (never `@project-vault/agent`), so a slow or failed check can never move
 * the agent's offline-cache fallback state. The request carries no credential. Every failure is
 * fail-open: unreachable, malformed, 404/429/503, redirect or timeout → proceed silently.
 */
export const VERSION_CHECK_TIMEOUT_MS = 1500
export const POLICY_PATH = 'api/v1/client-version-policy'

export type VersionVerdict =
  | { kind: 'ok' }
  | { kind: 'stale'; current: string }
  | { kind: 'below-minimum'; minimumSupported: string }
  | { kind: 'server-older'; current: string }
  | { kind: 'withdrawn'; reason: string }

function isLess(a: string, b: string): boolean {
  return (compareSemverStrings(a, b) ?? 0) < 0
}

/** Pure; precedence withdrawn > below-minimum > stale > server-older. Exact-version withdrawal. */
export function evaluateVersionPolicy(
  cliVersion: string,
  policy: CliVersionPolicy
): VersionVerdict {
  const withdrawn = policy.withdrawn.find((entry) => entry.version === cliVersion)
  if (withdrawn) return { kind: 'withdrawn', reason: withdrawn.reason }
  const { minimumSupported, current } = policy
  if (minimumSupported !== null && isLess(cliVersion, minimumSupported)) {
    return { kind: 'below-minimum', minimumSupported }
  }
  if (current !== null && isLess(cliVersion, current)) return { kind: 'stale', current }
  if (current !== null && isLess(current, cliVersion)) return { kind: 'server-older', current }
  return { kind: 'ok' }
}

/** `<baseUrl>/api/v1/client-version-policy`, tolerating any number of trailing slashes. */
export function policyEndpointUrl(baseUrl: string): string {
  const base = new URL(baseUrl)
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  base.search = ''
  base.hash = ''
  return new URL(POLICY_PATH, base).toString()
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Resolves to the validated policy, or `null` for every unreachable/malformed outcome. */
async function fetchPolicy(
  baseUrl: string,
  cliVersion: string,
  fetchFn: typeof fetch
): Promise<CliVersionPolicy | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, VERSION_CHECK_TIMEOUT_MS)
  })
  const attempt = (async () => {
    const response = await fetchFn(policyEndpointUrl(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': `pvault/${cliVersion}` },
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status !== 200) return null
    const body = await readBodyCapped(response, MAX_POLICY_BODY_BYTES)
    return body === null ? null : parseCliVersionPolicyBody(body)
  })().catch(() => null)
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    clearTimeout(timer)
    // Always tear the request down: an unread (e.g. non-200) body that never ends would otherwise
    // keep the connection, and so the process, alive after the command has finished.
    controller.abort()
  }
}

export type RunVersionCheckOptions = {
  baseUrl: string
  cliVersion: string
  fetchFn: typeof fetch
  now: () => number
  /** `null` → no cache (no usable home directory); the check still runs. */
  cacheDir: string | null
  writeStderr: (chunk: string) => void
  /** `PVAULT_NO_VERSION_CHECK` (D10): gates advisory output and `lastNoticeAt` only. */
  suppressNotices: boolean
}

export type VersionCheckResult = { refuse: false } | { refuse: true; exitCode: number }

function needsFetch(entry: VersionCheckCacheEntry | undefined, now: number): boolean {
  if (!entry) return true
  // A cached withdrawn verdict is never trusted without trying to refresh it (AC-8).
  if (entry.lastConfirmedWithdrawn) return true
  const ttl = entry.outcome === 'ok' ? OK_TTL_MS : UNREACHABLE_TTL_MS
  return !isWithinTtl(entry.checkedAt, now, ttl)
}

function advisoryText(cliVersion: string, verdict: VersionVerdict): string | null {
  switch (verdict.kind) {
    case 'below-minimum':
      return `warning: pvault ${cliVersion} is below this server's minimum supported version ${verdict.minimumSupported} and may stop working; upgrade from ${PVAULT_RELEASES_URL}\n`
    case 'stale':
      return `notice: pvault ${cliVersion} is older than this server's release ${verdict.current}; download the matching pvault from ${PVAULT_RELEASES_URL}\n`
    case 'server-older':
      return `notice: pvault ${cliVersion} is newer than this server's release ${verdict.current}; some commands may not work until the server is upgraded\n`
    default:
      return null
  }
}

const PATH_MAX_CODE_POINTS = 1024

function withdrawnText(
  cliVersion: string,
  baseUrl: string,
  reason: string,
  sticky: { at: string; cachePath: string } | null
): string {
  const host = sanitizeServerText(new URL(baseUrl).host)
  const cleanReason = sanitizeServerText(reason)
  const headline = cleanReason
    ? `error: pvault ${cliVersion} has been withdrawn by ${host}: ${cleanReason}`
    : `error: pvault ${cliVersion} has been withdrawn by ${host} (no reason given).`
  const suffix = sticky
    ? ` (last confirmed ${sanitizeServerText(sticky.at)}; the server is currently unreachable — if you trust this is wrong, delete ${sanitizeServerText(sticky.cachePath, PATH_MAX_CODE_POINTS)})`
    : ''
  return `${headline}${suffix}\nDownload a supported release from ${PVAULT_RELEASES_URL}\n`
}

type Refusal = { reason: string; sticky: { at: string } | null }

type Decision = {
  entry: VersionCheckCacheEntry
  refusal: Refusal | null
  /** Never a `withdrawn` verdict: a refusal is derived only from a fresh answer or the sticky one. */
  advisory: VersionVerdict | null
}

function advisoryOf(cliVersion: string, policy: CliVersionPolicy | null): VersionVerdict | null {
  if (!policy) return null
  const verdict = evaluateVersionPolicy(cliVersion, policy)
  return verdict.kind === 'withdrawn' ? null : verdict
}

function freshDecision(
  cliVersion: string,
  checkedAt: string,
  policy: CliVersionPolicy,
  prior: VersionCheckCacheEntry | undefined
): Decision {
  const verdict = evaluateVersionPolicy(cliVersion, policy)
  const withdrawn = verdict.kind === 'withdrawn' ? { reason: verdict.reason, at: checkedAt } : null
  return {
    entry: {
      cliVersion,
      checkedAt,
      outcome: 'ok',
      policy,
      lastConfirmedWithdrawn: withdrawn,
      lastNoticeAt: prior?.lastNoticeAt ?? null,
    },
    refusal: withdrawn ? { reason: withdrawn.reason, sticky: null } : null,
    advisory: advisoryOf(cliVersion, policy),
  }
}

/** Unreachable or malformed: never create a refusal, never erase one (sticky, D9). A previously
 * cached policy still drives the advisory notices. */
function unreachableDecision(
  cliVersion: string,
  checkedAt: string,
  prior: VersionCheckCacheEntry | undefined
): Decision {
  const sticky = prior?.lastConfirmedWithdrawn ?? null
  const policy = prior?.policy ?? null
  return {
    entry: {
      cliVersion,
      checkedAt,
      outcome: 'unreachable',
      policy,
      lastConfirmedWithdrawn: sticky,
      lastNoticeAt: prior?.lastNoticeAt ?? null,
    },
    refusal: sticky ? { reason: sticky.reason, sticky: { at: sticky.at } } : null,
    advisory: advisoryOf(cliVersion, policy),
  }
}

async function decide(
  opts: RunVersionCheckOptions,
  prior: VersionCheckCacheEntry | undefined
): Promise<Decision> {
  const nowMs = opts.now()
  if (prior && !needsFetch(prior, nowMs)) {
    return { entry: prior, refusal: null, advisory: advisoryOf(opts.cliVersion, prior.policy) }
  }
  const checkedAt = new Date(nowMs).toISOString()
  const policy = await fetchPolicy(opts.baseUrl, opts.cliVersion, opts.fetchFn)
  return policy
    ? freshDecision(opts.cliVersion, checkedAt, policy, prior)
    : unreachableDecision(opts.cliVersion, checkedAt, prior)
}

/** Prints the advisory notice unless suppressed or rate-limited; `true` when one was printed. */
function maybePrintNotice(opts: RunVersionCheckOptions, decision: Decision): boolean {
  if (!decision.advisory || opts.suppressNotices) return false
  const text = advisoryText(opts.cliVersion, decision.advisory)
  const nowMs = opts.now()
  if (!text || isWithinTtl(decision.entry.lastNoticeAt, nowMs, NOTICE_INTERVAL_MS)) return false
  opts.writeStderr(text)
  decision.entry.lastNoticeAt = new Date(nowMs).toISOString()
  return true
}

type CacheState = {
  cachePath: string | null
  cache: Map<string, VersionCheckCacheEntry>
  prior: VersionCheckCacheEntry | undefined
}

function loadCacheState(opts: RunVersionCheckOptions, serverKey: string): CacheState {
  const cachePath = opts.cacheDir === null ? null : versionCheckCachePath(opts.cacheDir)
  const cache = cachePath ? readVersionCheckCache(cachePath) : new Map()
  const cachedEntry = cache.get(serverKey)
  // An entry for another CLI version is ignored (and overwritten): upgrading never inherits it.
  const prior = cachedEntry?.cliVersion === opts.cliVersion ? cachedEntry : undefined
  return { cachePath, cache, prior }
}

function printRefusal(opts: RunVersionCheckOptions, refusal: Refusal, cachePath: string | null) {
  const sticky = refusal.sticky
    ? { at: refusal.sticky.at, cachePath: cachePath ?? '(no cache file)' }
    : null
  opts.writeStderr(withdrawnText(opts.cliVersion, opts.baseUrl, refusal.reason, sticky))
}

export async function runVersionCheck(opts: RunVersionCheckOptions): Promise<VersionCheckResult> {
  const serverKey = opts.cliVersion === 'dev' ? null : computeServerKey(opts.baseUrl)
  if (serverKey === null) return { refuse: false }

  const { cachePath, cache, prior } = loadCacheState(opts, serverKey)
  const decision = await decide(opts, prior)
  const { entry, refusal } = decision
  if (refusal) printRefusal(opts, refusal, cachePath)
  const noticePrinted = !refusal && maybePrintNotice(opts, decision)

  if (cachePath && (entry !== prior || noticePrinted)) {
    cache.set(serverKey, entry)
    writeVersionCheckCache(cachePath, cache)
  }
  return refusal ? { refuse: true, exitCode: EXIT_CODES.cliVersionWithdrawn } : { refuse: false }
}
