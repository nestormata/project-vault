// Story 68.2 AC-3: PV's SvelteKit config as a factory, exported as
// `@project-vault/web-host/svelte.config`. PV's own apps/web/svelte.config.js is a one-line call.
import adapterNode from '@sveltejs/adapter-node'
import type { Adapter, Config, KitConfig } from '@sveltejs/kit'
import { sharedAliases } from './paths.ts'

export interface SvelteConfigOptions {
  /** Replaces adapter-node. Nothing else changes. */
  adapter?: Adapter
  /** Extra aliases, merged after (and so able to override) PV's shared aliases. */
  alias?: Record<string, string>
  /** Any other Kit option, merged into PV's. */
  kit?: Omit<KitConfig, 'adapter' | 'alias'>
}

export function svelteConfig(options: SvelteConfigOptions = {}): Config {
  return {
    kit: {
      ...options.kit,
      adapter: options.adapter ?? adapterNode(),
      // Story 43.16: node-only subpath exports are listed before the package root so they win.
      alias: { ...sharedAliases(), ...options.alias },
    },
  }
}
