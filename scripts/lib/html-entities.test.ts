// Story 72.29 / 72.31: HTML/SVG brand-name hits run after one HTML-entity decode pass.
import { describe, expect, it } from 'vitest'
import {
  HTML5_NAMED_ENTITY_COUNT,
  HTML5_NAMED_ENTITY_SOURCE,
  decodeHtmlEntities,
} from './html-entities.js'

const BRAND_PATTERN = /project[\s\u00a0]+vault/i
const ENCODED_NBSP = 'Project&nbsp;Vault'
const ENCODED_THIN_SPACE = 'Project&ThinSpace;Vault'
const DECODED_NBSP = 'Project\u00a0Vault'
const DECODED_NAME = 'Project Vault'
const SMALL_MAP_72_29 = new Set([
  'amp',
  'apos',
  'gt',
  'lt',
  'quot',
  'nbsp',
  'NonBreakingSpace',
  'NewLine',
  'Tab',
  'ensp',
  'emsp',
  'emsp13',
  'emsp14',
  'numsp',
  'puncsp',
  'thinsp',
  'hairsp',
  'mediumsp',
  'zwnj',
  'zwj',
  'lrm',
  'rlm',
  'shy',
])

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

  it('decodes WHATWG names that were outside the 72-29 small map', () => {
    expect(SMALL_MAP_72_29.has('ohm')).toBe(false)
    expect(SMALL_MAP_72_29.has('ZeroWidthSpace')).toBe(false)
    expect(SMALL_MAP_72_29.has('ThinSpace')).toBe(false)
    expect(decodeHtmlEntities('&ohm;')).toBe('\u03A9')
    expect(decodeHtmlEntities('&ZeroWidthSpace;')).toBe('\u200B')
    expect(decodeHtmlEntities('&ThickSpace;')).toBe('\u205F\u200A')
    expect(decodeHtmlEntities(ENCODED_THIN_SPACE)).toBe('Project\u2009Vault')
    expect(BRAND_PATTERN.test(ENCODED_THIN_SPACE)).toBe(false)
    expect(BRAND_PATTERN.test(decodeHtmlEntities(ENCODED_THIN_SPACE))).toBe(true)
  })

  it('keeps the terminating semicolon required and drops unofficial 72-29 aliases', () => {
    expect(decodeHtmlEntities('&ohm')).toBe('&ohm')
    expect(decodeHtmlEntities('Project&mediumsp;Vault')).toBe('Project&mediumsp;Vault')
    expect(decodeHtmlEntities('Project&MediumSpace;Vault')).toBe('Project\u205FVault')
  })

  it('pins the generated WHATWG semicolon-terminated table', () => {
    expect(HTML5_NAMED_ENTITY_SOURCE).toBe('https://html.spec.whatwg.org/entities.json')
    expect(HTML5_NAMED_ENTITY_COUNT).toBe(2125)
  })
})
