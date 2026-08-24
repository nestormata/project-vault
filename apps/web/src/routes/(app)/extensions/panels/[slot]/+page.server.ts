import { getExtensionPanel } from '$lib/api/extension-panel.js'
import { getThemes } from '$lib/api/themes.js'
import { requireUser } from '$lib/server/require-user.js'
import { resolveAppliedThemeWithOrgDefault } from '$lib/theme/apply-theme.js'
import {
  BASE_EXTENSION_THEME_VARS,
  resolveExtensionThemeVars,
} from '$lib/security/extension-theme-vars.js'
import type { ExtensionThemeVars } from '$lib/security/extension-theme-vars.js'
import type { PageServerLoad } from './$types.js'

// Story 25.1 AC3: every degraded cause (throw, timeout, malformed result, permanently-absent
// hook, or a non-2xx from the API itself) renders the SAME calm "unavailable" state — this page
// never tries to distinguish them, matching the API route's own uniform degraded response.
export type ExtensionPanelPageData = {
  slot: string
  html: string | null
  themeVars: ExtensionThemeVars
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

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  // Defense in depth alongside auth-guard.ts's isProtectedAppPath redirect-to-login (AC1) — this
  // page is unreachable server-side without a resolved session either way.
  requireUser(locals)

  const themeVars = await resolveThemeVars(fetch)

  try {
    const result = await getExtensionPanel(fetch, params.slot)
    return {
      slot: params.slot,
      html: result.ok ? result.html : null,
      themeVars,
    } satisfies ExtensionPanelPageData
  } catch {
    // Covers both a 400 (invalid slot) and any other unexpected non-2xx — same calm placeholder
    // either way; this page has no separate "bad slot" UI (AC3b's 400 is a developer-facing
    // contract, not a state this hand-authored, single-slot page's own nav ever produces).
    return { slot: params.slot, html: null, themeVars } satisfies ExtensionPanelPageData
  }
}
