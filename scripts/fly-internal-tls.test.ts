import { execFileSync, spawnSync } from 'node:child_process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'

// Story 43.16 AC-5: scripts/fly-internal-tls.sh (init-ca / issue-leaves / issue-operator) against
// the real openssl, with flyctl stubbed as an exported bash function that records its argv and,
// for `secrets import`, the NAME=VALUE lines it receives on stdin — on file descriptor 3, a pipe
// the test reads back. Every generated file is inspected through openssl itself (verify via stdin,
// `openssl base64`) or `find -printf`, and all key material is throwaway test PKI.

const SCRIPT = resolve(import.meta.dirname, 'fly-internal-tls.sh')
const LIB = resolve(import.meta.dirname, 'fly-proxy-lib.sh')
const BASH = resolveTrustedExecutable('bash')
const OPENSSL = resolveTrustedExecutable('openssl')
const FIND = resolveTrustedExecutable('find')
const CALL_FD = 3
const FLYCTL_STUB = [
  '() {',
  `  printf 'ARGS %s\\n' "$*" >&${CALL_FD}`,
  '  if [[ "$1" == secrets && "$2" == import ]]; then',
  '    local line',
  `    while IFS= read -r line; do printf 'STDIN %s\\n' "$line" >&${CALL_FD}; done`,
  '  fi',
  '  if [[ -n "${FLYCTL_FAIL_MATCH:-}" && "$*" == *"$FLYCTL_FAIL_MATCH"* ]]; then return 1; fi',
  '  return 0',
  '}',
].join('\n')

const API_APP = 'project-vault-demo-api'
const WEB_APP = 'project-vault-demo-web'
const DB_APP = 'project-vault-demo-db'
const PEM_HEADER = '-----BEGIN'
const CA_CERT_VAR = 'FLY_INTERNAL_CA_CERT_B64'
const CA_KEY_VAR = 'FLY_INTERNAL_CA_KEY_B64'
const CA_FILE = 'ca.crt'
const OPERATOR_CERT_FILE = 'operator.crt'
const ISSUE_LEAVES = 'issue-leaves'
const ISSUE_OPERATOR = 'issue-operator'
const RERUN_MESSAGE =
  're-run scripts/fly-internal-tls.sh before any deploy — staged TLS secrets may be inconsistent across apps'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fly-internal-tls-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Run = {
  status: number | null
  output: string
  calls: string[]
  staged: Map<string, Map<string, string>>
  tmp: string
}

function parseStaged(calls: string[]): Map<string, Map<string, string>> {
  const staged = new Map<string, Map<string, string>>()
  let app: string | undefined
  for (const line of calls) {
    if (line.startsWith('ARGS ')) {
      app = /secrets import --stage -a (\S+)/.exec(line)?.[1]
      if (app && !staged.has(app)) staged.set(app, new Map())
    } else if (line.startsWith('STDIN ') && app) {
      const [name = '', ...rest] = line.slice('STDIN '.length).split('=')
      staged.get(app)?.set(name, rest.join('='))
    }
  }
  return staged
}

function runScript(args: string[], env: Record<string, string> = {}): Run {
  const root = tempRoot()
  const tmp = mkdtempSync(join(root, 'tmp-'))
  const result = spawnSync(BASH, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      TMPDIR: tmp,
      'BASH_FUNC_flyctl%%': FLYCTL_STUB,
      ...env,
    },
  })
  const calls = String(result.output.at(CALL_FD) ?? '')
    .split('\n')
    .filter(Boolean)
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls,
    staged: parseStaged(calls),
    tmp,
  }
}

/** Every entry (mode + path) under a directory, via find — no dynamic fs reads in the test. */
function listing(dir: string): string[] {
  return execFileSync(FIND, [dir, '-mindepth', '1', '-printf', '%m %P\n'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

function b64File(path: string): string {
  return execFileSync(OPENSSL, ['base64', '-A', '-in', path], { encoding: 'utf8' }).trim()
}

function verifiesAgainst(caPath: string, certPem: string): boolean {
  const result = spawnSync(OPENSSL, ['verify', '-CAfile', caPath], {
    input: certPem,
    encoding: 'utf8',
  })
  return result.status === 0
}

const pem = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8')

/** A staged value for `app`, failing the test loudly when it is missing. */
function stagedValue(run: Run, app: string, name: string): string {
  const value = run.staged.get(app)?.get(name)
  if (value === undefined) throw new Error(`${name} was not staged to ${app}`)
  return value
}

const EKU_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const EKU_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

type Ca = {
  dir: string
  certB64: string
  keyB64: string
  env: Record<string, string>
  output: string
}

function initCa(): Ca {
  const dir = join(tempRoot(), 'ca')
  const run = runScript(['init-ca', '--out', dir])
  expect(run.status).toBe(0)
  const certB64 = b64File(join(dir, CA_FILE))
  const keyB64 = b64File(join(dir, 'ca.key'))
  return {
    dir,
    certB64,
    keyB64,
    output: run.output,
    env: { [CA_CERT_VAR]: certB64, [CA_KEY_VAR]: keyB64 },
  }
}

let ca1: Ca
let ca2: Ca
let leaves: Run

beforeAll(() => {
  ca1 = initCa()
  ca2 = initCa()
  leaves = runScript([ISSUE_LEAVES], ca1.env)
})

describe('init-ca', () => {
  it('writes 0600 files in a 0700 dir and prints no PEM', () => {
    expect(
      execFileSync(FIND, [ca1.dir, '-maxdepth', '0', '-printf', '%m'], { encoding: 'utf8' })
    ).toBe('700')
    expect(listing(ca1.dir).sort()).toEqual([
      '600 ca.crt',
      '600 ca.crt.b64',
      '600 ca.key',
      '600 ca.key.b64',
    ])
    expect(ca1.output).not.toContain(PEM_HEADER)
    expect(ca1.output).toContain('notAfter=')
    expect(ca1.output).not.toContain(ca1.keyB64)
  })

  it('refuses a non-empty --out directory', () => {
    const run = runScript(['init-ca', '--out', ca1.dir])
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('is not empty')
  })

  it('rotation: two runs yield two different CAs', () => {
    expect(ca1.certB64).not.toBe(ca2.certB64)
  })
})

describe('issue-leaves', () => {
  it('stages every secret to the right app and nothing to the wrong one', () => {
    expect(leaves.status).toBe(0)
    expect([...leaves.staged.keys()].sort()).toEqual([API_APP, DB_APP, WEB_APP])
    expect([...(leaves.staged.get(API_APP)?.keys() ?? [])].sort()).toEqual([
      'API_TLS_CERT_B64',
      'API_TLS_CLIENT_CA_B64',
      'API_TLS_KEY_B64',
      'DATABASE_TLS_CA_B64',
      'DATABASE_TLS_CLIENT_CERT_B64',
      'DATABASE_TLS_CLIENT_KEY_B64',
    ])
    expect([...(leaves.staged.get(WEB_APP)?.keys() ?? [])].sort()).toEqual([
      'API_TLS_CA_B64',
      'API_TLS_CLIENT_CERT_B64',
      'API_TLS_CLIENT_KEY_B64',
    ])
    expect([...(leaves.staged.get(DB_APP)?.keys() ?? [])].sort()).toEqual([
      'DB_TLS_CERT_B64',
      'DB_TLS_CLIENT_CA_B64',
      'DB_TLS_KEY_B64',
    ])
  })

  it('issues leaves that verify against the CA with the right SANs and EKUs', () => {
    const value = (app: string, name: string) => stagedValue(leaves, app, name)
    const certs = {
      apiServer: pem(value(API_APP, 'API_TLS_CERT_B64')),
      apiDbClient: pem(value(API_APP, 'DATABASE_TLS_CLIENT_CERT_B64')),
      web: pem(value(WEB_APP, 'API_TLS_CLIENT_CERT_B64')),
      db: pem(value(DB_APP, 'DB_TLS_CERT_B64')),
    }
    for (const certPem of Object.values(certs)) {
      expect(verifiesAgainst(join(ca1.dir, CA_FILE), certPem)).toBe(true)
    }
    const apiServer = new X509Certificate(certs.apiServer)
    expect(apiServer.subjectAltName).toBe(`DNS:${API_APP}.internal`)
    expect(apiServer.keyUsage).toEqual([EKU_SERVER_AUTH])
    const webCert = new X509Certificate(certs.web)
    expect(webCert.keyUsage).toEqual([EKU_CLIENT_AUTH])
    expect(webCert.subject).toContain(`CN=${WEB_APP}`)
    const apiDbClient = new X509Certificate(certs.apiDbClient)
    expect(apiDbClient.keyUsage).toEqual([EKU_CLIENT_AUTH])
    expect(apiDbClient.subject).toContain(`CN=${API_APP}`)
    const dbCert = new X509Certificate(certs.db)
    expect(dbCert.subjectAltName).toBe(`DNS:${DB_APP}.internal, DNS:localhost`)
    expect(dbCert.keyUsage).toEqual([EKU_SERVER_AUTH])
  })

  it('issues leaves valid for at most 397 days whose keys match their certs', () => {
    const value = (app: string, name: string) => stagedValue(leaves, app, name)
    const pairs: [string, string][] = [
      [value(API_APP, 'API_TLS_CERT_B64'), value(API_APP, 'API_TLS_KEY_B64')],
      [
        value(API_APP, 'DATABASE_TLS_CLIENT_CERT_B64'),
        value(API_APP, 'DATABASE_TLS_CLIENT_KEY_B64'),
      ],
      [value(WEB_APP, 'API_TLS_CLIENT_CERT_B64'), value(WEB_APP, 'API_TLS_CLIENT_KEY_B64')],
      [value(DB_APP, 'DB_TLS_CERT_B64'), value(DB_APP, 'DB_TLS_KEY_B64')],
    ]
    const maxNotAfter = Date.now() + 397 * 86_400_000 + 60_000
    for (const [certB64, keyB64] of pairs) {
      const cert = new X509Certificate(pem(certB64))
      expect(new Date(cert.validTo).getTime()).toBeLessThanOrEqual(maxNotAfter)
      expect(cert.checkPrivateKey(createPrivateKey(pem(keyB64)))).toBe(true)
    }
  })

  it('stages the CA itself in every CA-bearing secret', () => {
    for (const [app, name] of [
      [API_APP, 'API_TLS_CLIENT_CA_B64'],
      [API_APP, 'DATABASE_TLS_CA_B64'],
      [WEB_APP, 'API_TLS_CA_B64'],
      [DB_APP, 'DB_TLS_CLIENT_CA_B64'],
    ] as const) {
      expect(stagedValue(leaves, app, name)).toBe(ca1.certB64)
    }
  })

  it('never prints PEM bodies or staged values, and prints subjects/SANs/notAfter', () => {
    expect(leaves.output).not.toContain(PEM_HEADER)
    for (const secrets of leaves.staged.values()) {
      for (const value of secrets.values()) expect(leaves.output).not.toContain(value)
    }
    expect(leaves.output).toContain(`DNS:${API_APP}.internal`)
    expect(leaves.output).toContain('notAfter=')
  })

  it('removes its temp dir and leaves no key file behind', () => {
    expect(listing(leaves.tmp)).toEqual([])
  })

  it('rotation: a leaf from CA 1 does not verify against CA 2; re-issuing yields new keys', () => {
    const apiServer = pem(leaves.staged.get(API_APP)?.get('API_TLS_CERT_B64'))
    expect(verifiesAgainst(join(ca2.dir, CA_FILE), apiServer)).toBe(false)
    const again = runScript([ISSUE_LEAVES], ca1.env)
    expect(again.status).toBe(0)
    const againCert = pem(again.staged.get(API_APP)?.get('API_TLS_CERT_B64'))
    expect(verifiesAgainst(join(ca1.dir, CA_FILE), againCert)).toBe(true)
    expect(again.staged.get(API_APP)?.get('API_TLS_KEY_B64')).not.toBe(
      leaves.staged.get(API_APP)?.get('API_TLS_KEY_B64')
    )
  })

  it('without FLY_INTERNAL_CA_KEY_B64 exits before any flyctl call, naming the variable', () => {
    const run = runScript([ISSUE_LEAVES], {
      [CA_CERT_VAR]: ca1.certB64,
    })
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('FLY_INTERNAL_CA_KEY_B64')
    expect(run.calls).toEqual([])
  })

  it('a CA key that does not match the CA cert fails before any flyctl call', () => {
    const run = runScript([ISSUE_LEAVES], {
      [CA_CERT_VAR]: ca1.certB64,
      [CA_KEY_VAR]: ca2.keyB64,
    })
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('FLY_INTERNAL_CA_KEY_B64 does not match FLY_INTERNAL_CA_CERT_B64')
    expect(run.calls).toEqual([])
  })

  it('openssl missing: exits non-zero before any flyctl call', () => {
    const run = runScript([ISSUE_LEAVES], { ...ca1.env, OPENSSL: '/nonexistent/openssl' })
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('openssl not found')
    expect(run.calls).toEqual([])
  })

  it('partial staging failure: exits non-zero with the re-run message and still cleans up', () => {
    const run = runScript([ISSUE_LEAVES], { ...ca1.env, FLYCTL_FAIL_MATCH: `-a ${WEB_APP}` })
    expect(run.status).not.toBe(0)
    expect(run.output).toContain(RERUN_MESSAGE)
    expect(listing(run.tmp)).toEqual([])
  })
})

describe('issue-operator', () => {
  it('mints a 1-day fly-operator clientAuth cert (key 0600) plus the CA into --out', () => {
    const out = mkdtempSync(join(tempRoot(), 'op-'))
    const run = runScript([ISSUE_OPERATOR, '--out', out], ca1.env)
    expect(run.status).toBe(0)
    expect(run.calls).toEqual([])
    expect(listing(out).sort()).toEqual(['600 operator.key', '644 ca.crt', '644 operator.crt'])
    const certPem = execFileSync(OPENSSL, ['x509', '-in', join(out, OPERATOR_CERT_FILE)], {
      encoding: 'utf8',
    })
    expect(verifiesAgainst(join(out, CA_FILE), certPem)).toBe(true)
    const cert = new X509Certificate(certPem)
    expect(cert.subject).toBe('CN=fly-operator')
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2'])
    expect(new Date(cert.validTo).getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000 + 60_000)
    expect(run.output).not.toContain(PEM_HEADER)
    expect(listing(run.tmp)).toEqual([])
  })

  it('requires an existing --out directory', () => {
    const run = runScript([ISSUE_OPERATOR, '--out', join(tempRoot(), 'missing')], ca1.env)
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('does not exist')
  })
})

describe('usage', () => {
  it('rejects an unknown subcommand', () => {
    const run = runScript(['bogus'])
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('usage:')
  })
})

// The operator helpers scripts/fly-migrate.sh and fly-reset.sh share (Decision 6).
describe('fly-proxy-lib.sh operator TLS helpers', () => {
  it('mint into a mktemp dir, build a verify-full psql URL, scope DATABASE_TLS_* to the child, and clean up', () => {
    const program = [
      'set -euo pipefail',
      `source "${LIB}"`,
      // open_fly_db_proxy normally defines cleanup (proxy kill + OP_DIR removal); no proxy here.
      'cleanup() { if [[ -n "${OP_DIR:-}" ]]; then rm -rf "$OP_DIR"; fi; return 0; }',
      `issue_operator_tls "${import.meta.dirname}" >/dev/null`,
      'printf "URL %s\\n" "$(operator_psql_url postgres pw 15432)"',
      'with_operator_tls bash -c \'printf "CHILD %s %s %s\\n" "${#DATABASE_TLS_CA_B64}" "${#DATABASE_TLS_CLIENT_CERT_B64}" "${#DATABASE_TLS_CLIENT_KEY_B64}"\'',
      'printf "PARENT %s\\n" "${DATABASE_TLS_CA_B64:-unset}"',
      'printf "OPDIR %s\\n" "$OP_DIR"',
      'cleanup',
      'if [[ -e "$OP_DIR" ]]; then echo LEFTOVER; fi',
    ].join('\n')
    const root = tempRoot()
    const result = spawnSync(BASH, ['-c', program], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        TMPDIR: mkdtempSync(join(root, 'tmp-')),
        ...ca1.env,
      },
    })
    expect(result.status).toBe(0)
    const opDir = /OPDIR (\S+)/.exec(result.stdout)?.[1] ?? ''
    expect(result.stdout).toContain(
      `URL postgresql://postgres:pw@localhost:15432/project_vault?sslmode=verify-full&sslrootcert=${opDir}/ca.crt&sslcert=${opDir}/operator.crt&sslkey=${opDir}/operator.key`
    )
    const [, caLen, certLen, keyLen] = /CHILD (\d+) (\d+) (\d+)/.exec(result.stdout) ?? []
    for (const length of [caLen, certLen, keyLen]) expect(Number(length)).toBeGreaterThan(100)
    expect(result.stdout).toContain('PARENT unset')
    expect(result.stdout).not.toContain('LEFTOVER')
    expect(result.stdout).not.toContain(PEM_HEADER)
  })
})
