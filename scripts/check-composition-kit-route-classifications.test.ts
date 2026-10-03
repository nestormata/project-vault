import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClassificationInputError,
  loadClassificationsFile,
  parseClassifications,
} from '../apps/api/src/extensions/api-routes/route-audit.js'
import { compose } from '../packages/composition-kit/src/compose.js'
import { validateGuardEntries } from '../packages/composition-kit/src/guard-entries.js'
import { extractClassifications } from '../packages/composition-kit/src/verify.js'
import {
  makeWorld,
  manifest,
  useWorlds,
  type World,
} from '../packages/composition-kit/tests/compose-test-helpers.js'
import { makeRecipe, workflowRunCommands } from './lib/ci-wiring.js'

// Story 68-16 AC-5: what a UI pack authors is exactly what the runtime route audit (Story 68-14)
// accepts. The kit (MIT) cannot import apps/api, so its entry rules are a mirror; this PV-side test
// composes the real fixture pack, extracts the classification file with `pv-verify --only
// classifications`, and feeds it to the API's own parser. It is DB-free and needs no registry.

useWorlds()

const repositoryRoot = join(import.meta.dirname, '..')
const FIXTURE = join(
  repositoryRoot,
  'packages',
  'composition-kit',
  'tests',
  'fixtures',
  'mini-pack'
)
const ROUTE_AUDIT = join(
  repositoryRoot,
  'apps',
  'api',
  'src',
  'extensions',
  'api-routes',
  'route-audit.ts'
)
const THIS_TEST = 'scripts/check-composition-kit-route-classifications.test.ts'

async function composedFixture(): Promise<World> {
  const world = makeWorld({
    packFiles: {
      'pv-guards.ts': readFileSync(join(FIXTURE, 'pv-guards.ts'), 'utf8'),
      'src/lib/billing-draft.ts': readFileSync(join(FIXTURE, 'src/lib/billing-draft.ts'), 'utf8'),
      // The fixture's `defineGuardEntries` import is the identity at runtime; the kit is not built here.
      'node_modules/@project-vault/composition-kit/package.json': JSON.stringify({
        name: '@project-vault/composition-kit',
        type: 'module',
        exports: './index.js',
      }),
      'node_modules/@project-vault/composition-kit/index.js':
        'export const defineGuardEntries = (entries) => entries\n',
    },
  })
  const result = await compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest({ guards: 'pv-guards.ts' }),
  })
  expect(result.messages).toEqual([])
  return world
}

/** The kit's verdict on one entry, as problems (empty means accepted). */
function kitProblems(entries: unknown[]): string[] {
  return validateGuardEntries({ routeClassifications: entries }).problems
}

/** The API parser's verdict on the same entries: the error message, or null when accepted. */
function auditError(entries: unknown[]): string | null {
  try {
    parseClassifications(JSON.stringify(entries))
    return null
  } catch (error) {
    if (error instanceof ClassificationInputError) return error.message
    throw error
  }
}

const GOOD = { route: 'GET /api/v1/x', reason: 'r' }
const MAXIMAL = {
  route: 'OPTIONS *',
  reason: 'r',
  securityOwner: 'owner',
  compensatingControls: ['control'],
  expiresAfterStory: 'story-1',
  revisitBy: '2027-01-01',
  temporary: true,
}

describe('composition kit route classifications vs the runtime route audit (Story 68-16 AC-5)', () => {
  it('the extracted file parses with the audit parser and returns the same entries', async () => {
    const world = await composedFixture()
    const out = join(world.root, 'classifications.json')
    expect(await extractClassifications({ appRoot: world.app, hostDir: world.host, out })).toEqual({
      ok: true,
      entries: 1,
      problems: [],
    })
    const parsed = loadClassificationsFile(out)
    expect(parsed).toEqual([
      {
        route: 'GET /api/v1/cm/health',
        reason: 'public liveness probe, returns a static body',
        securityOwner: 'cm-platform',
        compensatingControls: ['no data is read', 'edge rate limit'],
      },
    ])
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(parsed)
  })

  it('proves the test really uses the API parser: an unknown field in the file is rejected', async () => {
    const world = await composedFixture()
    const out = join(world.root, 'classifications.json')
    await extractClassifications({ appRoot: world.app, hostDir: world.host, out })
    const entries = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>[]
    writeFileSync(out, JSON.stringify([{ ...entries[0], class: 'public' }]))
    expect(() => loadClassificationsFile(out)).toThrow(/unknown field "class"/)
  })

  it('the kit and the audit accept the same entries', () => {
    for (const entry of [
      GOOD,
      MAXIMAL,
      { route: 'HEAD /x', reason: 'r' },
      { route: 'GET /', reason: 'r' },
      { ...GOOD, expiresAfterStory: null },
      { ...GOOD, temporary: false },
      { ...GOOD, compensatingControls: [] },
    ]) {
      expect(kitProblems([entry]), JSON.stringify(entry)).toEqual([])
      expect(auditError([entry]), JSON.stringify(entry)).toBeNull()
    }
  })

  it('the kit and the audit reject the same defect classes', () => {
    const defects: Record<string, unknown[]> = {
      'bad route (lower case)': [{ ...GOOD, route: 'get /x' }],
      'bad route (no slash)': [{ ...GOOD, route: 'GET x' }],
      'bad route (space in url)': [{ ...GOOD, route: 'GET /a b' }],
      'bad route (unknown method)': [{ ...GOOD, route: 'TRACE /x' }],
      'missing route': [{ reason: 'r' }],
      'empty reason': [{ ...GOOD, reason: '' }],
      'blank reason': [{ ...GOOD, reason: '   ' }],
      'missing reason': [{ route: 'GET /x' }],
      'unknown field': [{ ...GOOD, extra: 1 }],
      'the old 68-9 shape': [{ method: 'GET', url: '/x', class: 'public', reason: 'r' }],
      'duplicate route': [GOOD, GOOD],
      'compensatingControls not an array': [{ ...GOOD, compensatingControls: 'x' }],
      'compensatingControls blank item': [{ ...GOOD, compensatingControls: [''] }],
      'temporary not a boolean': [{ ...GOOD, temporary: 'yes' }],
      'empty securityOwner': [{ ...GOOD, securityOwner: '' }],
      'empty revisitBy': [{ ...GOOD, revisitBy: '' }],
      'empty expiresAfterStory': [{ ...GOOD, expiresAfterStory: '' }],
      'entry is not an object': ['GET /x'],
    }
    for (const [name, entries] of Object.entries(defects)) {
      expect(kitProblems(entries).length, `kit: ${name}`).toBeGreaterThan(0)
      expect(auditError(entries), `audit: ${name}`).not.toBeNull()
    }
  })

  it('every field the audit allows is accepted by the kit, and the kit allows no other', () => {
    const source = readFileSync(ROUTE_AUDIT, 'utf8')
    const block = /const ALLOWED_ENTRY_KEYS = new Set\(\[([^\]]*)\]\)/u.exec(source)?.[1] ?? ''
    const auditKeys = [...block.matchAll(/'([A-Za-z]+)'/gu)].map((match) => match[1] as string)
    expect(auditKeys).toContain('route')
    expect(auditKeys.length).toBeGreaterThanOrEqual(7)
    const kitAccepts = (key: string): boolean =>
      !kitProblems([{ route: 'GET /x', reason: 'r', [key]: 'x' }]).some((line) =>
        line.includes('unknown field')
      )
    for (const key of auditKeys) {
      expect(kitAccepts(key), `kit accepts the audit field ${key}`).toBe(true)
    }
    for (const key of ['class', 'method', 'url', 'owner', 'notes']) {
      expect(auditKeys, key).not.toContain(key)
      expect(kitAccepts(key), `kit rejects ${key}`).toBe(false)
    }
  })

  it('PV web carries the new entry shape, reads no classification, and commits an empty section (AC-8)', () => {
    const guardRoot = readFileSync(
      join(repositoryRoot, 'apps', 'web', 'src', 'lib', 'test', 'guard-root.ts'),
      'utf8'
    )
    expect(guardRoot).toMatch(/routeClassifications: \{\s+route: string\s+reason: string/u)
    expect(guardRoot).not.toMatch(/method: string; url: string; class: string/u)
    const generated = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          'apps',
          'web',
          'src',
          'lib',
          'composition',
          'guard-entries.generated.json'
        ),
        'utf8'
      )
    ) as { routeClassifications: unknown[] }
    expect(generated.routeClassifications).toEqual([])
    // only guard-root.ts (the typed loader) names the section in PV web's own sources
    const readers = readdirSync(join(repositoryRoot, 'apps', 'web', 'src'), { recursive: true })
      .map(String)
      .filter((file) => /\.(ts|svelte)$/u.test(file))
      .filter((file) =>
        readFileSync(join(repositoryRoot, 'apps', 'web', 'src', file), 'utf8').includes(
          'routeClassifications'
        )
      )
    expect(readers).toEqual(['lib/test/guard-root.ts'])
  })

  it('is wired into make ci and ci.yml next to the kit integration wiring test', () => {
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    const ci = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(makeRecipe(makefile, 'ci-inner')).toContain(`pnpm vitest run ${THIS_TEST}`)
    expect(workflowRunCommands(ci)).toContain(`pnpm vitest run ${THIS_TEST}`)
  })
})
