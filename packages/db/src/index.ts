import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

export type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]

let _db: ReturnType<typeof drizzle> | null = null

function getDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    const sql = postgres(
      process.env['DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault'
    )
    _db = drizzle(sql)
  }
  return _db
}

async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction((tx) => fn(tx as unknown as Tx))
}

export async function withOrg<T>(_orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Story 1.4 adds org-scoped RLS — sets app.current_org_id session variable
  return runInTransaction(fn)
}

export async function withOrgReadScope<T>(_orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Story 1.4 adds read-scope RLS — sets app.readonly_org_id session variable
  return runInTransaction(fn)
}

export async function withAdminAccess<T>(
  _authCtx: unknown,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  // Story 1.4 adds admin RLS — validates authCtx.role === 'admin' before transaction
  return runInTransaction(fn)
}
