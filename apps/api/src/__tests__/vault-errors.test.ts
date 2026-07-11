import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { resetVaultForTest } from './helpers/vault-test-cleanup.js'

const INIT_URL = '/api/v1/vault/init'
const UNSEAL_URL = '/api/v1/vault/unseal'

describe('vault route validation errors', () => {
  // Story 1.14: this suite shares a real Postgres vault_state row with every other vault test
  // file — a prior suite's initialized vault could otherwise leak into
  // "vault has not been initialized" assertions below when the full test run executes multiple
  // vault test files. Reset before each case, same discipline as vault-lifecycle.test.ts.
  beforeEach(async () => {
    await resetVaultForTest()
  })

  it('rejects init with passphrase shorter than 12 characters', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'passphrase', passphrase: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  it('rejects envelope init missing acknowledgeSplitKeyModel', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'envelope', envelopeKeyPath: '/run/secrets/half.bin' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  it('rejects file init missing acknowledgeCoLocationRisk', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'file', masterKeyPath: '/run/secrets/key.bin' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  it('rejects init with unknown kmsType', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'bogus' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // Story 1.14 AC-2: kms init requires a non-empty kmsKeyId, validated before any AWS KMS call.
  it('rejects kms init with missing kmsKeyId', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  it('rejects kms init with empty-string kmsKeyId', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms', kmsKeyId: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  it('rejects kms init with null kmsKeyId', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms', kmsKeyId: null },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })

  // Story 1.14 AC-10: the Zod layer now allows a zero-field unseal body (valid for kms-mode
  // vaults per AC-9) — enforcement of "zero fields is invalid for non-kms modes" moved
  // server-side into unsealVault()'s per-mode checks, unchanged in substance, just relocated
  // from the Zod layer. With no vault initialized, the zero-field body still 400s, just with
  // `not_initialized` (the next check in the pipeline) rather than `validation_error`.
  it('rejects unseal with zero credential fields when the vault has not been initialized', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: UNSEAL_URL,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'not_initialized' })
    await app.close()
  })

  it('rejects unseal with more than one credential field', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: UNSEAL_URL,
      payload: { passphrase: 'test-passphrase-12chars', masterKeyPath: '/run/secrets/key.bin' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
    await app.close()
  })
})
