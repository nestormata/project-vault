/**
 * Fault-containment conformance helpers (Story 67.1).
 *
 * Contract: the PV API host loads an extension in-process. Node treats an `'error'` event on an
 * emitter with no `'error'` listener, and a rejected promise nobody handles, as fatal for the
 * whole process. Every long-lived emitter an extension creates (database pools, sockets, streams,
 * clients) MUST therefore carry an `'error'` listener, and every background promise MUST have a
 * rejection handler. These helpers let an extension prove that in its own CI, before it ships.
 *
 * They report labels and counts only, never error text, so a failing run cannot leak a connection
 * string into CI logs.
 */

/** The structural slice of a Node `EventEmitter` (a `pg.Pool` is one) the helper needs. */
export interface ConformanceEmitter {
  listenerCount(eventName: string): number
  emit(eventName: string, ...args: unknown[]): boolean
}

export interface EmitterConformanceResult {
  readonly ok: boolean
  /** Labels of the emitters that crashed when an `'error'` event was forced on them. */
  readonly violations: readonly string[]
}

export interface BackgroundPromiseConformanceResult {
  readonly ok: boolean
  readonly unhandledCount: number
}

/**
 * Forces a synthetic `'error'` event on every emitter and reports the ones that throw (a
 * listener-less emitter rethrows it, which in a running host is the process-killing path). An
 * emitter that has a listener is invoked with the synthetic error, so listeners must tolerate it.
 */
export function checkExtensionEmitters(
  emitters: Readonly<Record<string, ConformanceEmitter>>
): EmitterConformanceResult {
  const violations: string[] = []
  for (const [label, emitter] of Object.entries(emitters)) {
    if (emitter.listenerCount('error') === 0) {
      violations.push(label)
      continue
    }
    try {
      emitter.emit('error', new Error('extension-api conformance probe'))
    } catch {
      violations.push(label)
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Throws (naming only the offending labels) unless every emitter survives a forced `'error'`. */
export function assertExtensionEmittersContained(
  emitters: Readonly<Record<string, ConformanceEmitter>>
): void {
  const { ok, violations } = checkExtensionEmitters(emitters)
  if (!ok) {
    throw new Error(
      `Extension emitters without a working 'error' listener: ${violations.join(', ')}`
    )
  }
}

/**
 * The slice of the Node runtime the background-promise check needs. Declared structurally because
 * this package's public sources compile without `@types/node` (the api-surface generator
 * enforces that), and the helper only ever runs under Node, in an extension's CI.
 */
interface NodeRuntimeSlice {
  readonly process: {
    on(event: 'unhandledRejection', listener: () => void): unknown
    removeListener(event: 'unhandledRejection', listener: () => void): unknown
  }
  readonly setImmediate: (callback: () => void) => unknown
}

/**
 * Runs `run` and reports any promise rejection that was left unhandled while it ran (and one
 * macrotask after). Use it around the code path that starts an extension's background work.
 */
export async function checkBackgroundPromisesHandled(
  run: () => void | Promise<void>
): Promise<BackgroundPromiseConformanceResult> {
  const runtime = globalThis as unknown as NodeRuntimeSlice
  let unhandledCount = 0
  const onUnhandled = (): void => {
    unhandledCount += 1
  }
  runtime.process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    await new Promise<void>((resolve) => runtime.setImmediate(resolve))
  } finally {
    runtime.process.removeListener('unhandledRejection', onUnhandled)
  }
  return { ok: unhandledCount === 0, unhandledCount }
}

/** Why an extension write under `:projectId` runs without the host's project-role gate. */
export type ProjectWriteUngatedReason = 'declared_viewer' | 'legacy_contract' | 'unauthenticated'

export interface ProjectWriteRoleFinding {
  /** `"<METHOD> <url>"` as declared. */
  readonly route: string
  /** The minimum effective project role the host enforces, or `null` when no check runs. */
  readonly minimumProjectRole: 'owner' | 'admin' | 'member' | null
  readonly ungated: ProjectWriteUngatedReason | null
}

export interface ProjectWriteRoleConformanceResult {
  /** `true` when every project write the manifest owns runs behind the gate. */
  readonly ok: boolean
  readonly routes: readonly ProjectWriteRoleFinding[]
}

/** The first contract version whose project writes get the default gate (Story 69.18). */
const PROJECT_ROLE_DEFAULT_SINCE = [3, 37, 0]
const PROJECT_ID_SEGMENT = /(?:^|\/):projectId(?:\/|$)/
const PROJECT_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

type ProjectWriteSecurity = { requireAuth?: boolean; minimumProjectRole?: string } | undefined

function declaresDefaultContract(apiVersion: string): boolean {
  const parts = apiVersion.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return true
  const index = parts.findIndex((part, position) => part !== PROJECT_ROLE_DEFAULT_SINCE[position])
  return index === -1 || (parts[index] ?? 0) > (PROJECT_ROLE_DEFAULT_SINCE[index] ?? 0)
}

function findingFor(
  route: string,
  security: ProjectWriteSecurity,
  currentContract: boolean
): ProjectWriteRoleFinding {
  const declared = security?.minimumProjectRole
  if (declared === 'owner' || declared === 'admin' || declared === 'member') {
    return { route, minimumProjectRole: declared, ungated: null }
  }
  const ungated = ungatedReason(declared, security, currentContract)
  return { route, minimumProjectRole: ungated === null ? 'member' : null, ungated }
}

function ungatedReason(
  declared: string | undefined,
  security: ProjectWriteSecurity,
  currentContract: boolean
): ProjectWriteUngatedReason | null {
  if (declared === 'viewer') return 'declared_viewer'
  if (!currentContract) return 'legacy_contract'
  if (security?.requireAuth === false) return 'unauthenticated'
  return null
}

/**
 * Story 69.18 — lists every POST, PUT, PATCH or DELETE route under `:projectId` whose security this
 * manifest owns (`apiRoutes.add`, and overrides with `replaceSecurity: true`) with the project-role
 * gate the host will apply, the same answer the host's boot log gives. Run it in the extension's
 * CI and fail on an `ungated` route you did not mean (`ok` is `false` when any route is ungated).
 * Overrides without `replaceSecurity` keep PV's own gate and are not listed.
 */
export function checkProjectWriteRoles(manifest: {
  apiVersion: string
  apiRoutes?: {
    add?: ReadonlyArray<{ method: string; url: string; options?: { security?: object } }>
    override?: ReadonlyArray<{
      method: string
      url: string
      replaceSecurity?: boolean
      security?: object
    }>
  }
}): ProjectWriteRoleConformanceResult {
  const currentContract = declaresDefaultContract(manifest.apiVersion)
  const owned = [
    ...(manifest.apiRoutes?.add ?? []).map((entry) => ({
      ...entry,
      security: entry.options?.security,
    })),
    ...(manifest.apiRoutes?.override ?? []).filter((entry) => entry.replaceSecurity === true),
  ]
  const routes = owned
    .filter(
      (entry) => PROJECT_WRITE_METHODS.has(entry.method) && PROJECT_ID_SEGMENT.test(entry.url)
    )
    .map((entry) =>
      findingFor(
        `${entry.method} ${entry.url}`,
        entry.security as ProjectWriteSecurity,
        currentContract
      )
    )
  return { ok: routes.every((route) => route.ungated === null), routes }
}
