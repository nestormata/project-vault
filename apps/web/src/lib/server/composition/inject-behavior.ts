// Story 68.4 AC-5 / AC-6: behavior injection. PV's `+page.server.ts` / `+layout.server.ts` call
// `injectLoad(event, ROUTE_ID, SCOPE)` and spread `...injectActions(ROUTE_ID)`. In PV's own build the
// virtual module is empty, so both are no-ops (`{}` and `undefined`). With a composition kit they
// run the pack's contribution loads and actions, with the SAME RequestEvent PV's own load received
// (same fetch, locals, cookies), after PV's own load finished (so a PV redirect/error short-circuits).
//
// CM is trusted first-party code (ADR 0007 invariant 0): nothing here sanitizes, sandboxes or hides
// a failure. A failure is rethrown wrapped with the point and the error NAME only (never a message
// or a property a caller could influence), with the original as `cause`; Kit's `handleError` logs it.
import { isHttpError, isRedirect } from '@sveltejs/kit'
import type { Action, Actions, LoadEvent, RequestEvent } from '@sveltejs/kit'
import { actions as generatedActions, loads as generatedLoads } from 'virtual:pv-inject-behavior'

export type InjectScope = 'page' | 'layout'
export type InjectedData = { __inject?: Record<string, readonly unknown[]> }
type BehaviorEvent = RequestEvent | LoadEvent

interface LoadContribution {
  order: number
  load: ((event: never) => unknown) | null
}

interface LoadPoint {
  point: string
  contributions: readonly LoadContribution[]
}

interface ActionEntry {
  point: string
  name: string
  run: (event: never) => unknown
}

/** The shape of the tables the kit generates for `virtual:pv-inject-behavior`. Keys are
 * `<routeId>#<scope>`; the registry (never the file path) decides which route and scope a point has. */
export interface BehaviorTables {
  loads: Readonly<Record<string, readonly LoadPoint[]>>
  actions: Readonly<Record<string, Readonly<Record<string, ActionEntry>>>>
}

const MAX_NAME_LENGTH = 64

function errorName(error: unknown): string {
  return error instanceof Error ? String(error.name).slice(0, MAX_NAME_LENGTH) : 'NonError'
}

/** A redirect or an HttpError is a legitimate control-flow throw and passes through untouched. */
function wrap(error: unknown, message: string): unknown {
  if (isRedirect(error) || isHttpError(error)) return error
  return new Error(message, { cause: error })
}

interface Job {
  point: string
  order: number
  position: number
  load: LoadContribution['load']
}

type Outcome = { job: Job; ok: true; value: unknown } | { job: Job; ok: false; reason: unknown }

function jobsOf(points: readonly LoadPoint[]): Job[] {
  let position = 0
  return points.flatMap((entry) =>
    entry.contributions.map((contribution) => ({
      point: entry.point,
      order: contribution.order,
      position: position++,
      load: contribution.load,
    }))
  )
}

/** One load, settled into a value: a rejection is data here, so nothing is ever left unhandled. */
async function settle(job: Job, event: BehaviorEvent): Promise<Outcome> {
  try {
    const value = job.load === null ? null : await job.load(event as never)
    return { job, ok: true, value: value ?? null }
  } catch (reason) {
    return { job, ok: false, reason }
  }
}

async function runLoads(event: BehaviorEvent, points: readonly LoadPoint[]): Promise<InjectedData> {
  // Every load is awaited to settlement (no unhandled rejection, nothing left running detached).
  const outcomes = await Promise.all(jobsOf(points).map((job) => settle(job, event)))
  const failed = outcomes
    .filter((outcome) => !outcome.ok)
    .sort((a, b) => a.job.order - b.job.order || a.job.position - b.job.position)[0]
  if (failed !== undefined && !failed.ok) {
    throw wrap(
      failed.reason,
      `injection "${failed.job.point}" load failed: ${errorName(failed.reason)}`
    )
  }
  const inject = new Map<string, unknown[]>()
  for (const outcome of outcomes) {
    if (outcome.ok)
      inject.set(outcome.job.point, [...(inject.get(outcome.job.point) ?? []), outcome.value])
  }
  return { __inject: Object.fromEntries(inject) }
}

function runAction(entry: ActionEntry): Action {
  return async (event) => {
    try {
      return (await entry.run(event as never)) as never
    } catch (error) {
      throw wrap(
        error,
        `injection "${entry.point}" action "${entry.name}" failed: ${errorName(error)}`
      )
    }
  }
}

/** One predicate for the own-result flags that mean "there is nothing a contribution load could
 * read": PV's 404 answer (`notFound: true`, no such entity for you), its sealed-vault answer
 * (`vaultSealed: true`, every PV API call 503s) and the typed `skipInjectedLoads: true` marker a
 * load sets when its "nothing here" answer has another shape (Story 69.3: the public status page's
 * `statusPage: null`). Only the literal `true` counts. */
function isLoadSkipped(data: object | undefined): boolean {
  const { notFound, vaultSealed, skipInjectedLoads } = (data ?? {}) as {
    notFound?: unknown
    vaultSealed?: unknown
    skipInjectedLoads?: unknown
  }
  return notFound === true || vaultSealed === true || skipInjectedLoads === true
}

/** The `skipInjectedLoads` marker is a message to this wrapper, never part of PV's page data. */
function withoutMarker(data: object | undefined): object | undefined {
  if (data === undefined || !('skipInjectedLoads' in data)) return data
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'skipInjectedLoads'))
}

/** No load ran: one null entry per contribution of every point of the slice, or nothing at all when
 * the slice has no contributions (PV's own build). */
function skippedLoads(points: readonly LoadPoint[] | undefined): InjectedData {
  if (points === undefined || points.length === 0) return {}
  return {
    __inject: Object.fromEntries(
      points.map((entry) => [entry.point, entry.contributions.map(() => null)])
    ),
  }
}

export function createInjectBehavior(tables: BehaviorTables) {
  const loads = new Map(Object.entries(tables.loads))
  const actions = new Map(Object.entries(tables.actions))
  const injectLoad = (
    event: BehaviorEvent,
    routeId: string,
    scope: InjectScope
  ): Promise<InjectedData> => {
    const points = loads.get(`${routeId}#${scope}`)
    if (points === undefined || points.length === 0) return Promise.resolve({})
    return runLoads(event, points)
  }
  return {
    /** Runs the contribution loads registered for this route's points and returns
     * `{ __inject: { '<point>': [entry per contribution] } }`, or `{}` when there is nothing. */
    injectLoad,

    /** Wraps a PV load: PV's own load runs and finishes FIRST (so a PV `redirect()`/`error()`
     * short-circuits and no contribution load runs), then its data is merged with the injected data
     * under `__inject`. A page server file reads `export const load = withInjectedLoad(ownLoad, ROUTE_ID, SCOPE)`. */
    withInjectedLoad<Event, Data>(
      own: (event: Event) => Data | Promise<Data>,
      routeId: string,
      scope: InjectScope
    ): (event: Event) => Promise<Awaited<Data> & InjectedData> {
      return async (event) => {
        const ownData = (await own(event)) as object | undefined
        // Story 69.1 (Q2, DW-490 item 1): PV's own 404 result (`notFound: true`) means there is no
        // entity a contribution could load for, and a contribution that calls the API for the same id
        // would turn PV's 404 into a 500 or an existence oracle. Story 69.2 (Q3): the same holds for
        // `vaultSealed: true`, where a contribution calling the API would turn PV's sealed banner
        // into a 500. Story 69.3: and for the `skipInjectedLoads` marker of the public status page.
        // No contribution load runs; every contribution still gets a null entry so the point's
        // `data` stays aligned.
        const injected = isLoadSkipped(ownData)
          ? skippedLoads(loads.get(`${routeId}#${scope}`))
          : // Kit hands the same event to PV's load and to this wrapper; PV's own load only needs the
            // slice of it (params, locals, ...) it declares, so `Event` is not tied to Kit's event types.
            await injectLoad(event as BehaviorEvent, routeId, scope)
        return { ...withoutMarker(ownData), ...injected } as Awaited<Data> & InjectedData
      }
    },

    /** The injected form actions of a page, keyed `<point>.<name>` (exact-match, null prototype),
     * or `undefined` when there are none: `{}` would make Kit answer a stray POST with its "no
     * action with name" 404 instead of the 405 "no actions exist" PV gives today. */
    injectActions(routeId: string): Actions | undefined {
      const entries = Object.entries(actions.get(`${routeId}#page`) ?? {})
      if (entries.length === 0) return undefined
      const result = Object.fromEntries(entries.map(([key, entry]) => [key, runAction(entry)]))
      return Object.freeze(Object.setPrototypeOf(result, null) as Record<string, Action>)
    },
  }
}

export const { injectLoad, injectActions, withInjectedLoad } = createInjectBehavior({
  loads: generatedLoads,
  actions: generatedActions,
})
