<script lang="ts">
  import { resolve } from '$app/paths'
  import type { CredentialDependencyWithChecklistStatus } from '$lib/api/credentials.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 69-14: one dependent system of the list (its Updated checkbox, scope badge, link, failure
  // notice and Archive button). A helper of the list region, so it carries no region of its own; the
  // state it reads and writes is the controller's.
  let {
    controller,
    dependency,
  }: {
    controller: CredentialDependenciesController
    dependency: CredentialDependencyWithChecklistStatus
  } = $props()

  const checklistItemStatus = $derived(dependency.checklistStatus?.status)
  const isFailed = $derived(
    checklistItemStatus === 'failed' || checklistItemStatus === 'max_retries_exceeded'
  )
</script>

<li
  class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
>
  <div class="flex flex-wrap items-center gap-3">
    {#if controller.isCheckboxRelevant(dependency)}
      <!-- Story 18.7 AC-2/3: only rendered while there's a staged rotation this
           dependency is actually tracked by — same conditional-render convention as
           the "Scoped to"/link/failed badges below, so its appearance/disappearance
           reads as ordinary row context rather than a jarring surprise control. -->
      <label class="flex items-center gap-2" for={`dependency-updated-${dependency.id}`}>
        <input
          id={`dependency-updated-${dependency.id}`}
          type="checkbox"
          checked={dependency.checklistStatus?.status === 'confirmed' || isFailed}
          disabled={!controller.canReveal ||
            Boolean(controller.confirmingDependencyId) ||
            dependency.checklistStatus?.status === 'confirmed'}
          onchange={() => void controller.confirmDependencyUpdate(dependency)}
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
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
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
          `/projects/${controller.projectId}/credentials/${controller.credentialId}/rotations/${dependency.checklistStatus?.rotationId}`
        )}
      >
        {checklistItemStatus === 'max_retries_exceeded'
          ? 'Retry limit reached — resolve on rotation page'
          : 'Failed — resolve on rotation page'}
      </a>
    {/if}
  </div>
  {#if controller.canReveal}
    <button
      class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={controller.archivingDependencyId === dependency.id}
      onclick={() => void controller.archiveDependency(dependency.id)}
    >
      {controller.archivingDependencyId === dependency.id ? 'Archiving…' : 'Archive'}
    </button>
  {/if}
</li>
