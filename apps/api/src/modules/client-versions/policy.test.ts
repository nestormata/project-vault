import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import {
  buildClientVersionPolicyData,
  CLI_MAX_REASON_CODE_POINTS,
  CLI_MAX_VERSION_LENGTH,
  CLI_MAX_WITHDRAWN_ENTRIES,
  ENV_WITHDRAWN_REASON,
  isCliAcceptedReleaseVersion,
  isCliAcceptedVersion,
  parseCliWithdrawnVersions,
  resolveCliVersionPolicy,
  strictReleaseVersionOrNull,
  type BakedCliVersionPolicy,
} from './policy.js'

const NO_BAKED: BakedCliVersionPolicy = { minimumSupported: null, withdrawn: [] }
const RELEASE = { version: '1.3.0', isRelease: true }
const DEV = { version: 'dev', isRelease: false }

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

describe('parseCliWithdrawnVersions', () => {
  it.each<[string | undefined, string[]]>([
    [undefined, []],
    ['', []],
    ['1.2.1, 1.2.2', ['1.2.1', '1.2.2']],
    ['1.2.1,,', ['1.2.1']],
    ['1.2.1,1.2.1', ['1.2.1']],
    ['1.3.0-rc.1', ['1.3.0-rc.1']],
  ])('%j → %j', (raw, expected) => {
    expect(parseCliWithdrawnVersions(raw)).toEqual({ ok: true, versions: expected })
  })

  it.each(['v1.2.1', '1.2', 'latest', '1.2.1+build', '01.2.1'])('rejects %j naming it', (bad) => {
    const result = parseCliWithdrawnVersions(`1.0.0,${bad}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(bad)
  })

  it('rejects more than 50 entries', () => {
    const raw = Array.from({ length: 51 }, (_, i) => `1.0.${i}`).join(',')
    expect(parseCliWithdrawnVersions(raw).ok).toBe(false)
  })
})

// The pvault CLI rejects the WHOLE policy if any one value breaks its parser's limits, which would
// silently disable withdrawal enforcement — so the server must never serve such a value.
const MAX_SAFE = String(Number.MAX_SAFE_INTEGER)
const UNSAFE = String(Number.MAX_SAFE_INTEGER + 1)
const LONGEST_ACCEPTED = `1.0.0-${'a'.repeat(CLI_MAX_VERSION_LENGTH - 6)}`
const TOO_LONG = `${LONGEST_ACCEPTED}a`

describe('CLI parser limits', () => {
  it('match the limits the pvault CLI enforces', () => {
    expect(CLI_MAX_VERSION_LENGTH).toBe(128)
    expect(CLI_MAX_WITHDRAWN_ENTRIES).toBe(100)
    expect(CLI_MAX_REASON_CODE_POINTS).toBe(200)
  })

  it.each([
    `${MAX_SAFE}.0.0`,
    `0.${MAX_SAFE}.0`,
    `0.0.${MAX_SAFE}`,
    `1.0.0-${MAX_SAFE}`,
    `1.0.0-rc.${MAX_SAFE}`,
    `1.0.0-${'9'.repeat(30)}x`,
    LONGEST_ACCEPTED,
  ])('accepts %s', (version) => {
    expect(isCliAcceptedVersion(version)).toBe(true)
  })

  it.each([
    `${UNSAFE}.0.0`,
    `0.${UNSAFE}.0`,
    `0.0.${UNSAFE}`,
    `1.0.0-${UNSAFE}`,
    `1.0.0-rc.${UNSAFE}`,
    TOO_LONG,
    'v1.0.0',
    '1.0.0+build',
  ])('rejects %s', (version) => {
    expect(isCliAcceptedVersion(version)).toBe(false)
  })

  it('release versions additionally reject a prerelease', () => {
    expect(isCliAcceptedReleaseVersion('1.2.3')).toBe(true)
    expect(isCliAcceptedReleaseVersion('1.2.3-rc.1')).toBe(false)
    expect(isCliAcceptedReleaseVersion(`${UNSAFE}.0.0`)).toBe(false)
  })
})

describe('parseCliWithdrawnVersions — CLI parser limits', () => {
  it.each([`${UNSAFE}.0.0`, `1.0.0-rc.${UNSAFE}`])('rejects %s naming it', (bad) => {
    const result = parseCliWithdrawnVersions(`1.0.0,${bad}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(bad)
  })

  it('rejects a version longer than the CLI accepts', () => {
    const result = parseCliWithdrawnVersions(`1.0.0,${TOO_LONG}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(`${CLI_MAX_VERSION_LENGTH}`)
  })

  it('accepts the longest version the CLI accepts', () => {
    expect(parseCliWithdrawnVersions(LONGEST_ACCEPTED)).toEqual({
      ok: true,
      versions: [LONGEST_ACCEPTED],
    })
  })

  it('rejects an effective (baked plus configured) list larger than the CLI accepts', () => {
    const baked = Array.from({ length: 60 }, (_, i) => `2.0.${i}`)
    const configured = Array.from({ length: 41 }, (_, i) => `1.0.${i}`).join(',')
    const result = parseCliWithdrawnVersions(configured, baked)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/101 .*at most 100/)
  })

  it('counts a version listed both baked and configured once', () => {
    const baked = Array.from({ length: 60 }, (_, i) => `1.0.${i}`)
    const configured = Array.from({ length: 50 }, (_, i) => `1.0.${i + 10}`).join(',')
    expect(parseCliWithdrawnVersions(configured, baked).ok).toBe(true)
  })
})

describe('strictReleaseVersionOrNull (AC-7 current)', () => {
  it.each<[{ version: string; isRelease: boolean }, string | null]>([
    [RELEASE, '1.3.0'],
    [{ version: '1.3.0-hotfix2', isRelease: true }, null],
    [{ version: '2026.09', isRelease: true }, null],
    [{ version: 'v1.3.0', isRelease: true }, null],
    [{ version: `${UNSAFE}.0.0`, isRelease: true }, null],
    [DEV, null],
  ])('%j → %j', (release, expected) => {
    expect(strictReleaseVersionOrNull(release)).toBe(expected)
  })
})

describe('resolveCliVersionPolicy — tighten-only merge (D5)', () => {
  it('no baked policy and no env → empty policy', () => {
    const log = logger()
    expect(resolveCliVersionPolicy({ withdrawn: [] }, NO_BAKED, log, RELEASE)).toEqual({
      minimumSupported: null,
      withdrawn: [],
    })
  })

  it('effective minimum is the higher of baked and env', () => {
    const baked = { minimumSupported: '1.1.0', withdrawn: [] }
    expect(
      resolveCliVersionPolicy(
        { minimumSupported: '1.2.0', withdrawn: [] },
        baked,
        logger(),
        RELEASE
      ).minimumSupported
    ).toBe('1.2.0')
  })

  it('an env minimum lower than the baked one is ignored with one boot warning naming both', () => {
    const log = logger()
    const baked = { minimumSupported: '1.2.0', withdrawn: [] }
    const policy = resolveCliVersionPolicy(
      { minimumSupported: '1.0.0', withdrawn: [] },
      baked,
      log,
      RELEASE
    )
    expect(policy.minimumSupported).toBe('1.2.0')
    const warnings = log.warn.mock.calls.map((c) => JSON.stringify(c))
    expect(warnings.filter((w) => w.includes('1.0.0') && w.includes('1.2.0'))).toHaveLength(1)
  })

  it('withdrawn is baked ∪ env, baked reason kept for duplicates, env gets the fixed reason', () => {
    const baked = {
      minimumSupported: null,
      withdrawn: [{ version: '1.2.1', reason: 'Upstream advisory.' }],
    }
    const policy = resolveCliVersionPolicy(
      { withdrawn: ['1.2.1', '1.2.2'] },
      baked,
      logger(),
      RELEASE
    )
    expect(policy.withdrawn).toEqual([
      { version: '1.2.1', reason: 'Upstream advisory.', source: 'baked' },
      { version: '1.2.2', reason: ENV_WITHDRAWN_REASON, source: 'env' },
    ])
    expect(ENV_WITHDRAWN_REASON).toBe("Withdrawn by this server's administrator.")
  })

  it('logs one info line with the effective policy (versions and provenance, never reasons)', () => {
    const log = logger()
    resolveCliVersionPolicy(
      { minimumSupported: '1.1.0', withdrawn: ['1.2.2'] },
      { minimumSupported: null, withdrawn: [{ version: '1.2.1', reason: 'secret-ish text' }] },
      log,
      RELEASE
    )
    expect(log.info).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(log.info.mock.calls[0])
    expect(logged).toContain('1.1.0')
    expect(logged).toContain('1.2.1')
    expect(logged).toContain('baked')
    expect(logged).toContain('env')
    expect(logged).not.toContain('secret-ish text')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('warns when the effective minimum is above the server release version', () => {
    const log = logger()
    resolveCliVersionPolicy({ minimumSupported: '1.4.0', withdrawn: [] }, NO_BAKED, log, RELEASE)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('warns when the server release version itself is withdrawn', () => {
    const log = logger()
    resolveCliVersionPolicy({ withdrawn: ['1.3.0'] }, NO_BAKED, log, RELEASE)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('tags every boot log line with a registered eventType and the system traceId', () => {
    const log = logger()
    resolveCliVersionPolicy(
      { minimumSupported: '1.0.0', withdrawn: ['1.3.0'] },
      { minimumSupported: '1.4.0', withdrawn: [] },
      log,
      RELEASE
    )
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      eventType: OperationalEvent.CLI_VERSION_POLICY_EFFECTIVE,
      traceId: SYSTEM_TRACE_ID,
    })
    const warnEvents = log.warn.mock.calls.map(
      (call) => (call[0] as { eventType?: unknown }).eventType
    )
    expect(warnEvents).toEqual([
      OperationalEvent.CLI_VERSION_POLICY_ENV_MINIMUM_IGNORED,
      OperationalEvent.CLI_VERSION_POLICY_SELF_CONTRADICTION,
      OperationalEvent.CLI_VERSION_POLICY_SELF_CONTRADICTION,
    ])
    for (const call of log.warn.mock.calls) {
      expect(call[0]).toMatchObject({ traceId: SYSTEM_TRACE_ID })
    }
  })

  it('never warns about the release version for a dev server', () => {
    const log = logger()
    resolveCliVersionPolicy({ minimumSupported: '9.0.0', withdrawn: ['1.3.0'] }, NO_BAKED, log, DEV)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('resolveCliVersionPolicy — never serves a policy the CLI would reject', () => {
  it('fails when the effective withdrawn list exceeds the CLI limit', () => {
    const baked = {
      minimumSupported: null,
      withdrawn: Array.from({ length: 60 }, (_, i) => ({ version: `2.0.${i}`, reason: 'r' })),
    }
    const configured = Array.from({ length: 41 }, (_, i) => `1.0.${i}`)
    expect(() =>
      resolveCliVersionPolicy({ withdrawn: configured }, baked, logger(), RELEASE)
    ).toThrow(/101 .*at most 100/)
  })

  it('accepts exactly 100 effective withdrawn versions', () => {
    const baked = {
      minimumSupported: null,
      withdrawn: Array.from({ length: 60 }, (_, i) => ({ version: `2.0.${i}`, reason: 'r' })),
    }
    const configured = Array.from({ length: 40 }, (_, i) => `1.0.${i}`)
    const policy = resolveCliVersionPolicy({ withdrawn: configured }, baked, logger(), RELEASE)
    expect(policy.withdrawn).toHaveLength(100)
  })

  it.each([`${UNSAFE}.0.0`, TOO_LONG, 'dev'])('fails on a withdrawn version %s', (version) => {
    expect(() =>
      resolveCliVersionPolicy({ withdrawn: [version] }, NO_BAKED, logger(), RELEASE)
    ).toThrow(/withdrawn/)
    const baked = { minimumSupported: null, withdrawn: [{ version, reason: 'r' }] }
    expect(() => resolveCliVersionPolicy({ withdrawn: [] }, baked, logger(), RELEASE)).toThrow(
      /withdrawn/
    )
  })

  it('fails on a withdrawn reason longer than the CLI accepts', () => {
    const baked = {
      minimumSupported: null,
      withdrawn: [{ version: '1.2.1', reason: '😀'.repeat(CLI_MAX_REASON_CODE_POINTS + 1) }],
    }
    expect(() => resolveCliVersionPolicy({ withdrawn: [] }, baked, logger(), RELEASE)).toThrow(
      /reason/
    )
  })

  it('accepts a reason of exactly the CLI limit in code points', () => {
    const baked = {
      minimumSupported: null,
      withdrawn: [{ version: '1.2.1', reason: '😀'.repeat(CLI_MAX_REASON_CODE_POINTS) }],
    }
    expect(() => resolveCliVersionPolicy({ withdrawn: [] }, baked, logger(), RELEASE)).not.toThrow()
  })

  it.each([`${UNSAFE}.0.0`, '1.2.0-rc.1'])('fails on a minimum %s', (minimum) => {
    expect(() =>
      resolveCliVersionPolicy(
        { minimumSupported: minimum, withdrawn: [] },
        NO_BAKED,
        logger(),
        RELEASE
      )
    ).toThrow(/minimum/)
    const baked = { minimumSupported: minimum, withdrawn: [] }
    expect(() => resolveCliVersionPolicy({ withdrawn: [] }, baked, logger(), RELEASE)).toThrow(
      /minimum/
    )
  })
})

describe('buildClientVersionPolicyData (AC-7 response)', () => {
  const effective = {
    minimumSupported: '1.1.0',
    withdrawn: [{ version: '1.2.1', reason: 'r', source: 'baked' as const }],
  }

  it('release server', () => {
    expect(buildClientVersionPolicyData(effective, RELEASE)).toEqual({
      schemaVersion: 1,
      server: { version: '1.3.0', versionSource: 'release' },
      clients: {
        cli: {
          current: '1.3.0',
          minimumSupported: '1.1.0',
          withdrawn: [{ version: '1.2.1', reason: 'r' }],
        },
      },
    })
  })

  it('dev server → current null, versionSource development', () => {
    const data = buildClientVersionPolicyData(effective, DEV)
    expect(data.server).toEqual({ version: 'dev', versionSource: 'development' })
    expect(data.clients.cli.current).toBeNull()
  })

  it.each(['1.3.0-hotfix2', '2026.09', 'v1.3.0'])(
    'non-strict RELEASE_VERSION %s → current null, raw server.version, policy intact',
    (version) => {
      const data = buildClientVersionPolicyData(effective, { version, isRelease: true })
      expect(data.server.version).toBe(version)
      expect(data.clients.cli.current).toBeNull()
      expect(data.clients.cli.minimumSupported).toBe('1.1.0')
      expect(data.clients.cli.withdrawn).toHaveLength(1)
    }
  )
})
