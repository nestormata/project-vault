<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import type { CredentialDetail, SystemType } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    addCredentialDependency,
    archiveCredentialDependency,
    listCredentialDependencies,
    type CredentialDependencyWithChecklistStatus,
  } from '$lib/api/credentials.js'
  import { confirmChecklistItem } from '$lib/api/rotations.js'
  import { withItem } from '$lib/utils/reset-on.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    credentialKeyOf,
    archivedBannerFor,
    canRevealCredential,
    fieldMetaOf,
    isCredentialArchived,
    type CredentialPointExtras,
  } from '$lib/credentials/credential-detail-helpers.js'
  import { m } from '$lib/paraglide/messages.js'
  import { resetOn } from '$lib/utils/reset-on.js'

  // Story 69.2: the Dependent systems section (list, checklist confirm, add form, the 15 s
  // visibility-aware poll) as one replaceable region. The poll and its visibility listener start and
  // stop with this component, so nothing outlives it.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    dependencies,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    project: CredentialPointExtras['project']
    dependencies: {
      items: CredentialDependencyWithChecklistStatus[]
      hasDependencies: boolean
      hasStagedRotation: boolean
    }
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))
  const canReveal = $derived(canRevealCredential(orgRole, project))
  const isArchived = $derived(isCredentialArchived(credential))
  const fieldMeta = $derived(fieldMetaOf(credential))

  // AC-D1: local list so a successful add/archive updates the UI immediately without a reload.
  // Story 68.1 AC-3: a writable $derived of the loader's list — a new load (credential A -> B,
  // invalidateAll) replaces it, local mutations and the background poll below still assign it.
  let dependencyItems = $derived<CredentialDependencyWithChecklistStatus[]>(dependencies.items)
  let depSystemName = $derived(resetOn(credentialKey, ''))
  let depSystemType = $derived(resetOn<SystemType>(credentialKey, 'other'))
  let depNotes = $derived(resetOn(credentialKey, ''))
  let depLinkUrl = $derived(resetOn(credentialKey, ''))
  // Story 13.5 AC-6: '' means "Whole credential" (omitted fieldKey), matching the rotation
  // field-selector's own field_meta.length > 1 gating convention (Story 13.4).
  let depFieldKey = $derived(resetOn(credentialKey, ''))
  let depSubmitting = $state(false)
  let depNameError = $state<string | null>(null)
  let depError = $state<string | null>(null)
  let depBanner = $state<string | null>(null)
  let archivingDependencyId = $state<string | null>(null)
  // AC-5: authoritative server-computed flag — never inferred from whether any item has a
  // non-null checklistStatus (ADR-2.10-02, see the story's "Challenge from Critical Perspective"
  // finding for why the naive inference is wrong when every dependency post-dates staging).
  // Story 18.7: local and writable (same pattern as `dependencyItems` above) so the background
  // poll below can update it in place without a full page reload.
  let hasStagedRotation = $derived(dependencies.hasStagedRotation)
  let confirmingDependencyId = $state<string | null>(null)
  let checklistError = $state<string | null>(null)
  // Story 18.7 AC-5: "Add dependent system" starts collapsed behind a native <details>/<summary>
  // disclosure — simple client-side UI state, not persisted across reloads (AC-6).
  let dependencyFormOpen = $derived(resetOn(credentialKey, false))

  async function onAddDependency(): Promise<void> {
    if (depSubmitting) return
    const systemName = depSystemName.trim()
    if (!systemName) {
      depNameError = m.form_error_dependency_system_name_required()
      return
    }
    depSubmitting = true
    depNameError = null
    depError = null
    depBanner = null
    try {
      const notes = depNotes.trim()
      const linkUrl = depLinkUrl.trim()
      const created = await addCredentialDependency(fetch, projectId, credentialId, {
        systemName,
        systemType: depSystemType,
        ...(notes ? { notes } : {}),
        ...(linkUrl ? { linkUrl } : {}),
        ...(depFieldKey ? { fieldKey: depFieldKey } : {}),
      })
      dependencyItems = withItem(dependencyItems, { ...created, checklistStatus: null }, 'end')
      depSystemName = ''
      depSystemType = 'other'
      depNotes = ''
      depLinkUrl = ''
      depFieldKey = ''
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        depBanner = archivedBanner
      } else if (
        error instanceof ApiClientError &&
        (error.code === 'too_many_dependencies' ||
          error.code === 'invalid_link_url' ||
          error.code === 'unknown_field_key')
      ) {
        depError = error.message
      } else {
        depError = error instanceof Error ? error.message : 'Could not add dependent system.'
      }
    } finally {
      depSubmitting = false
    }
  }

  async function onArchiveDependency(dependencyId: string): Promise<void> {
    if (archivingDependencyId) return
    archivingDependencyId = dependencyId
    depBanner = null
    try {
      await archiveCredentialDependency(fetch, projectId, credentialId, dependencyId)
      dependencyItems = dependencyItems.filter((item) => item.id !== dependencyId)
    } catch (error) {
      const archivedBanner = archivedBannerFor(error)
      if (archivedBanner) {
        depBanner = archivedBanner
      } else {
        depError = error instanceof Error ? error.message : 'Could not archive dependent system.'
      }
    } finally {
      archivingDependencyId = null
    }
  }

  // AC-6.2/6.3: checking the box calls the EXISTING checklist confirm route unchanged — only the
  // caller (this dependency-list surface) is new. Un-checking is not supported (confirm is a
  // one-way pending/failed -> confirmed transition, matching the rotation detail page's own
  // checklist UI — Story 5.2).
  async function onConfirmDependencyUpdate(
    dependency: CredentialDependencyWithChecklistStatus
  ): Promise<void> {
    if (confirmingDependencyId) return
    const status = dependency.checklistStatus
    if (!status || status.status === 'confirmed') return
    confirmingDependencyId = dependency.id
    checklistError = null
    try {
      const result = await confirmChecklistItem(
        fetch,
        projectId,
        credentialId,
        status.rotationId,
        status.itemId
      )
      dependencyItems = dependencyItems.map((item) =>
        item.id === dependency.id && item.checklistStatus
          ? {
              ...item,
              checklistStatus: {
                ...item.checklistStatus,
                status: result.item.status,
                confirmedBy: result.item.confirmedBy,
                confirmedAt: result.item.confirmedAt,
              },
            }
          : item
      )
    } catch (error) {
      // Example 6b: a 409 already_confirmed (someone else confirmed it first, e.g. from the
      // rotation detail page in another tab) is a success from Morgan's perspective — reconcile
      // local state from the error body instead of surfacing an error toast.
      if (error instanceof ApiClientError && error.code === 'already_confirmed') {
        const body = error.body as {
          confirmedBy?: string | null
          confirmedAt?: string | null
        } | null
        dependencyItems = dependencyItems.map((item) =>
          item.id === dependency.id && item.checklistStatus
            ? {
                ...item,
                checklistStatus: {
                  ...item.checklistStatus,
                  status: 'confirmed',
                  confirmedBy: body?.confirmedBy ?? item.checklistStatus.confirmedBy,
                  confirmedAt: body?.confirmedAt ?? item.checklistStatus.confirmedAt,
                },
              }
            : item
        )
      } else {
        checklistError = error instanceof Error ? error.message : 'Could not confirm update.'
      }
    } finally {
      confirmingDependencyId = null
    }
  }

  // Story 18.7 AC-1/2/3: this checkbox is Story 2.10's rotation-checklist "Updated" confirmation
  // control, not a permanently-dead one — it's real, functional state, just only meaningful while
  // (a) a rotation is currently staged AND (b) this specific dependency is tracked by that
  // rotation's checklist (a dependency added after staging has no checklist entry to confirm).
  // Both conditions gate on genuine state, so per AC-4's decision rule ("favor conditional-hide
  // if it gates on any real state") an inapplicable checkbox is hidden entirely rather than shown
  // permanently disabled with an unreadable tooltip.
  function isDependencyCheckboxRelevant(
    dependency: CredentialDependencyWithChecklistStatus
  ): boolean {
    return hasStagedRotation && dependency.checklistStatus !== null
  }

  // Story 18.7 AC-3: keeps the checkbox's relevance reactive to the credential's rotation state
  // while the page stays open — mirrors the rotation detail page's own visibility-aware 15s poll
  // (apps/web/.../rotations/[rotationId]/+page.svelte) so a user already on this page sees the
  // control appear/disappear without a reload as a rotation starts, finishes, or is retired.
  let dependencyPollTimer: ReturnType<typeof setInterval> | undefined

  function clearDependencyPoll() {
    if (dependencyPollTimer) clearInterval(dependencyPollTimer)
    dependencyPollTimer = undefined
  }

  async function refetchDependencies(): Promise<void> {
    // Skip a tick while any dependency-mutating request is in flight (confirm, archive, or add)
    // — that request's own response already reconciles local state (including a 409
    // already_confirmed for confirm), and a stale poll response landing after it completes but
    // reflecting pre-mutation server state would silently clobber/resurrect the mutated row until
    // the next tick corrects it.
    if (confirmingDependencyId || archivingDependencyId || depSubmitting) return
    try {
      const result = await listCredentialDependencies(fetch, projectId, credentialId)
      dependencyItems = result.items
      hasStagedRotation = result.hasStagedRotation
    } catch {
      // Best-effort background refresh: a failed poll just leaves the last-known state in place
      // and is retried on the next tick, matching the rotation detail page's own poll convention
      // — surfacing an error here would be noisier than useful for this background nicety.
    }
  }

  function scheduleDependencyPoll() {
    clearDependencyPoll()
    if (dependencyItems.length === 0) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    dependencyPollTimer = setInterval(() => {
      void refetchDependencies()
    }, 15000)
  }

  function handleDependencyVisibilityChange() {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') clearDependencyPoll()
    else scheduleDependencyPoll()
  }

  $effect(() => {
    // Re-evaluated whenever the dependency list count changes (e.g. the first dependency is
    // added, or the last one is archived), so polling starts/stops accordingly.
    dependencyItems.length
    scheduleDependencyPoll()
  })

  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleDependencyVisibilityChange)
    }
  })

  onDestroy(() => {
    clearDependencyPoll()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleDependencyVisibilityChange)
    }
  })
</script>

<!-- @region credential.detail.dependencies -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
  <FormHelpText id="dependent-systems-help" text={m.form_help_dependent_systems()} />
  {#if dependencyItems.length === 0}
    <p class="mt-3 text-sm text-slate-600">No dependent systems recorded.</p>
  {:else}
    {#if checklistError}
      <p class="mt-3 text-sm text-red-700" role="alert">{checklistError}</p>
    {/if}
    <ul class="mt-4 space-y-2">
      {#each dependencyItems as dependency (dependency.id)}
        {@const checklistItemStatus = dependency.checklistStatus?.status}
        {@const isFailed =
          checklistItemStatus === 'failed' || checklistItemStatus === 'max_retries_exceeded'}
        <li
          class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
        >
          <div class="flex flex-wrap items-center gap-3">
            {#if isDependencyCheckboxRelevant(dependency)}
              <!-- Story 18.7 AC-2/3: only rendered while there's a staged rotation this
                   dependency is actually tracked by — same conditional-render convention as
                   the "Scoped to"/link/failed badges below, so its appearance/disappearance
                   reads as ordinary row context rather than a jarring surprise control. -->
              <label class="flex items-center gap-2" for={`dependency-updated-${dependency.id}`}>
                <input
                  id={`dependency-updated-${dependency.id}`}
                  type="checkbox"
                  checked={dependency.checklistStatus?.status === 'confirmed' || isFailed}
                  disabled={!canReveal ||
                    Boolean(confirmingDependencyId) ||
                    dependency.checklistStatus?.status === 'confirmed'}
                  onchange={() => void onConfirmDependencyUpdate(dependency)}
                  aria-describedby={`dependency-updated-help-${dependency.id}`}
                />
                <span class={isFailed ? 'font-medium text-amber-800' : undefined}>Updated</span>
              </label>
              <FormHelpText id={`dependency-updated-help-${dependency.id}`} kind="checkbox" />
            {/if}
            <span class="font-medium">{dependency.systemName} ({dependency.systemType})</span>
            {#if dependency.fieldKey}
              <!-- Story 13.5 AC-6: scope badge, so Morgan-member can see at a glance which
                   rotations will include this dependency. -->
              <span
                class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
              >
                Scoped to: {dependency.fieldKey}
              </span>
            {/if}
            {#if dependency.linkUrl}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- AC-6.1: a
                   user-supplied external location link (validated http(s) server-side), not
                   a SvelteKit route resolve() can type-check. -->
              <a
                class="max-w-[16rem] truncate text-sm text-blue-700 underline"
                href={dependency.linkUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={dependency.linkUrl}
              >
                {dependency.linkUrl}
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {/if}
            {#if isFailed}
              <a
                class="text-xs font-medium text-amber-800 underline"
                href={resolve(
                  `/projects/${projectId}/credentials/${credentialId}/rotations/${dependency.checklistStatus?.rotationId}`
                )}
              >
                {checklistItemStatus === 'max_retries_exceeded'
                  ? 'Retry limit reached — resolve on rotation page'
                  : 'Failed — resolve on rotation page'}
              </a>
            {/if}
          </div>
          {#if canReveal}
            <button
              class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={archivingDependencyId === dependency.id}
              onclick={() => void onArchiveDependency(dependency.id)}
            >
              {archivingDependencyId === dependency.id ? 'Archiving…' : 'Archive'}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canReveal}
    <!-- Story 18.7 AC-5/6: collapsed by default behind a native <details>/<summary>
         disclosure — built-in keyboard operability (Enter/Space on the summary) and expanded
         state exposed to assistive tech for free, no bespoke bind:+ARIA needed. Open/closed
         state is plain client-side UI state (`dependencyFormOpen`, bound via `bind:open`) and
         intentionally does not persist across reloads (AC-6). -->
    <details class="mt-6 border-t border-slate-200 pt-6" bind:open={dependencyFormOpen}>
      <summary class="cursor-pointer font-semibold text-slate-950"> Add dependent system </summary>
      <form
        class="mt-3 space-y-3"
        onsubmit={(event) => {
          event.preventDefault()
          void onAddDependency()
        }}
      >
        <div class="space-y-1">
          <label class="block text-sm font-medium text-slate-800" for="dependency-system-name">
            System name
          </label>
          <input
            id="dependency-system-name"
            class="w-full rounded-xl border border-slate-300 px-3 py-2"
            type="text"
            required
            bind:value={depSystemName}
            aria-describedby={`dependency-system-name-help${depNameError ? ' dependency-system-name-error' : ''}`}
            aria-invalid={depNameError ? 'true' : undefined}
          />
          <FormHelpText id="dependency-system-name-help" kind="text" />
          {#if depNameError}
            <p id="dependency-system-name-error" class="text-sm text-red-700" role="alert">
              {depNameError}
            </p>
          {/if}
        </div>
        <div class="space-y-1">
          <label class="block text-sm font-medium text-slate-800" for="dependency-system-type">
            System type
          </label>
          <select
            id="dependency-system-type"
            class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
            aria-describedby="dependency-system-type-help"
            bind:value={depSystemType}
          >
            <option value="service">Service</option>
            <option value="ci_pipeline">CI pipeline</option>
            <option value="database">Database</option>
            <option value="third_party">Third party</option>
            <option value="other">Other</option>
          </select>
          <FormHelpText
            id="dependency-system-type-help"
            text={m.form_help_dependency_system_type()}
          />
        </div>
        <div class="space-y-1">
          <label class="block text-sm font-medium text-slate-800" for="dependency-notes">
            Notes
          </label>
          <textarea
            id="dependency-notes"
            class="w-full rounded-xl border border-slate-300 px-3 py-2"
            bind:value={depNotes}
            aria-describedby="dependency-notes-help"></textarea>
          <FormHelpText id="dependency-notes-help" kind="text" />
        </div>
        {#if fieldMeta.length > 1}
          <!-- Story 13.5 AC-6: only rendered for multi-field credentials — hidden entirely
               for single-field/legacy credentials (matches the rotation field-selector's own
               field_meta.length > 1 gating convention, Story 13.4). -->
          <div class="space-y-1">
            <label class="block text-sm font-medium text-slate-800" for="dependency-field-key">
              Scope to field
            </label>
            <select
              id="dependency-field-key"
              class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
              aria-describedby="dependency-field-key-help"
              bind:value={depFieldKey}
            >
              <option value="">Whole secret</option>
              {#each fieldMeta as field (field.key)}
                <option value={field.key}>{field.key}</option>
              {/each}
            </select>
            <FormHelpText id="dependency-field-key-help" text={m.form_help_dependency_scope()} />
          </div>
        {/if}
        <div class="space-y-1">
          <label class="block text-sm font-medium text-slate-800" for="dependency-link-url">
            Link (optional)
          </label>
          <input
            id="dependency-link-url"
            class="w-full rounded-xl border border-slate-300 px-3 py-2"
            type="url"
            placeholder="https://…"
            aria-describedby="dependency-link-url-help dependency-link-url-security-note"
            bind:value={depLinkUrl}
          />
          <FormHelpText id="dependency-link-url-help" text={m.form_help_dependency_link()} />
          <p id="dependency-link-url-security-note" class="text-xs text-slate-500">
            This link is visible to everyone with view access to this secret and is stored in
            plaintext audit logs.
          </p>
        </div>
        {#if depError}
          <p class="text-sm text-red-700" role="alert">{depError}</p>
        {/if}
        {#if depBanner}
          <p class="text-sm text-red-700" role="alert">{depBanner}</p>
        {/if}
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={depSubmitting || isArchived}
        >
          {depSubmitting ? 'Adding…' : 'Add dependent system'}
        </button>
      </form>
    </details>
  {/if}<InjectionPoint name="credential.detail.dependencies" props={pointProps} {data} />
</section>
