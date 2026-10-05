// @ts-check
// Story 66-7: the mutate globs are split into shards that run as separate jobs (own Postgres, own
// dry run). The dry run executes only the tests *related* (import graph) to the shard's mutated
// files, so a smaller shard means a smaller dry run: "add shards, not minutes". Set STRYKER_SHARD
// to `api` or `db` to run one shard; unset runs every shard's globs in one run (slow).
/** @type {{ api: string[], db: string[] }} */
export const SHARDS = {
  api: [
    'apps/api/src/lib/pagination.ts',
    'apps/api/src/services/**/*.ts',
    'apps/api/src/domain/**/*.ts',
  ],
  db: [
    'packages/db/src/repositories/**/*.ts',
    // Story 1.4: foundational RLS security layer, held to the >=80% mutation
    // requirement regardless of the epic-wide 60% nightly gate.
    'packages/db/src/index.ts',
    'packages/db/src/test-helpers.ts',
    'packages/db/src/check-rls-coverage.ts',
  ],
}
const EXCLUDES = [
  '!**/*.config.{js,ts,mjs}',
  '!**/migrations/**',
  '!**/*.d.ts',
  '!**/generated/**',
  '!**/*.test.ts',
  '!**/scripts/**',
]
const shard = process.env.STRYKER_SHARD
const selected = Object.entries(SHARDS).filter(([name]) => !shard || name === shard)
if (selected.length === 0) {
  throw new Error(`STRYKER_SHARD must be one of ${Object.keys(SHARDS).join(', ')} (got "${shard}")`)
}
const shardGlobs = selected.flatMap(([, globs]) => globs)

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
  // Measured (Story 66-9): the api shard's dry run (2295 serial DB-backed tests, runner forces one
  // worker) took 43m29s (Nightly 36927014312) and 46m50s (forced Nightly 36955819885); the db shard
  // 30 s. 70 = 1.5x the slower api measurement. A slower dry run fails the job honestly: add a
  // shard, never raise this number (Epic 66 rule); keep the workflow's timeout-minutes above it.
  dryRunTimeoutMinutes: 70,
  // Initial threshold: 60% — ratchets to 80% after Epic 2 is complete
  // Initial scaffold correctly reports "no mutants found" (all Story 1.1 code is
  // infrastructure/stubs — business logic files that Stryker mutates are added in Story 1.2+)
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },
  // Only mutate domain/business logic files (services, repositories, domain models)
  // Infrastructure, adapters, and stubs are excluded — they contain no domain logic
  // Story 1.2+ adds service files that Stryker will mutate
  mutate: [...shardGlobs, ...EXCLUDES],
  // json is uploaded as an artifact by the nightly job; clear-text prints the score table.
  reporters: ['progress-append-only', 'clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  // Without this, the vitest runner auto-discovers every package's vitest.config.ts
  // in the monorepo (including apps/web's), which crashes on startup: its
  // tsconfig.json extends ./.svelte-kit/tsconfig.json, a generated file that Stryker
  // never copies into the sandbox (.svelte-kit is hardcoded in Stryker's
  // ALWAYS_IGNORE list, like .next/.nuxt). apps/web isn't mutated and has no tests
  // that matter for this run, so scope vitest to just the mutated projects.
  vitest: {
    configFile: 'vitest.stryker.config.ts',
  },
}
