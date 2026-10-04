import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { checkInjectionPointCoverage, readRegistryFields } from './lib/injection-point-coverage.js'
import { parseMarkup } from './lib/route-files.js'
import { walkFiles } from './lib/scan-utils.js'
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
  const REGION_IMPORT = "<script>import Tiles from '$lib/components/Tiles.svelte'</script>"
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
    writeFixture(root, PAGE, `${REGION_IMPORT}\n${points('foo.page')}\n<Tiles />`)
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

  it('--lock: a composed tree skips the host route check (a CM override may drop the import)', () => {
    const root = regionTree()
    writeFixture(root, PAGE, points('foo.page'))
    expect(problemsOf(root).problems.join('\n')).toContain('is rendered by no page or layout')
    const locked = problemsOf(root, { overrides: [{ path: PAGE }] }).problems.join('\n')
    expect(locked).not.toContain('is rendered by no page or layout')
  })
})

describe('check-injection-point-coverage: the real tree holds its regions (Story 69.1)', () => {
  const REGIONS_ADDED_BY_69_1 = 14

  it('pairs every registered region point with a marker, inside the file that renders it', () => {
    const regions = [...(readRegistryFields(WEB) ?? [])].filter(
      ([, fields]) => fields.get('kind') === 'region'
    )
    expect(regions.length).toBeGreaterThanOrEqual(REGIONS_ADDED_BY_69_1)
    const marked = new Map<string, string[]>()
    for (const file of walkFiles(resolve(WEB, 'src'), (path) => path.endsWith('.svelte'))) {
      const parsed = parseMarkup(readFileSync(file, 'utf8'), file)
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

describe('check-injection-point-coverage: the real tree and its wiring', () => {
  const started = Date.now()

  it('reports zero problems on apps/web and scans every route file', () => {
    const result = checkInjectionPointCoverage({ webRoot: WEB })
    expect(result.problems).toEqual([])
    expect(result.scannedRouteFiles).toBe(70)
    expect(Date.now() - started).toBeLessThan(30_000)
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
