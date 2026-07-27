import { fail } from '@sveltejs/kit'
import { isSupportedLocale } from '@project-vault/shared'
import { getUsersMe } from '$lib/api/inbox.js'
import { patchUserLocale } from '$lib/api/locale.js'
import { requireUser } from '$lib/server/require-user.js'
import { buildLocaleOptions } from './locale-settings-model.js'
import type { Actions, PageServerLoad } from './$types.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  requireUser(locals)
  const me = await getUsersMe(fetch)
  return { options: buildLocaleOptions(me.locale) }
}

export const actions: Actions = {
  updateLocale: async ({ request, fetch }) => {
    const data = await request.formData()
    const locale = String(data.get('locale'))

    if (!isSupportedLocale(locale)) {
      return fail(422, { error: 'Unsupported locale' })
    }

    try {
      const result = await patchUserLocale(fetch, locale)
      return { success: true, locale: result.locale }
    } catch {
      return fail(422, { error: 'Failed to update language preference' })
    }
  },
}
