import { coverageConfigDefaults, mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'
import { defineConfig } from 'vite'
import { sveltekit } from '@sveltejs/kit/vite'

// Story 10.3: complete-source coverage instrumentation. `src/**/*.{ts,svelte}` is the canonical
// eligible-source pattern (see the story's "Canonical eligible-source contract"). We extend
// Vitest's exported coverage defaults (`coverageConfigDefaults.exclude`, empty in Vitest 4.1.10)
// rather than replacing them, and add only the four reconciled exclusion categories so that no
// broad rule can silently neutralize production inclusion.
export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [sveltekit()],
    resolve: {
      conditions: ['browser'],
    },
    test: {
      include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
      environment: 'jsdom',
      coverage: {
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
  })
)
