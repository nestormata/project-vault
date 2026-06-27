const REDACTED_FIELDS = new Set([
  'password',
  'passphrase',
  'masterKeyPath',
  'envelopeKeyPath',
  'totp',
  'recoveryCode',
  'secret',
  'otpauthUrl',
  'qrCodeSvg',
  'recoveryCodes',
  'value',
  'refreshToken',
  'accessToken',
  'currentPassword',
  'newPassword',
])

export function redactBodyForLog(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const copy = { ...(body as Record<string, unknown>) }
  for (const key of REDACTED_FIELDS) {
    if (key in copy) copy[key] = '[REDACTED]'
  }
  return copy
}
