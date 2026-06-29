import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentialVersions,
  credentials,
  pendingImports,
  type PendingImportItemRecord,
} from '@project-vault/db/schema'
import { encrypt } from '@project-vault/crypto'
import type { ImportAction } from '@project-vault/shared'
import {
  parseEnvFile,
  parseJsonImportFile,
  type EnvParseResult,
  type JsonParseResult,
} from '@project-vault/shared'
import { getPrimaryKey } from '../vault/key-service.js'
import { currentKeyVersion, isUniqueViolation } from './db-helpers.js'
import { findProjectInOrg } from './service.js'

export const IMPORT_ENTRY_LIMIT = 500
export const IMPORT_TTL_MS = 15 * 60 * 1000

export type ImportFileType = 'env' | 'json'

export type StagedImportPreview = {
  importId: string
  expiresAt: string
  itemCount: number
  parsed: Array<{
    name: string
    value: '[REDACTED]'
    conflictsWith: string | null
    conflictName: string | null
    suggestedAction: ImportAction
  }>
  warnings: EnvParseResult['warnings']
  auditPayload: { importId: string; itemCount: number; fileType: ImportFileType }
  operational: {
    fileType: ImportFileType
    warningCount: number
    conflictCount: number
  }
}

export type ConfirmImportResult = {
  imported: number
  newVersions: number
  skipped: number
  results: Array<{ name: string; action: ImportAction; credentialId: string | null }>
  auditPayload: { importId: string; imported: number; newVersions: number; skipped: number }
}

export function detectImportFileType(filename: string | undefined): ImportFileType | 'unsupported' {
  if (!filename) return 'unsupported'
  const lower = filename.toLowerCase()
  if (lower.endsWith('.env')) return 'env'
  if (lower.endsWith('.json')) return 'json'
  return 'unsupported'
}

export function parseImportFileContent(
  fileType: ImportFileType,
  content: string
): EnvParseResult | JsonParseResult {
  if (fileType === 'env') return parseEnvFile(content)
  return parseJsonImportFile(content)
}

export function resolveImportAction(
  item: PendingImportItemRecord,
  defaultAction: ImportAction,
  overrides: Record<string, ImportAction> | undefined
): ImportAction {
  const action = overrides?.[item.name] ?? defaultAction
  if (item.conflictsWith === null && action === 'new_version') return 'create_new'
  return action
}

async function encryptImportEntries(
  tx: Tx,
  entries: Array<{ name: string; value: string }>,
  conflictMap: Map<string, { id: string; name: string }>
): Promise<PendingImportItemRecord[]> {
  const keyMaterial = getPrimaryKey()
  const keyVersion = await currentKeyVersion(tx)
  const items: PendingImportItemRecord[] = []

  try {
    for (const entry of entries) {
      const plaintext = Buffer.from(entry.value, 'utf8')
      let encryptedValue
      try {
        encryptedValue = await encrypt(plaintext, keyMaterial)
      } finally {
        plaintext.fill(0)
      }

      const conflict = conflictMap.get(entry.name)
      const conflictsWith = conflict?.id ?? null
      items.push({
        name: entry.name,
        encryptedValue,
        keyVersion,
        conflictsWith,
        suggestedAction: conflictsWith ? 'new_version' : 'create_new',
      })
    }
  } finally {
    keyMaterial.fill(0)
  }

  return items
}

export async function stageCredentialImport(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    userId: string
    fileType: ImportFileType
    content: string
  }
): Promise<
  | { status: 'project_not_found' }
  | { status: 'too_large'; found: number }
  | { status: 'ok'; preview: StagedImportPreview }
> {
  const projectExists = await findProjectInOrg(tx, params.projectId)
  if (!projectExists) return { status: 'project_not_found' }

  const parsed = parseImportFileContent(params.fileType, params.content)
  if (parsed.entries.length > IMPORT_ENTRY_LIMIT) {
    return { status: 'too_large', found: parsed.entries.length }
  }

  const entryNames = parsed.entries.map((entry) => entry.name)
  const conflicting =
    entryNames.length === 0
      ? []
      : await tx
          .select({ id: credentials.id, name: credentials.name })
          .from(credentials)
          .where(
            and(eq(credentials.projectId, params.projectId), inArray(credentials.name, entryNames))
          )

  const conflictMap = new Map(conflicting.map((row) => [row.name, row]))
  const items = await encryptImportEntries(tx, parsed.entries, conflictMap)
  const expiresAt = new Date(Date.now() + IMPORT_TTL_MS)

  const [importRecord] = await tx
    .insert(pendingImports)
    .values({
      orgId: params.orgId,
      projectId: params.projectId,
      createdBy: params.userId,
      fileType: params.fileType,
      itemCount: items.length,
      items,
      warnings: parsed.warnings,
      expiresAt,
    })
    .returning({ id: pendingImports.id, expiresAt: pendingImports.expiresAt })

  if (!importRecord) throw new Error('pending_imports insert returned no row')

  const conflictCount = items.filter((item) => item.conflictsWith !== null).length
  const previewParsed = items.map((item) => ({
    name: item.name,
    value: '[REDACTED]' as const,
    conflictsWith: item.conflictsWith,
    conflictName: item.conflictsWith ? item.name : null,
    suggestedAction: item.suggestedAction,
  }))

  return {
    status: 'ok',
    preview: {
      importId: importRecord.id,
      expiresAt: importRecord.expiresAt.toISOString(),
      itemCount: items.length,
      parsed: previewParsed,
      warnings: parsed.warnings,
      auditPayload: {
        importId: importRecord.id,
        itemCount: items.length,
        fileType: params.fileType,
      },
      operational: {
        fileType: params.fileType,
        warningCount: parsed.warnings.length,
        conflictCount,
      },
    },
  }
}

async function insertImportedCredential(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    userId: string
    name: string
    item: PendingImportItemRecord
  }
): Promise<string> {
  const [newCred] = await tx
    .insert(credentials)
    .values({
      orgId: params.orgId,
      projectId: params.projectId,
      name: params.name,
      description: null,
      tags: [],
      expiresAt: null,
      rotationSchedule: null,
      retentionCount: 3,
      createdBy: params.userId,
    })
    .returning({ id: credentials.id })
  if (!newCred) throw new Error('Credential insert returned no row')

  await tx.insert(credentialVersions).values({
    orgId: params.orgId,
    credentialId: newCred.id,
    encryptedValue: params.item.encryptedValue,
    keyVersion: params.item.keyVersion,
    versionNumber: 1,
    createdBy: params.userId,
    rotationLockedAt: null,
    purgedAt: null,
  })

  return newCred.id
}

async function insertImportedVersion(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    userId: string
    credentialId: string
    item: PendingImportItemRecord
  }
): Promise<number> {
  const [cred] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
    .for('update')
    .limit(1)
  if (!cred) throw new Error('Credential not found for new_version import')

  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, params.credentialId))
  const nextVersion = Number(maxRow?.max ?? 0) + 1

  try {
    await tx.insert(credentialVersions).values({
      orgId: params.orgId,
      credentialId: params.credentialId,
      encryptedValue: params.item.encryptedValue,
      keyVersion: params.item.keyVersion,
      versionNumber: nextVersion,
      createdBy: params.userId,
      rotationLockedAt: null,
      purgedAt: null,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error('Concurrent version creation conflict during import')
    }
    throw error
  }

  return nextVersion
}

export async function confirmCredentialImport(
  tx: Tx,
  params: {
    orgId: string
    projectId: string
    userId: string
    importId: string
    defaultAction: ImportAction
    overrides?: Record<string, ImportAction>
    confirmTimestampMs?: number
  }
): Promise<
  | { status: 'not_found' }
  | { status: 'expired'; expiredAt: string }
  | { status: 'ok'; result: ConfirmImportResult; perCredentialAudits: PerCredentialImportAudit[] }
> {
  const [importRecord] = await tx
    .select()
    .from(pendingImports)
    .where(
      and(eq(pendingImports.id, params.importId), eq(pendingImports.projectId, params.projectId))
    )
    .limit(1)
    .for('update')

  if (!importRecord) return { status: 'not_found' }
  if (importRecord.expiresAt < new Date()) {
    return { status: 'expired', expiredAt: importRecord.expiresAt.toISOString() }
  }

  const suffixTimestamp = params.confirmTimestampMs ?? Date.now()
  let imported = 0
  let newVersions = 0
  let skipped = 0
  const results: ConfirmImportResult['results'] = []
  const perCredentialAudits: PerCredentialImportAudit[] = []

  for (let itemIndex = 0; itemIndex < importRecord.items.length; itemIndex++) {
    const item = importRecord.items.at(itemIndex)
    if (!item) continue
    const action = resolveImportAction(item, params.defaultAction, params.overrides)

    if (action === 'skip') {
      results.push({ name: item.name, action: 'skip', credentialId: null })
      skipped += 1
      continue
    }

    if (action === 'new_version') {
      if (!item.conflictsWith) {
        throw new Error('new_version action requires conflictsWith')
      }
      await insertImportedVersion(tx, {
        orgId: params.orgId,
        projectId: params.projectId,
        userId: params.userId,
        credentialId: item.conflictsWith,
        item,
      })
      results.push({
        name: item.name,
        action: 'new_version',
        credentialId: item.conflictsWith,
      })
      perCredentialAudits.push({
        eventType: 'credential.version_created',
        resourceId: item.conflictsWith,
        payload: {},
      })
      newVersions += 1
      imported += 1
      continue
    }

    const credentialName =
      item.conflictsWith === null
        ? item.name
        : `${item.name}_imported_${suffixTimestamp}_${itemIndex}`

    const credentialId = await insertImportedCredential(tx, {
      orgId: params.orgId,
      projectId: params.projectId,
      userId: params.userId,
      name: credentialName,
      item,
    })
    results.push({ name: item.name, action: 'create_new', credentialId })
    perCredentialAudits.push({
      eventType: 'credential.created',
      resourceId: credentialId,
      payload: {},
    })
    imported += 1
  }

  await tx.delete(pendingImports).where(eq(pendingImports.id, params.importId))

  return {
    status: 'ok',
    result: {
      imported,
      newVersions,
      skipped,
      results,
      auditPayload: {
        importId: params.importId,
        imported,
        newVersions,
        skipped,
      },
    },
    perCredentialAudits,
  }
}

export type PerCredentialImportAudit = {
  eventType: 'credential.created' | 'credential.version_created'
  resourceId: string
  payload: Record<string, unknown>
}
