import { countCall } from '$lib/server/cm-counter.js'

// Story 68-15: runs only after PV's own load finished (a PV error or redirect short-circuits it).
export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  await countCall(fetch, 'inject-load-guarded')
  return { guarded: true }
}
