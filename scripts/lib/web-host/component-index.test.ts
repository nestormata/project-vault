import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditRouteRegions } from '../route-regions.js'
import {
  buildComponentIndex,
  componentIndexText,
  indexableFile,
  readComponentIndex,
  stabilityOf,
} from './component-index.js'

const SVELTE = 'a/B.svelte'
const A_TS = 'src/lib/a.ts'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stage(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'component-index-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('stabilityOf (Story 68.5 Q5)', () => {
  it('is stable when the first top-level comment carries @pv-stable', () => {
    expect(stabilityOf(SVELTE, '<!-- @pv-stable: props are final -->\n<script></script>')).toBe(
      'stable'
    )
    expect(stabilityOf('a/b.ts', '/**\n * @pv-stable\n */\nexport const x = 1\n')).toBe('stable')
  })

  it('is unmarked otherwise, never "unstable"', () => {
    expect(stabilityOf(SVELTE, '<p>hi</p>')).toBe('unmarked')
    expect(stabilityOf('a/b.ts', 'export const x = 1\n')).toBe('unmarked')
  })

  it('looks only at the FIRST comment, and only for the file kind', () => {
    expect(stabilityOf(SVELTE, '<!-- plain -->\n<!-- @pv-stable -->')).toBe('unmarked')
    expect(stabilityOf('a/b.ts', '/** plain */\n/** @pv-stable */')).toBe('unmarked')
    expect(stabilityOf('a/b.ts', '<!-- @pv-stable -->')).toBe('unmarked')
    expect(stabilityOf(SVELTE, '/** @pv-stable */')).toBe('unmarked')
  })

  it('does not match a longer token or an unterminated comment', () => {
    expect(stabilityOf('a/b.ts', '/** @pv-stable-ish */')).toBe('unmarked')
    expect(stabilityOf(SVELTE, '<!-- @pv-stable')).toBe('unmarked')
  })
})

describe('indexableFile (AC-9 inclusion rules)', () => {
  it.each([
    ['src/lib/components/shell/GlobalSearch.svelte', true],
    ['src/lib/api/audit.ts', true],
    ['src/lib/server/require-user.ts', true],
    ['src/lib/state/theme.svelte.ts', true],
    ['src/lib/components/x/Thing.svelte', true],
    ['src/lib/api/audit.test.ts', false],
    ['src/lib/state/theme.test.svelte.ts', false],
    ['src/lib/test/fixtures.ts', false],
    ['src/lib/components/shell/global-search-test-helpers.ts', false],
    ['src/lib/components/__mocks__/x.ts', false],
    ['src/lib/types.d.ts', false],
    ['src/routes/(app)/dashboard/+page.svelte', false],
    ['src/lib/util.js', false],
    ['src/lib/readme.md', false],
    ['src/lib/paraglide/messages.ts', false],
    ['src/app.html', false],
  ])('%s -> %s', (path, expected) => {
    expect(indexableFile(path)).toBe(expected)
  })

  it('indexes a .svelte file only under lib/components, a .ts anywhere under lib', () => {
    expect(indexableFile('src/lib/loose/Thing.svelte')).toBe(false)
    expect(indexableFile('src/lib/loose/thing.ts')).toBe(true)
  })
})

describe('buildComponentIndex (AC-9)', () => {
  it('lists indexable files sorted by path with stability and the raw-bytes sha256', () => {
    const svelte = '<!-- @pv-stable -->\r\n<p>crlf</p>\r\n'
    const root = stage({
      'src/lib/components/B.svelte': svelte,
      'src/lib/api/a.ts': 'export const a = 1\n',
      'src/lib/api/a.test.ts': 'test\n',
      'src/routes/+page.svelte': '<p/>\n',
    })
    const index = buildComponentIndex(root)
    expect(index).toEqual({
      schemaVersion: 1,
      components: [
        { path: 'src/lib/api/a.ts', stability: 'unmarked', hash: sha('export const a = 1\n') },
        { path: 'src/lib/components/B.svelte', stability: 'stable', hash: sha(svelte) },
      ],
    })
  })

  it('is deterministic and keeps line endings (hash over raw bytes)', () => {
    const root = stage({ [A_TS]: 'a\r\nb\n' })
    expect(componentIndexText(buildComponentIndex(root))).toBe(
      componentIndexText(buildComponentIndex(root))
    )
    expect(buildComponentIndex(root).components[0]?.hash).toBe(sha('a\r\nb\n'))
    expect(componentIndexText(buildComponentIndex(root)).endsWith('}\n')).toBe(true)
  })

  it('is empty, not absent, for a stage with no lib files', () => {
    expect(buildComponentIndex(stage({ 'src/app.html': '<html/>' }))).toEqual({
      schemaVersion: 1,
      components: [],
    })
  })

  it('fails naming the path of a file it cannot read', () => {
    const root = stage({ [A_TS]: 'a\n' })
    expect(() =>
      buildComponentIndex(root, {
        files: [A_TS, 'src/lib/gone.ts'],
      })
    ).toThrow('src/lib/gone.ts')
  })

  it('fails on a duplicate path', () => {
    const root = stage({ [A_TS]: 'a\n' })
    expect(() => buildComponentIndex(root, { files: [A_TS, A_TS] })).toThrow(
      'duplicate path src/lib/a.ts'
    )
  })
})

describe('readComponentIndex', () => {
  it('parses a written index back', () => {
    const root = stage({ [A_TS]: 'a\n' })
    const text = componentIndexText(buildComponentIndex(root))
    expect(readComponentIndex(text)?.components).toHaveLength(1)
  })

  it('returns null for something that is not an index', () => {
    expect(readComponentIndex('{}')).toBeNull()
    expect(readComponentIndex('nope')).toBeNull()
  })
})

// Story 69.5 AC-6: M4 replaces a module by its resolved path, and only indexed files can be named, so
// the component of every route region has to be in `component-index.json`. A route-local `.svelte`
// would not be (a `.svelte` is indexed only under `src/lib/components`), which is why the audit fails
// a region component outside that directory.
describe("PV's own region components are indexed (Story 69.5 AC-6)", () => {
  const web = join(import.meta.dirname, '..', '..', '..', 'apps', 'web')

  it('lists the component of every route region, unmarked unless it carries @pv-stable', () => {
    const regions = auditRouteRegions(web).rows.filter((row) => row.component !== '')
    expect(regions.length).toBeGreaterThan(100)
    const indexed = new Map(
      buildComponentIndex(web).components.map((entry) => [entry.path, entry.stability] as const)
    )
    for (const row of regions) {
      expect(indexableFile(row.component), row.component).toBe(true)
      const stability = indexed.get(row.component)
      expect(stability, `${row.component} (region ${row.region}) is not in the index`).toBeDefined()
      expect(stability, row.component).toBe(
        row.stableCandidate === 'marked' ? 'stable' : 'unmarked'
      )
    }
  })

  it('does not index a route-local component, so a region outside src/lib/components fails the audit', () => {
    expect(indexableFile('src/routes/(app)/things/_local/Local.svelte')).toBe(false)
  })
})
