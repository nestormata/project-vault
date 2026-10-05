// Story 69.2 Task 1: the pure derivations the regions of the credential detail page share. They moved
// out of the page's single `<script>` when the page was split into region components, so no region
// re-implements them and none reads another region's state. Everything here is a function of its
// arguments: no module-level variable, no store, no clock.
import type { FieldMeta } from '@project-vault/shared'
import { DEFAULT_FIELD_KEY } from '@project-vault/shared'
import { ApiClientError } from '$lib/api/client.js'
import type { CredentialPointProps } from '$lib/components/composition/injection-points.js'
import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
import type { OrgRole } from '$lib/credentials/permissions.js'

// AC-L4/AC-D5/AC-V4: the UI has no way to know ahead of time that the parent project is archived, so
// every mutation on the page reacts to the real 410 the same way, with the same copy.
export const ARCHIVED_PROJECT_BANNER = 'This project is archived — unarchive it to make changes.'
// Story 28.5 AC6: the credential's OWN archival state, with distinct copy so a caller can tell which
// resource needs unarchiving.
export const CREDENTIAL_ARCHIVED_BANNER = 'This secret is archived — unarchive it to make changes.'

/** The two 410 causes (project vs. credential) mapped in one place so they cannot drift apart. */
export function archivedBannerFor(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.status !== 410) return null
  return error.code === 'credential_archived' ? CREDENTIAL_ARCHIVED_BANNER : ARCHIVED_PROJECT_BANNER
}

/** Story 68.1 AC-3: the record's identity as one primitive. A region derives it from its props, so it
 * only notifies when the record actually changes; it is never a module-level variable. */
export function credentialKeyOf(projectId: string, credentialId: string): string {
  return `${projectId}/${credentialId}`
}

type Project = CredentialPointProps['project']

/** Revealing, editing and the dependent-system controls need a creator org role AND a project role
 * above viewer (PV's API enforces the same; this only gates the controls). */
export function canRevealCredential(orgRole: OrgRole, project: Project): boolean {
  return canCreateCredential(orgRole) && project != null && project.role !== 'viewer'
}

/** Story 28.5 AC6: project-owner-or-org-owner, decided from data the page already has. */
export function canArchiveCredential(orgRole: OrgRole, project: Project): boolean {
  return project != null && (project.role === 'owner' || orgRole === 'owner')
}

/** Story 28.5 AC4/AC6: gates every mutating control once the secret itself is archived. */
export function isCredentialArchived(
  credential: { archivedAt?: string | null } | null | undefined
): boolean {
  return credential?.archivedAt != null
}

/** Story 13.2: the current version's field metadata. A legacy single-field secret renders as one
 * unnamed masked field (AC-7). */
export function fieldMetaOf(
  credential: { fields?: FieldMeta[] | null } | null | undefined
): FieldMeta[] {
  return credential?.fields ?? [{ key: DEFAULT_FIELD_KEY, sensitive: true }]
}

/** Anything but the one default field renders the multi-field editor. */
export function isMultiFieldCredential(fieldMeta: readonly FieldMeta[]): boolean {
  const first = fieldMeta[0]
  return fieldMeta.length > 1 || (first?.key ?? DEFAULT_FIELD_KEY) !== DEFAULT_FIELD_KEY
}

export type CredentialPointExtras = Omit<CredentialPointProps, 'routeId' | 'params'>

/** Story 69.2 AC-3: what every point of the credential page receives beyond the route id and params,
 * computed once. Display data only: it never carries a revealed value, a share token or a step-up
 * secret, and it is never authorization input. */
export function credentialPointExtras(source: {
  credential: CredentialPointExtras['credential']
  project: CredentialPointExtras['project']
  projectId: string
  credentialId: string
  orgRole: OrgRole
}): CredentialPointExtras {
  return {
    credential: source.credential,
    project: source.project,
    projectId: source.projectId,
    credentialId: source.credentialId,
    orgRole: source.orgRole,
    projectRole: source.project?.role ?? null,
  }
}
