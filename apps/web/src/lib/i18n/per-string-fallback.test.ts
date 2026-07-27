import { describe, expect, it } from 'vitest'
import { m } from '$lib/paraglide/messages.js'

/**
 * Story 15.1 AC 3 — a message key with no translation in the selected locale falls back to
 * English for that specific string, per-string, while every other translated string on the same
 * page still renders in the selected locale. `settings_language_save_success` is deliberately
 * omitted from messages/es.json (documented there) to prove this is Paraglide's actual compiled
 * behavior, not an assumption — see Task 4.5 (rely on Paraglide's built-in fallback, don't
 * hand-roll one).
 */
describe('per-string English fallback (AC 3)', () => {
  it('falls back to English for a key missing from the es translation', () => {
    expect(m.settings_language_save_success(undefined, { locale: 'es' })).toBe(
      'Language preference saved.'
    )
  })

  it('every other translated key on the same page still renders in Spanish', () => {
    expect(m.settings_language_page_heading(undefined, { locale: 'es' })).toBe(
      'Idioma de visualización'
    )
  })
})
