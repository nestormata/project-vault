import { z } from 'zod/v4'

const DEV_SESSION_SECRET = 'a'.repeat(64)
const DEV_REFRESH_TOKEN_HMAC_SECRET = 'b'.repeat(64)
const DEV_MFA_PENDING_SESSION_HMAC_SECRET = 'd'.repeat(64)
const DEV_INVITATION_TOKEN_HMAC_SECRET = 'e'.repeat(64)
const DEV_RECOVERY_TOKEN_HMAC_SECRET = 'f'.repeat(64)
const DEV_API_KEY_HMAC_SECRET = 'g'.repeat(64)
const DEV_AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'c/PLdA7Wvhkg8hPqLu5AlQ',
  ['7zS8GhNt', 'QTJsiMmJ', 'LErN9kM1', '9VoNBM3P', 'HV3OhidvHtY'].join(''),
].join('$')
const PLACEHOLDER_SECRET_PATTERN = /change-me|dev-only|placeholder/i
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

function validateProductionEnv(env: ProductionEnv, ctx: z.RefinementCtx): void {
  validateProductionBasics(env, ctx)
  validateTotpReplayProductionSecret(env, ctx)
  validatePendingMfaProductionSecret(env, ctx)
  validateInvitationTokenProductionSecret(env, ctx)
  validateRecoveryTokenProductionSecret(env, ctx)
  validateApiKeyProductionSecret(env, ctx)
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
            .some((origin) => origin === '*'),
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
    WEB_BASE_URL: z.url().default('http://localhost:5173'),
    MFA_PRIVILEGED_ROLE_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
    FAILED_AUTH_THRESHOLD_COUNT: z.coerce.number().int().min(3).max(100).default(10),
    FAILED_AUTH_THRESHOLD_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    FAILED_AUTH_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    FAILED_AUTH_RECORD_ENABLED: booleanEnvDefault(true),
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
  })

type RawEnv = z.infer<typeof envSchema>
export type Env = Omit<
  RawEnv,
  | 'TOTP_REPLAY_HMAC_SECRET'
  | 'MFA_PENDING_SESSION_HMAC_SECRET'
  | 'INVITATION_TOKEN_HMAC_SECRET'
  | 'RECOVERY_TOKEN_HMAC_SECRET'
  | 'API_KEY_HMAC_SECRET'
> & {
  TOTP_REPLAY_HMAC_SECRET: string
  MFA_PENDING_SESSION_HMAC_SECRET: string
  INVITATION_TOKEN_HMAC_SECRET: string
  RECOVERY_TOKEN_HMAC_SECRET: string
  API_KEY_HMAC_SECRET: string
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
  return data as Env
}

export const env = loadEnv()
