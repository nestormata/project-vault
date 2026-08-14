export const HEADER_SENSITIVE_LOG_FIELDS = ['authorization', 'cookie'] as const

export const BODY_SENSITIVE_LOG_FIELDS = [
  'password',
  'passphrase',
  'masterKeyPath',
  'envelopeKeyPath',
  'secret',
  'value',
  'newValue',
  'refreshToken',
  'accessToken',
  'totp',
  'recoveryCode',
  'currentPassword',
  'newPassword',
  'otpauthUrl',
  'qrCodeSvg',
  'recoveryCodes',
  // Story 9.1 D4: BACKUP_DATABASE_URL (and any field carrying it) embeds superuser/BYPASSRLS
  // credentials for pg_dump/pg_restore — never logged, alongside the existing password/
  // passphrase redaction above.
  'backupDatabaseUrl',
  // Story 24.2: the validated admin-pool URL may appear in an env-shaped diagnostic object.
  // Keep both the schema's SCREAMING_SNAKE key and the camelCase compatibility spelling covered.
  'adminDatabaseUrl',
  'ADMIN_DATABASE_URL',
  // Epic 17 retro (2026-07-29) Finding: story 17-2's step-up body carries `totpCode` (not `totp`,
  // the pre-existing field name), so it fell outside this registry despite AC-18 requiring it be
  // redacted by name — no live leak found (no request-logging call currently dumps req.body
  // wholesale on the step-up path), but the durable safeguard was missing. Added here rather than
  // left as a one-off inline redaction so any future logging change is covered automatically.
  'totpCode',
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
