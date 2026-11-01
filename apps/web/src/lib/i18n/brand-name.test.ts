import { afterEach, describe, expect, it } from 'vitest'
import enCatalog from '../../../messages/en.json'
import esCatalog from '../../../messages/es.json'
import { m } from '$lib/paraglide/messages.js'
import { setLocale } from '$lib/paraglide/runtime.js'

// Story 72.16 (CM request R1): the product name is the `brand_name` message. This is the one place
// that pins its default; every other test reads `m.brand_name()`, and a host renames PV by overlaying
// this single key (`docs/composition-kit.md`).
const DEFAULT_BRAND = 'Project Vault'

describe('brand_name message (Story 72.16)', () => {
  afterEach(() => setLocale('en', { reload: false }))

  it('defaults to the product name in both catalogues, so PV renders byte-identically', () => {
    expect(enCatalog.brand_name).toBe(DEFAULT_BRAND)
    expect(esCatalog.brand_name).toBe(DEFAULT_BRAND)
    expect(m.brand_name()).toBe(DEFAULT_BRAND)
  })

  it('is the name in every locale: a pack overlays one key to rename the product', () => {
    setLocale('es', { reload: false })
    expect(m.brand_name()).toBe(DEFAULT_BRAND)
  })

  it('messages that name the product take it as the {brand} parameter', () => {
    expect(m.auth_login_page_title({ brand: 'Acme Safe' })).toBe('Sign in | Acme Safe')
    expect(m.auth_login_page_description({ brand: 'Acme Safe' })).toBe(
      'Use your Acme Safe account to continue.'
    )
    expect(m.shares_index_page_title({ brand: m.brand_name() })).toBe(`Shares | ${DEFAULT_BRAND}`)
  })

  it('no catalogue message other than brand_name contains the literal name', () => {
    for (const catalogue of [enCatalog, esCatalog]) {
      const offenders = Object.entries(catalogue).filter(
        ([key, value]) =>
          key !== 'brand_name' && typeof value === 'string' && value.includes(DEFAULT_BRAND)
      )
      expect(offenders).toEqual([])
    }
  })
})
