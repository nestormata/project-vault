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
