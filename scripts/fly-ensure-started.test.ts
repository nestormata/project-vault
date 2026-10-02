import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'

// Story 43.28 AC-4: scripts/fly-ensure-started.sh starts an app's stopped Fly machines, waits until
// every non-destroyed machine is `started` and, given a web URL, until /ready stops reporting
// api_unreachable. `flyctl` and `curl` are stubbed as exported bash functions (inherited by the
// script's bash) that record each call on fd 3. Each `machine list` answers the next scripted JSON
// document (STUB_LIST_<n>, then STUB_LIST_LAST); a counter file in a temp dir carries n across the
// script's subshells. jq is the real one, as on the GitHub runner.

const SCRIPT = resolve(import.meta.dirname, 'fly-ensure-started.sh')
const BASH = resolveTrustedExecutable('bash')
const CALL_FD = 3
const APP = 'project-vault-demo-api'
const WEB_URL = 'https://project-vault-demo-web.fly.dev'
const TOKEN = 'token-test-value'
const LIST_CALL = `machine list -a ${APP} --json`

const FLYCTL_STUB = `() {
  printf '%s\\n' "$*" >&${CALL_FD}
  if [[ "$1 $2" == "machine list" ]]; then
    local n=0
    [[ -f "$STUB_DIR/n" ]] && n="$(<"$STUB_DIR/n")"
    n=$((n + 1)); printf '%s' "$n" >"$STUB_DIR/n"
    local var="STUB_LIST_$n"
    [[ -n "\${!var+x}" ]] || var=STUB_LIST_LAST
    printf '%s\\n' "\${!var}"
  elif [[ "$1 $2" == "machine start" && -n "\${STUB_START_FAILS:-}" ]]; then
    return 1
  fi
  return 0
}`
// Mirrors `curl -s --max-time N -w '\\n%{http_code}' <url>`: the body, a newline, the status.
const CURL_STUB = `() {
  printf 'curl %s\\n' "\${@: -1}" >&${CALL_FD}
  printf '%s\\n%s' "$STUB_READY_BODY" "$STUB_READY_CODE"
}`

type Machine = { id: string; state: string }
type Scenario = {
  lists: Array<Machine[] | string>
  args?: string[]
  startFails?: boolean
  ready?: { body: string; code: string }
  timeoutS?: string
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run({ lists, args = [APP], startFails, ready, timeoutS = '5' }: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'fly-ensure-started-'))
  roots.push(dir)
  const listEnv: Record<string, string> = {}
  lists.forEach((list, i) => {
    const text = typeof list === 'string' ? list : JSON.stringify(list)
    listEnv[`STUB_LIST_${i + 1}`] = text
    if (i === lists.length - 1) listEnv['STUB_LIST_LAST'] = text
  })
  const result = spawnSync(BASH, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: dir,
      STUB_DIR: dir,
      ...listEnv,
      ...(startFails ? { STUB_START_FAILS: '1' } : {}),
      STUB_READY_BODY: ready?.body ?? '',
      STUB_READY_CODE: ready?.code ?? '000',
      FLY_API_TOKEN: TOKEN,
      FLY_MACHINE_START_TIMEOUT_S: timeoutS,
      FLY_MACHINE_POLL_INTERVAL_S: '0',
      'BASH_FUNC_flyctl%%': FLYCTL_STUB,
      'BASH_FUNC_curl%%': CURL_STUB,
    },
  })
  const calls = String(result.output.at(CALL_FD) ?? '')
    .split('\n')
    .filter(Boolean)
  const flyctl = calls.filter((call) => !call.startsWith('curl '))
  const curl = calls.filter((call) => call.startsWith('curl '))
  expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, flyctl, curl }
}

const started = (id: string): Machine => ({ id, state: 'started' })
const stopped = (id: string): Machine => ({ id, state: 'stopped' })

describe('fly-ensure-started.sh (Story 43.28 AC-4)', () => {
  it('starts a stopped machine, re-polls until all are started, and says so', () => {
    const r = run({
      lists: [
        [stopped('m1'), started('m2')],
        [started('m1'), started('m2')],
      ],
    })
    expect(r.status).toBe(0)
    expect(r.flyctl).toEqual([LIST_CALL, `machine start m1 -a ${APP}`, LIST_CALL])
    expect(r.stdout).toContain(`== ${APP}: starting stopped machine m1 ==`)
    expect(r.stdout).toContain(`== ${APP}: all 2 machines started ==`)
  })

  it('also starts a suspended machine', () => {
    const r = run({ lists: [[{ id: 'm1', state: 'suspended' }], [started('m1')]] })
    expect(r.status).toBe(0)
    expect(r.flyctl).toContain(`machine start m1 -a ${APP}`)
  })

  it('all started: one list, no start', () => {
    const r = run({ lists: [[started('m1'), started('m2')]] })
    expect(r.status).toBe(0)
    expect(r.flyctl).toEqual([LIST_CALL])
    expect(r.stdout).toContain(`== ${APP}: all 2 machines started ==`)
  })

  it.each([
    ['an empty list', []],
    ['only destroyed machines', [{ id: 'm9', state: 'destroyed' }]],
  ])('%s fails: a deploy that left no machines is not a pass', (_label, list) => {
    const r = run({ lists: [list] })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`no machines for ${APP}`)
  })

  it('a failing machine start fails, naming the machine, without claiming success', () => {
    const r = run({ lists: [[stopped('m1')]], startFails: true })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('m1')
    expect(r.stdout).not.toContain('machines started')
  })

  it('never reaching started within the timeout fails, naming the ids', () => {
    const r = run({ lists: [[stopped('m1'), stopped('m2')]], timeoutS: '0' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(new RegExp(`${APP}.*m1 m2`))
    expect(r.flyctl.filter((call) => call.startsWith('machine start'))).toEqual([
      `machine start m1 -a ${APP}`,
      `machine start m2 -a ${APP}`,
    ])
    expect(r.stdout).not.toContain('machines started')
  })

  it.each([['not json at all'], ['{"id":"m1","state":"stopped"}']])(
    'malformed machine list %s fails loudly instead of meaning "nothing stopped"',
    (list) => {
      const r = run({ lists: [list] })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(`could not parse machine list for ${APP}`)
      expect(r.flyctl).toEqual([LIST_CALL])
    }
  )

  it('polls transitional machines without starting them, and ignores destroyed ones', () => {
    const r = run({
      lists: [
        [
          { id: 'm1', state: 'starting' },
          { id: 'm2', state: 'replacing' },
          { id: 'm3', state: 'created' },
          { id: 'm4', state: 'destroyed' },
          { id: 'm5', state: 'destroying' },
        ],
        [started('m1'), started('m2'), started('m3'), { id: 'm4', state: 'destroyed' }],
      ],
    })
    expect(r.status).toBe(0)
    expect(r.flyctl.filter((call) => call.startsWith('machine start'))).toEqual([])
    expect(r.stdout).toContain(`== ${APP}: all 3 machines started ==`)
  })

  it('rejects a missing app argument before any flyctl call', () => {
    const r = run({ lists: [[started('m1')]], args: [] })
    expect(r.status).not.toBe(0)
    expect(r.flyctl).toEqual([])
  })

  describe('with a web URL: waits for /ready to stop reporting api_unreachable', () => {
    const args = [APP, WEB_URL]

    it('a 200 succeeds', () => {
      const r = run({
        lists: [[started('m1')]],
        args,
        ready: { body: '{"status":"ok"}', code: '200' },
      })
      expect(r.status).toBe(0)
      expect(r.curl).toEqual([`curl ${WEB_URL}/ready`])
      expect(r.stdout).toContain(`== ${APP}: reachable via ${WEB_URL}/ready ==`)
    })

    it('a sealed vault (503 JSON without api_unreachable) succeeds', () => {
      const body = '{"status":"not_ready","reason":"sealed"}'
      const r = run({ lists: [[started('m1')]], args, ready: { body, code: '503' } })
      expect(r.status).toBe(0)
    })

    it.each([
      ['api_unreachable', '{"status":"not_ready","reason":"api_unreachable"}', '503'],
      ['an HTML 502 from the Fly edge', '<html><body>502 Bad Gateway</body></html>', '502'],
      ['an empty body', '', '000'],
    ])('%s until the timeout fails with the never-reachable message', (_label, body, code) => {
      const r = run({ lists: [[started('m1')]], args, ready: { body, code }, timeoutS: '0' })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(`api never became reachable via ${WEB_URL}/ready`)
      expect(r.stderr).not.toContain('parse error')
    })

    it('does not poll /ready when the machines never started', () => {
      const r = run({ lists: [[stopped('m1')]], args, timeoutS: '0' })
      expect(r.status).not.toBe(0)
      expect(r.curl).toEqual([])
    })
  })
})
