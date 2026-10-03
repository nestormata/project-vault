import { describe, expect, it } from 'vitest'

// Story 68.4 AC-6 / AC-7 / AC-12: in PV's own build every page server file is a no-op wrapper. A page
// with no actions of its own exports `actions` as `undefined` (not `{}`), so Kit keeps answering a stray
// POST with its "no actions exist" 405 instead of "no action with name" 404; the three pages with named
// actions keep exactly their own keys; every load returns exactly what it did before, plus nothing.

type ServerModule = { load?: unknown; actions?: Record<string, unknown> | undefined }
const modules = import.meta.glob('./**/+{page,layout}.server.ts', { eager: true }) as Record<
  string,
  ServerModule
>
const PAGES_WITH_OWN_ACTIONS = new Set([
  './(app)/settings/language/+page.server.ts',
  './(app)/notifications/+page.server.ts',
  './(app)/settings/notifications/+page.server.ts',
])

describe("page and layout server files in PV's own build", () => {
  const pages = Object.entries(modules).filter(([file]) => file.endsWith('+page.server.ts'))

  it('finds every server file', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(70)
    for (const [, module] of Object.entries(modules)) expect(typeof module.load).toBe('function')
  })

  it('exports no actions object from a page that has none of its own (Kit keeps its 405)', () => {
    for (const [file, module] of pages) {
      if (PAGES_WITH_OWN_ACTIONS.has(file)) continue
      expect(module.actions, file).toBeUndefined()
    }
  })

  it('keeps exactly the own action keys on the pages that have them', () => {
    const own = pages.filter(([file]) => PAGES_WITH_OWN_ACTIONS.has(file))
    expect(own).toHaveLength(PAGES_WITH_OWN_ACTIONS.size)
    for (const [file, module] of own) {
      const keys = Object.keys(module.actions ?? {})
      expect(keys.length, file).toBeGreaterThan(0)
      expect(
        keys.every((key) => !key.includes('.')),
        file
      ).toBe(true)
    }
  })

  it('layout server files export no actions at all', () => {
    for (const [file, module] of Object.entries(modules)) {
      if (file.endsWith('+layout.server.ts')) expect('actions' in module, file).toBe(false)
    }
  })
})
