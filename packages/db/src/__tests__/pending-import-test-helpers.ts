import { expect } from 'vitest'
import type { Tx } from '../index.js'
import { pendingImports, type ParseWarning, type PendingImportItemRecord } from '../schema/index.js'

type PendingImportInsert = {
  orgId: string
  projectId: string
  createdBy: string
  fileType?: 'env' | 'json'
  itemCount?: number
  items?: PendingImportItemRecord[]
  warnings?: ParseWarning[]
  expiresAt: Date
}

export async function insertTestPendingImport(
  tx: Tx,
  values: PendingImportInsert
): Promise<string> {
  const [row] = await tx
    .insert(pendingImports)
    .values({
      orgId: values.orgId,
      projectId: values.projectId,
      createdBy: values.createdBy,
      fileType: values.fileType ?? 'env',
      itemCount: values.itemCount ?? 0,
      items: values.items ?? [],
      warnings: values.warnings ?? [],
      expiresAt: values.expiresAt,
    })
    .returning({ id: pendingImports.id })

  if (!row) throw new Error('expected pending import row to be inserted')
  return row.id
}

export async function expectPendingImportInsertRejects(
  insert: () => Promise<unknown>
): Promise<void> {
  await expect(insert()).rejects.toThrow()
}
