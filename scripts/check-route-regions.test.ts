// Story 69.5 AC-1 / AC-9: the route-region audit command. It derives the region table from the tree
// (never from a typed list), follows a route file's `.svelte` imports to find regions that live in
// `$lib` components, and fails closed on a route file with no region, an unparseable file, a region
// whose point is not registered, a region component outside `src/lib/components`, and an oracle
// census mismatch. Fixtures are temp trees, never committed under `src/`.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from './check-route-regions.js'
import {
  auditRouteRegions,
  formatTable,
  formatUsesTable,
  OVERSIZE_ENFORCEMENT,
  OVERSIZE_FOLLOW_UP_STORIES,
} from './lib/route-regions.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const TABLE_POINT = 'things.list.table'
const THINGS_PAGE = 'src/routes/(app)/things/+page.svelte'
const makeRoot = useFixtureRoots('route-regions-', ['src'])

const REGISTRY = `export const INJECTION_POINTS = [
  { name: 'things.list.before', kind: 'standard' },
  { name: 'things.list.table', kind: 'region' },
]\n`
const ROUTE_SCRIPT = `<script>\n  import ThingsTable from '$lib/components/things/ThingsTable.svelte'\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n`
const SHELL = `<!-- @region things.list.table -->\n<section><InjectionPoint name="things.list.table" /><ThingsTable /></section>\n`
const ORACLE = 'src/routes/route-render-snapshot.test.ts'
const ORACLE_OK = `it('covers every one of the 1 route files', () => {})\n`
const COMPONENT = `<div>\n  <p>a</p>\n\n  <p>b</p>\n</div>\n`

function webTree(overrides: Record<string, string> = {}): string {
  const root = makeRoot()
  const files: Record<string, string> = {
    'src/lib/components/composition/injection-points.ts': REGISTRY,
    'src/lib/components/things/ThingsTable.svelte': COMPONENT,
    [THINGS_PAGE]: `${ROUTE_SCRIPT}${SHELL}`,
    [ORACLE]: ORACLE_OK,
    ...overrides,
  }
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  return root
}

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
}

describe('route-regions audit: the table', () => {
  it('lists one row per region with its component, point and line counts', () => {
    const result = auditRouteRegions(webTree())
    expect(result.problems).toEqual([])
    expect(result.routeFiles).toBe(1)
    expect(result.rows).toEqual([
      {
        file: THINGS_PAGE,
        scope: 'page',
        region: TABLE_POINT,
        component: 'src/lib/components/things/ThingsTable.svelte',
        point: TABLE_POINT,
        inlineLines: 1,
        componentLines: 4,
        stableCandidate: 'no',
        status: 'done',
      },
    ])
  })

  it('finds a region that lives in an imported $lib component (sibling-owned pages)', () => {
    const root = webTree({
      [THINGS_PAGE]: `${ROUTE_SCRIPT}<ThingsTable />\n`,
      'src/lib/components/things/ThingsTable.svelte': `<script>\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n<!-- @region things.list.table -->\n<div><InjectionPoint name="things.list.table" /></div>\n`,
    })
    const result = auditRouteRegions(root)
    expect(result.problems).toEqual([])
    expect(result.rows.map((row) => [row.region, row.component, row.inlineLines])).toEqual([
      [TABLE_POINT, 'src/lib/components/things/ThingsTable.svelte', 0],
    ])
  })

  it('prints a markdown table with the fixed columns', () => {
    const table = formatTable(auditRouteRegions(webTree()).rows)
    const [header, rule, first] = table.split('\n')
    expect(header).toBe(
      '| route file | scope | region | region component | point | inline lines | component lines | stable candidate | status |'
    )
    expect(rule).toMatch(/^\|( --- \|){9}$/)
    expect(first).toContain(TABLE_POINT)
  })
})

describe('route-regions audit: failures (fail closed)', () => {
  it('reports a route file with no region as MISSING and exits 1', () => {
    const root = webTree({ [THINGS_PAGE]: `<p>plain</p>\n` })
    const result = auditRouteRegions(root)
    expect(result.rows[0]?.status).toBe('MISSING')
    expect(result.problems.some((problem) => problem.includes('MISSING'))).toBe(true)
  })

  it('reports a route file that does not parse as UNPARSEABLE', () => {
    const result = auditRouteRegions(webTree({ [THINGS_PAGE]: '<div>' }))
    expect(result.rows[0]?.status).toBe('UNPARSEABLE')
    expect(result.problems.some((problem) => problem.includes('UNPARSEABLE'))).toBe(true)
  })

  it('reports a region whose point is not registered', () => {
    const root = webTree({
      [THINGS_PAGE]: `${ROUTE_SCRIPT}${SHELL.replaceAll(TABLE_POINT, 'things.list.gone')}`,
    })
    expect(auditRouteRegions(root).problems.join('\n')).toContain('unregistered point')
  })

  it('reports a region component that is not an indexed component', () => {
    const root = webTree({
      'src/routes/(app)/things/_local/Local.svelte': COMPONENT,
      [THINGS_PAGE]: `<script>\n  import Local from './_local/Local.svelte'\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n${SHELL.replace('<ThingsTable />', '<Local />')}`,
    })
    expect(auditRouteRegions(root).problems.join('\n')).toContain('not an indexed component')
  })

  it('rejects a +page@ reset route name the census cannot see', () => {
    const root = webTree({ 'src/routes/(app)/things/+page@.svelte': COMPONENT })
    expect(auditRouteRegions(root).problems.join('\n')).toContain('+page@.svelte')
  })

  it('fails closed when the oracle census sentence is gone or the oracle file is missing (DW-549)', () => {
    const renamed = webTree({ [ORACLE]: `it('covers all the route files', () => {})\n` })
    expect(auditRouteRegions(renamed).problems.join('\n')).toContain('census')
    const root = webTree()
    rmSync(join(root, ORACLE))
    expect(auditRouteRegions(root).problems.join('\n')).toContain('census')
  })

  it('reports an oracle census that disagrees with the tree', () => {
    const root = webTree({
      'src/routes/route-render-snapshot.test.ts': `it('covers every one of the 70 route files', () => {})\n`,
    })
    expect(auditRouteRegions(root).problems.join('\n')).toContain('route-render oracle')
  })
})

describe('route-regions audit: top-level uses and oversize components (69.6 AC-1)', () => {
  const marked = `${ROUTE_SCRIPT}${SHELL}`

  it('lists a marked region as covered with its line', () => {
    expect(auditRouteRegions(webTree()).uses).toEqual([
      {
        file: THINGS_PAGE,
        line: 6,
        use: `@region ${TABLE_POINT}`,
        kind: 'component',
        status: 'covered',
      },
    ])
  })

  it('lists a bare top-level use as UNCOVERED and reports it as a problem', () => {
    const root = webTree({ [THINGS_PAGE]: `${marked}<ThingsTable />\n` })
    const result = auditRouteRegions(root)
    expect(result.uses.map((use) => [use.use, use.status])).toEqual([
      [`@region ${TABLE_POINT}`, 'covered'],
      ['<ThingsTable />', 'UNCOVERED'],
    ])
    expect(result.problems.join('\n')).toContain('UNCOVERED')
  })

  it('lists a use of a component that hosts its own region as covered', () => {
    const root = webTree({
      [THINGS_PAGE]: `${ROUTE_SCRIPT}<ThingsTable />\n`,
      'src/lib/components/things/ThingsTable.svelte': `<script>\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n<!-- @region things.list.table -->\n<div><InjectionPoint name="things.list.table" /></div>\n`,
    })
    const result = auditRouteRegions(root)
    expect(result.uses.map((use) => use.status)).toEqual(['covered'])
    expect(result.problems).toEqual([])
  })

  it('lists a route file that only renders children as render-only and never skips it', () => {
    const root = webTree({
      [THINGS_PAGE]: `<script>\n  let { children } = $props()\n</script>\n{@render children()}\n`,
    })
    const result = auditRouteRegions(root)
    expect(result.uses).toEqual([
      {
        file: THINGS_PAGE,
        line: 4,
        use: '{@render children()}',
        kind: 'render',
        status: 'UNCOVERED',
      },
    ])
    expect(result.problems.join('\n')).toContain('render-only')
  })

  it('reports a region component over 60 template lines as OVERSIZE, a problem only when enforced', () => {
    const long = `<div>\n${'  <p>line</p>\n'.repeat(60)}</div>\n`
    const root = webTree({ 'src/lib/components/things/ThingsTable.svelte': long })
    const reported = auditRouteRegions(root)
    expect(reported.rows[0]).toMatchObject({ componentLines: 62, status: 'OVERSIZE' })
    expect(reported.oversize).toHaveLength(1)
    expect(reported.problems).toEqual([])
    const enforced = auditRouteRegions(root, { enforceOversize: true })
    expect(enforced.problems.join('\n')).toContain('OVERSIZE')
    const exactly = `<div>\n${'  <p>line</p>\n'.repeat(58)}</div>\n`
    const ok = auditRouteRegions(
      webTree({ 'src/lib/components/things/ThingsTable.svelte': exactly }),
      {
        enforceOversize: true,
      }
    )
    expect(ok.rows[0]).toMatchObject({ componentLines: 60, status: 'done' })
    expect(ok.oversize).toEqual([])
  })

  it('the oversize switch is exactly report-only, names its follow-up stories and lists no component', () => {
    expect(OVERSIZE_ENFORCEMENT).toBe(false)
    expect(OVERSIZE_FOLLOW_UP_STORIES).toEqual(['69-10', '69-11', '69-12'])
    const source = readFileSync(new URL('./lib/route-regions.ts', import.meta.url), 'utf8')
    expect(source).toContain('69-10, 69-11 and 69-12')
    expect(source).not.toMatch(/allowlist|allow-list|baseline|ignoreList|\.svelte'\s*,\s*'/i)
  })

  it('the CLI prints the report-only OVERSIZE summary and still exits 0', () => {
    const sink = io()
    const long = `<div>\n${'  <p>line</p>\n'.repeat(60)}</div>\n`
    const root = webTree({ 'src/lib/components/things/ThingsTable.svelte': long })
    expect(run(['--web', root], sink.io)).toBe(0)
    expect(sink.out.join('')).toContain('report-only until stories 69-10, 69-11, 69-12')
  })

  it('prints a uses table with the fixed columns', () => {
    const table = formatUsesTable(auditRouteRegions(webTree()).uses)
    const [header, rule, first] = table.split('\n')
    expect(header).toBe('| route file | line | top-level use | kind | status |')
    expect(rule).toMatch(/^\|( --- \|){5}$/)
    expect(first).toContain('covered')
  })
})

describe('check-route-regions: the CLI', () => {
  it('exits 0 and prints the row count on a clean tree', () => {
    const sink = io()
    expect(run(['--web', webTree()], sink.io)).toBe(0)
    expect(sink.out.join('')).toContain('1 route files, 1 regions')
  })

  it('--print writes the table and exits 0 even on a clean tree', () => {
    const sink = io()
    expect(run(['--web', webTree(), '--print'], sink.io)).toBe(0)
    expect(sink.out.join('')).toContain('| route file |')
  })

  it('exits 1 and lists the problems on a tree with a MISSING route file', () => {
    const sink = io()
    const root = webTree({ [THINGS_PAGE]: `<p>plain</p>\n` })
    expect(run(['--web', root], sink.io)).toBe(1)
    expect(sink.err.join('')).toContain('MISSING')
  })

  it('exits 1 when no route file exists (a guard that matches nothing is not a pass)', () => {
    const sink = io()
    expect(run(['--web', makeRoot()], sink.io)).toBe(1)
    expect(sink.err.join('')).toContain('no route files')
  })
})
