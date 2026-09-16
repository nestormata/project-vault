import { describe, expect, it } from 'vitest'
import {
  VaultInitRequestSchema,
  VaultInitResponseSchema,
  VaultUnsealRequestSchema,
  VaultUnsealResponseSchema,
  VaultErrorResponseSchema,
} from './vault.js'

const VALID_PASSPHRASE = 'a-passphrase-that-is-long-enough'
const KEY_PATH = '/path/to/key'

describe('VaultInitRequestSchema', () => {
  it('accepts a valid passphrase init request', () => {
    expect(
      VaultInitRequestSchema.safeParse({
        kmsType: 'passphrase',
        passphrase: VALID_PASSPHRASE,
      }).success
    ).toBe(true)
  })

  it('rejects a passphrase shorter than 12 characters', () => {
    expect(
      VaultInitRequestSchema.safeParse({ kmsType: 'passphrase', passphrase: 'short' }).success
    ).toBe(false)
  })

  it('accepts a valid envelope init request with the acknowledgement flag', () => {
    expect(
      VaultInitRequestSchema.safeParse({
        kmsType: 'envelope',
        envelopeKeyPath: KEY_PATH,
        acknowledgeSplitKeyModel: true,
      }).success
    ).toBe(true)
  })

  it('rejects an envelope init request missing the acknowledgement flag', () => {
    expect(
      VaultInitRequestSchema.safeParse({
        kmsType: 'envelope',
        envelopeKeyPath: KEY_PATH,
      }).success
    ).toBe(false)
  })

  it('accepts a valid file init request with the acknowledgement flag', () => {
    expect(
      VaultInitRequestSchema.safeParse({
        kmsType: 'file',
        masterKeyPath: KEY_PATH,
        acknowledgeCoLocationRisk: true,
      }).success
    ).toBe(true)
  })

  // Story 1.14 AC-8: kms mode is the most-secure mode, so it deliberately takes no
  // acknowledge* flag — a caller passing one anyway should not be silently stripped.
  it('accepts a valid kms init request with no acknowledgement flag required', () => {
    expect(
      VaultInitRequestSchema.safeParse({ kmsType: 'kms', kmsKeyId: 'projects/x/keys/y' }).success
    ).toBe(true)
  })

  it('rejects an unknown kmsType', () => {
    expect(VaultInitRequestSchema.safeParse({ kmsType: 'unknown' }).success).toBe(false)
  })
})

describe('VaultInitResponseSchema', () => {
  it('validates a successful init response', () => {
    expect(
      VaultInitResponseSchema.safeParse({
        initialized: true,
        keyVersion: 1,
        kmsType: 'passphrase',
      }).success
    ).toBe(true)
  })
})

describe('VaultUnsealRequestSchema', () => {
  it('accepts exactly one legacy unseal field', () => {
    expect(VaultUnsealRequestSchema.safeParse({ passphrase: VALID_PASSPHRASE }).success).toBe(true)
    expect(VaultUnsealRequestSchema.safeParse({ envelopeKeyPath: KEY_PATH }).success).toBe(true)
    expect(VaultUnsealRequestSchema.safeParse({ masterKeyPath: KEY_PATH }).success).toBe(true)
  })

  it('accepts zero fields (kms mode has none to provide)', () => {
    expect(VaultUnsealRequestSchema.safeParse({}).success).toBe(true)
  })

  // Story 1.14 AC-10: the Zod layer can't know the stored kms_type, so it only enforces
  // "at most one legacy field" — per-mode requiredness is checked server-side.
  it('rejects more than one legacy unseal field', () => {
    expect(
      VaultUnsealRequestSchema.safeParse({
        passphrase: VALID_PASSPHRASE,
        envelopeKeyPath: KEY_PATH,
      }).success
    ).toBe(false)
  })
})

describe('VaultUnsealResponseSchema', () => {
  it('validates a successful unseal response', () => {
    expect(
      VaultUnsealResponseSchema.safeParse({
        unsealed: true,
        keyVersion: 1,
        kmsType: 'kms',
      }).success
    ).toBe(true)
  })
})

describe('VaultErrorResponseSchema', () => {
  it('validates the {error, message} vault error shape', () => {
    expect(
      VaultErrorResponseSchema.safeParse({ error: 'sealed', message: 'Vault is sealed' }).success
    ).toBe(true)
  })
})
