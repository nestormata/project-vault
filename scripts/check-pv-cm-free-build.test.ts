// Story 68.10 AC-9: PV's own CM-free build is the control group. It builds apps/web exactly as
// `apps/web/Dockerfile` does (`vite build`, no pack) and asserts (a) every `virtual:pv-*` module of
// the BUILT server output is empty and every registered injection point has its empty module,
// (b) PV's own built server answers the committed `main` snapshot (status, location, security
// headers, set-cookie) with the same request list as the packed-consumer recording, and (d) the
// route-render oracle is referenced, not rewritten (it is `route-render-snapshot.test.ts`, run in
// the web package). The native-nav snapshot (c) needs story 68-7 (nav as data) on main.
//
// Option chosen for (b): `node build/index.js` from the freshly built `apps/web/build` with the
// fixture API stub, the cheapest of the two options of the story (no second Docker image).
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readRegistry } from './lib/injection-point-coverage.js'
import {
  PV_RESPONSE_CASES,
  diffResponseSnapshots,
  emptyPointNames,
  emptyVirtualModuleProblems,
  recordedResponseOf,
  virtualRegions,
  type RecordedResponse,
  type ResponseSnapshot,
} from './lib/pv-cm-free-build.js'
import { readOverlayFile, walkFiles } from './lib/scan-utils.js'
import { resolveBin } from './lib/trusted-executable.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(repositoryRoot, 'apps/web')
const BUILD = join(WEB, 'build')
const STUB = join(repositoryRoot, 'scripts/web-host-consumer-fixture/api-stub.mjs')
// The committed `main` snapshot, read through Vite (no dynamic fs path in the test).
const EXPECTED_SNAPSHOT: Record<string, string> = import.meta.glob(
  './web-host-consumer-fixture/pv-responses.main.json',
  { query: '?raw', import: 'default', eager: true }
)
const BUILD_TIMEOUT_MS = 10 * 60_000
const SHELL_HEAD = 'virtual:pv-inject/shell.head'
const SERVER_HOOKS = 'virtual:pv-hooks/server'
const REGION = (id: string, body: string) => `//#region \\0${id}\n${body}\n//#endregion\n`

describe('control group self-tests: a deliberate change turns the check red (AC-9)', () => {
  const clean = {
    'a.js': [
      REGION(SHELL_HEAD, 'var shell_head_default = [];'),
      REGION(
        'virtual:pv-inject-behavior',
        'var loads = Object.freeze(Object.create(null));\nvar actions = Object.freeze(Object.create(null));'
      ),
      REGION('virtual:pv-hooks/client', 'var hooks = Object.freeze({});'),
      REGION(
        SERVER_HOOKS,
        'var hooks$1 = Object.freeze({});\nvar protectedPaths = Object.freeze({\n\trouteIds: [],\n\tadd: [],\n\tremove: []\n});'
      ),
    ].join(''),
  }

  it('accepts empty providers', () => {
    expect(emptyVirtualModuleProblems(clean)).toEqual([])
    expect(virtualRegions(clean)).toHaveLength(4)
    expect(emptyPointNames(clean)).toEqual(['shell.head'])
  })

  it('names a non-empty injection provider', () => {
    const problems = emptyVirtualModuleProblems({
      'a.js': REGION(SHELL_HEAD, 'var shell_head_default = [{ id: "x" }];'),
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("virtual:pv-inject/shell.head is not empty in PV's own build")
  })

  it('names a non-empty hooks provider and protected path', () => {
    const problems = emptyVirtualModuleProblems({
      'a.js': REGION(
        SERVER_HOOKS,
        'var hooks = Object.freeze({});\nvar protectedPaths = Object.freeze({ routeIds: ["/x"], add: [], remove: [] });'
      ),
    })
    expect(problems).toHaveLength(1)
  })

  it('names an unknown virtual module and an unresolved virtual import', () => {
    expect(
      emptyVirtualModuleProblems({ 'a.js': REGION('virtual:pv-extra/thing', 'var x = [];') })
    ).toEqual(['a.js: unknown virtual module virtual:pv-extra/thing'])
    expect(
      emptyVirtualModuleProblems({ 'b.js': "import x from 'virtual:pv-inject/a.b.c'" })
    ).toEqual(['b.js: unresolved virtual import virtual:pv-inject/a.b.c'])
  })

  const snapshot = (): ResponseSnapshot => ({
    kitDefaultErrorLogged: true,
    responses: {
      login: {
        status: 200,
        headers: { 'x-frame-options': 'DENY' },
        setCookie: [],
      },
    },
  })

  it('reports an added header, a changed status, a cookie and a lost log line by name', () => {
    expect(diffResponseSnapshots(snapshot(), snapshot())).toEqual([])
    const mutated = snapshot()
    const login = mutated.responses.login
    if (login === undefined) throw new Error('fixture')
    login.headers['permissions-policy'] = 'camera=()'
    login.status = 500
    login.setCookie = ['a=b']
    mutated.kitDefaultErrorLogged = false
    expect(diffResponseSnapshots(snapshot(), mutated)).toEqual([
      'login: status 500, expected 200',
      'login: header permissions-policy is "camera=()", expected null',
      'login: set-cookie differs',
      'kitDefaultErrorLogged is false',
    ])
  })

  it('keeps only the snapshot headers when recording', () => {
    const headers = new Headers({ 'x-frame-options': 'DENY', date: 'now', location: '/login' })
    expect(recordedResponseOf(303, headers, [])).toEqual({
      status: 303,
      headers: { location: '/login', 'x-frame-options': 'DENY' },
      setCookie: [],
    })
  })

  it('covers the same 13 requests as the packed-consumer recording', () => {
    const snapshot = JSON.parse(Object.values(EXPECTED_SNAPSHOT)[0] ?? '') as ResponseSnapshot
    expect(PV_RESPONSE_CASES.map((entry) => entry.split(' ')[0]).toSorted()).toEqual(
      Object.keys(snapshot.responses).toSorted()
    )
  })
})

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    let output = ''
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun()
      else
        reject(
          new Error(
            `vite build exited ${code}. Build prerequisites: pnpm turbo build --filter=@project-vault/web-host\n${output.slice(-1500)}`
          )
        )
    })
  })
}

/** Every file of the built output with `suffix`, path relative to the build directory -> text. The
 * walk and the read go through the repository's shared scan helpers (the one place that touches
 * the filesystem), and an unreadable file fails the test instead of reading as empty. */
function readTree(dir: string, suffix: string): Record<string, string> {
  const files = walkFiles(dir, (file) => file.endsWith(suffix))
  return Object.fromEntries(
    files.map((file) => {
      const text = readOverlayFile(dir, file)
      if (text === undefined) throw new Error(`cannot read the built file ${file}`)
      return [file.slice(BUILD.length + 1), text]
    })
  )
}

const children: ChildProcess[] = []
let serverOutput = ''
let serverPort = 0
let apiPort = 0
let serverFiles: Record<string, string> = {}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`the built server never answered on ${port}: ${serverOutput.slice(-1000)}`)
}

beforeAll(async () => {
  const vite = resolveBin('vite', 'vite', WEB)
  await run(process.execPath, [vite, 'build'], WEB)
  serverFiles = readTree(join(BUILD, 'server'), '.js')
  apiPort = await freePort()
  serverPort = await freePort()
  children.push(spawn(process.execPath, [STUB, String(apiPort)], { stdio: 'ignore' }))
  const server = spawn(process.execPath, ['build/index.js'], {
    cwd: WEB,
    env: {
      HOME: process.env.HOME ?? '/tmp',
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      ORIGIN: `http://127.0.0.1:${serverPort}`,
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))
  children.push(server)
  await waitForServer(serverPort)
}, BUILD_TIMEOUT_MS)

afterAll(() => {
  for (const child of children) child.kill('SIGTERM')
})

describe("PV's own CM-free build is the control group (Story 68.10 AC-9)", () => {
  it('(a) every virtual module of the built server output is empty', () => {
    expect(Object.keys(serverFiles).length).toBeGreaterThan(10)
    expect(emptyVirtualModuleProblems(serverFiles)).toEqual([])
  })

  it('(a) the built output holds the empty module of every registered injection point', () => {
    const registered = [...(readRegistry(WEB)?.keys() ?? [])].toSorted()
    expect(registered.length).toBeGreaterThan(50)
    expect(emptyPointNames(serverFiles)).toEqual(registered)
    const ids = new Set(virtualRegions(serverFiles).map((region) => region.id))
    for (const id of [SERVER_HOOKS, 'virtual:pv-hooks/universal', 'virtual:pv-inject-behavior']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it("(b) the responses of PV's own built server equal the main snapshot", async () => {
    const expected = JSON.parse(Object.values(EXPECTED_SNAPSHOT)[0] ?? '') as ResponseSnapshot
    const recorded: [string, RecordedResponse][] = []
    for (const entry of PV_RESPONSE_CASES) {
      const [name = '', method = 'GET', path = '/', cookie = '-', vault = 'ready'] =
        entry.split(' ')
      await fetch(`http://127.0.0.1:${apiPort}/__fixture/vault/${vault}`)
      const headers: Record<string, string> = {
        origin: `http://127.0.0.1:${serverPort}`,
        'content-type': 'application/x-www-form-urlencoded',
      }
      if (cookie !== '-') headers.cookie = cookie
      const response = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
        method,
        headers,
        redirect: 'manual',
      })
      await response.arrayBuffer()
      recorded.push([
        name,
        recordedResponseOf(response.status, response.headers, response.headers.getSetCookie()),
      ])
    }
    await fetch(`http://127.0.0.1:${apiPort}/__fixture/vault/ready`)
    await new Promise((r) => setTimeout(r, 500))
    const actual: ResponseSnapshot = {
      responses: Object.fromEntries(recorded),
      kitDefaultErrorLogged: serverOutput.includes('[404] GET /nonexistent'),
    }
    expect(diffResponseSnapshots(expected, actual)).toEqual([])
  })
})
