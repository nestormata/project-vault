import { getThemes, type ThemeListItem } from '$lib/api/themes.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

const GENERIC_FETCH_ERROR = 'Failed to load themes, try again.'

export type ThemesPageData = {
  themes: ThemeListItem[]
  selected: string | null
  errorMessage: string | null
}

// Story 16.2 Dev Notes — this page mirrors `(app)/settings/language/`'s structure (a personal
// preference, no role-gate) rather than `sso-domains`/`extensions`'s OrgAdmin-gated pattern: every
// authenticated org member, including a viewer, may select their own theme (AC-5).
export const load: PageServerLoad = async ({ fetch, locals }): Promise<ThemesPageData> => {
  requireUser(locals)

  try {
    const response = await getThemes(fetch)
    return { themes: response.themes, selected: response.selected, errorMessage: null }
  } catch {
    return { themes: [], selected: null, errorMessage: GENERIC_FETCH_ERROR }
  }
}
