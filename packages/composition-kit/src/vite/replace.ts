import { join, resolve } from 'node:path'
import type { Plugin, Rollup } from 'vite'
import { REPLACEMENT_MAP_PATH } from '../replacement-map.js'
import type { DevServerLike, ModuleNodeLike } from './dev-server.js'
import { createComposeQueue } from './queue.js'
import { resolveOriginalFile } from './resolve-original.js'
import {
  isInside,
  loadReplacementMap,
  normalizeFsPath,
  realPathOf,
  type LoadedMap,
  type ResolvedReplacement,
} from './replace-map.js'

/** The specifier prefix that reaches PV's file without the replacement applied (design section 6). */
export const PV_ORIGINAL_PREFIX = 'pv-original:'
const DEFAULT_DEBOUNCE_MS = 100
const PLUGIN_NAME = 'pv-replace'

export interface PvReplaceOptions {
  /** The composed app root (where `pv-compose` wrote `src/` and `.pv-compose/`). */
  appRoot: string
  /** Defaults to `<appRoot>/composition.lock.json`; read only to cross-check the map. */
  lockPath?: string
  /** Quiet period before a changed map is reloaded in dev (default 100 ms). */
  debounceMs?: number
}

type Context = Rollup.PluginContext
type ResolveOptions = Parameters<Context['resolve']>[2]

/** `this.resolve` with `skipSelf` skips only this plugin's own call, not the nested resolves other
 * plugins start (Vite's alias plugin re-issues `$lib/x` as an absolute path through the whole
 * pipeline, this plugin included), so the answer may already be the replacement; callers accept
 * both. No decision travels in `custom`: Rolldown 1.2.x numbers each call's saved options by the
 * size of its map of in-flight calls, so two concurrent calls can share a number and one receives
 * the other's `custom`. A "leave this alone" flag sent that way once reached SvelteKit's guard on
 * an unrelated import, which then recorded PV's file instead of CM's replacement and failed a
 * client import of a replaced `$lib/server` module with "An impossible situation occurred". */
function plainResolve(
  context: Context,
  id: string,
  importer: string | undefined,
  options: ResolveOptions
) {
  return context.resolve(id, importer, { ...options, skipSelf: true })
}

/** Splits `file.svelte?svelte&type=style#x` into the path and its `?query#hash` suffix. */
function splitId(id: string): { path: string; suffix: string } {
  const cut = id.search(/[?#]/)
  return cut === -1
    ? { path: normalizeFsPath(id), suffix: '' }
    : { path: normalizeFsPath(id.slice(0, cut)), suffix: id.slice(cut) }
}

function isVirtualId(id: string): boolean {
  return id.startsWith('\0') || id.startsWith('virtual:')
}

/** vite-plugin-svelte asks for `<file>.svelte?svelte&type=style&lang.css`: that is the compiled
 * output of the file that was loaded, never a new import of it, so it is not mapped. */
function isSvelteSubRequest(suffix: string): boolean {
  return suffix.startsWith('?') && /(?:^|&)svelte(?:&|=|$)/.test(suffix.slice(1))
}

/** O(1) lookups of the replacement for a resolved id. Keys are real, forward-slash paths. */
class ReplacementTable {
  private readonly byHost = new Map<string, string>()
  private readonly real = new Map<string, string>()

  /** CM's file -> PV's file, or null when one CM file replaces several PV files. */
  private readonly byWith = new Map<string, string | null>()

  constructor(readonly entries: readonly ResolvedReplacement[]) {
    for (const entry of entries) {
      this.byHost.set(entry.host, entry.with)
      this.byWith.set(entry.with, this.byWith.has(entry.with) ? null : entry.host)
    }
  }

  private realOf(path: string): string {
    const known = this.real.get(path)
    if (known !== undefined) return known
    const real = realPathOf(path)
    this.real.set(path, real)
    return real
  }

  /** CM's file for a resolved id (its query and hash kept), or undefined. */
  replacementFor(id: string): string | undefined {
    if (isVirtualId(id)) return undefined
    const { path, suffix } = splitId(id)
    if (isSvelteSubRequest(suffix)) return undefined
    const target = this.byHost.get(path) ?? this.byHost.get(this.realOf(path))
    return target === undefined ? undefined : `${target}${suffix}`
  }

  /** Whether a resolved id is one of CM's replacement files (a nested resolve already mapped it). */
  isReplacement(id: string): boolean {
    if (isVirtualId(id)) return false
    const { path, suffix } = splitId(id)
    if (isSvelteSubRequest(suffix)) return false
    return this.byWith.has(path) || this.byWith.has(this.realOf(path))
  }

  /** PV's file for a resolved id that is CM's replacement (its query and hash kept): the id itself
   * when it is not a replacement, undefined when the replacement stands for several PV files. */
  originalOf(id: string): string | undefined {
    if (!this.isReplacement(id)) return id
    const { path, suffix } = splitId(id)
    const host = this.byWith.get(path) ?? this.byWith.get(this.realOf(path))
    return host === null || host === undefined ? undefined : `${host}${suffix}`
  }
}

function entryKey(entry: ResolvedReplacement): string {
  return `${entry.host}\0${entry.with}`
}

/** The files whose importers must re-resolve: both sides of every added, removed or retargeted entry. */
function changedFiles(
  before: readonly ResolvedReplacement[],
  after: readonly ResolvedReplacement[]
) {
  const was = new Set(before.map(entryKey))
  const now = new Set(after.map(entryKey))
  const changed = new Set<string>()
  for (const entry of [...before, ...after]) {
    if (was.has(entryKey(entry)) !== now.has(entryKey(entry))) {
      changed.add(entry.host)
      changed.add(entry.with)
    }
  }
  return changed
}

/** Invalidates the modules of `files` and their importers in every environment's graph (a module
 * absent from a graph is simply not there). */
function invalidateImporters(server: DevServerLike, files: ReadonlySet<string>): void {
  for (const { moduleGraph } of Object.values(server.environments)) {
    const nodes = new Set<ModuleNodeLike>()
    for (const node of moduleGraph.idToModuleMap.values()) {
      const path = splitId(node.file ?? node.id ?? '').path
      if (!files.has(path)) continue
      nodes.add(node)
      for (const importer of node.importers ?? []) nodes.add(importer)
    }
    for (const node of nodes) moduleGraph.invalidateModule(node as never)
  }
}

async function resolveOriginal(
  context: Context,
  table: ReplacementTable,
  appRoot: string,
  source: string,
  importer: string | undefined,
  options: ResolveOptions
): Promise<Rollup.ResolveIdResult> {
  const unresolved = (): never =>
    context.error(`pv-replace: cannot resolve "${source}" from ${importer ?? '(entry)'}`)
  const rest = source.slice(PV_ORIGINAL_PREFIX.length)
  if (rest === '') return unresolved()
  const src = join(realPathOf(appRoot), 'src')
  const outside = (): never =>
    context.error(
      `pv-replace: "${source}" resolves outside ${src}; pv-original: reaches PV's own files under src/ only.`
    )
  const local = resolveOriginalFile(rest, importer, appRoot)
  if (local.kind === 'outside') return outside()
  // Exactly PV's file, bypassing the map, straight from disk.
  if (local.kind === 'file') return { id: local.id }
  const resolved = await plainResolve(context, rest, importer, options)
  if (resolved === null) return unresolved()
  // The pipeline may have applied the map itself: PV's file is the one CM's replacement stands for.
  const id = table.originalOf(resolved.id)
  if (id === undefined) return unresolved()
  if (!isInside(src, realPathOf(splitId(id).path))) return outside()
  // Otherwise returned UNCHANGED: exactly PV's file, bypassing the map.
  return id === resolved.id ? resolved : { ...resolved, id }
}

/** Design section 6 (M4): shadows a module by its RESOLVED absolute path, not by specifier text
 * (`resolve.alias` would miss a relative or aliased import of the same file). List it AFTER PV's
 * plugins (`sveltekit()`'s import guard must see each import before this plugin answers it), which
 * is where `viteConfig({ plugins: [pvReplace()] })` puts it, and, to run PV's unit tests over the
 * same replacements, in the vitest plugins too.
 * Nothing is gated: any module under `src/` may be replaced, stable or not. */
export function pvReplace(options: PvReplaceOptions): Plugin {
  const appRoot = resolve(options.appRoot)
  const mapPath = join(appRoot, REPLACEMENT_MAP_PATH)
  const source = {
    appRoot,
    mapPath,
    ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
  }
  let table: ReplacementTable | undefined
  let logged = false

  const load = (context: Context): ReplacementTable => {
    let loaded: LoadedMap
    try {
      loaded = loadReplacementMap(source)
    } catch (error) {
      return context.error((error as Error).message)
    }
    table = new ReplacementTable(loaded.entries)
    return table
  }

  return {
    name: PLUGIN_NAME,
    enforce: 'pre',
    buildStart() {
      const loaded = load(this as Context)
      if (logged) return
      logged = true
      this.info(`pv-replace: ${loaded.entries.length} replacements applied`)
    },
    async resolveId(this: Context, id, importer, resolveOptions) {
      const current = table ?? load(this)
      if (id.startsWith(PV_ORIGINAL_PREFIX)) {
        return resolveOriginal(this, current, appRoot, id, importer, resolveOptions)
      }
      if (isVirtualId(id)) return null
      const resolved = await plainResolve(this, id, importer, resolveOptions)
      // `external` is `false` in a build and absent in a dev server: only a truthy one is external.
      if (resolved === null || resolved.external) return null
      // A nested resolve that already mapped the import answers with the replacement: keep it.
      if (current.isReplacement(resolved.id)) return resolved
      const replacement = current.replacementFor(resolved.id)
      return replacement === undefined ? null : { id: replacement }
    },
    configureServer(server: unknown) {
      const dev = server as DevServerLike
      const report = (message: string): void => {
        dev.ws.send({ type: 'error', err: { message, stack: '' } })
      }
      const reload = (): void => {
        let next: LoadedMap
        try {
          next = loadReplacementMap(source)
        } catch (error) {
          // The previous map stays in force until a good one arrives.
          return report((error as Error).message)
        }
        const files = changedFiles(table?.entries ?? [], next.entries)
        table = new ReplacementTable(next.entries)
        if (files.size === 0) return
        invalidateImporters(dev, files)
        dev.ws.send({ type: 'full-reload' })
      }
      const queue = createComposeQueue({
        debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        run: () => Promise.resolve(reload()),
      })
      dev.watcher.add(mapPath)
      for (const event of ['add', 'change', 'unlink']) {
        dev.watcher.on(event, (path: string) => {
          if (resolve(path) === mapPath) queue.schedule(path)
        })
      }
    },
  }
}
