import { describe, expect, it } from 'vitest'
import {
  CLI_MAX_REASON_CODE_POINTS,
  CLI_MAX_VERSION_LENGTH,
  CLI_MAX_WITHDRAWN_ENTRIES,
  isCliAcceptedReleaseVersion,
  isCliAcceptedVersion,
} from '@project-vault/api/client-version-policy'
import { parseStrictSemver } from './semver-precedence.js'
import {
  MAX_REASON_CODE_POINTS,
  MAX_WITHDRAWN_ENTRIES,
  validateCliVersionPolicy,
} from './version-policy-response.js'

/**
 * Story 43.6 — the server validates its CLI version policy at boot against the same limits this
 * CLI enforces. The CLI rejects a policy as a whole on any invalid value, so a drift between the
 * two would silently disable withdrawals. The server cannot import the CLI (the CLI's runtime
 * dependencies are kept minimal), so parity is asserted here.
 */

const UNSAFE = String(Number.MAX_SAFE_INTEGER + 1)
const MAX_SAFE = String(Number.MAX_SAFE_INTEGER)

const VERSIONS = [
  '0.0.0',
  '1.2.3',
  '1.2.3-rc.1',
  '1.2.3-0',
  '1.2.3-alpha-beta.0x',
  '1.2.3-00',
  '1.2.3-rc..1',
  '1.2.3-',
  '01.2.3',
  'v1.2.3',
  '1.2.3+build',
  '1.2',
  '',
  ' 1.2.3',
  `${MAX_SAFE}.0.0`,
  `${UNSAFE}.0.0`,
  `0.${UNSAFE}.0`,
  `0.0.${UNSAFE}`,
  `1.0.0-${MAX_SAFE}`,
  `1.0.0-${UNSAFE}`,
  `1.0.0-rc.${UNSAFE}`,
  `1.0.0-${'9'.repeat(40)}x`,
  `1.0.0-${'a'.repeat(122)}`,
  `1.0.0-${'a'.repeat(123)}`,
  `1.0.${'1'.repeat(125)}`,
]

describe('server/CLI version-policy parity (Story 43.6)', () => {
  it('shares the CLI limits', () => {
    expect(CLI_MAX_WITHDRAWN_ENTRIES).toBe(MAX_WITHDRAWN_ENTRIES)
    expect(CLI_MAX_REASON_CODE_POINTS).toBe(MAX_REASON_CODE_POINTS)
    const longest = `1.0.0-${'a'.repeat(CLI_MAX_VERSION_LENGTH - 6)}`
    expect(parseStrictSemver(longest)).not.toBeNull()
    expect(parseStrictSemver(`${longest}a`)).toBeNull()
  })

  it.each(VERSIONS)('the server accepts %j exactly when the CLI does', (version) => {
    expect(isCliAcceptedVersion(version)).toBe(parseStrictSemver(version) !== null)
  })

  it.each(VERSIONS.filter((v) => isCliAcceptedReleaseVersion(v)))(
    'server-accepted release version %j is a valid current/minimum for the CLI',
    (v) => {
      const policy = { current: v, minimumSupported: v, withdrawn: [] }
      expect(validateCliVersionPolicy(policy)).toEqual(policy)
    }
  )
})
