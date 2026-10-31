// Story 68.6 (design §8): PV's server hooks, composed with the UI pack's server hook contribution
// (`virtual:pv-hooks/server`; empty in PV's own build, so every hook PV did not define stays
// `undefined` and SvelteKit's own defaults run). The same code path runs in PV's build and in a
// composed build; only the virtual module's content differs.
import { env } from '$env/dynamic/private'
import { hooks as contributed, protectedPaths as contributedPaths } from 'virtual:pv-hooks/server'
import { getExtensionPanelCspHeaders } from '$lib/security/hardening.js'
import { PV_HEADER_POLICY } from '$lib/security/header-policy.js'
import { composeServerHooks } from '$lib/server/composition/compose-server-hooks.js'
import { createPvHandle } from '$lib/server/composition/pv-server-hooks.js'
import { PV_PROTECTED_PREFIXES, composeProtectedPaths } from '$lib/server/protected-paths.js'

// Story 29.1 — code-review hardening (2026-08-29). The extension-panel route renders sanitized,
// but not network-egress-restricted, third-party HTML inline into this same document/session
// (see `hardening.ts`'s `getExtensionPanelCspHeaders` doc comment for the full rationale) — a
// tighter, route-scoped CSP replaces the `<meta>`-based one the now-deleted `srcdoc` iframe used
// to carry. `event.setHeaders` throws on a duplicate header name, so this must be exclusive with
// the general `getFrameProtectionHeaders()` call below, not additive to it.
function isExtensionPanelPath(pathname: string) {
  return pathname.startsWith('/extensions/panels/')
}

// Story 68.6 (Nestor 2026-10-02, Q1): the frozen legacy panel branch stays outside the composed
// header policy. For panel paths it is checked first and exclusively, exactly as on `main`; the
// policy (PV's defaults and rules, and every CM delta) applies to every other path, until Story
// 68-11 retires the panel.
function panelHeadersOutsidePolicy({ pathname }: { pathname: string }) {
  return isExtensionPanelPath(pathname) ? getExtensionPanelCspHeaders() : null
}

const composed = composeServerHooks(
  {
    handle: createPvHandle({
      apiBaseUrl: () => env.API_BASE_URL,
      protectedPaths: composeProtectedPaths(PV_PROTECTED_PREFIXES, contributedPaths),
    }),
  },
  contributed,
  { headerPolicy: PV_HEADER_POLICY, outsidePolicy: panelHeadersOutsidePolicy }
)

export const handle = composed.handle
export const handleFetch = composed.handleFetch
export const handleError = composed.handleError
export const handleValidationError = composed.handleValidationError
export const init = composed.init
