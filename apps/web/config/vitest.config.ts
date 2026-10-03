// Story 68.2 AC-3: PV's Vitest config as a factory, exported as
// `@project-vault/web-host/vitest.config`. PV's own apps/web/vitest.config.ts is a one-line call.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { sveltekit } from '@sveltejs/kit/vite'
import {
  configDefaults,
  coverageConfigDefaults,
  mergeConfig,
  type ViteUserConfig,
} from 'vitest/config'
import { emptyHooksModules } from './hooks-plugins.ts'
import { emptyInjectionModules, injectionEntries } from './injection-plugins.ts'
import { paraglideOptions } from './paths.ts'
import type { WebHostBuildOptions } from './vite.config.ts'

/** The coverage defaults of PV's private @project-vault/tsconfig/vitest.base, inlined because a
 * web-host consumer cannot install that workspace package. A test pins the two as equal. */
export const WEB_HOST_COVERAGE = {
  provider: 'v8' as const,
  reporter: ['text', 'html', 'clover', 'json', 'lcov'],
  // Vitest defaults this to false, which skips writing lcov.info whenever ANY test fails, so one
  // unrelated failure blanks SonarCloud's coverage-on-new-code signal for the whole package.
  reportOnFailure: true,
  thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
}

/** Story 68.9 AC-10: the PV tests a composed tree does not run (their subject was overridden,
 * replaced or removed), from `<composedRoot>/composition.lock.json`. A missing or unreadable lock
 * throws: running every PV test silently over a tree the lock does not describe proves nothing. A
 * lock written before the list existed excludes nothing. */
function lockedExclusions(composedRoot: string): string[] {
  const path = join(composedRoot, 'composition.lock.json')
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as { excludedPvTests?: unknown }
    return Array.isArray(lock.excludedPvTests) ? lock.excludedPvTests.map(String) : []
  } catch (error) {
    throw new Error(
      `cannot read ${path} (${(error as Error).message}); a composed tree needs its composition.lock.json`,
      { cause: error }
    )
  }
}

// Story 10.3: complete-source coverage instrumentation. `src/**/*.{ts,svelte}` is the canonical
// eligible-source pattern. Vitest's exported coverage defaults are extended, not replaced, and only
// the four reconciled exclusion categories are added, so no broad rule can neutralize production
// inclusion.
function webHostTestConfig(options: WebHostBuildOptions): ViteUserConfig {
  return {
    plugins: [
      paraglideVitePlugin(paraglideOptions(options.appRoot, options.composedRoot)),
      injectionEntries(),
      emptyInjectionModules(),
      emptyHooksModules({ composed: options.composedRoot !== undefined }),
      sveltekit(),
    ],
    resolve: { conditions: ['browser'] },
    test: {
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
      // Vitest's own defaults stay; only a composed tree adds the locked exclusions.
      ...(options.composedRoot === undefined
        ? {}
        : { exclude: [...configDefaults.exclude, ...lockedExclusions(options.composedRoot)] }),
      environment: 'jsdom',
      coverage: {
        ...WEB_HOST_COVERAGE,
        include: ['src/**/*.{ts,svelte}'],
        exclude: [
          ...coverageConfigDefaults.exclude,
          'src/**/*.test.ts',
          'src/**/*.d.ts',
          'src/lib/test/**',
          'src/**/*-test-helpers.ts',
        ],
      },
    },
  }
}

/** PV's Vitest config merged with the caller's (arrays such as `test.include` are appended). */
export function vitestConfig(
  overrides: ViteUserConfig = {},
  options: WebHostBuildOptions = {}
): ViteUserConfig {
  return mergeConfig(webHostTestConfig(options), overrides)
}
