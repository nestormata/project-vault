import type { FastifyBaseLogger } from 'fastify'
import type { ActionResult, ModuleAction, ModuleActionContext } from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { getExtensionStatus } from '../extensions/loader.js'
import {
  defaultRenderExtensionPanelDeps,
  resolveBaseModuleActionContext,
  type PanelIdentity,
  type PanelQuery,
  type RenderExtensionPanelDeps,
} from './extension-panel.js'
import { operationalLog } from './logger.js'
import { raceWithTimeout } from './race-with-timeout.js'

/** Mirrors `extension-panel.ts`'s own (unexported) `PanelLogger` type exactly. */
type PanelLoggerLike = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>

/**
 * Story 25.5 AC6 — the exact same interim numeric default `extension-panel.ts`'s
 * `RENDER_PANEL_TIMEOUT_MS` already established for `onRenderPanel()`, reused verbatim rather
 * than a new, uncoordinated timeout value. Story 25.7 will formalize a project-wide timeout
 * policy across all hook calls — this is still an interim default, not that policy.
 */
const MODULE_ACTION_TIMEOUT_MS = 10_000

/**
 * Story 25.5 AC1/AC2/AC5 — the parsed, host-validated request. `action.kind`'s membership in the
 * loaded extension's declared `moduleActions` list is checked inside `handleModuleAction()`
 * itself (AC2), not here — this type only captures what the route has already shape-validated
 * (a string `kind` field) before calling in.
 */
export type ModuleActionRequestBody = Record<string, unknown> & { kind: string }

/**
 * Story 25.5 AC1/AC2/AC5 — the route's own outcome type: `invalid_slot`/`not_found` are host-level
 * pre-checks that never invoke `onAction()` at all (AC2 — a caller enumerating action kinds or
 * projectIds cannot distinguish "wrong slot" from "wrong action" from "no visibility", mirroring
 * `renderExtensionPanel()`'s own `panel_unavailable` non-distinguishing convention); every other
 * outcome is `onAction()`'s own returned `ActionResult`, passed through verbatim (message
 * redaction for `denied` happens at the route's HTTP-mapping layer, not here).
 */
export type ModuleActionOutcome =
  { outcome: 'invalid_slot' } | { outcome: 'not_found' } | ActionResult

function logModuleActionFailed(
  logger: PanelLoggerLike,
  slot: string,
  actionKind: string,
  subReason: 'timed_out' | 'threw' | 'malformed' | 'reported'
): void {
  // AC5: the extension's own thrown error text/stack (or its own reported failure detail) is
  // never included here — logged server-side only, as a fixed-enum subReason, mirroring
  // `extension-panel.ts`'s `logUnavailable()` never-leak-internal-detail discipline exactly.
  operationalLog(
    logger,
    'error',
    OperationalEvent.EXTENSION_MODULE_ACTION_FAILED,
    'Extension module action failed',
    { slot, actionKind, subReason }
  )
}

function isValidActionResult(value: unknown): value is ActionResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { outcome?: unknown; html?: unknown; message?: unknown }
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string'
  switch (candidate.outcome) {
    case 'ok':
      return optionalString(candidate.html) && optionalString(candidate.message)
    case 'validation_failed':
      return typeof candidate.message === 'string'
    case 'denied':
    case 'conflict':
      return optionalString(candidate.message)
    case 'error':
      return true
    default:
      return false
  }
}

type ModuleActionAttemptOutcome =
  | { kind: 'unknown_action' }
  | { kind: 'denied_project'; projectId: string }
  | { kind: 'dispatched'; result: unknown }

/**
 * Story 25.5 Task 3 — the single unit of work `raceWithTimeout()` races: the AC2 action-kind
 * allowlist check, projectId authorization, locale/theme resolution, and the `onAction()` call
 * itself. Mirrors `extension-panel.ts`'s own `resolvePanelContextAndRender()` factoring, for the
 * same reason (keeping the exported function's cyclomatic complexity within this repo's lint
 * budget while keeping all of this one atomic, timeout-wrapped attempt).
 */
async function resolveModuleActionContextAndDispatch(
  slot: string,
  identity: PanelIdentity,
  tx: Tx,
  query: PanelQuery,
  deps: RenderExtensionPanelDeps,
  moduleAction: ModuleAction,
  knownActions: readonly string[],
  request: ModuleActionRequestBody
): Promise<ModuleActionAttemptOutcome> {
  // AC2: checked BEFORE onAction() is ever invoked — a request naming an action.kind the
  // currently-loaded extension does not declare never reaches the hook.
  if (!knownActions.includes(request.kind)) {
    return { kind: 'unknown_action' }
  }

  // AC3: reuses the identical PV-authorized project-visibility gate (and locale/theme
  // resolution) `renderExtensionPanel()` already uses, via `resolveBaseModuleActionContext()` —
  // reused, not reinvented. Denial is reported via a distinct discriminant, not a thrown error,
  // so it is never conflated with a genuine hook/DB failure.
  //
  // AC3 — Red Team vs Blue Team: this context is built EXCLUSIVELY from `identity` (the caller's
  // own resolved session, forwarded in by the route from its own authenticated context) and DB
  // lookups. The `request` parameter (the parsed action body) is never read here beyond the
  // already-checked `kind` field above — no code path in this function reads an org/user/project
  // claim off of it, even though the body's type would structurally allow a same-named field.
  const base = await resolveBaseModuleActionContext(slot, identity, tx, query, deps, undefined)
  if (base.kind === 'denied') {
    return { kind: 'denied_project', projectId: base.projectId }
  }

  const result = await moduleAction.onAction(base.context as ModuleActionContext, {
    action: request,
  })
  return { kind: 'dispatched', result }
}

function finalizeModuleActionResult(
  raced: Awaited<ReturnType<typeof raceWithTimeout<ModuleActionAttemptOutcome>>>,
  logger: PanelLoggerLike,
  slot: string,
  actionKind: string,
  deps: RenderExtensionPanelDeps,
  identity: PanelIdentity
): ModuleActionOutcome {
  if (raced.status === 'timed_out') {
    logModuleActionFailed(logger, slot, actionKind, 'timed_out')
    return { outcome: 'error' }
  }
  if (raced.status === 'rejected') {
    logModuleActionFailed(logger, slot, actionKind, 'threw')
    return { outcome: 'error' }
  }

  const inner = raced.value
  if (inner.kind === 'unknown_action') {
    return { outcome: 'not_found' }
  }
  if (inner.kind === 'denied_project') {
    // AC2/AC3: the SAME non-distinguishing not_found outcome an unknown action.kind produces —
    // never a distinguishable 403/404 — so a caller cannot tell "wrong project" apart from
    // "unknown action". The hook is never invoked for a denied projectId.
    deps.logVisibilityDenied(
      { log: logger },
      { projectId: inner.projectId, callerId: identity.userId, orgRole: identity.orgRole }
    )
    return { outcome: 'not_found' }
  }

  if (!isValidActionResult(inner.result)) {
    logModuleActionFailed(logger, slot, actionKind, 'malformed')
    return { outcome: 'error' }
  }

  if (inner.result.outcome === 'error') {
    // AC5: the hook's own explicit { outcome: 'error' } is logged the same as a thrown/timed-out
    // failure — a caller-visible 500 either way, distinguished server-side only by subReason.
    logModuleActionFailed(logger, slot, actionKind, 'reported')
  }

  return inner.result
}

/**
 * Story 25.5 Task 3 — `POST /extensions/panels/:slot/actions`'s reusable dispatch function,
 * sibling to `renderExtensionPanel()` (same file's dependency-injection discipline). Re-derives
 * the caller's identity/org/project/locale/theme context fresh per call, reusing
 * `renderExtensionPanel()`'s exact dependency functions — never trusting the request body for any
 * identity/org claim (AC3).
 */
export async function handleModuleAction(
  slot: string,
  knownSlots: readonly string[],
  logger: PanelLoggerLike,
  identity: PanelIdentity,
  tx: Tx,
  request: ModuleActionRequestBody,
  query: PanelQuery = {},
  deps: RenderExtensionPanelDeps = defaultRenderExtensionPanelDeps
): Promise<ModuleActionOutcome> {
  if (!knownSlots.includes(slot)) {
    return { outcome: 'invalid_slot' }
  }

  // AC3: re-checked fresh on every request, never cached from an earlier call — the extension can
  // genuinely be gone by the time this route is hit.
  const status = getExtensionStatus()
  if (status.status !== 'loaded' || !status.hooks.moduleAction) {
    // AC2's own non-leaking-existence convention: a permanently-absent hook is indistinguishable
    // from "this action.kind was never declared" — both are `not_found`, onAction() never called.
    return { outcome: 'not_found' }
  }

  const moduleAction = status.hooks.moduleAction
  const knownActions = status.manifest.moduleActions ?? []

  const raced = await raceWithTimeout(
    () =>
      resolveModuleActionContextAndDispatch(
        slot,
        identity,
        tx,
        query,
        deps,
        moduleAction,
        knownActions,
        request
      ),
    MODULE_ACTION_TIMEOUT_MS
  )

  return finalizeModuleActionResult(raced, logger, slot, request.kind, deps, identity)
}
