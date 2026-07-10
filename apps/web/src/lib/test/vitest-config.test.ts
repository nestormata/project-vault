// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { coverageConfigDefaults } from 'vitest/config'

type MergedCoverageConfig = {
  include?: string[]
  exclude?: string[]
  provider?: string
  reporter?: string[]
  thresholds?: Record<string, number>
}

async function loadMergedCoverageConfig(): Promise<MergedCoverageConfig | undefined> {
  const configModule = (await import('../../../vitest.config')) as {
    default: { test?: { coverage?: MergedCoverageConfig } }
  }
  return configModule.default.test?.coverage
}

describe('apps/web vitest coverage configuration', () => {
  it('includes the canonical complete-source pattern for production TS and Svelte files', async () => {
    const coverage = await loadMergedCoverageConfig()

    expect(coverage).toBeDefined()
    expect(coverage?.include).toContain('src/**/*.{ts,svelte}')
  })

  it('extends (not replaces) Vitest exported coverage defaults and adds only the four exclusion categories', async () => {
    const coverage = await loadMergedCoverageConfig()
    const exclude = coverage?.exclude ?? []

    for (const defaultExclusion of coverageConfigDefaults.exclude) {
      expect(exclude).toContain(defaultExclusion)
    }

    expect(exclude).toEqual(
      expect.arrayContaining([
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/lib/test/**',
        'src/**/*-test-helpers.ts',
      ])
    )
  })

  it('does not neutralize production inclusion with an overly broad exclusion rule', async () => {
    const coverage = await loadMergedCoverageConfig()
    const exclude = coverage?.exclude ?? []

    const overlyBroad = exclude.some((pattern) =>
      ['src/**', 'src/**/*', 'src/**/*.ts', 'src/**/*.svelte', '**/*.ts', '**/*.svelte'].includes(
        pattern
      )
    )
    expect(overlyBroad).toBe(false)
  })

  it('preserves the inherited shared provider, reporters, and 80% thresholds', async () => {
    const coverage = await loadMergedCoverageConfig()

    expect(coverage?.provider).toBe('v8')
    expect(coverage?.reporter).toEqual(
      expect.arrayContaining(['text', 'html', 'clover', 'json', 'lcov'])
    )
    expect(coverage?.thresholds).toEqual({
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    })
  })
})
