import { createHash } from 'node:crypto'

export type ExtensionDbOperation = 'select' | 'insert' | 'update' | 'delete'
export type ExtensionDbScopeEntry = { table: string; operations: ExtensionDbOperation[] }

export const EXTENSION_DB_SCOPE_DENYLIST = new Set([
  'pgboss',
  'audit_log_entries',
  'platform_audit_events',
  'platform_audit_maintenance_state',
  'platform_audit_pending_entries',
])

const TABLE_IDENTIFIER = /^[a-z][a-z0-9_]*$/
const OPERATIONS = new Set<ExtensionDbOperation>(['select', 'insert', 'update', 'delete'])

export function validateDbScopeTable(table: string): string {
  if (!TABLE_IDENTIFIER.test(table))
    throw new Error(`Invalid extension DB table identifier: ${table}`)
  if (EXTENSION_DB_SCOPE_DENYLIST.has(table)) throw new Error(`Denied extension DB table: ${table}`)
  return table
}

export function quoteIdentifier(identifier: string): string {
  if (!TABLE_IDENTIFIER.test(identifier) && identifier !== 'public') {
    throw new Error(`Invalid PostgreSQL identifier: ${identifier}`)
  }
  return `"${identifier.replaceAll('"', '""')}"`
}

export function canonicalizeDbScope(scope: ExtensionDbScopeEntry[]): ExtensionDbScopeEntry[] {
  return [...scope]
    .map((entry) => ({
      table: validateDbScopeTable(entry.table),
      operations: [...new Set(entry.operations)].sort() as ExtensionDbOperation[],
    }))
    .sort((a, b) => a.table.localeCompare(b.table))
}

export function hashExtensionDbScope(scope: ExtensionDbScopeEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeDbScope(scope)))
    .digest('hex')
}

export function buildGrantStatements(role: string, scope: ExtensionDbScopeEntry[]): string[] {
  const quotedRole = quoteIdentifier(role)
  return canonicalizeDbScope(scope).flatMap((entry) =>
    entry.operations.map((operation) => {
      if (!OPERATIONS.has(operation))
        throw new Error(`Invalid extension DB operation: ${operation}`)
      return `GRANT ${operation.toUpperCase()} ON TABLE ${quoteIdentifier('public')}.${quoteIdentifier(entry.table)} TO ${quotedRole}`
    })
  )
}
