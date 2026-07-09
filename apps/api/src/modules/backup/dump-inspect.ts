export type BackupAssetsPresent = {
  credentials: boolean
  projects: boolean
  users: boolean
  auditEvents: boolean
  dataErasureRequests: boolean
}

// Story 9.1 D8/AC-10: this table list reflects the schema as of this story's implementation. If
// a future Epic 8 (or later) story adds new compliance-relevant tables before Epic 9 fully
// closes, this list — and BackupAssetsPresent above — must be extended to cover them. Documented
// here as a known, accepted limitation rather than left as a silent gap (see D8).
// Single fixed spaces (not `\s+`) — pg_dump's own output is consistently single-spaced, and
// avoiding repeated-quantifier-next-to-alternation keeps this regex clear of ReDoS-shaped
// backtracking (static analysis flags variable-length-repeat-heavy patterns here).
const CREATE_TABLE_PATTERN = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?(\w+)"? *\(/gi

/** Extracts every table name declared with a `CREATE TABLE` statement in a plain-SQL pg_dump —
 * pure text inspection, never executed against any live connection (AC-10's "structural
 * inspection... without executing it" option). */
export function extractTableNames(dumpSql: string): Set<string> {
  const tables = new Set<string>()
  for (const match of dumpSql.matchAll(CREATE_TABLE_PATTERN)) {
    const name = match[1]
    if (name) tables.add(name.toLowerCase())
  }
  return tables
}

export function assetsPresentFromTables(tables: Set<string>): BackupAssetsPresent {
  return {
    credentials: tables.has('credentials'),
    projects: tables.has('projects'),
    users: tables.has('users'),
    auditEvents: tables.has('audit_log_entries'),
    dataErasureRequests: tables.has('data_erasure_requests'),
  }
}

export function allAssetsPresent(assets: BackupAssetsPresent): boolean {
  return Object.values(assets).every(Boolean)
}
