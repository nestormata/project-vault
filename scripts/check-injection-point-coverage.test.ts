import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { run } from './check-injection-point-coverage.js'
import {
  checkInjectionPointCoverage,
  coverageFigure,
  formatFigure,
  readRegistryFields,
} from './lib/injection-point-coverage.js'
import { parseMarkup } from './lib/route-files.js'
import { walkFiles } from './lib/scan-utils.js'
import { sysReadFile } from './lib/web-host/import-graph.js'
import { INJECTION_POINTS } from '../apps/web/src/lib/components/composition/injection-points.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('injection-coverage-', ['src/routes'])

const REGISTRY = 'src/lib/components/composition/injection-points.ts'
const PAGE = 'src/routes/(app)/foo/+page.svelte'
const PAGE_SERVER = 'src/routes/(app)/foo/+page.server.ts'
const LAYOUT = 'src/routes/(app)/+layout.svelte'
const LAYOUT_SERVER = 'src/routes/(app)/+layout.server.ts'
const FOO_ID = '/(app)/foo'
const SUFFIXES = ['before', 'after', 'header.actions']
const PREFIXES = ['foo.page', 'app.layout']
const HEADER_REGION = 'foo.page.header'

function registry(names: string[], shell: string[] = []): string {
  const rows = [
    ...names.map((name) => `  { name: '${name}', kind: 'standard', propsType: 'X' },`),
    ...shell.map((name) => `  { name: '${name}', kind: 'shell', propsType: 'X' },`),
  ]
  return `export const INJECTION_POINTS = [\n${rows.join('\n')}\n]\n`
}

function points(prefix: string, suffixes = SUFFIXES): string {
  return suffixes.map((s) => `<InjectionPoint name="${prefix}.${s}" />`).join('\n')
}

const PAGE_SERVER_OK = [
  "export const load = async (event) => ({ ...(await injectLoad(event, '/(app)/foo', 'page')) })",
  "export const actions = { ...own, ...injectActions('/(app)/foo') }",
].join('\n')
const LAYOUT_SERVER_OK =
  "export const load = async (event) => ({ ...(await injectLoad(event, '/(app)', 'layout')) })"

/** A clean tree: one page and one layout, each with its three points and its server file. */
function cleanTree(): string {
  const root = makeRoot()
  const all = PREFIXES.flatMap((prefix) => SUFFIXES.map((s) => `${prefix}.${s}`))
  writeFixture(root, REGISTRY, registry(all))
  writeFixture(root, PAGE, points('foo.page'))
  writeFixture(root, PAGE_SERVER, PAGE_SERVER_OK)
  writeFixture(root, LAYOUT, points('app.layout'))
  writeFixture(root, LAYOUT_SERVER, LAYOUT_SERVER_OK)
  return root
}

const problemsOf = (
  root: string,
  lock?: Parameters<typeof checkInjectionPointCoverage>[0]['lock']
) => checkInjectionPointCoverage({ webRoot: root, ...(lock === undefined ? {} : { lock }) })

describe('check-injection-point-coverage: mutation self-tests (Story 68.4 AC-10)', () => {
  it('passes a clean tree and reports how many route files it scanned', () => {
    expect(problemsOf(cleanTree())).toEqual({ problems: [], scannedRouteFiles: 2 })
  })

  it('fails closed when there are no route files (scanned 0 files)', () => {
    const root = makeRoot()
    writeFixture(root, REGISTRY, registry(['a.b.before']))
    const result = problemsOf(root)
    expect(result.scannedRouteFiles).toBe(0)
    expect(result.problems.join('\n')).toContain('scanned 0 route files')
  })

  it('reads the shipped registry exactly as the registry module builds it at runtime', () => {
    const read = readRegistryFields(WEB)
    expect(read?.size).toBe(INJECTION_POINTS.length)
    for (const point of INJECTION_POINTS) {
      // a region's host routes are a string list at runtime and one comma-joined field when read
      const expected = {
        ...point,
        ...(point.hostRoutes === undefined ? {} : { hostRoutes: point.hostRoutes.join(',') }),
      }
      expect(Object.fromEntries(read?.get(point.name) ?? [])).toEqual(expected)
    }
  })

  it('expands a pagePoints spread into the three standard points of each page', () => {
    const root = makeRoot()
    writeFixture(
      root,
      REGISTRY,
      "export const INJECTION_POINTS = [\n  ...pagePoints('X', ['foo.page']),\n]\n"
    )
    const fields = readRegistryFields(root)
    expect([...(fields?.keys() ?? [])].sort()).toEqual(
      SUFFIXES.map((suffix) => `foo.page.${suffix}`).sort()
    )
    expect(fields?.get('foo.page.after')?.get('propsType')).toBe('X')
  })

  it('expands a regionPoints spread into one region row per listed name', () => {
    const root = makeRoot()
    writeFixture(
      root,
      REGISTRY,
      `export const INJECTION_POINTS = [\n  ...regionPoints('Y', [], ['${HEADER_REGION}', 'foo.page.body']),\n]\n`
    )
    const fields = readRegistryFields(root)
    expect([...(fields?.keys() ?? [])].sort()).toEqual(['foo.page.body', HEADER_REGION])
    expect(fields?.get(HEADER_REGION)?.get('kind')).toBe('region')
    expect(fields?.get(HEADER_REGION)?.get('propsType')).toBe('Y')
  })

  it('ignores a regionPoints call whose arguments are not string literals', () => {
    const root = makeRoot()
    writeFixture(
      root,
      REGISTRY,
      `export const INJECTION_POINTS = [\n  ...regionPoints(TYPE, [], ['${HEADER_REGION}']),\n  ...regionPoints('Y', [], NAMES),\n]\n`
    )
    expect(readRegistryFields(root)?.size).toBe(0)
  })

  it('reports a region point that is registered but not rendered, and a mistyped rendered name', () => {
    const root = cleanTree()
    const all = PREFIXES.flatMap((prefix) => SUFFIXES.map((s) => `${prefix}.${s}`))
    const rows = registry(all).replace(
      '\n]\n',
      `\n  ...regionPoints('X', [], ['${HEADER_REGION}']),\n]\n`
    )
    writeFixture(root, REGISTRY, rows)
    writeFixture(root, PAGE, `${points('foo.page')}\n<InjectionPoint name="foo.page.heder" />`)
    const text = problemsOf(root).problems.join('\n')
    expect(text).toContain('"foo.page.heder" is not registered')
    expect(text).toContain(HEADER_REGION)
  })

  it('flags a page missing its .after point', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE,
      points(
        'foo.page',
        SUFFIXES.filter((suffix) => suffix !== 'after')
      )
    )
    expect(problemsOf(root).problems).toContain(`${PAGE}: lacks injection point "foo.page.after"`)
  })

  it('flags a page with no standard points at all', () => {
    const root = cleanTree()
    writeFixture(root, PAGE, '<p>none</p>')
    expect(problemsOf(root).problems.join('\n')).toContain(
      `${PAGE}: lacks the standard injection points`
    )
  })

  it('flags a prefix mismatch (a.b.before + a.c.after)', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE,
      '<InjectionPoint name="foo.page.before" /><InjectionPoint name="foo.other.after" /><InjectionPoint name="foo.page.header.actions" />'
    )
    const text = problemsOf(root).problems.join('\n')
    expect(text).toContain('lacks injection point "foo.page.after"')
    expect(text).toContain('"foo.other.after" is not registered')
  })

  it('flags an unregistered literal name', () => {
    const root = cleanTree()
    writeFixture(root, PAGE, `${points('foo.page')}\n<InjectionPoint name="foo.page.nope" />`)
    expect(problemsOf(root).problems.join('\n')).toContain(
      'injection point "foo.page.nope" is not registered'
    )
  })

  it('flags a registered name that no file renders', () => {
    const root = cleanTree()
    writeFixture(
      root,
      REGISTRY,
      registry([
        'foo.page.before',
        'foo.page.after',
        'foo.page.header.actions',
        'app.layout.before',
        'app.layout.after',
        'app.layout.header.actions',
        'ghost.page.before',
      ])
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      '"ghost.page.before" is registered but no file renders it'
    )
  })

  it('flags a dynamic name', () => {
    const root = cleanTree()
    writeFixture(root, PAGE, `${points('foo.page')}\n<InjectionPoint name={someName} />`)
    expect(problemsOf(root).problems.join('\n')).toContain('name must be a string literal')
  })

  it('flags an @region block without a point and an @region comment at the end of a file', () => {
    const root = cleanTree()
    writeFixture(root, PAGE, `${points('foo.page')}\n<!-- @region tiles -->\n<div>none</div>`)
    expect(problemsOf(root).problems.join('\n')).toContain(
      '@region block contains no <InjectionPoint>'
    )
    writeFixture(root, PAGE, `${points('foo.page')}\n<!-- @region tiles -->`)
    expect(problemsOf(root).problems.join('\n')).toContain(
      '@region comment is not followed by an element or block'
    )
  })

  it('flags a name rendered in two files', () => {
    const root = cleanTree()
    writeFixture(
      root,
      'src/lib/components/Other.svelte',
      '<InjectionPoint name="foo.page.before" />'
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      '"foo.page.before" is rendered in more than one file'
    )
  })

  it('flags two route files sharing a prefix', () => {
    const root = cleanTree()
    writeFixture(root, 'src/routes/(app)/bar/+page.svelte', points('foo.page'))
    writeFixture(
      root,
      'src/routes/(app)/bar/+page.server.ts',
      "export const load = (e) => injectLoad(e, '/(app)/bar', 'page')\nexport const actions = injectActions('/(app)/bar')"
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      'prefix "foo.page" is used by more than one route file'
    )
  })

  it('flags a server file calling injectLoad with the wrong route id or scope', () => {
    const root = cleanTree()
    writeFixture(root, PAGE_SERVER, PAGE_SERVER_OK.replace(FOO_ID, '/(app)/wrong'))
    const text = problemsOf(root).problems.join('\n')
    expect(text).toContain(
      'injectLoad route id is called with "/(app)/wrong", expected "/(app)/foo"'
    )
    writeFixture(root, PAGE_SERVER, PAGE_SERVER_OK.replace("'page'", "'layout'"))
    expect(problemsOf(root).problems.join('\n')).toContain(
      'injectLoad scope is called with "layout", expected "page"'
    )
  })

  it('flags a page server file with no injectActions spread, and a page with no server file', () => {
    const root = cleanTree()
    writeFixture(root, PAGE_SERVER, PAGE_SERVER_OK.split('\n')[0] ?? '')
    expect(problemsOf(root).problems.join('\n')).toContain(
      'does not spread injectActions("/(app)/foo")'
    )
    writeFixture(root, 'src/routes/(app)/baz/+page.svelte', points('foo.page'))
    expect(problemsOf(root).problems.join('\n')).toContain(
      'src/routes/(app)/baz/+page.svelte: has no server file calling injectLoad'
    )
  })

  it('flags a default action next to injectActions', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE_SERVER,
      `${PAGE_SERVER_OK.split('\n')[0]}\nexport const actions = { default: async () => ({}), ...injectActions('/(app)/foo') }`
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      'exports a default action while spreading injectActions'
    )
  })

  it('flags a PV action key that starts with a registered point name plus a dot', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE_SERVER,
      `${PAGE_SERVER_OK.split('\n')[0]}\nexport const actions = { 'foo.page.after.x': async () => ({}), ...injectActions('/(app)/foo') }`
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      'action "foo.page.after.x" starts with injection point "foo.page.after."'
    )
  })

  it('requires a universal +page.ts to call injectLoad too', () => {
    const root = cleanTree()
    writeFixture(root, 'src/routes/(app)/foo/+page.ts', 'export const load = () => ({})')
    expect(problemsOf(root).problems.join('\n')).toContain(
      'src/routes/(app)/foo/+page.ts: does not call injectLoad'
    )
  })

  it('does not require the calls in a redirect-only server file with no component beside it', () => {
    const root = cleanTree()
    writeFixture(
      root,
      'src/routes/(app)/alerts/+page.server.ts',
      'export const load = () => { throw redirect(308, "/x") }'
    )
    expect(problemsOf(root).problems).toEqual([])
  })

  it('--lock: a CM addition or override lacking points passes, and the same tree fails without the lock', () => {
    const root = cleanTree()
    writeFixture(root, 'src/routes/billing/+page.svelte', '<p>cm</p>')
    writeFixture(root, PAGE, '<p>cm override</p>')
    expect(problemsOf(root).problems.length).toBeGreaterThan(0)
    const lock = {
      additions: [{ path: 'src/routes/billing/+page.svelte' }],
      overrides: [{ path: PAGE }],
    }
    expect(problemsOf(root, lock).problems).toEqual([])
  })

  it('--lock: a PV page the pack did not touch still fails', () => {
    const root = cleanTree()
    writeFixture(root, LAYOUT, '<p>no points</p>')
    const lock = { overrides: [{ path: PAGE }] }
    expect(problemsOf(root, lock).problems.join('\n')).toContain(
      `${LAYOUT}: lacks the standard injection points`
    )
  })

  it('applies the shell naming rule: two segments for kind shell, three otherwise', () => {
    const root = cleanTree()
    const all = PREFIXES.flatMap((prefix) => SUFFIXES.map((s) => `${prefix}.${s}`))
    writeFixture(root, REGISTRY, registry(all, ['shell.head']))
    writeFixture(root, 'src/lib/components/Shell.svelte', '<InjectionPoint name="shell.head" />')
    expect(problemsOf(root).problems).toEqual([])
    writeFixture(root, REGISTRY, registry([...all, 'toolong']))
    expect(problemsOf(root).problems.join('\n')).toContain('"toolong" breaks the naming rule')
  })
})

// Story 69.1 AC-3: region points. A region is a component holding an `<InjectionPoint>` inside its
// marked node; its host routes are declared in the registry and checked against the import graph.
describe('check-injection-point-coverage: region points (Story 69.1)', () => {
  const REGION = 'foo.page.tiles'
  const REGION_FILE = 'src/lib/components/Tiles.svelte'
  const REGION_IMPORT =
    "<script>import Tiles from '$lib/components/Tiles.svelte'\n  let { data } = $props()</script>"
  const FORWARDS = '<Tiles data={data.__inject} />'
  const HOST = '/(app)/foo#page'

  function regionTree(hosts = `'${HOST}'`): string {
    const root = makeRoot()
    const standard = SUFFIXES.map((s) => `foo.page.${s}`)
    const rows = standard.map((name) => `  { name: '${name}', kind: 'standard', propsType: 'X' },`)
    writeFixture(
      root,
      REGISTRY,
      `export const INJECTION_POINTS = [\n${rows.join('\n')}\n  ...regionPoints('X', [${hosts}], ['${REGION}']),\n]\n`
    )
    writeFixture(root, PAGE, `${REGION_IMPORT}\n${points('foo.page')}\n${FORWARDS}`)
    writeFixture(root, PAGE_SERVER, PAGE_SERVER_OK)
    writeFixture(
      root,
      REGION_FILE,
      `<script>import Tile from './Tile.svelte'</script>\n<!-- @region ${REGION} -->\n<dl><Tile /><InjectionPoint name="${REGION}" /></dl>`
    )
    writeFixture(root, 'src/lib/components/Tile.svelte', '<div></div>')
    return root
  }

  it('passes a region whose point sits inside the marked node and whose host route is declared', () => {
    expect(problemsOf(regionTree()).problems).toEqual([])
  })

  it('reads a regionPoints spread as kind region with its host routes', () => {
    const fields = readRegistryFields(regionTree())
    expect(fields?.get(REGION)?.get('kind')).toBe('region')
    expect(fields?.get(REGION)?.get('hostRoutes')).toBe(HOST)
  })

  it('resolves a top-level string constant used as a regionPoints host route', () => {
    const root = regionTree()
    writeFixture(
      root,
      REGISTRY,
      `const HOST_ROUTE = '${HOST}'\nexport const INJECTION_POINTS = [\n  ...regionPoints('X', [HOST_ROUTE, UNKNOWN], ['${REGION}']),\n]\n`
    )
    expect(readRegistryFields(root)?.get(REGION)?.get('hostRoutes')).toBe(HOST)
  })

  it('fails a point placed AFTER the marked element instead of inside it', () => {
    const root = regionTree()
    writeFixture(
      root,
      REGION_FILE,
      `<script>import Tile from './Tile.svelte'</script>\n<!-- @region ${REGION} -->\n<dl><Tile /></dl>\n<InjectionPoint name="${REGION}" />`
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      '@region block contains no <InjectionPoint>'
    )
  })

  it('fails a region point rendered in two files', () => {
    const root = regionTree()
    writeFixture(root, 'src/lib/components/Twin.svelte', `<InjectionPoint name="${REGION}" />`)
    expect(problemsOf(root).problems.join('\n')).toContain(
      `injection point "${REGION}" is rendered in more than one file`
    )
  })

  it('fails a registered region that no file renders', () => {
    const root = regionTree()
    writeFixture(root, REGION_FILE, '<p>no point here</p>')
    expect(problemsOf(root).problems.join('\n')).toContain(
      `"${REGION}" is registered but no file renders it`
    )
  })

  it('fails a region named like a standard position, and bad name segments', () => {
    const root = regionTree()
    writeFixture(
      root,
      REGISTRY,
      "export const INJECTION_POINTS = [\n  ...regionPoints('X', [], ['foo.page.before', 'Foo.Tiles', 'foo.page.header.actions']),\n]\n"
    )
    const text = problemsOf(root).problems.join('\n')
    expect(text).toContain('region point "foo.page.before" ends in a standard position')
    expect(text).toContain('region point "foo.page.header.actions" ends in a standard position')
    expect(text).toContain('"Foo.Tiles" breaks the naming rule')
  })

  it('fails a non-literal point name inside a region component', () => {
    const root = regionTree()
    writeFixture(
      root,
      REGION_FILE,
      `<script>import Tile from './Tile.svelte'\n  let name = 'x'</script>\n<!-- @region ${REGION} -->\n<dl><Tile /><InjectionPoint {name} /></dl>`
    )
    expect(problemsOf(root).problems.join('\n')).toContain('name must be a string literal')
  })

  it('fails a declared host route that no route reaches, and an importing route the registry omits', () => {
    expect(problemsOf(regionTree(`'${HOST}', '/(app)/bar#page'`)).problems.join('\n')).toContain(
      `"${REGION}" declares host route "/(app)/bar#page"`
    )
    const root = regionTree('')
    expect(problemsOf(root).problems.join('\n')).toContain(
      `"${REGION}" is rendered by "${HOST}" (it imports ${REGION_FILE}) but the registry does not declare it`
    )
  })

  // Q1: every host route reaching a region component must hand it the page's `__inject` map, through
  // every component in between (a region that is not given `data` would silently render data = null).
  it('fails a host route that does not pass data to the region component', () => {
    const root = regionTree()
    writeFixture(root, PAGE, `${REGION_IMPORT}\n${points('foo.page')}\n<Tiles />`)
    expect(problemsOf(root).problems.join('\n')).toContain(
      `${PAGE} renders <Tiles> (${REGION_FILE}) without data={data.__inject}`
    )
  })

  it('fails a host route that passes the whole page data instead of its __inject map', () => {
    const root = regionTree()
    writeFixture(root, PAGE, `${REGION_IMPORT}\n${points('foo.page')}\n<Tiles {data} />`)
    expect(problemsOf(root).problems.join('\n')).toContain('without data={data.__inject}')
  })

  it('fails a component between the route and the region that does not forward data', () => {
    const root = regionTree()
    writeFixture(
      root,
      PAGE,
      `<script>import Wrap from '$lib/components/Wrap.svelte'\n  let { data } = $props()</script>\n${points('foo.page')}\n<Wrap data={data.__inject} />`
    )
    writeFixture(
      root,
      'src/lib/components/Wrap.svelte',
      "<script>import Tiles from './Tiles.svelte'</script><Tiles />"
    )
    const text = problemsOf(root).problems.join('\n')
    expect(text).toContain('src/lib/components/Wrap.svelte renders <Tiles>')
    expect(text).toContain('without passing data')
    writeFixture(
      root,
      'src/lib/components/Wrap.svelte',
      "<script>import Tiles from './Tiles.svelte'\n  let { data } = $props()</script><Tiles {data} />"
    )
    expect(problemsOf(root).problems).toEqual([])
  })

  it('accepts data={data?.__inject}', () => {
    const root = regionTree()
    writeFixture(
      root,
      PAGE,
      `${REGION_IMPORT}\n${points('foo.page')}\n<Tiles data={data?.__inject} />`
    )
    expect(problemsOf(root).problems).toEqual([])
  })

  it('--lock: a composed tree skips the host route check (a CM override may drop the import)', () => {
    const root = regionTree()
    writeFixture(root, PAGE, points('foo.page'))
    expect(problemsOf(root).problems.join('\n')).toContain('is rendered by no page or layout')
    const locked = problemsOf(root, { overrides: [{ path: PAGE }] }).problems.join('\n')
    expect(locked).not.toContain('is rendered by no page or layout')
  })
})

describe('check-injection-point-coverage: the real tree holds its regions (Story 69.1, 69.2)', () => {
  const REGIONS_ADDED_BY_69_1 = 14
  // Story 69.2: the credential detail page's regions.
  const REGIONS_ADDED_BY_69_2 = 13
  const REGIONS_ADDED_BY_69_3 = 22

  it('pairs every registered region point with a marker, inside the file that renders it', () => {
    const regions = [...(readRegistryFields(WEB) ?? [])].filter(
      ([, fields]) => fields.get('kind') === 'region'
    )
    expect(regions.length).toBeGreaterThanOrEqual(
      REGIONS_ADDED_BY_69_1 + REGIONS_ADDED_BY_69_2 + REGIONS_ADDED_BY_69_3
    )
    const marked = new Map<string, string[]>()
    for (const file of walkFiles(resolve(WEB, 'src'), (path) => path.endsWith('.svelte'))) {
      const parsed = parseMarkup(sysReadFile(file) ?? '', file)
      for (const region of parsed.regions) {
        const holders = parsed.points.filter((point) => point.name === region.name)
        if (holders.length > 0) marked.set(region.name, [...(marked.get(region.name) ?? []), file])
      }
    }
    for (const [name] of regions) {
      expect(
        marked.get(name),
        `${name} needs exactly one @region marker holding its point`
      ).toHaveLength(1)
    }
  })
})

// Story 69.3 AC-3: a count alone stays green when one file loses all its regions, so the five monitoring
// routes are pinned per file: each region component below must keep its `@region` marker holding its
// own point, and each host route must still reach it (the registry's `hostRoutes` is checked against
// the import graph by the guard itself).
describe('check-injection-point-coverage: the monitoring regions, per file (Story 69.3)', () => {
  const MONITORING_REGIONS: Record<string, string[]> = {
    'monitoring/ServiceEndpointsHeader.svelte': ['project.service-endpoints.header'],
    'monitoring/ServiceEndpointsAlerts.svelte': ['project.service-endpoints.alerts'],
    'monitoring/ServiceEndpointsTable.svelte': ['project.service-endpoints.table'],
    'monitoring/ServiceEndpointRow.svelte': ['project.service-endpoints.row'],
    'monitoring/ServiceEndpointsEmpty.svelte': ['project.service-endpoints.empty'],
    'monitoring/ServiceEndpointsNotFound.svelte': ['project.service-endpoints.not-found'],
    'monitoring/ServiceEndpointNewHeader.svelte': ['project.service-endpoints-new.header'],
    'monitoring/ServiceEndpointCreateForm.svelte': ['project.service-endpoints-new.form'],
    'monitoring/ServiceEndpointTitle.svelte': ['project.service-endpoints-detail.title'],
    'monitoring/ServiceEndpointPause.svelte': ['project.service-endpoints-detail.pause'],
    'monitoring/ServiceEndpointSettings.svelte': ['project.service-endpoints-detail.settings'],
    'monitoring/ServiceEndpointHistory.svelte': ['project.service-endpoints-detail.history'],
    'monitoring/ServiceEndpointDelete.svelte': ['project.service-endpoints-detail.delete'],
    'monitoring/ServiceEndpointDetailNotFound.svelte': [
      'project.service-endpoints-detail.not-found',
    ],
    'status-page/StatusPageHeader.svelte': ['project.status-page.header'],
    'status-page/StatusPageReadOnly.svelte': ['project.status-page.read-only'],
    'status-page/StatusPageDisabled.svelte': ['project.status-page.disabled'],
    'status-page/StatusPageLink.svelte': ['project.status-page.link'],
    'status-page/StatusPageServices.svelte': ['project.status-page.services'],
    'public-status/PublicStatusHeader.svelte': ['status.detail.header'],
    'public-status/PublicStatusServices.svelte': ['status.detail.services'],
    'public-status/PublicStatusUnavailable.svelte': ['status.detail.unavailable'],
  }

  it.each(Object.entries(MONITORING_REGIONS))(
    '%s holds its marked region(s), each with its own point',
    (file, names) => {
      const path = resolve(WEB, 'src/lib/components', file)
      const parsed = parseMarkup(sysReadFile(path) ?? '', path)
      expect(parsed.regionProblems).toEqual([])
      expect(parsed.regions.map((region) => region.name)).toEqual(names)
      for (const name of names) {
        expect(parsed.points.map((point) => point.name)).toContain(name)
      }
    }
  )

  it('registers every one of them as a region point with its host routes', () => {
    const registry = readRegistryFields(WEB) ?? new Map()
    for (const name of Object.values(MONITORING_REGIONS).flat()) {
      expect(registry.get(name)?.get('kind'), name).toBe('region')
    }
  })
})

const NEVER_RENDERED = 'never rendered'

describe('check-injection-point-coverage: dead points (Story 69.6 AC-3 g)', () => {
  const dead = (markup: string): string => {
    const root = cleanTree()
    writeFixture(root, PAGE, `${points('foo.page')}\n${markup}`)
    return problemsOf(root).problems.join('\n')
  }

  it('flags a point that sits only in a {#snippet} nobody renders', () => {
    const found = dead('{#snippet row()}<InjectionPoint name="foo.page.row" />{/snippet}')
    expect(found).toContain('"foo.page.row"')
    expect(found).toContain('{#snippet row}')
    expect(found).toContain(NEVER_RENDERED)
  })

  it('counts a point in a snippet that the same file renders', () => {
    expect(
      dead('{#snippet row()}<InjectionPoint name="foo.page.before" />{/snippet}\n{@render row()}')
    ).not.toContain(NEVER_RENDERED)
  })

  it('counts a snippet passed to a component as that component renders it', () => {
    const found = dead(
      '<Panel>{#snippet row()}<InjectionPoint name="foo.page.row" />{/snippet}</Panel>'
    )
    expect(found).not.toContain(NEVER_RENDERED)
  })

  it('flags a point inside {#if false} markup', () => {
    expect(dead('{#if false}<InjectionPoint name="foo.page.row" />{/if}')).toContain(
      'never renders'
    )
    expect(dead('{#if true}<p>x</p>{:else}<InjectionPoint name="foo.page.row" />{/if}')).toContain(
      'never renders'
    )
  })

  it('does not count a dead point as rendering its registered name', () => {
    const root = cleanTree()
    writeFixture(
      root,
      REGISTRY,
      registry([...PREFIXES.flatMap((p) => SUFFIXES.map((s) => `${p}.${s}`)), 'foo.page.row'])
    )
    writeFixture(
      root,
      PAGE,
      `${points('foo.page')}\n{#snippet row()}<InjectionPoint name="foo.page.row" />{/snippet}`
    )
    expect(problemsOf(root).problems.join('\n')).toContain(
      '"foo.page.row" is registered but no file renders it'
    )
  })
})

describe('check-injection-point-coverage: the coverage figure (Story 69.6 AC-3, Q3)', () => {
  const figureOf = (root: string, lock?: Parameters<typeof coverageFigure>[0]['lock']) =>
    coverageFigure({ webRoot: root, ...(lock === undefined ? {} : { lock }) })

  it('counts regions with a point, top-level uses in a region and pages with the three points', () => {
    const figure = figureOf(cleanTree())
    expect(figure).toMatchObject({
      regions: { covered: 0, total: 0 },
      uses: { covered: 0, total: 0 },
      pages: { covered: 2, total: 2 },
      routeFiles: 2,
      exempt: 0,
      percent: 100,
    })
    expect(formatFigure(figure)).toBe(
      'coverage: 0/0 regions with a point, 0/0 top-level uses in a region, 2/2 pages with the 3 standard points = 100% (2 route files, 0 composition-lock exempt)'
    )
  })

  it('counts a marked region and a use of a component that hosts one', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE,
      `<script>import Tiles from '$lib/components/Tiles.svelte'</script>\n${points('foo.page')}\n<Tiles />`
    )
    writeFixture(
      root,
      'src/lib/components/Tiles.svelte',
      `<!-- @region foo.page.tiles -->\n<dl><InjectionPoint name="foo.page.tiles" /></dl>`
    )
    expect(figureOf(root)).toMatchObject({
      regions: { covered: 1, total: 1 },
      uses: { covered: 1, total: 1 },
    })
  })

  it('drops below 100 % for a bare top-level use, a region with no point and a missing standard point', () => {
    const root = cleanTree()
    writeFixture(
      root,
      PAGE,
      `<script>import Tile from '$lib/components/Tile.svelte'</script>\n<InjectionPoint name="foo.page.before" />\n<!-- @region foo.page.x -->\n<div>none</div>\n<Tile />`
    )
    const figure = figureOf(root)
    expect(figure.uses).toEqual({ covered: 1, total: 2 })
    expect(figure.regions).toEqual({ covered: 0, total: 1 })
    expect(figure.pages).toEqual({ covered: 1, total: 2 })
    expect(figure.percent).toBeLessThan(100)
    expect(formatFigure(figure)).toContain('1/2 pages with the 3 standard points = 40%')
  })

  it('prints how many files a lock exempts, so an inflated exemption is visible (k)', () => {
    const root = cleanTree()
    const figure = figureOf(root, { overrides: [{ path: PAGE }] })
    expect(figure.exempt).toBe(1)
    expect(figure.routeFiles).toBe(2)
    expect(formatFigure(figure)).toContain('1 composition-lock exempt')
  })

  it('a figure of 0 files is not 100 % (a guard that matches nothing is not a pass)', () => {
    const root = makeRoot()
    writeFixture(root, REGISTRY, registry(['a.b.before']))
    expect(figureOf(root).percent).toBe(0)
  })

  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
  }

  const censusOracle = (root: string, count: number): string => {
    writeFixture(
      root,
      'src/routes/route-render-snapshot.test.ts',
      `it('covers every one of the ${count} route files', () => {})`
    )
    return root
  }

  it('the CLI prints the figure on success and exits 0 at 100 %', () => {
    const sink = io()
    expect(run(['--web', censusOracle(cleanTree(), 2)], sink.io)).toBe(0)
    const text = sink.out.join('')
    expect(text).toContain('scanned 2 route files')
    expect(text).toContain('coverage: 0/0 regions with a point')
    expect(text).toContain('= 100%')
  })

  it('the CLI exits 1 below 100 % even when no other problem is listed, and still prints the figure', () => {
    const root = censusOracle(cleanTree(), 2)
    writeFixture(
      root,
      PAGE,
      `<script>import Tile from '$lib/components/Tile.svelte'</script>\n${points('foo.page')}\n<Tile />`
    )
    const sink = io()
    expect(run(['--web', root], sink.io)).toBe(1)
    expect(sink.err.join('')).toContain('coverage: 0/0 regions with a point, 0/1 top-level uses')
  })

  it('the CLI fails when the route-render oracle census disagrees with the tree (k)', () => {
    const sink = io()
    expect(run(['--web', censusOracle(cleanTree(), 9)], sink.io)).toBe(1)
    expect(sink.err.join('')).toContain('expects 9 route files')
    const none = io()
    expect(run(['--web', cleanTree()], none.io)).toBe(1)
    expect(none.err.join('')).toContain('route census')
  })
})

describe('check-injection-point-coverage: the real tree and its wiring', () => {
  const started = Date.now()

  it('reports zero problems on apps/web and scans every route file', () => {
    const result = checkInjectionPointCoverage({ webRoot: WEB })
    expect(result.problems).toEqual([])
    expect(result.scannedRouteFiles).toBe(70)
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it('measures 100 % on apps/web with no region, use or page left out (Story 69.6)', () => {
    const figure = coverageFigure({ webRoot: WEB })
    expect(figure.percent).toBe(100)
    expect(figure.regions.total).toBeGreaterThan(180)
    expect(figure.regions.covered).toBe(figure.regions.total)
    expect(figure.uses.covered).toBe(figure.uses.total)
    expect(figure.pages).toEqual({ covered: 70, total: 70 })
    expect(figure.exempt).toBe(0)
  })

  it('has no baseline, ignore list or skip switch in its source', () => {
    const sources = [
      'scripts/lib/injection-point-coverage.ts',
      'scripts/check-injection-point-coverage.ts',
    ].map((file) => readFileSync(resolve(repositoryRoot, file), 'utf8'))
    for (const text of sources) {
      expect(text).not.toMatch(
        /allowlist|allow-list|baseline|--skip|eslint-disable|ignoreList|ignorePaths/i
      )
    }
  })

  it('is wired: package.json script, make ci-inner and the ci.yml Checks job', () => {
    const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['check-injection-point-coverage']).toBe(
      'tsx scripts/check-injection-point-coverage.ts'
    )
    const makefile = readFileSync(resolve(repositoryRoot, 'Makefile'), 'utf8')
    const recipe = makeRecipe(makefile, 'ci-inner')
    expect(recipeRunsCommand(recipe, 'pnpm check-injection-point-coverage')).toBe(true)
    expect(
      recipeRunsCommand(recipe, 'pnpm vitest run scripts/check-injection-point-coverage.test.ts')
    ).toBe(true)
    const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    const runs = workflowRunCommands(workflow).join('\n')
    expect(runs).toContain('pnpm check-injection-point-coverage')
    expect(runs).toContain('pnpm vitest run scripts/check-injection-point-coverage.test.ts')
  })
})
