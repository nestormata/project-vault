import { BODY_SENSITIVE_LOG_FIELDS } from '../lib/redact-paths.js'

export const REDACTED_BODY_FIELDS = new Set<string>(BODY_SENSITIVE_LOG_FIELDS)

export function redactBodyForLog(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const copy = { ...(body as Record<string, unknown>) }
  for (const key of REDACTED_BODY_FIELDS) {
    if (key in copy) copy[key] = '[REDACTED]'
  }
  return copy
}
