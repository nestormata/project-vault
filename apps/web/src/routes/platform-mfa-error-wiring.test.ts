import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Story 69.5: each platform page's markup lives in its region component under
// `$lib/components/platform`, so the wiring is asserted on that file.
const platformPages = [
  {
    ac: 'AC-M1',
    path: '../lib/components/platform/PlatformSettingsContent.svelte',
    error: 'data.errorMessage',
  },
  {
    ac: 'AC-M2',
    path: '../lib/components/platform/PlatformOrgsContent.svelte',
    error: 'pageError',
  },
  {
    ac: 'AC-M3',
    path: '../lib/components/platform/PlatformResourceUsageContent.svelte',
    error: 'data.errorMessage',
  },
  {
    ac: 'AC-M4/AC-M8',
    path: '../lib/components/platform/PlatformAuditContent.svelte',
    error: 'data.eventsErrorMessage',
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
      expect(source).toMatch(
        new RegExp(`<MfaAwareErrorAlert\\s+message=\\{${error.replace('.', '\\.')}\\}`)
      )
    }
  )
})
