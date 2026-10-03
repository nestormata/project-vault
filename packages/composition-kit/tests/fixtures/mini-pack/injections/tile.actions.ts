import { fail } from '@sveltejs/kit'

// A contribution form action (Story 68.4): exposed as `?/auth.register.after.share`.
export const actions = {
  share: async ({ request }: { request: Request }) => {
    const form = await request.formData()
    const note = String(form.get('note') ?? '')
    return note === '' ? fail(422, { error: 'empty' }) : { shared: note }
  },
}
