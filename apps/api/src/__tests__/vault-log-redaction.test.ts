import { describe, it, expect } from 'vitest'
import { redactBodyForLog } from '../plugins/redact-secrets.js'

const REDACTED = '[REDACTED]'

describe('redactBodyForLog', () => {
  it('redacts passphrase field', () => {
    const result = redactBodyForLog({ kmsType: 'passphrase', passphrase: 'super-secret-12chars' })
    expect(result).toEqual({ kmsType: 'passphrase', passphrase: REDACTED })
  })

  it('redacts masterKeyPath and envelopeKeyPath fields', () => {
    const result = redactBodyForLog({
      masterKeyPath: '/run/secrets/key.bin',
      envelopeKeyPath: '/run/secrets/half.bin',
    })
    expect(result).toEqual({
      masterKeyPath: REDACTED,
      envelopeKeyPath: REDACTED,
    })
  })

  it('leaves non-sensitive fields untouched', () => {
    const result = redactBodyForLog({ kmsType: 'envelope', acknowledgeSplitKeyModel: true })
    expect(result).toEqual({ kmsType: 'envelope', acknowledgeSplitKeyModel: true })
  })

  it('passes through non-object bodies unchanged', () => {
    expect(redactBodyForLog(null)).toBeNull()
    expect(redactBodyForLog(undefined)).toBeUndefined()
    expect(redactBodyForLog('raw-string')).toBe('raw-string')
  })

  it('never leaks the passphrase value in the redacted output', () => {
    const passphrase = 'never-leak-this-passphrase'
    const result = redactBodyForLog({ passphrase }) as Record<string, unknown>
    expect(JSON.stringify(result)).not.toContain(passphrase)
  })

  // Story 1.14 AC-18 positive example: the KMS key ARN is not a secret and must remain visible
  // in the vault.init log line, unlike passphrase/masterKeyPath/envelopeKeyPath.
  it('leaves kmsKeyId untouched for kms-mode init bodies', () => {
    const result = redactBodyForLog({
      kmsType: 'kms',
      kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr',
    })
    expect(result).toEqual({
      kmsType: 'kms',
      kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr',
    })
  })
})
