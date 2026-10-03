// Story 68.6 AC-10/AC-12 — the ONE table of SvelteKit hooks the composition covers, per hooks file.
// `hook-surface.test.ts` enumerates the installed Kit's hooks from two independent sources and
// fails when this table is missing one (or lists one Kit no longer has). The pack script writes it
// to the web-host's `manifests/hooks-surface.json` for the composition kit.
export const HOOK_SURFACE = Object.freeze({
  server: Object.freeze(['handle', 'handleError', 'handleFetch', 'handleValidationError', 'init']),
  universal: Object.freeze(['reroute', 'transport']),
  client: Object.freeze(['handleError', 'init']),
})

export type HookSurfaceFile = keyof typeof HOOK_SURFACE

/** Non-Kit exports a server hook contribution may also define (consumed by the composition). */
export const SERVER_CONTRIBUTION_EXPORTS = Object.freeze(['headerPolicy'])
