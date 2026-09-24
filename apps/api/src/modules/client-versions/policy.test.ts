import { describe, expect, it, vi } from 'vitest'
import {
  buildClientVersionPolicyData,
  ENV_WITHDRAWN_REASON,
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

describe('strictReleaseVersionOrNull (AC-7 current)', () => {
  it.each<[{ version: string; isRelease: boolean }, string | null]>([
    [RELEASE, '1.3.0'],
    [{ version: '1.3.0-hotfix2', isRelease: true }, null],
    [{ version: '2026.09', isRelease: true }, null],
    [{ version: 'v1.3.0', isRelease: true }, null],
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

  it('never warns about the release version for a dev server', () => {
    const log = logger()
    resolveCliVersionPolicy({ minimumSupported: '9.0.0', withdrawn: ['dev'] }, NO_BAKED, log, DEV)
    expect(log.warn).not.toHaveBeenCalled()
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
