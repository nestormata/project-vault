import { BODY_SENSITIVE_LOG_FIELDS } from '../lib/redact-paths.js'

export const REDACTED_BODY_FIELDS = new Set<string>(BODY_SENSITIVE_LOG_FIELDS)

export function redactBodyForLog(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => [
      key,
      REDACTED_BODY_FIELDS.has(key) ? '[REDACTED]' : value,
    ])
  )
}
