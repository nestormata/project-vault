import { goto, invalidateAll } from '$app/navigation'
import { resolve } from '$app/paths'
import { ApiClientError } from '$lib/api/client.js'
import { createErasureRequest, pseudonymizeUser } from '$lib/api/compliance.js'
import { requestConfirm } from '$lib/state/confirm.svelte.js'
import {
  changeProjectRole,
  deactivateOrgUser,
  removeOrgUser,
  sendRecoveryLink,
  type OrgUser,
  type OrgUserProject,
  type RotationHandlingOptions,
  type SettableProjectRole,
} from '$lib/api/org-users.js'

/** The id of the erasure request a 409 (pending) or 410 (erased) answer points at, or null. */
function existingErasureRequestId(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || (error.status !== 409 && error.status !== 410)) {
    return null
  }
  return (error.body as { requestId?: string } | null)?.requestId || null
}

function soleOwnerMessage(email: string, projects: { projectName: string }[]): string {
  const names = projects.map((p) => p.projectName).join(', ')
  const count = projects.length
  return `${email} owns ${count} project${count === 1 ? '' : 's'} (${names}) — transfer ownership before removing`
}
// Story 43-15 AC-9: `n` for an active_rotations 409 (deactivate or remove), read defensively —
// a malformed body without `rotationIds` renders `0` rather than crashing (AC-6).
function blockingRotationCount(error: ApiClientError): number {
  return ((error.body as { rotationIds?: string[] } | null)?.rotationIds ?? []).length
}
function isActiveRotationsError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.code === 'active_rotations'
}
function removalBlockMessage(user: OrgUser, error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null
  if (error.code === 'sole_owner_of_projects') {
    const projects = (error.body as { projects?: { projectName: string }[] } | null)?.projects
    return soleOwnerMessage(user.email, projects ?? [])
  }
  if (error.code === 'last_org_owner') return 'Cannot remove the sole owner of the organization.'
  if (error.code === 'active_rotations') {
    return `${user.email} still owns ${blockingRotationCount(error)} unfinished rotation(s). Complete, retire, or abandon them before removing this account.`
  }
  return null
}
function deactivationErrorMessage(user: OrgUser, error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'Failed to deactivate account.'
  if (error.code === 'already_deactivated') return `${user.email} is already deactivated.`
  if (error.code === 'active_rotations') {
    return `${user.email} still owns ${blockingRotationCount(error)} unfinished rotation(s). Complete, retire, or abandon them before deactivating this account.`
  }
  return error.message ?? 'Failed to deactivate account.'
}
function transferFailureMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'invalid_transfer_target') {
      return 'That user can no longer receive rotations. Choose another active admin.'
    }
    if (error.code === 'rotation_busy') {
      return 'A rotation for this user is being modified right now. Try again in a moment.'
    }
    return error.message ?? 'Failed to transfer rotations.'
  }
  return 'Failed to transfer rotations.'
}

// Story 69.10: the state and handlers of the users table, moved verbatim from the panel so the
// table, its banners and its row sections share ONE owner. One instance per table (created by
// `UsersTable`, handed to its rows as a prop), never a module-level store.
export class UsersActions {
  /** The org's users, read at call time (the page reloads them after every mutation). */
  readonly page: () => { users: readonly OrgUser[] }

  constructor(page: () => { users: readonly OrgUser[] }) {
    this.page = page
  }

  errorMessage = $state<string | null>(null)
  busyKey = $state<string | null>(null)
  // Story 8.7 AC group J — pseudonymize identity (owner-only, D4's typed-email confirmation).
  pseudonymizeOpenFor = $state<string | null>(null)
  pseudonymizeMatches = $state(false)
  pseudonymizeSaving = $state(false)
  pseudonymizeError = $state<string | null>(null)
  pseudonymizeResults = $state<Record<string, { alias: string; otherAffectedOrgCount: number }>>({})
  openPseudonymize(user: OrgUser) {
    this.pseudonymizeOpenFor = user.userId
    this.pseudonymizeMatches = false
    this.pseudonymizeError = null
  }
  async onConfirmPseudonymize(user: OrgUser) {
    if (!this.pseudonymizeMatches || this.pseudonymizeSaving) return
    this.pseudonymizeSaving = true
    this.pseudonymizeError = null
    try {
      const result = await pseudonymizeUser(fetch, user.userId)
      // AC-J3 — Story 8.3 D8 makes a repeat call a true no-op returning the *existing* alias; this
      // client cannot distinguish that case from a fresh call using only the response fields
      // (both look identical), so the banner below always describes the alias/blast-radius the
      // server just returned rather than guessing whether this was the first call.
      this.pseudonymizeResults = {
        ...this.pseudonymizeResults,
        [user.userId]: { alias: result.alias, otherAffectedOrgCount: result.otherAffectedOrgCount },
      }
      this.pseudonymizeOpenFor = null
    } catch (error) {
      this.pseudonymizeError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to pseudonymize identity.')
          : 'Failed to pseudonymize identity.'
    } finally {
      this.pseudonymizeSaving = false
    }
  }
  // Story 8.7 AC group K — erasure request creation (admin+); on success/already-pending/
  // already-erased, navigates into the review/report flow at
  // /settings/users/[userId]/erasure/[requestId] (AC groups K/L/M own that page).
  erasureOpenFor = $state<string | null>(null)
  erasureReason = $state('')
  erasureRequestedBy = $state('')
  erasureSaving = $state(false)
  erasureError = $state<string | null>(null)
  openErasureRequest(user: OrgUser) {
    this.erasureOpenFor = user.userId
    this.erasureReason = ''
    this.erasureRequestedBy = ''
    this.erasureError = null
  }
  async onSubmitErasureRequest(user: OrgUser) {
    if (this.erasureSaving) return
    // AC-15: destructive actions require a confirmation naming the specific user/action, matching
    // the existing onDeactivateOrgUser/onRemoveOrgUser pattern's specificity.
    const confirmed = await requestConfirm({
      title: 'Request erasure?',
      message: `Request erasure for ${user.email}? This starts an irreversible data-erasure workflow for this user.`,
      confirmLabel: 'Request erasure',
      variant: 'danger',
    })
    if (!confirmed) return
    this.erasureSaving = true
    this.erasureError = null
    try {
      const result = await createErasureRequest(fetch, user.userId, {
        reason: this.erasureReason,
        requestedBy: this.erasureRequestedBy,
      })
      await goto(resolve(`/settings/users/${user.userId}/erasure/${result.requestId}`))
    } catch (error) {
      // AC-K3/K4 — an already-pending or already-erased response is a legitimate "resume review"
      // / "view the completed report" outcome, not a failure: navigate into the existing
      // request's page using the requestId the error body carries, same as a fresh 201 would.
      const existingRequestId = existingErasureRequestId(error)
      if (existingRequestId !== null) {
        await goto(resolve(`/settings/users/${user.userId}/erasure/${existingRequestId}`))
        return
      }
      this.erasureError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to create erasure request.')
          : 'Failed to create erasure request.'
    } finally {
      this.erasureSaving = false
    }
  }
  // Maps a userId to a human-readable "sole owner of these projects" blocking message.
  blockedRemoval = $state<Record<string, string>>({})
  async onChangeRole(user: OrgUser, project: OrgUserProject, role: SettableProjectRole) {
    const key = `${user.userId}:${project.projectId}`
    if (this.busyKey) return
    this.busyKey = key
    this.errorMessage = null
    try {
      await changeProjectRole(fetch, user.userId, project.projectId, role)
      await invalidateAll()
    } catch (error) {
      this.errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to change role.')
          : 'Failed to change role.'
    } finally {
      this.busyKey = null
    }
  }
  // Story 43-15 AC-9: the user whose removal was just refused with 409 active_rotations — their
  // row offers the explicit "abandon and remove" follow-up (mirrors AC-8's deactivate path).
  rotationBlockedRemovalUserId = $state<string | null>(null)
  async runRemoval(user: OrgUser, options?: RotationHandlingOptions) {
    this.busyKey = user.userId
    this.errorMessage = null
    this.transferNotice = null
    this.blockedRemoval = Object.fromEntries(
      Object.entries(this.blockedRemoval).filter(([userId]) => userId !== user.userId)
    )
    try {
      await removeOrgUser(fetch, user.userId, options)
      this.rotationBlockedRemovalUserId = null
      await invalidateAll()
    } catch (error) {
      const blocked = removalBlockMessage(user, error)
      if (blocked) {
        this.blockedRemoval = { ...this.blockedRemoval, [user.userId]: blocked }
      } else {
        this.errorMessage =
          error instanceof ApiClientError
            ? (error.message ?? 'Failed to remove user.')
            : 'Failed to remove user.'
      }
      this.rotationBlockedRemovalUserId = isActiveRotationsError(error) ? user.userId : null
    } finally {
      this.busyKey = null
    }
  }
  async onRemoveOrgUser(user: OrgUser) {
    if (this.busyKey) return
    const confirmed = await requestConfirm({
      title: 'Remove user?',
      message: `Remove ${user.email} from the organization? This removes them from every project and signs out their sessions immediately.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (!confirmed) return
    await this.runRemoval(user)
  }
  async onAbandonRotationsAndRemove(user: OrgUser) {
    if (this.busyKey) return
    const confirmed = await requestConfirm({
      title: 'Abandon rotations and remove user?',
      message: `Abandon ${user.email}'s unfinished rotations and remove ${user.email} from the organization? Staged and stale rotations will be abandoned (their new values discarded, the previous values stay current). Promoted rotations are kept as they are, for an admin to retire later.`,
      confirmLabel: 'Abandon and remove',
      variant: 'danger',
    })
    if (!confirmed) return
    await this.runRemoval(user, { rotationHandling: 'abandon' })
  }
  // Story 43-15 AC-6/AC-8: the user whose deactivation was just refused with 409
  // active_rotations — their row offers the explicit "abandon and deactivate" follow-up.
  rotationBlockedUserId = $state<string | null>(null)
  async runDeactivation(user: OrgUser, options?: RotationHandlingOptions) {
    this.busyKey = user.userId
    this.errorMessage = null
    this.transferNotice = null
    try {
      await deactivateOrgUser(fetch, user.userId, options)
      this.rotationBlockedUserId = null
      await invalidateAll()
    } catch (error) {
      this.errorMessage = deactivationErrorMessage(user, error)
      this.rotationBlockedUserId = isActiveRotationsError(error) ? user.userId : null
    } finally {
      this.busyKey = null
    }
  }
  async onDeactivateOrgUser(user: OrgUser) {
    if (this.busyKey) return
    const confirmed = await requestConfirm({
      title: 'Deactivate user?',
      message: `Deactivate ${user.email}? ${user.email} will be signed out of every session immediately and can no longer log in. Pending invitations ${user.email} sent will be revoked.`,
      confirmLabel: 'Deactivate',
      variant: 'danger',
    })
    if (!confirmed) return
    await this.runDeactivation(user)
  }
  async onAbandonRotationsAndDeactivate(user: OrgUser) {
    if (this.busyKey) return
    const confirmed = await requestConfirm({
      title: 'Abandon rotations and deactivate user?',
      message: `Abandon ${user.email}'s unfinished rotations and deactivate ${user.email}? Staged and stale rotations will be abandoned (their new values discarded, the previous values stay current). Promoted rotations are kept as they are, for an admin to retire later.`,
      confirmLabel: 'Abandon and deactivate',
      variant: 'danger',
    })
    if (!confirmed) return
    await this.runDeactivation(user, { rotationHandling: 'abandon' })
  }
  // Story 43-17 AC-10 (FR102 third outcome): after an active_rotations 409 the row also offers
  // "Transfer unfinished rotations and ...", opening one small panel (one at a time) with a select
  // of the org's other active admins. Failures keep the panel open; success reports the count.
  transferOpen = $state<{ userId: string; action: 'deactivate' | 'remove' } | null>(null)
  transferSaving = $state(false)
  transferError = $state<string | null>(null)
  transferNotice = $state<string | null>(null)
  // Targets the API refused with invalid_transfer_target: dropped from the select so the admin
  // cannot re-submit the same ineligible user (reset whenever the panel is reopened).
  transferIneligible = $state<string[]>([])

  transferTargetsFor(user: OrgUser) {
    return this.page().users.filter(
      (candidate) =>
        candidate.userId !== user.userId &&
        !this.transferIneligible.includes(candidate.userId) &&
        candidate.status === 'active' &&
        (candidate.orgRole === 'admin' || candidate.orgRole === 'owner')
    )
  }

  openTransfer(user: OrgUser, action: 'deactivate' | 'remove') {
    this.transferError = null
    this.transferNotice = null
    this.transferIneligible = []
    this.errorMessage = null
    this.transferOpen = { userId: user.userId, action }
  }

  async onConfirmTransfer(user: OrgUser, transferToUserId: string) {
    if (this.transferSaving || !this.transferOpen) return
    const action = this.transferOpen.action
    this.transferSaving = true
    this.transferError = null
    this.transferNotice = null
    const options = { rotationHandling: 'transfer', transferToUserId } as const
    try {
      const result =
        action === 'deactivate'
          ? await deactivateOrgUser(fetch, user.userId, options)
          : await removeOrgUser(fetch, user.userId, options)
      const toEmail =
        this.page().users.find((u) => u.userId === transferToUserId)?.email ?? 'the new owner'
      this.transferNotice = `Transferred ${result.transferredRotationCount ?? 0} unfinished rotation(s) from ${user.email} to ${toEmail}.`
      this.transferOpen = null
      this.errorMessage = null
      this.rotationBlockedUserId = null
      this.rotationBlockedRemovalUserId = null
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'invalid_transfer_target') {
        this.transferIneligible = [...this.transferIneligible, transferToUserId]
      }
      this.transferError = transferFailureMessage(error)
    } finally {
      this.transferSaving = false
    }
  }
  recoveryLinkSentFor = $state<string | null>(null)
  async onSendRecoveryLink(user: OrgUser) {
    if (this.busyKey) return
    const confirmed = await requestConfirm({
      title: 'Send recovery link?',
      message: `Send ${user.email} a password recovery link?`,
      confirmLabel: 'Send link',
    })
    if (!confirmed) return
    this.busyKey = user.userId
    this.errorMessage = null
    this.recoveryLinkSentFor = null
    try {
      await sendRecoveryLink(fetch, user.userId)
      this.recoveryLinkSentFor = user.userId
    } catch (error) {
      this.errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to send recovery link.')
          : 'Failed to send recovery link.'
    } finally {
      this.busyKey = null
    }
  }
}
