import type { CredentialDetail } from '@project-vault/shared'
import {
  canRevealCredential,
  credentialKeyOf,
  fieldMetaOf,
  isCredentialArchived,
  type CredentialPointExtras,
} from '$lib/credentials/credential-detail-helpers.js'

export type CredentialSectionSource = {
  credential: CredentialDetail
  projectId: string
  credentialId: string
  orgRole: CredentialPointExtras['orgRole']
  project: CredentialPointExtras['project']
}

/** What every sub-region of a credential detail section receives: the section's one state owner,
 * the display-only props of the section's points, and the page's `__inject` map. */
export type CredentialSectionRegionProps<C> = {
  controller: C
  pointProps: CredentialPointExtras
  data?: Record<string, readonly unknown[]>
}

// Story 69-14: what the Secret value and Dependent systems controllers share. The section hands in a
// thunk over its props, so every read below follows the props when SvelteKit reuses the section for
// another record (Story 68.1 AC-3).
export class CredentialSectionController<S extends CredentialSectionSource> {
  protected readonly source: () => S

  constructor(source: () => S) {
    this.source = source
  }

  get credential(): CredentialDetail {
    return this.source().credential
  }
  get orgRole(): CredentialPointExtras['orgRole'] {
    return this.source().orgRole
  }
  get project(): CredentialPointExtras['project'] {
    return this.source().project
  }
  get projectId(): string {
    return this.source().projectId
  }
  get credentialId(): string {
    return this.source().credentialId
  }

  credentialKey = $derived(credentialKeyOf(this.projectId, this.credentialId))
  canReveal = $derived(canRevealCredential(this.orgRole, this.project))
  isArchived = $derived(isCredentialArchived(this.credential))
  // Story 13.2: the current version's field metadata (keys/sensitivity); a legacy secret renders as
  // one unnamed masked field (AC-7).
  fieldMeta = $derived(fieldMetaOf(this.credential))
}
