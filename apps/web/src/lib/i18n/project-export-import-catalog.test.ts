import { describe, expect, it } from 'vitest'
import enCatalog from '../../../messages/en.json'
import esCatalog from '../../../messages/es.json'

// Story 62-2 AC-8: every string the export/import UX adds exists in BOTH catalogs, so the Spanish
// UI never relies on the per-string English fallback for these keys.
const REQUIRED_KEYS = [
  'project_export_copy_label',
  'project_export_copy_success',
  'project_export_copy_failure',
  'project_import_file_help',
  'project_import_export_key_show',
  'project_import_export_key_hide',
  'project_import_back_to_projects',
  'project_import_success_intro',
  'project_import_count_credentials',
  'project_import_count_credential_versions',
  'project_import_count_credential_dependencies',
  'project_import_count_rotations',
  'project_import_count_cert_records',
  'project_import_count_domain_records',
  'project_import_count_service_endpoints',
  'project_import_count_status_pages',
  'project_import_count_machine_users',
  'project_import_no_items',
] as const

describe('project export/import catalogs (Story 62-2 AC-8)', () => {
  const en = new Map(Object.entries(enCatalog))
  const es = new Map(Object.entries(esCatalog))

  it.each(REQUIRED_KEYS)('has a non-empty en and es entry for %s', (key) => {
    expect(en.get(key)?.trim()).toBeTruthy()
    expect(es.get(key)?.trim()).toBeTruthy()
  })

  it('has no project_export_/project_import_ key in en that is missing from es, or vice versa', () => {
    const scoped = (catalog: Map<string, string>) =>
      [...catalog.keys()]
        .filter((key) => key.startsWith('project_export_') || key.startsWith('project_import_'))
        .sort()
    expect(scoped(es)).toEqual(scoped(en))
  })

  it('no longer claims the export file is "never uploaded anywhere else"', () => {
    expect(JSON.stringify(enCatalog)).not.toContain('never uploaded anywhere else')
  })
})
