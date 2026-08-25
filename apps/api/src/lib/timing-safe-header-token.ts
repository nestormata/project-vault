import { timingSafeEqual } from 'node:crypto'

/**
 * Shared by every static-shared-secret header check (vault bootstrap, service provisioning, and
 * any future one): reads a single-valued header and compares it to `expectedToken` in constant
 * time. `supplied.length !== expectedToken.length` short-circuits before `timingSafeEqual` (which
 * throws on mismatched buffer lengths) rather than leaking length via an exception path — this is
 * itself still constant-time with respect to the token's *content*, only its length is compared
 * up front, matching the convention every one of these call sites already used independently.
 */
export function timingSafeHeaderTokenMatches(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
  expectedToken: string
): boolean {
  const header = headers[headerName]
  const supplied = Array.isArray(header) ? header[0] : header
  return (
    !!supplied &&
    supplied.length === expectedToken.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedToken))
  )
}
