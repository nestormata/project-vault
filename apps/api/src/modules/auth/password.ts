import { randomBytes } from 'node:crypto'
import {
  hashUserPassword as hashPassword,
  passwordHashConfigFromEnv,
  verifyUserPassword as verifyPassword,
} from '@project-vault/crypto'
import { env } from '../../config/env.js'

const config = passwordHashConfigFromEnv({
  memoryCost: env.ARGON2_MEMORY_COST,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
})

export function hashUserPassword(password: string): Promise<string> {
  return hashPassword(password, config)
}

export function verifyUserPassword(password: string, encodedHash: string): Promise<boolean> {
  return verifyPassword(password, encodedHash)
}

/**
 * Story 23.2 AC-6e: the single shared implementation of "a freshly-generated, per-user random,
 * non-functional password hash, never a fixed shared constant" — a discipline that
 * `platform-admin/service.ts` (new-org-owner provisioning) and `compliance/erasure-service.ts`
 * (erasure sentinel) already followed independently before this story, and that
 * `auth/sso-routes.ts` did NOT: it wrote `env.AUTH_DUMMY_PASSWORD_HASH`, one env-wide value
 * shared by every SSO-provisioned user on the instance, defaulting (in production, if unset) to
 * an in-repo, publicly-known constant (`config/env.ts`'s `DEV_AUTH_DUMMY_PASSWORD_HASH`). A
 * single recovered preimage would then unlock every SSO-provisioned account on that instance, and
 * `WHERE password_hash = :value` would enumerate all of them. Extracting one helper (jscpd gate)
 * and having all three call sites use it removes that shared-secret exposure — it is a net
 * *deletion* of a concept, not an addition. `env.AUTH_DUMMY_PASSWORD_HASH` is NOT deprecated by
 * this: it keeps its one legitimate remaining purpose, timing equalization against a
 * non-existent user in `verifyUserPassword()` call sites that compare against it — it is only
 * ever compared against now, never stored.
 */
export function generateUnusablePasswordHash(): Promise<string> {
  return hashUserPassword(randomBytes(32).toString('hex'))
}
