import { ApiClientError } from '$lib/api/client.js'
import { requireUser } from '$lib/server/require-user.js'
import type { OrgRole } from '$lib/machine-users/permissions.js'

/**
 * Shared "run this loader; a 404 ApiClientError resolves to notFoundValue instead of throwing;
 * any other error rethrows" shape used by page loaders that fetch a project-scoped resource which
 * may not exist or may belong to another org (both surface as 404, matching this app's
 * cross-org-looks-like-not-found convention). Extracted to avoid a near-duplicate try/catch clone
 * between call sites that otherwise differ only in what they fetch and what "empty" looks like.
 */
export async function loadOr404<T>(run: () => Promise<T>, notFoundValue: T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return notFoundValue
    }
    throw error
  }
}

/**
 * `loadOr404` plus the "resolve the caller's orgRole first, then thread it through both the
 * success and not-found branches" boilerplate every machine-user page loader in this directory
 * needs — extracted so the two call sites (list, detail) share this one implementation instead of
 * repeating an identical `const orgRole = requireUser(locals).orgRole; return loadOr404(...)`
 * preamble each.
 */
export async function loadOr404WithOrgRole<T>(
  locals: Parameters<typeof requireUser>[0],
  run: (orgRole: OrgRole) => Promise<T>,
  toNotFoundValue: (orgRole: OrgRole) => T
): Promise<T> {
  const orgRole = requireUser(locals).orgRole
  return loadOr404(() => run(orgRole), toNotFoundValue(orgRole))
}
