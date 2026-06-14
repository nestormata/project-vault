export type EncryptedValue = {
  version: number
  iv: string
  ciphertext: string
  tag: string
}

const REDACTED_MARKER = '[REDACTED]'

export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  use<T>(fn: (plaintext: string) => T): T {
    return fn(this.#value)
  }

  toJSON(): string {
    return REDACTED_MARKER
  }

  toString(): string {
    return REDACTED_MARKER
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED_MARKER
  }
}

export async function withSecret<T>(
  _encrypted: EncryptedValue,
  fn: (plaintext: Buffer) => Promise<T>
): Promise<T> {
  // Story 1.5 implements real decryption
  // Stub: never call in production — throws to surface misuse early
  throw new Error('withSecret is not implemented until Story 1.5')
  // Unreachable but satisfies TypeScript return type analysis
  return fn(Buffer.alloc(0))
}
