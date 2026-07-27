import { redirect } from '@sveltejs/kit'
import { getCredential, listCredentialDependencies } from '$lib/api/credentials.js'
import { listRotations } from '$lib/api/rotations.js'
import { ApiClientError } from '$lib/api/client.js'
import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// Mirrors the credential detail page's active-rotation detection (AC-2) — used here as a
// no-dead-end guard so a direct URL visit to /rotate never lands on a form that would just 409.
// `break_glass_complete` is deliberately excluded — see the matching comment in the credential
// detail page's `+page.server.ts`: it is a terminal status the backend never blocks a new
// `POST .../rotations` against, and treating it as "active" here previously made it impossible
// to ever start another rotation on a credential once it had been break-glass rotated.
const REDIRECT_AWAY_ROTATION_STATUSES = new Set(['in_progress', 'stale_recovery'])

// Story 13.4 Task 6 (Dev Notes pre-mortem elicitation) — the FULL active set (matching the
// credential detail page's ACTIVE_ROTATION_STATUSES and the backend's own
// ACTIVE_ROTATION_STATUSES in rotation/service.ts). A staged/promoted-but-unretired rotation
// doesn't redirect away from /rotate (REDIRECT_AWAY_ROTATION_STATUSES above is narrower, kept
// unchanged from its pre-13.4 behavior), but the form still needs to know about it so it can
// render a pre-emptive banner and disable the field selector/submit button *before* a submit
// that would just 409 (AC-6), rather than only surfacing the conflict after a failed POST.
const ACTIVE_ROTATION_STATUSES = new Set(['in_progress', 'staged', 'promoted', 'stale_recovery'])

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const orgRole = requireUser(locals).orgRole

  // AC-6: a member/viewer never triggers any fetch here — the page renders AccessNotice only,
  // and the server never issues the POST on their behalf.
  if (!canManageRotations(orgRole)) {
    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      canManage: false as const,
      dependencies: null,
      fieldMeta: null,
      activeRotationId: null,
    }
  }

  // AC-2: unlike the credential detail page, this loader has no existing try/catch today — a
  // sealed vault 503s every one of these calls (all are vault-guarded reads/writes). A 503 from
  // any is sufficient to render the sealed-vault message; the loader does not need to
  // distinguish which one failed (D1).
  try {
    const history = await listRotations(fetch, params.projectId, params.credentialId, { limit: 1 })
    const latest = history.items[0]
    if (latest && REDIRECT_AWAY_ROTATION_STATUSES.has(latest.status)) {
      throw redirect(
        303,
        `/projects/${params.projectId}/credentials/${params.credentialId}/rotations/${latest.id}`
      )
    }
    const activeRotationId =
      latest && ACTIVE_ROTATION_STATUSES.has(latest.status) ? latest.id : null

    // Story 13.4 Task 6 — the credential detail's `fields` (field_meta) drives the field
    // selector: when there are 2+ fields, the form offers per-field targeting; otherwise it
    // renders exactly today's single-textarea form, unchanged (AC-1/AC-7).
    const [dependencies, credential] = await Promise.all([
      listCredentialDependencies(fetch, params.projectId, params.credentialId),
      getCredential(fetch, params.projectId, params.credentialId),
    ])

    return {
      projectId: params.projectId,
      credentialId: params.credentialId,
      orgRole,
      canManage: true as const,
      dependencies,
      fieldMeta: credential.fields,
      activeRotationId,
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 503) {
      return {
        projectId: params.projectId,
        credentialId: params.credentialId,
        orgRole,
        canManage: true as const,
        dependencies: null,
        fieldMeta: null,
        activeRotationId: null,
        vaultSealed: true as const,
      }
    }
    throw error
  }
}
