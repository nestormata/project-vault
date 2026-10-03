// Story 68.12 AC-5: a read-only, repeatable proof that a @project-vault npm release is what the
// release workflow should have published.
//
//   pnpm exec tsx scripts/verify-npm-release.ts --package @project-vault/web-host \
//     --version X.Y.Z --tag vX.Y.Z --expect-dist-tag next [--wait 600]
//
// It reads https://registry.npmjs.org/ only (an attestation URL on any other host, or any HTTP
// redirect, is a FAIL, never followed) and checks: the version exists; the dist-tag points at it; it is not deprecated; it has
// an SLSA provenance v1 attestation whose statement names this repository, the package's release
// workflow and refs/tags/<tag>, whose subject is the version's purl, and whose sha512 digest equals
// the tarball's dist.integrity. One `ok`/`FAIL` line per check; exit 0 only if all pass, 2 on a
// usage error.
//
// Scope limit: this checks registry metadata and the attestation's claims, NOT the Sigstore
// signature. The cryptographic check is `npm audit signatures` in a project that installed the
// exact version (docs/releasing.md § 9).
import { Buffer } from 'node:buffer'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const REGISTRY = 'https://registry.npmjs.org/'
const SLSA_V1 = 'https://slsa.dev/provenance/v1'
const REPOSITORY = 'https://github.com/nestormata/project-vault'
const POLL_MS = 30_000
const TIMEOUT_MS = 15_000
const LAG_CHECKS = new Set(['version exists', 'dist-tag'])

/** Which workflow file may have published each package. */
export const RELEASE_WORKFLOWS: ReadonlyMap<string, string> = new Map([
  ['@project-vault/web-host', '.github/workflows/web-host-release.yml'],
  ['@project-vault/composition-kit', '.github/workflows/web-host-release.yml'],
  ['@project-vault/extension-api', '.github/workflows/extension-api-release.yml'],
])

export interface Expectations {
  packageName: string
  version: string
  tag: string
  distTag: string
}

export interface VersionEntry {
  deprecated?: string
  dist?: {
    integrity?: string
    attestations?: { url?: string; provenance?: { predicateType?: string } }
  }
}

export interface Packument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, VersionEntry>
}

export interface Statement {
  subject?: { name?: string; digest?: { sha512?: string } }[]
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { repository?: string; path?: string; ref?: string } }
    }
  }
}

export interface Provenance {
  statement?: Statement
  error?: string
}

export interface Check {
  ok: boolean
  name: string
  detail: string
}

const check = (ok: boolean, name: string, detail: string): Check => ({ ok, name, detail })

/** The decoded in-toto statement of the SLSA provenance entry of an attestations response. */
export function provenanceStatement(response: unknown): Statement {
  const entries = (response as { attestations?: unknown[] } | null)?.attestations ?? []
  const entry = entries.find(
    (candidate) => (candidate as { predicateType?: string }).predicateType === SLSA_V1
  ) as { bundle?: { dsseEnvelope?: { payload?: unknown } } } | undefined
  if (entry === undefined) throw new Error('no SLSA provenance entry in the attestations response')
  const payload = entry.bundle?.dsseEnvelope?.payload
  try {
    if (typeof payload !== 'string') throw new TypeError('payload is not a string')
    const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown
    if (typeof statement !== 'object' || statement === null) throw new TypeError('not an object')
    return statement as Statement
  } catch (error) {
    throw new Error(`malformed attestation bundle (${(error as Error).message})`)
  }
}

/** npm's `sha512-<base64>` integrity as the lowercase hex an in-toto subject digest uses. */
function integrityHex(integrity: string | undefined): string | undefined {
  return integrity?.startsWith('sha512-') === true
    ? Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
    : undefined
}

/** A record's value by key, without indexing an object by a runtime string. */
function lookup<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return new Map(Object.entries(record ?? {})).get(key)
}

/** The attestation's claims, flattened (every field may be missing in a hostile statement). */
function claimsOf(statement: Statement): Record<string, string | undefined> {
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {}
  const subject = statement.subject?.[0] ?? {}
  return { ...workflow, subject: subject.name, digest: subject.digest?.sha512 }
}

/** The checks on the attestation's claims: repository, workflow file, tag, subject and digest. */
function statementChecks(
  statement: Statement,
  entry: VersionEntry,
  expected: Expectations
): Check[] {
  const { repository, path, ref, subject, digest } = claimsOf(statement)
  const purl = `pkg:npm/${expected.packageName.replace('@', '%40')}@${expected.version}`
  const integrity = integrityHex(entry.dist?.integrity)
  const digestMatches = integrity !== undefined && digest === integrity
  return [
    check(repository === REPOSITORY, 'provenance repository', `${repository}`),
    check(path === RELEASE_WORKFLOWS.get(expected.packageName), 'provenance workflow', `${path}`),
    check(ref === `refs/tags/${expected.tag}`, 'provenance ref', `${ref}`),
    check(subject === purl, 'provenance subject', `${subject}`),
    check(
      digestMatches,
      'provenance digest',
      digestMatches ? 'sha512 matches dist.integrity' : 'sha512 does not match dist.integrity'
    ),
  ]
}

/** The version is not deprecated and carries an SLSA provenance v1 attestation. */
function versionChecks(entry: VersionEntry, provenance: Provenance): Check[] {
  const predicateType = entry.dist?.attestations?.provenance?.predicateType ?? 'missing'
  return [
    check(entry.deprecated === undefined, 'not deprecated', entry.deprecated ?? 'not deprecated'),
    check(
      provenance.error === undefined && predicateType === SLSA_V1,
      'provenance attestation',
      provenance.error ?? `predicateType ${predicateType}`
    ),
  ]
}

/** Every check for one version, from the packument and the decoded provenance statement. */
export function evaluateRelease(
  packument: Packument,
  provenance: Provenance,
  expected: Expectations
): Check[] {
  const { packageName, version, distTag } = expected
  const entry = lookup(packument.versions, version)
  const tagged = lookup(packument['dist-tags'], distTag) ?? 'unset'
  const checks = [
    check(entry !== undefined, 'version exists', `${packageName}@${version}`),
    check(tagged === version, 'dist-tag', `${distTag} is ${tagged}, expected ${version}`),
  ]
  if (entry === undefined) return checks
  checks.push(...versionChecks(entry, provenance))
  return provenance.statement === undefined
    ? checks
    : [...checks, ...statementChecks(provenance.statement, entry, expected)]
}

type Fetched = { ok: true; value: unknown } | { ok: false; error: string }

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Fetched> {
  if (!url.startsWith(REGISTRY))
    return { ok: false, error: `${url} is not on ${REGISTRY}; not followed` }
  let response: Response
  let body: string
  try {
    // A redirect is an error, never followed: it could lead off registry.npmjs.org.
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    // The timeout signal also covers reading the body, so it is read inside this try.
    body = response.ok ? await response.text() : ''
  } catch (error) {
    const name = (error as Error).name
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      ok: false,
      error: timedOut ? `${url} timed out after 15 s` : `${url}: ${String(error)}`,
    }
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status} from ${url}` }
  try {
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch {
    return { ok: false, error: `the body from ${url} is not JSON` }
  }
}

async function provenanceOf(url: string | undefined, fetchImpl: typeof fetch): Promise<Provenance> {
  if (url === undefined) return { error: 'no provenance attestation' }
  const fetched = await fetchJson(url, fetchImpl)
  if (!fetched.ok) return { error: fetched.error }
  try {
    return { statement: provenanceStatement(fetched.value) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function collect(expected: Expectations, fetchImpl: typeof fetch): Promise<Check[]> {
  const fetched = await fetchJson(
    `${REGISTRY}${expected.packageName.replace('/', '%2f')}`,
    fetchImpl
  )
  if (!fetched.ok) return [check(false, 'packument', fetched.error)]
  const packument = fetched.value as Packument
  const url = lookup(packument.versions, expected.version)?.dist?.attestations?.url
  return evaluateRelease(packument, await provenanceOf(url, fetchImpl), expected)
}

export interface CliDeps {
  fetch: typeof fetch
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

/** Polls (recursively, every 30 s) while only the version or the dist-tag is missing. */
async function poll(expected: Expectations, deps: CliDeps, remainingMs: number): Promise<Check[]> {
  const checks = await collect(expected, deps.fetch)
  const failing = checks.filter((item) => !item.ok)
  const lagging = failing.length > 0 && failing.every((item) => LAG_CHECKS.has(item.name))
  if (!lagging || remainingMs < POLL_MS) return checks
  deps.log('registry not updated yet (npm processing lag, see docs/releasing.md § 9)')
  await deps.sleep(POLL_MS)
  return poll(expected, deps, remainingMs - POLL_MS)
}

const USAGE =
  'usage: verify-npm-release.ts --package <name> --version X.Y.Z --tag <git tag> --expect-dist-tag <dist-tag> [--wait <seconds>]'

/** The expectations and wait from argv, or the usage error to print. */
function parseCli(argv: string[]): { expected: Expectations; waitMs: number } | string {
  const options = { type: 'string' } as const
  const { values } = parseArgs({
    args: argv,
    options: {
      package: options,
      version: options,
      tag: options,
      'expect-dist-tag': options,
      wait: options,
    },
  })
  const { package: packageName, version, tag, 'expect-dist-tag': distTag, wait = '0' } = values
  if (!packageName || !version || !tag || !distTag) return USAGE
  if (!RELEASE_WORKFLOWS.has(packageName)) {
    return `usage error: unknown package ${packageName} (known: ${[...RELEASE_WORKFLOWS.keys()].join(', ')})`
  }
  const waitSeconds = Number(wait)
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0)
    return `usage error: --wait ${wait} is not whole seconds`
  return { expected: { packageName, version, tag, distTag }, waitMs: waitSeconds * 1000 }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseCli>
  try {
    parsed = parseCli(argv)
  } catch (error) {
    parsed = `usage error: ${(error as Error).message}`
  }
  if (typeof parsed === 'string') {
    deps.log(parsed)
    return 2
  }
  const checks = await poll(parsed.expected, deps, parsed.waitMs)
  for (const item of checks) deps.log(`${item.ok ? 'ok' : 'FAIL'} ${item.name}: ${item.detail}`)
  return checks.every((item) => item.ok) ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  // No top-level await: the root package is CommonJS for tsx.
  runCli(process.argv.slice(2), { fetch, log: (line) => process.stdout.write(`${line}\n`), sleep })
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`FAIL unexpected error: ${String(error)}\n`)
      process.exitCode = 1
    })
}
