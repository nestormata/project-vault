// Story 43.13 AC-5.6 — the web /version page's all-or-nothing validator takes its display caps
// from `@project-vault/shared` (the same constants the API re-exports and the CLI parity test
// checks), so a cap change cannot silently make this page reject a healthy server's policy.
import {
  CLI_MAX_REASON_CODE_POINTS,
  CLI_MAX_VERSION_LENGTH,
  CLI_MAX_WITHDRAWN_ENTRIES,
} from '@project-vault/shared'
import { describe, expect, it } from 'vitest'

import validatorSource from './client-version-policy-validate.ts?raw'
import { parseClientVersionPolicyBody } from './client-version-policy-validate.js'

type Withdrawn = Array<{ version: string; reason: string }>

function body(overrides: { serverVersion?: string; withdrawn?: Withdrawn } = {}): unknown {
  return {
    data: {
      schemaVersion: 1,
      server: { version: overrides.serverVersion ?? '1.3.0', versionSource: 'release' },
      clients: {
        cli: {
          current: '1.3.0',
          minimumSupported: '1.1.0',
          withdrawn: overrides.withdrawn ?? [],
        },
      },
    },
  }
}

function withdrawnList(count: number): Withdrawn {
  return Array.from({ length: count }, (_, i) => ({ version: `1.0.${i}`, reason: 'r' }))
}

describe('parseClientVersionPolicyBody caps come from @project-vault/shared (Story 43.13 AC-5.6)', () => {
  it('accepts a version of exactly CLI_MAX_VERSION_LENGTH characters', () => {
    const version = `1.0.0-${'a'.repeat(CLI_MAX_VERSION_LENGTH - 6)}`
    expect(version).toHaveLength(CLI_MAX_VERSION_LENGTH)
    expect(parseClientVersionPolicyBody(body({ serverVersion: version }))?.server.version).toBe(
      version
    )
  })

  it('rejects the whole body for a version one character over the cap', () => {
    const version = `1.0.0-${'a'.repeat(CLI_MAX_VERSION_LENGTH - 5)}`
    expect(parseClientVersionPolicyBody(body({ serverVersion: version }))).toBeNull()
  })

  it('accepts CLI_MAX_WITHDRAWN_ENTRIES withdrawn entries and rejects one more', () => {
    const atCap = withdrawnList(CLI_MAX_WITHDRAWN_ENTRIES)
    expect(parseClientVersionPolicyBody(body({ withdrawn: atCap }))?.cli.withdrawn).toHaveLength(
      CLI_MAX_WITHDRAWN_ENTRIES
    )
    const overCap = withdrawnList(CLI_MAX_WITHDRAWN_ENTRIES + 1)
    expect(parseClientVersionPolicyBody(body({ withdrawn: overCap }))).toBeNull()
  })

  it('counts the reason cap in code points (astral), accepting n and rejecting n + 1', () => {
    const atCap = '\u{1F600}'.repeat(CLI_MAX_REASON_CODE_POINTS)
    expect(
      parseClientVersionPolicyBody(body({ withdrawn: [{ version: '1.2.1', reason: atCap }] }))?.cli
        .withdrawn[0]?.reason
    ).toBe(atCap)
    const overCap = '\u{1F600}'.repeat(CLI_MAX_REASON_CODE_POINTS + 1)
    expect(
      parseClientVersionPolicyBody(body({ withdrawn: [{ version: '1.2.1', reason: overCap }] }))
    ).toBeNull()
  })

  it('does not re-hardcode the cap values in the validator source', () => {
    expect(validatorSource).toContain('@project-vault/shared')
    expect(validatorSource).not.toMatch(/\b(128|100|200)\b/)
  })
})
