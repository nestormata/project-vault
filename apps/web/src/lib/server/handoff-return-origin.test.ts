import { describe, expect, it } from 'vitest'
import { resolveCentralizeMeOrigin } from './handoff-return-origin.js'

// Story 60.4 AC3/AC6: the /handoff consent page's "Return to CentralizeMe" link is derived only
// from the web process's own VAULT_HANDOFF_ISSUER — origin-normalized, http(s)-only, no
// credentials — and is absent (plain-text guidance) for anything else.
describe('resolveCentralizeMeOrigin', () => {
  it.each([
    ['3.1 happy', 'https://app.centralizeme.com', 'https://app.centralizeme.com'],
    ['3.1 trailing slash', 'https://app.centralizeme.com/', 'https://app.centralizeme.com'],
    [
      '3.2 path stripped',
      'https://router.centralizeme.com/handoff/v1',
      'https://router.centralizeme.com',
    ],
    [
      '3.2 query/hash stripped',
      'https://cm.example/x?returnTo=https://evil.example#y',
      'https://cm.example',
    ],
    ['3.3 port kept', 'http://127.0.0.1:4173', 'http://127.0.0.1:4173'],
    [
      'surrounding whitespace trimmed',
      '  https://app.centralizeme.com  ',
      'https://app.centralizeme.com',
    ],
  ])('%s → origin', (_label, raw, expected) => {
    expect(resolveCentralizeMeOrigin(raw)).toBe(expected)
  })

  it.each([
    ['3.4 unset', undefined],
    ['3.4 empty', ''],
    ['3.4 whitespace', '   '],
    ['3.5 javascript:', 'javascript:alert(1)'],
    ['3.5 data:', 'data:text/html,<script>alert(1)</script>'],
    ['3.5 mailto:', 'mailto:support@centralizeme.com'],
    ['3.5 relative', '/dashboard'],
    ['3.5 protocol-relative', '//evil.example'],
    ['3.6 non-URL issuer', 'centralizeme-router'],
    ['3.7 credentials', 'https://user:pw@cm.example'],
    ['3.7 username only', 'https://user@cm.example'],
    ['3.12 userinfo trick', 'https://app.centralizeme.com@evil.test'],
    ['ftp scheme', 'ftp://cm.example'],
  ])('%s → null', (_label, raw) => {
    expect(resolveCentralizeMeOrigin(raw)).toBeNull()
  })
})
