// Story 68.9 AC-14: the tests that keep PV's web guards usable over a composed tree run in `make ci`
// and in CI, and are not commented out or made non-blocking. Pure text in, assertions out: repo files
// are loaded with `import.meta.glob` (the lint-clean pattern of check-web-svelte-check-wiring.test.ts).
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'

const GUARD_TESTS = [
  'scripts/check-web-guard-completeness.test.ts',
  'scripts/check-web-guard-symmetry.test.ts',
  'scripts/check-web-guard-wiring.test.ts',
  'scripts/check-form-guidance.test.ts',
]
const COMMAND = `pnpm vitest run ${GUARD_TESTS.join(' ')}`

const WORKFLOW: Record<string, string> = import.meta.glob('../.github/workflows/ci.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
})
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal.
const MAKEFILE: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('PV web guard tests are wired into CI (Story 68.9 AC-14)', () => {
  it('make ci-inner runs them as a live, blocking line', () => {
    const makefile = Object.values(MAKEFILE)[0] ?? ''
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), COMMAND)).toBe(true)
  })

  it('ci.yml runs them in a step of its own', () => {
    const workflow = Object.values(WORKFLOW)[0] ?? ''
    expect(workflowRunCommands(workflow)).toContain(COMMAND)
  })
})

// Story 68.10 AC-4.5: the monolithic-region guard runs in `make ci-inner` and in a ci.yml step of its
// own, next to the 68-4 coverage guard, and the package script exists. Not commented out, not
// non-blocking, and the tests it needs (the walker's own route-files tests) run with it.
const PACKAGE_JSON: Record<string, string> = import.meta.glob('../package.jso[n]', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const MONOLITHIC_CHECK = 'pnpm check-monolithic-regions'
const MONOLITHIC_TESTS =
  'pnpm vitest run scripts/check-monolithic-regions.test.ts scripts/lib/route-files.test.ts'

// Story 68.10 AC-9: the control-group test (PV's own CM-free build) runs in `make ci-inner` after a
// forced build of the web app, and in the web-host-pack job, as live blocking lines.
const CONTROL_BUILD = 'pnpm turbo build --force --filter=@project-vault/web-host'
const CONTROL_TEST = 'pnpm vitest run scripts/check-pv-cm-free-build.test.ts'

describe("PV's CM-free control group is wired into CI (Story 68.10 AC-9)", () => {
  it('make ci-inner builds the web app, then runs the control group', () => {
    const recipe = makeRecipe(Object.values(MAKEFILE)[0] ?? '', 'ci-inner')
    expect(recipeRunsCommand(recipe, CONTROL_BUILD)).toBe(true)
    expect(recipeRunsCommand(recipe, CONTROL_TEST)).toBe(true)
    expect(recipe.indexOf(CONTROL_BUILD)).toBeLessThan(recipe.indexOf(CONTROL_TEST))
  })

  it('ci.yml builds the web app and runs the control group as separate steps, build first', () => {
    const commands = workflowRunCommands(Object.values(WORKFLOW)[0] ?? '')
    expect(commands).toContain(CONTROL_BUILD)
    expect(commands).toContain(CONTROL_TEST)
    expect(commands.indexOf(CONTROL_BUILD)).toBeLessThan(commands.indexOf(CONTROL_TEST))
  })
})

describe('the monolithic-region guard is wired into CI (Story 68.10 AC-4.5)', () => {
  it('has a package script that runs the thin CLI', () => {
    const scripts = (
      JSON.parse(Object.values(PACKAGE_JSON)[0] ?? '{}') as { scripts: Record<string, string> }
    ).scripts
    expect(scripts['check-monolithic-regions']).toBe('tsx scripts/check-monolithic-regions.ts')
  })

  it('make ci-inner runs the guard and its tests as live, blocking lines', () => {
    const recipe = makeRecipe(Object.values(MAKEFILE)[0] ?? '', 'ci-inner')
    expect(recipeRunsCommand(recipe, MONOLITHIC_CHECK)).toBe(true)
    expect(recipeRunsCommand(recipe, MONOLITHIC_TESTS)).toBe(true)
  })

  it('ci.yml runs the guard and its tests in one step, guard first', () => {
    const commands = workflowRunCommands(Object.values(WORKFLOW)[0] ?? '')
    expect(commands).toContain(`${MONOLITHIC_CHECK} &&\n${MONOLITHIC_TESTS}`)
  })
})
