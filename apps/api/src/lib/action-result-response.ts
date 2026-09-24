import type { ActionResult } from '@project-vault/extension-api'

/**
 * Shared `ActionResult` shape validation and HTTP-status mapping, used by every route that
 * dispatches an extension hook returning a plain `ActionResult` (`lib/module-action-handler.ts`'s
 * `ModuleAction.onAction()` dispatch, `extensions/panel-routes.ts`'s POST actions route,
 * `modules/extensions/oauth-handoff-routes.ts`'s Story 39.1 non-redirect outcomes,
 * `modules/extensions/public-route-routes.ts`'s Story 20.13 non-response outcomes). Extracted to
 * keep this validation/mapping in exactly one place instead of duplicated per call site.
 *
 * Story 59.1 — forwarding rule: a field of a returned `ActionResult` reaches the caller if and
 * only if its published contract says it is caller-facing. `html` is caller-facing on every
 * outcome (extension-computed display content, rendered by the panel host after sanitization), so
 * it is forwarded whenever present. `validation_failed.message`/`conflict.message` are forwarded
 * verbatim; `denied.message` is never forwarded. The extension's own thrown error text, stack or
 * DB detail is never forwarded: a throw/timeout/malformed result is replaced upstream by a bare
 * `{ outcome: 'error' }` before it reaches this mapper, and the mapper builds every body from
 * explicit fields — it never spreads `result`.
 */

export function isValidActionResult(value: unknown): value is ActionResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { outcome?: unknown; html?: unknown; message?: unknown }
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string'
  // Story 59.1 — `html` is optional on every outcome, and a non-string value is malformed.
  if (!optionalString(candidate.html)) return false
  switch (candidate.outcome) {
    case 'ok':
    case 'denied':
    case 'conflict':
      return optionalString(candidate.message)
    case 'validation_failed':
      return typeof candidate.message === 'string'
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
 *
 * Story 59.1 — `html` is forwarded on every outcome whenever present (including an empty
 * string; the client ignores empty html), per the forwarding rule in this file's header. The body
 * is always built from explicit fields, so extra runtime keys on a valid result never leak.
 */
export function mapActionResultToResponse(result: ActionResult): {
  status: number
  body: Record<string, unknown>
} {
  const htmlField = result.html !== undefined ? { html: result.html } : {}
  if (result.outcome === 'ok') {
    return {
      status: 200,
      body: {
        ...htmlField,
        ...(result.message !== undefined ? { message: result.message } : {}),
      },
    }
  }
  if (result.outcome === 'validation_failed') {
    return {
      status: 400,
      body: { code: 'validation_failed', message: result.message, ...htmlField },
    }
  }
  if (result.outcome === 'conflict') {
    return {
      status: 409,
      body: { code: 'conflict', message: result.message ?? 'Conflict', ...htmlField },
    }
  }
  const fixed = FIXED_STATUS_BY_OUTCOME[result.outcome]
  return { status: fixed.status, body: { code: fixed.code, message: fixed.message, ...htmlField } }
}
