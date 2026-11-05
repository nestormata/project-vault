import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

/** Story 43.30. Constants, not env: changing them is a code change, reviewed with the flow. */
export const CLI_DEVICE_TTL_SECONDS = 300
export const CLI_DEVICE_POLL_INTERVAL_SECONDS = 5
export const CLI_DEVICE_MAX_INTERVAL_SECONDS = 30
export const CLI_DEVICE_SLOW_DOWN_STEP_SECONDS = 5
export const CLI_DEVICE_CREATE_LIMIT_PER_MINUTE = 10
export const CLI_DEVICE_POLL_LIMIT_PER_MINUTE = 30
export const CLI_DEVICE_DECISION_IP_LIMIT_PER_MINUTE = 30
export const CLI_DEVICE_DECISION_USER_LIMIT_PER_MINUTE = 10
export const CLI_DEVICE_STEP_UP_FAILURE_LIMIT = 5
/** Organization credential minted from a user session. No refresh token; exchange again to renew. */
export const CLI_ORG_CREDENTIAL_TTL_SECONDS = 900
export const CLI_ORG_EXCHANGE_LIMIT_PER_MINUTE = 20
export const CLI_DEVICE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const CLI_DEVICE_USER_CODE_LENGTH = 8

const USER_CODE_PREFIX = 'cli-user-code:'
const DEVICE_CODE_PREFIX = 'cli-device-code:'

function hmac(material: string): string {
  return createHmac('sha256', env.CLI_DEVICE_CODE_HMAC_SECRET).update(material).digest('hex')
}

export function hashUserCode(normalized: string): string {
  return hmac(`${USER_CODE_PREFIX}${normalized}`)
}

export function hashDeviceCode(deviceCode: string): string {
  return hmac(`${DEVICE_CODE_PREFIX}${deviceCode}`)
}

/** Always runs a compare, including when the stored hash is absent, so a miss is not a shorter path. */
export function deviceCodeHashesEqual(storedHex: string | undefined, computedHex: string): boolean {
  const computed = Buffer.from(computedHex, 'hex')
  const stored = Buffer.from(storedHex ?? hmac(`${USER_CODE_PREFIX}absent`), 'hex')
  if (stored.length !== computed.length) {
    timingSafeEqual(computed, computed)
    return false
  }
  return timingSafeEqual(stored, computed)
}

export function normalizeUserCode(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '').toUpperCase()
  if (compact.length !== CLI_DEVICE_USER_CODE_LENGTH) return null
  for (const char of compact) {
    if (!CLI_DEVICE_USER_CODE_ALPHABET.includes(char)) return null
  }
  return compact
}

export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

export function generateUserCode(): string {
  let code = ''
  for (let i = 0; i < CLI_DEVICE_USER_CODE_LENGTH; i += 1) {
    const index = randomInt(0, CLI_DEVICE_USER_CODE_ALPHABET.length)
    code += CLI_DEVICE_USER_CODE_ALPHABET.charAt(index)
  }
  return code
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url')
}

export function isDeviceCodeShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}
