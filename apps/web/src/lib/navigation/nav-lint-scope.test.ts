// Story 68.7 Q1: every registered nav surface renderer is linted type-aware (eslint.config.js
// NAV_RENDERER_FILES), so `svelte/no-navigation-without-resolve` checks its data-driven hrefs by
// type (`ResolvedPathname`) instead of needing a suppression.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAV_SURFACES } from './nav-registry.js'

// A relative path literal, so web-host's test selection sees this test reads outside the package
// (apps/web/eslint.config.js is not shipped, so neither is this test).
const CONFIG = readFileSync(join(import.meta.dirname, '../../../eslint.config.js'), 'utf8')

describe('type-aware lint scope of the nav renderers (Story 68.7 Q1)', () => {
  it('covers every registered renderer file', () => {
    for (const surface of NAV_SURFACES) {
      const covered =
        surface.file.startsWith('src/lib/navigation/') || CONFIG.includes(`'${surface.file}'`)
      expect(covered, `${surface.file} (surface ${surface.id})`).toBe(true)
    }
  })

  it('turns on the TypeScript project service for that list', () => {
    expect(CONFIG).toContain('files: NAV_RENDERER_FILES')
    expect(CONFIG).toContain('projectService: true')
  })
})
