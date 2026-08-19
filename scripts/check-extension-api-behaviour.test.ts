import { describe, expect, it } from 'vitest'
import {
  checkBehaviourContract,
  extractBehaviourContract,
} from './check-extension-api-behaviour.js'

describe('extension API behaviour contract guard', () => {
  it('accepts the checked-in golden file against the real definitions', () => {
    expect(checkBehaviourContract(process.cwd())).toEqual({ ok: true })
  })

  it('captures the current definitions, including loader mapping and timeout', () => {
    const contract = extractBehaviourContract({
      registerSource: 'const REVERSE_DNS_NAME_PATTERN = /^[a-z]+$/\nincludePrerelease: false',
      loaderSource:
        "const DEFAULT_TIMEOUT_MS = 5000\nfunction mapFailureReason(error: unknown) {\n  return error.reason === 'invalid-name' || error.reason === 'invalid-manifest-field'\n    ? 'manifest_invalid'\n    : 'capability_mismatch'\n  }",
    })

    expect(contract).toEqual({
      reverseDnsNamePattern: '/^[a-z]+$/',
      includePrerelease: false,
      loaderTimeoutMs: 5000,
      reasonToStatus:
        'incompatible-version -> capability_mismatch; invalid-manifest-field -> manifest_invalid; invalid-name -> manifest_invalid',
    })
  })

  it('fails closed when a pinned value drifts', () => {
    const result = checkBehaviourContract(process.cwd(), {
      registerSource: 'const REVERSE_DNS_NAME_PATTERN = /^[a-z]+$/\nincludePrerelease: false',
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('REVERSE_DNS_NAME_PATTERN')
  })

  it('fails when the registration-reason mapping changes even if the old literals remain elsewhere', () => {
    const result = checkBehaviourContract(process.cwd(), {
      loaderSource: `
        type ExtensionLoadFailureReason = 'capability_mismatch' | 'manifest_invalid'
        function mapFailureReason(error: unknown) {
          return error instanceof ExtensionRegistrationError ? 'manifest_invalid' : 'import_error'
        }
        const DEFAULT_TIMEOUT_MS = 5000
        // 'incompatible-version' and 'capability_mismatch' remain in documentation
      `,
    })

    expect(result.ok).toBe(false)
  })
})
