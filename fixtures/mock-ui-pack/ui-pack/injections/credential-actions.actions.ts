import { fail } from '@sveltejs/kit'

// Story 69.2: a contribution form action at the region point `credential.detail.actions`, exposed on
// the credential page as `?/credential.detail.actions.note`. SvelteKit runs form actions WITHOUT
// running the page `load`, so PV's notFound/vaultSealed skip does not protect it: the action
// authorizes itself through the API. It first reads the credential and the project with the member's
// own session (RLS answers a foreign id exactly like a nonexistent one, 404), decides the caller's
// project role from THAT answer (never from a posted field), and only then writes through the pack's
// module route, which writes the audit row.
export const actions = {
  note: async ({
    request,
    fetch,
    params,
  }: {
    request: Request
    fetch: typeof globalThis.fetch
    params: { projectId?: string; credentialId?: string }
  }) => {
    const form = await request.formData()
    const note = String(form.get('note') ?? '').trim()
    if (note === '') return fail(422, { error: 'empty' })
    const projectId = encodeURIComponent(params.projectId ?? '')
    const credentialId = encodeURIComponent(params.credentialId ?? '')
    const credential = await fetch(`/api/v1/projects/${projectId}/credentials/${credentialId}`)
    if (!credential.ok) return fail(404, { error: 'not-found' })
    const project = await fetch(`/api/v1/projects/${projectId}`)
    if (!project.ok) return fail(404, { error: 'not-found' })
    const role = ((await project.json()) as { data?: { role?: string } }).data?.role
    if (role === 'viewer') return fail(403, { error: 'viewer-denied' })
    const response = await fetch('/api/v1/cm/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: note }),
    })
    return response.ok ? { saved: note } : fail(response.status, { error: 'rejected' })
  },
}
