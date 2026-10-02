// Shared parsing for "is this contract suite actually wired into CI?" self-tests (Story 66.1's
// e2e-stack.test.ts, Story 60.7's check-compose-config.test.ts). Pure text in, data out: callers
// load the Makefile / workflow text themselves.
import { parseYaml } from './yaml.js'

interface WorkflowStep {
  run?: string
}

interface WorkflowFile {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

/** The tab-indented recipe lines of one Makefile target (empty when the target is absent). */
export function makeRecipe(makefile: string, target: string): string {
  const lines = makefile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${target}:`))
  if (start === -1) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break
    body.push(line)
  }
  return body.join('\n')
}

/** Whether a recipe (from `makeRecipe`) runs `command` as its own live line: not commented out
 * and without make's `-` ignore-errors prefix (a failure would then not fail the target). A `@`
 * echo-suppression prefix is allowed. */
export function recipeRunsCommand(recipe: string, command: string): boolean {
  return recipe.split('\n').some((line) => line.trim().replace(/^@/, '') === command)
}

/** Every step `run` command across every job of a GitHub Actions workflow. */
export function workflowRunCommands(workflowText: string): string[] {
  const workflow = parseYaml(workflowText) as WorkflowFile
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run.trim()]))
  )
}
