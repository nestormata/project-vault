import type {
  ApiRouteHookPhase,
  ApiRoutesAppDeclaration,
  AppBehaviourHooks,
} from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from '../../lib/logger.js'
import { pvErrorHandler } from '../../lib/pv-error-handler.js'

/**
 * Story 68.14 AC-1 (M7) — app-level API behaviour: an extension's global hooks, error handler and
 * not-found handler, with the same wrap/replace model as routes.
 *
 * Install positions matter because Fastify copies hooks and the error handler into an
 * encapsulated child context when its plugin is registered:
 *
 * - prepended hooks go on the root right after the extension loads (before any PV plugin hook);
 * - appended hooks go on the root right after the vault-guard slot (`vaultGuardPlugin` when the
 *   guard is enabled, an empty slot otherwise) and before the first route plugin;
 * - the error and not-found handlers are installed at PV's own `setErrorHandler` call site.
 *
 * A CM error or not-found function that throws or rejects never reaches Fastify's default handler
 * (which would expose the thrown message): the shell below logs one `app_handler_failed` event
 * (route key and error class only) and answers with PV's own handler and the ORIGINAL error.
 */

export type AppBehaviourSpec = Readonly<{
  declaration: ApiRoutesAppDeclaration
  implementation: AppBehaviourHooks
}>

export type AppHookPosition = 'prepend' | 'append'

type HookHost = { addHook: (name: string, hook: unknown) => unknown }

type ReplyLike = { sent: boolean }
type RequestLike = {
  method: string
  url: string
  routeOptions?: { url?: string }
  raw: { method?: string; url?: string }
  log: { info: (message: string) => void; error: (fields: object, message: string) => void }
}

type PvErrorHandlerFn = (error: Error, req: never, reply: never) => unknown
type CmFn = (...args: unknown[]) => unknown

export function appSpecOf(
  declaration: { app?: ApiRoutesAppDeclaration } | undefined,
  implementation: AppBehaviourHooks | undefined
): AppBehaviourSpec | undefined {
  if (!declaration?.app) return undefined
  return Object.freeze({ declaration: declaration.app, implementation: implementation ?? {} })
}

function phasesFor(
  spec: AppBehaviourSpec | undefined,
  position: AppHookPosition
): ApiRouteHookPhase[] {
  const declared = new Map(Object.entries(spec?.declaration.hooks ?? {})).get(position)
  return [...(declared ?? [])]
}

function functionsFor(spec: AppBehaviourSpec, phase: ApiRouteHookPhase): CmFn[] {
  const value = new Map(Object.entries(spec.implementation.hooks ?? {})).get(phase)
  return ([] as unknown[]).concat(value ?? []).filter((fn): fn is CmFn => typeof fn === 'function')
}

/** Adds the declared phases' functions on the root (the caller picks the install position). */
export function installAppHooks(
  fastify: HookHost,
  spec: AppBehaviourSpec | undefined,
  position: AppHookPosition
): void {
  if (!spec) return
  for (const phase of phasesFor(spec, position)) {
    for (const fn of functionsFor(spec, phase)) fastify.addHook(phase, fn)
  }
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function routeOf(req: RequestLike): string | null {
  const url = req.routeOptions?.url
  return url ? `${req.method} ${url}` : null
}

function logHandlerFailure(
  extensionName: string,
  handler: 'errorHandler' | 'notFoundHandler',
  req: RequestLike,
  failure: unknown
): void {
  req.log.error(
    {
      eventType: OperationalEvent.EXTENSION_API_ROUTE_APP_HANDLER_FAILED,
      extensionName,
      handler,
      route: routeOf(req),
      errorClass: errorClassOf(failure),
    },
    'Extension app-level handler failed; PV handler answered with the original error'
  )
}

/**
 * The error handler to install: PV's own when the extension declares none, else a shell around
 * the extension's function (`replace`: CM answers; `wrap`: CM gets `next()` that runs PV's).
 */
export function resolveErrorHandler(
  extensionName: string,
  spec: AppBehaviourSpec | undefined,
  pv: PvErrorHandlerFn = pvErrorHandler as unknown as PvErrorHandlerFn
): PvErrorHandlerFn {
  const mode = spec?.declaration.errorHandler
  const cm = spec?.implementation.errorHandler as CmFn | undefined
  if (!mode || !cm) return pv
  return async (error: Error, req: never, reply: never): Promise<unknown> => {
    try {
      return mode === 'replace'
        ? await cm(error, req, reply)
        : await cm(error, req, reply, () => Promise.resolve(pv(error, req, reply)))
    } catch (failure) {
      logHandlerFailure(extensionName, 'errorHandler', req as RequestLike, failure)
      if ((reply as ReplyLike).sent) return reply
      return pv(error, req, reply)
    }
  }
}

/**
 * PV's explicit not-found handler: Fastify's own default 404 (log line and body), reproduced so
 * PV's output does not change and an extension can wrap it. A golden test compares it with a
 * bare Fastify instance.
 */
export function pvNotFoundHandler(
  req: RequestLike,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } }
): unknown {
  const message = `Route ${req.raw.method}:${req.raw.url} not found`
  req.log.info(message)
  return reply.code(404).send({ message, error: 'Not Found', statusCode: 404 })
}

type NotFoundFn = (req: never, reply: never) => unknown

export function resolveNotFoundHandler(
  extensionName: string,
  spec: AppBehaviourSpec | undefined,
  pv: NotFoundFn = pvNotFoundHandler as unknown as NotFoundFn
): NotFoundFn {
  const mode = spec?.declaration.notFoundHandler
  const cm = spec?.implementation.notFoundHandler as CmFn | undefined
  if (!mode || !cm) return pv
  return async (req: never, reply: never): Promise<unknown> => {
    try {
      return mode === 'replace'
        ? await cm(req, reply)
        : await cm(req, reply, () => Promise.resolve(pv(req, reply)))
    } catch (failure) {
      logHandlerFailure(extensionName, 'notFoundHandler', req as RequestLike, failure)
      if ((reply as ReplyLike).sent) return reply
      return pv(req, reply)
    }
  }
}

/** Declaration data for the status endpoint and the boot log (no functions, no source). */
export function appStatus(spec: AppBehaviourSpec | undefined) {
  return {
    errorHandler: spec?.declaration.errorHandler ?? null,
    notFoundHandler: spec?.declaration.notFoundHandler ?? null,
    hooks: {
      prepend: phasesFor(spec, 'prepend') as string[],
      append: phasesFor(spec, 'append') as string[],
    },
  }
}

type AppChange = {
  target: 'errorHandler' | 'notFoundHandler' | 'hook'
  mode?: 'wrap' | 'replace'
  phase?: string
  position?: AppHookPosition
}

export function appChanges(spec: AppBehaviourSpec | undefined): AppChange[] {
  if (!spec) return []
  const changes: AppChange[] = []
  const { errorHandler, notFoundHandler } = spec.declaration
  if (errorHandler) changes.push({ target: 'errorHandler', mode: errorHandler })
  if (notFoundHandler) changes.push({ target: 'notFoundHandler', mode: notFoundHandler })
  for (const position of ['prepend', 'append'] as const) {
    for (const phase of phasesFor(spec, position)) {
      changes.push({ target: 'hook', phase, position })
    }
  }
  return changes
}

type BootLogger = Parameters<typeof operationalLog>[0]

/** `"errorHandler wrap"`, `"hook onRequest prepend"`: the applied-summary spelling. */
export function appChangeLabels(spec: AppBehaviourSpec | undefined): string[] {
  return appChanges(spec).map((change) =>
    change.target === 'hook'
      ? `hook ${change.phase} ${change.position}`
      : `${change.target} ${change.mode}`
  )
}

/** One warn per app-level change; fields are declaration data only. */
export function logAppOverrides(
  extensionName: string,
  spec: AppBehaviourSpec | undefined,
  logger: BootLogger
): void {
  for (const change of appChanges(spec)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.EXTENSION_API_ROUTE_APP_OVERRIDE,
      'Extension apiRoutes changes PV app-level behaviour (recorded, not refused)',
      { extensionName, ...change }
    )
  }
}
