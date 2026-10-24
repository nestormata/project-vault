import * as m from '$lib/paraglide/messages.js'

// Story 62-2 AC-4: fixed display order, independent of the API object's key order. A key the
// API adds later with a positive count still renders (raw key as label) instead of vanishing.
const COUNT_LABELS: ReadonlyArray<readonly [string, () => string]> = [
  ['credentials', m.project_import_count_credentials],
  ['credentialVersions', m.project_import_count_credential_versions],
  ['credentialDependencies', m.project_import_count_credential_dependencies],
  ['rotations', m.project_import_count_rotations],
  ['certRecords', m.project_import_count_cert_records],
  ['domainRecords', m.project_import_count_domain_records],
  ['serviceEndpoints', m.project_import_count_service_endpoints],
  ['statusPages', m.project_import_count_status_pages],
  ['machineUsers', m.project_import_count_machine_users],
]

function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function importedCountRows(
  counts: Record<string, number>
): Array<{ label: string; count: number }> {
  const known = new Set(COUNT_LABELS.map(([key]) => key))
  const byKey = new Map(Object.entries(counts))
  const rows = COUNT_LABELS.flatMap(([key, label]) => {
    const count = byKey.get(key)
    return isPositiveCount(count) ? [{ label: label(), count }] : []
  })
  const unknown = Object.entries(counts).flatMap(([key, count]) =>
    !known.has(key) && isPositiveCount(count) ? [{ label: key, count }] : []
  )
  return [...rows, ...unknown]
}
