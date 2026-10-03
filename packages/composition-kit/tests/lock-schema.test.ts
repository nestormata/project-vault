import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import { parseLock } from '../src/lock.js'
import { makeWorld, manifest, sha, useWorlds } from './compose-test-helpers.js'

useWorlds()

// Ajv is a dev tool of the repository (api-contract-tests); the kit itself has no such dependency.
const requireAjv = createRequire(
  join(import.meta.dirname, '..', '..', 'api-contract-tests', 'package.json')
)
interface Validator {
  (data: unknown): boolean
  errors?: unknown
}
const Ajv = requireAjv('ajv') as new (options: object) => { compile: (schema: object) => Validator }
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'schema', 'composition.lock.schema.json'), 'utf8')
) as object
const validate = new Ajv({ allErrors: true }).compile(schema)
const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'

async function composedLock(): Promise<Record<string, unknown>> {
  const world = makeWorld({
    packFiles: { [DASHBOARD]: 'cm\n', 'src/routes/billing/+page.svelte': 'b\n' },
  })
  const result = await compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest({
      routes: {
        overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD) }],
        remove: ['/login'],
      },
    }),
  })
  expect(result.messages).toEqual([])
  return JSON.parse(readFileSync(join(world.app, 'composition.lock.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('composition.lock.schema.json (Story 68.3 AC-8)', () => {
  it('validates the lock the composer writes', async () => {
    const lock = await composedLock()
    expect(validate(lock), JSON.stringify(validate.errors)).toBe(true)
  })

  it('fails a lock missing lockfileVersion or any required section', async () => {
    const lock = await composedLock()
    for (const key of Object.keys(lock).filter((name) => name !== 'injections')) {
      const { [key]: _dropped, ...rest } = lock
      expect(validate(rest), key).toBe(false)
    }
  })

  it('accepts a lock written before injections existed, and validates the section when present', async () => {
    const lock = await composedLock()
    const { injections: _injections, ...older } = lock
    expect(validate(older), JSON.stringify(validate.errors)).toBe(true)
    expect(parseLock(JSON.stringify(older), 'lock').problem).toBeUndefined()
    const entry = {
      point: 'a.b.c',
      component: 'src/lib/_cm/x.svelte',
      order: 0,
      load: null,
      actions: null,
      routeId: null,
      scope: null,
    }
    expect(validate({ ...lock, injections: [entry] })).toBe(true)
    expect(validate({ ...lock, injections: [{ ...entry, order: 'x' }] })).toBe(false)
    expect(validate({ ...lock, injections: [{ ...entry, extra: 1 }] })).toBe(false)
  })

  it('fails a malformed hash and a missing story field', async () => {
    const lock = await composedLock()
    const overrides = lock.overrides as Record<string, unknown>[]
    expect(validate({ ...lock, overrides: [{ ...overrides[0], cmSha256: 'nope' }] })).toBe(false)
    const { story: _story, ...noStory } = overrides[0] ?? {}
    expect(validate({ ...lock, overrides: [noStory] })).toBe(false)
  })

  it('contains no timestamps, absolute paths or hostnames', async () => {
    const text = JSON.stringify(await composedLock())
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(text).not.toMatch(/"\/(?:home|tmp|Users|var|root)\//)
    expect(text).not.toContain('kit-world')
  })

  it('parseLock explains an unreadable lock and points at the schema', () => {
    expect(parseLock('{', 'lock').problem).toContain('composition.lock.schema.json')
    expect(parseLock('{"lockfileVersion":1}', 'lock').problem).toContain('missing')
  })
})
