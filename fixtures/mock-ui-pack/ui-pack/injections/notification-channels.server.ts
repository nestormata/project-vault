// A contribution `load` at `settings.notifications.channels` (Story 69.4): reads the pack's module
// route through the caller's own session and returns the row count, nothing else. The fault knob
// `?mock-p5-boom=1` makes it throw so the spec can prove how PV reports a failing contribution
// (the point and the error NAME only, never the message); it only ever makes the page fail.
export const load = async ({ fetch, url }: { fetch: typeof globalThis.fetch; url: URL }) => {
  if (url.searchParams.has('mock-p5-boom')) throw new TypeError('mock-ui-pack-secret-message')
  const documents = await fetch('/api/v1/cm/documents')
  if (!documents.ok) return {}
  const list = (await documents.json()) as { data?: { visibleProjectIds?: string[] } }
  return {
    marker: 'mock-ui-pack:m3-p5-settings.notifications.channels',
    rows: list.data?.visibleProjectIds?.length ?? 0,
  }
}
