import { randomInt } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import bcrypt from 'bcrypt'
import type { Tx } from '@project-vault/db'
import { mfaEnrollments, mfaRecoveryCodes } from '@project-vault/db/schema'

// eslint-disable-next-line no-secrets/no-secrets -- Public recovery-code alphabet, not a secret.
const RECOVERY_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const NORMALIZED_RECOVERY_CODE = /^[A-HJ-NP-Z2-9]{10}$/

export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i += 1) {
    let raw = ''
    for (let j = 0; j < 10; j += 1) {
      raw += RECOVERY_CODE_CHARSET[randomInt(RECOVERY_CODE_CHARSET.length)]
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '')
}

export function isNormalizedRecoveryCode(code: string): boolean {
  return NORMALIZED_RECOVERY_CODE.test(code)
}

export async function hashRecoveryCode(code: string, cost: number): Promise<string> {
  return bcrypt.hash(normalizeRecoveryCode(code), cost)
}

export async function recoveryCodeMatches(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(normalizeRecoveryCode(code), hash)
}

export async function countUnusedRecoveryCodes(userId: string, tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
  return rows.length
}

export async function deletePendingEnrollmentForUser(userId: string, tx: Tx): Promise<void> {
  await tx
    .delete(mfaEnrollments)
    .where(and(eq(mfaEnrollments.userId, userId), eq(mfaEnrollments.status, 'pending')))
}
