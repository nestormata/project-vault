// Story 72.10 (P5): the TOTP field kind. The seed is stored like any other field value (inside the
// encrypted field envelope) and is WRITE-ONLY: nothing here returns it, logs it or puts it in an
// error. Codes are derived server-side with the vetted `otpauth` library the MFA module already
// depends on (RFC 6238); there is no hand-rolled HMAC or truncation.
import * as OTPAuth from 'otpauth'
import type { Field } from '@project-vault/shared'

export const TOTP_DEFAULT_DIGITS = 6
export const TOTP_DEFAULT_PERIOD_SECONDS = 30
const TOTP_MIN_DIGITS = 6
const TOTP_MAX_DIGITS = 8
const TOTP_MIN_PERIOD_SECONDS = 15
const TOTP_MAX_PERIOD_SECONDS = 120
// 80 bits is the RFC 4226 floor for a shared secret (16 Base32 characters); the cap only bounds work.
const TOTP_MIN_SEED_CHARS = 16
const TOTP_MAX_SEED_CHARS = 256
const TOTP_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512'])
const BASE32_PATTERN = /^[A-Z2-7]+$/

/** A field of kind `totp` was written with a seed that cannot produce codes. Carries the field KEY
 *  (not a secret) and never the seed. Mapped to `422 invalid_totp_seed`. */
export class InvalidTotpSeedError extends Error {
  constructor(public readonly fieldKey: string) {
    super('invalid_totp_seed')
    this.name = 'InvalidTotpSeedError'
  }
}

/** A field of kind `totp` has no seed to keep and none was sent. Mapped to `422 totp_seed_required`. */
export class TotpSeedRequiredError extends Error {
  constructor(public readonly fieldKey: string) {
    super('totp_seed_required')
    this.name = 'TotpSeedRequiredError'
  }
}

/** Parses a stored or submitted seed: a Base32 secret (spaces, dashes and case are ignored) or an
 *  `otpauth://totp/...` URI (algorithm, digits and period are honoured within sane bounds). Returns
 *  null for anything else. The input is never echoed anywhere. */
export function parseTotpSeed(raw: string): OTPAuth.TOTP | null {
  const text = raw.trim()
  if (text.length === 0 || text.length > 2048) return null
  try {
    return text.toLowerCase().startsWith('otpauth://') ? parseOtpAuthUri(text) : parseBase32(text)
  } catch {
    // The library error text can name the offending part of the input; drop it.
    return null
  }
}

function parseBase32(text: string): OTPAuth.TOTP | null {
  const normalized = text.replaceAll(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (
    normalized.length < TOTP_MIN_SEED_CHARS ||
    normalized.length > TOTP_MAX_SEED_CHARS ||
    !BASE32_PATTERN.test(normalized)
  ) {
    return null
  }
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: TOTP_DEFAULT_DIGITS,
    period: TOTP_DEFAULT_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(normalized),
  })
}

function parseOtpAuthUri(text: string): OTPAuth.TOTP | null {
  const parsed = OTPAuth.URI.parse(text)
  if (!(parsed instanceof OTPAuth.TOTP)) return null
  const bits = parsed.secret.buffer.byteLength * 8
  if (
    bits < TOTP_MIN_SEED_CHARS * 5 ||
    !TOTP_ALGORITHMS.has(parsed.algorithm) ||
    parsed.digits < TOTP_MIN_DIGITS ||
    parsed.digits > TOTP_MAX_DIGITS ||
    parsed.period < TOTP_MIN_PERIOD_SECONDS ||
    parsed.period > TOTP_MAX_PERIOD_SECONDS
  ) {
    return null
  }
  return parsed
}

export type GeneratedTotpCode = {
  code: string
  digits: number
  periodSeconds: number
  /** When this code stops being the current one (start of the next period). */
  expiresAt: string
  secondsRemaining: number
}

/** The current code for a stored seed, or null when the seed is empty or invalid. */
export function generateTotpCode(
  seed: string,
  nowMs: number = Date.now()
): GeneratedTotpCode | null {
  const totp = parseTotpSeed(seed)
  if (!totp) return null
  const periodMs = totp.period * 1000
  const expiresAtMs = (Math.floor(nowMs / periodMs) + 1) * periodMs
  return {
    code: totp.generate({ timestamp: nowMs }),
    digits: totp.digits,
    periodSeconds: totp.period,
    expiresAt: new Date(expiresAtMs).toISOString(),
    secondsRemaining: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)),
  }
}

/** Throws `InvalidTotpSeedError` (key only) when a `totp` field's seed cannot produce codes. */
export function assertValidTotpSeeds(fields: Field[]): void {
  for (const field of fields) {
    if (field.kind === 'totp' && parseTotpSeed(field.value) === null) {
      throw new InvalidTotpSeedError(field.key)
    }
  }
}
