/**
 * Story 43.30 — out-of-request membership check. `orgAuthorization.checkMembership` answers
 * against the ambient request's organization and fails closed when no request is bound, so a
 * scheduled task (which has an organization id and no request) cannot use it.
 *
 * `userId` is the user id the caller stored (`users.id`). It is not a session id and not an
 * access-token `jti`. The check reads active organization membership for that user.
 *
 * The result is a tri-state. A missing organization and a user who is not an active member are
 * both `denied` — the result does not say which, and it does not list members or return a role.
 * A host or database failure is `unavailable` and is never reported as `denied`. `reason`, when
 * present, is a fixed diagnostic word, never driver or SQL text.
 */
export type OrgMembershipCheck = {
  organizationId: string
  /** Stored user id (`users.id`), not a session id. */
  userId: string
}

export type OrgMembershipResult =
  { status: 'allowed' } | { status: 'denied' } | { status: 'unavailable'; reason?: string }

export type OrgMembershipHost = {
  isOrgMember(check: OrgMembershipCheck): Promise<OrgMembershipResult>
}
