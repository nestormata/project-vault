// Story 68.6 AC-1 — the three hook contribution virtual modules. In PV's own build they come from
// `apps/web/config/hooks-plugins.ts` (`emptyHooksModules()`: empty contributions); in a composed
// app the composition kit's `pvHooks()` plugin generates them from the UI pack. The kit ships the
// same structural shapes for CM authors (`PvHooksModule` / `PvServerHooksModule`).
declare module 'virtual:pv-hooks/server' {
  /** The CM server hook file's namespace (every export; only hook names and `headerPolicy` are
   * composed). */
  export const hooks: Readonly<Record<string, unknown>>
  /** Protected-path data the composer derived and read from the manifest (AC-8). */
  export const protectedPaths: {
    readonly routeIds: readonly string[]
    readonly add: readonly string[]
    readonly remove: readonly string[]
  }
}

declare module 'virtual:pv-hooks/universal' {
  export const hooks: Readonly<Record<string, unknown>>
}

declare module 'virtual:pv-hooks/client' {
  export const hooks: Readonly<Record<string, unknown>>
}
