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
        "const DEFAULT_TIMEOUT_MS = 5000\n// 'incompatible-version' -> 'capability_mismatch'",
    })

    expect(contract).toEqual({
      reverseDnsNamePattern: '/^[a-z]+$/',
      includePrerelease: false,
      loaderTimeoutMs: 5000,
      reasonToStatus: 'incompatible-version -> capability_mismatch',
    })
  })

  it('fails closed when a pinned value drifts', () => {
    const result = checkBehaviourContract(process.cwd(), {
      registerSource: 'const REVERSE_DNS_NAME_PATTERN = /^[a-z]+$/\nincludePrerelease: false',
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('REVERSE_DNS_NAME_PATTERN')
  })
})
