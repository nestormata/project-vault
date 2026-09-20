import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { deriveKey, HKDF_INFO } from './kdf.js'

describe('Story 42.4: deriveKey — determinism and context-separation (load-bearing key hierarchy property)', () => {
  it('is deterministic: the same ikm + info derives the same 32-byte output twice', () => {
    const ikm = randomBytes(32)
    const first = deriveKey(ikm, HKDF_INFO.PRIMARY)
    const second = deriveKey(ikm, HKDF_INFO.PRIMARY)

    expect(first).toHaveLength(32)
    expect(first.equals(second)).toBe(true)
  })

  // This is the single most load-bearing property in this file — architecture.md's "vault and
  // the key hierarchy" section states that "compromising a backup archive... does not yield the
  // key that would let an attacker forge audit rows" — that guarantee rests entirely on different
  // HKDF_INFO labels producing different keys from the same ikm. Zero prior test coverage before
  // this story.
  it('different HKDF_INFO labels derive different 32-byte keys from the same ikm (context separation)', () => {
    const ikm = randomBytes(32)
    const primary = deriveKey(ikm, HKDF_INFO.PRIMARY)
    const audit = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)
    const backup = deriveKey(ikm, HKDF_INFO.BACKUP)
    const platformAudit = deriveKey(ikm, HKDF_INFO.PLATFORM_AUDIT)
    const exportKey = deriveKey(ikm, HKDF_INFO.EXPORT)

    const labeled: Array<[string, Buffer]> = [
      ['PRIMARY', primary],
      ['AUDIT_LOG', audit],
      ['BACKUP', backup],
      ['PLATFORM_AUDIT', platformAudit],
      ['EXPORT', exportKey],
    ]
    for (const [nameA, keyA] of labeled) {
      for (const [nameB, keyB] of labeled) {
        if (nameA === nameB) continue
        expect(keyA.equals(keyB)).toBe(false)
      }
    }
  })

  // Documents (via a test, not just a comment) that this file performs no IKM-length validation
  // of its own — Node's hkdfSync accepts any-length IKM per RFC 5869 §2.2 — and relies entirely
  // on its callers (key-service.ts's readKeyFile/readEnvelopeFileHalf/KMS's fixed 32-byte
  // contract) to reject bad-length input before it ever reaches deriveKey. A zero-length ikm does
  // not throw, and produces a key that is not a silent repeat of a well-formed derivation.
  it('does not validate ikm length itself — a zero-length ikm does not throw and does not silently repeat a well-formed derivation', () => {
    const emptyIkm = Buffer.alloc(0)
    const wellFormedIkm = randomBytes(32)

    expect(() => deriveKey(emptyIkm, HKDF_INFO.PRIMARY)).not.toThrow()
    const fromEmpty = deriveKey(emptyIkm, HKDF_INFO.PRIMARY)
    const fromWellFormed = deriveKey(wellFormedIkm, HKDF_INFO.PRIMARY)

    expect(fromEmpty).toHaveLength(32)
    expect(fromEmpty.equals(fromWellFormed)).toBe(false)
  })

  // Pins the literal HKDF_INFO string values — changing any of them would be a breaking
  // key-rotation event for every existing vault, far outside any single story's scope. An
  // accidental edit must be caught immediately by this test, not silently re-derive every
  // existing vault's keys differently.
  it('pins the exact HKDF_INFO literal string values', () => {
    expect(HKDF_INFO.PRIMARY).toBe('project-vault-v1')
    expect(HKDF_INFO.AUDIT_LOG).toBe('project-vault-audit-log-v1')
    expect(HKDF_INFO.BACKUP).toBe('project-vault-backup-v1')
    expect(HKDF_INFO.PLATFORM_AUDIT).toBe('project-vault-platform-audit-v1')
    expect(HKDF_INFO.EXPORT).toBe('project-vault-export-v1')
  })
})
