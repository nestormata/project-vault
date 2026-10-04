import { fail } from '@sveltejs/kit'

// A contribution form action (M3): exposed as `?/settings.home.after.document`. It posts through
// PV's own `event.fetch` (the session cookie rides along) to the pack's module route, so the real API
// applies its security pipeline and writes its audit row.
export const actions = {
  document: async ({ request, fetch }: { request: Request; fetch: typeof globalThis.fetch }) => {
    const form = await request.formData()
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return fail(422, { error: 'empty' })
    const response = await fetch('/api/v1/cm/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    return response.ok ? { saved: title } : fail(response.status, { error: 'rejected' })
  },
}
