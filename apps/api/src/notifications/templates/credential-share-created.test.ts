import { describe, expect, it } from 'vitest'
import { renderCredentialShareCreated } from './credential-share-created.js'

const BASE_PAYLOAD = {
  shareId: 'share-1',
  credentialId: 'cred-1',
  sharedByUserId: 'user-1',
  fieldKey: null,
}

describe('renderCredentialShareCreated', () => {
  it('renders whole-credential share text/html without a field note when fieldKey is null', () => {
    const result = renderCredentialShareCreated(BASE_PAYLOAD)

    expect(result.subject).toBe('[Project Vault] A credential was shared with you')
    expect(result.text).toContain('A teammate shared a credential with you.')
    expect(result.text).toContain('Open Project Vault and check your Shares to view it.')
    expect(result.html).toContain('A teammate shared a credential with you.')
  })

  it('includes the field note when fieldKey is set', () => {
    const result = renderCredentialShareCreated({ ...BASE_PAYLOAD, fieldKey: 'api_key' })

    expect(result.text).toContain('(field: api_key)')
    expect(result.html).toContain('(field: api_key)')
  })

  it('never embeds a share link/token in the rendered output (AC-10/AC-18)', () => {
    const result = renderCredentialShareCreated(BASE_PAYLOAD)

    expect(result.text).not.toContain('/shares/')
    expect(result.html).not.toContain('/shares/')
    expect(result.text).not.toContain(BASE_PAYLOAD.shareId)
    expect(result.html).not.toContain(BASE_PAYLOAD.shareId)
  })

  it('HTML-escapes a fieldKey containing special characters', () => {
    const result = renderCredentialShareCreated({
      ...BASE_PAYLOAD,
      fieldKey: '<script>alert(1)</script>',
    })

    expect(result.html).not.toContain('<script>alert(1)</script>')
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
