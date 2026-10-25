import { ApiClientError } from '$lib/api/client.js'
import {
  completeRotation,
  getRotation,
  getStagedValue,
  promoteRotation,
  retireRotation,
} from '$lib/api/rotations.js'
import type {
  ChecklistIncompleteErrorBody,
  RotationAcknowledgementRequiredErrorBody,
} from '$lib/api/rotations.js'
import { mapRotationMutationError } from '$lib/components/rotations/rotation-copy.js'
import {
  canActOnChecklist,
  canManageRotations,
  type OrgRole,
} from '$lib/components/rotations/rotation-permissions.js'
import type { RotationChecklistItem, RotationDetail } from '@project-vault/shared'
import type { ProjectWithRole } from '$lib/projects/project-write-access.js'

export interface RotationSource {
  projectId: string
  credentialId: string
  rotationId: string
  orgRole: OrgRole
  /** Story 69.17: the project layout's payload, for the effective project role. */
  project?: ProjectWithRole
  rotation: RotationDetail | null
}

/** The props every sub-region of the rotation detail page takes. */
export interface RotationSectionProps {
  controller: RotationController
  data?: Record<string, readonly unknown[]>
}
/** The props of a sub-region that also renders the loaded rotation. */
export interface RotationDetailSectionProps extends RotationSectionProps {
  rotation: RotationDetail
}

// Story 5.6: staged/promoted are also pollable — a rotation isn't done changing state just
// because it left in_progress.
const ACTIVE_STATUSES = new Set(['in_progress', 'staged', 'promoted', 'stale_recovery'])
const POLL_INTERVAL_MS = 15000

function is(error: ApiClientError, status: number, code: string): boolean {
  return error.status === status && error.code === code
}

/** What a promote or retire failure shows, and the copy that tells the two apart. */
interface GateCopy {
  acknowledgeAll: string
  acknowledgeSome: string
  wrongStateCode: string
  actionLabel: string
  fallback: string
}
const PROMOTE_COPY: GateCopy = {
  acknowledgeAll: 'Please confirm the secret is updated everywhere before promoting.',
  acknowledgeSome: 'Some systems have not confirmed yet — acknowledge to promote anyway:',
  wrongStateCode: 'rotation_not_promotable',
  actionLabel: 'promote this value',
  fallback: 'Could not promote rotation.',
}
const RETIRE_COPY: GateCopy = {
  acknowledgeAll: 'Please confirm the secret is updated everywhere before retiring the old value.',
  acknowledgeSome: 'Some systems have not confirmed yet — acknowledge to retire anyway:',
  wrongStateCode: 'rotation_not_retirable',
  actionLabel: 'retire the old value',
  fallback: 'Could not retire rotation.',
}

// Story 69.14: the state, polling and actions of the rotation detail page, moved verbatim from
// `RotationDetailContent` so the summary card, the staged value, the checklist and the complete /
// promote / abandon / retire sections (each a sub-region) share ONE owner. One instance per page,
// created by the page component and handed to its sections as a prop, never a module-level store.
export class RotationController {
  // Local, mutable working copy: per-item confirm/fail/retry and complete/resume/abandon all
  // patch or replace it in place (D5) without a full page reload. It resets to the loaded rotation
  // whenever SvelteKit re-runs the load (e.g. navigating between rotations), while still allowing
  // in-place reassignment for optimistic/refetched updates in between: an assignment is kept only
  // while the loaded rotation it was made against is still the current one.
  #working = $state.raw<{ loaded: RotationDetail | null; value: RotationDetail | null } | null>(
    null
  )
  get rotation(): RotationDetail | null {
    const loaded = this.source().rotation
    return this.#working !== null && this.#working.loaded === loaded ? this.#working.value : loaded
  }
  set rotation(value: RotationDetail | null) {
    this.#working = { loaded: this.source().rotation, value }
  }
  concurrentBanner = $state(false)
  pollSealedBanner = $state(false)
  completing = $state(false)
  completeError = $state<string | null>(null)
  pendingItemNames = $state<string[]>([])
  acknowledgedNoDependencies = $state(false)
  // Story 5.6 Task 6: promote/retire state.
  promoting = $state(false)
  promoteError = $state<string | null>(null)
  promotePendingItemNames = $state<string[]>([])
  acknowledgeIncompleteChecklistForPromote = $state(false)
  retiring = $state(false)
  retireError = $state<string | null>(null)
  retirePendingItemNames = $state<string[]>([])
  acknowledgeIncompleteChecklistForRetire = $state(false)
  stagedValue = $state<string | null>(null)
  stagedValueError = $state<string | null>(null)
  revealingStagedValue = $state(false)
  abandoning = $state(false)
  private pollTimer: ReturnType<typeof setInterval> | undefined

  /** `source` reads the loader data at call time (it reloads on navigation). */
  constructor(readonly source: () => RotationSource) {}

  get projectId(): string {
    return this.source().projectId
  }
  get credentialId(): string {
    return this.source().credentialId
  }
  get rotationId(): string {
    return this.source().rotationId
  }
  get canManage(): boolean {
    return canManageRotations(this.source().orgRole)
  }
  get canAct(): boolean {
    return canActOnChecklist(this.source().orgRole, this.source().project)
  }
  get confirmedCount(): number {
    return this.rotation
      ? this.rotation.checklistItems.filter((item) => item.status === 'confirmed').length
      : 0
  }
  get totalCount(): number {
    return this.rotation ? this.rotation.checklistItems.length : 0
  }
  get allConfirmed(): boolean {
    return this.totalCount > 0 && this.confirmedCount === this.totalCount
  }
  // Story 5.6 AC-8.5: the checklist stays workable through staged AND promoted (dependent-system
  // owners keep confirming after promotion, up until retire) — matches the backend's
  // CHECKLIST_ACTION_ALLOWED_STATUSES.
  get canPerformItemActions(): boolean {
    return (
      this.canAct &&
      (this.rotation?.status === 'in_progress' ||
        this.rotation?.status === 'staged' ||
        this.rotation?.status === 'promoted')
    )
  }

  readonly refetch = async (): Promise<void> => {
    try {
      this.rotation = await getRotation(fetch, this.projectId, this.credentialId, this.rotationId)
      // AC-5: clear the sealed banner the next time a poll/refresh succeeds (vault unsealed
      // again) — the poll itself is never paused or stopped by a sealed vault (D6), it just
      // self-heals once someone unseals it.
      this.pollSealedBanner = false
    } catch (error) {
      // AC-5: the vault can seal between page load and a poll/refresh tick — surface it via a
      // passive banner (D6) without blanking the last known rotation state (the poll failing is
      // not the same as the rotation not existing). Any other error keeps today's exact
      // behavior: best-effort, silently keep showing the last known state.
      if (error instanceof ApiClientError && error.status === 503) {
        this.pollSealedBanner = true
      }
    }
  }

  readonly handleItemUpdate = (
    item: RotationChecklistItem,
    rotationVersion: number | undefined
  ): void => {
    if (!this.rotation) return
    this.rotation = {
      ...this.rotation,
      version: rotationVersion ?? this.rotation.version,
      checklistItems: this.rotation.checklistItems.map((existing) =>
        existing.id === item.id ? item : existing
      ),
    }
  }

  readonly handleConcurrentModification = async (): Promise<void> => {
    this.concurrentBanner = true
    await this.refetch()
    this.concurrentBanner = false
  }

  readonly handleResumed = (): void => {
    void this.refetch()
  }

  readonly handleAbandoned = (updated?: RotationDetail): void => {
    // The discarded staged value must not linger in component state or the DOM.
    this.stagedValue = null
    this.stagedValueError = null
    // 43-18: the 200 response is authoritative; the follow-up refetch is best-effort only.
    if (updated) this.rotation = updated
    void this.refetch()
  }

  /** The request body of a promote or retire: advisory checklist, so pending items need a flag. */
  private gateBody(acknowledgeIncomplete: boolean) {
    if (this.totalCount === 0) return { acknowledgedNoDependencies: true }
    return acknowledgeIncomplete ? { acknowledgeIncompleteChecklist: true } : {}
  }

  async submitComplete(): Promise<void> {
    if (!this.rotation || this.completing) return
    this.completing = true
    this.completeError = null
    this.pendingItemNames = []
    try {
      const body = this.totalCount === 0 ? { acknowledgedNoDependencies: true } : {}
      this.rotation = await completeRotation(
        fetch,
        this.projectId,
        this.credentialId,
        this.rotationId,
        body
      )
    } catch (error) {
      await this.applyCompleteError(error)
    } finally {
      this.completing = false
    }
  }

  private async applyCompleteError(error: unknown): Promise<void> {
    if (!(error instanceof ApiClientError)) {
      this.completeError = error instanceof Error ? error.message : 'Could not complete rotation.'
      return
    }
    if (error.status === 422 && error.code === 'checklist_incomplete') {
      const body = error.body as unknown as ChecklistIncompleteErrorBody
      this.pendingItemNames = body.pendingItems.map((item) => item.systemName)
      this.completeError = 'Cannot complete — these systems still need confirmation:'
      await this.refetch()
    } else if (is(error, 422, 'acknowledgement_required')) {
      this.completeError = 'Please confirm the secret is updated everywhere before completing.'
      this.acknowledgedNoDependencies = false
    } else if (is(error, 409, 'concurrent_modification') || is(error, 422, 'rotation_not_active')) {
      // Ground-Truth API Surface: complete shares the same `rotation_not_active` outcome as
      // confirm/fail/retry — fires when the rotation moved out of `in_progress` between load
      // and this click. Same remediation as the concurrent-modification banner: refetch so
      // the page reflects the rotation's real, current state.
      await this.handleConcurrentModification()
    } else {
      // AC-8/AC-14: 503/mfa_required/429/generic — one shared helper instead of
      // re-deriving these three branches independently (D3/AC-20).
      this.completeError = mapRotationMutationError(
        error,
        { actionLabel: 'complete this rotation' },
        'Could not complete rotation.'
      )
    }
  }

  /** The message and pending systems a promote or retire failure shows (none when it just refetches). */
  private async gateFailure(
    error: unknown,
    copy: GateCopy
  ): Promise<{ message: string | null; pendingNames: string[] }> {
    const none = { message: null, pendingNames: [] }
    if (!(error instanceof ApiClientError)) {
      return { ...none, message: error instanceof Error ? error.message : copy.fallback }
    }
    if (is(error, 422, 'acknowledgement_required')) {
      const body = error.body as unknown as RotationAcknowledgementRequiredErrorBody
      return {
        message: body.totalItemCount === 0 ? copy.acknowledgeAll : copy.acknowledgeSome,
        pendingNames: body.pendingItems.map((item) => item.systemName),
      }
    }
    if (is(error, 409, 'concurrent_modification')) {
      await this.handleConcurrentModification()
      return none
    }
    if (is(error, 409, copy.wrongStateCode)) {
      await this.refetch()
      return none
    }
    return {
      ...none,
      message: mapRotationMutationError(error, { actionLabel: copy.actionLabel }, copy.fallback),
    }
  }

  // Story 5.6 AC-2/AC-5/AC-6: promote — staged -> promoted. Advisory checklist: pending items
  // never hard-block, they require the acknowledgeIncompleteChecklist flag instead.
  async submitPromote(): Promise<void> {
    if (!this.rotation || this.promoting) return
    this.promoting = true
    this.promoteError = null
    this.promotePendingItemNames = []
    try {
      this.rotation = await promoteRotation(
        fetch,
        this.projectId,
        this.credentialId,
        this.rotationId,
        this.gateBody(this.acknowledgeIncompleteChecklistForPromote)
      )
      // AC-6.2: the zero-dependency acknowledgement is required independently for promote and
      // retire. Do not carry the promote confirmation into the irreversible retire action.
      this.acknowledgedNoDependencies = false
      this.acknowledgeIncompleteChecklistForPromote = false
    } catch (error) {
      const failure = await this.gateFailure(error, PROMOTE_COPY)
      this.promoteError = failure.message
      this.promotePendingItemNames = failure.pendingNames
    } finally {
      this.promoting = false
    }
  }

  // Story 5.6 AC-2/AC-5/AC-6: retire — promoted -> retired (cryptographic purge of the old
  // value). Acknowledgement is independent of whatever was acknowledged at promote time (AC-8.5).
  async submitRetire(): Promise<void> {
    if (!this.rotation || this.retiring) return
    this.retiring = true
    this.retireError = null
    this.retirePendingItemNames = []
    try {
      this.rotation = await retireRotation(
        fetch,
        this.projectId,
        this.credentialId,
        this.rotationId,
        this.gateBody(this.acknowledgeIncompleteChecklistForRetire)
      )
      this.acknowledgeIncompleteChecklistForRetire = false
      this.stagedValue = null
    } catch (error) {
      const failure = await this.gateFailure(error, RETIRE_COPY)
      this.retireError = failure.message
      this.retirePendingItemNames = failure.pendingNames
    } finally {
      this.retiring = false
    }
  }

  // Story 5.6 AC-8: independently-retrievable staged value, same reveal-confirmation UX pattern
  // as the ordinary value-reveal button (fetched on demand, not preloaded).
  async revealStagedValue(): Promise<void> {
    if (this.revealingStagedValue) return
    this.revealingStagedValue = true
    this.stagedValueError = null
    try {
      const result = await getStagedValue(fetch, this.projectId, this.credentialId, this.rotationId)
      // A reveal that resolves after the rotation left `staged` (abandoned/promoted meanwhile)
      // must not put the discarded value back into component state.
      if (this.rotation?.status === 'staged') this.stagedValue = result.value
    } catch (error) {
      this.stagedValueError =
        error instanceof ApiClientError
          ? mapRotationMutationError(error, {}, 'Could not reveal the staged value.')
          : 'Could not reveal the staged value.'
    } finally {
      this.revealingStagedValue = false
    }
  }

  clearPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  schedulePoll(status: RotationDetail['status'] | undefined = this.rotation?.status): void {
    this.clearPoll()
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (status === undefined || !ACTIVE_STATUSES.has(status)) return
    this.pollTimer = setInterval(() => {
      void this.refetch()
    }, POLL_INTERVAL_MS)
  }

  readonly handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') this.clearPoll()
    else this.schedulePoll()
  }

  /** Re-evaluates the poll whenever the rotation's status changes (run from an `$effect`). */
  syncPolling(): void {
    // Re-evaluated whenever `rotation` is reassigned (status transitions in or out of the
    // pollable set, e.g. stale_recovery -> in_progress on resume, or -> completed on complete).
    this.schedulePoll(this.rotation?.status)
  }
}
