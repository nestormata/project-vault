import type { FastifyBaseLogger } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { apiKeys, machineUsers, organizations } from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { CredentialSharingNoMachineUserError } from '@project-vault/extension-api'
import { writeExtensionAuditEntry } from '../modules/audit/extension-entry.js'
import { isAdminProvisioned } from '../modules/machine-users/admin-provisioned.js'
import { isMachineKeyLive } from '../modules/machine-users/key-validity.js'
import { operationalLog } from './logger.js'

type Logger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

/**
 * Who an extension's credential-sharing write is attributed to (Design Decision A, Story 73.9).
 *
 * - `admin-provisioned`: a project machine user an admin created and keyed. Its `createdBy` (the
 *   human who provisioned it) is what `credential_shares.shared_by` records, and `keyId` is the live
 *   key it holds. Both are independent facts about the same mapping.
 * - `host-managed`: the keyless, org-scoped principal the host creates for the extension (D1). It
 *   has no key (`keyId: null`, D3) and no human, so `shared_by` is the validated acting user (D2).
 */
export type MachineUserAttribution =
  | { kind: 'admin-provisioned'; machineUserId: string; keyId: string; sharedByUserId: string }
  | { kind: 'host-managed'; machineUserId: string; keyId: null }

export type ProvisionedMachineUser = { machineUserId: string; created: boolean }

type MachineUserScope = { organizationId: string; extensionName: string; methodName: string }

/** `machine_users_name_len_check`: `char_length(name) BETWEEN 1 AND 128`. */
const MACHINE_USER_NAME_MAX_LENGTH = 128

/**
 * Every fail-closed path logs the same warn (AC-7) and throws the one existing error, whatever the
 * cause, so the error is no oracle for org existence beyond what the facade already exposes (D5).
 */
export function failNoMachineUser(logger: Logger, scope: MachineUserScope): never {
  operationalLog(
    logger,
    'warn',
    OperationalEvent.CREDENTIAL_SHARING_HOST_NO_MACHINE_USER,
    `credentialSharing.${scope.methodName}() rejected — no mapped PV machine-user for this extension's org`,
    { extensionName: scope.extensionName, organizationId: scope.organizationId }
  )
  throw new CredentialSharingNoMachineUserError(scope.methodName)
}

/**
 * The mapping convention (Design Decision A): an admin-provisioned `machine_users` row in the org
 * whose `name` is the extension's manifest name, with a live key (`isMachineKeyLive`) and a
 * provisioning human. A row whose `createdBy` was nulled by that human's deletion cannot satisfy the
 * NOT NULL `shared_by` FK, so it does not count.
 */
async function resolveAdminProvisioned(
  tx: Tx,
  scope: MachineUserScope
): Promise<MachineUserAttribution | null> {
  const rows = await tx
    .select({
      machineUserId: machineUsers.id,
      keyId: apiKeys.id,
      createdBy: machineUsers.createdBy,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      machineUserDeactivatedAt: machineUsers.deactivatedAt,
    })
    .from(machineUsers)
    .innerJoin(apiKeys, eq(apiKeys.machineUserId, machineUsers.id))
    .where(
      and(
        eq(machineUsers.orgId, scope.organizationId),
        eq(machineUsers.name, scope.extensionName),
        isNull(machineUsers.deactivatedAt),
        isAdminProvisioned
      )
    )

  const live = rows.find((row) => isMachineKeyLive(row) && row.createdBy !== null)
  if (!live?.createdBy) return null
  return {
    kind: 'admin-provisioned',
    machineUserId: live.machineUserId,
    keyId: live.keyId,
    sharedByUserId: live.createdBy,
  }
}

async function findHostManaged(tx: Tx, scope: MachineUserScope) {
  const [row] = await tx
    .select({ id: machineUsers.id, deactivatedAt: machineUsers.deactivatedAt })
    .from(machineUsers)
    .where(
      and(
        eq(machineUsers.orgId, scope.organizationId),
        eq(machineUsers.name, scope.extensionName),
        eq(machineUsers.hostManaged, true)
      )
    )
    .limit(1)
  return row
}

/** The org exists; the key-share lock keeps it from being deleted under the insert below. */
async function organizationExists(tx: Tx, organizationId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('key share')
  return rows.length > 0
}

function existingOrFail(
  row: { id: string; deactivatedAt: Date | null } | undefined,
  scope: MachineUserScope,
  logger: Logger
): ProvisionedMachineUser {
  // D6: a deactivated host-managed row is never resurrected.
  if (!row || row.deactivatedAt !== null) failNoMachineUser(logger, scope)
  return { machineUserId: row.id, created: false }
}

/**
 * Story 73.9 AC-1 — idempotent and race-safe. Two first calls both reach the insert; the partial
 * unique index on `(org_id, name) WHERE host_managed` makes the second wait for the first and then
 * do nothing, and its re-select (a new READ COMMITTED snapshot) sees the winner's row. If the winner
 * rolls back, the loser's insert goes through instead. Exactly one row and one audit row per org
 * and extension. Runs on the caller's transaction, which must already be `withOrg(organizationId)`
 * so the insert is checked by the `machine_users` RLS policy (AC-5).
 */
export async function provisionHostManagedMachineUser(
  tx: Tx,
  scope: MachineUserScope & { trigger: string },
  logger: Logger
): Promise<ProvisionedMachineUser> {
  // The manifest name pattern has no length bound, but `machine_users_name_len_check` does: a name
  // it would refuse fails closed here instead of surfacing a raw CHECK violation.
  if (scope.extensionName.length > MACHINE_USER_NAME_MAX_LENGTH) failNoMachineUser(logger, scope)
  if (!(await organizationExists(tx, scope.organizationId))) failNoMachineUser(logger, scope)

  const existing = await findHostManaged(tx, scope)
  if (existing) return existingOrFail(existing, scope, logger)

  const [inserted] = await tx
    .insert(machineUsers)
    .values({
      orgId: scope.organizationId,
      projectId: null,
      name: scope.extensionName,
      role: 'viewer',
      createdBy: null,
      hostManaged: true,
    })
    .onConflictDoNothing({
      target: [machineUsers.orgId, machineUsers.name],
      where: sql`${machineUsers.hostManaged}`,
    })
    .returning({ id: machineUsers.id })

  if (!inserted) return existingOrFail(await findHostManaged(tx, scope), scope, logger)

  await writeExtensionAuditEntry(tx, {
    orgId: scope.organizationId,
    eventType: AuditEvent.MACHINE_USER_CREATED,
    resourceType: 'machine_user',
    resourceId: inserted.id,
    extensionName: scope.extensionName,
    payload: { machineUserId: inserted.id, hostManaged: true, trigger: scope.trigger },
  })
  operationalLog(
    logger,
    'info',
    OperationalEvent.CREDENTIAL_SHARING_HOST_MACHINE_USER_PROVISIONED,
    'credentialSharing host-managed machine user provisioned',
    {
      extensionName: scope.extensionName,
      organizationId: scope.organizationId,
      machineUserId: inserted.id,
      trigger: scope.trigger,
    }
  )
  return { machineUserId: inserted.id, created: true }
}

/**
 * Story 73.9 AC-3 resolution order: the admin-provisioned keyed row wins (D7); else, only when the
 * manifest declares the host-managed contract (D4), the host-managed row, provisioned now if absent
 * (AC-2, `trigger = lazy:<method>`); else fail closed.
 */
export async function requireMachineUserForExtension(
  tx: Tx,
  scope: MachineUserScope & { hostManaged: boolean },
  logger: Logger
): Promise<MachineUserAttribution> {
  const adminProvisioned = await resolveAdminProvisioned(tx, scope)
  if (adminProvisioned) return adminProvisioned
  if (!scope.hostManaged) failNoMachineUser(logger, scope)
  const { machineUserId } = await provisionHostManagedMachineUser(
    tx,
    { ...scope, trigger: `lazy:${scope.methodName}` },
    logger
  )
  return { kind: 'host-managed', machineUserId, keyId: null }
}
