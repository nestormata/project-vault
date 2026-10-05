import { fail } from '@sveltejs/kit'

// A contribution form action at `project.members.access` (Story 69.4): exposed as
// `?/project.members.access.touch`. It posts through PV's own `event.fetch` to the pack's module
// route, so the real API applies its security pipeline and writes exactly one audit row.
export const actions = {
  touch: async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
    const response = await fetch('/api/v1/cm/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'mock-ui-pack:m3-p5-touch' }),
    })
    return response.ok ? { touched: true } : fail(response.status, { error: 'rejected' })
  },
}
