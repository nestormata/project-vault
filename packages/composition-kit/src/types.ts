// The UI-pack manifest (design section 4). Fields are optional except `host`. Every list in this
// shape is illustrative of what a pack may contain, never a list of what it may not.

/** An override of a file that exists in web-host. `hostSha256` is the PV file's hash at the time
 * the override was written. `story` is recorded context only: a missing one is informational. */
export interface RouteOverride {
  path: string
  hostSha256: string
  story?: string
}

export interface InjectionContribution {
  component: string
  order?: number
  /** Optional server data for the point (Story 68-4 applies it). */
  load?: string
  /** Optional form actions for the point (Story 68-4 applies it). */
  actions?: string
}

export interface Replacement {
  with: string
  hostSha256: string
  story?: string
}

export interface HooksContribution {
  server?: string
  universal?: string
  client?: string
}

export interface UiPackManifest {
  host: { pvRelease: string }
  routes?: {
    overrides?: RouteOverride[]
    /** Route ids (`/(app)/extensions/panels`), files (`src/...`) or static assets (`static/...`). */
    remove?: string[]
  }
  injections?: Record<string, InjectionContribution[]>
  replacements?: Record<string, Replacement>
  hooks?: HooksContribution
  nav?: string
  theme?: string
  /** A directory (relative to the pack root) of `<locale>.json` message overlays. */
  messages?: string
  protectedPaths?: { add?: string[]; remove?: string[] }
  /** Story 68.9: a data module (path in the pack) with this pack's guard entries, authored with
   * `defineGuardEntries()`. Optional: a pack that needs no carve-out has none. */
  guards?: string
}

/** Story 68.6: the shape of `virtual:pv-hooks/universal` and `virtual:pv-hooks/client` (web-host
 * declares the same structural shape; a contract test keeps the two assignable both ways). */
export interface PvHooksModule {
  readonly hooks: Readonly<Record<string, unknown>>
}

/** Story 68.6: the shape of `virtual:pv-hooks/server`. */
export interface PvServerHooksModule extends PvHooksModule {
  readonly protectedPaths: {
    readonly routeIds: readonly string[]
    readonly add: readonly string[]
    readonly remove: readonly string[]
  }
}

/** Identity at runtime, typed at compile time. */
export function defineUiPack(pack: UiPackManifest): UiPackManifest {
  return pack
}

/** The compatibility tuple a web-host release was built with (manifests/compatibility.json). */
export interface CompatibilityTuple {
  schemaVersion: number
  pvRelease: string
  extensionApiVersion: string
  kitVersion: string
  toolchain: { kit: string; svelte: string; vite: string; typescript: string }
  apiImageTag: string
}
