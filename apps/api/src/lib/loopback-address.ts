import { BlockList, isIP } from 'node:net'

/**
 * The loopback allowlist shared by /metrics and /status's no-token safe default: exactly
 * 127.0.0.1 and ::1 (no 127/8 widening). `net.BlockList` matches an IPv4-mapped IPv6 address
 * (::ffff:127.0.0.1, which a dual-stack socket reports for an IPv4 loopback peer) against the
 * IPv4 rule natively, so no hand-maintained list of textual forms is needed.
 */
const LOOPBACK = new BlockList()
LOOPBACK.addAddress('127.0.0.1', 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/** True when a raw socket `remoteAddress` is the loopback peer. Not an IP at all → false. */
export function isLoopbackSocketAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return LOOPBACK.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
