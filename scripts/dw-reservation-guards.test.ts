import { describe, expect, it } from 'vitest'
import { formatReservationStub, RESERVED_SECTION } from './lib/dw-reservation.js'
import { runScriptCli, useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const makeFixtureRoot = useFixtureRoots('dw-reservation-guards-', [ARTIFACTS_DIR])

const FRESH_STUB = formatReservationStub(2, '66-19', new Date())

function fixtureWith(stub: string): string {
  const root = makeFixtureRoot()
  writeFixture(
    root,
    LEDGER_PATH,
    `# Deferred Work\n\n## Deferred from: x\n\n### DW-1: closed entry\nstatus: done\n\n${RESERVED_SECTION}\n\n${stub}`
  )
  writeFixture(
    root,
    `${ARTIFACTS_DIR}/sprint-status.yaml`,
    'development_status:\n  66-19-fixture: in-progress\n'
  )
  writeFixture(root, `${ARTIFACTS_DIR}/66-19-fixture.md`, '# Fixture\n\nStatus: in-progress\n')
  return root
}

// Story 66-19 AC-2: every other consumer of deferred-work.md must neither fail nor warn on a fresh
// reservation stub. Each guard runs as a real CLI over the same fixture.
const LEDGER_CONSUMERS: [string, string[]][] = [
  ['scripts/check-deferred-work-triggers.ts', []],
  ['scripts/check-review-tradeoff-ledger.ts', []],
  ['scripts/check-story-review-deferrals.ts', []],
  ['scripts/check-followup-review-gate.ts', []],
  ['scripts/check-psc-tbd-tracking.ts', []],
  ['scripts/warn-fired-dw-triggers.ts', []],
  ['scripts/check-deferred-work-ids.ts', []],
]

describe('ledger consumers tolerate a fresh reservation stub (Story 66-19 AC-2)', () => {
  it.each(LEDGER_CONSUMERS)('%s exits 0 with no FATAL/WARN', (script, args) => {
    const run = runScriptCli(script, fixtureWith(FRESH_STUB), args)
    expect(run.stderr).not.toMatch(/FATAL|WARN/)
    expect(run.status).toBe(0)
  })

  it('check-cross-repo-dw-closure (pointed at the ledger) raises no warning for a fresh stub', () => {
    const root = fixtureWith(FRESH_STUB)
    const run = runScriptCli('scripts/check-cross-repo-dw-closure.ts', root, [
      '--cm-path',
      `${root}/${LEDGER_PATH}`,
    ])
    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('WARN')
  })

  it('the trigger guard still rejects a genuinely unknown status word (the stub case is not a blanket pass)', () => {
    const run = runScriptCli(
      'scripts/check-deferred-work-triggers.ts',
      fixtureWith('### DW-2: bogus\nstatus: bogus\n')
    )
    expect(run.status).toBe(1)
  })
})
