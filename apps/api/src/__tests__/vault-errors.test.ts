import { describe, it, expect } from 'vitest'
import { createApp } from '../app.js'

const INIT_URL = '/api/v1/vault/init'
const UNSEAL_URL = '/api/v1/vault/unseal'

describe('vault route validation errors', () => {
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

  it('rejects unseal with zero credential fields', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({
      method: 'POST',
      url: UNSEAL_URL,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'validation_error' })
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
