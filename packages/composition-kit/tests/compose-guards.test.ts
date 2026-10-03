import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import { GUARD_ENTRIES_PATH } from '../src/guard-entries.js'
import { makeWorld, manifest, sha, shaOf, useWorlds, type World } from './compose-test-helpers.js'

useWorlds()

const UTIL = 'src/lib/util.ts'
const UTIL_TEST = 'src/lib/util.test.ts'
const OVERRIDE_BODY = 'export const fmt = String\n'
const LOGIN = 'src/routes/login/+page.svelte'
const BILLING = 'src/lib/billing/draft.ts'
const GUARDS = 'pv-guards.json'
const LOCK_FILE = 'composition.lock.json'
const SUBJECTS = 'manifests/test-subjects.json'
const ENTRY = { file: BILLING, keys: ['cm:billing-draft'], reason: 'non-sensitive id' }
const SESSION_STORE = { browserStorage: { sessionStorage: [ENTRY] } }

function subjectsManifest(subjects: Record<string, string[]>): string {
  return JSON.stringify({ schemaVersion: 1, subjects })
}

function lockOf(world: World): Record<string, unknown> {
  return JSON.parse(readFileSync(join(world.app, LOCK_FILE), 'utf8')) as Record<string, unknown>
}

function generated(world: World): Record<string, unknown> {
  return JSON.parse(readFileSync(join(world.app, GUARD_ENTRIES_PATH), 'utf8')) as Record<
    string,
    unknown
  >
}

async function run(world: World, extra: Parameters<typeof manifest>[0] = {}, check = false) {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest(extra),
    ...(check ? { check: true } : {}),
  })
}

describe('compose: pack guard entries (Story 68.9 AC-3)', () => {
  it('maps a pack entry to its composed file, writes the generated module and locks its hashes', async () => {
    const world = makeWorld({
      packFiles: { [BILLING]: 'export const k = 1\n', [GUARDS]: JSON.stringify(SESSION_STORE) },
    })
    const result = await run(world, { guards: GUARDS })
    expect(result.messages).toEqual([])
    const entries = generated(world) as { browserStorage: { sessionStorage: unknown[] } }
    expect(Object.keys(entries)[0]).toBe('_generated')
    expect(entries.browserStorage.sessionStorage).toEqual([
      { file: BILLING, keys: ['cm:billing-draft'], reason: 'non-sensitive id' },
    ])
    const lock = lockOf(world) as { guardEntries: Record<string, string>; notes: string[] }
    expect(Object.keys(lock.guardEntries)).toEqual([
      'browserStorage',
      'externalHrefs',
      'internalApiConsumers',
      'routeClassifications',
    ])
    expect(lock.notes.filter((note) => note.includes('unreached'))).toEqual([])
  })

  it('maps a materialized pack file to its src/lib/_cm location', async () => {
    const world = makeWorld({
      packFiles: {
        'brand/theme.css': ':root { --x: 1 }\n',
        [GUARDS]: JSON.stringify({
          externalHrefs: {
            allow: [{ file: 'brand/theme.css', href: 'https://x.example', reason: 'r' }],
          },
        }),
      },
    })
    const result = await run(world, { theme: 'brand/theme.css', guards: GUARDS })
    expect(result.messages).toEqual([])
    const entries = generated(world) as { externalHrefs: { allow: { file: string }[] } }
    expect(entries.externalHrefs.allow[0]?.file).toBe('src/lib/_cm/brand/theme.css')
  })

  it('is byte-identical on a second compose and passes --check', async () => {
    const world = makeWorld({
      packFiles: { [BILLING]: 'export const k = 1\n', [GUARDS]: JSON.stringify(SESSION_STORE) },
    })
    await run(world, { guards: GUARDS })
    const first = readFileSync(join(world.app, LOCK_FILE), 'utf8')
    const text = readFileSync(join(world.app, GUARD_ENTRIES_PATH), 'utf8')
    expect((await run(world, { guards: GUARDS })).ok).toBe(true)
    expect(readFileSync(join(world.app, LOCK_FILE), 'utf8')).toBe(first)
    expect(readFileSync(join(world.app, GUARD_ENTRIES_PATH), 'utf8')).toBe(text)
    expect((await run(world, { guards: GUARDS }, true)).ok).toBe(true)
  })

  it('exits non-zero for a stale entry, naming the entry and the file', async () => {
    const world = makeWorld({ packFiles: { [GUARDS]: JSON.stringify(SESSION_STORE) } })
    const result = await run(world, { guards: GUARDS })
    expect(result.ok).toBe(false)
    expect(result.messages.join('\n')).toContain(
      `guard entry browserStorage.sessionStorage[0].file "${BILLING}" maps to no composed file (stale carve-out)`
    )
  })

  it('fails on a missing entry file, an escaping path and a non-data module', async () => {
    const missing = makeWorld({})
    expect((await run(missing, { guards: GUARDS })).messages.join('\n')).toContain(
      `guards: ${GUARDS} is named by the manifest but is not in the UI pack.`
    )
    const escaping = makeWorld({})
    expect((await run(escaping, { guards: '../x.json' })).messages.join('\n')).toContain(
      'must be a path inside the UI pack'
    )
    const code = makeWorld({
      packFiles: { 'guards.mjs': 'export default { browserStorage: { release: () => [] } }\n' },
    })
    expect((await run(code, { guards: 'guards.mjs' })).messages.join('\n')).toContain('plain data')
  })

  it('reports an entry with no reason as an integrity error with a ready-to-paste fix', async () => {
    const world = makeWorld({
      packFiles: {
        [BILLING]: 'x\n',
        [GUARDS]: JSON.stringify({
          browserStorage: { sessionStorage: [{ file: BILLING, keys: ['k'] }] },
        }),
      },
    })
    const result = await run(world, { guards: GUARDS })
    expect(result.ok).toBe(false)
    expect(result.messages.join('\n')).toContain('has no reason')
  })

  it('refuses a release for an untouched file and accepts one for an override', async () => {
    const untouched = makeWorld({
      packFiles: { [GUARDS]: JSON.stringify({ browserStorage: { release: [UTIL] } }) },
    })
    const refused = await run(untouched, { guards: GUARDS })
    expect(refused.ok).toBe(false)
    expect(refused.messages.join('\n')).toContain(
      'cannot release an entry for a file CM did not change'
    )
    const overridden = makeWorld({
      packFiles: {
        [UTIL]: OVERRIDE_BODY,
        [GUARDS]: JSON.stringify({ browserStorage: { release: [UTIL] } }),
      },
    })
    const allowed = await run(overridden, {
      guards: GUARDS,
      routes: { overrides: [{ path: UTIL, hostSha256: sha(overridden, UTIL) }] },
    })
    expect(allowed.messages).toEqual([])
    expect(
      (generated(overridden) as { browserStorage: { release: string[] } }).browserStorage.release
    ).toEqual([UTIL])
  })

  it('leaves the host entries module alone when the pack declares no guards, and locks its hashes', async () => {
    const empty = {
      _generated: 'x',
      browserStorage: { sessionStorage: [], localStorage: [], release: [] },
    }
    const world = makeWorld({ hostFiles: { [GUARD_ENTRIES_PATH]: JSON.stringify(empty) } })
    expect((await run(world)).messages).toEqual([])
    expect(JSON.parse(readFileSync(join(world.app, GUARD_ENTRIES_PATH), 'utf8'))).toEqual(empty)
    expect(Object.keys((lockOf(world) as { guardEntries: object }).guardEntries)).toEqual([
      'browserStorage',
    ])
  })

  it('notes a host without the entries module when the pack authors entries', async () => {
    const world = makeWorld({
      packFiles: { [BILLING]: 'x\n', [GUARDS]: JSON.stringify(SESSION_STORE) },
    })
    await run(world, { guards: GUARDS })
    expect((lockOf(world) as { notes: string[] }).notes).toContain(
      'host has no generated guard entries module; this web-host version does not read guard entries'
    )
  })

  it('--check against an old lock without guardEntries reports a diff, never a crash', async () => {
    const world = makeWorld({
      packFiles: { [BILLING]: 'x\n', [GUARDS]: JSON.stringify(SESSION_STORE) },
    })
    await run(world, { guards: GUARDS })
    const path = join(world.app, LOCK_FILE)
    const old = lockOf(world)
    delete old.guardEntries
    old.excludedPvTests = []
    writeFileSync(path, `${JSON.stringify(old, null, 2)}\n`)
    const checked = await run(world, { guards: GUARDS }, true)
    expect(checked.ok).toBe(false)
    expect(checked.messages.join('\n')).toContain('composition.lock.json is out of date')
  })
})

describe('compose: guard files a pack overrides (Story 68.9 Q3)', () => {
  const REGISTRY = JSON.stringify({
    schemaVersion: 1,
    guards: [
      {
        id: 'mini',
        kind: 'test',
        file: 'src/lib/g.test.ts',
        scope: 'all-files',
        closure: [{ file: UTIL, sha256: 'a'.repeat(64) }],
      },
    ],
  })

  it('composes (M1 floor) and notes a pack override of a guard file or of its helper closure', async () => {
    const world = makeWorld({
      hostFiles: { 'manifests/guards.json': REGISTRY, 'src/lib/g.test.ts': 'guard\n' },
      packFiles: { [UTIL]: OVERRIDE_BODY },
    })
    const result = await run(world, {
      routes: { overrides: [{ path: UTIL, hostSha256: sha(world, UTIL) }] },
    })
    expect(result.ok).toBe(true)
    expect((lockOf(world) as { notes: string[] }).notes).toContain(
      `guard-file-overridden: ${UTIL} (pv-verify runs the pristine PV copy)`
    )
  })

  it('adds no note when no guard file was changed, or the host has no registry', async () => {
    const quiet = makeWorld({
      hostFiles: { 'manifests/guards.json': REGISTRY },
      packFiles: { [LOGIN]: '<h1>cm</h1>\n' },
    })
    await run(quiet, { routes: { overrides: [{ path: LOGIN, hostSha256: sha(quiet, LOGIN) }] } })
    const notes = (lockOf(quiet) as { notes: string[] }).notes
    expect(notes.filter((note) => note.startsWith('guard-file-overridden'))).toEqual([])
    const none = makeWorld({ packFiles: { [UTIL]: OVERRIDE_BODY } })
    expect(
      (await run(none, { routes: { overrides: [{ path: UTIL, hostSha256: sha(none, UTIL) }] } })).ok
    ).toBe(true)
  })
})

describe('compose: excludedPvTests (Story 68.9 AC-10)', () => {
  const SUBJECT_MAP = {
    [UTIL_TEST]: [UTIL],
    'src/lib/other.test.ts': ['src/lib/other.ts'],
    'src/routes/login/login.test.ts': [LOGIN],
    'src/lib/both.test.ts': [UTIL, 'src/lib/other.ts'],
  }

  it('records the tests whose subject the pack overrode, sorted, and runs the rest', async () => {
    const world = makeWorld({
      hostFiles: { [SUBJECTS]: subjectsManifest(SUBJECT_MAP) },
      packFiles: { [UTIL]: OVERRIDE_BODY },
    })
    const result = await run(world, {
      routes: { overrides: [{ path: UTIL, hostSha256: sha(world, UTIL) }] },
    })
    expect(result.messages).toEqual([])
    expect(lockOf(world).excludedPvTests).toEqual(['src/lib/both.test.ts', UTIL_TEST])
  })

  it('counts a removed route file as a changed subject', async () => {
    const world = makeWorld({ hostFiles: { [SUBJECTS]: subjectsManifest(SUBJECT_MAP) } })
    await run(world, { routes: { remove: ['/login'] } })
    expect(lockOf(world).excludedPvTests).toEqual(['src/routes/login/login.test.ts'])
  })

  it('never lists a test the pack itself overrode (it is CM test code now)', async () => {
    const hostTest = 'import "./util"\n'
    const world = makeWorld({
      hostFiles: {
        [SUBJECTS]: subjectsManifest({ [UTIL_TEST]: [UTIL] }),
        [UTIL_TEST]: hostTest,
      },
      packFiles: { [UTIL]: OVERRIDE_BODY, [UTIL_TEST]: 'cm test\n' },
    })
    const result = await run(world, {
      routes: {
        overrides: [
          { path: UTIL, hostSha256: sha(world, UTIL) },
          { path: UTIL_TEST, hostSha256: shaOf(hostTest) },
        ],
      },
    })
    expect(result.messages).toEqual([])
    expect(lockOf(world).excludedPvTests).toEqual([])
  })

  it('writes an empty list and a note when the host publishes no subject map', async () => {
    const world = makeWorld({ packFiles: { [UTIL]: OVERRIDE_BODY } })
    await run(world, { routes: { overrides: [{ path: UTIL, hostSha256: sha(world, UTIL) }] } })
    expect(lockOf(world).excludedPvTests).toEqual([])
    expect((lockOf(world) as { notes: string[] }).notes).toContain(
      'host publishes no test-subjects manifest; no PV test was excluded automatically'
    )
  })

  it('rejects a subject map with an unsupported schema version', async () => {
    const world = makeWorld({
      hostFiles: { [SUBJECTS]: JSON.stringify({ schemaVersion: 9, subjects: {} }) },
    })
    const result = await run(world)
    expect(result.ok).toBe(false)
    expect(result.messages.join('\n')).toContain('upgrade @project-vault/composition-kit')
  })

  it('does not depend on the previous lock: the list is recomputed every run', async () => {
    const world = makeWorld({
      hostFiles: { [SUBJECTS]: subjectsManifest(SUBJECT_MAP) },
      packFiles: { [UTIL]: OVERRIDE_BODY },
    })
    const overrides = { routes: { overrides: [{ path: UTIL, hostSha256: sha(world, UTIL) }] } }
    await run(world, overrides)
    const stale = lockOf(world)
    stale.excludedPvTests = ['src/lib/gone.test.ts']
    writeFileSync(join(world.app, LOCK_FILE), `${JSON.stringify(stale, null, 2)}\n`)
    await run(world, overrides)
    expect(lockOf(world).excludedPvTests).toEqual(['src/lib/both.test.ts', UTIL_TEST])
    expect(existsSync(join(world.app, GUARD_ENTRIES_PATH))).toBe(false)
  })

  it('warns, report-only, about security-relevant exclusions and a high exclusion rate', async () => {
    const world = makeWorld({
      hostFiles: {
        [SUBJECTS]: subjectsManifest({
          'src/lib/server/auth.test.ts': [UTIL],
          'src/lib/a.test.ts': ['src/lib/a.ts'],
        }),
      },
      packFiles: { [UTIL]: OVERRIDE_BODY },
    })
    const result = await run(world, {
      routes: { overrides: [{ path: UTIL, hostSha256: sha(world, UTIL) }] },
    })
    expect(result.ok).toBe(true)
    const notes = (lockOf(world) as { notes: string[] }).notes
    expect(notes).toContain(
      '1 excluded PV test(s) look security relevant: src/lib/server/auth.test.ts'
    )
    expect(notes).toContain('1 of 2 PV tests excluded (50%)')
  })
})
