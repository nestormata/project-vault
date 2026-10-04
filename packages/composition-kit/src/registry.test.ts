import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkInjectionPoints, checkNavIds, readRegistries } from './registry.js'

const A_PAGE = 'src/routes/a/+page.svelte'

const B_PAGE = 'src/routes/b/+page.svelte'
const SHELL_HEAD = 'shell.head'
const OLD_POINT = 'old.point.x'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostWith(manifests: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-registry-'))
  roots.push(root)
  mkdirSync(join(root, 'manifests'))
  for (const [name, value] of Object.entries(manifests)) {
    writeFileSync(join(root, 'manifests', name), JSON.stringify(value))
  }
  return root
}

describe('readRegistries', () => {
  it('returns nothing for registries the host does not ship', () => {
    expect(readRegistries(hostWith({}))).toEqual({ problems: [] })
  })

  it('reads the minimal shapes and tolerates extra fields', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': {
          schemaVersion: 1,
          extra: true,
          points: [{ name: 'project.detail.tiles', file: 'src/routes/p/+page.svelte', more: 1 }],
        },
        'nav-ids.json': { schemaVersion: 1, ids: [{ id: 'settings.org', area: 'settings' }] },
      })
    )
    expect(registries.injectionPoints).toEqual([
      { name: 'project.detail.tiles', file: 'src/routes/p/+page.svelte' },
    ])
    expect(registries.navIds).toEqual(['settings.org'])
    expect(registries.problems).toEqual([])
  })

  it('fails a registry from a newer schema or with the wrong shape', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': { schemaVersion: 2, points: [] },
        'nav-ids.json': { schemaVersion: 1, ids: 'x' },
      })
    )
    expect(registries.problems).toEqual([
      expect.stringContaining('injection-points.json'),
      expect.stringContaining('nav-ids.json'),
    ])
  })
})

describe('checkInjectionPoints (AC-7, AC-9)', () => {
  const points = [{ name: 'a.b', file: A_PAGE }]

  it('notes, never passes silently, when the registry is absent', () => {
    expect(checkInjectionPoints(['a.b'], undefined, new Set())).toEqual({
      problems: [],
      notes: ['injection point names not validated: this web-host ships no injection-points.json'],
      used: [{ name: 'a.b', file: null }],
    })
  })

  it('fails a name the registry does not have', () => {
    const result = checkInjectionPoints(['nope'], points, new Set())
    expect(result.problems).toEqual([expect.stringContaining('"nope"')])
  })

  it('only notes when the page that contained the point was overridden or removed by the pack', () => {
    const previous = [{ name: 'gone', file: A_PAGE }]
    const result = checkInjectionPoints(['gone'], points, new Set([A_PAGE]), previous)
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([expect.stringContaining('gone')])
  })

  it('fails a vanished point CM did not cause, naming the file it used to live in', () => {
    const previous = [{ name: 'gone', file: B_PAGE }]
    const result = checkInjectionPoints(['gone'], points, new Set(), previous)
    expect(result.problems).toEqual([expect.stringContaining(B_PAGE)])
  })

  it('records the file for known points', () => {
    expect(checkInjectionPoints(['a.b'], points, new Set()).used).toEqual([
      { name: 'a.b', file: A_PAGE },
    ])
  })
})

describe('checkNavIds (design section 11)', () => {
  it('notes when the registry is absent and fails only operative vanished ids', () => {
    expect(checkNavIds([{ id: 'x', operative: true }], undefined).problems).toEqual([])
    const result = checkNavIds(
      [
        { id: 'gone-op', operative: true },
        { id: 'gone-hide', operative: false },
        { id: 'here', operative: true },
      ],
      ['here']
    )
    expect(result.problems).toEqual([expect.stringContaining('gone-op')])
    expect(result.notes).toEqual([expect.stringContaining('gone-hide')])
  })
})

describe('route ids and scopes for behavior injection (Story 68.4 AC-17)', () => {
  it('reads routeId and scope as additive fields without changing the minimal record', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': {
          schemaVersion: 1,
          points: [
            { name: 'a.b.after', file: A_PAGE, routeId: '/(app)/a', scope: 'page' },
            {
              name: SHELL_HEAD,
              file: 'src/routes/+layout.svelte',
              routeId: '/',
              scope: 'layout',
            },
            { name: OLD_POINT, file: A_PAGE },
          ],
        },
      })
    )
    expect(registries.injectionPoints).toEqual([
      { name: 'a.b.after', file: A_PAGE },
      { name: SHELL_HEAD, file: 'src/routes/+layout.svelte' },
      { name: OLD_POINT, file: A_PAGE },
    ])
    expect(registries.pointRoutes).toEqual([
      { name: 'a.b.after', routeId: '/(app)/a', scope: 'page', hostRoutes: null },
      { name: SHELL_HEAD, routeId: '/', scope: 'layout', hostRoutes: null },
      { name: OLD_POINT, routeId: null, scope: null, hostRoutes: null },
    ])
  })

  it('fails closed on a duplicate name in the registry file', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': {
          schemaVersion: 1,
          points: [
            { name: 'a.b.after', file: A_PAGE },
            { name: 'a.b.after', file: B_PAGE },
          ],
        },
      })
    )
    expect(registries.problems).toEqual([
      'manifests/injection-points.json: duplicate injection point name "a.b.after"',
    ])
  })

  it('ends the unknown-point message with the way out: override the page or replace the component', () => {
    const result = checkInjectionPoints(['nope'], [{ name: 'a.b', file: A_PAGE }], new Set())
    expect(result.problems).toEqual([
      'Injection point "nope" does not exist in web-host\'s injection-points.json. If this point is missing, override the page (M1) or replace the component (M4); a missing point never blocks you. Ask for the point in PV.',
    ])
  })
})

describe('readRegistries: hostRoutes (Story 69.1)', () => {
  it('reads the additive hostRoutes of a component-scoped point, null when the host predates it', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': {
          schemaVersion: 1,
          points: [
            {
              name: 'dashboard.home.activity',
              file: 'src/lib/c.svelte',
              scope: 'component',
              hostRoutes: ['/(app)/dashboard#page'],
              unknownFutureField: { nested: true },
            },
            { name: OLD_POINT, file: 'src/lib/o.svelte', scope: 'component' },
          ],
        },
      })
    )
    expect(registries.problems).toEqual([])
    expect(registries.pointRoutes).toEqual([
      {
        name: 'dashboard.home.activity',
        routeId: null,
        scope: 'component',
        hostRoutes: ['/(app)/dashboard#page'],
      },
      { name: OLD_POINT, routeId: null, scope: 'component', hostRoutes: null },
    ])
  })

  it('ignores a malformed hostRoutes value instead of failing (an additive field)', () => {
    const registries = readRegistries(
      hostWith({
        'injection-points.json': {
          schemaVersion: 1,
          points: [{ name: 'a.b.c', file: 'x', scope: 'component', hostRoutes: 'nope' }],
        },
      })
    )
    expect(registries.problems).toEqual([])
    expect(registries.pointRoutes?.[0]?.hostRoutes).toBeNull()
  })
})
