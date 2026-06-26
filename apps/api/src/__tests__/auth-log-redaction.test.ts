import { describe, expect, it } from 'vitest'
import { redactBodyForLog } from '../plugins/redact-secrets.js'

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
      password: '[REDACTED]',
      orgName: 'Acme Corp',
    })
    expect(JSON.stringify(redacted)).not.toContain(password)
  })
})
