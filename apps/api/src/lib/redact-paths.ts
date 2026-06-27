export const HEADER_SENSITIVE_LOG_FIELDS = ['authorization', 'cookie'] as const

export const BODY_SENSITIVE_LOG_FIELDS = [
  'password',
  'passphrase',
  'masterKeyPath',
  'envelopeKeyPath',
  'secret',
  'value',
  'refreshToken',
  'accessToken',
  'totp',
  'recoveryCode',
  'currentPassword',
  'newPassword',
  'otpauthUrl',
  'qrCodeSvg',
  'recoveryCodes',
] as const

const requestHeaderRedactPaths = HEADER_SENSITIVE_LOG_FIELDS.map((field) => `req.headers.${field}`)
const requestBodyRedactPaths = BODY_SENSITIVE_LOG_FIELDS.map((field) => `req.body.${field}`)
const singleLevelRedactPaths = BODY_SENSITIVE_LOG_FIELDS.map((field) => `*.${field}`)

export const PINO_REDACT_PATHS = [
  // Epic AC literal paths
  ...requestHeaderRedactPaths,
  ...requestBodyRedactPaths,
  'res.body.data.secret',
  'res.body.data.otpauthUrl',
  'res.body.data.qrCodeSvg',
  'res.body.data.recoveryCodes',
  // Nested / wildcard (single-level only — see Story 1.10 AC-6 known limitation)
  ...singleLevelRedactPaths,
  // Story 1.9 — never log attempted email at info+
  'attemptedEmail',
  'attempted_email',
] as const
