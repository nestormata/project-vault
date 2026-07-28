import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { orgSsoDomains } from '@project-vault/db/schema'
import { normalizeSsoDomain, ORG_SSO_DOMAIN_ERROR_CODES } from '@project-vault/shared'
import { findAuthStrategy } from './strategies.js'
import { isUniqueViolation } from '../credentials/db-helpers.js'

/**
 * Story 14.4's schema-file comment flagged this exact operational hazard as unguarded: nothing
 * stopped an operator/admin from mapping a shared public email domain to one org's SSO strategy,
 * silently breaking local login for every other user across every org who shares that domain.
 * This is a best-effort UX/safety guard, not a claimed-complete security boundary — many
 * regional/corporate-adjacent free-mail providers exist beyond this ~11-entry starter list. Do
 * not phrase UI copy as "blocks all public domains"; phrase it as "on our list of shared public
 * email providers".
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'mail.com',
])

export type OrgSsoDomainRow = {
  id: string
  domain: string
  providerName: string
  createdAt: Date
}

type OrgSsoDomainErrorCode =
  (typeof ORG_SSO_DOMAIN_ERROR_CODES)[keyof typeof ORG_SSO_DOMAIN_ERROR_CODES]

export type OrgSsoDomainValidationFailure = {
  ok: false
  status: 422 | 503
  code: OrgSsoDomainErrorCode
}

export type OrgSsoDomainValidationResult = { ok: true } | OrgSsoDomainValidationFailure

export type OrgSsoDomainWriteResult =
  | { ok: true; row: OrgSsoDomainRow }
  | OrgSsoDomainValidationFailure
  | { ok: false; status: 409; code: 'domain_already_mapped' }

/**
 * AC-2(c)/(d)/(e): the public-domain blocklist and provider-registration checks, shared by
 * create and update. Domain normalization/format checks already happened at the schema layer
 * (packages/shared/src/schemas/auth.ts) before this is ever called — this function only performs
 * the checks that need runtime/business state (the blocklist set, the live authStrategies list).
 */
export async function validateOrgSsoDomainInput(input: {
  domain?: string
  providerName?: string
}): Promise<OrgSsoDomainValidationResult> {
  if (input.domain !== undefined) {
    // Already normalized by the request schema, but re-normalize defensively — this function may
    // be called with a caller-supplied value that bypassed the schema in a future refactor.
    const normalized = normalizeSsoDomain(input.domain)
    if (PUBLIC_EMAIL_DOMAINS.has(normalized)) {
      return { ok: false, status: 422, code: ORG_SSO_DOMAIN_ERROR_CODES.PUBLIC_DOMAIN_BLOCKED }
    }
  }

  if (input.providerName !== undefined) {
    let strategy: ReturnType<typeof findAuthStrategy>
    try {
      strategy = findAuthStrategy(input.providerName)
    } catch {
      // AC-2(e): findAuthStrategy() itself throwing (extension runtime unloaded/crashed) is a
      // transient infra failure, distinct from "ran fine, provider just isn't registered" — must
      // not be presented to the admin as "you typed the wrong provider name".
      return { ok: false, status: 503, code: ORG_SSO_DOMAIN_ERROR_CODES.PROVIDER_CHECK_UNAVAILABLE }
    }
    if (!strategy) {
      return { ok: false, status: 422, code: ORG_SSO_DOMAIN_ERROR_CODES.PROVIDER_NOT_REGISTERED }
    }
  }

  return { ok: true }
}

/** Column selection shared by every read/write path below — kept in one place so the row shape can't drift. */
const ORG_SSO_DOMAIN_COLUMNS = {
  id: orgSsoDomains.id,
  domain: orgSsoDomains.domain,
  providerName: orgSsoDomains.providerName,
  createdAt: orgSsoDomains.createdAt,
}

/**
 * AC-2/AC-3: runs an insert/update write, translating a Postgres unique-violation into the shared
 * 409 result; anything else rethrows. Returning `row: undefined` (no matching write) is a valid,
 * non-error outcome — callers decide what that means (create treats it as unexpected; update
 * treats it as a 404 cross-org/missing-id guess) rather than this helper guessing for them.
 * Exported for direct unit coverage of the non-unique-violation rethrow path, which is otherwise
 * only reachable by forcing a genuine non-constraint DB failure through the live route flow.
 */
export async function runDomainWrite(
  op: () => Promise<OrgSsoDomainRow | undefined>
): Promise<
  | { ok: true; row: OrgSsoDomainRow | undefined }
  | { ok: false; status: 409; code: 'domain_already_mapped' }
> {
  try {
    return { ok: true, row: await op() }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, status: 409, code: 'domain_already_mapped' }
    }
    throw error
  }
}

export async function listOrgSsoDomains(tx: Tx, orgId: string): Promise<OrgSsoDomainRow[]> {
  return tx.select(ORG_SSO_DOMAIN_COLUMNS).from(orgSsoDomains).where(eq(orgSsoDomains.orgId, orgId))
}

export async function createOrgSsoDomain(
  tx: Tx,
  orgId: string,
  input: { domain: string; providerName: string }
): Promise<OrgSsoDomainWriteResult> {
  const validation = await validateOrgSsoDomainInput(input)
  if (!validation.ok) return validation

  const result = await runDomainWrite(async () => {
    const [row] = await tx
      .insert(orgSsoDomains)
      .values({ orgId, domain: input.domain, providerName: input.providerName })
      .returning(ORG_SSO_DOMAIN_COLUMNS)
    return row
  })
  if (!result.ok) return result
  if (!result.row) throw new Error('org_sso_domains insert returned no row')
  return { ok: true, row: result.row }
}

export async function updateOrgSsoDomain(
  tx: Tx,
  orgId: string,
  id: string,
  input: { domain?: string; providerName?: string }
): Promise<OrgSsoDomainWriteResult | { ok: false; status: 404 }> {
  const validation = await validateOrgSsoDomainInput(input)
  if (!validation.ok) return validation

  const result = await runDomainWrite(async () => {
    const [row] = await tx
      .update(orgSsoDomains)
      .set({
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.providerName !== undefined ? { providerName: input.providerName } : {}),
      })
      .where(and(eq(orgSsoDomains.id, id), eq(orgSsoDomains.orgId, orgId)))
      .returning(ORG_SSO_DOMAIN_COLUMNS)
    return row
  })
  if (!result.ok) return result
  if (!result.row) return { ok: false, status: 404 }
  return { ok: true, row: result.row }
}

export async function deleteOrgSsoDomain(
  tx: Tx,
  orgId: string,
  id: string
): Promise<OrgSsoDomainRow | null> {
  const [row] = await tx
    .delete(orgSsoDomains)
    .where(and(eq(orgSsoDomains.id, id), eq(orgSsoDomains.orgId, orgId)))
    .returning(ORG_SSO_DOMAIN_COLUMNS)
  return row ?? null
}
