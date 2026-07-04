import { encrypt, type EncryptedValue } from '@project-vault/crypto'
import { getPrimaryKey } from '../modules/vault/key-service.js'

/** Encrypts a plaintext string with the vault's current primary key, zeroing both the
 *  plaintext buffer and the key copy afterward. Shared by every module that writes a new
 *  `credential_versions` row (credentials create/add-version/import, rotation initiation). */
export async function encryptValue(value: string): Promise<EncryptedValue> {
  const plaintext = Buffer.from(value, 'utf8')
  const key = getPrimaryKey()
  try {
    return await encrypt(plaintext, key)
  } finally {
    plaintext.fill(0)
    key.fill(0)
  }
}
