// Story 72.29: HTML/SVG brand-name hits run after one HTML-entity decode pass.
import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities } from './html-entities.js'

const BRAND_PATTERN = /project[\s\u00a0]+vault/i
const ENCODED_NBSP = 'Project&nbsp;Vault'
const DECODED_NBSP = 'Project\u00a0Vault'
const DECODED_NAME = 'Project Vault'

describe('decodeHtmlEntities', () => {
  it('decodes named nbsp and numeric nbsp (decimal and hex)', () => {
    expect(decodeHtmlEntities(ENCODED_NBSP)).toBe(DECODED_NBSP)
    expect(decodeHtmlEntities('Project&#160;Vault')).toBe(DECODED_NBSP)
    expect(decodeHtmlEntities('Project&#xA0;Vault')).toBe(DECODED_NBSP)
    expect(decodeHtmlEntities('Project&#xa0;Vault')).toBe(DECODED_NBSP)
  })

  it('decodes a letter and a space hidden as numeric references', () => {
    expect(decodeHtmlEntities('Projec&#116; Vault')).toBe(DECODED_NAME)
    expect(decodeHtmlEntities('Project&#x20;Vault')).toBe(DECODED_NAME)
  })

  it('decodes named whitespace that the brand pattern already treats as a gap', () => {
    expect(decodeHtmlEntities('Project&ensp;Vault')).toBe('Project\u2002Vault')
    expect(decodeHtmlEntities('Project&Tab;Vault')).toBe('Project\tVault')
  })

  it('is a single pass: &amp;nbsp; stays an encoded nbsp, not a decoded name', () => {
    expect(decodeHtmlEntities('Project&amp;nbsp;Vault')).toBe(ENCODED_NBSP)
  })

  it('leaves unknown names, unterminated refs and plain text unchanged', () => {
    expect(decodeHtmlEntities('Project&notanentity;Vault')).toBe('Project&notanentity;Vault')
    expect(decodeHtmlEntities('Project&nbspVault')).toBe('Project&nbspVault')
    expect(decodeHtmlEntities(DECODED_NAME)).toBe(DECODED_NAME)
  })

  it('does not throw on an out-of-range numeric reference', () => {
    expect(decodeHtmlEntities('x&#x110000;y')).toBe('x\uFFFDy')
  })

  it('mutation: the encoded form is invisible to the brand pattern until decode', () => {
    expect(BRAND_PATTERN.test(ENCODED_NBSP)).toBe(false)
    expect(BRAND_PATTERN.test(decodeHtmlEntities(ENCODED_NBSP))).toBe(true)
  })
})
