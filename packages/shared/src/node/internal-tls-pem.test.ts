import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLIENT_AUTH_EKU_OID,
  InternalTlsConfigError,
  certificateExpiry,
  hasClientAuthEku,
  parseCertBundleB64,
  parsePrivateKeyB64,
  readB64Var,
  resolveTlsMaterial,
} from './internal-tls-pem.js'
import { createTestPki, type TestPki } from './test-pki-test-helpers.js'

let pki: TestPki

beforeAll(async () => {
  pki = await createTestPki()
})

afterAll(async () => {
  await pki.cleanup()
})

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function thrown(fn: () => unknown): InternalTlsConfigError {
  try {
    fn()
  } catch (error) {
    if (error instanceof InternalTlsConfigError) return error
    throw error
  }
  throw new Error('expected an InternalTlsConfigError')
}

describe('readB64Var', () => {
  it('treats unset, empty and whitespace-only values as unset', () => {
    expect(readB64Var({}, 'X')).toBeUndefined()
    expect(readB64Var({ X: '' }, 'X')).toBeUndefined()
    expect(readB64Var({ X: ' \n\t ' }, 'X')).toBeUndefined()
  })

  it('strips every whitespace character, including wrapped base64 newlines', () => {
    expect(readB64Var({ X: ' QUJD\nREVG\r\n ' }, 'X')).toBe('QUJDREVG')
  })
})

describe('parseCertBundleB64', () => {
  it('parses a single certificate and a multi-CA bundle', () => {
    const one = parseCertBundleB64('CA_VAR', pki.ca.certB64)
    expect(one.certs).toHaveLength(1)
    const bundle = parseCertBundleB64('CA_VAR', b64(`${pki.ca.certPem}${pki.foreignCa.certPem}`))
    expect(bundle.certs).toHaveLength(2)
    expect(bundle.pem).toContain(pki.foreignCa.certPem.trim())
  })

  it.each([
    ['not base64', 'not-base64!!'],
    ['base64 of non-PEM text', b64('hello world')],
    ['non-canonical base64 (fails the round trip)', 'QUJDRA'],
    ['base64 of a truncated certificate block', b64('-----BEGIN CERTIFICATE-----\nAAAA')],
    [
      'base64 of a garbage certificate body',
      b64('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'),
    ],
  ])('rejects %s and names only the variable', (_label, value) => {
    const error = thrown(() => parseCertBundleB64('API_TLS_CERT_B64', value))
    expect(error.variable).toBe('API_TLS_CERT_B64')
    expect(error.message).toBe('API_TLS_CERT_B64 is not valid base64 PEM')
    expect(error.message).not.toContain(value)
  })
})

describe('parsePrivateKeyB64', () => {
  it('parses an unencrypted PKCS#8 key', () => {
    const parsed = parsePrivateKeyB64('KEY_VAR', pki.server.keyB64)
    expect(parsed.key.type).toBe('private')
  })

  it('rejects an encrypted private key with a dedicated message', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'test-only-passphrase',
      },
    })
    const error = thrown(() => parsePrivateKeyB64('API_TLS_KEY_B64', b64(privateKey)))
    expect(error.message).toBe('API_TLS_KEY_B64: encrypted private keys are not supported')
  })

  it('rejects a certificate where a key is expected', () => {
    const error = thrown(() => parsePrivateKeyB64('API_TLS_KEY_B64', pki.server.certB64))
    expect(error.message).toBe('API_TLS_KEY_B64 is not valid base64 PEM')
    expect(error.message).not.toContain(pki.server.certB64)
  })
})

const SERVER_SPEC = {
  certVar: 'API_TLS_CERT_B64',
  keyVar: 'API_TLS_KEY_B64',
  caVar: 'API_TLS_CLIENT_CA_B64',
  role: 'server',
} as const

const CLIENT_SPEC = {
  certVar: 'DATABASE_TLS_CLIENT_CERT_B64',
  keyVar: 'DATABASE_TLS_CLIENT_KEY_B64',
  caVar: 'DATABASE_TLS_CA_B64',
  role: 'client',
} as const

describe('resolveTlsMaterial (server role)', () => {
  it('returns nothing when all three variables are unset or empty', () => {
    expect(resolveTlsMaterial({}, SERVER_SPEC)).toEqual({})
    expect(
      resolveTlsMaterial(
        { API_TLS_CERT_B64: '', API_TLS_KEY_B64: ' ', API_TLS_CLIENT_CA_B64: '\n' },
        SERVER_SPEC
      )
    ).toEqual({})
  })

  it('resolves the pair plus the client CA', () => {
    const material = resolveTlsMaterial(
      {
        API_TLS_CERT_B64: pki.server.certB64,
        API_TLS_KEY_B64: pki.server.keyB64,
        API_TLS_CLIENT_CA_B64: pki.ca.certB64,
      },
      SERVER_SPEC
    )
    expect(material.cert?.leaf.subjectAltName).toContain('DNS:localhost')
    expect(material.key).toContain('PRIVATE KEY')
    expect(material.ca).toContain('BEGIN CERTIFICATE')
  })

  it('reports the missing half of the pair on that variable', () => {
    const error = thrown(() =>
      resolveTlsMaterial({ API_TLS_CERT_B64: pki.server.certB64 }, SERVER_SPEC)
    )
    expect(error.variable).toBe('API_TLS_KEY_B64')
    expect(error.message).toBe('API_TLS_KEY_B64 is required when API_TLS_CERT_B64 is set')
    const reverse = thrown(() =>
      resolveTlsMaterial({ API_TLS_KEY_B64: pki.server.keyB64 }, SERVER_SPEC)
    )
    expect(reverse.variable).toBe('API_TLS_CERT_B64')
  })

  it('rejects a client CA without the server pair', () => {
    const error = thrown(() =>
      resolveTlsMaterial({ API_TLS_CLIENT_CA_B64: pki.ca.certB64 }, SERVER_SPEC)
    )
    expect(error.variable).toBe('API_TLS_CLIENT_CA_B64')
    expect(error.message).toBe(
      'API_TLS_CLIENT_CA_B64 requires API_TLS_CERT_B64 and API_TLS_KEY_B64'
    )
  })

  it('rejects a key from a different keypair', () => {
    const error = thrown(() =>
      resolveTlsMaterial(
        { API_TLS_CERT_B64: pki.server.certB64, API_TLS_KEY_B64: pki.client.keyB64 },
        SERVER_SPEC
      )
    )
    expect(error.variable).toBe('API_TLS_KEY_B64')
    expect(error.message).toBe('API_TLS_KEY_B64 does not match API_TLS_CERT_B64')
  })

  it('accepts a certificate chain in the cert variable and uses the first block as the leaf', () => {
    const material = resolveTlsMaterial(
      {
        API_TLS_CERT_B64: b64(`${pki.server.certPem}${pki.ca.certPem}`),
        API_TLS_KEY_B64: pki.server.keyB64,
      },
      SERVER_SPEC
    )
    expect(material.cert?.leaf.subject).toContain('CN=localhost')
  })
})

describe('resolveTlsMaterial (client role)', () => {
  it('allows the CA alone (server verification only)', () => {
    const material = resolveTlsMaterial({ DATABASE_TLS_CA_B64: pki.ca.certB64 }, CLIENT_SPEC)
    expect(material.ca).toContain('BEGIN CERTIFICATE')
    expect(material.cert).toBeUndefined()
  })

  it('rejects a client pair without a CA', () => {
    const error = thrown(() =>
      resolveTlsMaterial(
        {
          DATABASE_TLS_CLIENT_CERT_B64: pki.client.certB64,
          DATABASE_TLS_CLIENT_KEY_B64: pki.client.keyB64,
        },
        CLIENT_SPEC
      )
    )
    expect(error.variable).toBe('DATABASE_TLS_CA_B64')
    expect(error.message).toBe(
      'DATABASE_TLS_CA_B64 is required when DATABASE_TLS_CLIENT_CERT_B64 is set'
    )
  })

  it('rejects an invalid CA value without echoing it', () => {
    const error = thrown(() => resolveTlsMaterial({ DATABASE_TLS_CA_B64: '%%%' }, CLIENT_SPEC))
    expect(error.message).toBe('DATABASE_TLS_CA_B64 is not valid base64 PEM')
  })
})

describe('certificate helpers', () => {
  it('computes an ISO notAfter and whole days remaining', () => {
    const { certs } = parseCertBundleB64('X', pki.server.certB64)
    const leaf = certs[0]
    if (!leaf) throw new Error('missing leaf')
    const expiry = certificateExpiry(leaf, new Date())
    expect(expiry.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(expiry.daysRemaining).toBeGreaterThanOrEqual(396)
    expect(expiry.daysRemaining).toBeLessThanOrEqual(397)
    expect(expiry.secondsRemaining).toBeGreaterThan(396 * 86400)
  })

  it('detects the clientAuth EKU', () => {
    const client = parseCertBundleB64('X', pki.client.certB64).certs[0]
    const server = parseCertBundleB64('X', pki.server.certB64).certs[0]
    if (!client || !server) throw new Error('missing leaf')
    expect(client.keyUsage).toContain(CLIENT_AUTH_EKU_OID)
    expect(hasClientAuthEku(client)).toBe(true)
    expect(hasClientAuthEku(server)).toBe(false)
  })
})
