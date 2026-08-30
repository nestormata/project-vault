import { randomBytes } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  certRecords,
  credentialDependencies,
  credentials,
  credentialVersions,
  domainRecords,
  machineUsers,
  projects,
  rotationChecklistItems,
  rotations,
  serviceEndpoints,
  statusPageServices,
  statusPages,
} from '@project-vault/db/schema'
import {
  deriveKey,
  encryptExportBundle,
  HKDF_INFO,
  withSecret,
  type EncryptedValue,
} from '@project-vault/crypto'
import { EXPORT_FORMAT_VERSION, type ExportBundle, type ExportCredential } from './schema.js'

/**
 * Story 28.9 D2 — sibling of credential-shares' `generateShareToken()`, deliberately NOT reused
 * directly: a share token authorizes a server-side reveal (verified by the server against a
 * stored hash); an export key is real client-held key material the server never stores any trace
 * of, not even hashed (D2). Same primitive/encoding (`randomBytes(32).toString('base64url')`),
 * different domain.
 */
export function generateExportKey(): string {
  return randomBytes(32).toString('base64url')
}

// Terminal rotation statuses — every other value (in_progress/staged/stale_recovery) is a live
// state-machine status that must never appear on an imported row, since no state machine is
// actually running for it in the new project (D5/AC-6).
const TERMINAL_ROTATION_STATUSES = new Set([
  'promoted',
  'retired',
  'completed',
  'abandoned',
  'break_glass_complete',
])

/** D5/AC-6: coerces a non-terminal rotation status to 'completed' at EXPORT time (not import
 *  time) — documented here as the single place this decision is made. A rotation that was
 *  genuinely in_progress/staged/stale_recovery at export time becomes a plain historical
 *  'completed' record; every already-terminal status passes through unchanged. */
export function coerceRotationStatusForExport(status: string): string {
  return TERMINAL_ROTATION_STATUSES.has(status) ? status : 'completed'
}

type CredentialRow = typeof credentials.$inferSelect
type CredentialVersionRow = typeof credentialVersions.$inferSelect
type RotationRow = typeof rotations.$inferSelect
type RotationChecklistItemRow = typeof rotationChecklistItems.$inferSelect

/** Shared date-formatting used across every export serializer function below — keeps each of
 *  their own cyclomatic complexity counts down (this repo's `complexity`/`cognitive-complexity`
 *  rules count each `?.`/`??` as its own decision point) by moving the null-safe formatting out
 *  to one place. */
function toIsoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** Extracted from `buildExportRotation` purely to keep that function's own complexity under this
 *  repo's lint thresholds. */
function buildExportChecklistItems(
  items: RotationChecklistItemRow[]
): ExportBundle['rotations'][number]['checklistItems'] {
  return items.map((item) => ({
    systemName: item.systemName,
    status: item.status,
    confirmedAt: toIsoOrNull(item.confirmedAt),
    notes: item.notes,
    retryCount: item.retryCount,
    lastFailureReason: item.lastFailureReason,
    lastActedAt: toIsoOrNull(item.lastActedAt),
  }))
}

/** Extracted from `buildExportBundle` purely to keep that function's own cyclomatic/cognitive
 *  complexity under this repo's lint thresholds. Returns an array (0 or 1 items) rather than
 *  `T | undefined` so its only caller can keep using `flatMap` to skip an unresolvable rotation
 *  (see the inline comment below) without a second filter pass. */
function buildExportRotation(
  rotation: RotationRow,
  lookups: {
    versionById: Map<string, CredentialVersionRow>
    credentialIndexById: Map<string, number>
    checklistByRotation: Map<string, RotationChecklistItemRow[]>
  }
): ExportBundle['rotations'] {
  const newVersion = lookups.versionById.get(rotation.newVersionId)
  const previousVersion = lookups.versionById.get(rotation.previousVersionId)
  // Defensive: both versions must resolve — if not (should be unreachable given FK integrity),
  // skip this rotation rather than emit a row with a dangling reference.
  if (!newVersion || !previousVersion) return []
  return [
    {
      credentialIndex: lookups.credentialIndexById.get(rotation.credentialId) ?? 0,
      newVersionNumber: newVersion.versionNumber,
      previousVersionNumber: previousVersion.versionNumber,
      status: coerceRotationStatusForExport(rotation.status),
      initiatedAt: rotation.initiatedAt.toISOString(),
      completedAt: toIsoOrNull(rotation.completedAt),
      promotedAt: toIsoOrNull(rotation.promotedAt),
      retiredAt: toIsoOrNull(rotation.retiredAt),
      notes: rotation.notes,
      targetFields: rotation.targetFields,
      checklistItems: buildExportChecklistItems(lookups.checklistByRotation.get(rotation.id) ?? []),
    },
  ]
}

async function decryptVersionValue(version: CredentialVersionRow): Promise<string | null> {
  if (!version.encryptedValue) return null // purged (retention job) — nothing to carry across
  return withSecret(version.encryptedValue as EncryptedValue, async (buf) => buf.toString('utf8'))
}

async function buildExportCredential(tx: Tx, credential: CredentialRow): Promise<ExportCredential> {
  const versionRows = await tx
    .select()
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, credential.id))
    .orderBy(asc(credentialVersions.versionNumber))

  const versions = await Promise.all(
    versionRows.map(async (version) => ({
      versionNumber: version.versionNumber,
      schemaVersion: version.schemaVersion,
      fieldMeta: version.fieldMeta ?? null,
      value: await decryptVersionValue(version),
      promoted: version.promotedAt !== null,
      createdAt: version.createdAt.toISOString(),
    }))
  )

  const currentVersion = versionRows.find((v) => v.id === credential.currentVersionId)

  return {
    name: credential.name,
    description: credential.description,
    tags: credential.tags,
    expiresAt: toIsoOrNull(credential.expiresAt),
    alertLeadDays: credential.alertLeadDays,
    notifiedLeadDays: credential.notifiedLeadDays,
    rotationSchedule: credential.rotationSchedule,
    retentionCount: credential.retentionCount,
    cacheable: credential.cacheable,
    createdAt: credential.createdAt.toISOString(),
    currentVersionNumber: currentVersion?.versionNumber ?? null,
    versions,
  }
}

export type ExportEntityCounts = Record<string, number>

export type BuildExportBundleResult = { bundle: ExportBundle; counts: ExportEntityCounts }

/**
 * D1 — assembles the full plaintext export payload for `projectId`. Every secret value is fully
 * decrypted via `withSecret()` (zeroed after use by that helper's own `finally` block) and never
 * written anywhere except into this in-memory JSON object, which the caller immediately
 * re-encrypts under the export key (AC-1 step 3) — this function itself never persists or
 * transmits plaintext.
 */
export async function buildExportBundle(
  tx: Tx,
  params: { orgId: string; projectId: string }
): Promise<BuildExportBundleResult> {
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, params.projectId))
    .limit(1)
  if (!project) throw new Error('buildExportBundle: project not found')

  const credentialRows = await tx
    .select()
    .from(credentials)
    .where(eq(credentials.projectId, params.projectId))
    .orderBy(asc(credentials.createdAt))
  const credentialIndexById = new Map(credentialRows.map((c, i) => [c.id, i]))

  const exportCredentials = await Promise.all(
    credentialRows.map((credential) => buildExportCredential(tx, credential))
  )

  const dependencyRows = credentialRows.length
    ? await tx
        .select()
        .from(credentialDependencies)
        .where(
          inArray(
            credentialDependencies.credentialId,
            credentialRows.map((c) => c.id)
          )
        )
    : []
  const exportDependencies = dependencyRows.map((dep) => ({
    credentialIndex: credentialIndexById.get(dep.credentialId) ?? 0,
    systemName: dep.systemName,
    systemType: dep.systemType,
    notes: dep.notes,
    linkUrl: dep.linkUrl,
    fieldKey: dep.fieldKey,
  }))

  const rotationRows = await tx
    .select()
    .from(rotations)
    .where(eq(rotations.projectId, params.projectId))
    .orderBy(asc(rotations.initiatedAt))

  // credential_versions rows referenced by rotations — needed to resolve newVersionId/
  // previousVersionId to their (credentialIndex, versionNumber) pair, since D1 remaps every FK
  // to newly generated IDs rather than carrying source-instance UUIDs into the export file.
  const versionIds = [
    ...new Set(rotationRows.flatMap((r) => [r.newVersionId, r.previousVersionId])),
  ]
  const referencedVersions = versionIds.length
    ? await tx.select().from(credentialVersions).where(inArray(credentialVersions.id, versionIds))
    : []
  const versionById = new Map(referencedVersions.map((v) => [v.id, v]))

  const rotationIds = rotationRows.map((r) => r.id)
  const checklistRows = rotationIds.length
    ? await tx
        .select()
        .from(rotationChecklistItems)
        .where(inArray(rotationChecklistItems.rotationId, rotationIds))
    : []
  const checklistByRotation = new Map<string, typeof checklistRows>()
  for (const item of checklistRows) {
    const bucket = checklistByRotation.get(item.rotationId) ?? []
    bucket.push(item)
    checklistByRotation.set(item.rotationId, bucket)
  }

  const exportRotations = rotationRows.flatMap((rotation) =>
    buildExportRotation(rotation, { versionById, credentialIndexById, checklistByRotation })
  )

  const certRows = await tx
    .select()
    .from(certRecords)
    .where(eq(certRecords.projectId, params.projectId))
  const exportCertRecords = certRows.map((c) => ({
    domain: c.domain,
    expiresAt: toIsoOrNull(c.expiresAt),
    alertLeadDays: c.alertLeadDays,
    notifiedLeadDays: c.notifiedLeadDays,
  }))

  const domainRows = await tx
    .select()
    .from(domainRecords)
    .where(eq(domainRecords.projectId, params.projectId))
  const exportDomainRecords = domainRows.map((d) => ({
    domainName: d.domainName,
    renewalDate: toIsoOrNull(d.renewalDate),
    alertLeadDays: d.alertLeadDays,
    notifiedLeadDays: d.notifiedLeadDays,
  }))

  const serviceRows = await tx
    .select()
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.projectId, params.projectId))
    .orderBy(asc(serviceEndpoints.createdAt))
  const serviceIndexById = new Map(serviceRows.map((s, i) => [s.id, i]))
  const exportServiceEndpoints = serviceRows.map((s) => ({
    name: s.name,
    url: s.url,
    checkFrequencyMinutes: s.checkFrequencyMinutes,
    downThresholdFailures: s.downThresholdFailures,
  }))

  const statusPageRows = await tx
    .select()
    .from(statusPages)
    .where(eq(statusPages.projectId, params.projectId))
    .limit(1)
  let exportStatusPages: ExportBundle['statusPages'] = []
  if (statusPageRows[0]) {
    const spServiceRows = await tx
      .select()
      .from(statusPageServices)
      .where(eq(statusPageServices.statusPageId, statusPageRows[0].id))
      .orderBy(asc(statusPageServices.sortOrder))
    exportStatusPages = [
      {
        services: spServiceRows
          .filter((s) => serviceIndexById.has(s.serviceId))
          .map((s) => ({
            serviceIndex: serviceIndexById.get(s.serviceId) as number,
            displayName: s.displayName,
            sortOrder: s.sortOrder,
          })),
      },
    ]
  }

  const machineUserRows = await tx
    .select()
    .from(machineUsers)
    .where(eq(machineUsers.projectId, params.projectId))
  // D1/AC-8: definitions only — no API key/secret is exported (machine_users itself has no key
  // column; the live key material lives in a separate table this story never touches).
  const exportMachineUsers = machineUserRows.map((m) => ({
    name: m.name,
    description: m.description,
    role: m.role,
  }))

  const bundle: ExportBundle = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    project: { name: project.name, description: project.description, tags: project.tags },
    credentials: exportCredentials,
    credentialDependencies: exportDependencies,
    rotations: exportRotations,
    certRecords: exportCertRecords,
    domainRecords: exportDomainRecords,
    serviceEndpoints: exportServiceEndpoints,
    statusPages: exportStatusPages,
    machineUsers: exportMachineUsers,
  }

  const counts: ExportEntityCounts = {
    credentials: exportCredentials.length,
    credentialVersions: exportCredentials.reduce((sum, c) => sum + c.versions.length, 0),
    credentialDependencies: exportDependencies.length,
    rotations: exportRotations.length,
    certRecords: exportCertRecords.length,
    domainRecords: exportDomainRecords.length,
    serviceEndpoints: exportServiceEndpoints.length,
    statusPages: exportStatusPages.length,
    machineUsers: exportMachineUsers.length,
  }

  return { bundle, counts }
}

/** D2/D3: HKDF-derives the actual AES key from the shown raw export key, then encrypts the
 *  bundle. The raw key bytes are never used directly as an AES key. */
export async function encryptBundleUnderExportKey(
  bundle: ExportBundle,
  rawExportKey: string
): Promise<EncryptedValue> {
  const rawKeyBytes = Buffer.from(rawExportKey, 'base64url')
  const aesKey = deriveKey(rawKeyBytes, HKDF_INFO.EXPORT)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  try {
    return await encryptExportBundle(plaintext, aesKey)
  } finally {
    aesKey.fill(0)
    plaintext.fill(0)
  }
}
