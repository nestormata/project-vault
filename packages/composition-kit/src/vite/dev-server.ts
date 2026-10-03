/** A node of Vite's per-environment module graph, as far as the kit's plugins read it. */
export interface ModuleNodeLike {
  id?: string | null
  file?: string | null
  importers?: ReadonlySet<ModuleNodeLike>
}

export interface ModuleGraphLike {
  idToModuleMap: ReadonlyMap<string, ModuleNodeLike>
  invalidateModule: (module: never) => void
}

/** The subset of Vite's dev server the kit's plugins use (Vite 8's `environments` API). */
export interface DevServerLike {
  watcher: {
    add: (paths: string | readonly string[]) => unknown
    on: (event: string, listener: (path: string) => void) => unknown
  }
  ws: { send: (payload: unknown) => void }
  environments: Record<string, { moduleGraph: ModuleGraphLike }>
}
