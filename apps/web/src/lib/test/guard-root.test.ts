import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GUARD_ENTRIES_PATH,
  GUARD_ROOT_ENV,
  SCAN_FAILURE_HINT,
  assertNotVacuous,
  entriesTamperProblem,
  guardAppRoot,
  guardSources,
  readGuardEntries,
  removedFiles,
  sectionHash,
} from './guard-root.js'

const roots: string[] = []

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pv-guard-root-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

const SENTINELS = { 'src/hooks.server.ts': 'export {}', 'src/routes/+layout.svelte': '<slot />' }

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('guard root (Story 68.9 AC-2)', () => {
  it('defaults to the directory above this src and follows PV_GUARD_APP_ROOT when set', () => {
    expect(guardAppRoot().endsWith('apps/web') || guardAppRoot().endsWith('web-host')).toBe(true)
    const root = app(SENTINELS)
    vi.stubEnv(GUARD_ROOT_ENV, root)
    expect(guardAppRoot()).toBe(root)
    vi.stubEnv(GUARD_ROOT_ENV, '')
    expect(guardAppRoot()).not.toBe(root)
  })

  it('scans composed and PV directories alike, skipping paraglide output and test files', () => {
    const root = app({
      ...SENTINELS,
      'src/lib/_cm/Banner.svelte': 'x',
      'src/lib/server/_cm/crm.ts': 'x',
      'src/lib/paraglide/messages.js': 'x',
      'src/lib/a.test.ts': 'x',
      'src/lib/b.ts': 'x',
    })
    expect(guardSources(/\.(ts|svelte)$/, root).map((source) => source.path)).toEqual([
      'src/hooks.server.ts',
      'src/lib/_cm/Banner.svelte',
      'src/lib/b.ts',
      'src/lib/server/_cm/crm.ts',
      'src/routes/+layout.svelte',
    ])
  })

  it('scans a file that merely copies a generated-marker header like any other file', () => {
    const root = app({ ...SENTINELS, 'src/lib/_cm/x.ts': '// .pv-compose-generated\nexport {}' })
    expect(guardSources(/\.ts$/, root).map((source) => source.path)).toContain('src/lib/_cm/x.ts')
  })

  it('refuses a vacuous scan: no files, or no PV sentinels (unless the lock records a removal)', () => {
    const empty = app({})
    expect(() => assertNotVacuous([], empty)).toThrow(SCAN_FAILURE_HINT)
    const noSentinels = app({ 'src/lib/b.ts': 'x' })
    const sources = guardSources(/\.ts$/, noSentinels)
    expect(() => assertNotVacuous(sources, noSentinels)).toThrow('sentinel files not found')
    const removed = app({
      'src/lib/b.ts': 'x',
      'src/hooks.server.ts': 'x',
      'composition.lock.json': JSON.stringify({
        removals: [{ path: '/', files: ['src/routes/+layout.svelte'] }],
      }),
    })
    expect(() => assertNotVacuous(guardSources(/\.ts$/, removed), removed)).not.toThrow()
    expect(removedFiles(removed).has('src/routes/+layout.svelte')).toBe(true)
  })

  it('reads empty entries when the generated module is absent', () => {
    expect(readGuardEntries(app({})).browserStorage.release).toEqual([])
  })

  // Pinned with the kit's own test (packages/composition-kit/tests/guard-entries.test.ts): the two
  // sides compute the same canonical hash without importing each other.
  it('hashes canonical JSON, keys sorted at every depth', () => {
    expect(sectionHash({ b: [2, 1], a: { d: 1, c: null } })).toBe(
      'fe22be92ff0e701c45153b01eea0c202e55d082dd462131d3428dac89670b9b9'
    )
  })

  it('detects a hand-edited generated module against the lock', () => {
    const section = { sessionStorage: [], localStorage: [], release: [] }
    const clean = { _generated: 'x', browserStorage: section }
    const lock = { guardEntries: { browserStorage: sectionHash(section) } }
    const ok = app({
      [GUARD_ENTRIES_PATH]: JSON.stringify(clean),
      'composition.lock.json': JSON.stringify(lock),
    })
    expect(entriesTamperProblem(ok)).toBeNull()
    const edited = {
      ...clean,
      browserStorage: {
        ...section,
        sessionStorage: [{ file: 'src/x.ts', keys: ['k'], reason: 'r' }],
      },
    }
    const tampered = app({
      [GUARD_ENTRIES_PATH]: JSON.stringify(edited),
      'composition.lock.json': JSON.stringify(lock),
    })
    expect(entriesTamperProblem(tampered)).toBe(
      'generated guard entries differ from composition.lock.json (browserStorage); re-run pv-compose'
    )
    expect(entriesTamperProblem(app({ [GUARD_ENTRIES_PATH]: JSON.stringify(edited) }))).toBeNull()
  })
})
