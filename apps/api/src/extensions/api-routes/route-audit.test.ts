import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ClassificationInputError,
  classifyRoutes,
  formatAuditReport,
  loadClassificationsFile,
  mergeClassifications,
  parseClassifications,
  type ClassificationEntry,
} from './route-audit.js'
import type { ObservedRoute } from './route-observer.js'

/** Story 68.14 AC-2 — the pure classifier, the strict classification input and the report. */

const SECURE = { builtBy: 'secureRoute' }
const HEALTH = '/health'
const NEEDS_REASON = 'classifications[0].reason must be a non-empty string'
const GOOD = { route: `GET ${HEALTH}`, reason: 'liveness' }

function route(
  method: string,
  url: string,
  origin: ObservedRoute['origin'] = 'plugin',
  pvRoute?: unknown
): ObservedRoute {
  return { method, url, origin, ...(pvRoute === undefined ? {} : { pvRoute }) }
}

const tableOf = (entries: ClassificationEntry[], extension: ClassificationEntry[] = []) =>
  mergeClassifications(entries, extension)

describe('parseClassifications (strict input)', () => {
  it('accepts PV-shaped entries including the optional table fields', () => {
    const entries = parseClassifications(
      JSON.stringify([
        {
          route: 'POST /cm/hook',
          reason: 'webhook',
          securityOwner: 'cm',
          compensatingControls: ['hmac'],
          expiresAfterStory: null,
          revisitBy: '2027-01-01',
          temporary: false,
        },
        { route: 'OPTIONS *', reason: 'preflight' },
      ])
    )
    expect(entries.map((entry) => entry.route)).toEqual(['POST /cm/hook', 'OPTIONS *'])
  })

  it.each([
    ['not JSON', '{nope', 'not valid JSON'],
    ['a non-array top level', '{"route":"GET /x"}', 'must be a JSON array'],
    ['a non-object entry', '["GET /x"]', 'classifications[0] must be an object'],
    ['a missing route', '[{"reason":"r"}]', 'classifications[0].route must be a non-empty string'],
    ['a missing reason', '[{"route":"GET /x"}]', NEEDS_REASON],
    ['an empty reason', '[{"route":"GET /x","reason":"  "}]', NEEDS_REASON],
    [
      'an unknown field',
      '[{"route":"GET /x","reason":"r","extra":1}]',
      'classifications[0] has unknown field "extra"',
    ],
    [
      'a malformed route key',
      '[{"route":"get /x","reason":"r"}]',
      'classifications[0].route must be "METHOD /full/url"',
    ],
    [
      'a route without a leading slash',
      '[{"route":"GET x","reason":"r"}]',
      'classifications[0].route must be "METHOD /full/url"',
    ],
    [
      'a duplicate key',
      '[{"route":"GET /x","reason":"r"},{"route":"GET /x","reason":"r2"}]',
      'classifications[1] duplicates the route key GET /x',
    ],
    [
      'a non-string owner',
      '[{"route":"GET /x","reason":"r","securityOwner":3}]',
      'securityOwner must be a non-empty string',
    ],
    [
      'non-array controls',
      '[{"route":"GET /x","reason":"r","compensatingControls":"a"}]',
      'compensatingControls must be an array',
    ],
    [
      'a bad control',
      '[{"route":"GET /x","reason":"r","compensatingControls":[""]}]',
      'compensatingControls[0] must be a non-empty string',
    ],
    [
      'a non-boolean temporary',
      '[{"route":"GET /x","reason":"r","temporary":"yes"}]',
      'temporary must be a boolean',
    ],
    [
      'a bad expiresAfterStory',
      '[{"route":"GET /x","reason":"r","expiresAfterStory":4}]',
      'expiresAfterStory must be a non-empty string',
    ],
    [
      'a bad revisitBy',
      '[{"route":"GET /x","reason":"r","revisitBy":""}]',
      'revisitBy must be a non-empty string',
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseClassifications(text)).toThrow(ClassificationInputError)
    expect(() => parseClassifications(text)).toThrow(message)
  })
})

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/classifications/${name}`, import.meta.url))

describe('loadClassificationsFile', () => {
  it('reads a regular file', () => {
    expect(loadClassificationsFile(fixturePath('ok.json'))).toEqual([GOOD])
  })

  it('resolves a relative path against the working directory', () => {
    expect(
      loadClassificationsFile('src/extensions/api-routes/__fixtures__/classifications/ok.json')
    ).toEqual([GOOD])
  })

  it('rejects an unreadable path, a directory and a device without reading them', () => {
    expect(() => loadClassificationsFile(fixturePath('missing.json'))).toThrow(
      'classifications file cannot be read'
    )
    expect(() => loadClassificationsFile(fixturePath(''))).toThrow('not a regular file')
    expect(() => loadClassificationsFile('/dev/null')).toThrow('not a regular file')
  })

  it('propagates strict parse errors from the file content', () => {
    expect(() => loadClassificationsFile(fixturePath('not-json.json'))).toThrow('not valid JSON')
    expect(() => loadClassificationsFile(fixturePath('missing-reason.json'))).toThrow(NEEDS_REASON)
  })
})

describe('mergeClassifications', () => {
  it('keeps both sources and rejects an extension restating a PV key', () => {
    const table = tableOf([GOOD], [{ route: 'GET /cm', reason: 'cm' }])
    expect(table.get(`GET ${HEALTH}`)?.source).toBe('pv')
    expect(table.get('GET /cm')?.source).toBe('extension')
    expect(() => tableOf([GOOD], [GOOD])).toThrow('duplicates a PV classification')
  })
})

describe('classifyRoutes', () => {
  const table = tableOf([GOOD], [{ route: 'POST /cm/raw', reason: 'cm raw' }])

  it('counts secureRoute-built, classified and HEAD-clone routes and passes', () => {
    const report = classifyRoutes(
      [
        route('GET', '/api/v1/projects', 'core', SECURE),
        route('POST', '/cm/x', 'extension-add', { builtBy: 'secureRoute', added: true }),
        route('GET', HEALTH),
        route('HEAD', HEALTH),
        route('POST', '/cm/raw'),
      ],
      table
    )
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.counts).toEqual({
      secureRoute: 2,
      'classified-pv': 1,
      'classified-extension': 1,
      'head-clone': 1,
    })
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBe(report.total)
  })

  it('fails naming BOTH GET and HEAD when a classification is removed', () => {
    const report = classifyRoutes([route('GET', HEALTH), route('HEAD', HEALTH)], tableOf([]))
    expect(report.ok).toBe(false)
    expect(report.failures).toEqual([
      expect.stringContaining(`unclassified route GET ${HEALTH} (origin: plugin)`),
      expect.stringContaining(`unclassified route HEAD ${HEALTH} (origin: plugin)`),
    ])
  })

  it('an explicit HEAD route without a GET partner needs its own classification', () => {
    const report = classifyRoutes([route('HEAD', '/lonely')], table)
    expect(report.failures.some((line) => line.includes('unclassified route HEAD /lonely'))).toBe(
      true
    )
  })

  it('names the origin of an unclassified raw route from an app-level hook', () => {
    const report = classifyRoutes([route('GET', '/cm/sneaky', 'hook-registered')], table)
    expect(report.failures).toContain('stale classification GET /health: no such route')
    expect(
      report.failures.some((line) => line.includes('GET /cm/sneaky (origin: hook-registered)'))
    ).toBe(true)
  })

  it('a route classified by an extension entry passes', () => {
    const report = classifyRoutes(
      [route('GET', HEALTH), route('POST', '/cm/raw', 'hook-registered')],
      table
    )
    expect(report.ok).toBe(true)
  })

  it('a stale classification FAILS the audit and names the key', () => {
    const report = classifyRoutes(
      [route('GET', HEALTH)],
      tableOf([GOOD, { route: 'GET /gone', reason: 'r' }])
    )
    expect(report.ok).toBe(false)
    expect(report.failures).toEqual(['stale classification GET /gone: no such route'])
  })

  it('a replaceSecurity override of a secureRoute keeps its builtBy and needs no entry', () => {
    const report = classifyRoutes(
      [
        route('GET', '/api/v1/dashboard', 'core', {
          builtBy: 'secureRoute',
          replaceSecurity: true,
        }),
      ],
      tableOf([])
    )
    expect(report.ok).toBe(true)
  })

  it('a replaceSecurity override of a classified raw route keeps its classification', () => {
    const report = classifyRoutes(
      [
        route('GET', HEALTH, 'plugin', {
          builtBy: 'onRoute',
          override: 'replace',
          replaceSecurity: true,
        }),
      ],
      tableOf([GOOD])
    )
    expect(report.ok).toBe(true)
  })

  it('a synthetic key collision fails with both origins in the message', () => {
    const report = classifyRoutes(
      [route('GET', '/dup', 'core', SECURE), route('GET', '/dup', 'extension-add', SECURE)],
      tableOf([])
    )
    expect(report.failures).toContain('duplicate route key GET /dup (origins: core, extension-add)')
  })

  it('sorts failures and routes by code unit so the output is deterministic', () => {
    const shuffled = [route('GET', '/b'), route('GET', '/a'), route('POST', '/a')]
    const first = formatAuditReport(classifyRoutes(shuffled, tableOf([])))
    const second = formatAuditReport(classifyRoutes([...shuffled].reverse(), tableOf([])))
    expect(first).toBe(second)
    expect(first.indexOf('GET /a')).toBeLessThan(first.indexOf('GET /b'))
  })
})

describe('formatAuditReport', () => {
  it('prints counts and failures without paths or env values', () => {
    const passing = formatAuditReport(
      classifyRoutes([route('GET', '/x', 'core', SECURE)], tableOf([]))
    )
    expect(passing).toBe(
      [
        'route audit: PASS',
        'routes observed: 1',
        '  secureRoute-built: 1',
        '  classified (PV table): 0',
        '  classified (extension table): 0',
        '  HEAD clones of classified GET routes: 0',
      ].join('\n')
    )
    const failing = formatAuditReport(classifyRoutes([route('GET', '/y')], tableOf([])))
    expect(failing).toContain('route audit: FAIL')
    expect(failing).toContain('failures: 1')
    expect(failing).not.toContain(process.cwd())
  })
})
