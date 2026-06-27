import { z } from 'zod/v4'

const DEV_SESSION_SECRET = 'a'.repeat(64)
const DEV_REFRESH_TOKEN_HMAC_SECRET = 'b'.repeat(64)
const DEV_AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'c/PLdA7Wvhkg8hPqLu5AlQ',
  ['7zS8GhNt', 'QTJsiMmJ', 'LErN9kM1', '9VoNBM3P', 'HV3OhidvHtY'].join(''),
].join('$')
const PLACEHOLDER_SECRET_PATTERN = /change-me|dev-only|placeholder/i
const isProduction = process.env.NODE_ENV === 'production'
const ARGON2_PHC_REGEX =
  /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/._-]{16,}\$[A-Za-z0-9+/._-]{32,}$/

function validateProductionEnv(env: Env, ctx: z.RefinementCtx): void {
  if (!env.COOKIE_SECURE) {
    ctx.addIssue({
      code: 'custom',
      path: ['COOKIE_SECURE'],
      message: 'FATAL: COOKIE_SECURE must be true in production',
    })
  }

  if (PLACEHOLDER_SECRET_PATTERN.test(env.SESSION_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_SECRET'],
      message: 'SESSION_SECRET must not be a placeholder secret in production',
    })
  }
  if (PLACEHOLDER_SECRET_PATTERN.test(env.REFRESH_TOKEN_HMAC_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['REFRESH_TOKEN_HMAC_SECRET'],
      message: 'REFRESH_TOKEN_HMAC_SECRET must not be a placeholder secret in production',
    })
  }
}

function validateDummyPasswordHash(env: Env, ctx: z.RefinementCtx): void {
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
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

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
    validateDummyPasswordHash(env, ctx)
  })

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    process.stderr.write(`Missing or invalid environment variables:\n${missing.join('\n')}\n`)
    process.exit(1)
    throw new Error('Invalid environment configuration')
  }
  return result.data
}

export const env = loadEnv()
