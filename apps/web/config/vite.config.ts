// Story 68.2 AC-3: PV's Vite config as a factory, exported as `@project-vault/web-host/vite.config`.
// PV's own apps/web/vite.config.ts is a one-line call.
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { mergeConfig, type PluginOption, type UserConfig } from 'vite'
import { emptyHooksModules } from './hooks-plugins.ts'
import { emptyInjectionModules, injectionEntries } from './injection-plugins.ts'
import { emptyNavModule } from './nav-plugins.ts'
import { paraglideOptions } from './paths.ts'

export interface WebHostBuildOptions {
  /** The app being built: compiled Paraglide messages go into `<appRoot>/src/lib/paraglide`.
   * Defaults to the working directory, which is where Vite and SvelteKit look for the app. */
  appRoot?: string
  /** A composed app's root (Story 68.3): the inlang project is read from its composed copy. */
  composedRoot?: string
}

/** PV's plugins, in PV's order: Tailwind, then the Paraglide compiler (Story 15.1, compiles
 * project.inlang + messages/{locale}.json into typesafe message functions), then the injection
 * point transform and PV's empty answer to the injection virtual modules (Story 68.4; a composition
 * kit's own plugin runs `enforce: 'pre'` and wins), then PV's empty providers for the hooks
 * virtual modules (Story 68.6: `virtual:pv-hooks/*`, failing closed on a composed tree), then
 * PV's empty nav delta (Story 68.7: `virtual:pv-nav`, failing closed the same way), then SvelteKit. */
export function webHostPlugins(options: WebHostBuildOptions = {}): PluginOption[] {
  return [
    tailwindcss(),
    paraglideVitePlugin(paraglideOptions(options.appRoot, options.composedRoot)),
    ...compositionProviders(options),
    sveltekit(),
  ]
}

/** PV's own answers to the composition virtual modules (injection points, hooks, nav), in that
 * order, shared by the build and the test config. On a composed tree each refuses to build without
 * the composition kit's plugin. */
export function compositionProviders(options: WebHostBuildOptions = {}): PluginOption[] {
  const composed = options.composedRoot !== undefined
  return [
    injectionEntries(),
    emptyInjectionModules(),
    emptyHooksModules({ composed }),
    emptyNavModule({ composed }),
  ]
}

/** PV's Vite config merged with the caller's: arrays (plugins) are appended after PV's, objects
 * (resolve.alias, server, ...) are merged. */
export function viteConfig(
  overrides: UserConfig = {},
  options: WebHostBuildOptions = {}
): UserConfig {
  return mergeConfig<UserConfig, UserConfig>({ plugins: webHostPlugins(options) }, overrides)
}
