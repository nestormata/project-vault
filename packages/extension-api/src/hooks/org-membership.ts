/**
 * Story 43.30 / 73.11 — out-of-request membership check. `orgAuthorization.checkMembership`
 * answers against the ambient request's organization and fails closed when no request is bound.
 * This host method is available only while PV dispatches a scheduled task, and PV binds it to that
 * task's organization; the explicit organizationId is checked against that binding.
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
  /**
   * Checks active membership for the current PV-dispatched task organization. Calls outside a
   * scheduled task or with another organization return `unavailable`; the input organization is
   * not a scope selector.
   */
  isOrgMember(check: OrgMembershipCheck): Promise<OrgMembershipResult>
}
