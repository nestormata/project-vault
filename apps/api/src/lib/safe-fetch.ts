import { promises as dnsPromises } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

/** D4 — this codebase's first outbound HTTP request to an org-admin-controlled URL. Rejected
 * with the same 422 { code: "unsafe_forwarding_url" } shape at every call site (webhook `url`,
 * S3 `endpoint`). */
export class UnsafeForwardingUrlError extends Error {}

export const WEBHOOK_FETCH_TIMEOUT_MS = 5_000
/** The webhook response body is never used for anything beyond status-code success/failure —
 * bounded so a malicious/misbehaving endpoint can't force an unbounded read. */
const MAX_RESPONSE_BODY_BYTES = 64 * 1024

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0)
}

function cidrV4Matches(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

// D4's exact required ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
// 169.254.0.0/16 — plus 0.0.0.0/8 (unspecified/"this network") as an obvious additional guard.
const PRIVATE_V4_CIDRS: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
]

export function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_V4_CIDRS.some(([base, bits]) => cidrV4Matches(ip, base, bits))
}

/** IPv6 D4 ranges: ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local). Also
 * rejects an IPv4-mapped IPv6 address (::ffff:a.b.c.d) whose embedded v4 address is private. */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::1') return true
  const firstGroup = normalized.split(':')[0] ?? ''
  // fc00::/7 covers first 7 bits = 1111 110x -> first hex nibble 'fc'..'fd'
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstGroup)) return true
  // fe80::/10 -> first 10 bits = 1111 1110 10 -> fe8x, fe9x, feax, febx
  if (/^fe[89ab][0-9a-f]{0,2}$/.test(firstGroup)) return true
  const mappedV4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized)
  if (mappedV4?.[1]) return isPrivateIPv4(mappedV4[1])
  return false
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true // not a parseable IP at all — refuse rather than silently allow
}

function hostnameOf(hostnameOrUrl: string): string {
  try {
    return new URL(hostnameOrUrl).hostname
  } catch {
    return hostnameOrUrl
  }
}

export type ResolvedAddress = { address: string }
export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>

export const defaultDnsLookup: DnsLookupFn = (hostname) =>
  dnsPromises.lookup(hostname, { all: true })

/**
 * D4 — resolves `hostname` and rejects if ANY resolved address falls in a private/loopback/
 * link-local/reserved range. No HTTP fetch is performed here; this is the standalone check
 * reused by S3 `endpoint` validation at PUT /audit/forwarding configuration time (D4's
 * adversarial-review correction). Returns the validated addresses so callers (safeFetchExternal)
 * can pin the subsequent connection to exactly them.
 */
export async function resolveAndValidatePublicAddresses(
  hostnameOrUrl: string,
  lookup: DnsLookupFn = defaultDnsLookup
): Promise<ResolvedAddress[]> {
  const hostname = hostnameOf(hostnameOrUrl)
  let addresses: ResolvedAddress[]
  try {
    addresses = await lookup(hostname)
  } catch (error) {
    throw new UnsafeForwardingUrlError(
      `Unable to resolve hostname "${hostname}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (addresses.length === 0) {
    throw new UnsafeForwardingUrlError(`Hostname "${hostname}" resolved to no addresses`)
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      throw new UnsafeForwardingUrlError(
        `Hostname "${hostname}" resolves to a private/reserved address (${address}), which is not permitted for external forwarding destinations`
      )
    }
  }
  return addresses
}

export async function assertPublicHostname(
  hostnameOrUrl: string,
  lookup: DnsLookupFn = defaultDnsLookup
): Promise<void> {
  await resolveAndValidatePublicAddresses(hostnameOrUrl, lookup)
}

/**
 * D4 (DNS-rebinding correction) — builds the `connect.lookup` callback undici's `Agent` accepts,
 * pinned to exactly `addresses` regardless of the hostname/options undici passes in. This is a
 * pure function, independently unit-testable: it proves the pinning guarantee (ignores the
 * requested hostname entirely, never performs a second resolution) without needing a real
 * socket connection or network access.
 */
export function buildPinnedLookupHandler(
  addresses: ResolvedAddress[]
): (
  hostname: string,
  options: unknown,
  callback: (err: Error | null, addresses: { address: string; family: 4 | 6 }[]) => void
) => void {
  return (_hostname, _options, callback) => {
    callback(
      null,
      addresses.map(({ address }) => ({ address, family: (isIP(address) as 4 | 6) || 4 }))
    )
  }
}

export type SafeFetchResult = {
  status: number
  ok: boolean
}

export type SafeFetchDeps = {
  lookup?: DnsLookupFn
  fetchImpl?: (
    url: string,
    init: Record<string, unknown>
  ) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>
}

/**
 * D4 — the only sanctioned way this codebase makes outbound HTTP requests to an org-admin-
 * controlled URL:
 *  - HTTPS-only (defense-in-depth; the Zod schema layer already requires this).
 *  - Validates the hostname's resolved addresses are all public.
 *  - Pins the connection to exactly those validated addresses via a custom `lookup` override on
 *    a per-call undici Agent (buildPinnedLookupHandler) — closes the DNS-rebinding TOCTOU gap
 *    where a second, independent resolution at connect time could return a different (private)
 *    address.
 *  - `redirect: 'manual'` — a 3xx response is never automatically followed; it is treated as a
 *    plain delivery failure like any other non-2xx status.
 *  - Bounded connect+total timeout and a bounded response-body read (the body is never used for
 *    anything beyond status-code success/failure).
 */
/** Bounded read — the body's content is never used, only whether the read itself completes
 * within the byte cap; a webhook receiver has no legitimate reason to send more. Extracted to
 * keep safeFetchExternal()'s own complexity down. */
async function drainBoundedResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  let bytesRead = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    bytesRead += value?.byteLength ?? 0
    if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel()
      return
    }
  }
}

export async function safeFetchExternal(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  deps: SafeFetchDeps = {}
): Promise<SafeFetchResult> {
  if (!url.startsWith('https://')) {
    throw new UnsafeForwardingUrlError('safeFetchExternal: url must use the https:// scheme')
  }
  const pinnedAddresses = await resolveAndValidatePublicAddresses(url, deps.lookup)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_FETCH_TIMEOUT_MS)
  const dispatcher = deps.fetchImpl
    ? undefined
    : new Agent({ connect: { lookup: buildPinnedLookupHandler(pinnedAddresses) } })
  const fetchImpl =
    deps.fetchImpl ?? (undiciFetch as unknown as NonNullable<SafeFetchDeps['fetchImpl']>)
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    })
    await drainBoundedResponseBody(response.body)
    return { status: response.status, ok: response.status >= 200 && response.status < 300 }
  } finally {
    clearTimeout(timeout)
    if (dispatcher) await dispatcher.close()
  }
}
