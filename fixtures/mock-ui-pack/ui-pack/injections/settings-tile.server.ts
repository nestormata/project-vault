// A contribution `load` (M3): runs after PV's own load with the same RequestEvent. It reads the
// signed-in user through the authenticated `event.fetch` and can probe another resource id
// (`?mock-probe=<id>`) so the spec can prove the real API's tenant isolation: another org's id is
// answered exactly like a nonexistent one (404), and the tile renders the status without a 500.
export const load = async ({ fetch, url }: { fetch: typeof globalThis.fetch; url: URL }) => {
  const me = await fetch('/api/v1/auth/me')
  const body = (await me.json()) as { data?: { userId?: string } }
  const probe = url.searchParams.get('mock-probe')
  const probed =
    probe === null ? null : await fetch(`/api/v1/projects/${encodeURIComponent(probe)}`)
  return { who: body.data?.userId ?? null, probeStatus: probed?.status ?? null }
}
