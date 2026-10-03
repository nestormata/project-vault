import type { ClientInit } from '@sveltejs/kit'

// A CM client hook contribution (Story 68-6).
export const init: ClientInit = () => {
  document.documentElement.dataset.cmInit = 'PV_HOOKS_CLIENT_MARKER_93d5c1'
}
