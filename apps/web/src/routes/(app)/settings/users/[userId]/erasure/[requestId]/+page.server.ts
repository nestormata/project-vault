import { ApiClientError } from '$lib/api/client.js'
import {
  createErasureRequest,
  getErasureReport,
  type ErasureReport,
  type PiiInventory,
} from '$lib/api/compliance.js'
import { listOrgUsers } from '$lib/api/org-users.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

type CommonFields = { orgRole: string; userId: string; requestId: string; userEmail: string | null }

type LoadResult =
  | (CommonFields & { state: 'not_allowed' })
  | (CommonFields & { state: 'completed'; report: ErasureReport })
  | (CommonFields & { state: 'pending'; piiInventory: PiiInventory | null })
  | (CommonFields & { state: 'in_progress' })
  | (CommonFields & { state: 'not_found' })

// K/L/M's own gates are admin+ (review) / owner-only (execute); a member/viewer has no legitimate
// use for this page at all. Every sibling page this story adds (`/settings/audit`,
// `/settings/audit/access-report`, `/settings/audit/forwarding`) checks role and returns an
// honest "not allowed" state before ever calling its API — this page was the one exception,
// which meant a member/viewer hitting this URL directly fell through to `getErasureReport`'s own
// 403, an error this load() didn't handle, crashing into SvelteKit's generic error page instead
// of the same honest notice every other page in this story shows.
const ERASURE_VIEW_ROLES = new Set(['owner', 'admin'])

// D4/D5 — the typed-confirmation gate needs the target user's exact email; there is no per-user
// `GET` on this erasure route, so this reuses the existing org-members list endpoint (already
// consumed by /settings/users) rather than adding a new backend endpoint. If the target has since
// left the org (edge case), the email is unavailable and the confirm gate simply has nothing to
// match against.
async function resolveUserEmail(fetchFn: typeof fetch, userId: string): Promise<string | null> {
  const users = await listOrgUsers(fetchFn)
  return users.find((u) => u.userId === userId)?.email ?? null
}

// D6 (adversarial review, medium) — an `in_progress` request must NOT be re-POSTed (that hits
// `execution_in_progress`, which carries no `piiInventory`); only `pending` is safe to re-POST
// per D6's idempotent-by-construction `already_pending` branch. Extracted from load() to keep its
// cyclomatic/cognitive complexity within this repo's lint budget.
async function resolveNotYetCompleted(
  fetchFn: typeof fetch,
  common: CommonFields,
  status: string | undefined
): Promise<LoadResult> {
  if (status === 'in_progress') {
    return { ...common, state: 'in_progress' }
  }

  try {
    // Safe re-POST as a read path (D6): `createErasureRequest`'s `already_pending` outcome always
    // fires before any new-row validation runs, so this never creates a duplicate request — it's
    // a genuine, intentional reuse of an idempotent-by-construction endpoint purely to redisplay
    // the PII inventory the report-status probe doesn't return.
    await createErasureRequest(fetchFn, common.userId, {
      reason: 'Status check for existing pending erasure request review',
      requestedBy: 'system:erasure-status-check',
    })
    // Should not normally succeed for a genuinely pending request (the server always finds the
    // existing row first) — but if it somehow does, fall through with no inventory rather than
    // crash.
    return { ...common, state: 'pending', piiInventory: null }
  } catch (innerErr) {
    // Only the specific, expected `already_pending` outcome is safe to swallow into a "pending,
    // here's the inventory" result — any other error (a 403 from a role the outer check let
    // through unexpectedly, a 500, a genuine validation failure) must propagate as a real error
    // instead of being silently repainted as a benign empty-inventory pending screen.
    if (innerErr instanceof ApiClientError && innerErr.code === 'erasure_request_already_pending') {
      const innerBody = innerErr.body as { piiInventory?: PiiInventory } | null
      return { ...common, state: 'pending', piiInventory: innerBody?.piiInventory ?? null }
    }
    throw innerErr
  }
}

// D6 — there is no dedicated `GET`-by-userId endpoint for "the current erasure request for user
// X"; `GET .../report` doubles as a status probe: 200 means completed, a `409
// erasure_not_yet_completed` distinguishes pending/in_progress, and 404 means no such request.
export const load: PageServerLoad = async ({ fetch, params, locals }) => {
  const user = requireUser(locals)
  const { userId, requestId } = params

  if (!ERASURE_VIEW_ROLES.has(user.orgRole)) {
    return {
      orgRole: user.orgRole,
      userId,
      requestId,
      userEmail: null,
      state: 'not_allowed',
    } satisfies LoadResult
  }

  const userEmail = await resolveUserEmail(fetch, userId)
  const common: CommonFields = { orgRole: user.orgRole, userId, requestId, userEmail }

  try {
    const report = await getErasureReport(fetch, userId, requestId)
    return { ...common, state: 'completed', report } satisfies LoadResult
  } catch (err) {
    if (!(err instanceof ApiClientError)) throw err
    if (err.status === 404) return { ...common, state: 'not_found' } satisfies LoadResult
    if (err.status === 409 && err.code === 'erasure_not_yet_completed') {
      const body = err.body as { status?: string } | null
      return resolveNotYetCompleted(fetch, common, body?.status)
    }
    throw err
  }
}
