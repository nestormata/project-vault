import { describe, expect, it } from 'vitest'
import { findDbErrorCause, MAX_CAUSE_DEPTH, type DbErrorReason } from './db-error-cause.js'

function withCode(code: unknown, cause?: unknown): Error {
  return Object.assign(new Error('driver text'), {
    code,
    ...(cause === undefined ? {} : { cause }),
  })
}

function chain(depth: number, code: string): unknown {
  let current: unknown = withCode(code)
  for (let i = 0; i < depth; i += 1) current = new Error(`wrapper ${i}`, { cause: current })
  return current
}

// Story 43.28 AC-1: one classifier shared by the startup log and the admin-pool check.
describe('findDbErrorCause', () => {
  const table: Array<[string, DbErrorReason]> = [
    ['28P01', 'auth_failed'],
    ['28000', 'auth_failed'],
    ['3D000', 'database_missing'],
    ['42501', 'permission_denied'],
    ['42P01', 'schema_missing'],
    ['42703', 'schema_missing'],
    ['3F000', 'schema_missing'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_failed'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_failed'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_failed'],
    ['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'tls_failed'],
    ['ECONNREFUSED', 'connection_failed'],
    ['ENOTFOUND', 'connection_failed'],
    ['EAI_AGAIN', 'connection_failed'],
    ['ETIMEDOUT', 'connection_failed'],
    ['CONNECT_TIMEOUT', 'connection_failed'],
    ['57P03', 'connection_failed'],
    ['53300', 'unknown'],
    ['ERR_SOMETHING_ELSE', 'unknown'],
  ]

  it.each(table)('maps code %s to reason %s', (code, reason) => {
    expect(findDbErrorCause(withCode(code))).toEqual({ code, reason, depth: 0 })
  })

  it('finds a drizzle-wrapped driver code at depth 1', () => {
    const wrapper = new Error('Failed query: select * from "vault_state"', {
      cause: withCode('28P01'),
    })
    expect(findDbErrorCause(wrapper)).toEqual({ code: '28P01', reason: 'auth_failed', depth: 1 })
  })

  it('returns null when no link carries a code', () => {
    expect(findDbErrorCause(new Error('boom'))).toBeNull()
    expect(findDbErrorCause('boom')).toBeNull()
    expect(findDbErrorCause(null)).toBeNull()
    expect(findDbErrorCause(undefined)).toBeNull()
  })

  it('finds a code at the maximum depth and ignores one beyond it', () => {
    expect(MAX_CAUSE_DEPTH).toBe(3)
    expect(findDbErrorCause(chain(3, '3D000'))).toEqual({
      code: '3D000',
      reason: 'database_missing',
      depth: 3,
    })
    expect(findDbErrorCause(chain(4, '3D000'))).toBeNull()
  })

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {}
    const b: { cause?: unknown } = { cause: a }
    a.cause = b
    expect(findDbErrorCause(a)).toBeNull()

    const c: { cause?: unknown; code?: string } = {}
    const d = { cause: c, code: undefined }
    c.cause = d
    c.code = 'ECONNREFUSED'
    expect(findDbErrorCause(d)).toEqual({
      code: 'ECONNREFUSED',
      reason: 'connection_failed',
      depth: 1,
    })
  })

  it('ignores a numeric code and keeps walking to the cause', () => {
    const err = withCode(-111, withCode('ECONNREFUSED'))
    expect(findDbErrorCause(err)).toEqual({
      code: 'ECONNREFUSED',
      reason: 'connection_failed',
      depth: 1,
    })
  })

  it('never runs a getter for code or cause', () => {
    let getterRan = false
    const err = new Error('x')
    Object.defineProperty(err, 'code', {
      get() {
        getterRan = true
        return '28P01'
      },
    })
    Object.defineProperty(err, 'cause', {
      get() {
        getterRan = true
        return withCode('28P01')
      },
    })
    expect(findDbErrorCause(err)).toBeNull()
    expect(getterRan).toBe(false)
  })

  it('replaces a code that is not an enumerated identifier with "invalid"', () => {
    const smuggled = 'password authentication failed for user "vault_app"'
    const result = findDbErrorCause(withCode(smuggled))
    expect(result).toEqual({ code: 'invalid', reason: 'unknown', depth: 0 })
    expect(JSON.stringify(result)).not.toContain('vault_app')
    expect(findDbErrorCause(withCode('A'.repeat(65)))?.code).toBe('invalid')
    expect(findDbErrorCause(withCode(''))).toEqual({ code: 'invalid', reason: 'unknown', depth: 0 })
  })

  it('only ever returns a code matching the identifier format', () => {
    for (const [code] of table) {
      expect(findDbErrorCause(withCode(code))?.code).toMatch(/^[A-Z0-9_]{1,64}$/)
    }
  })

  it('never copies the TLS message text (host and port) into the result', () => {
    const tls = Object.assign(
      new Error('self-signed certificate in certificate chain: db.internal:5432'),
      { code: 'SELF_SIGNED_CERT_IN_CHAIN', host: 'db.internal', port: 5432 }
    )
    const result = findDbErrorCause(tls)
    expect(result).toEqual({ code: 'SELF_SIGNED_CERT_IN_CHAIN', reason: 'tls_failed', depth: 0 })
    expect(JSON.stringify(result)).not.toMatch(/db\.internal|5432|self-signed/)
  })
})
