import { randomUUID } from 'node:crypto'
import { createSigner } from 'fast-jwt'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetBurnedJtiForTests,
  createEnvelopeAuthStrategy,
  signFixtureEnvelope,
} from './index.js'
import { FIXTURE_TEST_ONLY_PRIVATE_KEY, FIXTURE_TEST_ONLY_PUBLIC_KEY } from './keys.js'

const AUD = 'test-instance'
const ATTACKER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIIID4q0+KSd+JzOEzOpd5T8VK/xktbL4uOMvA92c3L7v
-----END PRIVATE KEY-----`

function makeStrategy(overrides: Partial<Parameters<typeof createEnvelopeAuthStrategy>[0]> = {}) {
  return createEnvelopeAuthStrategy({ expectedAudience: AUD, ...overrides })
}

describe('mock-envelope-extension (Story 23.2 AC-14/AC-15)', () => {
  beforeEach(() => {
    __resetBurnedJtiForTests()
  })

  it('accepts a validly signed envelope and returns the expected AuthResult', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD, email: 'user1@example.test' })

    const result = await strategy.onAuthenticate(token)

    expect(result).toEqual({
      externalSubject: 'user-1',
      providerName: 'test.mock-envelope-extension',
      email: 'user1@example.test',
    })
  })

  it('rejects an invalid signature', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD })
    const tampered = token.slice(0, -4) + 'abcd'

    await expect(strategy.onAuthenticate(tampered)).rejects.toThrow()
  })

  it('rejects an expired envelope', async () => {
    const strategy = makeStrategy({ clock: () => Date.now() + 120_000 })
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD })

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects exp - iat > 60s even when not yet expired', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD }, { lifetimeSeconds: 3600 })

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects a replayed jti on the second use', async () => {
    const strategy = makeStrategy()
    const jti = randomUUID()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD, jti })

    await expect(strategy.onAuthenticate(token)).resolves.toBeDefined()
    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects concurrent replay of the same jti — exactly one caller wins', async () => {
    const strategy = makeStrategy()
    const jti = randomUUID()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD, jti })

    const results = await Promise.allSettled([
      strategy.onAuthenticate(token),
      strategy.onAuthenticate(token),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })

  it('rejects the wrong audience', async () => {
    const strategy = makeStrategy({ expectedAudience: 'a-different-instance' })
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD })

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects alg: none', async () => {
    const strategy = makeStrategy()
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        aud: AUD,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: randomUUID(),
      })
    ).toString('base64url')
    const noneToken = `${header}.${payload}.`

    await expect(strategy.onAuthenticate(noneToken)).rejects.toThrow()
  })

  it('rejects an HMAC-signed token that reuses the Ed25519 public key PEM as an HMAC secret (algorithm-confusion)', async () => {
    const strategy = makeStrategy()
    const confusionSign = createSigner({
      key: FIXTURE_TEST_ONLY_PUBLIC_KEY,
      algorithm: 'HS256',
      expiresIn: 60_000,
      jti: randomUUID(),
      aud: AUD,
      sub: 'user-1',
    })
    const confusionToken = confusionSign({}) as unknown as string

    await expect(strategy.onAuthenticate(confusionToken)).rejects.toThrow()
  })

  it('rejects a token missing required claims', async () => {
    const strategy = makeStrategy()
    const sign = createSigner({
      key: FIXTURE_TEST_ONLY_PRIVATE_KEY,
      algorithm: 'EdDSA',
      // No aud/jti supplied and noTimestamp skips iat — required-claims check must catch this.
      noTimestamp: true,
    })
    const token = sign({ sub: 'user-1' }) as unknown as string

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects malformed input', async () => {
    const strategy = makeStrategy()

    await expect(strategy.onAuthenticate('not-a-jwt-at-all')).rejects.toThrow()
    await expect(strategy.onAuthenticate('')).rejects.toThrow()
  })

  it('rejects an untrusted role claim', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD, role: 'platform_operator' })

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('accepts the one allow-listed role claim', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD, role: 'member' })

    await expect(strategy.onAuthenticate(token)).resolves.toBeDefined()
  })

  it('rejects when the verification key can never be obtained (simulated JWKS failure)', async () => {
    const strategy = makeStrategy({
      getVerificationKey: () => {
        throw new Error('simulated JWKS endpoint unreachable')
      },
    })
    const token = signFixtureEnvelope({ sub: 'user-1', aud: AUD })

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('rejects a token signed with an unrelated Ed25519 keypair (wrong key)', async () => {
    const strategy = makeStrategy()
    const token = signFixtureEnvelope(
      { sub: 'user-1', aud: AUD },
      { privateKey: ATTACKER_PRIVATE_KEY }
    )

    await expect(strategy.onAuthenticate(token)).rejects.toThrow()
  })

  it('every rejection throws the same generic error shape (AC-15 uniform rejection)', async () => {
    const strategy = makeStrategy()
    const badAud = signFixtureEnvelope({ sub: 'a', aud: 'wrong' })
    const expired = signFixtureEnvelope(
      { sub: 'a', aud: AUD },
      { iatOverride: Date.now() - 120_000 }
    )

    let err1: Error | undefined
    let err2: Error | undefined
    try {
      await strategy.onAuthenticate(badAud)
    } catch (e) {
      err1 = e as Error
    }
    try {
      await strategy.onAuthenticate(expired)
    } catch (e) {
      err2 = e as Error
    }

    expect(err1?.message).toBe(err2?.message)
    expect(err1?.name).toBe(err2?.name)
  })
})
