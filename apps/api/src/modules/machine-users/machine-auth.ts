import { and, eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { withOrg } from '@project-vault/db'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import type { MachineJwtVerifiedClaims } from '../../plugins/machine-jwt.js'
import { extractBearerToken } from './bearer-token.js'
import { isMachineKeyLive } from './key-validity.js'

const ACCESS_TOKEN_MISSING = {
  code: 'access_token_missing',
  message: 'Access token is missing',
} as const
const INVALID_MACHINE_TOKEN = {
  code: 'invalid_machine_token',
  message: 'Machine access token is invalid',
} as const

export type VerifiedMachineRequest = {
  machineUserId: string
  orgId: string
  projectId: string
  keyId: string
  role: 'member' | 'viewer'
}

/**
 * Shared by every route that's manually machine-JWT-authenticated (D4/D13): registered on the
 * requireAuth:false public path, with verifyMachineRequest() as the handler's first action — see
 * route-exemptions.ts for the documented compensating controls.
 */
export const MANUAL_MACHINE_AUTH_SECURITY = {
  requireAuth: false,
  writeAuditEvent: false,
  rateLimit: false,
} as const

type MachineJwtVerifyFastify = {
  machineJwtVerify: (token: string) => Promise<MachineJwtVerifiedClaims>
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function hasWellFormedMachineClaims(claims: MachineJwtVerifiedClaims): boolean {
  return (
    typeof claims.orgId === 'string' &&
    UUID_REGEX.test(claims.orgId) &&
    typeof claims.keyId === 'string' &&
    typeof claims.sub === 'string' &&
    typeof claims.scope === 'string'
  )
}

type LiveKeyState = {
  revokedAt: Date | null
  expiresAt: Date | null
  machineUserRole: string
  machineUserDeactivatedAt: Date | null
}

function isLiveKeyStateValid(row: LiveKeyState, now: Date = new Date()): boolean {
  return isMachineKeyLive(row, now)
}

async function findLiveKeyState(orgId: string, keyId: string): Promise<LiveKeyState | null> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
        machineUserRole: machineUsers.role,
        machineUserDeactivatedAt: machineUsers.deactivatedAt,
      })
      .from(apiKeys)
      .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
      .limit(1)
  )
  return rows[0] ?? null
}

/**
 * Story 7.2 D4/AC-5 — the manual verification helper every machine-authenticated route calls as
 * its first action, composed inside `security.requireAuth: false`'s already-existing public path
 * (the same pattern `enforceMfaIfRequired` uses to layer extra guards onto that path) rather than
 * a parallel SecureRoute-like wrapper. On success, sends nothing and returns the verified
 * context. On any failure, sends the 401 response itself and returns null — callers must check
 * for null and `return reply` without further handling.
 *
 * Steps: (1) extract `Authorization: Bearer`, 401 if missing/malformed; (2) verify the machine
 * JWT signature/expiry via `machineJwtVerify()`, 401 on any failure; (3) re-validate the
 * referenced `api_keys` row is still non-revoked, non-expired (`expiresAt`, matching the same
 * validity condition `isApiKeyValidForExchange()`/`activeMachineUserKeysQuery()` already check —
 * an explicitly time-boxed key must stop authenticating at its `expiresAt`, not linger for up to
 * the JWT's own `MACHINE_JWT_TTL_SECONDS` past that point), and its machine user non-deactivated
 * via a fresh, org-scoped `withOrg(claims.orgId, ...)` lookup by `id = claims.keyId AND org_id =
 * claims.orgId` (AC-25: an org mismatch yields zero rows via the WHERE clause itself, not an RLS
 * leak) — this live DB recheck is what catches revoke-after-issue within the JWT's <=1h window,
 * since the JWT itself carries no revocation state.
 */
export async function verifyMachineRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<VerifiedMachineRequest | null> {
  const token = extractBearerToken(request)
  if (!token) {
    reply.status(401).send(ACCESS_TOKEN_MISSING)
    return null
  }

  let claims: MachineJwtVerifiedClaims
  try {
    claims = await (request.server as unknown as MachineJwtVerifyFastify).machineJwtVerify(token)
  } catch {
    reply.status(401).send(INVALID_MACHINE_TOKEN)
    return null
  }

  if (!hasWellFormedMachineClaims(claims)) {
    reply.status(401).send(INVALID_MACHINE_TOKEN)
    return null
  }

  const keyId = claims.keyId
  const orgId = claims.orgId
  const row = await findLiveKeyState(orgId, keyId)
  if (!row || !isLiveKeyStateValid(row)) {
    reply.status(401).send(INVALID_MACHINE_TOKEN)
    return null
  }

  return {
    machineUserId: claims.sub,
    orgId,
    projectId: claims.scope,
    keyId,
    role: row.machineUserRole as 'member' | 'viewer',
  }
}
