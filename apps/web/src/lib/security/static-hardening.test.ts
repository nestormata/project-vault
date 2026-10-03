/**
 * @pv-guard static-hardening
 *
 * Scans the whole source tree (PV's own, or a composed app root through `PV_GUARD_APP_ROOT`) for raw
 * HTML rendering and browser storage, with the pack's entries merged (Story 68.9). The rules live
 * in `guard-rules.ts`; the reviewed carve-outs in `browser-storage-entries.ts`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getFrameProtectionHeaders } from './hardening.js'
import {
  BASE_LOCAL_STORAGE_ENTRIES,
  BASE_SESSION_STORAGE_ENTRIES,
} from './browser-storage-entries.js'
import { rawHtmlViolations, storageViolations, type GuardFile } from './guard-rules.js'
import {
  assertNotVacuous,
  entriesTamperProblem,
  guardSources,
  readGuardEntries,
  readGuardSource,
  removedFiles,
} from '../test/guard-root.js'

function scanned(): GuardFile[] {
  const sources = guardSources(/\.(ts|svelte)$/)
  assertNotVacuous(sources)
  return sources.map((source) => ({ path: source.path, content: readGuardSource(source) }))
}

describe('static frontend hardening', () => {
  it('derives the scanned source root from this checkout', () => {
    const hardcodedCheckout = ['', 'home', 'nestor', 'Proyects', 'project-vault'].join('/')
    expect(readFileSync(fileURLToPath(import.meta.url), 'utf-8')).not.toContain(hardcodedCheckout)
  })

  it('scans a non-empty tree that holds PV sentinels', () => {
    expect(scanned().length).toBeGreaterThan(0)
  })

  it('uses the generated guard entries exactly as the lock recorded them', () => {
    expect(entriesTamperProblem()).toBeNull()
  })

  it('does not use browser storage APIs for token, MFA, or vault material', () => {
    const problems = storageViolations(scanned(), readGuardEntries().browserStorage, removedFiles())
    expect(problems).toEqual([])
  })

  it('Story 16.6 AC-1/AC-2: every reviewed local-storage carve-out is a documented, non-sensitive key', () => {
    const entries = BASE_LOCAL_STORAGE_ENTRIES.map((entry) => entry.file)
    const content = scanned()
      .filter((file) => entries.includes(file.path))
      .map((file) => file.content)
      .join('\n')
    expect(content).toContain("'pv:preAuthTheme:v1'")
  })

  it('Story 16.2 AC-3: every reviewed session-storage carve-out is a documented, non-sensitive key', () => {
    const entries = BASE_SESSION_STORAGE_ENTRIES.map((entry) => entry.file)
    const content = scanned()
      .filter((file) => entries.includes(file.path))
      .map((file) => file.content)
      .join('\n')
    expect(content).toContain("'dismissedOrphanedTheme'")
    expect(content).toContain("'project-vault.registration-locale-pending'")
  })

  it('does not use raw HTML rendering', () => {
    expect(rawHtmlViolations(scanned())).toEqual([])
  })

  it('defines clickjacking protection headers for web responses', () => {
    expect(getFrameProtectionHeaders()).toEqual({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
  })
})
