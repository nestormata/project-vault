import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { verifyUserPassword } from '../auth/password.js'
import { verifyConfirmedLoginTotp } from '../auth/mfa.js'
import { isNativeLoginEnabled } from '../auth/native-login-policy.js'

/**
 * Story 17.2 AC-3: sharer step-up re-authentication for external-share creation. This is a
 * synchronous, stateless re-check on a single request — no new "step-up session"/short-lived
 * elevated-privilege token is introduced (a deliberate, documented scope decision; see the
 * story's Dev Agent Record). No existing precedent in this codebase for this pattern — the
 * closest analogues (reused here rather than reinvented) are login-time password verification
 * (`verifyUserPassword`) and login-time TOTP verification (`verifyConfirmedLoginTotp`, which
 * already enforces `totpUsedCodes` replay-prevention).
 */
export type StepUpResult =
  | { status: 'ok' }
  | { status: 'missing_factor' }
  | { status: 'invalid_password' }
  | { status: 'invalid_totp' }

export type StepUpInput = {
  userId: string
  password?: string
  totpCode?: string
}

/**
 * Verifies exactly one of `password`/`totpCode` against the sharer's own account. The caller
 * supplies whichever factor they have — MFA is an *additional* accepted factor, not a hard
 * requirement (a sharer with no MFA enrolled can always use the password path).
 */
export async function verifyStepUp(tx: Tx, input: StepUpInput): Promise<StepUpResult> {
  // Story 23.2 AC-6b: under exclusion the password factor is disabled outright — `input.password`
  // is ignored (never read against `users.passwordHash`, never even looked at) and this behaves
  // as if no password were supplied. Checked once, up front, rather than duplicated inside the
  // `if (input.password)` branch below, so a caller supplying BOTH factors still falls through to
  // the TOTP check (AC-6b item 2: "both factors supplied: password ignored, TOTP evaluated") —
  // duplicating the check inside that branch would incorrectly short-circuit on the password
  // before ever reaching the TOTP path.
  const passwordFactorDisabled = !isNativeLoginEnabled()
  const password = passwordFactorDisabled ? undefined : input.password

  if (password) {
    const [row] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
    if (!row) return { status: 'invalid_password' }
    const valid = await verifyUserPassword(password, row.passwordHash)
    return valid ? { status: 'ok' } : { status: 'invalid_password' }
  }

  if (input.totpCode) {
    const result = await verifyConfirmedLoginTotp(tx, input.userId, input.totpCode)
    return result === 'valid' ? { status: 'ok' } : { status: 'invalid_totp' }
  }

  return { status: 'missing_factor' }
}
