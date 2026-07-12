import { describe, expect, it } from 'vitest'
import { coverageConfigDefaults } from 'vitest/config'

// Story 10.4: `apps/api/vitest.config.ts` must expand its Story-1.1-era 21-file allowlist to
// truthful product-source membership (AC-B4, AC-B5) while keeping test/helper/bootstrap files
// and the shared 80% thresholds untouched (AC-C1, AC-C2). This guard evaluates the merged Vitest
// config object returned by the config module itself (not the raw file text), matching the
// precedent set by `apps/web/src/lib/test/vitest-config.test.ts` for Story 10.3 and satisfying
// AC-C3's "merged config semantics can override raw text" requirement.

type MergedCoverageConfig = {
  include?: string[]
  exclude?: string[]
  provider?: string
  reporter?: string[]
  thresholds?: Record<string, number>
}

// `vitest.config.ts` lives at the package root, outside this package's `tsconfig.json`
// `rootDir: "src"` — a static `import('../../vitest.config')` specifier makes `tsc --noEmit`
// (this package's tests ARE typechecked, unlike apps/web's, which excludes `*.test.ts`) fail
// with "Cannot find module" even though Vitest itself resolves it fine at runtime. Routing the
// specifier through a non-literal `const` sidesteps TS's static module-resolution/type-checking
// for this one dynamic import (the return type is asserted explicitly below instead).
const VITEST_CONFIG_MODULE_PATH = '../../vitest.config.js'

async function loadMergedCoverageConfig(): Promise<MergedCoverageConfig | undefined> {
  const configModule = (await import(VITEST_CONFIG_MODULE_PATH)) as {
    default: { test?: { coverage?: MergedCoverageConfig } }
  }
  return configModule.default.test?.coverage
}

// Minimal glob matcher sufficient for the fixed set of patterns under test here (only `**` and
// `*` segments appear in this repo's vitest coverage config); not shipped as product code.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('')
    .map((char) => (/[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char))
    .join('')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesAny(patterns: string[], filePath: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath))
}

describe('apps/api vitest coverage configuration', () => {
  it('includes the canonical truthful product-source pattern instead of a hand-maintained allowlist', async () => {
    const coverage = await loadMergedCoverageConfig()

    expect(coverage).toBeDefined()
    expect(coverage?.include).toContain('src/**/*.ts')
  })

  it('makes previously-omitted product modules eligible for coverage (AC-B4)', async () => {
    const coverage = await loadMergedCoverageConfig()
    const include = coverage?.include ?? []
    const exclude = coverage?.exclude ?? []

    const previouslyOmittedProductFiles = [
      'src/modules/projects/dashboard-stats.ts',
      'src/modules/auth/mfa.ts',
      'src/modules/auth/mfa-enforcement.ts',
      'src/workers/prune-revoked-tokens.ts',
      'src/workers/check-failed-auth-threshold.ts',
    ]

    for (const file of previouslyOmittedProductFiles) {
      expect(matchesAny(include, file)).toBe(true)
      expect(matchesAny(exclude, file)).toBe(false)
    }
  })

  it('excludes only test, helper, and bootstrap files — not product code', async () => {
    const coverage = await loadMergedCoverageConfig()
    const exclude = coverage?.exclude ?? []

    for (const defaultExclusion of coverageConfigDefaults.exclude) {
      expect(exclude).toContain(defaultExclusion)
    }

    expect(exclude).toEqual(
      expect.arrayContaining([
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/__tests__/**',
        'src/**/*-test-helpers.ts',
        'src/**/*-test-bootstrap.ts',
      ])
    )

    const testInfrastructureFiles = [
      'src/__tests__/helpers/auth-test-helpers.ts',
      'src/modules/credentials/credential-route-test-helpers.ts',
      'src/modules/machine-users/machine-user-route-test-bootstrap.ts',
      'src/modules/projects/project-route-test-bootstrap.ts',
      'src/workers/worker-test-helpers.ts',
    ]
    for (const file of testInfrastructureFiles) {
      expect(matchesAny(exclude, file)).toBe(true)
    }
  })

  it('does not neutralize production inclusion with an overly broad exclusion rule', async () => {
    const coverage = await loadMergedCoverageConfig()
    const exclude = coverage?.exclude ?? []

    const overlyBroad = exclude.some((pattern) =>
      ['src/**', 'src/**/*', 'src/**/*.ts', 'src/modules/**', 'src/workers/**'].includes(pattern)
    )
    expect(overlyBroad).toBe(false)
  })

  it('preserves the inherited shared provider, reporters, and 80% thresholds (AC-C1, AC-C2)', async () => {
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
