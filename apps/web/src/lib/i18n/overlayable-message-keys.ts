// Story 72.19 (CentralizeMe request R4): the PV message keys a host is expected to overlay (a pack's
// `messages/<locale>.json`), as data. PV's own unit tests must not pin the text of these keys, because a
// composed run (PV's shipped tests over a tree with the pack's messages) would turn red as soon as a
// host changes one. A test reads the message (`m.<key>()`) or masks it (`$lib/test/overlayable-messages`)
// instead of writing the default sentence. `scripts/check-overlayable-messages.ts` fails when a test
// does, and when the mock UI pack stops overlaying one of these keys.
//
// This file is data only (no imports) so that script can read it. Add a key here when PV documents it
// as overlayable (docs/composition-kit.md); it is a contract, so removing one is a breaking change.
export const OVERLAYABLE_MESSAGE_KEYS = [
  'auth_login_page_description',
  'auth_login_page_title',
  'auth_register_page_title',
  'brand_name',
  'shell_brand_tagline',
] as const

export type OverlayableMessageKey = (typeof OVERLAYABLE_MESSAGE_KEYS)[number]
