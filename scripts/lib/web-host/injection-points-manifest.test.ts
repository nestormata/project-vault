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
      row('region.thing.tiles', 'region'),
    ].join('\n')}\n]\n`
  )
  writeFixture(root, PAGE, `<InjectionPoint name="${FOO}" />`)
  writeFixture(
    root,
    'src/routes/+layout.svelte',
    `<svelte:head><InjectionPoint name="${HEAD}" /></svelte:head>`
  )
  writeFixture(root, 'src/lib/components/shell/AppShell.svelte', `<InjectionPoint name="${END}" />`)
  writeFixture(
    root,
    'src/lib/components/Region.svelte',
    '<InjectionPoint name="region.thing.tiles" />'
  )
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
        name: 'region.thing.tiles',
        file: 'src/lib/components/Region.svelte',
        kind: 'region',
        propsType: 'P',
        scope: 'component',
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
