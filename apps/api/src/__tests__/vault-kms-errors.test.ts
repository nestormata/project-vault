import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { createApp } = await import('../app.js')
const { initVault, unsealVault, zeroKeys, loadInitialVaultState, __setKmsProviderForTest } =
  await import('../modules/vault/key-service.js')
const { KmsProviderError } = await import('../modules/vault/kms-provider.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { vaultState } = await import('@project-vault/db/schema')

const KEY_ID = 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr'

function throwingProvider(kind: 'unreachable' | 'not_found' | 'permission_denied') {
  return {
    generateDataKey: vi.fn(async () => {
      throw new KmsProviderError(kind, `simulated ${kind}`)
    }),
    decryptDataKey: vi.fn(async () => {
      throw new KmsProviderError(kind, `simulated ${kind}`)
    }),
  }
}

async function restartSealed(): Promise<void> {
  zeroKeys()
  await loadInitialVaultState()
}

afterAll(async () => {
  __setKmsProviderForTest(null)
  await resetVaultForTest()
})

describe.sequential('Story 1.14: KMS error mapping', () => {
  beforeEach(async () => {
    await resetVaultForTest()
  })

  describe('init-time error mapping', () => {
    it('AC-3: KMS unreachable maps to 503 kms_unreachable and inserts no vault_state row', async () => {
      __setKmsProviderForTest(throwingProvider('unreachable'))

      await expect(initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})).rejects.toMatchObject({
        code: 'KMS_UNREACHABLE',
        statusCode: 503,
      })
      const rows = await getDb().select().from(vaultState).limit(1)
      expect(rows).toHaveLength(0)
    })

    it('AC-3 via HTTP: the 503 response serializes correctly against the route response schema', async () => {
      __setKmsProviderForTest(throwingProvider('unreachable'))
      const app = await createApp({ logger: false })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/init',
        payload: { kmsType: 'kms', kmsKeyId: KEY_ID },
      })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ error: 'kms_unreachable' })
      await app.close()
    })

    it('AC-4: KMS key not found maps to 400 kms_key_not_found and inserts no vault_state row', async () => {
      __setKmsProviderForTest(throwingProvider('not_found'))

      await expect(initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})).rejects.toMatchObject({
        code: 'KMS_KEY_NOT_FOUND',
        statusCode: 400,
      })
      const rows = await getDb().select().from(vaultState).limit(1)
      expect(rows).toHaveLength(0)
    })

    it('AC-5: permission denied maps to 403 kms_permission_denied and never leaks credential detail', async () => {
      __setKmsProviderForTest(throwingProvider('permission_denied'))

      try {
        await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
        expect.unreachable()
      } catch (err) {
        expect(err).toMatchObject({ code: 'KMS_PERMISSION_DENIED', statusCode: 403 })
        expect((err as Error).message).not.toMatch(/AKIA|arn:aws:iam/)
      }
      const rows = await getDb().select().from(vaultState).limit(1)
      expect(rows).toHaveLength(0)
    })
  })

  describe('unseal-time error mapping', () => {
    async function initKmsVaultThenSeal(): Promise<void> {
      __setKmsProviderForTest({
        generateDataKey: vi.fn(async () => ({
          plaintext: Buffer.alloc(32, 3),
          ciphertextBlob: 'ZmFrZS1jaXBoZXJ0ZXh0',
        })),
        decryptDataKey: vi.fn(),
      })
      await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
      await restartSealed()
    }

    it('AC-11: KMS unreachable at unseal maps to 503 kms_unreachable, vault stays sealed', async () => {
      await initKmsVaultThenSeal()
      __setKmsProviderForTest(throwingProvider('unreachable'))

      await expect(unsealVault({})).rejects.toMatchObject({
        code: 'KMS_UNREACHABLE',
        statusCode: 503,
      })
    })

    it('AC-12: KMS key deleted/disabled at unseal maps to 503 kms_key_unavailable (distinct from AC-11)', async () => {
      await initKmsVaultThenSeal()
      __setKmsProviderForTest(throwingProvider('not_found'))

      await expect(unsealVault({})).rejects.toMatchObject({
        code: 'KMS_KEY_UNAVAILABLE',
        statusCode: 503,
      })
    })

    it('AC-13: permission denied at unseal maps to 403 kms_permission_denied', async () => {
      await initKmsVaultThenSeal()
      __setKmsProviderForTest(throwingProvider('permission_denied'))

      await expect(unsealVault({})).rejects.toMatchObject({
        code: 'KMS_PERMISSION_DENIED',
        statusCode: 403,
      })
    })

    it('AC-13 via HTTP: the 403 response serializes correctly against the route response schema', async () => {
      await initKmsVaultThenSeal()
      __setKmsProviderForTest(throwingProvider('permission_denied'))
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'POST', url: '/api/v1/vault/unseal', payload: {} })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'kms_permission_denied' })
      await app.close()
    })
  })
})
