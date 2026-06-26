import argon2 from 'argon2'
import { randomBytes } from 'node:crypto'

/** Canonical Argon2id params — shared with Story 1.6 user password hashing. */
export const ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  type: argon2.argon2id,
  hashLength: 32, // 256-bit output used directly as HKDF IKM
} as const

const ALLOWED_ARGON2 = { memoryCost: 65536, timeCost: 3, parallelism: 4 } as const

export type KeyDerivationParams = {
  type: 'argon2id'
  salt: string // hex-encoded 16-byte random salt
  memoryCost: number
  timeCost: number
  parallelism: number
}

export type PasswordHashConfig = {
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** Generate new random salt + params for vault init (passphrase mode). */
export function createKeyDerivationParams(): KeyDerivationParams {
  return {
    type: 'argon2id',
    salt: randomBytes(16).toString('hex'),
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
  }
}

/**
 * Derive 32-byte IKM from master passphrase using Argon2id.
 * Passphrase string is owned by the caller — this function does not retain it.
 */
export async function deriveIkmFromPassphrase(
  passphrase: string,
  params: KeyDerivationParams
): Promise<Buffer> {
  if (params.type !== 'argon2id') {
    throw new Error(`deriveIkmFromPassphrase: unsupported type ${params.type}`)
  }
  const hash = await argon2.hash(passphrase, {
    ...ARGON2_PARAMS,
    salt: Buffer.from(params.salt, 'hex'),
    raw: true, // return Buffer, not encoded string
  })
  return Buffer.from(hash)
}

/** Reject params strictly below canonical minimums (allows future increases, blocks tampering downward). */
export function validateKeyDerivationParams(params: KeyDerivationParams): void {
  if (params.type !== 'argon2id') throw new Error('unsupported KDF type')
  if (params.memoryCost < ALLOWED_ARGON2.memoryCost) throw new Error('memoryCost below minimum')
  if (params.timeCost < ALLOWED_ARGON2.timeCost) throw new Error('timeCost below minimum')
  if (params.parallelism < 1 || params.parallelism > 4) throw new Error('parallelism out of range')
  if (!/^[0-9a-f]{32}$/.test(params.salt)) throw new Error('invalid salt')
}

/** Build runtime config from env — single source for master KDF and user passwords. */
export function passwordHashConfigFromEnv(env: PasswordHashConfig): PasswordHashConfig {
  return {
    memoryCost: env.memoryCost,
    timeCost: env.timeCost,
    parallelism: env.parallelism,
  }
}

/**
 * Hash a user password as PHC-encoded Argon2id.
 * The encoded hash embeds salt and Argon2 params; future upgrades can rehash after successful login.
 */
export async function hashUserPassword(
  password: string,
  config: PasswordHashConfig
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.memoryCost,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  })
}

export async function verifyUserPassword(password: string, encodedHash: string): Promise<boolean> {
  return argon2.verify(encodedHash, password)
}
