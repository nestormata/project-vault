import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Story 69.5: each platform page's markup lives in its region component under
// `$lib/components/platform` (a page that was split into sub-regions: the sub-region that renders
// the error), so the wiring is asserted on that file.
const platformPages = [
  {
    ac: 'AC-M1',
    path: '../lib/components/platform/PlatformSettingsContent.svelte',
    error: 'pageData.errorMessage',
  },
  {
    ac: 'AC-M2',
    path: '../lib/components/platform/PlatformOrgsContent.svelte',
    error: 'pageError',
  },
  {
    ac: 'AC-M2 (create)',
    path: '../lib/components/platform/PlatformOrgsCreateStatus.svelte',
    error: 'create.createMfaError',
  },
  {
    ac: 'AC-M3',
    path: '../lib/components/platform/PlatformResourceUsageError.svelte',
    error: 'errorMessage',
  },
  {
    ac: 'AC-M4/AC-M8',
    path: '../lib/components/platform/PlatformAuditResults.svelte',
    error: 'errorMessage',
  },
] as const

describe('platform MFA error guidance wiring', () => {
  it.each(platformPages)(
    '$ac routes $error through the tested MFA-aware alert',
    ({ path, error }) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')

      expect(source).toContain(
        "import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'"
      )
      expect(source.replace(/\s+/g, ' ')).toContain(`<MfaAwareErrorAlert message={${error}}`)
    }
  )
})
