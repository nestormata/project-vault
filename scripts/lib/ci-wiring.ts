// Shared parsing for "is this contract suite actually wired into CI?" self-tests (Story 66.1's
// e2e-stack.test.ts, Story 60.7's check-compose-config.test.ts). Pure text in, data out: callers
// load the Makefile / workflow text themselves.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

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

/** Every step `run` command across every job of a GitHub Actions workflow. */
export function workflowRunCommands(workflowText: string): string[] {
  const workflow = parseYaml(workflowText) as WorkflowFile
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run.trim()]))
  )
}
