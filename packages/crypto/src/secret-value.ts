import { decrypt } from './aes.js'
import type { EncryptedValue } from './types.js'

const REDACTED = '[REDACTED]'

// Module-level active key — injected by vault service at unseal time.
// withSecret(encrypted, fn) takes exactly 2 args (no key param) so call sites
// never thread the key through every layer. The vault guard ensures withSecret()
// is never reached while sealed, so _activeKey is set whenever this runs normally.
let _activeKey: Buffer | null = null

export function setVaultKey(key: Buffer): void {
  if (_activeKey) _activeKey.fill(0)
  _activeKey = Buffer.from(key) // own copy — caller may zero their copy independently
}

export function clearVaultKey(): void {
  if (_activeKey) {
    _activeKey.fill(0)
    _activeKey = null
  }
}

export function isVaultKeySet(): boolean {
  return _activeKey !== null
}

export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  use<T>(fn: (plaintext: string) => T): T {
    return fn(this.#value)
  }

  toJSON(): string {
    return REDACTED
  }
  toString(): string {
    return REDACTED
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED
  }
}

/**
 * Decrypt an encrypted value and pass the plaintext Buffer to fn().
 * The Buffer is zeroed in finally{} — plaintext never outlives the callback.
 */
export async function withSecret<T>(
  encrypted: EncryptedValue,
  fn: (plaintext: Buffer) => Promise<T>
): Promise<T> {
  if (!_activeKey) {
    throw new Error(
      'withSecret: vault is sealed — ensure vault is unsealed before accessing secrets'
    )
  }
  const plaintext = await decrypt(encrypted, _activeKey)
  try {
    return await fn(plaintext)
  } finally {
    plaintext.fill(0)
  }
}
