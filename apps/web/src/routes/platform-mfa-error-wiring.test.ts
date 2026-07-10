import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const platformPages = [
  {
    ac: 'AC-M1',
    path: './(app)/platform/settings/+page.svelte',
    error: 'data.errorMessage',
  },
  {
    ac: 'AC-M2',
    path: './(app)/platform/settings/orgs/+page.svelte',
    error: 'pageError',
  },
  {
    ac: 'AC-M3',
    path: './(app)/platform/settings/resource-usage/+page.svelte',
    error: 'data.errorMessage',
  },
  {
    ac: 'AC-M4/AC-M8',
    path: './(app)/platform/audit/+page.svelte',
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
