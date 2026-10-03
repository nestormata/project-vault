// Story 68.2 AC-3: PV's Vite config as a factory, exported as `@project-vault/web-host/vite.config`.
// PV's own apps/web/vite.config.ts is a one-line call.
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { mergeConfig, type PluginOption, type UserConfig } from 'vite'
import { emptyHooksModules } from './hooks-plugins.ts'
import { paraglideOptions } from './paths.ts'

export interface WebHostBuildOptions {
  /** The app being built: compiled Paraglide messages go into `<appRoot>/src/lib/paraglide`.
   * Defaults to the working directory, which is where Vite and SvelteKit look for the app. */
  appRoot?: string
  /** A composed app's root (Story 68.3): the inlang project is read from its composed copy. */
  composedRoot?: string
}

/** PV's plugins, in PV's order: Tailwind, then the Paraglide compiler (Story 15.1, compiles
 * project.inlang + messages/{locale}.json into typesafe message functions), then PV's empty
 * providers for the composition virtual modules (Story 68.6: `virtual:pv-hooks/*`), then
 * SvelteKit last. */
export function webHostPlugins(options: WebHostBuildOptions = {}): PluginOption[] {
  return [
    tailwindcss(),
    paraglideVitePlugin(paraglideOptions(options.appRoot, options.composedRoot)),
    emptyHooksModules({ composed: options.composedRoot !== undefined }),
    sveltekit(),
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
