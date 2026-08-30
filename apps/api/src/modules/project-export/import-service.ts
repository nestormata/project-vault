import { eq } from 'drizzle-orm'
import {
  certRecords,
  credentialDependencies,
  credentialVersions,
  credentials,
  domainRecords,
  machineUsers,
  rotationChecklistItems,
  rotations,
  serviceEndpoints,
} from '@project-vault/db/schema'
import {
  deriveKey,
  decryptExportBundle,
  HKDF_INFO,
  type EncryptedValue,
} from '@project-vault/crypto'
import { encryptValue } from '../../lib/encrypt-value.js'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import { currentKeyVersion } from '../credentials/db-helpers.js'
import { enableStatusPage, updateStatusPageServices } from '../monitoring/status-page-service.js'
import { createProject } from '../projects/routes.js'
import { EXPORT_FORMAT_VERSION, ExportBundleSchema, type ExportBundle } from './schema.js'

export type DecryptExportFileResult =
  { status: 'decrypt_failed' } | { status: 'ok'; plaintext: string }

function isEncryptedValueShape(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['version'] === 'number' &&
    typeof v['iv'] === 'string' &&
    typeof v['ciphertext'] === 'string' &&
    typeof v['tag'] === 'string'
  )
}

/** AC-3: no distinction between "wrong key" and "corrupted/malformed file" — a file that isn't
 *  even valid JSON, or isn't shaped like an `EncryptedValue`, is treated identically to a GCM
 *  auth-tag failure (same "no oracle" discipline Story 9.1 AC-9 established for backup restore). */
export async function decryptExportFile(
  fileBuffer: Buffer,
  rawExportKey: string
): Promise<DecryptExportFileResult> {
  let envelope: unknown
  try {
    envelope = JSON.parse(fileBuffer.toString('utf8'))
  } catch {
    return { status: 'decrypt_failed' }
  }
  if (!isEncryptedValueShape(envelope)) return { status: 'decrypt_failed' }

  let rawKeyBytes: Buffer
  try {
    rawKeyBytes = Buffer.from(rawExportKey, 'base64url')
    if (rawKeyBytes.length !== 32) return { status: 'decrypt_failed' }
  } catch {
    return { status: 'decrypt_failed' }
  }

  const aesKey = deriveKey(rawKeyBytes, HKDF_INFO.EXPORT)
  try {
    const plaintext = await decryptExportBundle(envelope, aesKey)
    return { status: 'ok', plaintext: plaintext.toString('utf8') }
  } catch {
    return { status: 'decrypt_failed' }
  } finally {
    aesKey.fill(0)
  }
}

export type FormatVersionCheckResult = { status: 'ok' } | { status: 'unsupported'; found: unknown }

/** D7: validated BEFORE any other field is interpreted — a distinct, explicit failure from
 *  AC-3's generic schema-validation failure. */
export function checkExportFormatVersion(json: unknown): FormatVersionCheckResult {
  if (json && typeof json === 'object' && 'exportFormatVersion' in json) {
    const found = (json as Record<string, unknown>)['exportFormatVersion']
    if (found === EXPORT_FORMAT_VERSION) return { status: 'ok' }
    return { status: 'unsupported', found }
  }
  return { status: 'unsupported', found: undefined }
}

export type ParseExportBundleResult =
  { status: 'ok'; bundle: ExportBundle } | { status: 'invalid_payload' }

/** AC-3 Red Team round: the strict Zod schema (with hard size caps) is the last gate before any
 *  database write — a validly-decrypted payload whose shape doesn't match is rejected here, not
 *  interpreted best-effort. */
export function parseExportBundle(json: unknown): ParseExportBundleResult {
  const parsed = ExportBundleSchema.safeParse(json)
  if (!parsed.success) return { status: 'invalid_payload' }
  return { status: 'ok', bundle: parsed.data }
}

export type ImportProjectBundleResult =
  | { status: 'create_project_failed'; error: { code: string; message: string } }
  | {
      status: 'ok'
      projectId: string
      name: string
      counts: Record<string, number>
    }

type ImportTx = SecureRouteContext['tx']
type ImportAuth = SecureRouteContext['auth']

/** Every per-entity-group insert helper below shares this shape: the transaction, the importing
 *  user's auth context, and the newly created project's id. Factored out so each helper's own
 *  signature stays short. */
type ImportTarget = { tx: ImportTx; auth: ImportAuth; projectId: string }

type InsertedCredentials = { newCredentialIds: string[]; newVersionIdByKey: Map<string, string> }

/** Extracted from `insertCredentialsAndVersions` purely to keep that function's own complexity
 *  under this repo's lint thresholds. Inserts every `credential_versions` row for one credential
 *  and returns the id of whichever version matches the export's `currentVersionNumber` (or
 *  `null` for the practically-unreachable zero-version case), so the caller can set
 *  `credentials.currentVersionId` once after this returns. */
async function insertCredentialVersions(
  target: ImportTarget,
  credential: ExportBundle['credentials'][number],
  credentialId: string,
  credentialIndex: number,
  keyVersion: number,
  newVersionIdByKey: Map<string, string>
): Promise<string | null> {
  const { tx, auth } = target
  let currentVersionId: string | null = null
  for (const version of credential.versions) {
    const encryptedValue = version.value !== null ? await encryptValue(version.value) : null
    const [versionRow] = await tx
      .insert(credentialVersions)
      .values({
        orgId: auth.orgId,
        credentialId,
        encryptedValue,
        keyVersion: encryptedValue ? keyVersion : null,
        versionNumber: version.versionNumber,
        schemaVersion: version.schemaVersion,
        fieldMeta: version.fieldMeta as never,
        promotedAt: version.promoted ? new Date() : null,
        purgedAt: encryptedValue ? null : new Date(),
      })
      .returning()
    if (!versionRow) throw new Error('importProjectBundle: version insert returned no row')
    newVersionIdByKey.set(`${credentialIndex}:${version.versionNumber}`, versionRow.id)
    if (credential.currentVersionNumber === version.versionNumber) currentVersionId = versionRow.id
  }
  return currentVersionId
}

/** D1 — inserts every `credentials` row and its full `credential_versions` history, remapping
 *  each secret value to a fresh encryption under the importing org's own live master key
 *  (AC-3 step 6/AC-5) rather than any trace of the exporting org's key. Returns the new IDs so
 *  downstream helpers (dependencies, rotations) can remap their own FKs by (sourceIndex) and
 *  (sourceIndex, versionNumber) respectively — never by carrying a source-instance UUID. */
async function insertCredentialsAndVersions(
  target: ImportTarget,
  bundle: ExportBundle
): Promise<InsertedCredentials> {
  const { tx, auth, projectId } = target
  const keyVersion = await currentKeyVersion(tx)
  const newCredentialIds: string[] = []
  const newVersionIdByKey = new Map<string, string>()

  for (const credential of bundle.credentials) {
    const [row] = await tx
      .insert(credentials)
      .values({
        orgId: auth.orgId,
        projectId,
        name: credential.name,
        description: credential.description,
        tags: credential.tags,
        expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
        alertLeadDays: credential.alertLeadDays,
        notifiedLeadDays: [],
        rotationSchedule: credential.rotationSchedule,
        retentionCount: credential.retentionCount,
        cacheable: credential.cacheable,
        createdBy: auth.userId,
      })
      .returning()
    if (!row) throw new Error('importProjectBundle: credential insert returned no row')
    const credentialIndex = newCredentialIds.push(row.id) - 1

    const currentVersionId = await insertCredentialVersions(
      target,
      credential,
      row.id,
      credentialIndex,
      keyVersion,
      newVersionIdByKey
    )
    if (currentVersionId) {
      await tx.update(credentials).set({ currentVersionId }).where(eq(credentials.id, row.id))
    }
  }

  return { newCredentialIds, newVersionIdByKey }
}

async function insertDependencies(
  target: ImportTarget,
  bundle: ExportBundle,
  newCredentialIds: string[]
): Promise<void> {
  if (bundle.credentialDependencies.length === 0) return
  // Code review fix (28.9): `credentialIndex` is schema-validated only as `>= 0`, not bounded
  // against `credentials.length` (a whole-array cross-field constraint Zod can't express here).
  // A tampered-but-validly-encrypted file (attacker already has the key, per this story's own
  // threat model) with an out-of-range index previously produced `newCredentialIds[i] === undefined`
  // cast to `string`, throwing a raw NOT-NULL/FK violation instead of failing cleanly. Filtered out
  // here, mirroring `insertOneRotation`'s and `insertServiceEndpointsAndStatusPage`'s existing
  // skip-rather-than-throw handling of the same class of dangling index.
  const inRange = bundle.credentialDependencies.filter(
    (dep) => newCredentialIds[dep.credentialIndex] !== undefined
  )
  if (inRange.length === 0) return
  await target.tx.insert(credentialDependencies).values(
    inRange.map((dep) => ({
      orgId: target.auth.orgId,
      credentialId: newCredentialIds[dep.credentialIndex] as string,
      systemName: dep.systemName,
      systemType: dep.systemType,
      notes: dep.notes,
      linkUrl: dep.linkUrl,
      fieldKey: dep.fieldKey,
      createdBy: target.auth.userId,
    }))
  )
}

/** Extracted from `insertRotations` purely to keep that function's own complexity under this
 *  repo's lint thresholds. Inserts one rotation row plus its checklist items; a dangling
 *  version reference (should be unreachable post-schema-validation, but defensive per AC-3's
 *  Red Team round) is skipped rather than thrown. */
async function insertOneRotation(
  target: ImportTarget,
  rotation: ExportBundle['rotations'][number],
  newCredentialIds: string[],
  newVersionIdByKey: Map<string, string>
): Promise<void> {
  const newVersionId = newVersionIdByKey.get(
    `${rotation.credentialIndex}:${rotation.newVersionNumber}`
  )
  const previousVersionId = newVersionIdByKey.get(
    `${rotation.credentialIndex}:${rotation.previousVersionNumber}`
  )
  if (!newVersionId || !previousVersionId) return

  const { tx, auth, projectId } = target
  // D1: rotation-history is a per-item historical record, not attributable to the importing
  // user — initiatedBy is left NULL rather than pointing at the importer (who did not actually
  // initiate any of these historical rotations).
  const [rotationRow] = await tx
    .insert(rotations)
    .values({
      orgId: auth.orgId,
      projectId,
      credentialId: newCredentialIds[rotation.credentialIndex] as string,
      newVersionId,
      previousVersionId,
      status: rotation.status,
      initiatedBy: null,
      initiatedAt: rotation.initiatedAt ? new Date(rotation.initiatedAt) : new Date(),
      completedAt: rotation.completedAt ? new Date(rotation.completedAt) : null,
      promotedAt: rotation.promotedAt ? new Date(rotation.promotedAt) : null,
      retiredAt: rotation.retiredAt ? new Date(rotation.retiredAt) : null,
      notes: rotation.notes,
      targetFields: rotation.targetFields,
    })
    .returning()
  if (!rotationRow) throw new Error('importProjectBundle: rotation insert returned no row')
  if (rotation.checklistItems.length === 0) return

  await tx.insert(rotationChecklistItems).values(
    rotation.checklistItems.map((item) => ({
      orgId: auth.orgId,
      rotationId: rotationRow.id,
      dependencyId: null,
      systemName: item.systemName,
      status: item.status,
      confirmedBy: null,
      confirmedAt: item.confirmedAt ? new Date(item.confirmedAt) : null,
      notes: item.notes,
      retryCount: item.retryCount,
      lastFailureReason: item.lastFailureReason,
      lastActedBy: null,
      lastActedAt: item.lastActedAt ? new Date(item.lastActedAt) : null,
    }))
  )
}

async function insertRotations(
  target: ImportTarget,
  bundle: ExportBundle,
  newCredentialIds: string[],
  newVersionIdByKey: Map<string, string>
): Promise<void> {
  for (const rotation of bundle.rotations) {
    await insertOneRotation(target, rotation, newCredentialIds, newVersionIdByKey)
  }
}

async function insertCertAndDomainRecords(
  target: ImportTarget,
  bundle: ExportBundle
): Promise<void> {
  const { tx, auth, projectId } = target
  if (bundle.certRecords.length > 0) {
    await tx.insert(certRecords).values(
      bundle.certRecords.map((c) => ({
        orgId: auth.orgId,
        projectId,
        domain: c.domain,
        expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
        alertLeadDays: c.alertLeadDays,
        notifiedLeadDays: [],
        createdBy: auth.userId,
      }))
    )
  }
  if (bundle.domainRecords.length > 0) {
    await tx.insert(domainRecords).values(
      bundle.domainRecords.map((d) => ({
        orgId: auth.orgId,
        projectId,
        domainName: d.domainName,
        renewalDate: d.renewalDate ? new Date(d.renewalDate) : null,
        alertLeadDays: d.alertLeadDays,
        notifiedLeadDays: [],
        createdBy: auth.userId,
      }))
    )
  }
}

/** D1 — inserts every `service_endpoints` row, then (if the source project had one) recreates
 *  its status page via the existing `enableStatusPage`/`updateStatusPageServices` flow. A status
 *  page's token is a bearer secret (same "never portable" reasoning as machine-user keys), so
 *  this always mints a brand-new token rather than carrying one across. */
async function insertServiceEndpointsAndStatusPage(
  target: ImportTarget,
  bundle: ExportBundle
): Promise<void> {
  const { tx, auth, projectId } = target
  const newServiceIds: string[] = []
  for (const s of bundle.serviceEndpoints) {
    const [row] = await tx
      .insert(serviceEndpoints)
      .values({
        orgId: auth.orgId,
        projectId,
        name: s.name,
        url: s.url,
        checkFrequencyMinutes: s.checkFrequencyMinutes,
        downThresholdFailures: s.downThresholdFailures,
        createdBy: auth.userId,
      })
      .returning()
    if (!row) throw new Error('importProjectBundle: service endpoint insert returned no row')
    newServiceIds.push(row.id)
  }

  const statusPage = bundle.statusPages[0]
  if (!statusPage || newServiceIds.length === 0) return

  await enableStatusPage(tx, { orgId: auth.orgId, projectId, userId: auth.userId })
  const services = statusPage.services
    .filter((svc) => newServiceIds[svc.serviceIndex])
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((svc) => ({
      serviceId: newServiceIds[svc.serviceIndex] as string,
      displayName: svc.displayName,
    }))
  if (services.length > 0) {
    await updateStatusPageServices(tx, { orgId: auth.orgId, projectId, body: { services } })
  }
}

/** D1/AC-8: definitions only, no key issuance — the importing user issues a fresh key later via
 *  the existing machine-user key-issuance flow if they want to use it. */
async function insertMachineUsers(target: ImportTarget, bundle: ExportBundle): Promise<void> {
  if (bundle.machineUsers.length === 0) return
  await target.tx.insert(machineUsers).values(
    bundle.machineUsers.map((m) => ({
      orgId: target.auth.orgId,
      projectId: target.projectId,
      name: m.name,
      description: m.description,
      role: m.role,
      createdBy: target.auth.userId,
    }))
  )
}

function summarizeImportedCounts(bundle: ExportBundle): Record<string, number> {
  return {
    credentials: bundle.credentials.length,
    credentialVersions: bundle.credentials.reduce((sum, c) => sum + c.versions.length, 0),
    credentialDependencies: bundle.credentialDependencies.length,
    rotations: bundle.rotations.length,
    certRecords: bundle.certRecords.length,
    domainRecords: bundle.domainRecords.length,
    serviceEndpoints: bundle.serviceEndpoints.length,
    statusPages: bundle.statusPages.length,
    machineUsers: bundle.machineUsers.length,
  }
}

/**
 * AC-3/AC-4/AC-5/AC-6/AC-7/AC-8/D1 — the whole-operation transactional import. Runs entirely
 * inside the caller's SecureRoute transaction (`secureCtx.tx`) — a failure anywhere here throws,
 * rolling back everything, so no half-imported project is ever visible (AC-3's "one transaction,
 * fully commits or fully rolls back").
 */
export async function importProjectBundle(
  secureCtx: SecureRouteContext,
  params: {
    bundle: ExportBundle
    projectNameOverride?: string
    logger: Parameters<typeof createProject>[2]
  }
): Promise<ImportProjectBundleResult> {
  const { bundle } = params

  // D4: always a NEW project, in the importing user's own org, with the importing user as sole
  // owner — reuses ordinary project creation verbatim (same slug/policy/membership rules).
  const created = await createProject(
    secureCtx,
    {
      name: params.projectNameOverride?.trim() || bundle.project.name,
      description: bundle.project.description,
    },
    params.logger
  )
  if ('error' in created) return { status: 'create_project_failed', error: created.error }

  const target: ImportTarget = {
    tx: secureCtx.tx,
    auth: secureCtx.auth,
    projectId: created.project.id,
  }

  const { newCredentialIds, newVersionIdByKey } = await insertCredentialsAndVersions(target, bundle)
  await insertDependencies(target, bundle, newCredentialIds)
  await insertRotations(target, bundle, newCredentialIds, newVersionIdByKey)
  await insertCertAndDomainRecords(target, bundle)
  await insertServiceEndpointsAndStatusPage(target, bundle)
  await insertMachineUsers(target, bundle)

  return {
    status: 'ok',
    projectId: target.projectId,
    name: created.project.name,
    counts: summarizeImportedCounts(bundle),
  }
}
