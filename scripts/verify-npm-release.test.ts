import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import {
  evaluateRelease,
  provenanceStatement,
  runCli,
  type Expectations,
  type Packument,
  type Statement,
} from './verify-npm-release.js'

// Story 68.12 AC-5. The fixtures are the real, public registry answers for
// @project-vault/extension-api@3.27.0 recorded on 2026-10-03, trimmed to the fields the helper
// reads (signatures, certificates and the signed access URL are dropped; the DSSE payloads are
// byte-for-byte the published ones). Every negative case mutates a decoded copy of them.

const repositoryRoot = join(import.meta.dirname, '..')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'verify-npm-release')
const PACKUMENT_TEXT = readFileSync(join(FIXTURES, 'extension-api-3.27.0.packument.json'), 'utf8')
const ATTESTATIONS_TEXT = readFileSync(
  join(FIXTURES, 'extension-api-3.27.0.attestations.json'),
  'utf8'
)
const PACKUMENT_URL = 'https://registry.npmjs.org/@project-vault%2fextension-api'
const ATTESTATIONS_URL =
  'https://registry.npmjs.org/-/npm/v1/attestations/@project-vault%2fextension-api@3.27.0'

const ATTESTATION_CHECK = 'provenance attestation'
const REF_CHECK = 'provenance ref'

const EXPECT: Expectations = {
  packageName: '@project-vault/extension-api',
  version: '3.27.0',
  tag: 'extension-api-v3.27.0',
  distTag: 'next',
}

function packument(): Packument {
  return JSON.parse(PACKUMENT_TEXT) as Packument
}

function statement(): Statement {
  return provenanceStatement(JSON.parse(ATTESTATIONS_TEXT))
}

function failures(checks: { ok: boolean; name: string }[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.name)
}

describe('verify-npm-release: evaluateRelease (Story 68.12 AC-5)', () => {
  it('passes the real extension-api 3.27.0 release', () => {
    const checks = evaluateRelease(packument(), { statement: statement() }, EXPECT)
    expect(failures(checks)).toEqual([])
    expect(checks.map((check) => check.name)).toEqual([
      'version exists',
      'dist-tag',
      'not deprecated',
      ATTESTATION_CHECK,
      'provenance repository',
      'provenance workflow',
      REF_CHECK,
      'provenance subject',
      'provenance digest',
    ])
  })

  it('selects the SLSA statement by predicate type, never by index', () => {
    const response = JSON.parse(ATTESTATIONS_TEXT) as { attestations: unknown[] }
    response.attestations.reverse()
    expect(provenanceStatement(response)).toEqual(statement())
  })

  it('fails when the version is missing', () => {
    const checks = evaluateRelease(
      packument(),
      { statement: statement() },
      {
        ...EXPECT,
        version: '3.99.0',
      }
    )
    expect(failures(checks)).toEqual(['version exists', 'dist-tag'])
  })

  it('fails when the dist-tag names another version', () => {
    const checks = evaluateRelease(
      packument(),
      { statement: statement() },
      {
        ...EXPECT,
        distTag: 'latest',
      }
    )
    expect(failures(checks)).toEqual(['dist-tag'])
  })

  it('fails when the version is deprecated', () => {
    const value = packument()
    const version = value.versions?.['3.27.0']
    if (version !== undefined) version.deprecated = 'do not use'
    expect(failures(evaluateRelease(value, { statement: statement() }, EXPECT))).toEqual([
      'not deprecated',
    ])
  })

  it('fails when there is no attestation, or it is not SLSA provenance v1', () => {
    const value = packument()
    const dist = value.versions?.['3.27.0']?.dist
    if (dist?.attestations?.provenance !== undefined) {
      dist.attestations.provenance.predicateType = 'https://slsa.dev/provenance/v0.2'
    }
    expect(failures(evaluateRelease(value, { statement: statement() }, EXPECT))).toEqual([
      ATTESTATION_CHECK,
    ])
    expect(
      failures(evaluateRelease(packument(), { error: 'no provenance attestation' }, EXPECT))
    ).toEqual([ATTESTATION_CHECK])
  })

  const statementCases: [string, (value: Statement) => void, string][] = [
    [
      'another repository',
      (value) => setWorkflow(value, { repository: 'https://github.com/someone/fork' }),
      'provenance repository',
    ],
    [
      'another workflow file',
      (value) => setWorkflow(value, { path: '.github/workflows/web-host-release.yml' }),
      'provenance workflow',
    ],
    ['a branch ref', (value) => setWorkflow(value, { ref: 'refs/heads/main' }), REF_CHECK],
    [
      'another tag',
      (value) => setWorkflow(value, { ref: 'refs/tags/extension-api-v3.25.0' }),
      REF_CHECK,
    ],
    [
      'another subject',
      (value) => {
        const subject = value.subject?.[0]
        if (subject !== undefined) subject.name = 'pkg:npm/@project-vault/extension-api@3.27.0'
      },
      'provenance subject',
    ],
    [
      'another digest',
      (value) => {
        const digest = value.subject?.[0]?.digest
        if (digest !== undefined) digest.sha512 = '0'.repeat(128)
      },
      'provenance digest',
    ],
  ]

  for (const [label, change, failing] of statementCases) {
    it(`fails on a statement from ${label}`, () => {
      const value = statement()
      change(value)
      expect(failures(evaluateRelease(packument(), { statement: value }, EXPECT))).toEqual([
        failing,
      ])
    })
  }

  it('rejects a malformed bundle with a named error', () => {
    const response = JSON.parse(ATTESTATIONS_TEXT) as {
      attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[]
    }
    for (const entry of response.attestations) entry.bundle.dsseEnvelope.payload = 'bm90IGpzb24='
    expect(() => provenanceStatement(response)).toThrow(/malformed attestation bundle/)
    expect(() => provenanceStatement({ attestations: [] })).toThrow(/no SLSA provenance/)
  })
})

function setWorkflow(
  value: Statement,
  change: { repository?: string; path?: string; ref?: string }
): void {
  const workflow = value.predicate?.buildDefinition?.externalParameters?.workflow
  if (workflow !== undefined) Object.assign(workflow, change)
}

type Answer = { status: number; body: string } | 'timeout' | 'body-timeout'

function fakeFetch(answers: Record<string, Answer | Answer[]>): {
  fetch: typeof fetch
  urls: string[]
  redirects: (RequestRedirect | undefined)[]
} {
  const urls: string[] = []
  const redirects: (RequestRedirect | undefined)[] = []
  const byUrl = new Map(Object.entries(answers))
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    redirects.push(init?.redirect)
    const entry = byUrl.get(url)
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
    if (answer === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    if (answer === 'timeout') {
      return Promise.reject(new DOMException('The operation was aborted', 'TimeoutError'))
    }
    if (answer === 'body-timeout') {
      // The headers arrive, then the body stalls until the request's timeout signal fires.
      const body = new ReadableStream({
        start(controller) {
          controller.error(new DOMException('The operation was aborted', 'TimeoutError'))
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    return Promise.resolve(new Response(answer.body, { status: answer.status }))
  }
  return { fetch: fetchImpl as typeof fetch, urls, redirects }
}

const ARGS = [
  '--package',
  '@project-vault/extension-api',
  '--version',
  '3.27.0',
  '--tag',
  'extension-api-v3.27.0',
  '--expect-dist-tag',
  'next',
]

async function cli(
  args: string[],
  answers: Record<string, Answer | Answer[]>
): Promise<{
  code: number
  lines: string[]
  urls: string[]
  redirects: (RequestRedirect | undefined)[]
  sleeps: number[]
}> {
  const lines: string[] = []
  const sleeps: number[] = []
  const fake = fakeFetch(answers)
  const code = await runCli(args, {
    fetch: fake.fetch,
    log: (line) => lines.push(line),
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })
  return { code, lines, urls: fake.urls, redirects: fake.redirects, sleeps }
}

const OK_ANSWERS = {
  [PACKUMENT_URL]: { status: 200, body: PACKUMENT_TEXT },
  [ATTESTATIONS_URL]: { status: 200, body: ATTESTATIONS_TEXT },
}

describe('verify-npm-release: CLI (Story 68.12 AC-5, no network)', () => {
  it('prints one ok line per check and exits 0 for a good release', async () => {
    const result = await cli(ARGS, OK_ANSWERS)
    expect(result.code).toBe(0)
    expect(result.lines).toHaveLength(9)
    expect(result.lines.every((line) => line.startsWith('ok '))).toBe(true)
    expect(result.urls).toEqual([PACKUMENT_URL, ATTESTATIONS_URL])
  })

  // Code review 68.12: fetch follows redirects by default, so a registry redirect to another host
  // would be followed silently. Every request refuses redirects.
  it('refuses HTTP redirects on every request', async () => {
    const result = await cli(ARGS, OK_ANSWERS)
    expect(result.redirects).toEqual(['error', 'error'])
  })

  it('never follows an attestation URL outside registry.npmjs.org', async () => {
    const value = packument()
    const attestations = value.versions?.['3.27.0']?.dist?.attestations
    if (attestations !== undefined) attestations.url = 'https://example.com/attestations'
    const result = await cli(ARGS, {
      [PACKUMENT_URL]: { status: 200, body: JSON.stringify(value) },
    })
    expect(result.code).toBe(1)
    expect(result.urls).toEqual([PACKUMENT_URL])
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^FAIL provenance attestation: .*not on https:\/\/registry\.npmjs\.org\//
      )
    )
  })

  it('turns 5xx, non-JSON bodies and timeouts into named FAIL lines', async () => {
    for (const [answer, message] of [
      [{ status: 503, body: 'unavailable' }, /HTTP 503/],
      [{ status: 200, body: '<html>' }, /not JSON/],
      ['timeout', /timed out/],
      ['body-timeout', /timed out/],
    ] as const) {
      const result = await cli(ARGS, { [PACKUMENT_URL]: answer })
      expect(result.code).toBe(1)
      expect(result.lines).toEqual([expect.stringMatching(message)])
      expect(result.lines[0]).toMatch(/^FAIL packument: /)
    }
  })

  it('polls while the version is missing (registry lag), then succeeds', async () => {
    const missing = packument()
    missing.versions = {}
    missing['dist-tags'] = { latest: '3.25.0', next: '3.25.0' }
    const result = await cli([...ARGS, '--wait', '600'], {
      [PACKUMENT_URL]: [
        { status: 200, body: JSON.stringify(missing) },
        { status: 200, body: PACKUMENT_TEXT },
      ],
      [ATTESTATIONS_URL]: { status: 200, body: ATTESTATIONS_TEXT },
    })
    expect(result.code).toBe(0)
    expect(result.sleeps).toEqual([30_000])
    expect(result.lines[0]).toBe(
      'registry not updated yet (npm processing lag, see docs/releasing.md § 9)'
    )
  })

  it('stops polling at the --wait limit', async () => {
    const result = await cli([...ARGS, '--expect-dist-tag', 'beta', '--wait', '60'], OK_ANSWERS)
    expect(result.code).toBe(1)
    expect(result.sleeps).toEqual([30_000, 30_000])
    expect(result.lines).toContain('FAIL dist-tag: beta is unset, expected 3.27.0')
  })

  it('reports any other failure at once, without polling', async () => {
    const result = await cli(
      [...ARGS, '--tag', 'extension-api-v3.25.0', '--wait', '600'],
      OK_ANSWERS
    )
    expect(result.code).toBe(1)
    expect(result.sleeps).toEqual([])
  })

  it('rejects an unknown package or missing arguments as a usage error', async () => {
    const unknown = await cli(['--package', 'left-pad', ...ARGS.slice(2)], OK_ANSWERS)
    expect(unknown.code).toBe(2)
    expect(unknown.lines[0]).toMatch(/unknown package left-pad/)
    const missing = await cli(['--package', '@project-vault/web-host'], OK_ANSWERS)
    expect(missing.code).toBe(2)
    expect(missing.urls).toEqual([])
  })
})

describe('verify-npm-release: wiring (Story 68.12 AC-5)', () => {
  it('runs its unit test in ci.yml and make ci-inner', () => {
    const command = 'pnpm vitest run scripts/verify-npm-release.test.ts'
    const ci = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(workflowRunCommands(ci)).toContain(command)
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), command)).toBe(true)
  })
})
