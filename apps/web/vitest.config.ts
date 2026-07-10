import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'
import { defineConfig } from 'vite'
import { sveltekit } from '@sveltejs/kit/vite'

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [sveltekit()],
    resolve: {
      conditions: ['browser'],
    },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'jsdom',
    },
  })
)
