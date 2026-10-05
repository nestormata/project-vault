import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readRegistries } from '../../../packages/composition-kit/src/registry.ts'
import { useFixtureRoots, writeFixture } from '../fixture-test-helpers.js'
import { buildInjectionPointsManifest } from './injection-points-manifest.js'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web')
const makeRoot = useFixtureRoots('injection-manifest-', ['src/routes'])
const REGISTRY = 'src/lib/components/composition/injection-points.ts'
const PAGE = 'src/routes/(app)/foo/+page.svelte'
const SHELL = 'shell'
const FOO = 'foo.page.before'
const HEAD = 'shell.head'
const END = 'shell.header.end'

const FOO_HOST = '/(app)/foo#page'
const REGION = 'region.thing.tiles'
const REGION_FILE = 'src/lib/components/Region.svelte'
const REGION_IMPORT = '$lib/components/Region.svelte'
const PROPS = 'let { data } = $props()'
const PAGE_BODY = `<InjectionPoint name="${FOO}" />\n<Region data={data.__inject} />`

/** A registry spread declaring the region point and the host routes that render it. */
function regionRow(hosts: string, names = `'${REGION}'`): string {
  const list = hosts === '' ? '' : hosts.split(',').map((host) => `'${host}'`)
  return `  ...regionPoints('P', [${list}], [${names}]),`
}

function row(name: string, kind = 'standard', extra = ''): string {
  return `  { name: '${name}', kind: '${kind}', propsType: 'P'${extra} },`
}

function tree(): string {
  const root = makeRoot()
  writeFixture(
    root,
    REGISTRY,
    `export const INJECTION_POINTS = [\n${[
      row(FOO),
      row(HEAD, SHELL),
      row(END, SHELL, ", hostRouteId: '/(app)'"),
      regionRow(FOO_HOST),
    ].join('\n')}\n]\n`
  )
  writeFixture(
    root,
    PAGE,
    `<script>import Region from '${REGION_IMPORT}'\n${PROPS}</script>\n${PAGE_BODY}`
  )
  writeFixture(
    root,
    'src/routes/+layout.svelte',
    `<svelte:head><InjectionPoint name="${HEAD}" /></svelte:head>`
  )
  writeFixture(root, 'src/lib/components/shell/AppShell.svelte', `<InjectionPoint name="${END}" />`)
  writeFixture(root, REGION_FILE, `<InjectionPoint name="${REGION}" />`)
  return root
}

describe('buildInjectionPointsManifest (Story 68.4 AC-2)', () => {
  it('joins the registry with the rendering file, route id and scope, sorted by name', () => {
    const { points, problems } = buildInjectionPointsManifest(tree())
    expect(problems).toEqual([])
    expect(points).toEqual([
      {
        name: FOO,
        file: PAGE,
        kind: 'standard',
        propsType: 'P',
        routeId: '/(app)/foo',
        scope: 'page',
      },
      {
        name: REGION,
        file: REGION_FILE,
        kind: 'region',
        propsType: 'P',
        scope: 'component',
        hostRoutes: [FOO_HOST],
      },
      {
        name: HEAD,
        file: 'src/routes/+layout.svelte',
        kind: SHELL,
        propsType: 'P',
        routeId: '/',
        scope: 'layout',
      },
      {
        name: END,
        file: 'src/lib/components/shell/AppShell.svelte',
        kind: SHELL,
        propsType: 'P',
        routeId: '/(app)',
        scope: 'shell',
      },
    ])
  })

  it('is byte-deterministic', () => {
    const root = tree()
    expect(buildInjectionPointsManifest(root).text).toBe(buildInjectionPointsManifest(root).text)
  })

  it('fails closed on a missing or empty registry (never an empty stub)', () => {
    const root = makeRoot()
    expect(buildInjectionPointsManifest(root).problems[0]).toContain('no INJECTION_POINTS registry')
    writeFixture(root, REGISTRY, 'export const INJECTION_POINTS = []\n')
    expect(buildInjectionPointsManifest(root).text).toBe('')
  })

  it('reports a registered name nobody renders, an unregistered literal and a name in two files', () => {
    const root = tree()
    writeFixture(
      root,
      'src/lib/components/Ghost.svelte',
      '<InjectionPoint name="not.registered.here" />'
    )
    writeFixture(root, 'src/lib/components/Dup.svelte', `<InjectionPoint name="${FOO}" />`)
    const text = buildInjectionPointsManifest(root).problems.join('\n')
    expect(text).toContain('"not.registered.here" is not registered')
    expect(text).toContain('"foo.page.before" is rendered in more than one file')
    writeFixture(
      root,
      REGISTRY,
      `export const INJECTION_POINTS = [\n${row(FOO)}\n${row('lonely.page.before')}\n]\n`
    )
    expect(buildInjectionPointsManifest(root).problems.join('\n')).toContain(
      '"lonely.page.before" is registered but no file renders it'
    )
  })

  it('rejects a bad name (naming rule) with the registry file named', () => {
    const root = tree()
    writeFixture(root, REGISTRY, `export const INJECTION_POINTS = [\n${row('Foo.Bar')}\n]\n`)
    expect(buildInjectionPointsManifest(root).problems.join('\n')).toContain(
      '"Foo.Bar" breaks the naming rule'
    )
  })
})

// Story 69.1 AC-4 / Q1: a region point's host routes are DERIVED from the import graph (route files
// to the region component, through other components too) and the registry declaration is checked
// against it both ways. The manifest never trusts the declaration.
describe('region point host routes (Story 69.1)', () => {
  const problemsOf = (root: string): string =>
    buildInjectionPointsManifest(root).problems.join('\n')

  function declare(root: string, hosts: string, names?: string): void {
    writeFixture(
      root,
      REGISTRY,
      `export const INJECTION_POINTS = [\n${row(FOO)}\n${row(HEAD, SHELL)}\n${row(END, SHELL, ", hostRouteId: '/(app)'")}\n${regionRow(hosts, names)}\n]\n`
    )
  }

  it('resolves a region reached through another component, and lists every host sorted', () => {
    const root = tree()
    writeFixture(root, REGION_FILE, `<InjectionPoint name="${REGION}" />`)
    writeFixture(
      root,
      'src/lib/components/Wrapper.svelte',
      `<script>import Region from './Region.svelte'\n${PROPS}</script><Region {data} />`
    )
    writeFixture(
      root,
      PAGE,
      `<script>import Wrapper from '$lib/components/Wrapper.svelte'\n${PROPS}</script>\n<InjectionPoint name="${FOO}" />\n<Wrapper data={data.__inject} />`
    )
    writeFixture(
      root,
      'src/routes/(app)/foo/+layout.svelte',
      `<script>import Region from '${REGION_IMPORT}'\n${PROPS}</script><Region data={data.__inject} />`
    )
    declare(root, `${FOO_HOST},/(app)/foo#layout`)
    const manifest = buildInjectionPointsManifest(root)
    expect(manifest.problems).toEqual([])
    expect(manifest.points.find((point) => point.name === REGION)).toMatchObject({
      scope: 'component',
      hostRoutes: ['/(app)/foo#layout', FOO_HOST],
    })
  })

  it('fails a declared host route that does not import the region component', () => {
    const root = tree()
    declare(root, `${FOO_HOST},/(app)/bar#page`)
    expect(problemsOf(root)).toContain(
      `"${REGION}" declares host route "/(app)/bar#page" but no such route renders ${REGION_FILE}`
    )
  })

  it('fails an importing route the registry does not declare', () => {
    const root = tree()
    writeFixture(
      root,
      'src/routes/(app)/bar/+page.svelte',
      `<script>import Region from '${REGION_IMPORT}'\n${PROPS}</script><Region data={data.__inject} />\n<InjectionPoint name="bar.page.before" />`
    )
    expect(problemsOf(root)).toContain(
      `"${REGION}" is rendered by "/(app)/bar#page" (it imports ${REGION_FILE}) but the registry does not declare it`
    )
  })

  it('fails a region component that no route file reaches (an empty host list is a bug, not a stub)', () => {
    const root = tree()
    writeFixture(root, PAGE, PAGE_BODY.replace('<Region data={data.__inject} />', ''))
    declare(root, '')
    expect(problemsOf(root)).toContain(`"${REGION}" is rendered by no page or layout`)
  })

  it('ignores a type-only import of the region component', () => {
    const root = tree()
    writeFixture(
      root,
      PAGE,
      `<script lang="ts">import type Region from '${REGION_IMPORT}'</script>\n<InjectionPoint name="${FOO}" />`
    )
    expect(problemsOf(root)).toContain(`"${REGION}" declares host route "${FOO_HOST}"`)
  })

  it('keeps schemaVersion 1 and a deterministic file with the additive hostRoutes field', () => {
    const root = tree()
    const { text } = buildInjectionPointsManifest(root)
    const parsed = JSON.parse(text) as {
      schemaVersion: number
      points: { hostRoutes?: string[] }[]
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.points.filter((point) => point.hostRoutes !== undefined)).toHaveLength(1)
    expect(text).toBe(buildInjectionPointsManifest(root).text)
  })
})

describe('the real registry and the kit (compatibility contract)', () => {
  it('the generated file is read by the kit with no problems, every point round-tripping name and file', () => {
    const { text, points, problems } = buildInjectionPointsManifest(WEB)
    expect(problems).toEqual([])
    expect(points.length).toBeGreaterThan(200)
    const host = makeRoot()
    writeFixture(host, 'manifests/injection-points.json', text)
    const registries = readRegistries(host)
    expect(registries.problems).toEqual([])
    expect(registries.injectionPoints).toEqual(points.map(({ name, file }) => ({ name, file })))
  })

  it('carries a route id and scope for every route-rendered point, including the fixed CM names', () => {
    const { points } = buildInjectionPointsManifest(WEB)
    const byName = new Map(points.map((point) => [point.name, point]))
    expect(byName.get('project.detail.after')).toMatchObject({
      routeId: '/(app)/projects/[projectId]',
      scope: 'page',
    })
    expect(byName.get('project.layout.after')).toMatchObject({
      routeId: '/(app)/projects/[projectId]',
      scope: 'layout',
    })
    expect(byName.get('root.error.before')).toMatchObject({ routeId: '/', scope: 'error' })
    expect(byName.get(HEAD)).toMatchObject({ routeId: '/', scope: 'layout' })
    expect(byName.get(END)).toMatchObject({ routeId: '/(app)', scope: 'shell' })
    for (const name of [
      'dashboard.home.before',
      'project.members.before',
      'project.service-endpoints.before',
      'project.status-page.before',
      'credential.detail.before',
      'settings.audit.before',
      'settings.notifications.before',
    ]) {
      expect(byName.has(name), name).toBe(true)
    }
  })
})

// Story 69.3 (AC-1, AC-4): every monitoring region point lists exactly the host route that renders its
// component, derived from the import graph, so a contribution's `hostRoutes` opt-in can name it.
describe('the real registry: monitoring region host routes (Story 69.3)', () => {
  const LIST = '/(app)/projects/[projectId]/service-endpoints#page'
  const NEW = '/(app)/projects/[projectId]/service-endpoints/new#page'
  const DETAIL = '/(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]#page'
  const STATUS_ADMIN = '/(app)/projects/[projectId]/status-page#page'
  const PUBLIC = '/status/[token]#page'
  const EXPECTED: Record<string, string> = {
    'project.service-endpoints.header': LIST,
    'project.service-endpoints.alerts': LIST,
    'project.service-endpoints.table': LIST,
    'project.service-endpoints.row': LIST,
    'project.service-endpoints.empty': LIST,
    'project.service-endpoints.not-found': LIST,
    'project.service-endpoints-new.header': NEW,
    'project.service-endpoints-new.form': NEW,
    'project.service-endpoints-detail.title': DETAIL,
    'project.service-endpoints-detail.pause': DETAIL,
    'project.service-endpoints-detail.settings': DETAIL,
    'project.service-endpoints-detail.history': DETAIL,
    'project.service-endpoints-detail.delete': DETAIL,
    'project.service-endpoints-detail.not-found': DETAIL,
    'project.status-page.header': STATUS_ADMIN,
    'project.status-page.read-only': STATUS_ADMIN,
    'project.status-page.disabled': STATUS_ADMIN,
    'project.status-page.link': STATUS_ADMIN,
    'project.status-page.services': STATUS_ADMIN,
    'status.detail.header': PUBLIC,
    'status.detail.services': PUBLIC,
    'status.detail.unavailable': PUBLIC,
  }

  it.each(Object.entries(EXPECTED))('%s is a region hosted by exactly its route', (name, host) => {
    const { points, problems } = buildInjectionPointsManifest(WEB)
    expect(problems).toEqual([])
    const point = points.find((candidate) => candidate.name === name)
    expect(point?.kind).toBe('region')
    expect(point?.hostRoutes).toEqual([host])
  })
})
