// Story 31.1 (DW-130) AC7.26: the machine-authenticated org-wide revocation route's static
// shared-secret header — never logged, on the same header-redaction surface as authorization/
// cookie, even though (unlike them) no existing request-logging call currently dumps req.headers
// wholesale; this closes the gap defensively, exactly as Story 28.9's res.headers['x-export-key']
// entry below does for its own one-time-secret header.
export const HEADER_SENSITIVE_LOG_FIELDS = [
  'authorization',
  'cookie',
  'x-service-revocation-token',
] as const

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
  'extensionDatabaseUrl',
  'EXTENSION_DATABASE_URL',
  'extensionGrantDatabaseUrl',
  'EXTENSION_GRANT_DATABASE_URL',
  // Epic 17 retro (2026-07-29) Finding: story 17-2's step-up body carries `totpCode` (not `totp`,
  // the pre-existing field name), so it fell outside this registry despite AC-18 requiring it be
  // redacted by name — no live leak found (no request-logging call currently dumps req.body
  // wholesale on the step-up path), but the durable safeguard was missing. Added here rather than
  // left as a one-off inline redaction so any future logging change is covered automatically.
  'totpCode',
  // Story 28.9 D2: the one-time project-export decryption key. Never persisted server-side, and
  // never logged either — the create-export response header carries it (see the dedicated
  // `res.headers` redact path below) and the import request's multipart form carries it as
  // `exportKey`; both must be redacted the same as any other bearer secret if a future logger
  // ever captures either surface wholesale.
  'exportKey',
  // Story 30.2 AC6.22: /auth/handoff/prepare's request body carries the raw compact JWS under
  // `token` — this must never appear in a log line, matching the same never-leak-the-secret-body
  // discipline as every other field in this registry.
  'token',
] as const

const requestHeaderRedactPaths = HEADER_SENSITIVE_LOG_FIELDS.map((field) => `req.headers.${field}`)
const requestBodyRedactPaths = BODY_SENSITIVE_LOG_FIELDS.map((field) => `req.body.${field}`)
const singleLevelRedactPaths = BODY_SENSITIVE_LOG_FIELDS.map((field) => `*.${field}`)

export const PINO_REDACT_PATHS = [
  // Epic AC literal paths
  ...requestHeaderRedactPaths,
  ...requestBodyRedactPaths,
  // Story 28.9 AC-2: the create-export response returns the raw one-time key in the
  // `X-Export-Key` response header (never the body) — redacted defensively in case a future
  // request/response logger middleware ever captures response headers wholesale (this app's
  // current structured-logging plugin does not, by design, but this closes the gap either way).
  'res.headers["x-export-key"]',
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
