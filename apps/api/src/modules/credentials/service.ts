import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentialVersions, credentials, projects, vaultState } from '@project-vault/db/schema'
import { encrypt, withSecret, type EncryptedValue } from '@project-vault/crypto'
import { getPrimaryKey } from '../vault/key-service.js'
import type { AddVersionBody, CreateCredentialBody } from './schema.js'

export class VersionConflictError extends Error {
  constructor() {
    super('Concurrent version creation conflict')
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== 'object') return false
  return (cause as { code?: string }).code === '23505'
}

async function currentKeyVersion(tx: Tx): Promise<number> {
  const [vs] = await tx.select({ keyVersion: vaultState.keyVersion }).from(vaultState).limit(1)
  return vs?.keyVersion ?? 1
}

async function encryptValue(value: string): Promise<EncryptedValue> {
  const plaintext = Buffer.from(value, 'utf8')
  const key = getPrimaryKey()
  try {
    return await encrypt(plaintext, key)
  } finally {
    plaintext.fill(0)
    key.fill(0)
  }
}

export function serializeCredentialDetail(
  credential: typeof credentials.$inferSelect,
  currentVersionNumber: number
) {
  return {
    id: credential.id,
    projectId: credential.projectId,
    orgId: credential.orgId,
    name: credential.name,
    description: credential.description,
    tags: credential.tags,
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    rotationSchedule: credential.rotationSchedule,
    retentionCount: credential.retentionCount,
    currentVersionNumber,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  }
}

export async function findProjectInOrg(tx: Tx, projectId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .limit(1)
  return Boolean(rows[0])
}

export async function createCredentialWithFirstVersion(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    userId: string
    body: CreateCredentialBody
  }
) {
  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(input.body.value)

  const [credential] = await tx
    .insert(credentials)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.body.name,
      description: input.body.description ?? null,
      tags: input.body.tags ?? [],
      expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : null,
      rotationSchedule: input.body.rotationSchedule ?? null,
      createdBy: input.userId,
    })
    .returning()
  if (!credential) throw new Error('Credential insert returned no row')

  await tx.insert(credentialVersions).values({
    orgId: input.orgId,
    credentialId: credential.id,
    encryptedValue,
    keyVersion,
    versionNumber: 1,
    createdBy: input.userId,
  })

  return { credential, detail: serializeCredentialDetail(credential, 1) }
}

export async function findCredentialInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const [credential] = await tx
    .select()
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
    .limit(1)
  return credential ?? null
}

export async function addCredentialVersion(
  tx: Tx,
  input: {
    orgId: string
    credentialId: string
    projectId: string
    userId: string
    body: AddVersionBody
  }
) {
  const [cred] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.id, input.credentialId), eq(credentials.projectId, input.projectId)))
    .for('update')
    .limit(1)
  if (!cred) return null

  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, input.credentialId))
  const nextVersion = Number(maxRow?.max ?? 0) + 1

  const keyVersion = await currentKeyVersion(tx)
  const encryptedValue = await encryptValue(input.body.value)

  try {
    const [version] = await tx
      .insert(credentialVersions)
      .values({
        orgId: input.orgId,
        credentialId: input.credentialId,
        encryptedValue,
        keyVersion,
        versionNumber: nextVersion,
        createdBy: input.userId,
      })
      .returning()
    if (!version) throw new Error('Credential version insert returned no row')
    return version
  } catch (error) {
    if (isUniqueViolation(error)) throw new VersionConflictError()
    throw error
  }
}

export async function revealCurrentValue(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return null

  const [version] = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      encryptedValue: credentialVersions.encryptedValue,
    })
    .from(credentialVersions)
    .where(
      and(
        eq(credentialVersions.credentialId, params.credentialId),
        isNull(credentialVersions.purgedAt)
      )
    )
    .orderBy(desc(credentialVersions.versionNumber))
    .limit(1)

  if (!version || !version.encryptedValue) return null

  // reveal path: Buffer->string permitted here (the one sanctioned conversion site)
  const value = await withSecret(version.encryptedValue, async (plaintext) =>
    plaintext.toString('utf8')
  )
  return { value, versionNumber: version.versionNumber }
}

export async function listVersionHistory(
  tx: Tx,
  params: { credentialId: string; projectId: string }
) {
  const credential = await findCredentialInProject(tx, params)
  if (!credential) return null

  const rows = await tx
    .select({
      versionNumber: credentialVersions.versionNumber,
      createdBy: credentialVersions.createdBy,
      createdAt: credentialVersions.createdAt,
      purgedAt: credentialVersions.purgedAt,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.credentialId, params.credentialId))
    .orderBy(desc(credentialVersions.versionNumber))

  const currentVersionNumber = rows.find((row) => row.purgedAt === null)?.versionNumber

  return rows.map((row) => ({
    versionNumber: row.versionNumber,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.versionNumber === currentVersionNumber,
    purgedAt: row.purgedAt?.toISOString() ?? null,
  }))
}
