import { z } from 'zod/v4'

const DEV_SESSION_SECRET = 'a'.repeat(64)
const DEV_REFRESH_TOKEN_HMAC_SECRET = 'b'.repeat(64)
const DEV_MFA_PENDING_SESSION_HMAC_SECRET = 'd'.repeat(64)
const DEV_INVITATION_TOKEN_HMAC_SECRET = 'e'.repeat(64)
const DEV_RECOVERY_TOKEN_HMAC_SECRET = 'f'.repeat(64)
const DEV_API_KEY_HMAC_SECRET = 'g'.repeat(64)
const DEV_MACHINE_JWT_SECRET = 'h'.repeat(64)
const DEV_STATUS_PAGE_TOKEN_HMAC_SECRET = 'i'.repeat(64)
const DEV_ERASURE_EMAIL_HASH_SECRET = 'j'.repeat(64)
const DEV_AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'c/PLdA7Wvhkg8hPqLu5AlQ',
  ['7zS8GhNt', 'QTJsiMmJ', 'LErN9kM1', '9VoNBM3P', 'HV3OhidvHtY'].join(''),
].join('$')
const PLACEHOLDER_SECRET_PATTERN = /change-me|dev-only|placeholder/i
// Story 9.1 AC-14: syntactic-only 5-field cron validation (no minimum-interval constraint, unlike
// packages/shared/src/validation/rotation-cron.ts's validateRotationCron — backup scheduling has
// no analogous "too frequent" concern, just "is this parseable at all").
// A single comma-separated term (no repeating group — comma-splitting happens in JS below,
// avoiding a nested-quantifier regex that static analysis flags as a potential ReDoS risk).
const CRON_TERM_PATTERN = /^(\*|\d{1,2})(-\d{1,2})?(\/\d{1,2})?$/
function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => field.split(',').every((term) => CRON_TERM_PATTERN.test(term)))
}
const isProduction = process.env.NODE_ENV === 'production'
const ARGON2_PHC_REGEX =
  /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/._-]{16,}\$[A-Za-z0-9+/._-]{32,}$/

type ProductionEnv = {
  COOKIE_SECURE: boolean
  SESSION_SECRET: string
  REFRESH_TOKEN_HMAC_SECRET: string
  FAILED_AUTH_RECORD_ENABLED: boolean
  TOTP_REPLAY_HMAC_SECRET?: string
  MFA_PENDING_SESSION_HMAC_SECRET?: string
  INVITATION_TOKEN_HMAC_SECRET?: string
  RECOVERY_TOKEN_HMAC_SECRET?: string
  API_KEY_HMAC_SECRET?: string
  MACHINE_JWT_SECRET?: string
  STATUS_PAGE_TOKEN_HMAC_SECRET?: string
  ERASURE_EMAIL_HASH_SECRET?: string
  LOG_LEVEL: string
}

function addEnvIssue(ctx: z.RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: 'custom', path: [path], message })
}

function validateProductionBasics(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
    addEnvIssue(ctx, 'LOG_LEVEL', 'FATAL: LOG_LEVEL must not be debug or trace in production')
  }
  if (!env.COOKIE_SECURE) {
    addEnvIssue(ctx, 'COOKIE_SECURE', 'FATAL: COOKIE_SECURE must be true in production')
  }

  if (PLACEHOLDER_SECRET_PATTERN.test(env.SESSION_SECRET)) {
    addEnvIssue(
      ctx,
      'SESSION_SECRET',
      'SESSION_SECRET must not be a placeholder secret in production'
    )
  }
  if (PLACEHOLDER_SECRET_PATTERN.test(env.REFRESH_TOKEN_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'REFRESH_TOKEN_HMAC_SECRET',
      'REFRESH_TOKEN_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
  if (!env.FAILED_AUTH_RECORD_ENABLED) {
    addEnvIssue(
      ctx,
      'FAILED_AUTH_RECORD_ENABLED',
      'FATAL: FAILED_AUTH_RECORD_ENABLED must not be false in production'
    )
  }
}

function validateTotpReplayProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.TOTP_REPLAY_HMAC_SECRET) {
    addEnvIssue(ctx, 'TOTP_REPLAY_HMAC_SECRET', 'TOTP_REPLAY_HMAC_SECRET is required in production')
  } else if (env.TOTP_REPLAY_HMAC_SECRET === env.REFRESH_TOKEN_HMAC_SECRET) {
    addEnvIssue(
      ctx,
      'TOTP_REPLAY_HMAC_SECRET',
      'TOTP_REPLAY_HMAC_SECRET must differ from REFRESH_TOKEN_HMAC_SECRET in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.TOTP_REPLAY_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'TOTP_REPLAY_HMAC_SECRET',
      'TOTP_REPLAY_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

function validatePendingMfaProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.MFA_PENDING_SESSION_HMAC_SECRET) {
    addEnvIssue(
      ctx,
      'MFA_PENDING_SESSION_HMAC_SECRET',
      'MFA_PENDING_SESSION_HMAC_SECRET is required in production'
    )
  } else if (
    env.MFA_PENDING_SESSION_HMAC_SECRET === env.SESSION_SECRET ||
    env.MFA_PENDING_SESSION_HMAC_SECRET === env.REFRESH_TOKEN_HMAC_SECRET ||
    env.MFA_PENDING_SESSION_HMAC_SECRET === env.TOTP_REPLAY_HMAC_SECRET
  ) {
    addEnvIssue(
      ctx,
      'MFA_PENDING_SESSION_HMAC_SECRET',
      'MFA_PENDING_SESSION_HMAC_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.MFA_PENDING_SESSION_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'MFA_PENDING_SESSION_HMAC_SECRET',
      'MFA_PENDING_SESSION_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

function validateInvitationTokenProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.INVITATION_TOKEN_HMAC_SECRET) {
    addEnvIssue(
      ctx,
      'INVITATION_TOKEN_HMAC_SECRET',
      'INVITATION_TOKEN_HMAC_SECRET is required in production'
    )
  } else if (
    env.INVITATION_TOKEN_HMAC_SECRET === env.SESSION_SECRET ||
    env.INVITATION_TOKEN_HMAC_SECRET === env.REFRESH_TOKEN_HMAC_SECRET ||
    env.INVITATION_TOKEN_HMAC_SECRET === env.TOTP_REPLAY_HMAC_SECRET ||
    env.INVITATION_TOKEN_HMAC_SECRET === env.MFA_PENDING_SESSION_HMAC_SECRET
  ) {
    addEnvIssue(
      ctx,
      'INVITATION_TOKEN_HMAC_SECRET',
      'INVITATION_TOKEN_HMAC_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.INVITATION_TOKEN_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'INVITATION_TOKEN_HMAC_SECRET',
      'INVITATION_TOKEN_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

function validateRecoveryTokenProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.RECOVERY_TOKEN_HMAC_SECRET) {
    addEnvIssue(
      ctx,
      'RECOVERY_TOKEN_HMAC_SECRET',
      'RECOVERY_TOKEN_HMAC_SECRET is required in production'
    )
  } else if (
    env.RECOVERY_TOKEN_HMAC_SECRET === env.SESSION_SECRET ||
    env.RECOVERY_TOKEN_HMAC_SECRET === env.REFRESH_TOKEN_HMAC_SECRET ||
    env.RECOVERY_TOKEN_HMAC_SECRET === env.TOTP_REPLAY_HMAC_SECRET ||
    env.RECOVERY_TOKEN_HMAC_SECRET === env.MFA_PENDING_SESSION_HMAC_SECRET ||
    env.RECOVERY_TOKEN_HMAC_SECRET === env.INVITATION_TOKEN_HMAC_SECRET
  ) {
    addEnvIssue(
      ctx,
      'RECOVERY_TOKEN_HMAC_SECRET',
      'RECOVERY_TOKEN_HMAC_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.RECOVERY_TOKEN_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'RECOVERY_TOKEN_HMAC_SECRET',
      'RECOVERY_TOKEN_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

function validateApiKeyProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.API_KEY_HMAC_SECRET) {
    addEnvIssue(ctx, 'API_KEY_HMAC_SECRET', 'API_KEY_HMAC_SECRET is required in production')
  } else if (
    env.API_KEY_HMAC_SECRET === env.SESSION_SECRET ||
    env.API_KEY_HMAC_SECRET === env.REFRESH_TOKEN_HMAC_SECRET ||
    env.API_KEY_HMAC_SECRET === env.TOTP_REPLAY_HMAC_SECRET ||
    env.API_KEY_HMAC_SECRET === env.MFA_PENDING_SESSION_HMAC_SECRET ||
    env.API_KEY_HMAC_SECRET === env.INVITATION_TOKEN_HMAC_SECRET ||
    env.API_KEY_HMAC_SECRET === env.RECOVERY_TOKEN_HMAC_SECRET
  ) {
    addEnvIssue(
      ctx,
      'API_KEY_HMAC_SECRET',
      'API_KEY_HMAC_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.API_KEY_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'API_KEY_HMAC_SECRET',
      'API_KEY_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

function validateMachineJwtProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.MACHINE_JWT_SECRET) {
    addEnvIssue(ctx, 'MACHINE_JWT_SECRET', 'MACHINE_JWT_SECRET is required in production')
  } else if (
    env.MACHINE_JWT_SECRET === env.SESSION_SECRET ||
    env.MACHINE_JWT_SECRET === env.REFRESH_TOKEN_HMAC_SECRET ||
    env.MACHINE_JWT_SECRET === env.TOTP_REPLAY_HMAC_SECRET ||
    env.MACHINE_JWT_SECRET === env.MFA_PENDING_SESSION_HMAC_SECRET ||
    env.MACHINE_JWT_SECRET === env.INVITATION_TOKEN_HMAC_SECRET ||
    env.MACHINE_JWT_SECRET === env.RECOVERY_TOKEN_HMAC_SECRET ||
    env.MACHINE_JWT_SECRET === env.API_KEY_HMAC_SECRET
  ) {
    addEnvIssue(
      ctx,
      'MACHINE_JWT_SECRET',
      'MACHINE_JWT_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.MACHINE_JWT_SECRET)) {
    addEnvIssue(
      ctx,
      'MACHINE_JWT_SECRET',
      'MACHINE_JWT_SECRET must not be a placeholder secret in production'
    )
  }
}

// Story 6.3 is the 8th dedicated-secret requirement — an OR-chain mirroring the other
// validate*ProductionSecret functions' exact style would push this function's cyclomatic
// complexity past the repo's eslint threshold, so this one instead checks membership against an
// array of the other auth secrets (same comparison set, just expressed without one branch per
// secret).
function statusPageTokenSharesAnotherAuthSecret(env: ProductionEnv): boolean {
  const otherSecrets = [
    env.SESSION_SECRET,
    env.REFRESH_TOKEN_HMAC_SECRET,
    env.TOTP_REPLAY_HMAC_SECRET,
    env.MFA_PENDING_SESSION_HMAC_SECRET,
    env.INVITATION_TOKEN_HMAC_SECRET,
    env.RECOVERY_TOKEN_HMAC_SECRET,
    env.API_KEY_HMAC_SECRET,
    env.MACHINE_JWT_SECRET,
  ]
  return otherSecrets.includes(env.STATUS_PAGE_TOKEN_HMAC_SECRET)
}

function validateStatusPageTokenProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.STATUS_PAGE_TOKEN_HMAC_SECRET) {
    addEnvIssue(
      ctx,
      'STATUS_PAGE_TOKEN_HMAC_SECRET',
      'STATUS_PAGE_TOKEN_HMAC_SECRET is required in production'
    )
  } else if (statusPageTokenSharesAnotherAuthSecret(env)) {
    addEnvIssue(
      ctx,
      'STATUS_PAGE_TOKEN_HMAC_SECRET',
      'STATUS_PAGE_TOKEN_HMAC_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.STATUS_PAGE_TOKEN_HMAC_SECRET)) {
    addEnvIssue(
      ctx,
      'STATUS_PAGE_TOKEN_HMAC_SECRET',
      'STATUS_PAGE_TOKEN_HMAC_SECRET must not be a placeholder secret in production'
    )
  }
}

// Story 8.4 D6: same array-based comparison this file already uses for
// STATUS_PAGE_TOKEN_HMAC_SECRET (Story 6.3) — a 9th OR-chain would push cyclomatic complexity
// past the repo's eslint threshold. Never reuse the audit-log HMAC key (Story 8.1) either — that
// key's rotation lifecycle is scoped to audit integrity, not this unrelated re-invite-block
// purpose (D6) — but that key isn't part of this env-secret comparison set, so nothing to add here.
function erasureEmailHashSharesAnotherAuthSecret(env: ProductionEnv): boolean {
  const otherSecrets = [
    env.SESSION_SECRET,
    env.REFRESH_TOKEN_HMAC_SECRET,
    env.TOTP_REPLAY_HMAC_SECRET,
    env.MFA_PENDING_SESSION_HMAC_SECRET,
    env.INVITATION_TOKEN_HMAC_SECRET,
    env.RECOVERY_TOKEN_HMAC_SECRET,
    env.API_KEY_HMAC_SECRET,
    env.MACHINE_JWT_SECRET,
    env.STATUS_PAGE_TOKEN_HMAC_SECRET,
  ]
  return otherSecrets.includes(env.ERASURE_EMAIL_HASH_SECRET)
}

function validateErasureEmailHashProductionSecret(env: ProductionEnv, ctx: z.RefinementCtx): void {
  if (!env.ERASURE_EMAIL_HASH_SECRET) {
    addEnvIssue(
      ctx,
      'ERASURE_EMAIL_HASH_SECRET',
      'ERASURE_EMAIL_HASH_SECRET is required in production'
    )
  } else if (erasureEmailHashSharesAnotherAuthSecret(env)) {
    addEnvIssue(
      ctx,
      'ERASURE_EMAIL_HASH_SECRET',
      'ERASURE_EMAIL_HASH_SECRET must differ from other auth secrets in production'
    )
  } else if (PLACEHOLDER_SECRET_PATTERN.test(env.ERASURE_EMAIL_HASH_SECRET)) {
    addEnvIssue(
      ctx,
      'ERASURE_EMAIL_HASH_SECRET',
      'ERASURE_EMAIL_HASH_SECRET must not be a placeholder secret in production'
    )
  }
}

// Story 9.1 AC-14/AC-15: backup is opt-in. "Enabled" means at least one of
// STORAGE_PATH/S3_BUCKET/DATABASE_URL is configured — any one of them alone is enough to trigger
// the fail-fast checks below, since all three are required together for a working setup.
function validateBackupEnv(
  env: {
    BACKUP_SCHEDULE: string
    BACKUP_STORAGE_PATH?: string
    BACKUP_S3_BUCKET?: string
    BACKUP_DATABASE_URL?: string
  },
  ctx: z.RefinementCtx
): void {
  const enabled = Boolean(
    env.BACKUP_STORAGE_PATH || env.BACKUP_S3_BUCKET || env.BACKUP_DATABASE_URL
  )
  if (!enabled) return

  if (env.BACKUP_STORAGE_PATH && env.BACKUP_S3_BUCKET) {
    addEnvIssue(
      ctx,
      'BACKUP_STORAGE_PATH',
      'FATAL: BACKUP_STORAGE_PATH and BACKUP_S3_BUCKET are mutually exclusive — configure exactly one backup destination.'
    )
  }
  if (!env.BACKUP_STORAGE_PATH && !env.BACKUP_S3_BUCKET) {
    addEnvIssue(
      ctx,
      'BACKUP_STORAGE_PATH',
      'FATAL: Backup is enabled but neither BACKUP_STORAGE_PATH nor BACKUP_S3_BUCKET is configured.'
    )
  }
  if (!env.BACKUP_DATABASE_URL) {
    addEnvIssue(
      ctx,
      'BACKUP_DATABASE_URL',
      'FATAL: Backup is enabled but BACKUP_DATABASE_URL is not configured — pg_dump/restore ' +
        'cannot use the RLS-restricted application DATABASE_URL (see Story 9.1 D4).'
    )
  }
  if (!isValidCronExpression(env.BACKUP_SCHEDULE)) {
    addEnvIssue(
      ctx,
      'BACKUP_SCHEDULE',
      'BACKUP_SCHEDULE must be a syntactically valid 5-field cron expression'
    )
  }
}

function validateProductionEnv(env: ProductionEnv, ctx: z.RefinementCtx): void {
  validateProductionBasics(env, ctx)
  validateTotpReplayProductionSecret(env, ctx)
  validatePendingMfaProductionSecret(env, ctx)
  validateInvitationTokenProductionSecret(env, ctx)
  validateRecoveryTokenProductionSecret(env, ctx)
  validateApiKeyProductionSecret(env, ctx)
  validateMachineJwtProductionSecret(env, ctx)
  validateStatusPageTokenProductionSecret(env, ctx)
  validateErasureEmailHashProductionSecret(env, ctx)
}

function validateDummyPasswordHash(
  env: {
    AUTH_DUMMY_PASSWORD_HASH: string
    ARGON2_MEMORY_COST: number
    ARGON2_TIME_COST: number
    ARGON2_PARALLELISM: number
  },
  ctx: z.RefinementCtx
): void {
  const dummyParams = ARGON2_PHC_REGEX.exec(env.AUTH_DUMMY_PASSWORD_HASH)
  if (
    !dummyParams ||
    Number(dummyParams[1]) !== env.ARGON2_MEMORY_COST ||
    Number(dummyParams[2]) !== env.ARGON2_TIME_COST ||
    Number(dummyParams[3]) !== env.ARGON2_PARALLELISM
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_DUMMY_PASSWORD_HASH'],
      message: 'AUTH_DUMMY_PASSWORD_HASH Argon2 params must match configured user-password params',
    })
  }
}

function booleanEnvDefault(defaultValue: boolean) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? String(defaultValue) : value),
    z.enum(['true', 'false']).transform((parsed) => parsed === 'true')
  )
}

function secretEnvDefault(defaultValue: string | undefined) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.string().min(32)
  )
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().default(3000),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          return new URL(value).username !== 'postgres'
        } catch {
          return false
        }
      }, "FATAL: DATABASE_URL must not use the 'postgres' superuser — RLS enforcement requires a non-superuser role.\nUse 'vault_app' or another application role. See .env.example."),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value
            .split(',')
            .map((item) => item.trim())
            .includes('*'),
        'CORS_ALLOWED_ORIGINS cannot contain "*"'
      )
      .default('http://localhost:5173'),
    METRICS_BIND_HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SERVICE_NAME: z
      .string()
      .regex(
        /^[a-z][a-z0-9_-]{0,63}$/,
        'SERVICE_NAME must be lowercase alphanumeric with hyphens/underscores, max 64 chars'
      )
      .default('api'),

    SESSION_SECRET: secretEnvDefault(isProduction ? undefined : DEV_SESSION_SECRET),
    REFRESH_TOKEN_HMAC_SECRET: secretEnvDefault(
      isProduction ? undefined : DEV_REFRESH_TOKEN_HMAC_SECRET
    ),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(600).default(300),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    SESSION_ACTIVITY_DEBOUNCE_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
    MAX_SESSIONS_PER_USER: z.coerce.number().int().min(0).default(0),
    JWT_MAX_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    REFRESH_GRACE_WINDOW_SECONDS: z.coerce.number().int().positive().default(30),
    MFA_TOTP_ISSUER: z.string().min(1).max(64).default('Project Vault'),
    MFA_TOTP_PERIOD_SECONDS: z.coerce
      .number()
      .int()
      .refine((value) => value === 30, 'MFA_TOTP_PERIOD_SECONDS must be 30 in v1')
      .default(30),
    MFA_TOTP_DIGITS: z.coerce
      .number()
      .int()
      .refine((value) => value === 6, 'MFA_TOTP_DIGITS must be 6 in v1')
      .default(6),
    MFA_TOTP_WINDOW: z.coerce.number().int().min(0).max(2).default(1),
    MFA_RECOVERY_CODE_COUNT: z.coerce.number().int().min(8).max(16).default(10),
    MFA_RECOVERY_CODE_BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(12),
    TOTP_USED_CODES_TTL_MINUTES: z.coerce.number().int().positive().default(90),
    TOTP_REPLAY_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    MFA_PENDING_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    MFA_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    MFA_PENDING_SESSION_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    INVITATION_TOKEN_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    RECOVERY_TOKEN_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    API_KEY_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    // Story 7.2 D3: dedicated HS256 secret for the machine-token exchange JWT — never shared
    // with the human-session fastify.jwt instance's SESSION_SECRET.
    MACHINE_JWT_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    MACHINE_JWT_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(3600),
    // Story 6.3 ADR-6.3-06: dedicated HMAC secret for the public status-page opaque token,
    // reusing opaque-token.ts's shared generate/hash/compare primitives (mirrors
    // RECOVERY_TOKEN_HMAC_SECRET's exact shape).
    STATUS_PAGE_TOKEN_HMAC_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    // Story 8.4 D6: dedicated keyed-HMAC secret for data_erasure_requests.original_email_hash —
    // a bare unsalted hash of a low-entropy email address is brute-forceable, so this must be a
    // server-side secret never shared with any other auth-token HMAC (see the production
    // cross-secret checks below).
    ERASURE_EMAIL_HASH_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional()
    ),
    WEB_BASE_URL: z.url().default('http://localhost:5173'),
    MFA_PRIVILEGED_ROLE_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
    FAILED_AUTH_THRESHOLD_COUNT: z.coerce.number().int().min(3).max(100).default(10),
    FAILED_AUTH_THRESHOLD_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    FAILED_AUTH_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    FAILED_AUTH_RECORD_ENABLED: booleanEnvDefault(true),
    // Story 5.2 AC-7/AC-E5b: read fresh on every `retry` call (never cached/snapshotted per
    // rotation) — same env-var-as-admin-configurable-threshold convention as
    // FAILED_AUTH_THRESHOLD_COUNT/MFA_LOGIN_MAX_ATTEMPTS.
    ROTATION_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
    // Story 5.3 AC-8/CR1: the break-glass "emergency overlap" window (epics.md AC-E5c) — how
    // long the superseded credential version stays purge-protected before the overlap-expiry
    // job auto-retires it. Read fresh at break-glass time only (AC-8's edge case: lowering this
    // later never retroactively shortens an already-stored break_glass_overlap_expires_at).
    BREAK_GLASS_OVERLAP_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    // Story 5.3 AC-9 (CR2/ADR-5.3-02): the stale-rotation detection job's time threshold — an
    // in_progress rotation older than this is transitioned to stale_recovery. Read fresh on
    // every job run (never cached), same convention as ROTATION_MAX_RETRIES.
    STALE_ROTATION_THRESHOLD_MINUTES: z.coerce.number().int().min(15).max(10080).default(60),
    // Story 5.5 AC-4: break-glass double-submit idempotency window — a second break-glass call
    // for the same credential within this many seconds of the first returns the already-created
    // rotation instead of creating an independent second one. Deliberately short: the endpoint's
    // entire premise is acting "in seconds" during an incident (epics.md AC-E5c) — this only
    // needs to cover an accidental double-click/client-retry, not a legitimate follow-up
    // break-glass minutes later. Read fresh on every call, same convention as
    // ROTATION_MAX_RETRIES/STALE_ROTATION_THRESHOLD_MINUTES.
    BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
    ARGON2_MEMORY_COST: z.coerce.number().int().min(19456).max(262144).default(65536),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(4),
    AUTH_DUMMY_PASSWORD_HASH: z
      .string()
      .regex(ARGON2_PHC_REGEX, 'AUTH_DUMMY_PASSWORD_HASH must be a valid Argon2id PHC string')
      .default(DEV_AUTH_DUMMY_PASSWORD_HASH),
    AUTH_REGISTRATION_ENABLED: booleanEnvDefault(true),
    COOKIE_SECURE: booleanEnvDefault(isProduction),
    TRUST_PROXY: booleanEnvDefault(false),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(1).default(1),

    // Story 9.3 D5: fail-closed by design — Swagger UI (GET /api/v1/docs) and the live spec
    // route (GET /api/v1/openapi.json) are only registered when this is explicitly true, or
    // NODE_ENV is 'development'/'test' (checked at the app.ts registration call site, not here —
    // this flag alone does not imply "development also enables it"). Defaulting to false means a
    // self-hosted deployment never exposes a browsable map of every authenticated route/schema
    // unless an operator opts in.
    ENABLE_API_DOCS: booleanEnvDefault(false),

    // Credential version retention is irreversible (AC-8 R11/AC-11B O1). Production's first
    // run MUST default to dry-run (log-only); tests/dev default to destructive for coverage.
    CREDENTIAL_RETENTION_DRY_RUN: booleanEnvDefault(isProduction),

    // Directory for envelope/file key halves (read-only mount in production).
    VAULT_KEY_DIR: z.string().min(1).default('/run/secrets'),

    // Envelope mode only: 32 lowercase hex chars = 16-byte env half. Optional at startup.
    // Docker Compose's ${VAR:-} interpolation yields "" (not unset) when the host env var
    // is absent — preprocess treats that the same as "not configured".
    VAULT_ENVELOPE_KEY_HALF: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[0-9a-f]{32}$/, 'VAULT_ENVELOPE_KEY_HALF must be 32 lowercase hex characters')
        .optional()
    ),

    // First-init protection. Generate: openssl rand -base64 32
    VAULT_BOOTSTRAP_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32).optional()
    ),

    // Dev-only: allow init without bootstrap token. NEVER true in production.
    VAULT_ALLOW_REMOTE_INIT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    SMTP_PORT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().min(1).max(65535).optional()
    ),
    SMTP_SECURE: z.preprocess(
      (v) => (v === '' ? undefined : String(v)),
      z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional()
    ),
    SMTP_USER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    SMTP_PASS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    SMTP_FROM: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().email('SMTP_FROM must be a valid email address').optional()
    ),
    SLACK_WEBHOOK_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().url('SLACK_WEBHOOK_URL must be a valid URL').optional()
    ),
    NOTIFICATION_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
    INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),

    // Story 6.2 ADR-6.2-09: hard per-project registration cap — bounds worst-case exposure
    // (registered-endpoint count x per-check timeout x per-tick concurrency).
    MAX_SERVICE_ENDPOINTS_PER_PROJECT: z.coerce.number().int().min(1).max(1000).default(25),
    // Story 6.2 ADR-6.2-09: bounded per-tick concurrency so a large due-batch can't blow past
    // the 60-second health-check tick interval.
    HEALTH_CHECK_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
    // Story 6.2 ADR-6.2-06 (FR31): raw volume threshold for the anomalous-access detection job —
    // mirrors FAILED_AUTH_THRESHOLD_COUNT/_WINDOW_SECONDS. Max corrected to 86400 (24h) per
    // adversarial-review finding 17 so the window is genuinely widenable, not just narrowable.
    ANOMALOUS_ACCESS_THRESHOLD_COUNT: z.coerce.number().int().min(2).max(100).default(5),
    ANOMALOUS_ACCESS_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

    // Story 9.1 D2/D4/AC-14/AC-15: encrypted whole-instance backup & restore configuration.
    // Backup is opt-in — see the superRefine block below for the "at least one of
    // STORAGE_PATH/S3_BUCKET/DATABASE_URL configured" enablement + mutual-exclusivity rules.
    BACKUP_SCHEDULE: z.string().min(1).default('0 3 * * *'),
    BACKUP_RETENTION_COUNT: z.coerce.number().int().min(1).default(7),
    BACKUP_MAX_AGE_HOURS: z.coerce.number().int().positive().default(25),
    BACKUP_STORAGE_PATH: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional()
    ),
    BACKUP_S3_BUCKET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    BACKUP_S3_ENDPOINT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional()
    ),
    BACKUP_S3_REGION: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    // D4: intentionally NOT the same schema as DATABASE_URL — this one is *expected* to be a
    // superuser or BYPASSRLS role (pg_dump/pg_restore need RLS bypass), so the anti-superuser
    // `.refine()` on DATABASE_URL above must NOT apply here.
    BACKUP_DATABASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional()
    ),
    // Story 9.6 D3.1/AC-18: local staging path for the S3 destination's staged-before-upload
    // encrypted file. Same optional-string shape as BACKUP_STORAGE_PATH — only meaningful when
    // BACKUP_S3_BUCKET is configured, ignored otherwise. Unset default (os.tmpdir()-based) is
    // applied at the storage layer (apps/api/src/modules/backup/s3-upload.ts), not here — see
    // .env.example for the ephemeral-/tmp persistence caveat and the `.staged`/`.staged.hold`
    // operator-protection convention (D3.11).
    BACKUP_S3_STAGING_PATH: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional()
    ),
    // Story 9.6 D3.9/AC-16b: optional cumulative staging-directory disk-usage monitoring
    // threshold — unset by default (disabled; this is a monitoring addition, never a hard cap
    // that could itself block a backup attempt).
    BACKUP_S3_STAGING_MAX_BYTES: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().positive().optional()
    ),

    // Story 9.2 D5/AC-15/AC-21: daily audit-log-storage-pressure monitoring threshold —
    // pg_total_relation_size('audit_log_entries') is compared against this (the real table
    // name; epics.md's literal 'audit_events' has never existed in this codebase, see D5).
    AUDIT_LOG_STORAGE_LIMIT_GB: z.coerce.number().positive().default(50),
    // Story 9.2 D8/AC-20/AC-21: weekly master-key custody-age trigger threshold.
    KEY_ROTATION_MAX_AGE_DAYS: z.coerce.number().int().positive().default(365),
    // Story 9.4 AC-17: same validation pattern as INBOX_RETENTION_DAYS — independent of Story
    // 8.2's equivalent org-scoped audit retention (D10/open question 4: the two logs have
    // unrelated growth rates and retention policies).
    PLATFORM_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    // Story 9.4 AC-18/D10: independent of AUDIT_LOG_STORAGE_LIMIT_GB — the two logs' growth rates
    // are unrelated, so a single shared threshold would be wrong.
    PLATFORM_AUDIT_STORAGE_LIMIT_GB: z.coerce.number().positive().default(5),
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_SECRET === env.REFRESH_TOKEN_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_HMAC_SECRET'],
        message: 'FATAL: REFRESH_TOKEN_HMAC_SECRET must be different from SESSION_SECRET',
      })
    }

    if (env.NODE_ENV === 'production') validateProductionEnv(env, ctx)
    if (
      env.TOTP_USED_CODES_TTL_MINUTES * 60 <=
      (env.MFA_TOTP_WINDOW + 1) * env.MFA_TOTP_PERIOD_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOTP_USED_CODES_TTL_MINUTES'],
        message: 'TOTP_USED_CODES_TTL_MINUTES must outlive the accepted TOTP replay window',
      })
    }
    if (
      env.MFA_PENDING_SESSION_TTL_SECONDS <
      (env.MFA_TOTP_WINDOW + 1) * env.MFA_TOTP_PERIOD_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_PENDING_SESSION_TTL_SECONDS'],
        message: 'MFA_PENDING_SESSION_TTL_SECONDS must cover the accepted TOTP window',
      })
    }
    validateDummyPasswordHash(env, ctx)
    if (env.SMTP_HOST && !env.SMTP_FROM) {
      addEnvIssue(ctx, 'SMTP_FROM', 'SMTP_FROM is required when SMTP_HOST is set')
    }
    validateBackupEnv(env, ctx)
  })

type RawEnv = z.infer<typeof envSchema>
export type Env = Omit<
  RawEnv,
  | 'TOTP_REPLAY_HMAC_SECRET'
  | 'MFA_PENDING_SESSION_HMAC_SECRET'
  | 'INVITATION_TOKEN_HMAC_SECRET'
  | 'RECOVERY_TOKEN_HMAC_SECRET'
  | 'API_KEY_HMAC_SECRET'
  | 'MACHINE_JWT_SECRET'
  | 'STATUS_PAGE_TOKEN_HMAC_SECRET'
  | 'ERASURE_EMAIL_HASH_SECRET'
> & {
  TOTP_REPLAY_HMAC_SECRET: string
  MFA_PENDING_SESSION_HMAC_SECRET: string
  INVITATION_TOKEN_HMAC_SECRET: string
  RECOVERY_TOKEN_HMAC_SECRET: string
  API_KEY_HMAC_SECRET: string
  MACHINE_JWT_SECRET: string
  STATUS_PAGE_TOKEN_HMAC_SECRET: string
  ERASURE_EMAIL_HASH_SECRET: string
}

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    process.stderr.write(`Missing or invalid environment variables:\n${missing.join('\n')}\n`)
    process.exit(1)
    throw new Error('Invalid environment configuration')
  }
  const data = { ...result.data }
  if (!data.TOTP_REPLAY_HMAC_SECRET) {
    process.stderr.write(
      '[env] TOTP_REPLAY_HMAC_SECRET unset outside production; falling back to REFRESH_TOKEN_HMAC_SECRET. Do not use this fallback in production.\n'
    )
    data.TOTP_REPLAY_HMAC_SECRET = data.REFRESH_TOKEN_HMAC_SECRET
  }
  if (!data.MFA_PENDING_SESSION_HMAC_SECRET) {
    process.stderr.write(
      '[env] MFA_PENDING_SESSION_HMAC_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.MFA_PENDING_SESSION_HMAC_SECRET = DEV_MFA_PENDING_SESSION_HMAC_SECRET
  }
  if (!data.INVITATION_TOKEN_HMAC_SECRET) {
    process.stderr.write(
      '[env] INVITATION_TOKEN_HMAC_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.INVITATION_TOKEN_HMAC_SECRET = DEV_INVITATION_TOKEN_HMAC_SECRET
  }
  if (!data.RECOVERY_TOKEN_HMAC_SECRET) {
    process.stderr.write(
      '[env] RECOVERY_TOKEN_HMAC_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.RECOVERY_TOKEN_HMAC_SECRET = DEV_RECOVERY_TOKEN_HMAC_SECRET
  }
  if (!data.API_KEY_HMAC_SECRET) {
    process.stderr.write(
      '[env] API_KEY_HMAC_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.API_KEY_HMAC_SECRET = DEV_API_KEY_HMAC_SECRET
  }
  if (!data.MACHINE_JWT_SECRET) {
    process.stderr.write(
      '[env] MACHINE_JWT_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.MACHINE_JWT_SECRET = DEV_MACHINE_JWT_SECRET
  }
  if (!data.STATUS_PAGE_TOKEN_HMAC_SECRET) {
    process.stderr.write(
      '[env] STATUS_PAGE_TOKEN_HMAC_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.STATUS_PAGE_TOKEN_HMAC_SECRET = DEV_STATUS_PAGE_TOKEN_HMAC_SECRET
  }
  if (!data.ERASURE_EMAIL_HASH_SECRET) {
    process.stderr.write(
      '[env] ERASURE_EMAIL_HASH_SECRET unset outside production; falling back to a dedicated dev-only secret. Do not use this fallback in production.\n'
    )
    data.ERASURE_EMAIL_HASH_SECRET = DEV_ERASURE_EMAIL_HASH_SECRET
  }
  return data as Env
}

export const env = loadEnv()
