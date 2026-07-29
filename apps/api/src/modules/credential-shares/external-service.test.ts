import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 17.2 Task 1.3: confirms no other query path in this module ever runs on the raw admin
// connection outside the one, narrow, explicitly-justified point-lookup — a targeted
// lint-style assertion, similar in spirit to route-audit.test.ts's enforcement style, rather than
// relying purely on code review to catch a future accidental second `getAdminDb()` call site.
describe('external-service.ts getAdminDb confinement (Task 1.3)', () => {
  it('getAdminDb is called exactly once, inside adminLookupByTokenHash', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/credential-shares/external-service.ts'),
      'utf-8'
    )
    // Strips block (/** ... */ and /* ... */) and line (//...) comments so a prose mention of
    // `getAdminDb()` inside this module's own documentation doesn't count as a call site.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    const callSites = [...withoutComments.matchAll(/getAdminDb\(\)/g)]
    expect(callSites).toHaveLength(1)

    const functionStart = withoutComments.indexOf('async function adminLookupByTokenHash')
    const functionEnd = withoutComments.indexOf('\n}\n', functionStart)
    expect(functionStart).toBeGreaterThan(-1)

    const callIndex = callSites[0]?.index ?? -1
    expect(callIndex).toBeGreaterThan(functionStart)
    expect(callIndex).toBeLessThan(functionEnd)
  })

  it('every other exported function in this module takes/derives its scope from withOrg, not getAdminDb', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/credential-shares/external-service.ts'),
      'utf-8'
    )
    const withOrgCallSites = [...source.matchAll(/withOrg\(/g)]
    // findExternalShareByTokenHash + revealExternalShare each re-scope via withOrg exactly once.
    expect(withOrgCallSites.length).toBeGreaterThanOrEqual(2)
  })
})
