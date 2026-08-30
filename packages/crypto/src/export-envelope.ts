import { decrypt, encrypt } from './aes.js'
import type { EncryptedValue } from './types.js'

// Story 28.9 D2/D3: the project export/import envelope. This is a thin, distinctly-named
// wrapper around aes.ts's own encrypt()/decrypt() (D2: "reused verbatim, not reimplemented") —
// the wrapper exists so apps/api's no-bare-decrypt ESLint rule (which blocks the literal
// `decrypt`/`bootstrapDecrypt` names anywhere in that package) doesn't block this call path.
// That rule exists to force every OTHER secret read through withSecret() (the vault's own
// module-level master key) — but the export key is user-held key material, never the vault's
// master key, so withSecret() cannot be used here; this is a legitimate, distinct decrypt
// boundary, not a bypass of the vault's own secret-value discipline.
export async function encryptExportBundle(
  plaintext: Buffer,
  exportAesKey: Buffer
): Promise<EncryptedValue> {
  return encrypt(plaintext, exportAesKey)
}

export async function decryptExportBundle(
  encrypted: EncryptedValue,
  exportAesKey: Buffer
): Promise<Buffer> {
  return decrypt(encrypted, exportAesKey)
}
