import { createHmac } from 'node:crypto'

type JsonLike =
  string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike | undefined }

/** Canonical key-sorting for HMAC input — exported so Story 9.4's platform-audit equivalent
 * (`modules/platform-audit/write-entry.ts`) can reuse it verbatim rather than duplicating it. */
export function sortKeys(value: unknown): JsonLike {
  if (value === null || typeof value !== 'object') {
    return value as JsonLike
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item))
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortKeys(nested)])
  )
}

/** Canonical JSON: sorted keys, no whitespace; matches the Story 8.1 audit HMAC contract. */
export function computeAuditHmac(fields: Record<string, unknown>, auditKey: Buffer): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', auditKey).update(canonical).digest('hex')
}
