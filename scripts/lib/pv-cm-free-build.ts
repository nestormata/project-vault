// Story 68.10 AC-9: PV's own CM-free build is the control group. Pure helpers (so the self-tests can
// feed them mutated input) for the two assertions that make "every mechanism is a no-op in PV's own
// build" a tested statement: the virtual modules of the BUILT server output are empty, and the
// responses of PV's own built server equal the committed snapshot taken from `main`.

/** One rolled-up module of the bundler's output is introduced by `//#region <id>` and closed by
 * `//#endregion`; the bundler prints the NUL of a virtual id as the two characters backslash-zero. */
const REGION_OPEN = /^\/\/#region (?:\\0|\0)?(virtual:pv-[^\s]+)\s*$/
const REGION_CLOSE = '//#endregion'

// The bundler may hoist an unrelated shared declaration into the same region (`var SvelteMap =
// globalThis.Map;`), so each shape pins the module's own leading statements, not the region's end.
const EMPTY_POINT = /^var [\w$]+ = \[\];/
const EMPTY_BEHAVIOR =
  /^var loads[\w$]* = Object\.freeze\(Object\.create\(null\)\); var actions[\w$]* = Object\.freeze\(Object\.create\(null\)\);/
const EMPTY_HOOKS = /^var hooks[\w$]* = Object\.freeze\(\{\}\);/
// Story 68.7: PV's own nav delta is the empty object (identity: PV's nav renders unchanged).
const EMPTY_NAV = /^var _virtual_pv_nav_default = \{\};$/
const EMPTY_SERVER_HOOKS =
  /^var hooks[\w$]* = Object\.freeze\(\{\}\); var protectedPaths[\w$]* = Object\.freeze\(\{ routeIds: \[\], add: \[\], remove: \[\] \}\);/

const POINT_PREFIX = 'virtual:pv-inject/'
const BEHAVIOR_ID = 'virtual:pv-inject-behavior'
const HOOKS_PREFIX = 'virtual:pv-hooks/'
const NAV_ID = 'virtual:pv-nav'

export interface VirtualRegion {
  id: string
  file: string
  body: string
}

/** Every `virtual:pv-*` region of the given files (path -> text), with its body on one line. */
export function virtualRegions(files: Readonly<Record<string, string>>): VirtualRegion[] {
  const found: VirtualRegion[] = []
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const id = REGION_OPEN.exec(line)?.[1]
      if (id === undefined) continue
      const rest = lines.slice(index + 1)
      const close = rest.indexOf(REGION_CLOSE)
      const inner = close === -1 ? rest : rest.slice(0, close)
      const body = inner.map((text) => text.trim()).filter((text) => text !== '')
      found.push({ id, file, body: body.join(' ') })
    }
  }
  return found
}

function expectedShape(id: string): RegExp | null {
  if (id === BEHAVIOR_ID) return EMPTY_BEHAVIOR
  if (id === NAV_ID) return EMPTY_NAV
  if (id.startsWith(POINT_PREFIX)) return EMPTY_POINT
  if (id === `${HOOKS_PREFIX}server`) return EMPTY_SERVER_HOOKS
  if (id === `${HOOKS_PREFIX}universal` || id === `${HOOKS_PREFIX}client`) return EMPTY_HOOKS
  return null
}

/** Problems with the virtual modules of a CM-free build: a non-empty provider, an unknown virtual
 * id, an unresolved `virtual:pv-` import left in the output. Empty means every one is a no-op. */
export function emptyVirtualModuleProblems(files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = []
  const regions = virtualRegions(files)
  for (const region of regions) {
    const shape = expectedShape(region.id)
    if (shape === null) problems.push(`${region.file}: unknown virtual module ${region.id}`)
    else if (!shape.test(region.body)) {
      problems.push(`${region.file}: ${region.id} is not empty in PV's own build: ${region.body}`)
    }
  }
  const regionIds = new Set(regions.map((region) => region.id))
  for (const [file, text] of Object.entries(files)) {
    for (const match of text.matchAll(/['"`](?:\\0|\0)?(virtual:pv-[^'"`\s]+)['"`]/g)) {
      const id = match[1] ?? ''
      if (!regionIds.has(id)) problems.push(`${file}: unresolved virtual import ${id}`)
    }
  }
  return problems.toSorted((a, b) => a.localeCompare(b))
}

/** The injection point names whose empty module is in the output. */
export function emptyPointNames(files: Readonly<Record<string, string>>): string[] {
  return [
    ...new Set(
      virtualRegions(files)
        .map((region) => region.id)
        .filter((id) => id.startsWith(POINT_PREFIX))
        .map((id) => id.slice(POINT_PREFIX.length))
    ),
  ].toSorted((a, b) => a.localeCompare(b))
}

// --- response snapshot -------------------------------------------------------------------------

export interface RecordedResponse {
  status: number
  headers: Record<string, string>
  setCookie: string[]
}

export interface ResponseSnapshot {
  responses: Record<string, RecordedResponse>
  kitDefaultErrorLogged: boolean
}

/** The same request list `scripts/web-host-consumer-fixture/pv-responses.sh` records: <name> <method>
 * <path> <cookie> <vault-state>. */
export const PV_RESPONSE_CASES: readonly string[] = [
  'login-anonymous GET /login - ready',
  'register-anonymous GET /register - ready',
  'status-public GET /status/abc - ready',
  'handoff-anonymous GET /handoff - ready',
  'dashboard-anonymous GET /dashboard - ready',
  'dashboard-session-expired GET /dashboard refresh-token=dead ready',
  'dashboard-authenticated-data GET /dashboard/__data.json session=ok ready',
  'login-authenticated GET /login session=ok ready',
  'panel-anonymous GET /extensions/panels/group - ready',
  'panel-authenticated GET /extensions/panels/group session=ok ready',
  'settings-action-anonymous POST /settings - ready',
  'dashboard-sealed GET /dashboard session=ok sealed',
  'unmatched GET /nonexistent - ready',
]

/** The headers the snapshot keeps (anything else may vary run to run). */
export const KEPT_HEADERS = [
  'location',
  'content-security-policy',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
] as const

export function recordedResponseOf(
  status: number,
  headers: Headers,
  setCookie: string[]
): RecordedResponse {
  const kept = Object.fromEntries(
    KEPT_HEADERS.flatMap((name) => {
      const value = headers.get(name)
      return value === null ? [] : [[name, value] as const]
    })
  )
  return { status, headers: kept, setCookie }
}

function diffResponse(name: string, want: RecordedResponse, got: RecordedResponse): string[] {
  const lines: string[] = []
  if (want.status !== got.status)
    lines.push(`${name}: status ${got.status}, expected ${want.status}`)
  const wantHeaders = new Map(Object.entries(want.headers))
  const gotHeaders = new Map(Object.entries(got.headers))
  const keys = new Set([...wantHeaders.keys(), ...gotHeaders.keys()])
  for (const key of [...keys].toSorted((a, b) => a.localeCompare(b))) {
    if (wantHeaders.get(key) !== gotHeaders.get(key)) {
      lines.push(
        `${name}: header ${key} is ${JSON.stringify(gotHeaders.get(key) ?? null)}, expected ${JSON.stringify(wantHeaders.get(key) ?? null)}`
      )
    }
  }
  if (JSON.stringify(want.setCookie) !== JSON.stringify(got.setCookie)) {
    lines.push(`${name}: set-cookie differs`)
  }
  return lines
}

/** What differs between a recorded and the expected snapshot, one line per difference, naming the
 * case and the header: the failure message of the control-group test. */
export function diffResponseSnapshots(
  expected: ResponseSnapshot,
  actual: ResponseSnapshot
): string[] {
  const lines: string[] = []
  const wanted = new Map(Object.entries(expected.responses))
  const recorded = new Map(Object.entries(actual.responses))
  const names = new Set([...wanted.keys(), ...recorded.keys()])
  for (const name of [...names].toSorted((a, b) => a.localeCompare(b))) {
    const want = wanted.get(name)
    const got = recorded.get(name)
    if (want === undefined || got === undefined) {
      lines.push(`${name}: ${want === undefined ? 'not in the snapshot' : 'not recorded'}`)
    } else {
      lines.push(...diffResponse(name, want, got))
    }
  }
  if (expected.kitDefaultErrorLogged !== actual.kitDefaultErrorLogged) {
    lines.push(`kitDefaultErrorLogged is ${actual.kitDefaultErrorLogged}`)
  }
  return lines
}
