/**
 * Fastify's `trustProxy` option type union dropped `number` as of fastify 5.12.1 (still runtime
 * supported — fastify's own lib/request.js turns a numeric trustProxy into exactly this
 * `(address, hop) => hop < n` function internally). Extracted here so the hop-count logic has a
 * direct, isolated unit test rather than depending on an HTTP round-trip through createApp() for
 * coverage.
 */
export function resolveTrustProxy(
  trustProxyEnabled: boolean,
  hops: number
): false | ((address: string, hop: number) => boolean) {
  if (!trustProxyEnabled) return false
  return (_address: string, hop: number) => hop < hops
}
