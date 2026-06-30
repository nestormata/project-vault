import { redirect } from '@sveltejs/kit'
import { getOnboardingStatus } from '$lib/api/onboarding.js'
import { listProjects } from '$lib/api/projects.js'
import type { LayoutServerLoad } from './$types.js'

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
  if (!locals.user) throw redirect(303, '/login')

  let onboardingCompleted = true
  try {
    const status = await getOnboardingStatus(fetch)
    onboardingCompleted = status.completed === true
  } catch {
    // Fail-open: transient onboarding API errors must not trap users in the wizard.
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

  return {
    user: locals.user,
    onboardingCompleted,
    projects: projects.items,
    importRouteLive: ['owner', 'admin'].includes(locals.user.orgRole),
  }
}
