import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'
import { defineConfig } from 'vite'
import { sveltekit } from '@sveltejs/kit/vite'

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [sveltekit()],
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'jsdom',
      coverage: {
        // Coverage for web app will be set up when real UI components are added in Story 1.6+
        // For Story 1.1 scaffold, coverage is disabled (no testable source yet)
        exclude: ['**/*'],
        thresholds: {
          lines: 0,
          branches: 0,
          functions: 0,
          statements: 0,
        },
      },
    },
  })
)
