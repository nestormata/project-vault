import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'

const VAULT_APP_DATABASE_URL = 'postgresql://vault_app:secret@localhost:5432/project_vault'

const BASE_ENV = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  METRICS_BIND_HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
}

const AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'c/PLdA7Wvhkg8hPqLu5AlQ',
  ['7zS8GhNt', 'QTJsiMmJ', 'LErN9kM1', '9VoNBM3P', 'HV3OhidvHtY'].join(''),
].join('$')

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...BASE_ENV,
    NODE_ENV: 'production',
    DATABASE_URL: VAULT_APP_DATABASE_URL,
    SESSION_SECRET: 'a'.repeat(64),
    REFRESH_TOKEN_HMAC_SECRET: 'b'.repeat(64),
    // Story 4.3: required in production since RECOVERY_TOKEN_HMAC_SECRET's own validation
    // block landed; baked into the base fixture like SESSION_SECRET/REFRESH_TOKEN_HMAC_SECRET so
    // every other secret's dedicated-requirement test isn't also tripped by this one being unset.
    RECOVERY_TOKEN_HMAC_SECRET: 'f'.repeat(64),
    // Story 7.1: same reasoning as RECOVERY_TOKEN_HMAC_SECRET above.
    API_KEY_HMAC_SECRET: 'g'.repeat(64),
    // Story 7.2 D3: same reasoning — baked into the base fixture so unrelated production tests
    // aren't also tripped by this newest dedicated secret being unset.
    MACHINE_JWT_SECRET: 'h'.repeat(64),
    // Story 6.3 ADR-6.3-06: same reasoning — baked into the base fixture so unrelated production
    // tests aren't also tripped by this newest dedicated secret being unset.
    STATUS_PAGE_TOKEN_HMAC_SECRET: 'i'.repeat(64),
    AUTH_DUMMY_PASSWORD_HASH,
    ...overrides,
  }
}

async function expectInvalidEnv(
  exitSpy: MockInstance<(...args: never[]) => unknown>
): Promise<void> {
  await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
  expect(exitSpy).toHaveBeenCalledWith(1)
}

function resetEnvImport(exitSpy: MockInstance<(...args: never[]) => unknown>): void {
  vi.resetModules()
  exitSpy.mockClear()
}

/** Asserts a secret is required in production once its predecessors are set, and accepted once present. */
async function expectDedicatedSecretRequired(
  exitSpy: MockInstance<(...args: never[]) => unknown>,
  overridesWithoutSecret: NodeJS.ProcessEnv,
  secretKey: string,
  secretValue: string
): Promise<void> {
  process.env = productionEnv(overridesWithoutSecret)
  await expectInvalidEnv(exitSpy)

  resetEnvImport(exitSpy)
  process.env = productionEnv({ ...overridesWithoutSecret, [secretKey]: secretValue })
  const { env } = await import('./env.js')
  expect((env as Record<string, unknown>)[secretKey]).toBe(secretValue)
  expect(exitSpy).not.toHaveBeenCalled()
}

describe('env', () => {
  let originalEnv: NodeJS.ProcessEnv
  let exitSpy: MockInstance<(...args: never[]) => unknown>

  beforeEach(() => {
    originalEnv = process.env
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('accepts a DATABASE_URL using a non-superuser role', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.DATABASE_URL).toBe(VAULT_APP_DATABASE_URL)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects a DATABASE_URL using the postgres superuser', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/project_vault',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('defaults VAULT_KEY_DIR to /run/secrets and VAULT_ALLOW_REMOTE_INIT to false when unset', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.VAULT_KEY_DIR).toBe('/run/secrets')
    expect(env.VAULT_ALLOW_REMOTE_INIT).toBe(false)
  })

  it('defaults auth environment settings for local/test startup', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.SESSION_SECRET).toHaveLength(64)
    expect(env.REFRESH_TOKEN_HMAC_SECRET).toHaveLength(64)
    expect(env.SESSION_SECRET).not.toBe(env.REFRESH_TOKEN_HMAC_SECRET)
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(300)
    expect(env.SESSION_IDLE_TIMEOUT_MINUTES).toBe(30)
    expect(env.SESSION_ACTIVITY_DEBOUNCE_SECONDS).toBe(60)
    expect(env.MAX_SESSIONS_PER_USER).toBe(0)
    expect(env.JWT_MAX_CLOCK_SKEW_SECONDS).toBe(30)
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7)
    expect(env.REFRESH_GRACE_WINDOW_SECONDS).toBe(30)
    expect(env.ARGON2_MEMORY_COST).toBe(65536)
    expect(env.ARGON2_TIME_COST).toBe(3)
    expect(env.ARGON2_PARALLELISM).toBe(4)
    expect(env.AUTH_REGISTRATION_ENABLED).toBe(true)
    expect(env.COOKIE_SECURE).toBe(false)
    expect(env.TRUST_PROXY).toBe(false)
    expect(env.TRUST_PROXY_HOPS).toBe(1)
    expect(env.MFA_TOTP_ISSUER).toBe('Project Vault')
    expect(env.MFA_TOTP_PERIOD_SECONDS).toBe(30)
    expect(env.MFA_TOTP_DIGITS).toBe(6)
    expect(env.MFA_TOTP_WINDOW).toBe(1)
    expect(env.MFA_RECOVERY_CODE_COUNT).toBe(10)
    expect(env.MFA_RECOVERY_CODE_BCRYPT_COST).toBe(12)
    expect(env.TOTP_USED_CODES_TTL_MINUTES).toBe(90)
    expect(env.TOTP_REPLAY_HMAC_SECRET).toBe(env.REFRESH_TOKEN_HMAC_SECRET)
    expect(env.MFA_PENDING_SESSION_TTL_SECONDS).toBe(300)
    expect(env.MFA_LOGIN_MAX_ATTEMPTS).toBe(5)
    expect(env.MFA_PENDING_SESSION_HMAC_SECRET).toHaveLength(64)
    expect(env.MFA_PENDING_SESSION_HMAC_SECRET).not.toBe(env.REFRESH_TOKEN_HMAC_SECRET)
    expect(env.MFA_PENDING_SESSION_HMAC_SECRET).not.toBe(env.SESSION_SECRET)
    expect(env.MFA_PENDING_SESSION_HMAC_SECRET).not.toBe(env.TOTP_REPLAY_HMAC_SECRET)
    expect(env.MFA_PRIVILEGED_ROLE_GRACE_DAYS).toBe(7)
    expect(env.FAILED_AUTH_THRESHOLD_COUNT).toBe(10)
    expect(env.FAILED_AUTH_THRESHOLD_WINDOW_SECONDS).toBe(300)
    expect(env.FAILED_AUTH_RETENTION_HOURS).toBe(24)
    expect(env.FAILED_AUTH_RECORD_ENABLED).toBe(true)
    expect(env.MAX_SERVICE_ENDPOINTS_PER_PROJECT).toBe(25)
    expect(env.HEALTH_CHECK_MAX_CONCURRENCY).toBe(20)
    expect(env.ANOMALOUS_ACCESS_THRESHOLD_COUNT).toBe(5)
    expect(env.ANOMALOUS_ACCESS_WINDOW_SECONDS).toBe(3600)
    expect(env.ROTATION_MAX_RETRIES).toBe(3)
    expect(env.BREAK_GLASS_OVERLAP_MINUTES).toBe(60)
    expect(env.STALE_ROTATION_THRESHOLD_MINUTES).toBe(60)
  })

  it('accepts custom Story 5.3 BREAK_GLASS_OVERLAP_MINUTES/STALE_ROTATION_THRESHOLD_MINUTES within bounds', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      BREAK_GLASS_OVERLAP_MINUTES: '30',
      STALE_ROTATION_THRESHOLD_MINUTES: '120',
    }
    const { env } = await import('./env.js')
    expect(env.BREAK_GLASS_OVERLAP_MINUTES).toBe(30)
    expect(env.STALE_ROTATION_THRESHOLD_MINUTES).toBe(120)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects an out-of-bounds Story 5.3 BREAK_GLASS_OVERLAP_MINUTES', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      BREAK_GLASS_OVERLAP_MINUTES: '1441',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects an out-of-bounds Story 5.3 STALE_ROTATION_THRESHOLD_MINUTES', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      STALE_ROTATION_THRESHOLD_MINUTES: '14',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('Story 6.2: ANOMALOUS_ACCESS_WINDOW_SECONDS can be widened up to 86400 (adversarial-review finding 17)', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      ANOMALOUS_ACCESS_WINDOW_SECONDS: '86400',
    }
    vi.resetModules()
    const { env } = await import('./env.js')
    expect(env.ANOMALOUS_ACCESS_WINDOW_SECONDS).toBe(86400)
  })

  it('accepts a custom Story 5.2 ROTATION_MAX_RETRIES within bounds', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      ROTATION_MAX_RETRIES: '10',
    }
    const { env } = await import('./env.js')
    expect(env.ROTATION_MAX_RETRIES).toBe(10)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects an out-of-bounds Story 5.2 ROTATION_MAX_RETRIES', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      ROTATION_MAX_RETRIES: '11',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects identical auth secrets', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_SECRET: 'a'.repeat(64),
      REFRESH_TOKEN_HMAC_SECRET: 'a'.repeat(64),
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects an invalid dummy password hash', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      AUTH_DUMMY_PASSWORD_HASH: 'not-a-phc-hash',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects a dummy password hash whose Argon2 params do not match configured params', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      AUTH_DUMMY_PASSWORD_HASH: AUTH_DUMMY_PASSWORD_HASH.replace(
        'm=65536,t=3,p=4',
        'm=19456,t=2,p=1'
      ),
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects Argon2 memory cost above the safety cap', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      ARGON2_MEMORY_COST: '262145',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('accepts Story 1.7 session security controls within bounds', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_IDLE_TIMEOUT_MINUTES: '1440',
      SESSION_ACTIVITY_DEBOUNCE_SECONDS: '300',
      MAX_SESSIONS_PER_USER: '5',
      JWT_MAX_CLOCK_SKEW_SECONDS: '0',
    }
    const { env } = await import('./env.js')
    expect(env.SESSION_IDLE_TIMEOUT_MINUTES).toBe(1440)
    expect(env.SESSION_ACTIVITY_DEBOUNCE_SECONDS).toBe(300)
    expect(env.MAX_SESSIONS_PER_USER).toBe(5)
    expect(env.JWT_MAX_CLOCK_SKEW_SECONDS).toBe(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid Story 1.7 session security controls', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_IDLE_TIMEOUT_MINUTES: '0',
      SESSION_ACTIVITY_DEBOUNCE_SECONDS: '9',
      MAX_SESSIONS_PER_USER: '-1',
      JWT_MAX_CLOCK_SKEW_SECONDS: '301',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('defaults COOKIE_SECURE to true in production and rejects placeholder secrets', async () => {
    process.env = productionEnv({
      SESSION_SECRET: 'change-me'.repeat(8),
    })
    await expectInvalidEnv(exitSpy)

    resetEnvImport(exitSpy)
    process.env = productionEnv({
      TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
      MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
      INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
    })
    const { env } = await import('./env.js')
    expect(env.COOKIE_SECURE).toBe(true)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects COOKIE_SECURE=false in production', async () => {
    process.env = productionEnv({
      COOKIE_SECURE: 'false',
    })
    await expectInvalidEnv(exitSpy)
  })

  it('requires a dedicated TOTP replay secret in production', async () => {
    process.env = productionEnv({
      COOKIE_SECURE: 'true',
    })
    await expectInvalidEnv(exitSpy)

    resetEnvImport(exitSpy)
    process.env = productionEnv({
      TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
      MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
      INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
      COOKIE_SECURE: 'true',
    })
    const { env } = await import('./env.js')
    expect(env.TOTP_REPLAY_HMAC_SECRET).toBe('c'.repeat(64))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('requires a dedicated pending MFA session secret in production', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      {
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
      },
      'MFA_PENDING_SESSION_HMAC_SECRET',
      'd'.repeat(64)
    )
  })

  it('rejects placeholder or reused pending MFA session secrets in production', async () => {
    for (const MFA_PENDING_SESSION_HMAC_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        MFA_PENDING_SESSION_HMAC_SECRET,
      })
      await expectInvalidEnv(exitSpy)
    }
  })

  it('requires a dedicated invitation token secret in production (Story 4.1)', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      {
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
      },
      'INVITATION_TOKEN_HMAC_SECRET',
      'e'.repeat(64)
    )
  })

  it('rejects placeholder or reused invitation token secrets in production', async () => {
    for (const INVITATION_TOKEN_HMAC_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
        INVITATION_TOKEN_HMAC_SECRET,
      })
      await expectInvalidEnv(exitSpy)
    }
  })

  it('requires a dedicated recovery token secret in production (Story 4.3)', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      {
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
        INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
        RECOVERY_TOKEN_HMAC_SECRET: undefined,
      },
      'RECOVERY_TOKEN_HMAC_SECRET',
      'f'.repeat(64)
    )
  })

  it('rejects placeholder or reused recovery token secrets in production', async () => {
    for (const RECOVERY_TOKEN_HMAC_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      'e'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({
        COOKIE_SECURE: 'true',
        TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
        MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
        INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
        RECOVERY_TOKEN_HMAC_SECRET,
      })
      await expectInvalidEnv(exitSpy)
    }
  })

  // Story 7.1: API_KEY_HMAC_SECRET is the 5th dedicated-secret requirement, so satisfying its
  // own fixture now needs every earlier secret's context baked in too — spreading a shared
  // constant here (instead of repeating the literal object) avoids duplicating the identical
  // multi-line context the recovery-token block above already contains (jscpd).
  const priorSecretsSatisfied = {
    COOKIE_SECURE: 'true',
    TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
    MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
    INVITATION_TOKEN_HMAC_SECRET: 'e'.repeat(64),
    RECOVERY_TOKEN_HMAC_SECRET: 'f'.repeat(64),
  }

  it('requires a dedicated API key secret in production (Story 7.1, D3)', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      { ...priorSecretsSatisfied, API_KEY_HMAC_SECRET: undefined },
      'API_KEY_HMAC_SECRET',
      'g'.repeat(64)
    )
  })

  it('rejects placeholder or reused API key secrets in production', async () => {
    for (const API_KEY_HMAC_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({ ...priorSecretsSatisfied, API_KEY_HMAC_SECRET })
      await expectInvalidEnv(exitSpy)
    }
  })

  // Story 7.2 D3: MACHINE_JWT_SECRET is the 6th dedicated-secret requirement.
  const priorSecretsSatisfiedWithApiKey = {
    ...priorSecretsSatisfied,
    API_KEY_HMAC_SECRET: 'g'.repeat(64),
  }

  it('requires a dedicated machine JWT secret in production (Story 7.2, D3)', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      { ...priorSecretsSatisfiedWithApiKey, MACHINE_JWT_SECRET: undefined },
      'MACHINE_JWT_SECRET',
      'h'.repeat(64)
    )
  })

  it('rejects placeholder or reused machine JWT secrets in production', async () => {
    for (const MACHINE_JWT_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
      'g'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({ ...priorSecretsSatisfiedWithApiKey, MACHINE_JWT_SECRET })
      await expectInvalidEnv(exitSpy)
    }
  })

  // Story 6.3 ADR-6.3-06: STATUS_PAGE_TOKEN_HMAC_SECRET is the 7th dedicated-secret requirement.
  const priorSecretsSatisfiedWithMachineJwt = {
    ...priorSecretsSatisfiedWithApiKey,
    MACHINE_JWT_SECRET: 'h'.repeat(64),
  }

  it('requires a dedicated status page token secret in production (Story 6.3, ADR-6.3-06)', async () => {
    await expectDedicatedSecretRequired(
      exitSpy,
      { ...priorSecretsSatisfiedWithMachineJwt, STATUS_PAGE_TOKEN_HMAC_SECRET: undefined },
      'STATUS_PAGE_TOKEN_HMAC_SECRET',
      'i'.repeat(64)
    )
  })

  it('rejects placeholder or reused status page token secrets in production', async () => {
    for (const STATUS_PAGE_TOKEN_HMAC_SECRET of [
      'change-me'.repeat(8),
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
      'g'.repeat(64),
      'h'.repeat(64),
    ]) {
      resetEnvImport(exitSpy)
      process.env = productionEnv({
        ...priorSecretsSatisfiedWithMachineJwt,
        STATUS_PAGE_TOKEN_HMAC_SECRET,
      })
      await expectInvalidEnv(exitSpy)
    }
  })

  it('rejects unsupported MFA parameter values', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      MFA_TOTP_PERIOD_SECONDS: '60',
      MFA_TOTP_DIGITS: '8',
      MFA_RECOVERY_CODE_COUNT: '17',
      MFA_RECOVERY_CODE_BCRYPT_COST: '9',
      TOTP_USED_CODES_TTL_MINUTES: '1',
      MFA_PENDING_SESSION_TTL_SECONDS: '59',
      MFA_LOGIN_MAX_ATTEMPTS: '0',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('accepts Story 1.12 pending MFA login settings within bounds', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      MFA_PENDING_SESSION_TTL_SECONDS: '900',
      MFA_LOGIN_MAX_ATTEMPTS: '10',
      MFA_PENDING_SESSION_HMAC_SECRET: 'd'.repeat(64),
    }
    const { env } = await import('./env.js')
    expect(env.MFA_PENDING_SESSION_TTL_SECONDS).toBe(900)
    expect(env.MFA_LOGIN_MAX_ATTEMPTS).toBe(10)
    expect(env.MFA_PENDING_SESSION_HMAC_SECRET).toBe('d'.repeat(64))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects pending MFA TTL values that cannot cover the accepted TOTP window', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      MFA_PENDING_SESSION_TTL_SECONDS: '60',
      MFA_TOTP_WINDOW: '2',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('accepts Story 1.9 MFA enforcement and failed auth settings within bounds', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      MFA_PRIVILEGED_ROLE_GRACE_DAYS: '0',
      FAILED_AUTH_THRESHOLD_COUNT: '3',
      FAILED_AUTH_THRESHOLD_WINDOW_SECONDS: '60',
      FAILED_AUTH_RETENTION_HOURS: '168',
      FAILED_AUTH_RECORD_ENABLED: 'false',
    }
    const { env } = await import('./env.js')
    expect(env.MFA_PRIVILEGED_ROLE_GRACE_DAYS).toBe(0)
    expect(env.FAILED_AUTH_THRESHOLD_COUNT).toBe(3)
    expect(env.FAILED_AUTH_THRESHOLD_WINDOW_SECONDS).toBe(60)
    expect(env.FAILED_AUTH_RETENTION_HOURS).toBe(168)
    expect(env.FAILED_AUTH_RECORD_ENABLED).toBe(false)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid Story 1.9 MFA enforcement and failed auth settings', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      MFA_PRIVILEGED_ROLE_GRACE_DAYS: '31',
      FAILED_AUTH_THRESHOLD_COUNT: '2',
      FAILED_AUTH_THRESHOLD_WINDOW_SECONDS: '59',
      FAILED_AUTH_RETENTION_HOURS: '0',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects FAILED_AUTH_RECORD_ENABLED=false in production', async () => {
    process.env = productionEnv({
      COOKIE_SECURE: 'true',
      TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
      FAILED_AUTH_RECORD_ENABLED: 'false',
    })
    await expectInvalidEnv(exitSpy)
  })

  it('defaults SERVICE_NAME to "api" and LOG_LEVEL to "info"', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      LOG_LEVEL: undefined,
    }
    const { env } = await import('./env.js')
    expect(env.SERVICE_NAME).toBe('api')
    expect(env.LOG_LEVEL).toBe('info')
  })

  it('accepts a custom SERVICE_NAME matching the lowercase slug pattern', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SERVICE_NAME: 'vault-api_2',
    }
    const { env } = await import('./env.js')
    expect(env.SERVICE_NAME).toBe('vault-api_2')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects a SERVICE_NAME with invalid characters', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SERVICE_NAME: 'Vault API!',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('accepts LOG_LEVEL=silent', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      LOG_LEVEL: 'silent',
    }
    const { env } = await import('./env.js')
    expect(env.LOG_LEVEL).toBe('silent')
  })

  it('rejects LOG_LEVEL=debug or trace in production', async () => {
    process.env = productionEnv({
      COOKIE_SECURE: 'true',
      TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
      LOG_LEVEL: 'debug',
    })
    await expectInvalidEnv(exitSpy)

    resetEnvImport(exitSpy)
    process.env = productionEnv({
      COOKIE_SECURE: 'true',
      TOTP_REPLAY_HMAC_SECRET: 'c'.repeat(64),
      LOG_LEVEL: 'trace',
    })
    await expectInvalidEnv(exitSpy)
  })
})
