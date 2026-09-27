// Story 43.7 AC-1 / AC-4 (D5, D6): view-model helpers for the CLI Version Policy section.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { CliVersionPolicy } from '$lib/api/platform.js'
import {
  ADMINISTRATOR_WITHDRAWN_REASON,
  deriveCliPolicyWarnings,
  describeCurrent,
  hasAdministratorWithdrawals,
} from './cli-version-policy-view.js'

const here = dirname(fileURLToPath(import.meta.url))

function policy(
  cli: Partial<CliVersionPolicy['cli']> = {},
  server: CliVersionPolicy['server'] = { version: '1.3.0', versionSource: 'release' }
): CliVersionPolicy {
  return {
    server,
    cli: { current: '1.3.0', minimumSupported: null, withdrawn: [], ...cli },
  }
}

function withdrawnOf(...versions: string[]) {
  return versions.map((version) => ({ version, reason: 'x' }))
}

const MIN_WARNING = /minimum supported version \((.+)\) is above this server's release \((.+)\)/i
const WITHDRAWN_WARNING = /this server's own release \((.+)\) is in the withdrawn list/i

describe('deriveCliPolicyWarnings (AC-4)', () => {
  it.each<[string, string | null, string | null, boolean]>([
    ['min above current', '1.3.0', '1.4.0', true],
    ['min equal to current', '1.3.0', '1.3.0', false],
    ['numeric, not lexical (1.10.0 vs 1.9.0)', '1.10.0', '1.9.0', false],
    ['numeric, not lexical (1.9.0 vs 1.10.0)', '1.9.0', '1.10.0', true],
    ['major dominates (2.0.0 vs 1.99.99)', '2.0.0', '1.99.99', false],
    ['patch above', '1.3.0', '1.3.1', true],
    ['no current (dev build)', null, '9.9.9', false],
    ['no minimum', '1.3.0', null, false],
    ['non-strict minimum (defence in depth)', '1.3.0', '1.4.0-rc.1', false],
    ['non-strict current (defence in depth)', '1.3', '1.4.0', false],
    ['leading-zero minimum', '1.3.0', '01.4.0', false],
    ['numeric part above MAX_SAFE_INTEGER', '1.3.0', '99999999999999999999.0.0', false],
  ])('%s → minimum warning %s', (_label, current, minimumSupported, expected) => {
    const warnings = deriveCliPolicyWarnings(policy({ current, minimumSupported }))
    expect(warnings.some((line) => MIN_WARNING.test(line))).toBe(expected)
  })

  it('the minimum warning names both versions with the binding copy', () => {
    expect(
      deriveCliPolicyWarnings(policy({ current: '1.3.0', minimumSupported: '1.4.0' }))
    ).toEqual([
      "The minimum supported version (1.4.0) is above this server's release (1.3.0). Every pvault up to this server's own release is told it is below the minimum.",
    ])
  })

  it('own release withdrawn → the withdrawn warning (exact match)', () => {
    expect(deriveCliPolicyWarnings(policy({ withdrawn: withdrawnOf('1.3.0') }))).toEqual([
      "This server's own release (1.3.0) is in the withdrawn list. pvault 1.3.0, the matching client for this server, refuses to run.",
    ])
  })

  it('near-misses of the release are not an exact match → no warning', () => {
    expect(
      deriveCliPolicyWarnings(policy({ withdrawn: withdrawnOf('1.3.0-rc.1', '1.3.00', ' 1.3.0') }))
    ).toEqual([])
  })

  it('no current → no warnings at all, whatever the minimum or withdrawn list says', () => {
    expect(
      deriveCliPolicyWarnings(
        policy({ current: null, minimumSupported: '9.9.9', withdrawn: withdrawnOf('1.0.0') })
      )
    ).toEqual([])
  })

  it('both conditions → both lines, minimum first', () => {
    const warnings = deriveCliPolicyWarnings(
      policy({ current: '1.3.0', minimumSupported: '1.4.0', withdrawn: withdrawnOf('1.3.0') })
    )
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(MIN_WARNING)
    expect(warnings[1]).toMatch(WITHDRAWN_WARNING)
  })
})

describe('describeCurrent (AC-1)', () => {
  it('a string current → version', () => {
    expect(describeCurrent(policy({ current: '1.3.0' }))).toEqual({
      kind: 'version',
      version: '1.3.0',
    })
  })

  it('null current on a development server → development', () => {
    expect(
      describeCurrent(policy({ current: null }, { version: 'dev', versionSource: 'development' }))
    ).toEqual({ kind: 'development' })
  })

  it('null current on a release server → non-strict release naming the raw version', () => {
    expect(
      describeCurrent(
        policy({ current: null }, { version: '1.3.0-hotfix2', versionSource: 'release' })
      )
    ).toEqual({ kind: 'non_strict_release', serverVersion: '1.3.0-hotfix2' })
  })
})

describe('hasAdministratorWithdrawals (AC-1 D5)', () => {
  it('true when any reason is the fixed env reason', () => {
    expect(
      hasAdministratorWithdrawals(
        policy({
          withdrawn: [
            { version: '1.0.0', reason: 'Known-bad build.' },
            { version: '1.2.1', reason: ADMINISTRATOR_WITHDRAWN_REASON },
          ],
        })
      )
    ).toBe(true)
  })

  it('false when no reason matches, and for an empty list', () => {
    expect(
      hasAdministratorWithdrawals(
        policy({ withdrawn: [{ version: '1.0.0', reason: 'Known-bad build.' }] })
      )
    ).toBe(false)
    expect(hasAdministratorWithdrawals(policy({ withdrawn: [] }))).toBe(false)
  })
})

describe('ADMINISTRATOR_WITHDRAWN_REASON parity with the API (D5)', () => {
  it('matches apps/api policy.ts ENV_WITHDRAWN_REASON (read as text; apps/web has no api dependency)', () => {
    const apiPolicy = readFileSync(
      resolve(here, '../../../../api/src/modules/client-versions/policy.ts'),
      'utf-8'
    )
    expect(apiPolicy).toContain(
      `export const ENV_WITHDRAWN_REASON = ${JSON.stringify(ADMINISTRATOR_WITHDRAWN_REASON)}`
    )
  })
})
