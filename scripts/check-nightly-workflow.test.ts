import { describe, expect, it } from 'vitest'

// Story 66-11 guard: the nightly's quiet-day skip gate and the 5-leg flaky repeat matrix.
// Each assertion fails if someone "fixes" a red nightly by loosening the gate (continue-on-error,
// fewer repeats, a for loop) instead of the cause. Files are loaded as raw text by Vite.
const nightly = Object.values(
  import.meta.glob('../.github/workflows/nightly.yml', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
).join('\n') as string
const gateScript = Object.values(
  import.meta.glob('./nightly-changes-gate.sh', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
).join('\n') as string

// Splits the `jobs:` block into jobId -> rawJobText on two-space-indented job keys.
function parseJobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const jobs = new Map<string, string>()
  let current: string | undefined
  for (const line of body.split('\n')) {
    const header = /^ {2}([a-z][\w-]*):\s*$/.exec(line)
    if (header) {
      current = header[1]
      jobs.set(current, '')
    } else if (current) {
      jobs.set(current, `${jobs.get(current) ?? ''}${line}\n`)
    }
  }
  return jobs
}

const jobs = parseJobs(nightly)
const jobText = (id: string): string => jobs.get(id) ?? ''
const gated = ['mutation', 'flaky-test-repeat', 'trivy-image', 'e2e']
const NOTIFY_JOB = 'notify-failure'
const RUN_GUARD = "if: needs.changes.outputs.run == 'true'"

describe('nightly changes gate job', () => {
  it('has a `changes` job that is the only job without `needs: changes`', () => {
    expect([...jobs.keys()]).toContain('changes')
    for (const [id, text] of [...jobs.entries()]) {
      if (id === 'changes') {
        expect(text).not.toMatch(/^ {4}needs:/m)
      } else if (id !== NOTIFY_JOB) {
        expect(text, id).toMatch(/^ {4}needs:\s*(changes|\[[^\]]*\bchanges\b[^\]]*\])\s*$/m)
      }
    }
  })

  it('exposes outputs.run, reads contents only, runs the gate script with a token', () => {
    const job = jobText('changes')
    expect(job).toMatch(/outputs:\s*\n\s+run: \$\{\{ steps\.gate\.outputs\.run \}\}/)
    expect(job).toMatch(/permissions:\s*\n\s+contents: read/)
    // steps.gate.outputs.run only resolves if the step id matches (a mismatch would skip everything)
    expect(job).toMatch(/- name: Decide whether to run the nightly\s*\n\s+id: gate\b/)
    expect(job).toContain('./scripts/nightly-changes-gate.sh')
    expect(job).toContain('GH_TOKEN: ${{ github.token }}')
    expect(job).toContain('FORCE: ${{ inputs.force }}')
    expect(job).toMatch(/timeout-minutes:\s*\d+/)
  })

  it('declares the force input as a boolean defaulting to false', () => {
    const dispatch = nightly.slice(
      nightly.indexOf('workflow_dispatch:'),
      nightly.indexOf('\njobs:')
    )
    expect(dispatch).toMatch(/force:/)
    expect(dispatch).toMatch(/type: boolean/)
    expect(dispatch).toMatch(/default: false/)
  })

  it('gate script fails open, handles force, and labels a skip as not-a-proof', () => {
    expect(gateScript).toContain('set -euo pipefail')
    expect(gateScript).toContain('"${FORCE:-false}" == "true"')
    expect(gateScript).toContain('::warning::')
    expect(gateScript).toMatch(/failing open/)
    expect(gateScript).toContain('emit true')
    expect(gateScript).toContain('Skipped: no commits in the last 24h on')
    expect(gateScript).toContain('Running:')
    expect(gateScript).toMatch(/commits\?sha=\$\{GITHUB_SHA\}&since=/)
    expect(gateScript).toContain('per_page=1')
  })
})

describe('nightly job gating', () => {
  it.each(gated)('%s needs changes and only runs when the gate says so', (id) => {
    const job = jobText(id)
    expect(job).toMatch(/^ {4}needs:\s*changes\s*$/m)
    expect(job).toContain(RUN_GUARD)
  })

  it('posts to Slack with the slack-github-action v4 inputs (Story 66-13)', () => {
    const job = jobText(NOTIFY_JOB)
    // v4 rejects the pre-v3 SLACK_WEBHOOK_TYPE env: the alert never posted (test run 37008010743).
    expect(job).not.toContain('SLACK_WEBHOOK_TYPE')
    expect(job).toMatch(/webhook-type:\s*incoming-webhook\s*$/m)
    expect(job).toContain('webhook: ${{ env.SLACK_WEBHOOK_URL }}')
    // still skipped (not failed) when the secret is unset
    expect(job).toContain("if: ${{ env.SLACK_WEBHOOK_URL != '' }}")
  })

  it('notify-failure keeps if: failure() and needs every job including changes', () => {
    const job = jobText(NOTIFY_JOB)
    expect(job).toMatch(/^ {4}if: failure\(\)\s*$/m)
    expect(job).toMatch(
      /needs:\s*\[\s*changes\s*,\s*mutation\s*,\s*flaky-test-repeat\s*,\s*trivy-image\s*,\s*e2e\s*\]/
    )
  })

  it('never uses continue-on-error and gives every job a timeout', () => {
    const withoutComments = nightly
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(withoutComments).not.toContain('continue-on-error')
    for (const [id, text] of [...jobs.entries()]) {
      expect(text, id).toMatch(/^ {4}timeout-minutes:\s*\d+/m)
    }
  })
})

describe('nightly flaky repeat matrix', () => {
  const job = jobText('flaky-test-repeat')

  it('is a 5-leg matrix (repeat 1..5), fail-fast off, named per leg', () => {
    expect(job).toMatch(/fail-fast:\s*false/)
    expect(job).toMatch(/repeat:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]/)
    expect(job).toContain('name: Flaky Test Repeat Run (${{ matrix.repeat }}/5)')
  })

  it('runs the suite once per leg: no for loop, no DB reset, one forced turbo test', () => {
    expect(job).not.toMatch(/\bfor\s+\w+\s+in\b/)
    expect(job).not.toContain('DROP SCHEMA')
    expect(job.match(/pnpm turbo test --force/g)).toHaveLength(1)
    expect(job.match(/pnpm db:migrate/g)).toHaveLength(1)
    expect(job).toContain('ALTER ROLE vault_admin')
    expect(job).toContain('=== flaky-test-repeat: run ${{ matrix.repeat }}/5 ===')
  })

  it('keeps a measured-basis timeout of at least the observed 1h17m run', () => {
    const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(job)?.[1])
    expect(minutes).toBeGreaterThanOrEqual(90)
    expect(minutes).toBeLessThanOrEqual(180)
  })
})
