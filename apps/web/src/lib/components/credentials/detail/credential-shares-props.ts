import type { CredentialShareSummary } from '$lib/api/credential-shares.js'
import type { OrgUser } from '$lib/api/org-users.js'
import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'

// The share list state and point inputs both the Shares region (outer) and its native body (inner)
// receive, declared once so the two prop lists cannot drift.
export type CredentialSharesListProps = {
  shares?: CredentialShareSummary[]
  sharesTotal?: number
  sharesPage?: number
  sharesStatus?: string | null
  orgMembers?: OrgUser[]
  pointProps: CredentialPointExtras
  data?: Record<string, readonly unknown[]>
}
