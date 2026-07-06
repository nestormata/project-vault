/**
 * RFC 4180 field quoting (D9) — hand-rolled deliberately; no CSV library dependency for this
 * story's small, fixed 8-column export shape (AC-E8c).
 */
function quoteField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function toCsvRow(fields: (string | null | undefined)[]): string {
  return fields.map((field) => quoteField(field ?? '')).join(',')
}

export const AUDIT_EXPORT_CSV_HEADER = [
  'timestamp',
  'actor_display_name',
  'event_type',
  'resource_id',
  'resource_type',
  'org_id',
  'project_id',
  'ip_address',
].join(',')
