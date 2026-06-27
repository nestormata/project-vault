// Public types
export type { EncryptedValue } from './types.js'

// Public encryption API — encrypt IS exported (plaintext is the INPUT, not leaked output)
export { encrypt } from './aes.js'

// Key derivation
export { deriveKey, HKDF_INFO } from './kdf.js'

// Safe decryption + vault key lifecycle
export {
  withSecret,
  SecretValue,
  setVaultKey,
  clearVaultKey,
  isVaultKeySet,
} from './secret-value.js'

// Argon2id master passphrase KDF
export {
  deriveIkmFromPassphrase,
  createKeyDerivationParams,
  hashUserPassword,
  passwordHashConfigFromEnv,
  validateKeyDerivationParams,
  verifyUserPassword,
  ARGON2_PARAMS,
} from './passwords.js'
export type { KeyDerivationParams, PasswordHashConfig } from './passwords.js'

// Split-key envelope combination
export { combineEnvelopeHalves, parseEnvelopeEnvHalf } from './envelope.js'

// NOTE: decrypt() from aes.ts is NOT re-exported for general use.
// All plaintext access goes through withSecret() which zeros the buffer in finally.
// The no-bare-decrypt ESLint rule enforces this at compile time.
//
// EXCEPTION: bootstrapDecrypt is the ONLY export of the raw decrypt function.
// It is permitted ONLY in apps/api/src/modules/vault/key-service.ts (unseal bootstrap,
// where the module-level key is not yet set and withSecret() cannot be used).
export { decrypt as bootstrapDecrypt } from './aes.js'
