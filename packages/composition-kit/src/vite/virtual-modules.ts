// The virtual-module registry of the kit's Vite plugins: each plugin registers the id prefix of
// the modules it serves (`virtual:pv-inject/`; 68-5 and 68-7 add theirs), and a manifest change
// invalidates every registered module in both module graphs.
const virtualPrefixes = new Set<string>()

/** Registers a virtual module id prefix (for example `virtual:pv-inject/`) so a manifest change
 * invalidates every module under it, in both the client and the SSR module graphs. */
export function registerVirtualModulePrefix(prefix: string): void {
  virtualPrefixes.add(prefix)
}

export interface ModuleGraphLike {
  idToModuleMap: Map<string, unknown>
  invalidateModule: (module: never) => void
}

/** The subset of Vite's dev server the plugin uses (Vite 8's `environments` API). */
export interface DevServerLike {
  watcher: {
    add: (paths: string | readonly string[]) => unknown
    on: (event: string, listener: (path: string) => void) => unknown
  }
  ws: { send: (payload: unknown) => void }
  environments: Record<string, { moduleGraph: ModuleGraphLike }>
}

/** Invalidates every registered virtual module in the `client` and `ssr` environments' module
 * graphs (`server.environments.<env>.moduleGraph`, not the legacy `server.moduleGraph` alone). */
export function invalidateVirtualModules(server: DevServerLike): void {
  const prefixes = [...virtualPrefixes].flatMap((prefix) => [prefix, `\0${prefix}`])
  const environments = new Map(Object.entries(server.environments))
  for (const name of ['client', 'ssr']) {
    const graph = environments.get(name)?.moduleGraph
    if (graph === undefined) continue
    for (const [id, module] of graph.idToModuleMap) {
      if (prefixes.some((prefix) => id.startsWith(prefix))) graph.invalidateModule(module as never)
    }
  }
}
