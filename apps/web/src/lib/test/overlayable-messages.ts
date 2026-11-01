// Story 72.19 (CentralizeMe request R4): how a PV unit test refers to the text of an overlayable
// message key without writing the default sentence. A host that overlays the key must not turn the
// composed PV suite red, so tests read the message (`overlayableMessage`) and snapshot oracles mask it
// (`maskOverlayable`): the stored snapshot holds a token, the render holds whatever the tree says.
import { m } from '$lib/paraglide/messages.js'
import type { OverlayableMessageKey } from '$lib/i18n/overlayable-message-keys.js'

type MessageFunction = (inputs?: undefined, options?: { locale?: 'en' | 'es' }) => string

// One entry per listed key: adding a key to OVERLAYABLE_MESSAGE_KEYS fails type-checking until it is here.
const MESSAGES: Readonly<Record<OverlayableMessageKey, MessageFunction>> = {
  auth_login_page_description: m.auth_login_page_description,
  auth_login_page_title: m.auth_login_page_title,
  auth_register_page_title: m.auth_register_page_title,
  shell_brand_tagline: m.shell_brand_tagline,
}

/** The key's text in the current locale, or in `locale` when given (what the page really renders). */
export function overlayableMessage(key: OverlayableMessageKey, locale?: 'en' | 'es'): string {
  const message = new Map(Object.entries(MESSAGES)).get(key)
  if (message === undefined) throw new Error(`no message function for ${key}`)
  return message(undefined, locale === undefined ? undefined : { locale })
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
 * only the keys the render under test really draws from the message: the same sentence written as
 * fixed text elsewhere (the auth header, the public home) is not an overlay and stays as it is. */
export function maskOverlayable(text: string, keys: readonly OverlayableMessageKey[]): string {
  return keys.reduce((masked, key) => {
    const value = overlayableMessage(key)
    return masked
      .replaceAll(escapeHtml(value), overlayableToken(key))
      .replaceAll(value, overlayableToken(key))
  }, text)
}
