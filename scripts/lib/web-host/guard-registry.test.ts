import { describe, expect, it } from 'vitest'
import {
  buildGuardRegistry,
  guardMarker,
  leadingCommentText,
  unshippedGuardProblems,
} from './guard-registry.js'
import { buildTestSubjects } from './test-subjects.js'
import type { GraphResolver } from './import-graph.js'

const WEB = '/w'
const GUARD_ID = 'static-hardening'
const HARDENING = '/w/src/lib/security/static-hardening.test.ts'
const HARDENING_REL = 'src/lib/security/static-hardening.test.ts'
const CARD = '/w/src/lib/ui/Card.test.ts'

function resolverOf(files: Record<string, string>): GraphResolver {
  const known = new Map(Object.entries(files))
  return {
    alias: (specifier) =>
      specifier.startsWith('$lib/') ? `${WEB}/src/lib/${specifier.slice(5)}` : undefined,
    readFile: (path) => known.get(path),
  }
}

const GUARD = `/**
 * @pv-guard static-hardening
 * @pv-entries browserStorage
 * @pv-subject ./hardening.js
 */
import { root } from '../test/guard-root.js'
import { header } from './hardening.js'
`

const FILES: Record<string, string> = {
  [HARDENING]: GUARD,
  '/w/src/lib/test/guard-root.ts':
    "import { rules } from '../security/rules.js'\nexport const root = 1\n",
  '/w/src/lib/security/rules.ts': 'export const rules = 1\n',
  '/w/src/lib/security/hardening.ts':
    "import { deep } from './deep.js'\nexport const header = deep\n",
  '/w/src/lib/security/deep.ts': 'export const deep = 1\n',
  '/w/guards/form-guidance.ts': '// @pv-guard form-guidance\nexport const scan = 1\n',
  [CARD]: "import { card } from './Card.js'\n",
  '/w/src/lib/ui/Card.ts': 'export const card = 1\n',
}

const input = (testFiles: string[], scriptFiles: string[] = []) => ({
  webDir: WEB,
  testFiles,
  scriptFiles,
  resolver: resolverOf(FILES),
})

describe('guard marker (Story 68.9 AC-1)', () => {
  it('reads the marker only from the leading comment block', () => {
    expect(guardMarker(GUARD)).toEqual({
      id: GUARD_ID,
      scope: 'all-files',
      entries: 'browserStorage',
      subjects: ['./hardening.js'],
    })
    expect(guardMarker("import x from 'y'\n/** @pv-guard late */")).toBeUndefined()
    expect(guardMarker('export const a = 1')).toBeUndefined()
    expect(leadingCommentText('// @pv-guard a-b\nconst x = 1')).toContain('@pv-guard a-b')
  })

  it('reads a PV-duty scope', () => {
    expect(
      guardMarker('/** @pv-guard region-coverage\n * @pv-scope pv-originated-only */')
    ).toEqual({
      id: 'region-coverage',
      scope: 'pv-originated-only',
      subjects: [],
    })
  })
})

describe('guard registry (Story 68.9 AC-1)', () => {
  const registry = buildGuardRegistry(input([HARDENING, CARD], ['/w/guards/form-guidance.ts']))

  it('registers marked tests and scripts, sorted by id, and no unmarked test', () => {
    expect(registry.problems).toEqual([])
    expect(registry.guards.map((guard) => [guard.id, guard.kind, guard.file])).toEqual([
      ['form-guidance', 'script', 'guards/form-guidance.js'],
      [GUARD_ID, 'test', HARDENING_REL],
    ])
    expect(registry.guards.every((guard) => guard.license === 'AGPL-3.0-or-later')).toBe(true)
  })

  it('closes over helpers but not over a subject the guard names, and lists the subject and its imports', () => {
    const guard = registry.guards.find((entry) => entry.id === GUARD_ID)
    expect(guard?.closure.map((entry) => entry.file)).toEqual([
      'src/lib/security/rules.ts',
      'src/lib/test/guard-root.ts',
    ])
    expect(guard?.closure.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true)
    expect(guard?.subjects).toEqual(['src/lib/security/hardening.ts'])
    expect(guard?.subjectClosure).toEqual(['src/lib/security/deep.ts'])
  })

  it('is byte-identical across runs', () => {
    const again = buildGuardRegistry(input([CARD, HARDENING], ['/w/guards/form-guidance.ts']))
    expect(again.text).toBe(registry.text)
    expect(JSON.parse(registry.text)).toMatchObject({ schemaVersion: 1 })
  })

  it('fails when two files claim one id', () => {
    const files = { ...FILES, '/w/src/a.test.ts': '/** @pv-guard static-hardening */' }
    const clash = buildGuardRegistry({
      webDir: WEB,
      testFiles: [HARDENING, '/w/src/a.test.ts'],
      scriptFiles: [],
      resolver: resolverOf(files),
    })
    expect(clash.problems).toEqual([
      'guard id static-hardening is claimed by both src/lib/security/static-hardening.test.ts and src/a.test.ts',
    ])
  })

  it('names a marked test that is not shipped', () => {
    expect(
      unshippedGuardProblems([HARDENING, CARD], new Set([CARD]), resolverOf(FILES), WEB)
    ).toEqual([
      'src/lib/security/static-hardening.test.ts carries @pv-guard but is not a self-contained test, so it cannot ship',
    ])
  })
})

describe('test subjects (Story 68.9 AC-10, Q2)', () => {
  const subjects = buildTestSubjects({
    webDir: WEB,
    testFiles: [HARDENING, CARD],
    resolver: resolverOf({
      ...FILES,
      [CARD]:
        "import { card } from './Card.js'\nimport { f } from '$lib/test/fixtures.js'\nimport { z } from 'zod'\n",
      '/w/src/lib/test/fixtures.ts': 'export const f = 1\n',
    }),
  })

  it('lists direct imports and the sibling, never support files, and skips guards', () => {
    expect(subjects.subjects).toEqual({ 'src/lib/ui/Card.test.ts': ['src/lib/ui/Card.ts'] })
  })

  it('finds a sibling the test does not import', () => {
    const sibling = buildTestSubjects({
      webDir: WEB,
      testFiles: [CARD],
      resolver: resolverOf({
        [CARD]: 'export {}\n',
        '/w/src/lib/ui/Card.svelte': '<p></p>',
      }),
    })
    expect(sibling.subjects['src/lib/ui/Card.test.ts']).toEqual(['src/lib/ui/Card.svelte'])
  })

  it('does not list transitive imports', () => {
    const direct = buildTestSubjects({
      webDir: WEB,
      testFiles: ['/w/src/lib/security/x.test.ts'],
      resolver: resolverOf({
        '/w/src/lib/security/x.test.ts': "import { header } from './hardening.js'\n",
        '/w/src/lib/security/hardening.ts': FILES['/w/src/lib/security/hardening.ts'] ?? '',
        '/w/src/lib/security/deep.ts': FILES['/w/src/lib/security/deep.ts'] ?? '',
      }),
    })
    expect(direct.subjects['src/lib/security/x.test.ts']).toEqual(['src/lib/security/hardening.ts'])
  })

  it('is byte-stable', () => {
    expect(subjects.text.endsWith('\n')).toBe(true)
    expect(JSON.parse(subjects.text).schemaVersion).toBe(1)
  })
})
