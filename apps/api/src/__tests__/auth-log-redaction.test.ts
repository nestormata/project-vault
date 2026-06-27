import { describe, expect, it } from 'vitest'
import { redactBodyForLog } from '../plugins/redact-secrets.js'

const REDACTED = '[REDACTED]'
const TEST_RECOVERY_CODE = 'K7F2M-9QPLX'

describe('auth log redaction', () => {
  it('redacts password fields from logged request bodies', () => {
    const password = 'never-log-this-password'
    const redacted = redactBodyForLog({
      email: 'owner@example.com',
      password,
      orgName: 'Acme Corp',
    })

    expect(redacted).toEqual({
      email: 'owner@example.com',
      password: REDACTED,
      orgName: 'Acme Corp',
    })
    expect(JSON.stringify(redacted)).not.toContain(password)
  })

  it('redacts MFA secrets, TOTP codes, and recovery codes from logged request bodies', () => {
    const redacted = redactBodyForLog({
      totp: '123456',
      recoveryCode: TEST_RECOVERY_CODE,
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUrl: 'otpauth://totp/Project%20Vault:user@example.com',
      qrCodeSvg: '<svg>secret</svg>',
      recoveryCodes: [TEST_RECOVERY_CODE],
    })

    expect(redacted).toEqual({
      totp: REDACTED,
      recoveryCode: REDACTED,
      secret: REDACTED,
      otpauthUrl: REDACTED,
      qrCodeSvg: REDACTED,
      recoveryCodes: REDACTED,
    })
    expect(JSON.stringify(redacted)).not.toContain('123456')
    expect(JSON.stringify(redacted)).not.toContain(TEST_RECOVERY_CODE)
    expect(JSON.stringify(redacted)).not.toContain('JBSWY3DPEHPK3PXP')
  })
})
