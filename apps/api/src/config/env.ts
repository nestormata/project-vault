import { z } from 'zod/v4'

const envSchema = z.object({
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

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    process.stderr.write(`Missing or invalid environment variables:\n${missing.join('\n')}\n`)
    process.exit(1)
  }
  return result.data
}

export const env = loadEnv()
