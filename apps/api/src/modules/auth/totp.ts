import { createHmac } from 'node:crypto'
import * as OTPAuth from 'otpauth'
import { encrypt, withSecret, type EncryptedValue } from '@project-vault/crypto'
import type { Tx } from '@project-vault/db'
import { totpUsedCodes } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import { getPrimaryKey } from '../vault/key-service.js'

export type GeneratedTotpSecret = { base32: string; buffer: ArrayBufferLike }
export type DecryptedTotpSecret = { base32: string; enrollmentId: string }

export function generateSecret(): GeneratedTotpSecret {
  const secret = new OTPAuth.Secret({ size: 20 })
  return { base32: secret.base32, buffer: secret.buffer }
}

export function buildOtpAuthUrl(base32Secret: string, userEmail: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: env.MFA_TOTP_ISSUER,
    label: userEmail,
    algorithm: 'SHA1',
    digits: env.MFA_TOTP_DIGITS,
    period: env.MFA_TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  })
  return totp.toString()
}

export async function encryptTotpSecret(secretBuffer: Buffer): Promise<EncryptedValue> {
  const key = getPrimaryKey()
  try {
    return await encrypt(secretBuffer, key)
  } finally {
    key.fill(0)
  }
}

export async function decryptEnrollmentSecret(encrypted: EncryptedValue): Promise<Buffer> {
  return withSecret(encrypted, async (plaintext) => Buffer.from(plaintext))
}

export function base32FromSecretBytes(secretBytes: Buffer): string {
  const buffer = secretBytes.buffer.slice(
    secretBytes.byteOffset,
    secretBytes.byteOffset + secretBytes.byteLength
  )
  return new OTPAuth.Secret({ buffer }).base32
}

export function validateTotpCode(
  secretBase32: string,
  token: string,
  options: { window?: number; timestamp?: number } = {}
): { valid: boolean; counter?: number } {
  const normalized = token.replace(/\s/g, '')
  if (!/^\d{6}$/.test(normalized)) return { valid: false }
  const period = env.MFA_TOTP_PERIOD_SECONDS
  const timestamp = options.timestamp ?? Date.now()
  const totp = new OTPAuth.TOTP({
    issuer: env.MFA_TOTP_ISSUER,
    label: 'Project Vault',
    algorithm: 'SHA1',
    digits: env.MFA_TOTP_DIGITS,
    period,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  })
  const delta = totp.validate({
    token: normalized,
    window: options.window ?? env.MFA_TOTP_WINDOW,
    timestamp,
  })
  if (delta === null) return { valid: false }
  const currentCounter = Math.floor(timestamp / 1000 / period)
  return { valid: true, counter: currentCounter + delta }
}

export function createTotpReplayHash(
  userId: string,
  counter: number,
  token: string,
  hmacSecret = env.TOTP_REPLAY_HMAC_SECRET
): string {
  return createHmac('sha256', hmacSecret).update(`${userId}:${counter}:${token}`).digest('hex')
}

export async function recordTotpUse(
  userId: string,
  counter: number,
  token: string,
  tx: Tx
): Promise<void> {
  const periodMs = env.MFA_TOTP_PERIOD_SECONDS * 1000
  const windowStart = new Date(counter * periodMs)
  await tx.insert(totpUsedCodes).values({
    userId,
    codeHash: createTotpReplayHash(userId, counter, token),
    windowStart,
    expiresAt: new Date(windowStart.getTime() + env.TOTP_USED_CODES_TTL_MINUTES * 60_000),
  })
}
