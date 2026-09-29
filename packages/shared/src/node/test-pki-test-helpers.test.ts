import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OPENSSL_SEARCH_DIRS,
  createTestPki,
  resolveOpensslBinary,
  type TestPki,
} from './test-pki-test-helpers.js'

let pki: TestPki

beforeAll(async () => {
  pki = await createTestPki({ clientCommonName: 'pv-helper-client' })
})

afterAll(async () => {
  await pki.cleanup()
})

describe('createTestPki', () => {
  it('issues leaves that chain to the right CA', () => {
    const ca = new X509Certificate(pki.ca.certPem)
    const foreignCa = new X509Certificate(pki.foreignCa.certPem)
    expect(new X509Certificate(pki.server.certPem).checkIssued(ca)).toBe(true)
    expect(new X509Certificate(pki.client.certPem).checkIssued(ca)).toBe(true)
    expect(new X509Certificate(pki.foreignClient.certPem).checkIssued(foreignCa)).toBe(true)
    expect(new X509Certificate(pki.foreignServer.certPem).checkIssued(ca)).toBe(false)
  })

  it('gives the server leaf localhost SANs and the client leaf the requested CN', () => {
    expect(new X509Certificate(pki.server.certPem).subjectAltName).toContain('DNS:localhost')
    expect(new X509Certificate(pki.client.certPem).subject).toContain('CN=pv-helper-client')
    expect(Buffer.from(pki.client.keyB64, 'base64').toString('utf8')).toBe(pki.client.keyPem)
  })

  it('issues an already-expired leaf for days = 0', async () => {
    const leaf = await pki.issueLeaf({ commonName: 'expired', eku: 'clientAuth', days: 0 })
    const cert = new X509Certificate(leaf.certPem)
    expect(new Date(cert.validTo).getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('removes its working directory on cleanup and fails loudly without openssl', async () => {
    const other = await createTestPki()
    await other.cleanup()
    await expect(promisify(execFile)('test', ['-e', other.dir])).rejects.toThrow()
    await expect(createTestPki({ opensslSearchDirs: ['/nonexistent'] })).rejects.toThrow(
      /test PKI: openssl not found in \/nonexistent/
    )
  })
})

// typescript:S4036 (Story 43.9 AC-4 precedent): openssl is resolved from fixed root-owned
// directories, never looked up through $PATH.
describe('resolveOpensslBinary', () => {
  it('resolves an absolute path from the fixed directories only', () => {
    const resolved = resolveOpensslBinary()
    expect(OPENSSL_SEARCH_DIRS.some((dir) => resolved === `${dir}/openssl`)).toBe(true)
  })

  it('ignores $PATH entirely', async () => {
    const originalPath = process.env['PATH']
    process.env['PATH'] = '/nonexistent'
    try {
      expect(OPENSSL_SEARCH_DIRS.map((dir) => `${dir}/openssl`)).toContain(resolveOpensslBinary())
      const pki = await createTestPki()
      await pki.cleanup()
    } finally {
      process.env['PATH'] = originalPath
    }
  })

  it('throws naming the searched directories when openssl is absent', () => {
    expect(() => resolveOpensslBinary(['/nonexistent-a', '/nonexistent-b'])).toThrow(
      'test PKI: openssl not found in /nonexistent-a, /nonexistent-b'
    )
  })
})
