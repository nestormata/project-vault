import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import {
  projects,
  serviceEndpoints,
  statusPages,
  statusPageServices,
} from '@project-vault/db/schema'
import { withSecret, type EncryptedValue } from '@project-vault/crypto'
import type { PublicStatusPageService, StatusPageConfig } from '@project-vault/shared'
import { getAdminDb } from '../../lib/db.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import { currentKeyVersion } from '../credentials/db-helpers.js'
import { generateStatusPageToken, hashStatusPageToken } from './status-page-tokens.js'
import type { UpdateStatusPageBody } from './schema.js'

export class StatusPageAlreadyEnabledError extends Error {
  readonly code = 'status_page_already_enabled'
  constructor() {
    super('A status page is already enabled for this project')
    this.name = 'StatusPageAlreadyEnabledError'
  }
}

export class StatusPageNotFoundError extends Error {
  readonly code = 'status_page_not_found'
  constructor() {
    super('No status page exists for this project')
    this.name = 'StatusPageNotFoundError'
  }
}

export class InvalidServiceReferenceError extends Error {
  readonly code = 'invalid_service_reference'
  constructor() {
    super('One or more serviceId values are not service_endpoints rows in this project')
    this.name = 'InvalidServiceReferenceError'
  }
}

export async function findStatusPageByProject(tx: Tx, projectId: string) {
  const [row] = await tx
    .select()
    .from(statusPages)
    .where(eq(statusPages.projectId, projectId))
    .limit(1)
  return row ?? null
}

/**
 * AC 8's concurrency example: two concurrent first-time enables both pass the pre-check before
 * either commits, so the second INSERT to reach the DB must be mapped to 409, not an unhandled
 * 500. `onConflictDoNothing` (rather than catching a thrown unique-violation exception) avoids
 * ever raising a real Postgres-level error — a conflicting INSERT just returns zero rows, leaving
 * the surrounding transaction perfectly healthy — the same pattern already used throughout this
 * codebase (auth/service.ts, mfa-login.ts, invitations/token-routes.ts) for this exact race shape.
 */
export async function enableStatusPage(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string }
): Promise<{ id: string; token: string; createdAt: string }> {
  const token = generateStatusPageToken()
  const tokenHash = hashStatusPageToken(token)
  // Story 21.7: written in the same INSERT as tokenHash so the redisplayable ciphertext and the
  // public-lookup hash are always in lockstep (never a row with one but not the other).
  const encryptedToken = await encryptValue(token)
  const keyVersion = await currentKeyVersion(tx)
  const [row] = await tx
    .insert(statusPages)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      tokenHash,
      encryptedToken,
      keyVersion,
      createdBy: input.userId,
    })
    .onConflictDoNothing({ target: statusPages.projectId })
    .returning()
  if (!row) throw new StatusPageAlreadyEnabledError()
  return { id: row.id, token, createdAt: row.createdAt.toISOString() }
}

export async function regenerateStatusPageToken(
  tx: Tx,
  projectId: string
): Promise<{ id: string; token: string; updatedAt: string }> {
  const token = generateStatusPageToken()
  const tokenHash = hashStatusPageToken(token)
  // Story 21.7: tokenHash + encryptedToken + keyVersion are overwritten together in the same
  // UPDATE, so the previous token's public lookup (tokenHash) and its redisplayable ciphertext
  // both go stale atomically — "only one link is ever active" holds for both mechanisms at once.
  const encryptedToken = await encryptValue(token)
  const keyVersion = await currentKeyVersion(tx)
  const [row] = await tx
    .update(statusPages)
    .set({ tokenHash, encryptedToken, keyVersion })
    .where(eq(statusPages.projectId, projectId))
    .returning()
  if (!row) throw new StatusPageNotFoundError()
  return { id: row.id, token, updatedAt: row.updatedAt.toISOString() }
}

/**
 * Story 21.7: decrypts `encryptedToken` for redisplay on the owner-facing settings page.
 * Returns `null` (never throws) for a legacy row with no `encryptedToken`, and — via the
 * catch — when the vault is sealed at read time: `withSecret` throws in that case, and unlike
 * this module's other fail-closed points (which throw route-level, surfacing a 5xx/503), this one
 * is purely presentational — the rest of the config must still render, so decrypt failure just
 * means "token temporarily unavailable, regenerate to get a persistent link" rather than an error.
 */
async function decryptStatusPageToken(
  encryptedToken: EncryptedValue | null
): Promise<string | null> {
  if (!encryptedToken) return null
  try {
    return await withSecret(encryptedToken, async (plaintext) => plaintext.toString('utf8'))
  } catch {
    return null
  }
}

export async function getStatusPageConfig(tx: Tx, projectId: string): Promise<StatusPageConfig> {
  const statusPage = await findStatusPageByProject(tx, projectId)
  if (!statusPage) return { enabled: false }

  const services = await tx
    .select({
      serviceId: statusPageServices.serviceId,
      displayName: statusPageServices.displayName,
      sortOrder: statusPageServices.sortOrder,
    })
    .from(statusPageServices)
    .where(eq(statusPageServices.statusPageId, statusPage.id))
    .orderBy(statusPageServices.sortOrder)

  const encryptedToken = statusPage.encryptedToken as EncryptedValue | null
  const token = await decryptStatusPageToken(encryptedToken)
  // Story 6.6 AC-4: distinguish "never had a recoverable ciphertext" (genuine legacy row, the
  // hash truly cannot be reversed) from "has one but couldn't decrypt it just now" (sealed vault
  // — transient, decryptStatusPageToken already returns null for that case too). Only the former
  // gets `legacyToken: true`; checked on the raw column, not on `token === null`, so the two
  // null-token causes stay distinguishable downstream.
  const legacyToken = encryptedToken === null

  return {
    enabled: true,
    createdAt: statusPage.createdAt.toISOString(),
    updatedAt: statusPage.updatedAt.toISOString(),
    services,
    ...(token !== null ? { token } : {}),
    ...(legacyToken ? { legacyToken: true } : {}),
  }
}

export type StatusPageServicesSnapshot = { count: number; displayNames: string[] }

async function currentServicesSnapshot(
  tx: Tx,
  statusPageId: string
): Promise<StatusPageServicesSnapshot> {
  const rows = await tx
    .select({ displayName: statusPageServices.displayName })
    .from(statusPageServices)
    .where(eq(statusPageServices.statusPageId, statusPageId))
    .orderBy(statusPageServices.sortOrder)
  return { count: rows.length, displayNames: rows.map((row) => row.displayName) }
}

export type UpdateStatusPageServicesResult = {
  statusPageId: string
  services: { serviceId: string; displayName: string; sortOrder: number }[]
  previous: StatusPageServicesSnapshot
}

/**
 * AC 15: full delete-all-then-insert-new replace in one transaction (the caller's `tx`), so a
 * concurrent public GET never observes a transient "zero services" state mid-update. Validates
 * every serviceId is a `service_endpoints` row belonging to this project (realigned per
 * ADR-6.3-02/04 — no longer "eligible vs ineligible" filtering within one table, just "is this id
 * a service_endpoints row belonging to this project") before mutating anything.
 */
export async function updateStatusPageServices(
  tx: Tx,
  input: { orgId: string; projectId: string; body: UpdateStatusPageBody }
): Promise<UpdateStatusPageServicesResult> {
  // The replacement contract is last-write-wins, so concurrent full replacements must queue
  // behind one another instead of deadlocking while both delete and reinsert the same rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 0))`)
  const statusPage = await findStatusPageByProject(tx, input.projectId)
  if (!statusPage) throw new StatusPageNotFoundError()

  if (input.body.services.length > 0) {
    const serviceIds = input.body.services.map((service) => service.serviceId)
    const validRows = await tx
      .select({ id: serviceEndpoints.id })
      .from(serviceEndpoints)
      .where(
        and(
          inArray(serviceEndpoints.id, serviceIds),
          eq(serviceEndpoints.projectId, input.projectId)
        )
      )
    const validIds = new Set(validRows.map((row) => row.id))
    if (validIds.size !== new Set(serviceIds).size) throw new InvalidServiceReferenceError()
  }

  const previous = await currentServicesSnapshot(tx, statusPage.id)

  await tx.delete(statusPageServices).where(eq(statusPageServices.statusPageId, statusPage.id))

  const rowsToInsert = input.body.services.map((service, index) => ({
    orgId: input.orgId,
    statusPageId: statusPage.id,
    serviceId: service.serviceId,
    displayName: service.displayName,
    sortOrder: index,
  }))

  const inserted =
    rowsToInsert.length > 0
      ? await tx.insert(statusPageServices).values(rowsToInsert).returning()
      : []

  return {
    statusPageId: statusPage.id,
    services: inserted
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => ({
        serviceId: row.serviceId,
        displayName: row.displayName,
        sortOrder: row.sortOrder,
      })),
    previous,
  }
}

export async function disableStatusPage(
  tx: Tx,
  projectId: string
): Promise<{ statusPageId: string; snapshot: StatusPageServicesSnapshot } | null> {
  const statusPage = await findStatusPageByProject(tx, projectId)
  if (!statusPage) return null
  const snapshot = await currentServicesSnapshot(tx, statusPage.id)
  await tx.delete(statusPages).where(eq(statusPages.id, statusPage.id))
  return { statusPageId: statusPage.id, snapshot }
}

/**
 * Story 6.3 ADR-6.3-09 (Task 7): the caller has no session/org context, so a per-org RLS-scoped
 * scan isn't possible — this is the single point-lookup by the unique hashed-token index via the
 * admin connection, mirroring findInvitationByTokenHash's exact shape and documented rationale.
 * The 256-bit token is itself the authorization credential.
 */
export async function findStatusPageByTokenHash(tokenHash: string) {
  const [row] = await getAdminDb()
    .select()
    .from(statusPages)
    .where(eq(statusPages.tokenHash, tokenHash))
    .limit(1)
  return row ?? null
}

/**
 * Step 2 of ADR-6.3-09: once the admin lookup resolves the row's orgId, re-scope with withOrg —
 * only the initial org-unknown point lookup runs on the admin connection.
 *
 * Returns `null` (caller must treat as 404, same as an unknown token) in two cases the
 * admin-connection point lookup alone cannot rule out:
 *  - the `status_pages` row was disabled/deleted in the narrow window between the admin-connection
 *    lookup (step 1) and this re-scoped read — without this check, a status page disabled a moment
 *    ago would silently serve a `200` with an empty `services: []` (indistinguishable from the
 *    legitimate "enabled, nothing configured yet" state, AC 12) instead of the `404` AC 16 requires
 *    "immediately, no grace period".
 *  - the project the status page belongs to has since been archived — archiving a project is this
 *    codebase's mechanism for taking it out of active/visible use (it is already excluded from the
 *    cross-project health dashboard, `health-dashboard-service.ts`); a public, unauthenticated link
 *    must not keep serving a decommissioned project's live status indefinitely.
 */
export async function getPublicStatusPageServices(
  orgId: string,
  statusPageId: string
): Promise<PublicStatusPageService[] | null> {
  return withOrg(orgId, async (tx) => {
    const [statusPage] = await tx
      .select({ id: statusPages.id })
      .from(statusPages)
      .innerJoin(projects, eq(projects.id, statusPages.projectId))
      .where(and(eq(statusPages.id, statusPageId), isNull(projects.archivedAt)))
      .limit(1)
    if (!statusPage) return null

    const rows = await tx
      .select({
        displayName: statusPageServices.displayName,
        status: serviceEndpoints.status,
        lastCheckedAt: serviceEndpoints.lastCheckedAt,
      })
      .from(statusPageServices)
      .innerJoin(serviceEndpoints, eq(serviceEndpoints.id, statusPageServices.serviceId))
      .where(eq(statusPageServices.statusPageId, statusPageId))
      .orderBy(statusPageServices.sortOrder)

    return rows.map((row) => ({
      displayName: row.displayName,
      status: row.status as 'healthy' | 'degraded' | 'down',
      lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    }))
  })
}
