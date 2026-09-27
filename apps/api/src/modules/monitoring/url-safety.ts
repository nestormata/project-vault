import net from 'node:net'
import dns from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { Agent, buildConnector, type Dispatcher } from 'undici'

/**
 * Story 6.2 AC 1/2, ADR-6.2-08: registration-time and check-time SSRF validation for
 * service_endpoints URLs, plus ADR-6.2-11's URL redaction for any credential-bearing URL
 * component. architecture.md mandates rejecting RFC1918 private ranges, loopback, link-local
 * (including cloud metadata addresses), and IPv6 equivalents at registration time — and,
 * per the adversarial review, re-validating every redirect hop and pinning every outbound
 * connection to its validated address at check time (closing the DNS-rebinding TOCTOU gap a
 * "validate once, connect later" approach would leave open).
 */

export class UrlNotMonitorableError extends Error {
  readonly code = 'url_not_allowed'

  constructor(
    message = 'URL resolves to a private, loopback, or reserved address and cannot be monitored'
  ) {
    super(message)
    this.name = 'UrlNotMonitorableError'
  }
}

// The SSRF block set (Story 6.2 AC 1/2, ADR-6.2-08), classified by ipaddr.js's IANA
// special-purpose registry (`range()`) instead of a hand-maintained range table:
// - IPv4: RFC 1918 private, loopback 127/8, link-local 169.254/16 (includes the
//   169.254.169.254 cloud metadata address) and unspecified 0.0.0.0/8 (Story 43.9 AC-12:
//   0.0.0.0 reaches the local host on Linux).
// - IPv6: loopback ::1, unique-local fc00::/7, link-local fe80::/10 and unspecified ::
//   (Story 43.9 AC-12, same reason). IPv4-mapped addresses (::ffff:a.b.c.d, in dotted or hex
//   form) are unwrapped and checked against the IPv4 set.
// Deliberately NOT blocked (unchanged, see the deferred-work ledger): CGNAT, multicast, 240/4.
const BLOCKED_V4_RANGES: ReadonlySet<string> = new Set([
  'private',
  'loopback',
  'linkLocal',
  'unspecified',
])
const BLOCKED_V6_RANGES: ReadonlySet<string> = new Set([
  'loopback',
  'uniqueLocal',
  'linkLocal',
  'unspecified',
])

/** `dotted` must be strict four-part decimal; anything else fails closed, because ipaddr.js's
 * lenient parser would read e.g. '010.0.0.1' as octal 8.0.0.1 (public). */
function isBlockedIpv4(dotted: string): boolean {
  if (!ipaddr.IPv4.isValidFourPartDecimal(dotted)) return true
  return BLOCKED_V4_RANGES.has(ipaddr.IPv4.parse(dotted).range())
}

function isBlockedIpv6(address: string): boolean {
  const parsed = ipaddr.IPv6.parse(address)
  if (parsed.isIPv4MappedAddress()) return isBlockedIpv4(parsed.toIPv4Address().toString())
  return BLOCKED_V6_RANGES.has(parsed.range())
}

/**
 * Canonicalizes well-known SSRF-filter-bypass numeric IPv4 encodings (decimal, hex, octal —
 * e.g. `2130706433`, `0x7f000001`, `017700000001`, all meaning 127.0.0.1) to dotted-decimal
 * form. Returns null for anything that isn't one of these exact literal forms.
 */
function canonicalizeNumericIpv4Literal(input: string): string | null {
  let value: number
  // Order matters: a leading-zero digit string (e.g. "017700000001") is also a syntactically
  // valid decimal number, so octal must be checked before the plain-decimal branch below —
  // otherwise the octal case would always be misparsed as (and rejected as too large for) decimal.
  if (/^0x[0-9a-f]+$/i.test(input)) {
    value = Number.parseInt(input, 16)
  } else if (/^0[0-7]+$/.test(input)) {
    value = Number.parseInt(input, 8)
  } else if (/^\d+$/.test(input)) {
    value = Number(input)
  } else {
    return null
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null
  const octets = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  return octets.join('.')
}

/**
 * Pure function: is this IP address (or numeric-literal-encoded IPv4 form) private, loopback,
 * link-local, or otherwise reserved and therefore unsafe to health-check? Canonicalizes
 * encoded/obfuscated forms to dotted-decimal before range-checking (adversarial-review
 * finding 7) — a hostname string that isn't any recognizable IP form returns false here
 * (callers that need to validate an arbitrary hostname must resolve it first).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim()
  if (net.isIPv4(trimmed)) return isBlockedIpv4(trimmed)
  if (net.isIPv6(trimmed)) return isBlockedIpv6(trimmed)
  const canonicalIpv4 = canonicalizeNumericIpv4Literal(trimmed)
  if (canonicalIpv4) return isBlockedIpv4(canonicalIpv4)
  return false
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * AC 1/2: synchronous (relative to the caller) registration/update-time validation. Parses the
 * URL, rejects non-http/https schemes and a literal `localhost` hostname, then resolves the
 * hostname (or parses a literal IP) and rejects if ANY resolved address is private/reserved —
 * AC 2's "mixed public/private DNS answers" edge case: reject on any match, never cherry-pick.
 */
export async function assertUrlIsMonitorable(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UrlNotMonitorableError('URL is not a valid absolute URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlNotMonitorableError('Only http and https URLs can be monitored')
  }

  const hostname = stripBrackets(parsed.hostname)
  if (hostname.toLowerCase() === 'localhost') {
    throw new UrlNotMonitorableError()
  }

  if (isPrivateOrReservedIp(hostname)) {
    throw new UrlNotMonitorableError()
  }
  if (net.isIP(hostname)) {
    return // a literal, already-validated public IP — nothing left to resolve
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    throw new UrlNotMonitorableError('Unable to resolve hostname')
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new UrlNotMonitorableError()
  }
}

/**
 * ADR-6.2-08: an undici Agent whose custom `connect` re-resolves the target hostname itself
 * (never relying on a separate, earlier DNS answer) and pins the actual outbound TCP/TLS
 * connection to the exact address it just validated — closing the TOCTOU gap a "validate at
 * registration, connect independently at check time" flow would leave open for DNS rebinding.
 * Every health-check probe (including every manually-followed redirect hop, per AC 4) must use
 * this dispatcher; there is no other outbound path to a monitored endpoint.
 */
export function createSsrfSafeDispatcher(): Dispatcher {
  const connect = buildConnector({})

  return new Agent({
    connect: (options, callback) => {
      const hostname = options.hostname
      void (async () => {
        try {
          if (isPrivateOrReservedIp(hostname)) {
            throw new UrlNotMonitorableError()
          }
          let targetHostname = hostname
          if (!net.isIP(hostname)) {
            const addresses = await dns.lookup(hostname, { all: true })
            const blocked = addresses.some((a) => isPrivateOrReservedIp(a.address))
            if (blocked || addresses.length === 0) {
              throw new UrlNotMonitorableError()
            }
            targetHostname = addresses[0]?.address ?? hostname
          }
          connect(
            { ...options, hostname: targetHostname, servername: options.servername ?? hostname },
            callback
          )
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)), null)
        }
      })()
    },
  })
}

const SECRET_QUERY_PARAM_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'access_token',
  'auth',
])

/**
 * ADR-6.2-11: strips any userinfo component and masks the value of any query parameter whose
 * key case-insensitively matches a small deny-list — pure, stateless, no schema/column impact.
 * The raw url remains the single source of truth in the DB and is what the health-check worker
 * actually connects to; this is applied only at read/write response boundaries and audit-log
 * payload snapshots (never the probe itself).
 */
export function redactUrlForDisplay(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  parsed.username = ''
  parsed.password = ''

  const redactedParams = new URLSearchParams()
  for (const [key, value] of parsed.searchParams) {
    redactedParams.append(
      key,
      SECRET_QUERY_PARAM_KEYS.has(key.toLowerCase()) ? '***REDACTED***' : value
    )
  }
  parsed.search = redactedParams.toString()

  return parsed.toString()
}
