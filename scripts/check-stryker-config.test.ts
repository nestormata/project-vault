import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs config, no type declarations
import config, { SHARDS } from '../stryker.config.mjs'

// Story 66-7 guard: the invariants the Stryker/vitest-5 fix depends on. Each assertion fails if
// someone "fixes" a red nightly by loosening the gate instead of the cause (DW-335).
// Files are loaded as raw text at transform time by Vite (literal globs are required).
const workspaceYaml = Object.values(
  import.meta.glob('../pnpm-workspace.yaml', { query: '?raw', import: 'default', eager: true })
).join('\n') as string
const nightly = Object.values(
  import.meta.glob('../.github/workflows/nightly.yml', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
).join('\n') as string
const patchFiles = import.meta.glob('../patches/@stryker-mutator__vitest-runner.patch', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const installedRunner = import.meta.glob(
  '../node_modules/@stryker-mutator/vitest-runner/dist/src/{test-helpers,stryker-setup}.js',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

describe('stryker.config.mjs gate invariants', () => {
  it('keeps the break threshold at 60 or higher (never lowered to get green)', () => {
    expect(config.thresholds.break).toBeGreaterThanOrEqual(60)
    expect(config.thresholds.low).toBeGreaterThanOrEqual(config.thresholds.break)
    expect(config.thresholds.high).toBeGreaterThanOrEqual(config.thresholds.low)
  })

  it('still runs the vitest runner with per-test coverage (not "off")', () => {
    expect(config.testRunner).toBe('vitest')
    expect(config.coverageAnalysis).toBe('perTest')
    expect(config.plugins).toContain('@stryker-mutator/vitest-runner')
  })

  it('mutates a non-empty set of source globs split into non-overlapping api and db shards', () => {
    const positives = (config.mutate as string[]).filter((glob) => !glob.startsWith('!'))
    // Floor, not a count to track: shrinking `mutate` to get green must fail here (66-7 review).
    expect(positives.length).toBeGreaterThanOrEqual(4)
    expect(Object.keys(SHARDS).sort()).toEqual(['api', 'db'])
    const all = (Object.values(SHARDS) as string[][]).flat()
    for (const globs of Object.values(SHARDS) as string[][]) expect(globs.length).toBeGreaterThan(0)
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(positives)).toEqual(new Set(all))
  })

  it('has a dry-run timeout tuned to the measured api dry run (Story 66-9)', () => {
    expect(config.dryRunTimeoutMinutes).toBeGreaterThan(0)
    // Measured api dry run: 43m29s and 46m50s (Nightly 36927014312, forced Nightly 36955819885); 70 = 1.5x the slower.
    expect(config.dryRunTimeoutMinutes).toBeLessThanOrEqual(70)
  })
})

describe('vitest 5 runner patch (DW-335)', () => {
  it('is registered in pnpm-workspace.yaml patchedDependencies and the patch file exists', () => {
    expect(workspaceYaml).toMatch(
      /patchedDependencies:\s*\n\s+'@stryker-mutator\/vitest-runner': patches\/@stryker-mutator__vitest-runner\.patch/
    )
    expect(Object.keys(patchFiles)).toHaveLength(1)
  })

  it('joins test-name parts with " > " in both copies of collectTestName', () => {
    const [patch] = Object.values(patchFiles)
    expect(patch).toContain('dist/src/test-helpers.js')
    expect(patch).toContain('dist/src/stryker-setup.js')
    expect(patch.match(/^\+\s+return nameParts\.join\(' > '\)\.trim\(\);$/gm)).toHaveLength(2)
  })

  it('is actually applied to the installed runner (a lost patch scores every mutant "survived")', () => {
    expect(Object.keys(installedRunner)).toHaveLength(2)
    for (const text of Object.values(installedRunner)) {
      expect(text).toContain("nameParts.join(' > ').trim()")
    }
  })
})

describe('nightly mutation job wiring', () => {
  const job = nightly.slice(nightly.indexOf('  mutation:'), nightly.indexOf('  flaky-test-repeat:'))

  it('runs one matrix leg per shard, fail-fast off, passing STRYKER_SHARD', () => {
    expect(job).toMatch(/fail-fast:\s*false/)
    expect(job).toMatch(/shard:\s*\[\s*api\s*,\s*db\s*\]/)
    expect(job).toContain('STRYKER_SHARD: ${{ matrix.shard }}')
  })

  it('has an explicit job timeout, never continue-on-error', () => {
    expect(job).toMatch(/timeout-minutes:\s*\d+/)
    const jobTimeout = Number(/timeout-minutes:\s*(\d+)/.exec(job)?.[1])
    // The job timeout must leave room beyond the dry-run ceiling for the mutation phase.
    expect(jobTimeout).toBeGreaterThan(config.dryRunTimeoutMinutes)
    expect(job).not.toContain('continue-on-error')
  })
})
