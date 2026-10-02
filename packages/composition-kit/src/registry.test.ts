import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkInjectionPoints, checkNavIds, readRegistries } from './registry.js'

const A_PAGE = 'src/routes/a/+page.svelte'

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
    const previous = [{ name: 'gone', file: 'src/routes/b/+page.svelte' }]
    const result = checkInjectionPoints(['gone'], points, new Set(), previous)
    expect(result.problems).toEqual([expect.stringContaining('src/routes/b/+page.svelte')])
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
