/* eslint-disable security/detect-non-literal-fs-filename -- test fixtures intentionally exercise dynamic temp-file key paths. */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'

// Dynamic imports (not hoisted, unlike static imports) so these env vars are set
// before config/env.ts (a module-level singleton) reads process.env on first import.
// VAULT_ALLOW_REMOTE_INIT, VAULT_BOOTSTRAP_TOKEN, and VAULT_ENVELOPE_KEY_HALF are read
// live from process.env by key-service.ts (not cached), so individual tests below may
// freely toggle them between cases without needing module resets.
const keyDir = mkdtempSync(join(tmpdir(), 'vault-key-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { createApp } = await import('../app.js')
const { initVault, unsealVault, zeroKeys, loadInitialVaultState } =
  await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { vaultState } = await import('@project-vault/db/schema')

const TEST_PASSPHRASE = 'test-passphrase-12chars'
const INIT_URL = '/api/v1/vault/init'
const UNSEAL_URL = '/api/v1/vault/unseal'

async function restartSealed(): Promise<void> {
  zeroKeys()
  await loadInitialVaultState()
}

async function initVaultThenRestartSealed(): Promise<void> {
  await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  await restartSealed()
}

/** Initializes with the test passphrase, closes that app, then simulates a restart (sealed). */
async function initThenSeal(): Promise<void> {
  const initApp = await createApp({ logger: false, vaultGuardEnabled: true })
  await initApp.inject({
    method: 'POST',
    url: INIT_URL,
    payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
  })
  await initApp.close()
  await restartSealed()
}

async function unsealWith(passphrase: string) {
  const app = await createApp({ logger: false, vaultGuardEnabled: true })
  const res = await app.inject({
    method: 'POST',
    url: UNSEAL_URL,
    payload: { passphrase },
  })
  await app.close()
  return res
}

afterAll(async () => {
  await resetVaultForTest()
  rmSync(keyDir, { recursive: true, force: true })
})

describe.sequential('Vault lifecycle (passphrase mode)', () => {
  beforeEach(async () => {
    await resetVaultForTest()
  })

  it('returns 503 on protected routes before initialization', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).toBe(503)
    expect(res.json<{ status: string }>().status).toBe('sealed')
    await app.close()
  })

  it('GET /health and GET /health/ return 200 while sealed', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/health/' })).statusCode).toBe(200)
    await app.close()
  })

  it('GET /ready returns 503 uninitialized message while uninitialized', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json<{ reason: string }>().reason).toBe('uninitialized')
    await app.close()
  })

  it('GET /metrics returns 503 while sealed', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('POST /vault/init with passphrase succeeds', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ initialized: true, keyVersion: 1, kmsType: 'passphrase' })
    await app.close()
  })

  it('POST /vault/init a second time returns 409', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'already_initialized' })
    await app.close()
  })

  it('POST /vault/unseal with correct passphrase succeeds (new process instance = sealed)', async () => {
    await initThenSeal()
    const res = await unsealWith(TEST_PASSPHRASE)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ unsealed: true, kmsType: 'passphrase' })
  })

  it('POST /vault/unseal with wrong passphrase returns 401', async () => {
    await initThenSeal()
    const res = await unsealWith('wrong-passphrase-here')
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'unseal_failed' })
  })

  it('POST /vault/unseal before init returns 400 not_initialized', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({
      method: 'POST',
      url: UNSEAL_URL,
      payload: { passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'not_initialized' })
    await app.close()
  })

  it('after init, protected routes and /metrics are no longer 503', async () => {
    const app = await createApp({
      logger: false,
      vaultGuardEnabled: true,
      dbPool: { query: async () => [] },
    })
    await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).not.toBe(503)
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    expect(metrics.statusCode).not.toBe(503)
    const ready = await app.inject({ method: 'GET', url: '/ready' })
    expect(ready.statusCode).toBe(200)
    await app.close()
  })

  it('rate-limits /vault/unseal but NOT /vault/init (AC-24: limiter scoped to unseal only)', async () => {
    // Rate limiting is bypassed under NODE_ENV=test by default (route-helpers.ts,
    // isRateLimitEnforced) — this test explicitly opts back in to cover real enforcement.
    process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
    const app = await createApp({ logger: false, vaultGuardEnabled: true })

    try {
      // 6 init attempts (over the 5/min limit) must never 429 — init relies on the
      // bootstrap-token gate, not rate limiting.
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: 'POST',
          url: INIT_URL,
          payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
        })
        expect(res.statusCode).not.toBe(429)
      }

      // 6 unseal attempts (over the 5/min limit) must 429 on the 6th.
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: 'POST',
          url: UNSEAL_URL,
          payload: { passphrase: 'wrong-passphrase-here' },
        })
        statuses.push(res.statusCode)
      }
      expect(statuses.at(-1)).toBe(429)
    } finally {
      await app.close()
      delete process.env['RATE_LIMIT_TEST_ENFORCE']
    }
  })
})

describe.sequential('Vault bootstrap token enforcement', () => {
  const BOOTSTRAP_TOKEN = 'a'.repeat(32)

  beforeEach(async () => {
    await resetVaultForTest()
    process.env['VAULT_ALLOW_REMOTE_INIT'] = 'false'
    process.env['VAULT_BOOTSTRAP_TOKEN'] = BOOTSTRAP_TOKEN
  })

  afterAll(() => {
    process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
    delete process.env['VAULT_BOOTSTRAP_TOKEN']
  })

  it('rejects init with no token header', async () => {
    await expect(
      initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_FORBIDDEN', statusCode: 403 })
  })

  it('rejects init with wrong token header', async () => {
    await expect(
      initVault(
        { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
        { 'x-vault-bootstrap-token': 'b'.repeat(32) }
      )
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_FORBIDDEN', statusCode: 403 })
  })

  it('accepts init with the correct token header', async () => {
    const result = await initVault(
      { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
      { 'x-vault-bootstrap-token': BOOTSTRAP_TOKEN }
    )
    expect(result).toMatchObject({ initialized: true, kmsType: 'passphrase' })
  })
})

describe.sequential('Vault key-service custody models', () => {
  beforeEach(async () => {
    await resetVaultForTest()
    process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
  })

  it('file mode: init then unseal with a 32-byte key file', async () => {
    const keyPath = join(keyDir, 'vault-key.bin')
    writeFileSync(keyPath, randomBytes(32))

    const initResult = await initVault(
      { kmsType: 'file', masterKeyPath: keyPath, acknowledgeCoLocationRisk: true },
      {}
    )
    expect(initResult).toMatchObject({ initialized: true, kmsType: 'file' })

    await restartSealed()

    const unsealResult = await unsealVault({ masterKeyPath: keyPath })
    expect(unsealResult).toMatchObject({ unsealed: true, kmsType: 'file' })
  })

  it('file mode: rejects key file outside VAULT_KEY_DIR', async () => {
    const outsidePath = join(tmpdir(), 'outside-vault-key.bin')
    writeFileSync(outsidePath, randomBytes(32))
    try {
      await expect(
        initVault(
          { kmsType: 'file', masterKeyPath: outsidePath, acknowledgeCoLocationRisk: true },
          {}
        )
      ).rejects.toMatchObject({ code: 'KEY_FILE_NOT_FOUND', statusCode: 400 })
    } finally {
      rmSync(outsidePath, { force: true })
    }
  })

  it('file mode: rejects a symlink in place of a regular key file', async () => {
    const targetPath = join(tmpdir(), 'symlink-target.bin')
    writeFileSync(targetPath, randomBytes(32))
    const linkPath = join(keyDir, 'vault-key-link.bin')
    symlinkSync(targetPath, linkPath)
    try {
      await expect(
        initVault({ kmsType: 'file', masterKeyPath: linkPath, acknowledgeCoLocationRisk: true }, {})
      ).rejects.toMatchObject({ code: 'INVALID_KEY_FILE', statusCode: 400 })
    } finally {
      rmSync(linkPath, { force: true })
      rmSync(targetPath, { force: true })
    }
  })

  it('envelope mode: init then unseal with env half + file half', async () => {
    process.env['VAULT_ENVELOPE_KEY_HALF'] = randomBytes(16).toString('hex')
    const filePath = join(keyDir, 'envelope-half.bin')
    writeFileSync(filePath, randomBytes(16))

    const initResult = await initVault(
      { kmsType: 'envelope', envelopeKeyPath: filePath, acknowledgeSplitKeyModel: true },
      {}
    )
    expect(initResult).toMatchObject({ initialized: true, kmsType: 'envelope' })

    await restartSealed()

    const unsealResult = await unsealVault({ envelopeKeyPath: filePath })
    expect(unsealResult).toMatchObject({ unsealed: true, kmsType: 'envelope' })
  })

  it('envelope mode: missing VAULT_ENVELOPE_KEY_HALF returns 503', async () => {
    delete process.env['VAULT_ENVELOPE_KEY_HALF']
    const filePath = join(keyDir, 'envelope-half-2.bin')
    writeFileSync(filePath, randomBytes(16))
    await expect(
      initVault(
        { kmsType: 'envelope', envelopeKeyPath: filePath, acknowledgeSplitKeyModel: true },
        {}
      )
    ).rejects.toMatchObject({ code: 'ENVELOPE_ENV_HALF_MISSING', statusCode: 503 })
  })

  it('returns 503 vault_corrupted when encrypted_sentinel JSON is malformed', async () => {
    await initVaultThenRestartSealed()

    // append-only trigger blocks UPDATE in production; bypass via test-only GUC for this assertion
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
      await tx.update(vaultState).set({ encryptedSentinel: 'not-json' })
    })

    await expect(unsealVault({ passphrase: TEST_PASSPHRASE })).rejects.toMatchObject({
      code: 'VAULT_CORRUPTED',
      statusCode: 503,
    })
  })

  it('returns 503 vault_corrupted when key_derivation_params are tampered below minimum', async () => {
    await initVaultThenRestartSealed()

    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
      await tx.update(vaultState).set({
        keyDerivationParams: JSON.stringify({
          type: 'argon2id',
          salt: 'a'.repeat(32),
          memoryCost: 1024,
          timeCost: 1,
          parallelism: 1,
        }),
      })
    })

    await expect(unsealVault({ passphrase: TEST_PASSPHRASE })).rejects.toMatchObject({
      code: 'VAULT_CORRUPTED',
      statusCode: 503,
    })
  })
})
