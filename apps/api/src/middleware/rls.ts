import { sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type TransactionalDb = {
  transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
}

function assertUuid(value: string, caller: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`${caller}: invalid orgId - expected UUID, received: "${value}"`)
  }
}

export async function setRlsOrgContext(
  tx: { execute: (query: unknown) => Promise<unknown> | unknown },
  orgId: string
): Promise<void> {
  assertUuid(orgId, 'setRlsOrgContext')
  await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
}

export async function runOrgScopedJob<T>(
  orgId: string,
  jobName: string,
  fn: (ctx: { tx: Tx; orgId: string; jobName: string }) => Promise<T>,
  options: { db?: TransactionalDb } = {}
): Promise<T> {
  assertUuid(orgId, 'runOrgScopedJob')
  const db = (options.db ?? getDb()) as TransactionalDb
  const result = await db.transaction(async (tx) => {
    await setRlsOrgContext(tx as { execute: (query: unknown) => Promise<unknown> }, orgId)
    return fn({ tx: tx as Tx, orgId, jobName })
  })
  return result as T
}
