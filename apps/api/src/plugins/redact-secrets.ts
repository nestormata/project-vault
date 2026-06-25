const REDACTED_FIELDS = new Set(['passphrase', 'masterKeyPath', 'envelopeKeyPath'])

export function redactBodyForLog(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const copy = { ...(body as Record<string, unknown>) }
  for (const key of REDACTED_FIELDS) {
    if (key in copy) copy[key] = '[REDACTED]'
  }
  return copy
}
