<script lang="ts">
  import type { Snippet } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { updateProject } from '$lib/api/projects.js'
  import Button from '$lib/components/ui/Button.svelte'
  import Textarea from '$lib/components/ui/Textarea.svelte'
  import TextField from '$lib/components/ui/TextField.svelte'
  import {
    formatUrlLines,
    parseUrlLines,
    settingsErrorOf,
    type SettingsFieldErrors,
  } from './project-settings-logic.js'

  // Story 72-9: edit name, description and links. The form owns the typed values and the save.
  let {
    project,
    children,
  }: {
    project: { id: string; name: string; description: string | null; urls: string[] }
    children?: Snippet
  } = $props()

  // svelte-ignore state_referenced_locally
  let name = $state(project.name)
  // svelte-ignore state_referenced_locally
  let description = $state(project.description ?? '')
  // svelte-ignore state_referenced_locally
  let urlText = $state(formatUrlLines(project.urls))
  let saving = $state(false)
  let message = $state<string | null>(null)
  let failed = $state(false)
  let fieldErrors = $state<SettingsFieldErrors>({})

  async function save(): Promise<void> {
    if (saving) return
    saving = true
    message = null
    fieldErrors = {}
    try {
      await updateProject(fetch, project.id, {
        name,
        description: description.trim() === '' ? null : description.trim(),
        urls: parseUrlLines(urlText),
      })
      failed = false
      message = 'Saved.'
      await invalidateAll()
    } catch (error) {
      const result = settingsErrorOf(error)
      failed = true
      message = result.message
      fieldErrors = result.fields
    } finally {
      saving = false
    }
  }
</script>

{@render children?.()}
<form
  class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
  onsubmit={(event) => {
    event.preventDefault()
    void save()
  }}
>
  <TextField
    id="project-settings-name"
    label="Name"
    bind:value={name}
    required
    error={fieldErrors.name}
    hint="Up to 128 characters."
  />
  <Textarea
    id="project-settings-description"
    label="Description"
    bind:value={description}
    rows={3}
    error={fieldErrors.description}
    hint="Up to 512 characters. Optional."
  />
  <Textarea
    id="project-settings-urls"
    label="Links"
    bind:value={urlText}
    rows={4}
    error={fieldErrors.urls}
    hint="One http or https address per line, up to 10. Optional."
  />
  {#if message}
    <p class={failed ? 'text-sm text-red-700' : 'text-sm text-green-800'} role="status">
      {message}
    </p>
  {/if}
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
    <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
    <a
      class="text-center font-medium text-slate-700 underline"
      href={resolve(`/projects/${project.id}`)}
    >
      Cancel
    </a>
  </div>
</form>
