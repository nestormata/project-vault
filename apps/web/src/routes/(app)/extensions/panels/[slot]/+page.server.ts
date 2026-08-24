import { getExtensionPanel } from '$lib/api/extension-panel.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Story 25.1 AC3: every degraded cause (throw, timeout, malformed result, permanently-absent
// hook, or a non-2xx from the API itself) renders the SAME calm "unavailable" state — this page
// never tries to distinguish them, matching the API route's own uniform degraded response.
export type ExtensionPanelPageData = { slot: string; html: string | null }

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  // Defense in depth alongside auth-guard.ts's isProtectedAppPath redirect-to-login (AC1) — this
  // page is unreachable server-side without a resolved session either way.
  requireUser(locals)

  try {
    const result = await getExtensionPanel(fetch, params.slot)
    return {
      slot: params.slot,
      html: result.ok ? result.html : null,
    } satisfies ExtensionPanelPageData
  } catch {
    // Covers both a 400 (invalid slot) and any other unexpected non-2xx — same calm placeholder
    // either way; this page has no separate "bad slot" UI (AC3b's 400 is a developer-facing
    // contract, not a state this hand-authored, single-slot page's own nav ever produces).
    return { slot: params.slot, html: null } satisfies ExtensionPanelPageData
  }
}
