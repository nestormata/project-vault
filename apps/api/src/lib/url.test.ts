import { describe, expect, it } from 'vitest'
import { stripTrailingSlashes } from './url.js'

const EXAMPLE_URL = 'https://example.com'

describe('stripTrailingSlashes', () => {
  it('removes a single trailing slash', () => {
    expect(stripTrailingSlashes(`${EXAMPLE_URL}/`)).toBe(EXAMPLE_URL)
  })

  it('removes multiple trailing slashes', () => {
    expect(stripTrailingSlashes(`${EXAMPLE_URL}///`)).toBe(EXAMPLE_URL)
  })

  it('leaves a url with no trailing slash unchanged', () => {
    expect(stripTrailingSlashes(EXAMPLE_URL)).toBe(EXAMPLE_URL)
  })

  it('returns an empty string unchanged, and a string of only slashes as empty', () => {
    expect(stripTrailingSlashes('')).toBe('')
    expect(stripTrailingSlashes('///')).toBe('')
  })
})
