import { redirect } from '@sveltejs/kit'
import { getOnboardingStatus } from '$lib/api/onboarding.js'
import { listProjects } from '$lib/api/projects.js'
import { getUsersMe } from '$lib/api/inbox.js'
import { getThemes } from '$lib/api/themes.js'
import { isOrphaned, resolveAppliedThemeWithOrgDefault } from '$lib/theme/apply-theme.js'
import type { LayoutServerLoad } from './$types.js'

type ThemeLoadResult = {
  appliedTheme: string | null
  orphanedNotice: boolean
  orphanedThemeName: string | null
  themeCss: string
}

const FAILED_THEME_LOAD: ThemeLoadResult = {
  appliedTheme: null,
  orphanedNotice: false,
  orphanedThemeName: null,
  themeCss: '',
}

// Story 16.2 AC-2/AC-3/AC-6: re-checked fresh on every layout load (never cached in the
// session/JWT) so a selection change on another tab/device is picked up on this page's next
// navigation, and an admin removing the caller's selected theme is detected live rather than
// sticking around as a stale flag. Fails open to the base theme (never blocks product access) if
// the themes fetch itself fails, same "fail-open" convention as onboarding/projects below.
async function resolveThemeLoad(fetchFn: typeof fetch): Promise<ThemeLoadResult> {
  try {
    const themesResponse = await getThemes(fetchFn)
    const availableThemeNames = themesResponse.themes.map((theme) => theme.name)
    // Story 16.4 AC-2's own edge case: the orphaned-selection *notice* is still keyed off the
    // personal selection alone (a member never chose the org default themselves, so a notice
    // about a setting they don't control would be noise — see the story's Dev Notes) — only the
    // *applied theme* resolution itself (below) additionally falls through to the org default.
    const orphanedNotice = isOrphaned(themesResponse.selected, availableThemeNames)
    return {
      appliedTheme: resolveAppliedThemeWithOrgDefault(
        themesResponse.selected,
        themesResponse.orgDefaultThemeName,
        availableThemeNames
      ),
      orphanedNotice,
      orphanedThemeName: orphanedNotice ? themesResponse.selected : null,
      themeCss: themesResponse.themes
        .map((theme) => theme.css)
        .filter((css): css is string => Boolean(css))
        .join('\n'),
    }
  } catch {
    return FAILED_THEME_LOAD
  }
}

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
  if (!locals.user) throw redirect(303, '/login')

  let onboardingCompleted = true
  try {
    const status = await getOnboardingStatus(fetch)
    onboardingCompleted = status.completed === true
  } catch {
    onboardingCompleted = true
  }

  let projects = { items: [] as Awaited<ReturnType<typeof listProjects>>['items'], total: 0 }
  if (!onboardingCompleted) {
    try {
      projects = await listProjects(fetch)
    } catch {
      projects = { items: [], total: 0 }
    }
    // AC-8: the wizard's auto-launch gate is "does this org have any projects", not "has this
    // specific user personally completed onboarding" — a second admin/owner joining an org that
    // already has ≥1 project should never see the wizard, even though their own per-user
    // onboarding row doesn't exist yet. An org with 0 projects still gates on the per-user flag
    // (a newly joining member should see the wizard if the org genuinely has no project yet).
    if (projects.total > 0) onboardingCompleted = true
  }

  let unreadCount = 0
  try {
    const me = await getUsersMe(fetch)
    unreadCount = me.notifications?.unreadCount ?? 0
  } catch {
    unreadCount = 0
  }

  const themeLoad = await resolveThemeLoad(fetch)

  return {
    user: locals.user,
    onboardingCompleted,
    projects: projects.items,
    importRouteLive: ['owner', 'admin'].includes(locals.user.orgRole),
    unreadCount,
    ...themeLoad,
  }
}
