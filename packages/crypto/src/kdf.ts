import { hkdfSync } from 'node:crypto'

const KEY_BYTES = 32 // 256-bit AES key

// Canonical info strings — these are the authoritative constants; never hardcode elsewhere
export const HKDF_INFO = {
  PRIMARY: 'project-vault-v1',
  AUDIT_LOG: 'project-vault-audit-log-v1',
  BACKUP: 'project-vault-backup-v1', // Story 9.1 uses this
  PLATFORM_AUDIT: 'project-vault-platform-audit-v1', // Story 9.4 uses this
} as const

/**
 * Derive a 256-bit AES key from master key material (IKM).
 * Salt is intentionally empty: RFC 5869 §3.1 default of HashLen zeros is valid
 * since IKM is uniformly random (≥32 bytes).
 */
export function deriveKey(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_BYTES))
}
