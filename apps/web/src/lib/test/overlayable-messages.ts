// Story 72.19 (CentralizeMe request R4): how a PV unit test refers to the text of an overlayable
// message key without writing the default sentence. A host that overlays the key must not turn the
// composed PV suite red, so tests read the message (`overlayableMessage`) and snapshot oracles mask it
// (`maskOverlayable`): the stored snapshot holds a token, the render holds whatever the tree says.
import { m } from '$lib/paraglide/messages.js'
import type { OverlayableMessageKey } from '$lib/i18n/overlayable-message-keys.js'

type LocaleOpts = { locale?: 'en' | 'es' }

function localeOpts(locale?: 'en' | 'es'): LocaleOpts | undefined {
  return locale === undefined ? undefined : { locale }
}

function brandInLocale(locale?: 'en' | 'es'): string {
  return m.brand_name(undefined, localeOpts(locale))
}

/** The key's text in the current locale, or in `locale` when given (what the page really renders). */
export function overlayableMessage(key: OverlayableMessageKey, locale?: 'en' | 'es'): string {
  const opts = localeOpts(locale)
  const brand = brandInLocale(locale)
  if (key === 'brand_name') return brand
  if (key === 'auth_login_page_description') return m.auth_login_page_description({ brand }, opts)
  if (key === 'auth_login_page_title') return m.auth_login_page_title({ brand }, opts)
  if (key === 'auth_register_page_title') return m.auth_register_page_title({ brand }, opts)
  return m.shell_brand_tagline(undefined, opts)
}

/** The token a snapshot stores in place of a key's text. Free of `{`, which Svelte's parser reads. */
export function overlayableToken(key: OverlayableMessageKey): string {
  return `%%${key}%%`
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** `text` with the current text of each named key (raw or HTML-escaped) replaced by its token. Name
 * only the keys the render under test really draws from the message. */
export function maskOverlayable(text: string, keys: readonly OverlayableMessageKey[]): string {
  return keys.reduce((masked, key) => {
    const value = overlayableMessage(key)
    return masked
      .replaceAll(escapeHtml(value), overlayableToken(key))
      .replaceAll(value, overlayableToken(key))
  }, text)
}
