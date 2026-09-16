import type { ActionResult } from '@project-vault/extension-api'

/**
 * Shared `ActionResult` shape validation and HTTP-status mapping, used by every route that
 * dispatches an extension hook returning a plain `ActionResult` (`lib/module-action-handler.ts`'s
 * `ModuleAction.onAction()` dispatch, `extensions/panel-routes.ts`'s POST actions route,
 * `modules/extensions/oauth-handoff-routes.ts`'s Story 39.1 non-redirect outcomes). Extracted to
 * keep this validation/mapping in exactly one place instead of duplicated per call site.
 */

export function isValidActionResult(value: unknown): value is ActionResult {
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

const FIXED_STATUS_BY_OUTCOME = {
  denied: { status: 403, code: 'denied', message: 'Request denied' },
  error: { status: 500, code: 'internal_error', message: 'Request failed' },
} as const

/**
 * The fixed `ActionResult` → HTTP-status mapping (AC5 in `panel-routes.ts`'s originating story,
 * reused verbatim by every other `ActionResult`-dispatching route). No outcome ever forwards the
 * extension's own thrown error text, DB error detail, or stack trace. `denied`'s own `message`
 * (if the extension supplied one) is deliberately never forwarded here, unlike
 * `validation_failed`/`conflict`.
 */
export function mapActionResultToResponse(result: ActionResult): {
  status: number
  body: Record<string, unknown>
} {
  if (result.outcome === 'ok') {
    return {
      status: 200,
      body: {
        ...(result.html !== undefined ? { html: result.html } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      },
    }
  }
  if (result.outcome === 'validation_failed') {
    return { status: 400, body: { code: 'validation_failed', message: result.message } }
  }
  if (result.outcome === 'conflict') {
    return { status: 409, body: { code: 'conflict', message: result.message ?? 'Conflict' } }
  }
  const fixed = FIXED_STATUS_BY_OUTCOME[result.outcome]
  return { status: fixed.status, body: { code: fixed.code, message: fixed.message } }
}
