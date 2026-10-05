// A contribution `load` at `settings.audit.results` (Story 69.4, M3 region point). PV runs it for
// EVERY request to the page, including a caller PV decided to render as "not allowed", so it
// authorizes on its own (D3): it reads the caller's role through the authenticated `event.fetch`
// and returns nothing for a non-owner. The data comes from the pack's module route, read through
// the caller's own session (RLS and the route's security apply), and the pack's low-limit route
// answers 429 after a few loads, which the component renders as a status number.
export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  const me = await fetch('/api/v1/auth/me')
  const body = (await me.json()) as { data?: { orgRole?: string } }
  if (body.data?.orgRole !== 'owner') return {}
  const documents = await fetch('/api/v1/cm/documents')
  if (!documents.ok) return {}
  const list = (await documents.json()) as { data?: { visibleProjectIds?: string[] } }
  const limited = await fetch('/api/v1/cm/limited')
  return {
    marker: 'mock-ui-pack:m3-p5-settings.audit.results',
    rows: list.data?.visibleProjectIds?.length ?? 0,
    limitedStatus: limited.status,
  }
}
