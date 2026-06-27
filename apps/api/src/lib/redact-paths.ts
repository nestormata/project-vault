export const PINO_REDACT_PATHS = [
  // Epic AC literal paths
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.passphrase', // Story 1.5
  'req.body.masterKeyPath',
  'req.body.envelopeKeyPath', // Story 1.5
  'req.body.secret',
  'req.body.value',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.totp',
  'req.body.recoveryCode',
  'req.body.currentPassword',
  'req.body.newPassword',
  'res.body.data.secret',
  'res.body.data.otpauthUrl',
  'res.body.data.qrCodeSvg',
  'res.body.data.recoveryCodes',
  // Nested / wildcard (single-level only — see Story 1.10 AC-6 known limitation)
  '*.password',
  '*.passphrase',
  '*.secret',
  '*.masterKeyPath',
  '*.envelopeKeyPath',
  '*.value',
  '*.recoveryCode',
  '*.totp',
  // Story 1.9 — never log attempted email at info+
  'attemptedEmail',
  'attempted_email',
] as const
