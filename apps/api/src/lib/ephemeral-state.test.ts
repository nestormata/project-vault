import { describe, expect, it } from 'vitest'
import {
  EphemeralStateUnboundContextError,
  EphemeralStateValidationError,
  MAX_KEY_LENGTH,
  MAX_LIVE_ENTRIES_PER_ORG,
  MAX_TTL_SECONDS,
  MAX_VALUE_BYTES,
  extensionNamespaceFor,
  validateKeySize,
  validateTtl,
  validateValueSize,
} from './ephemeral-state.js'
import { createEphemeralStateHost } from './ephemeral-state.js'

const FIXTURE_MANIFEST_NAME = 'com.acme.sso-extension'

describe('extensionNamespaceFor — namespace derivation (AC-4)', () => {
  it('derives ext.<manifest.name> from the loaded extension manifest name', () => {
    expect(extensionNamespaceFor(FIXTURE_MANIFEST_NAME)).toBe(`ext.${FIXTURE_MANIFEST_NAME}`)
  })
})

describe('validateTtl — AC-3 (0, 3600] bound', () => {
  it('accepts the inclusive upper bound 3600', () => {
    expect(() => validateTtl(3600)).not.toThrow()
  })
  it('accepts a small positive value', () => {
    expect(() => validateTtl(1)).not.toThrow()
  })
  it('rejects 3601 (just above the ceiling)', () => {
    expect(() => validateTtl(3601)).toThrow(EphemeralStateValidationError)
  })
  it('rejects 0', () => {
    expect(() => validateTtl(0)).toThrow(EphemeralStateValidationError)
  })
  it('rejects a negative value', () => {
    expect(() => validateTtl(-5)).toThrow(EphemeralStateValidationError)
  })
})

describe('validateKeySize — AC-16 (<= 256 chars)', () => {
  it('accepts a 200-character key', () => {
    expect(() => validateKeySize('k'.repeat(200))).not.toThrow()
  })
  it('accepts exactly 256 characters', () => {
    expect(() => validateKeySize('k'.repeat(256))).not.toThrow()
  })
  it('rejects a 300-character key', () => {
    expect(() => validateKeySize('k'.repeat(300))).toThrow(EphemeralStateValidationError)
  })
})

describe('validateValueSize — AC-16 (<= 16 KiB)', () => {
  it('accepts a 64-byte value', () => {
    expect(() => validateValueSize('v'.repeat(64))).not.toThrow()
  })
  it('accepts exactly 16 KiB', () => {
    expect(() => validateValueSize('v'.repeat(16 * 1024))).not.toThrow()
  })
  it('rejects a 20 KiB value', () => {
    expect(() => validateValueSize('v'.repeat(20 * 1024))).toThrow(EphemeralStateValidationError)
  })
})

describe('constants — AC-16/AC-11 literal bounds', () => {
  it('MAX_KEY_LENGTH is 256, MAX_VALUE_BYTES is 16 KiB, MAX_TTL_SECONDS is 3600, cap is 1000', () => {
    expect(MAX_KEY_LENGTH).toBe(256)
    expect(MAX_VALUE_BYTES).toBe(16 * 1024)
    expect(MAX_TTL_SECONDS).toBe(3600)
    expect(MAX_LIVE_ENTRIES_PER_ORG).toBe(1000)
  })
})

describe('createEphemeralStateHost — AC-4 fail-closed on unbound request context', () => {
  it('set()/get()/delete()/compareAndSwap()/compareAndDelete() all reject when no ambient orgId is bound', async () => {
    const host = createEphemeralStateHost(FIXTURE_MANIFEST_NAME)
    await expect(host.set('k', 'v', 60)).rejects.toThrow(EphemeralStateUnboundContextError)
    await expect(host.get('k')).rejects.toThrow(EphemeralStateUnboundContextError)
    await expect(host.delete('k')).rejects.toThrow(EphemeralStateUnboundContextError)
    await expect(host.compareAndSwap('k', null, 'v', 60)).rejects.toThrow(
      EphemeralStateUnboundContextError
    )
    await expect(host.compareAndDelete('k', 'v')).rejects.toThrow(EphemeralStateUnboundContextError)
  })

  it('set() validates size/TTL before ever checking for a bound request context (cheapest check first, AC-16)', async () => {
    const host = createEphemeralStateHost(FIXTURE_MANIFEST_NAME)
    // Oversized key/value and out-of-range TTL must throw the validation error, not the
    // unbound-context error, even though no request context is bound in this test — proves the
    // cheap synchronous checks run first, before any ambient-context/DB work.
    await expect(host.set('k'.repeat(300), 'v', 60)).rejects.toThrow(EphemeralStateValidationError)
    await expect(host.set('k', 'v'.repeat(20 * 1024), 60)).rejects.toThrow(
      EphemeralStateValidationError
    )
    await expect(host.set('k', 'v', 3601)).rejects.toThrow(EphemeralStateValidationError)
  })
})
