// Story 68.7 AC-9: composing a pack's nav delta onto a web-host that ships `nav-ids.json` with
// `delta: 1`: the references and declared ids land in the lock, a vanished operative id, a wrong
// surface and a collision with a new PV id fail, everything else is a note (inherited new ids,
// vanished hides, non-literal ids, the AGPL source-offer note). An older web-host keeps 68-3.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose, type ComposeResult } from '../src/compose.js'
import { deferredNotes } from '../src/contributions.js'
import { readLock, type CompositionLock } from '../src/lock.js'
import {
  RESOLVE_FROM,
  makeWorld,
  manifest,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'

useWorlds()

const NOT_APPLIED =
  'nav delta not applied: requires web-host with navigation as data (Story 68-7); the nav file was materialized'

const PRIMARY = 'primary'
const PROJECT = 'project'
const HEALTH = 'primary.health'
const entry = (id: string, surface = PRIMARY) => ({ id, surface, parent: null, conditional: false })
const HOST_IDS = [
  entry('primary.dashboard'),
  entry(HEALTH),
  entry('primary.settings'),
  entry('project.members', PROJECT),
  entry('footer.license', 'footer'),
]

function navIds(ids = HOST_IDS, delta: number | null = 1): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    ...(delta === null ? {} : { delta }),
    surfaces: [PRIMARY, PROJECT, 'footer'].map((id) => ({
      id,
      file: `src/${id}.svelte`,
      contextKeys: [],
    })),
    ids,
  })}\n`
}

const NAV = `import { defineNavDelta, hide, insert, move, relabel } from '@project-vault/composition-kit/nav'
const later = 'primary.' + 'settings'
export default defineNavDelta({
  primary: [
    insert({ after: 'primary.dashboard', item: { id: 'cm.billing', label: 'Billing', children: [{ id: 'cm.billing.plans', label: 'Plans' }] } }),
    relabel('primary.health', () => 'Status'),
    move(later, { parent: 'cm.billing' }),
    hide('primary.gone'),
  ],
  footer: [hide('footer.license')],
})
`

function world(hostIds: string, nav = NAV): World {
  return makeWorld({
    hostFiles: { 'manifests/nav-ids.json': hostIds },
    packFiles: { 'nav.ts': nav },
  })
}

function run(target: World): Promise<ComposeResult> {
  return compose({
    appRoot: target.app,
    packRoot: target.pack,
    hostDir: target.host,
    manifest: manifest({ nav: './nav.ts' }),
    resolveFrom: RESOLVE_FROM,
  })
}

function lockOf(target: World): CompositionLock {
  const read = readLock(join(target.app, 'composition.lock.json'))
  if (read?.lock === undefined) throw new Error(`no lock: ${read?.problem ?? 'missing'}`)
  return read.lock
}

const texts = (result: ComposeResult) => result.messages.join('\n')

describe('nav delta at compose time (Story 68.7 AC-9)', () => {
  it('records references, declared and host ids; notes, never fails, the deliberate changes', async () => {
    const target = world(navIds())
    const result = await run(target)
    expect(result.plan.problems).toEqual([])
    const lock = lockOf(target)
    expect(lock.contributions.nav).toBe('src/lib/_cm/nav.ts')
    expect(lock.navIdsReferenced).toEqual([
      { id: 'footer.license', operative: false },
      { id: 'primary.dashboard', operative: true },
      { id: 'primary.gone', operative: false },
      { id: 'primary.health', operative: true },
    ])
    expect(lock.navIdsDeclared).toEqual(['cm.billing', 'cm.billing.plans'])
    expect(lock.navIdsHost).toEqual(HOST_IDS.map((entry) => entry.id).sort())
    const notes = result.plan.notes
    expect(notes).not.toContain(NOT_APPLIED)
    expect(notes).toContain(
      "nav ids: web-host defines 5; every one this pack's nav does not change is inherited (shown)"
    )
    expect(notes).toContain('nav references: 7 literal, 1 not statically checked')
    expect(notes).toContain(
      'nav id argument at src/lib/_cm/nav.ts:7:10 is not a string literal; the composed nav test checks it'
    )
    expect(notes).toContain(
      'nav id "primary.gone" vanished from web-host; it is only hidden or removed, so nothing to do'
    )
    expect(notes).toContain(
      'nav delta changes footer.license: check the AGPL-3.0 §13 source-offer obligations (see DW-127/DW-225); never refused'
    )
  })

  it('names each id that is new in web-host on the next compose (inherited, shown)', async () => {
    const target = world(navIds())
    expect((await run(target)).plan.problems).toEqual([])
    writeAll(target.host, {
      'manifests/nav-ids.json': navIds([...HOST_IDS, entry('primary.audit')]),
    })
    const again = await run(target)
    expect(again.plan.problems).toEqual([])
    expect(again.plan.notes).toContain(
      'nav id "primary.audit" is new in web-host and inherited (shown) by this pack\'s nav'
    )
  })

  it('fails an operative reference to a vanished id', async () => {
    const result = await run(world(navIds(HOST_IDS.filter((entry) => entry.id !== HEALTH))))
    expect(result.plan.problems).toContain(
      'Nav id "primary.health" vanished from web-host and an operative nav change targets it'
    )
  })

  it('fails a reference under the wrong surface (Q4)', async () => {
    const result = await run(
      world(
        navIds(),
        "export default { primary: [{ op: 'relabel', id: 'project.members', label: 'M' }] }\n"
      )
    )
    expect(result.plan.problems).toEqual([
      'Nav id "project.members" belongs to surface "project", not "primary"',
    ])
  })

  it('fails an inserted id that web-host now defines (an accidental collision)', async () => {
    const result = await run(world(navIds([...HOST_IDS, entry('cm.billing')])))
    expect(result.plan.problems).toContain(
      'nav id "cm.billing" is inserted by this pack but web-host now defines it; rename your item or replace PV\'s'
    )
  })

  it('reports a syntax error in nav.ts with its file and line', async () => {
    const result = await run(world(navIds(), "export default { primary: [hide('x') }\n"))
    expect(result.plan.problems).toEqual([expect.stringMatching(/^src\/lib\/_cm\/nav\.ts:1:\d+: /)])
  })

  it('an older web-host (no delta) keeps Story 68-3: materialized, not applied, carried forward', async () => {
    for (const hostIds of [navIds(HOST_IDS, null), undefined]) {
      const target = makeWorld({
        ...(hostIds === undefined ? {} : { hostFiles: { 'manifests/nav-ids.json': hostIds } }),
        packFiles: { 'nav.ts': NAV },
      })
      const result = await run(target)
      expect(result.plan.problems).toEqual([])
      expect(result.plan.notes, JSON.stringify(result.plan.notes)).toContain(NOT_APPLIED)
      const lock = lockOf(target)
      expect(lock.contributions.nav).toBe('src/lib/_cm/nav.ts')
      expect(lock.navIdsReferenced).toEqual([])
      expect(lock.navIdsDeclared).toBeUndefined()
      expect(lock.navIdsHost).toBeUndefined()
    }
  })

  it('a supporting host and no nav file: no note, no references, host ids still recorded', async () => {
    const target = makeWorld({ hostFiles: { 'manifests/nav-ids.json': navIds() } })
    const result = await compose({
      appRoot: target.app,
      packRoot: target.pack,
      hostDir: target.host,
      manifest: manifest(),
      resolveFrom: RESOLVE_FROM,
    })
    expect(texts(result)).not.toContain('nav delta not applied')
    expect(lockOf(target).navIdsReferenced).toEqual([])
    expect(lockOf(target).navIdsHost).toHaveLength(5)
  })

  it('deferredNotes: no nav note for a supporting host', () => {
    expect(deferredNotes(manifest({ nav: './nav.ts' }), true, true)).toEqual([])
    expect(deferredNotes(manifest({ nav: './nav.ts' }), true, false)).toEqual([NOT_APPLIED])
  })
})
