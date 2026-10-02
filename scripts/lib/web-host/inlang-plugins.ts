// Story 68.2 AC-5: the inlang (Paraglide) plugins are exact-pinned npm packages loaded from local
// files, never fetched from a CDN, so message compilation is offline and reproducible. Pure rules,
// shared by scripts/check-paraglide-plugin-pinned.test.ts and scripts/pack-web-host.ts.

export interface PluginPin {
  /** The exact devDependency version of apps/web. */
  version: string
  /** The module path settings.json loads in PV's workspace (relative to apps/web). */
  module: string
  /** Where the packed web-host carries a copy (relative to the package root). */
  packedAs: string
  /** sha256 of the plugin file. */
  sha256: string
}

/** apps/web/inlang-plugins/plugins.lock.json: package name -> pin. */
export type PluginLock = Record<string, PluginPin>

export interface InlangSettings {
  modules?: string[]
  [key: string]: unknown
}

export const PLUGIN_UPGRADE_HINT =
  'Fix: pin the plugin as an exact apps/web devDependency and update ' +
  'apps/web/inlang-plugins/plugins.lock.json (steps in apps/web/inlang-plugins/README.md).'

function pinFor(lock: PluginLock, module: string): [string, PluginPin] | undefined {
  return Object.entries(lock).find(([, pin]) => pin.module === module)
}

function modulePinProblems(
  entry: string,
  lock: PluginLock,
  devDependencies: Readonly<Record<string, string>>,
  fileSha256: (pluginPackage: string) => string | undefined
): string[] {
  if (/^https?:\/\//i.test(entry) || entry.includes('@latest')) {
    return [
      `${entry}: a module must be a local file, never a URL or @latest. ${PLUGIN_UPGRADE_HINT}`,
    ]
  }
  const found = pinFor(lock, entry)
  if (found === undefined)
    return [`${entry}: not pinned in plugins.lock.json. ${PLUGIN_UPGRADE_HINT}`]
  const [name, pin] = found
  const declared = Object.entries(devDependencies).find(([dependency]) => dependency === name)?.[1]
  const problems: string[] = []
  if (declared !== pin.version) {
    problems.push(
      `${name}: apps/web declares ${declared ?? 'nothing'}, the pin is exactly ${pin.version}. ${PLUGIN_UPGRADE_HINT}`
    )
  }
  const actual = fileSha256(name)
  if (actual !== pin.sha256) {
    problems.push(
      `${entry}: sha256 ${actual ?? '(file missing)'} does not match the pinned ${pin.sha256} ` +
        `(${name} ${pin.version}). ${PLUGIN_UPGRADE_HINT}`
    )
  }
  return problems
}

/** Every pin violation of PV's settings.json. `fileSha256` hashes a plugin package's module. */
export function pluginPinProblems(
  settings: InlangSettings,
  lock: PluginLock,
  devDependencies: Readonly<Record<string, string>>,
  fileSha256: (pluginPackage: string) => string | undefined
): string[] {
  const modules = settings.modules ?? []
  if (modules.length === 0) {
    return ['settings.json has no `modules`: the message-format plugin is missing']
  }
  return modules.flatMap((entry) => modulePinProblems(entry, lock, devDependencies, fileSha256))
}

/** settings.json as packed: every module points at the plugin copy inside the package. */
export function packedSettings(settings: InlangSettings, lock: PluginLock): InlangSettings {
  return {
    ...settings,
    modules: (settings.modules ?? []).map((entry) => {
      const found = pinFor(lock, entry)
      if (found === undefined) throw new Error(`${entry}: not pinned in plugins.lock.json`)
      return found[1].packedAs
    }),
  }
}
