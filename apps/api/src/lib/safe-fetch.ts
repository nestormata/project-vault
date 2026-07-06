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

function ipv4PartToGroups(ipv4: string): [number, number] | null {
  const octets = ipv4.split('.')
  if (octets.length !== 4) return null
  const bytes = octets.map(Number)
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null
  return [((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)]
}

function parseHexGroups(part: string): number[] | null {
  if (part === '') return []
  const parsed: number[] = []
  for (const g of part.split(':')) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    parsed.push(parseInt(g, 16))
  }
  return parsed
}

/** Mixed notation (e.g. "::ffff:127.0.0.1"): folds a trailing IPv4 literal into two hex groups
 * so the rest of expandIPv6Groups only ever deals with plain hex groups. Returns the address
 * unchanged if there's no dotted-decimal tail, or null if the tail is present but malformed. */
function foldIPv4Tail(address: string): string | null {
  const lastColon = address.lastIndexOf(':')
  const tail = lastColon >= 0 ? address.slice(lastColon + 1) : address
  if (!tail.includes('.')) return address
  const v4Groups = ipv4PartToGroups(tail)
  if (!v4Groups) return null
  return `${address.slice(0, lastColon + 1)}${v4Groups[0].toString(16)}:${v4Groups[1].toString(16)}`
}

/**
 * Expands a canonical/compressed IPv6 address string (as returned by dns.lookup — which may
 * render the same address as e.g. "fe80::1", "::ffff:127.0.0.1", or "::ffff:7f00:1") into its 8
 * 16-bit groups. Regression-driven (adversarial review): a textual-prefix regex over the raw
 * string is fragile in both directions — it under-blocks an IPv4-mapped address written in hex
 * group form instead of dotted-decimal (::ffff:7f00:1 is the same address as ::ffff:127.0.0.1),
 * and it over-blocks a canonical address whose leading zero is compressed away (e.g. "fc1::1" is
 * 0x0fc1, nowhere near fc00::/7, but a naive "starts with fc" check flags it anyway). Parsing to
 * actual 16-bit numeric groups and comparing with bitmasks is correct regardless of how the
 * resolver chose to render the text. Returns null if the input isn't a well-formed IPv6 address.
 */
function expandSingleIPv6Part(part: string): number[] | null {
  const groups = parseHexGroups(part)
  return groups && groups.length === 8 ? groups : null
}

/** The `::`-compressed case: `head` and `tail` are the groups either side of the compression
 * point; the missing groups in between are all-zero. */
function expandCompressedIPv6Parts(headPart: string, tailPart: string): number[] | null {
  const head = parseHexGroups(headPart)
  const tail = parseHexGroups(tailPart)
  if (!head || !tail) return null
  if (head.length + tail.length > 7) return null
  const missing = 8 - head.length - tail.length
  return [...head, ...new Array(missing).fill(0), ...tail]
}

function expandIPv6Groups(address: string): number[] | null {
  const withoutZone = address.split('%')[0] ?? address
  const folded = foldIPv4Tail(withoutZone)
  if (folded === null) return null

  const doubleColonParts = folded.split('::')
  if (doubleColonParts.length > 2) return null
  if (doubleColonParts.length === 2) {
    return expandCompressedIPv6Parts(doubleColonParts[0] ?? '', doubleColonParts[1] ?? '')
  }
  return expandSingleIPv6Part(doubleColonParts[0] ?? '')
}

function isIPv6Loopback(groups: number[]): boolean {
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1
}

function isUniqueLocalIPv6(groups: number[]): boolean {
  return ((groups[0] ?? 0) & 0xfe00) === 0xfc00 // fc00::/7
}

function isLinkLocalIPv6(groups: number[]): boolean {
  return ((groups[0] ?? 0) & 0xffc0) === 0xfe80 // fe80::/10
}

/** Returns the embedded dotted-decimal IPv4 address if `groups` is an IPv4-mapped IPv6 address
 * (::ffff:0:0/96), or null otherwise. */
function ipv4MappedAddress(groups: number[]): string | null {
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  if (!isMapped) return null
  const g6 = groups[6] ?? 0
  const g7 = groups[7] ?? 0
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`
}

/** IPv6 D4 ranges: ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local), and any
 * IPv4-mapped IPv6 address (::ffff:0:0/96) whose embedded v4 address is private — matched by
 * parsing to numeric 16-bit groups (expandIPv6Groups) rather than a fragile textual prefix, so
 * detection is correct regardless of hex-vs-dotted rendering or leading-zero compression. */
export function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6Groups(ip.toLowerCase())
  // Not a parseable IPv6 address at all — refuse rather than silently allow.
  if (!groups) return true
  if (isIPv6Loopback(groups) || isUniqueLocalIPv6(groups) || isLinkLocalIPv6(groups)) return true
  const mappedV4 = ipv4MappedAddress(groups)
  return mappedV4 !== null && isPrivateIPv4(mappedV4)
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
