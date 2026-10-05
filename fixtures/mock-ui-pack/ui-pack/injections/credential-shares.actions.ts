import { fail } from '@sveltejs/kit'

// Story 69.2: a contribution form action at the region point `credential.detail.shares`, exposed as
// `?/credential.detail.shares.probe`. It calls the pack's rate-limited module route
// (`GET /api/v1/cm/limited`, three calls a minute) through PV's `event.fetch`, so the real API's 429
// reaches the action result and the page re-renders with a FRESH load (the shape CM's 16-10 needs PV
// to carry for a rate-limited share action).
export const actions = {
  probe: async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
    const response = await fetch('/api/v1/cm/limited')
    return response.ok ? { ok: true } : fail(response.status, { error: String(response.status) })
  },
}
