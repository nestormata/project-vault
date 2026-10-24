<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
  import { m } from '$lib/paraglide/messages.js'
  import type { ProjectsListActions } from './projects-list-actions.svelte.js'

  // Story 69.11: the tags of one project card (the chips, and the editor for callers who may edit).
  let {
    project,
    actions,
  }: { project: ProjectListPage['items'][number]; actions: ProjectsListActions } = $props()

  const canEdit = $derived(canCreateCredential(project.role as never) && !project.isArchived)
</script>

<div class="mt-4">
  <p class="text-sm text-slate-500">Tags</p>
  {#if project.tags.length > 0}
    <ul class="mt-1 flex flex-wrap gap-2">
      {#each project.tags as tag (tag)}
        <li class="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
          {tag}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-1 text-sm text-slate-500">No tags yet</p>
  {/if}
  {#if canEdit}
    <div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
      <div class="flex-1 space-y-1">
        <label class="sr-only" for={`project-tags-${project.id}`}> Tags </label>
        <input
          id={`project-tags-${project.id}`}
          class="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          type="text"
          aria-describedby={`project-tags-help-${project.id}`}
          placeholder="production, api"
          value={actions.tagInputValue(project)}
          oninput={(event) => actions.setTagInput(project, event.currentTarget.value)}
        />
        <FormHelpText id={`project-tags-help-${project.id}`} text={m.form_help_project_tags()} />
        {#if actions.tagErrors[project.id]}
          <p class="text-sm text-red-700" role="alert">{actions.tagErrors[project.id]}</p>
        {/if}
      </div>
      <button
        type="button"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={actions.savingTagsProjectId === project.id}
        onclick={() => actions.onSaveTags(project)}
      >
        {actions.savingTagsProjectId === project.id ? 'Saving…' : 'Save'}
      </button>
    </div>
  {/if}
</div>
