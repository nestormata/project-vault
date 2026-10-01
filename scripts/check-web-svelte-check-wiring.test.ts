// Story 68.1 AC-4/AC-7: guards that svelte-check really runs, in the right order and with the
// strict flags, in both CI (`ci.yml` Checks job) and `make ci` (`ci-inner`), and that no web
// component escapes the check by not being TypeScript. No network, no child processes: repo files
// are loaded as raw text at transform time with `import.meta.glob` (the lint-clean loading
// pattern of check-action-pins.test.ts / check-compose-config.test.ts).
import { describe, expect, it } from 'vitest'

const WEB_TSCONFIG = '../apps/web/tsconfig.json'
const GUARD_TEST_COMMAND = 'pnpm vitest run scripts/check-web-svelte-check-wiring.test.ts'
const CHECK_SVELTE = '"check:svelte"'
const FORBIDDEN_SVELTE_CHECK_FLAGS = [
  '--threshold',
  '--ignore',
  '--compiler-warnings',
  '--no-tsconfig',
] as const

const REPO_TEXT: Record<string, string> = import.meta.glob(
  [
    '../apps/web/package.json',
    '../apps/web/tsconfig.json',
    '../apps/web/svelte.config.js',
    '../apps/web/vite.config.ts',
    '../.github/workflows/ci.yml',
  ],
  { query: '?raw', import: 'default', eager: true }
)
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal.
const MAKEFILE_TEXT: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const WEB_SVELTE_SOURCES: Record<string, string> = import.meta.glob(
  ['../apps/web/src/**/*.svelte', '!../apps/web/src/lib/paraglide/**'],
  { query: '?raw', import: 'default', eager: true }
)

function repoText(key: string): string {
  const text = Object.entries({ ...REPO_TEXT, ...MAKEFILE_TEXT }).find(
    ([candidate]) => candidate === key
  )?.[1]
  expect(text, `${key} must exist`).toBeDefined()
  return text ?? ''
}

function webScripts(packageJson: string): Record<string, string> {
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> }
  return parsed.scripts ?? {}
}

/** Reports out-of-order steps, given each step's index (-1 when absent). */
function orderProblems(compile: number, sync: number, check: number): string[] {
  const problems: string[] = []
  if (compile !== -1 && sync !== -1 && compile > sync) {
    problems.push('"typecheck" runs svelte-kit sync before paraglide:compile')
  }
  if (sync !== -1 && check !== -1 && sync > check) {
    problems.push('"typecheck" runs check:svelte before svelte-kit sync')
  }
  return problems
}

/** `typecheck` must compile paraglide, then sync SvelteKit, then run `check:svelte`. Only order
 * and presence are asserted (never the exact string), so 66-2's appended `typecheck:e2e` step
 * stays compatible. */
export function typecheckScriptProblems(typecheck: string | undefined): string[] {
  if (!typecheck) return ['apps/web has no "typecheck" script']
  const steps = typecheck.split('&&').map((step) => step.trim())
  const indexOf = (needle: string) => steps.findIndex((step) => step.includes(needle))
  const required = [
    ['paraglide:compile', indexOf('paraglide:compile')],
    ['svelte-kit sync', indexOf('svelte-kit sync')],
    ['check:svelte', indexOf('check:svelte')],
  ] as const
  const missing = required
    .filter(([, index]) => index === -1)
    .map(([name]) => `"typecheck" does not run ${name}`)
  return [...missing, ...orderProblems(required[0][1], required[1][1], required[2][1])]
}

/** `check:svelte` must run svelte-check against the app tsconfig, failing on warnings too. */
export function svelteCheckScriptProblems(checkSvelte: string | undefined): string[] {
  if (!checkSvelte) return [`apps/web has no ${CHECK_SVELTE} script`]
  const problems: string[] = []
  if (!/^svelte-check(\s|$)/.test(checkSvelte.trim())) {
    problems.push(`${CHECK_SVELTE} does not invoke svelte-check`)
  }
  if (!checkSvelte.includes('--tsconfig ./tsconfig.json')) {
    problems.push(`${CHECK_SVELTE} does not pass --tsconfig ./tsconfig.json`)
  }
  if (!checkSvelte.includes('--fail-on-warnings')) {
    problems.push(`${CHECK_SVELTE} does not pass --fail-on-warnings`)
  }
  for (const flag of FORBIDDEN_SVELTE_CHECK_FLAGS) {
    if (checkSvelte.includes(flag)) problems.push(`${CHECK_SVELTE} loosens the check with ${flag}`)
  }
  return problems
}

/** A `turbo typecheck` invocation must not filter @project-vault/web out. */
export function turboTypecheckFilterProblems(source: string, label: string): string[] {
  return source
    .split('\n')
    .filter((line) => line.includes('turbo typecheck') && line.includes('--filter'))
    .filter((line) => !/--filter[= ]@project-vault\/web(\s|$)/.test(line) || line.includes('!'))
    .map((line) => `${label}: turbo typecheck is filtered: ${line.trim()}`)
}

/** The ci.yml `checks` job (from its `  checks:` key to the next top-level job). */
export function checksJobBlock(workflow: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === '  checks:')
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:\s*$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The Makefile `ci-inner` recipe (from its target line to the next target). */
export function ciInnerRecipe(makefile: string): string {
  const lines = makefile.split('\n')
  const start = lines.findIndex((line) => line.startsWith('ci-inner:'))
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^[\w.-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** Whether a tsconfig's `exclude` drops `*.test.ts` / `*.spec.ts` files from the check. */
export function tsconfigExcludesTests(tsconfigJson: string): boolean {
  const { exclude = [] } = JSON.parse(tsconfigJson) as { exclude?: string[] }
  return exclude.some((pattern) => /\.(test|spec)\.ts$/.test(pattern))
}

/** Every `<script>` opening tag in a .svelte file must declare lang="ts" (AC-7). */
export function hasUntypedScript(svelteSource: string): boolean {
  const openingTags = svelteSource.match(/<script\b[^>]*>/g) ?? []
  return openingTags.some((tag) => !/\blang=["']ts["']/.test(tag))
}

describe('web svelte-check wiring guard: parsers (Story 68.1 AC-4)', () => {
  const GOOD_TYPECHECK =
    'pnpm run paraglide:compile && svelte-kit sync && tsc --noEmit && pnpm run check:svelte'
  const GOOD_CHECK_SVELTE = 'svelte-check --tsconfig ./tsconfig.json --fail-on-warnings'

  it('accepts the canonical typecheck chain and check:svelte command', () => {
    expect(typecheckScriptProblems(GOOD_TYPECHECK)).toEqual([])
    expect(svelteCheckScriptProblems(GOOD_CHECK_SVELTE)).toEqual([])
  })

  it("accepts 66-2's typecheck:e2e step appended anywhere after sync", () => {
    expect(
      typecheckScriptProblems(
        'pnpm run paraglide:compile && svelte-kit sync && tsc --noEmit && pnpm run typecheck:e2e && pnpm run check:svelte'
      )
    ).toEqual([])
    expect(typecheckScriptProblems(`${GOOD_TYPECHECK} && pnpm run typecheck:e2e`)).toEqual([])
  })

  it('rejects svelte-check running before svelte-kit sync', () => {
    expect(
      typecheckScriptProblems(
        'pnpm run paraglide:compile && pnpm run check:svelte && svelte-kit sync && tsc --noEmit'
      )
    ).toContain('"typecheck" runs check:svelte before svelte-kit sync')
  })

  it('rejects sync before the paraglide compile, and a missing step', () => {
    expect(
      typecheckScriptProblems(
        'svelte-kit sync && pnpm run paraglide:compile && pnpm run check:svelte'
      )
    ).toContain('"typecheck" runs svelte-kit sync before paraglide:compile')
    expect(
      typecheckScriptProblems('pnpm run paraglide:compile && svelte-kit sync && tsc --noEmit')
    ).toContain('"typecheck" does not run check:svelte')
    expect(typecheckScriptProblems(undefined)).toEqual(['apps/web has no "typecheck" script'])
  })

  it('rejects a check:svelte without --fail-on-warnings or with --threshold error', () => {
    expect(svelteCheckScriptProblems('svelte-check --tsconfig ./tsconfig.json')).toContain(
      '"check:svelte" does not pass --fail-on-warnings'
    )
    expect(svelteCheckScriptProblems(`${GOOD_CHECK_SVELTE} --threshold error`)).toContain(
      '"check:svelte" loosens the check with --threshold'
    )
    expect(
      svelteCheckScriptProblems(`${GOOD_CHECK_SVELTE} --compiler-warnings x:ignore`)
    ).toContain('"check:svelte" loosens the check with --compiler-warnings')
    expect(svelteCheckScriptProblems('tsc --noEmit')).toEqual([
      '"check:svelte" does not invoke svelte-check',
      '"check:svelte" does not pass --tsconfig ./tsconfig.json',
      '"check:svelte" does not pass --fail-on-warnings',
    ])
  })

  it('rejects a turbo typecheck that filters the web app out', () => {
    expect(
      turboTypecheckFilterProblems('run: pnpm turbo typecheck --filter=!@project-vault/web', 'x')
    ).toHaveLength(1)
    expect(
      turboTypecheckFilterProblems('run: pnpm turbo typecheck --filter=@project-vault/api', 'x')
    ).toHaveLength(1)
    expect(turboTypecheckFilterProblems('run: pnpm turbo typecheck', 'x')).toEqual([])
  })

  it('flags a component whose script is not TypeScript, including a module script', () => {
    expect(hasUntypedScript('<script>\n  let a = 1\n</script>\n<p>{a}</p>')).toBe(true)
    expect(hasUntypedScript('<script module>\n</script>\n<script lang="ts">\n</script>')).toBe(true)
    expect(hasUntypedScript('<script lang="ts">\n  let a = 1\n</script>')).toBe(false)
    expect(hasUntypedScript('<p>no script at all</p>')).toBe(false)
  })

  it('detects a tsconfig that excludes unit test files', () => {
    expect(tsconfigExcludesTests('{"exclude": ["node_modules", "src/**/*.test.ts"]}')).toBe(true)
    expect(tsconfigExcludesTests('{"exclude": ["node_modules"]}')).toBe(false)
    expect(tsconfigExcludesTests('{}')).toBe(false)
  })

  it('finds the checks job and the ci-inner recipe', () => {
    const workflow = [
      'jobs:',
      '  checks:',
      '    steps:',
      '      - run: pnpm turbo typecheck',
      '  tests:',
      '    steps:',
      '      - run: other',
    ].join('\n')
    expect(checksJobBlock(workflow)).toContain('pnpm turbo typecheck')
    expect(checksJobBlock(workflow)).not.toContain('other')
    const makefile = 'ci-inner: ## x\n\tpnpm turbo typecheck\nnext:\n\tpnpm other\n'
    expect(ciInnerRecipe(makefile)).toContain('pnpm turbo typecheck')
    expect(ciInnerRecipe(makefile)).not.toContain('pnpm other')
  })
})

describe('web svelte-check wiring guard: the real repository files (Story 68.1 AC-4/AC-7)', () => {
  const scripts = webScripts(repoText('../apps/web/package.json'))
  const workflow = repoText('../.github/workflows/ci.yml')
  const makefile = repoText('../Makefile')

  it('apps/web typecheck runs paraglide compile -> svelte-kit sync -> check:svelte', () => {
    expect(typecheckScriptProblems(scripts.typecheck)).toEqual([])
  })

  it('apps/web check:svelte is strict (--tsconfig, --fail-on-warnings, no loosening flags)', () => {
    expect(svelteCheckScriptProblems(scripts['check:svelte'])).toEqual([])
  })

  it('the ci.yml Checks job runs `pnpm turbo typecheck` in a step named for both tools', () => {
    const checks = checksJobBlock(workflow)
    expect(checks).toMatch(
      /- name: Typecheck \(tsc \+ svelte-check\)\n\s+run: pnpm turbo typecheck\n/
    )
  })

  it('make ci (ci-inner) runs `pnpm turbo typecheck`', () => {
    expect(ciInnerRecipe(makefile)).toMatch(/\spnpm turbo typecheck\s*$/m)
  })

  it('no turbo typecheck invocation filters the web app out', () => {
    expect([
      ...turboTypecheckFilterProblems(workflow, 'ci.yml'),
      ...turboTypecheckFilterProblems(makefile, 'Makefile'),
    ]).toEqual([])
  })

  it('this guard itself runs in both the ci.yml Checks job and ci-inner', () => {
    expect(checksJobBlock(workflow)).toContain(GUARD_TEST_COMMAND)
    expect(ciInnerRecipe(makefile)).toContain(GUARD_TEST_COMMAND)
  })

  it('apps/web/tsconfig.json includes the generated route types', () => {
    const tsconfig = JSON.parse(repoText(WEB_TSCONFIG)) as { include?: string[] }
    expect(tsconfig.include).toContain('.svelte-kit/non-ambient.d.ts')
  })

  // Story 68.1 Q2 (Nestor 2026-09-30): unit tests are type-checked by the same gate.
  it('apps/web/tsconfig.json does not exclude unit test files from the check', () => {
    expect(tsconfigExcludesTests(repoText(WEB_TSCONFIG))).toBe(false)
  })

  it('no warning filter hides Svelte warnings from the build or svelte-check', () => {
    for (const path of ['../apps/web/svelte.config.js', '../apps/web/vite.config.ts']) {
      expect(repoText(path), path).not.toMatch(/\bonwarn\b|\bwarningFilter\b/)
    }
  })

  it('every .svelte file with a <script> under apps/web/src uses lang="ts" (AC-7)', () => {
    const files = Object.entries(WEB_SVELTE_SOURCES)
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter(([, source]) => hasUntypedScript(source)).map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
