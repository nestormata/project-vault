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
