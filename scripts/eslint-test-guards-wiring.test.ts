import { ESLint } from 'eslint'
import { describe, expect, it, vi } from 'vitest'
import {
  baseRules,
  NO_AWAIT_IN_LOOP_CARVE_OUTS,
  SONAR_LOCAL_RULE_NAMES,
  SONAR_LOCAL_TYPED_RULE_NAMES,
  TEST_FILE_GLOBS,
} from '../packages/eslint-config/index.js'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import makefile from '../Makefile?raw'
import ciWorkflow from '../.github/workflows/ci.yml?raw'
import packageJson from '../package.json?raw'

// Story 66-17 self-wiring guard. The three new lint guards (no-await-in-loop in production source,
// prefer-to-have-length and no-elapsed-time-assertion in test files), the Sonar rules promoted
// into baseRules and the lint:changed script must stay registered: removing one fails here, not
// silently. Every rule is also proven to FIRE through the real ESLint engine on the root config.

type RuleLevel = string | [string, ...unknown[]]
type ConfigObject = {
  files?: string[]
  ignores?: string[]
  rules?: Record<string, RuleLevel>
  languageOptions?: { parserOptions?: { projectService?: unknown } }
}

const configs = baseRules as ConfigObject[]

function levelOf(rule: RuleLevel | undefined): string | undefined {
  return Array.isArray(rule) ? rule[0] : rule
}

function objectsEnabling(rule: string): ConfigObject[] {
  return configs.filter((config) => levelOf(Reflect.get(config.rules ?? {}, rule)) === 'error')
}

const AWAIT_RULE = 'no-await-in-loop'
const LENGTH_RULE = 'project-vault-tests/prefer-to-have-length'
const ELAPSED_RULE = 'project-vault-tests/no-elapsed-time-assertion'
const TS_GLOB = '**/*.ts'
const TS_FILE = 'apps/api/src/example.ts'
const TEST_FILE = 'apps/api/src/example.test.ts'
const AWAIT_IN_LOOP = 'for (const x of xs) {\n  await work(x)\n}\n'
const WRAPPED = (body: string) => `export async function f(xs: number[]) {\n${body}}\n`

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname })

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? []).flatMap((message) => (message.ruleId ? [message.ruleId] : []))
}

describe('baseRules registration (AC-6)', () => {
  it('enables no-await-in-loop at error for production source only, with the ledgered carve-out', () => {
    const enabling = objectsEnabling(AWAIT_RULE)
    expect(enabling).toHaveLength(1)
    const [config] = enabling
    expect(config?.ignores).toEqual([...TEST_FILE_GLOBS, ...NO_AWAIT_IN_LOOP_CARVE_OUTS])
    expect(config?.files).toEqual(expect.arrayContaining([TS_GLOB, '**/*.js']))
  })

  it('pins the carve-out list: loader.ts is blocked by the extension-api version-bump guard (DW-578)', () => {
    expect(NO_AWAIT_IN_LOOP_CARVE_OUTS).toEqual(['**/src/extensions/loader.ts'])
  })

  it('enables both test-file rules at error, scoped to the test globs', () => {
    for (const rule of [LENGTH_RULE, ELAPSED_RULE]) {
      const enabling = objectsEnabling(rule)
      expect(enabling, rule).toHaveLength(1)
      expect(enabling[0]?.files, rule).toEqual(TEST_FILE_GLOBS)
    }
  })

  it('keeps the test globs covering test, spec, e2e and __tests__ files', () => {
    expect(TEST_FILE_GLOBS).toEqual(
      expect.arrayContaining([
        '**/*.test.{ts,tsx,js,mjs,cjs}',
        '**/*.spec.{ts,tsx,js,mjs,cjs}',
        '**/e2e/**',
        '**/__tests__/**',
      ])
    )
  })

  it('enforces the untyped Sonar rules that are clean repo-wide (S4634, S3699)', () => {
    for (const rule of [
      'sonarjs/prefer-promise-shorthand',
      'sonarjs/no-use-of-empty-return-value',
    ]) {
      expect(objectsEnabling(rule), rule).toHaveLength(1)
    }
  })

  it('does not pretend the type-aware Sonar rules run in baseRules (they are inert without types)', () => {
    expect(SONAR_LOCAL_TYPED_RULE_NAMES).toEqual([
      'deprecation',
      'no-alphabetical-sort',
      'no-misleading-array-reverse',
    ])
    for (const name of SONAR_LOCAL_TYPED_RULE_NAMES) {
      expect(objectsEnabling(`sonarjs/${name}`), name).toHaveLength(0)
    }
  })

  it('switches the not-yet-clean Sonar rules on only with PV_SONAR_LOCAL=1', async () => {
    const without = configs.flatMap((config) => Object.keys(config.rules ?? {}))
    for (const name of SONAR_LOCAL_RULE_NAMES) expect(without).not.toContain(`sonarjs/${name}`)

    vi.stubEnv('PV_SONAR_LOCAL', '1')
    vi.resetModules()
    try {
      const gated = (await import('../packages/eslint-config/index.js?sonar-local')) as {
        baseRules: ConfigObject[]
      }
      const withLocal = gated.baseRules.flatMap((config) => Object.keys(config.rules ?? {}))
      for (const name of SONAR_LOCAL_RULE_NAMES) expect(withLocal).toContain(`sonarjs/${name}`)
      for (const name of SONAR_LOCAL_TYPED_RULE_NAMES)
        expect(withLocal).toContain(`sonarjs/${name}`)
      const typed = gated.baseRules.find((config) => config.rules?.['sonarjs/no-alphabetical-sort'])
      expect(typed?.languageOptions?.parserOptions?.projectService).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('includes the nine overrides of the sonarcloud spec (deprecation in the typed set)', () => {
    expect([...SONAR_LOCAL_RULE_NAMES, ...SONAR_LOCAL_TYPED_RULE_NAMES]).toEqual(
      expect.arrayContaining([
        'no-hardcoded-ip',
        'no-clear-text-protocols',
        'no-undefined-assignment',
        'pseudo-random',
        'no-os-command-from-path',
        'no-skipped-tests',
        'deprecation',
        'todo-tag',
        'no-hardcoded-passwords',
      ])
    )
  })
})

describe('the rules fire through the real ESLint engine (root config)', () => {
  it('no-await-in-loop fails production source and not test files or the carve-out', async () => {
    const code = WRAPPED(AWAIT_IN_LOOP)
    expect(await ruleIdsFor(code, TS_FILE)).toContain(AWAIT_RULE)
    expect(await ruleIdsFor(code, TEST_FILE)).not.toContain(AWAIT_RULE)
    expect(await ruleIdsFor(code, 'apps/api/src/extensions/loader.ts')).not.toContain(AWAIT_RULE)
    // the carve-out is exactly one file: its neighbours are still enforced
    expect(await ruleIdsFor(code, 'apps/api/src/extensions/registry.ts')).toContain(AWAIT_RULE)
  })

  it('prefer-to-have-length fails a .length matcher in a test file only', async () => {
    const code = 'expect(items.length).toBe(3)\n'
    expect(await ruleIdsFor(code, TEST_FILE)).toContain(LENGTH_RULE)
    expect(await ruleIdsFor(code, TS_FILE)).not.toContain(LENGTH_RULE)
    expect(await ruleIdsFor('expect(items).toHaveLength(3)\n', TEST_FILE)).not.toContain(
      LENGTH_RULE
    )
  })

  it('no-elapsed-time-assertion fails a clock-delta bound in a test file only', async () => {
    const code =
      'const started = performance.now()\nexpect(performance.now() - started).toBeLessThan(1000)\n'
    expect(await ruleIdsFor(code, TEST_FILE)).toContain(ELAPSED_RULE)
    expect(await ruleIdsFor(code, TS_FILE)).not.toContain(ELAPSED_RULE)
    const fakeTimers =
      'vi.useFakeTimers()\nawait vi.advanceTimersByTimeAsync(19)\nexpect(done).toBe(false)\n'
    expect(await ruleIdsFor(fakeTimers, TEST_FILE)).not.toContain(ELAPSED_RULE)
  })
})

describe('the DW-434 files stay structural (narrow pin for what a syntactic rule cannot see)', () => {
  // The lint rule cannot follow a clock read through a helper (the old `measureP95` shape) or an
  // alias, so the five files DW-434 ledgered are pinned directly: no clock read, no p95 helper.
  const sources = import.meta.glob(
    [
      '../apps/api/src/lib/logger.test.ts',
      '../apps/api/src/lib/capability-gate.test.ts',
      './check-deferred-work-triggers.test.ts',
      './check-crypto-adjacent-pins.test.ts',
    ],
    { query: '?raw', import: 'default', eager: true }
  ) as Record<string, string>

  it('pins exactly the four files that carried the five wall-clock tests', () => {
    expect(Object.keys(sources).toSorted((a, b) => a.localeCompare(b))).toHaveLength(4)
  })

  it.each(Object.entries(sources))('%s reads no clock and measures no p95', (_path, source) => {
    expect(source).not.toMatch(/performance\.now\(|Date\.now\(|process\.hrtime|measureP95/)
  })
})

describe('lint:changed wiring (AC-5, AC-6)', () => {
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts

  it('is a package.json script that runs scripts/lint-changed-sonar.ts', () => {
    expect(scripts['lint:changed']).toBe('tsx scripts/lint-changed-sonar.ts')
  })

  it('has its tests and the shell guard tests wired into make ci-inner and ci.yml', () => {
    const command =
      'pnpm vitest run scripts/lint-changed-sonar.test.ts scripts/check-shell-positional-params.test.ts scripts/eslint-test-guards-wiring.test.ts'
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), command)).toBe(true)
    expect(workflowRunCommands(ciWorkflow).some((run) => run.includes(command))).toBe(true)
  })
})
