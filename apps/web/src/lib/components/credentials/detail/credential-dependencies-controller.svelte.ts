import type { SystemType } from '@project-vault/shared'
import { ApiClientError } from '$lib/api/client.js'
import {
  addCredentialDependency,
  archiveCredentialDependency,
  listCredentialDependencies,
  type CredentialDependencyWithChecklistStatus,
} from '$lib/api/credentials.js'
import { confirmChecklistItem } from '$lib/api/rotations.js'
import { archivedBannerFor } from '$lib/credentials/credential-detail-helpers.js'
import { m } from '$lib/paraglide/messages.js'
import { resetOn, withItem } from '$lib/utils/reset-on.js'
import {
  CredentialSectionController,
  type CredentialSectionRegionProps,
  type CredentialSectionSource,
} from './credential-section-controller.svelte.js'

export type CredentialDependenciesSource = CredentialSectionSource & {
  dependencies: {
    items: CredentialDependencyWithChecklistStatus[]
    hasDependencies: boolean
    hasStagedRotation: boolean
  }
}

export type CredentialDependenciesRegionProps =
  CredentialSectionRegionProps<CredentialDependenciesController>

const POLL_INTERVAL_MS = 15000

type ChecklistStatus = NonNullable<CredentialDependencyWithChecklistStatus['checklistStatus']>

// Story 69-14: the one owner of the Dependent systems section's state (the list, the checklist
// confirm, the add form and the 15 s visibility-aware poll). The section creates it, hands it to its
// sub-regions as a prop, and starts and stops the poll with its own lifecycle, so nothing outlives it.
export class CredentialDependenciesController extends CredentialSectionController<CredentialDependenciesSource> {
  get dependencies(): CredentialDependenciesSource['dependencies'] {
    return this.source().dependencies
  }

  // AC-D1: local list so a successful add/archive updates the UI immediately without a reload.
  // Story 68.1 AC-3: a writable $derived of the loader's list — a new load (credential A -> B,
  // invalidateAll) replaces it, local mutations and the background poll below still assign it.
  dependencyItems = $derived<CredentialDependencyWithChecklistStatus[]>(this.dependencies.items)
  depSystemName = $derived(resetOn(this.credentialKey, ''))
  depSystemType = $derived(resetOn<SystemType>(this.credentialKey, 'other'))
  depNotes = $derived(resetOn(this.credentialKey, ''))
  depLinkUrl = $derived(resetOn(this.credentialKey, ''))
  // Story 13.5 AC-6: '' means "Whole credential" (omitted fieldKey), matching the rotation
  // field-selector's own field_meta.length > 1 gating convention (Story 13.4).
  depFieldKey = $derived(resetOn(this.credentialKey, ''))
  depSubmitting = $state(false)
  depNameError = $state<string | null>(null)
  depError = $state<string | null>(null)
  depBanner = $state<string | null>(null)
  archivingDependencyId = $state<string | null>(null)
  // AC-5: authoritative server-computed flag — never inferred from whether any item has a
  // non-null checklistStatus (ADR-2.10-02, see the story's "Challenge from Critical Perspective"
  // finding for why the naive inference is wrong when every dependency post-dates staging).
  // Story 18.7: local and writable (same pattern as `dependencyItems` above) so the background
  // poll below can update it in place without a full page reload.
  hasStagedRotation = $derived(this.dependencies.hasStagedRotation)
  confirmingDependencyId = $state<string | null>(null)
  checklistError = $state<string | null>(null)
  // Story 18.7 AC-5: "Add dependent system" starts collapsed behind a native <details>/<summary>
  // disclosure — simple client-side UI state, not persisted across reloads (AC-6).
  dependencyFormOpen = $derived(resetOn(this.credentialKey, false))

  async addDependency(): Promise<void> {
    if (this.depSubmitting) return
    const systemName = this.depSystemName.trim()
    if (!systemName) {
      this.depNameError = m.form_error_dependency_system_name_required()
      return
    }
    this.depSubmitting = true
    this.depNameError = null
    this.depError = null
    this.depBanner = null
    try {
      const notes = this.depNotes.trim()
      const linkUrl = this.depLinkUrl.trim()
      const created = await addCredentialDependency(fetch, this.projectId, this.credentialId, {
        systemName,
        systemType: this.depSystemType,
        ...(notes ? { notes } : {}),
        ...(linkUrl ? { linkUrl } : {}),
        ...(this.depFieldKey ? { fieldKey: this.depFieldKey } : {}),
      })
      this.dependencyItems = withItem(
        this.dependencyItems,
        { ...created, checklistStatus: null },
        'end'
      )
      this.depSystemName = ''
      this.depSystemType = 'other'
      this.depNotes = ''
      this.depLinkUrl = ''
      this.depFieldKey = ''
    } catch (error) {
      this.#showAddError(error)
    } finally {
      this.depSubmitting = false
    }
  }

  #showAddError(error: unknown): void {
    const archivedBanner = archivedBannerFor(error)
    if (archivedBanner) {
      this.depBanner = archivedBanner
    } else if (
      error instanceof ApiClientError &&
      (error.code === 'too_many_dependencies' ||
        error.code === 'invalid_link_url' ||
        error.code === 'unknown_field_key')
    ) {
      this.depError = error.message
    } else {
      this.depError = error instanceof Error ? error.message : 'Could not add dependent system.'
    }
  }

  async archiveDependency(dependencyId: string): Promise<void> {
    if (this.archivingDependencyId) return
    this.archivingDependencyId = dependencyId
    this.depBanner = null
    try {
      await archiveCredentialDependency(fetch, this.projectId, this.credentialId, dependencyId)
      this.dependencyItems = this.dependencyItems.filter((item) => item.id !== dependencyId)
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        this.depBanner = archivedBanner
      } else {
        this.depError =
          error instanceof Error ? error.message : 'Could not archive dependent system.'
      }
    } finally {
      this.archivingDependencyId = null
    }
  }

  // AC-6.2/6.3: checking the box calls the EXISTING checklist confirm route unchanged — only the
  // caller (this dependency-list surface) is new. Un-checking is not supported (confirm is a
  // one-way pending/failed -> confirmed transition, matching the rotation detail page's own
  // checklist UI — Story 5.2).
  async confirmDependencyUpdate(
    dependency: CredentialDependencyWithChecklistStatus
  ): Promise<void> {
    if (this.confirmingDependencyId) return
    const status = dependency.checklistStatus
    if (!status || status.status === 'confirmed') return
    this.confirmingDependencyId = dependency.id
    this.checklistError = null
    try {
      const result = await confirmChecklistItem(
        fetch,
        this.projectId,
        this.credentialId,
        status.rotationId,
        status.itemId
      )
      this.#patchChecklist(dependency.id, (current) => ({
        ...current,
        status: result.item.status,
        confirmedBy: result.item.confirmedBy,
        confirmedAt: result.item.confirmedAt,
      }))
    } catch (error) {
      // Example 6b: a 409 already_confirmed (someone else confirmed it first, e.g. from the
      // rotation detail page in another tab) is a success from Morgan's perspective — reconcile
      // local state from the error body instead of surfacing an error toast.
      if (error instanceof ApiClientError && error.code === 'already_confirmed') {
        const body = error.body as {
          confirmedBy?: string | null
          confirmedAt?: string | null
        } | null
        this.#patchChecklist(dependency.id, (current) => ({
          ...current,
          status: 'confirmed',
          confirmedBy: body?.confirmedBy ?? current.confirmedBy,
          confirmedAt: body?.confirmedAt ?? current.confirmedAt,
        }))
      } else {
        this.checklistError = error instanceof Error ? error.message : 'Could not confirm update.'
      }
    } finally {
      this.confirmingDependencyId = null
    }
  }

  #patchChecklist(
    dependencyId: string,
    patch: (current: ChecklistStatus) => ChecklistStatus
  ): void {
    this.dependencyItems = this.dependencyItems.map((item) =>
      item.id === dependencyId && item.checklistStatus
        ? { ...item, checklistStatus: patch(item.checklistStatus) }
        : item
    )
  }

  // Story 18.7 AC-1/2/3: this checkbox is Story 2.10's rotation-checklist "Updated" confirmation
  // control, not a permanently-dead one — it's real, functional state, just only meaningful while
  // (a) a rotation is currently staged AND (b) this specific dependency is tracked by that
  // rotation's checklist (a dependency added after staging has no checklist entry to confirm).
  // Both conditions gate on genuine state, so per AC-4's decision rule ("favor conditional-hide
  // if it gates on any real state") an inapplicable checkbox is hidden entirely rather than shown
  // permanently disabled with an unreadable tooltip.
  isCheckboxRelevant(dependency: CredentialDependencyWithChecklistStatus): boolean {
    return this.hasStagedRotation && dependency.checklistStatus !== null
  }

  // Story 18.7 AC-3: keeps the checkbox's relevance reactive to the credential's rotation state
  // while the page stays open — mirrors the rotation detail page's own visibility-aware 15s poll
  // (apps/web/.../rotations/[rotationId]/+page.svelte) so a user already on this page sees the
  // control appear/disappear without a reload as a rotation starts, finishes, or is retired.
  #pollTimer: ReturnType<typeof setInterval> | undefined

  #clearPoll(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer)
    this.#pollTimer = undefined
  }

  async #refetch(): Promise<void> {
    // Skip a tick while any dependency-mutating request is in flight (confirm, archive, or add)
    // — that request's own response already reconciles local state (including a 409
    // already_confirmed for confirm), and a stale poll response landing after it completes but
    // reflecting pre-mutation server state would silently clobber/resurrect the mutated row until
    // the next tick corrects it.
    if (this.confirmingDependencyId || this.archivingDependencyId || this.depSubmitting) return
    try {
      const result = await listCredentialDependencies(fetch, this.projectId, this.credentialId)
      this.dependencyItems = result.items
      this.hasStagedRotation = result.hasStagedRotation
    } catch {
      // Best-effort background refresh: a failed poll just leaves the last-known state in place
      // and is retried on the next tick, matching the rotation detail page's own poll convention
      // — surfacing an error here would be noisier than useful for this background nicety.
    }
  }

  // Re-evaluated by the owner's effect whenever the dependency list count changes (e.g. the first
  // dependency is added, or the last one is archived), so polling starts/stops accordingly.
  schedulePoll(): void {
    this.#clearPoll()
    if (this.dependencyItems.length === 0) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    this.#pollTimer = setInterval(() => {
      void this.#refetch()
    }, POLL_INTERVAL_MS)
  }

  readonly #onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') this.#clearPoll()
    else this.schedulePoll()
  }

  mount(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange)
    }
  }

  destroy(): void {
    this.#clearPoll()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange)
    }
  }
}
