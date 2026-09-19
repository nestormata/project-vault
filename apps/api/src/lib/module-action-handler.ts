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
import { isValidActionResult } from './action-result-response.js'
import { peekRequestState } from './extension-request-state.js'

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

type ModuleActionAttemptOutcome =
  | { kind: 'unknown_action' }
  | { kind: 'denied_project'; projectId: string }
  | { kind: 'dispatched'; result: unknown }

/**
 * Story 25.5 Task 3/Sonar S107 — `moduleAction`/`knownActions` are both derived from the same
 * loaded-extension state and always passed together (the AC2 allowlist check below, then the
 * `onAction()` call itself), so they're bundled into one parameter, the same rationale as
 * `ModuleActionPanelTarget` above.
 */
type ModuleActionCapability = { moduleAction: ModuleAction; knownActions: readonly string[] }

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
  capability: ModuleActionCapability,
  request: ModuleActionRequestBody,
  requestStateScope: { extensionName: string; requestStateCookie: string | undefined }
): Promise<ModuleActionAttemptOutcome> {
  const { moduleAction, knownActions } = capability
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

  // Story 40.1 AC2/AC8/AC12 — populated ONLY here (the `moduleAction` dispatch path), never on
  // `uiPanel`'s own `resolveBaseModuleActionContext()` call sites (`extension-panel.ts`,
  // `oauth-handoff-routes.ts`'s `handleStart`) — see `ModuleActionContext.requestState`'s own doc
  // comment for the "point-in-time snapshot, computed once before onAction() runs" contract.
  const requestState = await peekRequestState(requestStateScope.requestStateCookie, {
    extensionName: requestStateScope.extensionName,
    orgId: identity.orgId,
    identityId: identity.userId,
  })
  const moduleActionContext: ModuleActionContext = {
    ...base.context,
    ...(requestState !== undefined ? { requestState } : {}),
  }

  const result = await moduleAction.onAction(moduleActionContext, {
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
 * Story 25.5 Task 3/Sonar S107 — `slot`/`knownSlots` are always passed and consumed together (the
 * single `invalid_slot` pre-check below), so they're bundled into one parameter to keep
 * `handleModuleAction()`'s own parameter count within this repo's lint budget rather than
 * splitting an otherwise-cohesive routing concern across two positional arguments.
 */
export type ModuleActionPanelTarget = { slot: string; knownSlots: readonly string[] }

/**
 * Story 25.5 Task 3 — `POST /extensions/panels/:slot/actions`'s reusable dispatch function,
 * sibling to `renderExtensionPanel()` (same file's dependency-injection discipline). Re-derives
 * the caller's identity/org/project/locale/theme context fresh per call, reusing
 * `renderExtensionPanel()`'s exact dependency functions — never trusting the request body for any
 * identity/org claim (AC3).
 */
export async function handleModuleAction(
  panelTarget: ModuleActionPanelTarget,
  logger: PanelLoggerLike,
  identity: PanelIdentity,
  tx: Tx,
  request: ModuleActionRequestBody,
  query: PanelQuery = {},
  deps: RenderExtensionPanelDeps = defaultRenderExtensionPanelDeps,
  // Story 40.1 AC2/AC8 — the raw `extension-request-state` cookie value off the inbound
  // `moduleAction` request, if any. Deliberately a separate, explicit parameter (never read off
  // `query`/`request`) so it is obvious at every call site that only `moduleAction` routes ever
  // supply it — `uiPanel`'s own render path has no equivalent parameter at all (AC8).
  requestStateCookie?: string
): Promise<ModuleActionOutcome> {
  const { slot, knownSlots } = panelTarget
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
        { moduleAction, knownActions },
        request,
        { extensionName: status.manifest.name, requestStateCookie }
      ),
    MODULE_ACTION_TIMEOUT_MS
  )

  return finalizeModuleActionResult(raced, logger, slot, request.kind, deps, identity)
}
