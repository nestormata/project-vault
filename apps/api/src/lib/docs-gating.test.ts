import { describe, expect, it } from 'vitest'
import { docsEnabled } from './docs-gating.js'

describe('docsEnabled (Story 9.3 D5)', () => {
  it('is enabled when ENABLE_API_DOCS is explicitly true, regardless of NODE_ENV', () => {
    expect(docsEnabled({ enableApiDocs: true, nodeEnv: 'production' })).toBe(true)
    expect(docsEnabled({ enableApiDocs: true, nodeEnv: 'development' })).toBe(true)
  })

  it('is enabled in development even without the flag', () => {
    expect(docsEnabled({ enableApiDocs: false, nodeEnv: 'development' })).toBe(true)
  })

  it('is enabled in test even without the flag', () => {
    expect(docsEnabled({ enableApiDocs: false, nodeEnv: 'test' })).toBe(true)
  })

  it('is disabled by default in production (fail-closed)', () => {
    expect(docsEnabled({ enableApiDocs: false, nodeEnv: 'production' })).toBe(false)
  })

  // AC-21 item 7: a deliberate allowlist, not a `!== 'production'` negation — any unrecognized
  // value defaults closed too (even though env.ts's Zod enum already rejects genuinely malformed
  // values at startup, this function's own logic must not silently treat "anything but
  // production" as safe).
  it('defaults closed for a value that is neither development, test, nor production', () => {
    expect(docsEnabled({ enableApiDocs: false, nodeEnv: 'staging' })).toBe(false)
  })
})
