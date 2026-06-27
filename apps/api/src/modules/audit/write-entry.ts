import { createHmac } from 'node:crypto'

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike | undefined }

function sortKeys(value: unknown): JsonLike {
  if (value === null || typeof value !== 'object') {
    return value as JsonLike
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item))
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, JsonLike>>((acc, key) => {
      const nested = (value as Record<string, unknown>)[key]
      if (nested !== undefined) {
        acc[key] = sortKeys(nested)
      }
      return acc
    }, {})
}

/** Canonical JSON: sorted keys, no whitespace; matches the Story 8.1 audit HMAC contract. */
export function computeAuditHmac(fields: Record<string, unknown>, auditKey: Buffer): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', auditKey).update(canonical).digest('hex')
}
