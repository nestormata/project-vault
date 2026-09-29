import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestPki, type TestPki } from '@project-vault/shared/test-pki'
import { pgBossConnectionOptions, pgTlsOptions } from './pg-tls.js'

// Story 43.16 AC-3: every Postgres client that can reach the Fly DB pins the private CA.
let pki: TestPki

beforeAll(async () => {
  pki = await createTestPki({ clientCommonName: 'project-vault-demo-api' })
})

afterAll(async () => {
  await pki.cleanup()
})

describe('pgTlsOptions', () => {
  it('returns {} when no DATABASE_TLS variable is set (today’s behaviour)', () => {
    expect(pgTlsOptions({})).toEqual({})
    expect(pgTlsOptions({ DATABASE_TLS_CA_B64: '  ' })).toEqual({})
  })

  it('pins the CA with rejectUnauthorized and TLS 1.3', () => {
    const options = pgTlsOptions({ DATABASE_TLS_CA_B64: pki.ca.certB64 })
    expect(options).toEqual({
      ssl: { ca: pki.ca.certPem, minVersion: 'TLSv1.3', rejectUnauthorized: true },
    })
  })

  it('adds the client pair for DB mTLS (AC-12)', () => {
    const options = pgTlsOptions({
      DATABASE_TLS_CA_B64: pki.ca.certB64,
      DATABASE_TLS_CLIENT_CERT_B64: pki.client.certB64,
      DATABASE_TLS_CLIENT_KEY_B64: pki.client.keyB64,
    })
    expect(options).toEqual({
      ssl: {
        ca: pki.ca.certPem,
        cert: pki.client.certPem,
        key: pki.client.keyPem,
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      },
    })
  })

  it('throws naming the variable, never the value, on invalid base64', () => {
    expect(() => pgTlsOptions({ DATABASE_TLS_CA_B64: '%%%' })).toThrow(
      'DATABASE_TLS_CA_B64 is not valid base64 PEM'
    )
  })

  it('rejects a client pair without a CA and a half pair', () => {
    expect(() =>
      pgTlsOptions({
        DATABASE_TLS_CLIENT_CERT_B64: pki.client.certB64,
        DATABASE_TLS_CLIENT_KEY_B64: pki.client.keyB64,
      })
    ).toThrow('DATABASE_TLS_CA_B64 is required when DATABASE_TLS_CLIENT_CERT_B64 is set')
    expect(() =>
      pgTlsOptions({
        DATABASE_TLS_CA_B64: pki.ca.certB64,
        DATABASE_TLS_CLIENT_CERT_B64: pki.client.certB64,
      })
    ).toThrow('DATABASE_TLS_CLIENT_KEY_B64 is required when DATABASE_TLS_CLIENT_CERT_B64 is set')
  })

  it('wins over the URL sslmode in postgres.js (explicit ssl object precedence)', async () => {
    const tls = pgTlsOptions({ DATABASE_TLS_CA_B64: pki.ca.certB64 })
    const sql = postgres('postgresql://u:p@db.internal:5432/x?sslmode=verify-full', {
      ...tls,
      max: 1,
    })
    try {
      expect(sql.options.ssl).toEqual({
        ca: pki.ca.certPem,
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      })
    } finally {
      await sql.end({ timeout: 0 })
    }
  })
})

describe('pgBossConnectionOptions', () => {
  const url = 'postgresql://vault_app:pw@db.internal:5432/project_vault?sslmode=verify-full'

  it('passes the connection string through unchanged when TLS is off', () => {
    expect(pgBossConnectionOptions(url, {})).toEqual({ connectionString: url })
  })

  // node-postgres lets URL ssl params override the `ssl` option, so the pin only holds if every
  // ssl* query parameter is removed from the string it parses.
  it('strips every ssl* URL parameter and carries the pinned ssl object', () => {
    const options = pgBossConnectionOptions(`${url}&sslrootcert=/x&application_name=pv`, {
      DATABASE_TLS_CA_B64: pki.ca.certB64,
    })
    expect(options).toEqual({
      connectionString:
        'postgresql://vault_app:pw@db.internal:5432/project_vault?application_name=pv',
      ssl: { ca: pki.ca.certPem, minVersion: 'TLSv1.3', rejectUnauthorized: true },
    })
  })

  // Review follow-up (43-16 #11): WHATWG URL's TypeError carries the raw input (password
  // included) on `input`; the rethrown error names the variable only and chains nothing.
  it('rejects an unparseable URL naming DATABASE_URL, never echoing the URL', () => {
    const passwordSentinel = 'pw-review-sentinel'
    const unparseable = `not a url vault_app:${passwordSentinel}@db.internal`
    let caught: unknown
    try {
      pgBossConnectionOptions(unparseable, { DATABASE_TLS_CA_B64: pki.ca.certB64 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const error = caught as Error & { input?: unknown }
    expect(error.message).toBe('DATABASE_URL is not a parseable URL')
    expect(error.input).toBeUndefined()
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(passwordSentinel)
  })
})
