import { describe, expect, it } from 'vitest'
import { assertTrustedOrigin, buildAbsoluteUrl } from './absolute-url.js'

const TRUSTED_ORIGIN = 'https://vault.example.com'
const SHARE_PATH = '/shares/tok123'
const EXPECTED_URL = `${TRUSTED_ORIGIN}${SHARE_PATH}`

describe('buildAbsoluteUrl', () => {
  // Story 18.2 AC-1/AC-2/AC-7: centralized "build absolute app URL from path" helper — every
  // shared/generated link (credential shares, public status page, etc.) goes through this instead
  // of reimplementing origin + path concatenation ad hoc.
  it('joins a trusted origin and an app-relative path into a full absolute URL', () => {
    expect(buildAbsoluteUrl(TRUSTED_ORIGIN, SHARE_PATH)).toBe(EXPECTED_URL)
  })

  it('normalizes a path missing its leading slash', () => {
    expect(buildAbsoluteUrl(TRUSTED_ORIGIN, 'shares/tok123')).toBe(EXPECTED_URL)
  })

  it('strips a trailing slash already present on the origin', () => {
    expect(buildAbsoluteUrl(`${TRUSTED_ORIGIN}/`, SHARE_PATH)).toBe(EXPECTED_URL)
  })

  it('preserves a non-default port on the origin', () => {
    expect(buildAbsoluteUrl('http://localhost:5173', SHARE_PATH)).toBe(
      `http://localhost:5173${SHARE_PATH}`
    )
  })

  // AC-5: must never silently produce a broken "https://undefined/..." link — fail loudly instead
  // so a misconfigured/missing origin is caught by tests/CI rather than shown to an end user.
  it.each([
    ['', SHARE_PATH],
    [undefined as unknown as string, SHARE_PATH],
    [null as unknown as string, SHARE_PATH],
    ['not-a-url', SHARE_PATH],
    ['ftp://vault.example.com', SHARE_PATH],
    // A scheme-only value (no host) satisfies a naive `/^https?:\/\//` prefix check but is not a
    // valid URL — regression guard so a load-time guard reimplementing that check can never be
    // weaker than what this function actually requires (see `assertTrustedOrigin`).
    ['https://', SHARE_PATH],
  ])('throws instead of building a broken link when origin is %p', (origin, path) => {
    expect(() => buildAbsoluteUrl(origin, path)).toThrow()
  })
})

describe('assertTrustedOrigin', () => {
  // This is the single validation both `buildAbsoluteUrl` and every route's load-time origin
  // guard delegate to, so they can't drift out of sync with each other.
  it('returns the normalized origin for a well-formed http(s) origin', () => {
    expect(assertTrustedOrigin(TRUSTED_ORIGIN)).toBe(TRUSTED_ORIGIN)
  })

  it.each(['', undefined as unknown as string, null as unknown as string, 'not-a-url', 'https://'])(
    'throws for an untrustworthy origin: %p',
    (origin) => {
      expect(() => assertTrustedOrigin(origin)).toThrow()
    }
  )
})
