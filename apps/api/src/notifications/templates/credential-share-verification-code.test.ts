import { describe, expect, it } from 'vitest'
import { renderCredentialShareVerificationCode } from './credential-share-verification-code.js'
import { renderEmailTemplate } from './index.js'

const PAYLOAD = { code: '048213', sharedByDisplayName: 'nestor' }

describe('renderCredentialShareVerificationCode (Story 72-11 V11)', () => {
  it('renders the subject, the code, the validity, the sharer and the ignore line', () => {
    const result = renderCredentialShareVerificationCode(PAYLOAD)
    expect(result.subject).toBe('[Project Vault] Your verification code')
    for (const part of [result.text, result.html]) {
      expect(part).toContain('048213')
      expect(part).toContain('valid for 10 minutes')
      expect(part).toContain('nestor')
      expect(part).toContain('If you did not expect this, ignore this email.')
    }
  })

  it('never carries a link', () => {
    const result = renderCredentialShareVerificationCode(PAYLOAD)
    expect(result.text).not.toMatch(/https?:|www\./i)
    expect(result.html).not.toMatch(/https?:|href|www\./i)
  })

  it('escapes the sharer name in the HTML part', () => {
    const result = renderCredentialShareVerificationCode({
      ...PAYLOAD,
      sharedByDisplayName: '<b>x</b>',
    })
    expect(result.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(result.html).not.toContain('<b>x</b>')
  })

  it('does not throw on a malformed payload (a scrubbed row renders without a code)', () => {
    const result = renderCredentialShareVerificationCode({})
    expect(result.text).toContain('A teammate')
    expect(result.text).not.toContain('undefined')
  })

  it('is registered in the template registry, and the inbox fields never carry the code', () => {
    const rendered = renderEmailTemplate('credential_share.verification_code', PAYLOAD)
    expect(rendered.subject).toBe('[Project Vault] Your verification code')
    expect(rendered.text).toContain('048213')
    expect(rendered.inboxTitle).toBe('Your verification code')
    expect(rendered.inboxBody).not.toContain('048213')
  })
})
