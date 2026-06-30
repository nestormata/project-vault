import { redirect } from '@sveltejs/kit'
import { getOnboardingStatus } from '$lib/api/onboarding.js'
import { listProjects } from '$lib/api/projects.js'
import { getUsersMe } from '$lib/api/inbox.js'
import type { LayoutServerLoad } from './$types.js'

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
  }

  let unreadCount = 0
  try {
    const me = await getUsersMe(fetch)
    unreadCount = me.notifications?.unreadCount ?? 0
  } catch {
    unreadCount = 0
  }

  return {
    user: locals.user,
    onboardingCompleted,
    projects: projects.items,
    importRouteLive: ['owner', 'admin'].includes(locals.user.orgRole),
    unreadCount,
  }
}
