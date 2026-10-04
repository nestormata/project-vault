import { fail } from '@sveltejs/kit'

// Story 69.1: a contribution form action at the region point `project.detail.tiles`, exposed on the
// project page as `?/project.detail.tiles.ping`. SvelteKit runs form actions WITHOUT running the page
// `load`, so PV's notFound skip does not protect it: the action authorizes itself through the API. It
// first reads the project with the member's own session (RLS answers a foreign id exactly like a
// nonexistent one, 404) and only then writes through the pack's module route, which writes the audit
// row. A foreign or missing id therefore writes nothing and answers one and the same failure.
export const actions = {
  ping: async ({
    request,
    fetch,
    params,
  }: {
    request: Request
    fetch: typeof globalThis.fetch
    params: { projectId?: string }
  }) => {
    const form = await request.formData()
    const title = String(form.get('title') ?? '').trim()
    if (title === '') return fail(422, { error: 'empty' })
    const project = await fetch(`/api/v1/projects/${encodeURIComponent(params.projectId ?? '')}`)
    if (!project.ok) return fail(404, { error: 'not-found' })
    const response = await fetch('/api/v1/cm/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    return response.ok ? { saved: title } : fail(response.status, { error: 'rejected' })
  },
}
