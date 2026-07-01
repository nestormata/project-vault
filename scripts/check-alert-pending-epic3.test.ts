import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanAlertPendingEpic3 } from './check-alert-pending-epic3.js'

const STUB_MARKER = ['alert', 'pending_epic3'].join('.')
const MFA_FIXTURE_PATH = 'apps/api/src/modules/auth/mfa.ts'
const makeFixtureRoot = useFixtureRoots('project-vault-alert-epic3-', [
  'apps/api/src',
  '_bmad-output/implementation-artifacts',
])

describe('check-alert-pending-epic3', () => {
  it('flags a literal occurrence of the retired stub marker', () => {
    const root = makeFixtureRoot()
    writeFixture(root, MFA_FIXTURE_PATH, `process.stdout.write('{"eventType":"${STUB_MARKER}"}')`)

    const violations = scanAlertPendingEpic3(root)

    expect(violations.map((v) => v.file)).toEqual([MFA_FIXTURE_PATH])
  })

  it('flags split-string obfuscation of the marker', () => {
    const root = makeFixtureRoot()
    writeFixture(root, MFA_FIXTURE_PATH, `const eventType = 'alert' + '.' + 'pending_epic3'`)

    const violations = scanAlertPendingEpic3(root)

    expect(violations).toHaveLength(1)
  })

  it('ignores docs and _bmad-output content', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      '_bmad-output/implementation-artifacts/deferred-work.md',
      `Historical stub reference: ${STUB_MARKER}`
    )

    const violations = scanAlertPendingEpic3(root)

    expect(violations).toHaveLength(0)
  })

  it('passes clean source with no matches', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      MFA_FIXTURE_PATH,
      `await dispatchDirectUserNotification({ orgId, userId, template, tx })`
    )

    expect(scanAlertPendingEpic3(root)).toHaveLength(0)
  })
})
