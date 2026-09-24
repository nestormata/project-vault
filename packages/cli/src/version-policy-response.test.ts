import { describe, expect, it } from 'vitest'
import {
  MAX_POLICY_BODY_BYTES,
  parseCliVersionPolicyBody,
  validateCliVersionPolicy,
} from './version-policy-response.js'

const REASON = 'Session refresh bug; upgrade immediately.'

function body(cli: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      schemaVersion: 1,
      server: { version: '1.3.0', versionSource: 'release' },
      clients: { cli },
      ...extra,
    },
  })
}

const VALID_CLI = {
  current: '1.3.0',
  minimumSupported: '1.1.0',
  withdrawn: [{ version: '1.2.1', reason: REASON }],
}

describe('parseCliVersionPolicyBody (Story 43.6 AC-1 malformed cases)', () => {
  it('accepts a well-formed response', () => {
    expect(parseCliVersionPolicyBody(body(VALID_CLI))).toEqual(VALID_CLI)
  })

  it('accepts null current and null minimum', () => {
    expect(
      parseCliVersionPolicyBody(body({ current: null, minimumSupported: null, withdrawn: [] }))
    ).toEqual({ current: null, minimumSupported: null, withdrawn: [] })
  })

  it('treats a missing or empty reason as an empty string', () => {
    expect(
      parseCliVersionPolicyBody(
        body({ current: null, minimumSupported: null, withdrawn: [{ version: '1.2.1' }] })
      )?.withdrawn
    ).toEqual([{ version: '1.2.1', reason: '' }])
  })

  it('ignores unknown extra fields and other clients (forward compatibility)', () => {
    const raw = JSON.stringify({
      data: {
        schemaVersion: 2,
        extraKey: true,
        clients: {
          cli: { ...VALID_CLI, downloadUrl: 'https://evil.example/', url: 'x' },
          extension: { anything: 1 },
        },
      },
    })
    expect(parseCliVersionPolicyBody(raw)).toEqual(VALID_CLI)
  })

  it.each<[string, string]>([
    ['non-JSON body', '<html>oops</html>'],
    ['JSON null', 'null'],
    ['missing data', JSON.stringify({})],
    ['missing clients', JSON.stringify({ data: {} })],
    ['missing data.clients.cli', JSON.stringify({ data: { clients: {} } })],
    ['cli not an object', body('nope')],
    ['current not semver', body({ ...VALID_CLI, current: 'latest' })],
    ['current with a v prefix', body({ ...VALID_CLI, current: 'v1.3.0' })],
    ['current with build metadata', body({ ...VALID_CLI, current: '1.3.0+sha' })],
    ['minimum wrong type', body({ ...VALID_CLI, minimumSupported: 5 })],
    ['minimum missing', body({ current: '1.3.0', withdrawn: [] })],
    ['withdrawn not an array', body({ ...VALID_CLI, withdrawn: {} })],
    [
      'withdrawn too long',
      body({
        ...VALID_CLI,
        withdrawn: Array.from({ length: 101 }, (_, i) => ({ version: `1.0.${i}`, reason: 'x' })),
      }),
    ],
    [
      'one bad withdrawn version (all-or-nothing)',
      body({
        ...VALID_CLI,
        withdrawn: [
          { version: '1.2.1', reason: 'ok' },
          { version: 'bad', reason: 'x' },
        ],
      }),
    ],
    ['withdrawn entry not an object', body({ ...VALID_CLI, withdrawn: ['1.2.1'] })],
    ['reason wrong type', body({ ...VALID_CLI, withdrawn: [{ version: '1.2.1', reason: 5 }] })],
    [
      'reason longer than 200 characters',
      body({ ...VALID_CLI, withdrawn: [{ version: '1.2.1', reason: 'r'.repeat(201) }] }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parseCliVersionPolicyBody(raw)).toBeNull()
  })

  it('accepts exactly 100 withdrawn entries and a 200-character reason', () => {
    const withdrawn = Array.from({ length: 100 }, (_, i) => ({
      version: `1.0.${i}`,
      reason: 'r'.repeat(200),
    }))
    expect(parseCliVersionPolicyBody(body({ ...VALID_CLI, withdrawn }))?.withdrawn).toHaveLength(
      100
    )
  })

  it('exports the 16 KiB body cap', () => {
    expect(MAX_POLICY_BODY_BYTES).toBe(16 * 1024)
  })
})

describe('validateCliVersionPolicy', () => {
  it('re-validates an already-parsed policy (used for cached entries)', () => {
    expect(validateCliVersionPolicy(VALID_CLI)).toEqual(VALID_CLI)
    expect(validateCliVersionPolicy({ ...VALID_CLI, current: 1 })).toBeNull()
  })
})
