import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Story 43.16 Task 1: test-only private PKI, minted at test runtime with the `openssl` CLI. No
 * certificate or key fixture is ever committed (the secrets guard and gitleaks both match
 * `*.pem`/`*.key`). openssl writes its files into a `mkdtemp` directory that `cleanup()` removes;
 * every PEM is read back from openssl's own stdout, never echoed anywhere.
 *
 * `openssl` is resolved from fixed root-owned directories, never through `$PATH` (typescript:S4036,
 * the Story 43.9 AC-4 precedent): the ubuntu CI runners, the CI container (apk `openssl`) and the
 * dev boxes all install it into /usr/bin. If it is missing, `createTestPki()` rejects loudly —
 * tests never skip silently.
 */

const run = promisify(execFile)

/** Root-owned directories searched, in order, for `openssl`. Never user-writable locations. */
export const OPENSSL_SEARCH_DIRS: readonly string[] = ['/usr/bin', '/usr/local/bin', '/bin']

/** The absolute path of `openssl` from `dirs`. There is deliberately no fallback to the bare name,
 * which would bring the `$PATH` lookup back. */
export function resolveOpensslBinary(dirs: readonly string[] = OPENSSL_SEARCH_DIRS): string {
  for (const dir of dirs) {
    const candidate = path.join(dir, 'openssl')
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    return candidate
  }
  throw new Error(`test PKI: openssl not found in ${dirs.join(', ')}`)
}

export type TestPkiLeaf = {
  certPem: string
  keyPem: string
  certB64: string
  keyB64: string
}

export type TestPkiCa = {
  certPem: string
  certB64: string
}

export type TestPkiEku = 'serverAuth' | 'clientAuth'

export type IssueLeafOptions = {
  commonName: string
  eku: TestPkiEku
  /** Certificate lifetime; `0` issues an already-expired certificate (notAfter == notBefore). */
  days?: number
  /** `subjectAltName` value, e.g. `DNS:localhost,IP:127.0.0.1`. */
  subjectAltName?: string
  /** Sign with the unrelated foreign CA instead of the main one. */
  foreign?: boolean
}

export type TestPki = {
  ca: TestPkiCa
  foreignCa: TestPkiCa
  /** serverAuth leaf, SAN localhost + 127.0.0.1 + ::1, 397 days. */
  server: TestPkiLeaf
  /** clientAuth leaf signed by the main CA, 397 days. */
  client: TestPkiLeaf
  /** clientAuth leaf signed by the foreign CA. */
  foreignClient: TestPkiLeaf
  /** serverAuth leaf (SAN localhost) signed by the foreign CA. */
  foreignServer: TestPkiLeaf
  issueLeaf: (options: IssueLeafOptions) => Promise<TestPkiLeaf>
  /** The `mkdtemp` working directory (removed by `cleanup()`). */
  dir: string
  cleanup: () => Promise<void>
}

export const TEST_PKI_SERVER_SAN = 'DNS:localhost,IP:127.0.0.1,IP:::1'

const EC_KEY_ARGS = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes']

function toB64(pem: string): string {
  return Buffer.from(pem, 'utf8').toString('base64')
}

/** Runs openssl and returns its stdout. Never includes stdout/stderr in an error: openssl can
 * print key material on some failure paths. */
async function openssl(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, { encoding: 'utf8' })
    return stdout
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(`test PKI: openssl ${args[0] ?? ''} failed (${String(code ?? 'exit')})`)
  }
}

type CaFiles = { certPath: string; keyPath: string }

async function createCa(
  bin: string,
  dir: string,
  name: string
): Promise<CaFiles & { certPem: string }> {
  const files = { certPath: path.join(dir, `${name}.crt`), keyPath: path.join(dir, `${name}.pk8`) }
  await openssl(bin, [
    'req',
    '-x509',
    ...EC_KEY_ARGS,
    '-keyout',
    files.keyPath,
    '-out',
    files.certPath,
    '-days',
    '825',
    '-subj',
    `/CN=${name}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ])
  return { ...files, certPem: await openssl(bin, ['x509', '-in', files.certPath]) }
}

async function signLeaf(
  bin: string,
  dir: string,
  ca: CaFiles,
  options: IssueLeafOptions
): Promise<TestPkiLeaf> {
  const stem = path.join(dir, `leaf-${randomBytes(8).toString('hex')}`)
  const extensions = [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature',
    `extendedKeyUsage=${options.eku}`,
    ...(options.subjectAltName ? [`subjectAltName=${options.subjectAltName}`] : []),
  ].flatMap((extension) => ['-addext', extension])
  await openssl(bin, [
    'req',
    '-new',
    ...EC_KEY_ARGS,
    '-keyout',
    `${stem}.pk8`,
    '-out',
    `${stem}.csr`,
    '-subj',
    `/CN=${options.commonName}`,
    ...extensions,
  ])
  const certPem = await openssl(bin, [
    'x509',
    '-req',
    '-in',
    `${stem}.csr`,
    '-CA',
    ca.certPath,
    '-CAkey',
    ca.keyPath,
    '-copy_extensions',
    'copyall',
    '-set_serial',
    `0x${randomBytes(16).toString('hex')}`,
    '-days',
    String(options.days ?? 397),
  ])
  const keyPem = await openssl(bin, ['pkey', '-in', `${stem}.pk8`])
  return { certPem, keyPem, certB64: toB64(certPem), keyB64: toB64(keyPem) }
}

export async function createTestPki(
  options: { clientCommonName?: string; opensslSearchDirs?: readonly string[] } = {}
): Promise<TestPki> {
  const bin = resolveOpensslBinary(options.opensslSearchDirs)
  const dir = await mkdtemp(path.join(tmpdir(), 'pv-test-pki-'))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const mainCa = await createCa(bin, dir, 'pv-test-ca')
    const otherCa = await createCa(bin, dir, 'pv-foreign-ca')
    const issueLeaf = (leaf: IssueLeafOptions) =>
      signLeaf(bin, dir, leaf.foreign ? otherCa : mainCa, leaf)
    const [server, client, foreignClient, foreignServer] = await Promise.all([
      issueLeaf({
        commonName: 'localhost',
        eku: 'serverAuth',
        subjectAltName: TEST_PKI_SERVER_SAN,
      }),
      issueLeaf({ commonName: options.clientCommonName ?? 'pv-test-web', eku: 'clientAuth' }),
      issueLeaf({ commonName: 'pv-foreign-client', eku: 'clientAuth', foreign: true }),
      issueLeaf({
        commonName: 'localhost',
        eku: 'serverAuth',
        subjectAltName: TEST_PKI_SERVER_SAN,
        foreign: true,
      }),
    ])
    return {
      ca: { certPem: mainCa.certPem, certB64: toB64(mainCa.certPem) },
      foreignCa: { certPem: otherCa.certPem, certB64: toB64(otherCa.certPem) },
      server,
      client,
      foreignClient,
      foreignServer,
      issueLeaf,
      dir,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
