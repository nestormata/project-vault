/** CSV/formula-injection guard (CWE-1236, OWASP CSV injection prevention): actor_display_name
 * (user_identity_tokens.display_name) is user-controlled — it defaults to the registration
 * email, which this codebase's validator accepts with a leading `+`/`-` local-part — and flows
 * unsanitized into this export's column 2. Excel/Sheets treat a field beginning with `=`, `+`,
 * `-`, or `@` as a formula when the CSV is opened; prefixing with a single quote forces it to be
 * read as inert text without changing the field's visible content. */
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@'])

function neutralizeFormulaPrefix(value: string): string {
  return FORMULA_TRIGGER_CHARS.has(value[0] ?? '') ? `'${value}` : value
}

/**
 * RFC 4180 field quoting (D9) — hand-rolled deliberately; no CSV library dependency for this
 * story's small, fixed 8-column export shape (AC-E8c).
 */
function quoteField(value: string): string {
  const neutralized = neutralizeFormulaPrefix(value)
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replaceAll('"', '""')}"`
  }
  return neutralized
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
