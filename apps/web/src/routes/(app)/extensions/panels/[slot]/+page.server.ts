import { getExtensionPanel } from '$lib/api/extension-panel.js'
import { getThemes } from '$lib/api/themes.js'
import { requireUser } from '$lib/server/require-user.js'
import { resolveAppliedThemeWithOrgDefault } from '$lib/theme/apply-theme.js'
import {
  BASE_EXTENSION_THEME_VARS,
  resolveExtensionThemeVars,
} from '$lib/security/extension-theme-vars.js'
import type { ExtensionThemeVars } from '$lib/security/extension-theme-vars.js'
import { assertTrustedOrigin } from '@project-vault/shared'
import type { PageServerLoad } from './$types.js'

// Story 25.1 AC3: every degraded cause (throw, timeout, malformed result, permanently-absent
// hook, or a non-2xx from the API itself) renders the SAME calm "unavailable" state — this page
// never tries to distinguish them, matching the API route's own uniform degraded response.
export type ExtensionPanelPageData = {
  slot: string
  html: string | null
  themeVars: ExtensionThemeVars
  // Story 25.5 AC4/Task 4: actionsOrigin drives compose-panel-document.ts's conditional
  // connect-src widening (undefined = no widening); actionEndpoint is forwarded through
  // unchanged from the API response (undefined, never '', when the loaded extension declares no
  // moduleActions). actionsOrigin is this request's own trusted origin (never the literal
  // 'self' keyword — see compose-panel-document.ts's bug-fix comment for why that keyword can
  // never work inside this iframe's opaque-origin sandbox), populated only alongside
  // actionEndpoint.
  actionsOrigin: string | undefined
  actionEndpoint: string | undefined
}

/**
 * Story 25.4 AC4 — resolves the same three-tier `resolveAppliedThemeWithOrgDefault()` result
 * `(app)/+layout.server.ts` already computes for PV's own chrome, independently of Story 25.3's
 * own `UIPanelContext.theme.name` route wiring (this story does not depend on 25.3 landing first
 * — see Dependencies). Fails open to the base/default theme vars on any error, matching every
 * other fail-open theme-load convention in this codebase (`(app)/+layout.server.ts`'s
 * `resolveThemeLoad`).
 */
async function resolveThemeVars(fetchFn: typeof fetch): Promise<ExtensionThemeVars> {
  try {
    const themesResponse = await getThemes(fetchFn)
    const availableThemeNames = themesResponse.themes.map((theme) => theme.name)
    const appliedThemeName = resolveAppliedThemeWithOrgDefault(
      themesResponse.selected,
      themesResponse.orgDefaultThemeName,
      availableThemeNames
    )
    return resolveExtensionThemeVars(appliedThemeName, themesResponse.themes)
  } catch {
    return BASE_EXTENSION_THEME_VARS
  }
}

export const load: PageServerLoad = async ({ params, fetch, locals, url }) => {
  // Defense in depth alongside auth-guard.ts's isProtectedAppPath redirect-to-login (AC1) — this
  // page is unreachable server-side without a resolved session either way.
  requireUser(locals)

  const themeVars = await resolveThemeVars(fetch)

  try {
    const result = await getExtensionPanel(fetch, params.slot)
    const actionEndpoint = result.ok ? result.actionEndpoint : undefined
    // Bug fix (2026-08-24, found via Chrome-driven manual verification): the composed panel's
    // CSP needs the real, concrete PV origin here — not the 'self' keyword, which can never
    // match inside the panel iframe's opaque-origin sandbox (see compose-panel-document.ts).
    // Only resolved when actually needed (an extension declaring actions), same as
    // resolveTrustedOrigin()'s existing credential-detail/status-page precedent.
    const actionsOrigin = actionEndpoint !== undefined ? assertTrustedOrigin(url.origin) : undefined
    return {
      slot: params.slot,
      html: result.ok ? result.html : null,
      themeVars,
      actionsOrigin,
      actionEndpoint,
    } satisfies ExtensionPanelPageData
  } catch {
    // Covers both a 400 (invalid slot) and any other unexpected non-2xx — same calm placeholder
    // either way; this page has no separate "bad slot" UI (AC3b's 400 is a developer-facing
    // contract, not a state this hand-authored, single-slot page's own nav ever produces).
    return {
      slot: params.slot,
      html: null,
      themeVars,
      actionsOrigin: undefined,
      actionEndpoint: undefined,
    } satisfies ExtensionPanelPageData
  }
}
